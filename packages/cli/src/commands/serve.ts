// `gorilator serve` — the foreground process the OS service supervises. Runs the
// Colyseus server from TS via tsx (same runtime as `pnpm dev` / the Railway
// image); the server also serves the built client via CLIENT_DIST, so ONE
// process answers both the game page and the WebSocket on one port.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.js";
import { parseEnv } from "../lib/env.js";
import * as log from "../lib/log.js";
import type { Options } from "../lib/options.js";
import { clientDist, envFile, serverDir } from "../lib/paths.js";

export function serve(opts: Options): void {
  // Prefer the saved install record unless --dir was given explicitly.
  const cfg = loadConfig();
  const appDir = opts.dirExplicit ? opts.appDir : (cfg?.appDir ?? opts.appDir);

  const env: NodeJS.ProcessEnv = { ...process.env };
  const ef = envFile(appDir);
  if (existsSync(ef)) Object.assign(env, parseEnv(readFileSync(ef, "utf8")));
  env.CLIENT_DIST = clientDist(appDir);
  // Serve the client on its own port too (the server opens a second listener).
  if (!env.CLIENT_PORT && cfg?.clientPort) env.CLIENT_PORT = String(cfg.clientPort);
  if (opts.portExplicit) env.GAME_SERVER_PORT = String(opts.port);
  else if (!env.GAME_SERVER_PORT) env.GAME_SERVER_PORT = String(opts.port);

  // Tell the server it's a CLI-managed install and how to relaunch the updater,
  // so an admin can trigger `gorilator update` from the splash (systems/selfUpdate).
  // process.argv[1] is this CLI's entrypoint (dist/index.js).
  env.GORILATOR_MANAGED = "1";
  if (process.argv[1]) env.GORILATOR_BIN = process.argv[1];
  if (!env.GORILATOR_UPDATE_LOG) env.GORILATOR_UPDATE_LOG = join(appDir, ".gorilator-update.log");

  // Developer mode (toggled in `gorilator setup → Developer`) serves the SAME
  // single-port build as production — ONE process answers the game page, the
  // WebSocket, monitor, and API on one port, behind ONE Cloudflare tunnel
  // (permanent or temporary) — but with NODE_ENV=development so the server runs
  // its development code paths. The port manager and tunnel behave identically to
  // production; the only difference is the environment.
  //
  // The live Vite HMR + in-game Dev Mode editor is a LOCAL workflow (two ports on
  // localhost): run `gorilator start` inside a checkout, or `pnpm dev`. A public,
  // tunneled host stays single-port — running Vite there is heavier and would
  // need a second tunnel. Mock Nostr login is suppressed (VITE_NO_MOCK_NOSTR) so a
  // reachable server can't be used to impersonate any npub.
  const devMode = env.GORILATOR_DEV === "1";
  if (devMode) {
    env.NODE_ENV = "development";
    env.VITE_NO_MOCK_NOSTR = "1";
    log.info("Developer mode: serving the dev build (NODE_ENV=development) on one port.");
  }
  const child = spawnProdServer(appDir, env);

  const forward = (sig: NodeJS.Signals) => {
    if (child.pid) {
      try {
        process.kill(child.pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));

  child.on("error", (e) => {
    log.err(`Failed to launch the server: ${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    // Clean stop (a signal from systemd/launchd) → exit 0; crash → propagate.
    process.exit(signal ? 0 : (code ?? 0));
  });
}

/** Run the built server via tsx — the same node that runs the CLI, so there's no
 *  reliance on the service PATH (tsx resolves from packages/server/node_modules).
 *  The server serves the built client via CLIENT_DIST, so one process answers the
 *  game page AND the WebSocket on one port (production AND developer mode). */
function spawnProdServer(appDir: string, env: NodeJS.ProcessEnv) {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir(appDir),
    env,
    stdio: "inherit",
  });
}
