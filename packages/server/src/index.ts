import "./systems/webcrypto";
import { createServer } from "node:http";
import { join } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { matchMaker, Server } from "@colyseus/core";
import { Encoder } from "@colyseus/schema";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import { ROOM_NAME, SERVER_PORT } from "@rpg/shared";
import { GameRoom } from "./rooms/GameRoom";
import { issueChallenge } from "./systems/nostr";
import { getServerIdentity } from "./systems/nostrIdentity";
import { realmTracker } from "./systems/realms";
import { perfTracker } from "./systems/perf";
import { updateChecker } from "./systems/updateCheck";
import { adminCount, isAdmin, listAdminNpubs } from "./systems/admins";
import { requireAdmin, verifyNip98, type AdminRequest } from "./systems/nip98";
import { canSelfUpdate, startSelfUpdate } from "./systems/selfUpdate";
import { createDevEditorRouter } from "./dev/editorApi";
import { featureLabScenario, featureLabScenarioName } from "./systems/featureLab";

// Resolve (or generate) the server's Nostr key up-front, so the npub — and the
// "no NOSTR_NSEC set" warning, if any — prints once at startup rather than on
// the first player's join. This key signs every player's progress save.
const serverIdentity = getServerIdentity();

// The big (×6) world syncs a lot of entities at once — 120 trees, 45 rocks,
// plus logs/stones/potions/bananas/players. The full-state encode on join
// exceeds the 8 KB default, so raise the schema encode buffer to avoid overflow.
Encoder.BUFFER_SIZE = 64 * 1024; // 64 KB

// Use a server-specific env var, NOT the generic PORT (dev tooling repurposes
// PORT for the web/client port; the client always dials SERVER_PORT).
const port = Number(process.env.GAME_SERVER_PORT) || SERVER_PORT;

const app = express();
app.use(cors());
app.use(express.json());

// The Colyseus monitor lets you inspect and dispose live rooms, so behind a
// public Cloudflare tunnel it must not be wide open. When MONITOR_USER/PASS are
// set (the deployed default), gate /colyseus behind HTTP Basic auth; with no
// creds set (local dev) it stays open exactly as before.
const monitorUser = process.env.MONITOR_USER;
const monitorPass = process.env.MONITOR_PASS;
function monitorAuth(req: Request, res: Response, next: NextFunction) {
  const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (user === monitorUser && pass === monitorPass) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="gorilator monitor"');
  res.status(401).end("Authentication required");
}
if (monitorUser && monitorPass) {
  app.use("/colyseus", monitorAuth, monitor()); // protected live room inspector
} else {
  app.use("/colyseus", monitor()); // live room/state inspector (open in dev)
}

// Single-service deploys (e.g. the Railway template) set CLIENT_DIST to the built
// client bundle so ONE server serves the game page AND the WebSocket on the same
// origin/port. Unset in dev / two-service (Docker+Cloudflare) deploys → no effect.
const clientDist = process.env.CLIENT_DIST;
if (clientDist) app.use(express.static(clientDist));

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));
app.get("/", (_req, res) => {
  res.send("Gorilator server is up. Room state monitor at /colyseus");
});

// Nostr login: hand out a one-time challenge the client signs (NIP-07) to prove
// it controls a pubkey. The signed event is verified when it joins the room.
// `serverPubkey` lets the client read its own server-signed save off the relays
// (the server is the save author) to preview recovered progress on the splash.
app.get("/nostr/challenge", (_req, res) => {
  res.json({ challenge: issueChallenge(), serverPubkey: serverIdentity.pubkey });
});

// Public discovery/stats API for external apps + dashboards (see REALMS.md).
//  GET /api/status — server identity + lifetime stats + the live realm
//  GET /api/realm  — the current realm to join (+ players already in it)
app.get("/api/status", (_req, res) =>
  res.json({ ...realmTracker.status(), activeScenario: featureLabScenario()?.name ?? (featureLabScenarioName() || null) }),
);
app.get("/api/realm", (_req, res) => res.json(realmTracker.realm()));

// Live server performance snapshot (latest tick + a 5s rolling summary + per-system
// span times). The F3 perf overlay polls this; also handy with curl/jq. See
// docs/performance.md.
app.get("/api/perf", (_req, res) => res.json(perfTracker.snapshot()));

// Run a labelled server benchmark and return the BenchmarkResult JSON (it is
// also written to perf-logs/bench-<label>-<ts>.json). This is how `pnpm bench`
// captures scenarios. Body: { label?: string, durationMs?: number }.
// Open in dev / GORILATOR_TEST runs; behind the monitor Basic-auth when
// MONITOR_USER/PASS are set (same trust level as /colyseus).
const benchHandler = async (req: Request, res: Response) => {
  const label = String(req.body?.label ?? "adhoc").replace(/[^a-zA-Z0-9_.-]/g, "_");
  // Capped under Node's default 300s requestTimeout — the response waits for the run.
  const durationMs = Math.max(1_000, Math.min(120_000, Number(req.body?.durationMs) || 15_000));
  if (perfTracker.isBenchmarking()) {
    res.status(409).json({ error: "a benchmark is already running" });
    return;
  }
  const result = await perfTracker.startBenchmark(label, durationMs);
  res.json(result);
};
if (monitorUser && monitorPass) {
  app.post("/api/bench", monitorAuth, benchHandler);
} else {
  app.post("/api/bench", benchHandler);
}

