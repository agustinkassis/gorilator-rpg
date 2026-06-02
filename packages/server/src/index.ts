import { createServer } from "http";
import { join } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { Server } from "@colyseus/core";
import { Encoder } from "@colyseus/schema";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import { ROOM_NAME, SERVER_PORT } from "@rpg/shared";
import { GameRoom } from "./rooms/GameRoom";
import { issueChallenge } from "./systems/nostr";
import { getServerIdentity } from "./systems/nostrIdentity";
import { realmTracker } from "./systems/realms";

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
app.get("/api/status", (_req, res) => res.json(realmTracker.status()));
app.get("/api/realm", (_req, res) => res.json(realmTracker.realm()));

// SPA fallback (single-service only): unmatched GETs return index.html so the
// client renders, but never shadow the monitor or Colyseus matchmaking routes.
if (clientDist) {
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/colyseus") || req.path.startsWith("/matchmake")) return next();
    res.sendFile(join(clientDist, "index.html"));
  });
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
  })
  .catch((err) => {
    console.error("[server] failed to start", err);
    process.exit(1);
  });
