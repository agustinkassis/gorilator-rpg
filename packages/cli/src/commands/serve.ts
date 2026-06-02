// `gorilator serve` — the foreground process the OS service supervises. Runs the
// Colyseus server from TS via tsx (same runtime as `pnpm dev` / the Railway
// image); the server also serves the built client via CLIENT_DIST, so ONE
// process answers both the game page and the WebSocket on one port.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

  // Same node that runs the CLI runs the server — no reliance on the service's
  // PATH; tsx resolves from <appDir>/packages/server/node_modules.
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir(appDir),
    env,
    stdio: "inherit",
  });

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
