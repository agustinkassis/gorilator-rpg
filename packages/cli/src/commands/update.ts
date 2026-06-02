// `gorilator update` — stop services, fast-forward, rebuild, and start services.
import { existsSync, readFileSync } from "node:fs";
import { cloneOrUpdate, ensurePnpm, installAndBuild } from "../lib/build.js";
import { startTunnelService, stopTunnelService } from "../lib/cloudflare.js";
import { loadConfig } from "../lib/config.js";
import { parseEnv } from "../lib/env.js";
import { waitForHealth } from "../lib/health.js";
import * as log from "../lib/log.js";
import { envFile } from "../lib/paths.js";
import { startService, stopService } from "../lib/service.js";

export async function update(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) log.die("No install record found — run 'gorilator install' first.");
  log.info(`Updating ${cfg.appDir} (${cfg.ref})…`);

  const ef = envFile(cfg.appDir);
  const env = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  const tunnelConfigured = Boolean(env.SERVER_HOSTNAME || env.CLIENT_HOSTNAME);

  log.info("Stopping services before updating…");
  if (tunnelConfigured) {
    if (stopTunnelService()) log.ok("Cloudflare tunnel stopped.");
    else log.warn("Could not stop the Cloudflare tunnel service; continuing.");
  }
  try {
    stopService();
    log.ok("Gorilator daemon stopped.");
  } catch (e) {
    log.warn(`Could not stop the Gorilator daemon: ${(e as Error).message}`);
  }

  ensurePnpm();
  cloneOrUpdate(cfg.repo, cfg.ref, cfg.appDir);
  // Preserve the public client build. New `setup` builds same-origin for the
  // single public hostname; older split-host installs may still carry
  // VITE_SERVER_URL and should keep working until setup is rerun.
  const buildOpts =
    env.VITE_SAME_ORIGIN === "1"
      ? {}
      : env.VITE_SERVER_URL
        ? { serverUrl: env.VITE_SERVER_URL }
        : { serverPort: cfg.port };
  installAndBuild(cfg.appDir, buildOpts);

  log.info("Starting the daemon…");
  try {
    startService();
  } catch (e) {
    log.warn(`Start failed: ${(e as Error).message}`);
  }
  const healthy = await waitForHealth(cfg.port);
  if (healthy) log.ok("Gorilator daemon is healthy.");
  else log.warn("The server did not answer /healthz yet — check 'gorilator logs'.");

  if (tunnelConfigured && healthy) {
    log.info("Starting the Cloudflare tunnel…");
    if (startTunnelService()) log.ok("Cloudflare tunnel started.");
    else log.warn("Could not start the Cloudflare tunnel service; run 'gorilator tunnel restart'.");
  } else if (tunnelConfigured) {
    log.warn("Leaving the Cloudflare tunnel stopped because the daemon is not healthy yet.");
  }
  log.ok("Updated.");
}
