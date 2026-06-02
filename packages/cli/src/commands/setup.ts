// `gorilator setup` — wire the running daemon to one public Cloudflare hostname.
// The server port already serves the built client, WebSocket/API, and Colyseus
// monitor, so the tunnel only needs one hostname → one local port. The client is
// rebuilt same-origin so it dials whichever public host served the page.
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
  const user = cfg?.user ?? targetUser();

  log.info("Configuring the Cloudflare tunnel (one public hostname → the game port).");

  // Public hostname: env overrides for automation, otherwise prompt.
  let publicHost =
    process.env.GORILATOR_HOST ||
    process.env.GORILATOR_GAME_HOST ||
    process.env.GORILATOR_SERVER_HOST ||
    process.env.GORILATOR_CLIENT_HOST;
  if (!publicHost) {
    const base = process.env.GORILATOR_DOMAIN || ask("Base domain on Cloudflare (e.g. example.com): ");
    if (!base) log.die("A domain is required (set GORILATOR_DOMAIN or answer the prompt).");
    publicHost = promptDefault("  Game subdomain", `game.${base}`);
  }
  log.ok(`Tunneling: ${publicHost} → :${port} (client + WebSocket + monitor + API)`);
  const ef = envFile(appDir);
  const beforeEnv = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  const clientAlreadySameOrigin =
    beforeEnv.VITE_SAME_ORIGIN === "1" &&
    !beforeEnv.VITE_SERVER_URL &&
    !beforeEnv.CLIENT_PORT;

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

  writeTunnelConfig(id, publicHost, port);
  log.info("Creating DNS routes…");
  routeDns(publicHost);
  installTunnelService();

  // --- make the client + server work together over the single public origin ---
  mergeEnv(appDir, user, {
    VITE_SERVER_URL: "",
    VITE_SAME_ORIGIN: "1",
    CLIENT_PORT: "",
    CLIENT_HOSTNAME: "",
    SERVER_HOSTNAME: publicHost,
    PLAY_URL: `https://${publicHost}`,
  });
  updateConfig({ clientPort: undefined, clientHost: undefined, serverHost: publicHost });

  if (clientAlreadySameOrigin) {
    log.ok("Client bundle is already same-origin; skipping rebuild.");
  } else {
    log.info("Rebuilding the client for same-origin HTTPS/WSS…");
    buildClient(appDir);
  }

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
  log.ok(`Updated ${ef} (same-origin public host → ${patch.SERVER_HOSTNAME}).`);
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
