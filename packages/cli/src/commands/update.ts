// `gorilator update` — stop services, fast-forward, rebuild, and start services.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildOrFetch, cloneOrUpdate, ensurePnpm } from "../lib/build.js";
import { startTunnelService, stopTunnelService } from "../lib/cloudflare.js";
import { loadConfig, updateConfig } from "../lib/config.js";
import { latestReleaseTag, repoSlug } from "../lib/dist.js";
import type { RuntimeContext } from "../lib/context.js";
import { generateNsec, isValidNsec, parseEnv, renderEnv } from "../lib/env.js";
import { waitForHealth } from "../lib/health.js";
import * as log from "../lib/log.js";
import type { Options } from "../lib/options.js";
import { envFile } from "../lib/paths.js";
import { updateProjectDev } from "../lib/projectDev.js";
import { isRoot, run } from "../lib/proc.js";
import { startService, stopService } from "../lib/service.js";

export async function update(ctx?: RuntimeContext, opts?: Options): Promise<void> {
  if (ctx?.kind === "project") {
    if (!opts) log.die("Internal error: project update requires resolved options.");
    await updateProjectDev(ctx, opts);
    return;
  }
  const cfg = loadConfig();
  if (!cfg) log.die("No install record found — run 'gorilator install' first.");
  log.info(`Updating ${cfg.appDir} (${cfg.ref})…`);

  const ef = envFile(cfg.appDir);
  const env = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  if (!isValidNsec(env.NOSTR_NSEC)) {
    const reason = env.NOSTR_NSEC ? "invalid" : "missing";
    env.NOSTR_NSEC = generateNsec();
    writeFileSync(ef, renderEnv(env), { mode: 0o600 });
    if (isRoot() && cfg.user && cfg.user !== "root") run("chown", [cfg.user, ef]);
    log.ok(`Generated ${reason} NOSTR_NSEC in ${ef}`);
  }
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

  // Resolve the ref to fetch. A "latest" channel re-resolves the newest release
  // each run (and persists it); a pinned ref is used as-is.
  const slug = repoSlug(cfg.repo);
  let ref = cfg.ref;
  if (cfg.channel === "latest") {
    ref = (slug && (await latestReleaseTag(slug))) || cfg.ref || "main";
    if (ref !== cfg.ref) {
      updateConfig({ ref });
      log.info(`Latest release: ${ref}`);
    }
  }
  cloneOrUpdate(cfg.repo, ref, cfg.appDir);

  // Preserve the public client build. Same-origin installs can use the prebuilt
  // release dist; older split-host (VITE_SERVER_URL) installs build from source.
  const buildOpts =
    env.VITE_SAME_ORIGIN === "1"
      ? {}
      : env.VITE_SERVER_URL
        ? { serverUrl: env.VITE_SERVER_URL }
        : { serverPort: cfg.port };
  const prebuilt = slug && env.VITE_SAME_ORIGIN === "1" ? { slug, tag: ref } : null;
  buildOrFetch(cfg.appDir, buildOpts, prebuilt);

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
