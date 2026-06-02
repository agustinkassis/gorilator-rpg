// `gorilator setup` — wire the running daemon to public Cloudflare subdomains.
// Prompts for a base domain + two subdomains, sets up the cloudflared tunnel
// (two hostnames → the one game port), bakes the server subdomain into the
// client bundle (so the client dials it over wss), rebuilds the client, and
// restarts the daemon. Shares all its logic with the CLI so the bash entry
// point and `npx gorilator setup` do exactly the same thing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildClient } from "../lib/build.js";
import { loadConfig, updateConfig } from "../lib/config.js";
import {
  createTunnel,
  ensureCloudflared,
  getTunnelId,
  installTunnelService,
  isAuthorized,
  login,
  routeDns,
  TUNNEL_NAME,
  tunnelLogin,
  tunnelRestart,
  tunnelStatus,
  writeTunnelConfig,
} from "../lib/cloudflare.js";
import { parseEnv, renderEnv } from "../lib/env.js";
import * as log from "../lib/log.js";
import type { Options } from "../lib/options.js";
import { envFile } from "../lib/paths.js";
import { ask, isRoot, promptDefault, run, targetUser } from "../lib/proc.js";
import { restartService } from "../lib/service.js";
import { printPorts, printPublic, readEnvInfo } from "../lib/summary.js";

export async function runSetup(opts: Options): Promise<void> {
  const cfg = loadConfig();
  const appDir = cfg?.appDir ?? opts.appDir;
  const port = cfg?.port ?? opts.port;
  const clientPort = cfg?.clientPort ?? opts.clientPort;
  const user = cfg?.user ?? targetUser();

  log.info("Configuring the Cloudflare tunnel (two subdomains → the game port).");

  // Subdomains: env overrides for automation, otherwise prompt.
  let clientHost = process.env.GORILATOR_CLIENT_HOST;
  let serverHost = process.env.GORILATOR_SERVER_HOST;
  if (!clientHost || !serverHost) {
    const base = process.env.GORILATOR_DOMAIN || ask("Base domain on Cloudflare (e.g. example.com): ");
    if (!base) log.die("A domain is required (set GORILATOR_DOMAIN or answer the prompt).");
    clientHost = clientHost || promptDefault("  Client subdomain", `play.${base}`);
    serverHost = serverHost || promptDefault("  Server subdomain", `api.${base}`);
  }
  log.ok(`Tunneling: ${clientHost} → :${clientPort} (client page),  ${serverHost} → :${port} (server WebSocket)`);

  // --- cloudflared: install, authorize, create/find tunnel, config, DNS, run ---
  ensureCloudflared();
  if (!isAuthorized()) {
    log.info("Authorize cloudflared — a browser opens (or copy the printed URL); pick your domain:");
    login();
  } else {
    log.ok("cloudflared already authorized.");
  }

  let id = getTunnelId(TUNNEL_NAME);
  if (!id) {
    log.info(`Creating tunnel '${TUNNEL_NAME}'…`);
    createTunnel(TUNNEL_NAME);
    id = getTunnelId(TUNNEL_NAME);
  } else {
    log.ok(`Tunnel '${TUNNEL_NAME}' already exists (${id}).`);
  }
  if (!id) log.die("Could not determine the tunnel id.");

  writeTunnelConfig(id, clientHost, clientPort, serverHost, port);
  log.info("Creating DNS routes…");
  routeDns(clientHost);
  routeDns(serverHost);
  installTunnelService();

  // --- make the client + server work together over the tunnel ---
  mergeEnv(appDir, user, {
    VITE_SERVER_URL: `wss://${serverHost}`,
    CLIENT_HOSTNAME: clientHost,
    SERVER_HOSTNAME: serverHost,
    PLAY_URL: `https://${clientHost}`,
  });
  updateConfig({ clientHost, serverHost });

  log.info("Rebuilding the client to dial the server subdomain…");
  buildClient(appDir, { serverUrl: `wss://${serverHost}` });

  log.info("Restarting the daemon to serve the new client bundle…");
  try {
    restartService();
  } catch (e) {
    log.warn(`Restart failed: ${(e as Error).message}`);
  }

  const info = readEnvInfo(appDir, port);
  process.stdout.write("\n");
  log.ok("🦍 Cloudflare tunnel is live — the game is public.");
  printPublic(info);
  process.stdout.write("\n");
  printPorts(info);
}

/** Merge a patch into the install's .env, preserving every other key. Re-chowns
 *  to the daemon user when we wrote it as root. */
function mergeEnv(appDir: string, user: string, patch: Record<string, string>): void {
  const ef = envFile(appDir);
  const cur = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  writeFileSync(ef, renderEnv({ ...cur, ...patch }), { mode: 0o600 });
  if (isRoot() && user !== "root") run("chown", [user, ef]);
  log.ok(`Updated ${ef} (VITE_SERVER_URL → wss://${patch.SERVER_HOSTNAME}).`);
}

/** `gorilator tunnel <login|status|restart>` — manage the cloudflared service. */
export function tunnelCmd(sub: string | undefined): void {
  switch (sub ?? "status") {
    case "login":
      tunnelLogin();
      break;
    case "status":
      tunnelStatus();
      break;
    case "restart":
      tunnelRestart();
      break;
    default:
      log.die("usage: gorilator tunnel <login|status|restart>");
  }
}