// Auto-update status: the daemon's cached verdict on whether a newer GitHub
// release exists. The game splash polls this to show an "update available"
// banner; the `gorilator` CLI surfaces it in `status`. See systems/updateCheck.
app.get("/api/update", (_req, res) => res.json(updateChecker.snapshot()));

// ---- Admin API (NIP-98 authenticated; see systems/nip98 + systems/admins) ----
//
// whoami: validates the NIP-98 token and reports whether that key is an admin.
// Unlike the other routes it does NOT 403 non-admins — the splash uses it to
// decide whether to show the admin "Update now" button. `selfUpdate` advertises
// whether this process can even self-update (a CLI-managed install).
app.get("/api/admin/whoami", async (req: AdminRequest, res: Response) => {
  try {
    const pubkey = await verifyNip98(req);
    res.json({ pubkey, isAdmin: isAdmin(pubkey), adminCount: adminCount(), selfUpdate: canSelfUpdate() });
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : "unauthorized" });
  }
});

// List the configured admin npubs (admin only).
app.get("/api/admin/admins", requireAdmin, (_req, res) => {
  res.json({ admins: listAdminNpubs(), selfUpdate: canSelfUpdate() });
});

// Trigger a self-update (admin only): launches `gorilator update` detached. The
// daemon will go down and come back on the new version; the client polls
// /api/status to detect the new version and reloads.
app.post("/api/admin/update", requireAdmin, (req: AdminRequest, res: Response) => {
  const fromVersion = realmTracker.status().version;
  const result = startSelfUpdate();
  if (!result.ok) {
    res.status(409).json({ error: result.reason ?? "cannot self-update", fromVersion });
    return;
  }
  console.log(`[admin] update triggered by ${req.adminPubkey?.slice(0, 12)}… from v${fromVersion}`);
  res.status(202).json({ started: true, fromVersion });
});

// Dev-mode in-game editor API: persists the Dev Mode editor's changes to the
// content manifests (packages/client/public/*.json) so the editor works on a
// single-port, built-client dev server (where Vite — and its `/__*/` endpoints —
// isn't running). Mounted ONLY in development; every mutating route is NIP-98
// admin-gated (see dev/editorApi). Must come BEFORE the SPA fallback so `/__*`
// isn't shadowed by the index.html catch-all.
if (process.env.NODE_ENV === "development") {
  app.use(createDevEditorRouter());
  console.log("[dev] in-game editor API mounted (/__*, admin-gated) — NODE_ENV=development");
}

// SPA fallback (single-service only): unmatched GETs return index.html so the
// client renders, but never shadow the monitor or Colyseus matchmaking routes.
if (clientDist) {
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/colyseus") || req.path.startsWith("/matchmake")) return next();
    res.sendFile(join(clientDist, "index.html"));
  });
}

// Explicit legacy two-port deploys: also serve the client bundle on its own port.
// The current production path keeps the client, WebSocket, monitor, API, and
// health check on the main server port above. This extra listener is best-effort:
// a bind failure logs and is swallowed so it never takes the game server down.
const clientPort = Number(process.env.CLIENT_PORT) || 0;
if (clientDist && clientPort && clientPort !== port) {
  const clientApp = express();
  clientApp.use(express.static(clientDist));
  clientApp.get("*", (_req: Request, res: Response) =>
    res.sendFile(join(clientDist, "index.html")),
  );
  createServer(clientApp)
    .listen(clientPort, () =>
      console.log(`[client] serving game page on http://localhost:${clientPort}`),
    )
    .on("error", (err: NodeJS.ErrnoException) =>
      console.error(`[client] could not bind port ${clientPort}: ${err.message} (server still on ${port})`),
    );
}

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define(ROOM_NAME, GameRoom);

gameServer
  .listen(port)
  .then(() => {
    console.log(`[server] listening on ws://localhost:${port}`);
    console.log(`[server] monitor:  http://localhost:${port}/colyseus`);
    realmTracker.init(); // realm/stats tracking + Nostr discovery event + /api/* (see REALMS.md)
    perfTracker.init(); // CPU/memory/tick sampling + /api/perf (+ JSONL when PERF_LOG=1)
    updateChecker.init(); // periodic GitHub release check → /api/update (UPDATE_CHECK_HOURS)
    if (process.env.GORILATOR_TEST === "1") {
      // Test/bench mode: pre-create the room so the 20Hz simulation ticks (and
      // POST /api/bench can sample it) without needing a client to join first.
      matchMaker
        .createRoom(ROOM_NAME, {})
        .then(() => console.log("[server] GORILATOR_TEST=1 — room pre-created for bench/e2e"))
        .catch((err) => console.error("[server] test room pre-create failed", err));
    }
  })
  .catch((err) => {
    console.error("[server] failed to start", err);
    process.exit(1);
  });
