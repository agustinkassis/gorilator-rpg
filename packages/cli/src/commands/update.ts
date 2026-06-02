// `gorilator update` — fast-forward the checkout, rebuild, and restart.
import { existsSync, readFileSync } from "node:fs";
import { cloneOrUpdate, ensurePnpm, installAndBuild } from "../lib/build.js";
import { loadConfig } from "../lib/config.js";
import { parseEnv } from "../lib/env.js";
import * as log from "../lib/log.js";
import { envFile } from "../lib/paths.js";
import { restartService } from "../lib/service.js";

export function update(): void {
  const cfg = loadConfig();
  if (!cfg) log.die("No install record found — run 'gorilator install' first.");
  log.info(`Updating ${cfg.appDir} (${cfg.ref})…`);
  ensurePnpm();
  cloneOrUpdate(cfg.repo, cfg.ref, cfg.appDir);
  // Preserve the public client build: if `setup` baked VITE_SERVER_URL into
  // .env, rebuild the client against it so the public bundle survives updates.
  const ef = envFile(cfg.appDir);
  const env = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  installAndBuild(cfg.appDir, { serverUrl: env.VITE_SERVER_URL });
  log.info("Restarting the daemon…");
  try {
    restartService();
  } catch (e) {
    log.warn(`Restart failed: ${(e as Error).message}`);
  }
  log.ok("Updated.");
}
