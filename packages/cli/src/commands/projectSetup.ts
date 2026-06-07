import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { saveConfig } from "../lib/config.js";
import {
  createTunnel,
  ensureCloudflared,
  getTunnelId,
  installTunnelService,
  isAuthorized,
  login,
  removeTunnelLocalConfig,
  routeDns,
  TUNNEL_NAME,
  uninstallTunnelService,
  writeTunnelConfigRoutes,
} from "../lib/cloudflare.js";
import { loadProjectConfig, readProjectEnv, type RuntimeContext } from "../lib/context.js";
import { devTunnelRunning, readDevTunnelState, startDevTunnels, stopDevTunnels } from "../lib/devTunnel.js";
import { generateNsec, genSecret, isValidNsec, parseEnv, renderEnv } from "../lib/env.js";
import * as log from "../lib/log.js";
import { selectMenu } from "../lib/menu.js";
import type { Options } from "../lib/options.js";
import { ask, canPrompt, confirm, promptDefault } from "../lib/proc.js";
import { projectStatus, restartProjectDev } from "../lib/projectDev.js";
import {
  adminsHint,
  adminsMenu,
  updateAutoUpdateInterval,
  updateCheckHint,
  type ServerSettingsCtx,
} from "../lib/serverSettings.js";

type EnvMap = Record<string, string>;

const DEFAULT_SERVER_NAME = "Gorilator Server";
const DEFAULT_CLIENT_PORT = 5173;

export async function runProjectSetup(opts: Options, ctx: RuntimeContext): Promise<void> {
  if (!canPrompt() || opts.yes) {
    saveProjectConfigFromEnv(opts, ctx);
    showCurrentSettings(opts, ctx);
    return;
  }

  for (;;) {
    const cfg = loadProjectConfig(ctx, opts);
    const env = readProjectEnv(ctx);
    const serverPort = Number(env.GAME_SERVER_PORT) || cfg.port;
    const running = (await projectStatus(ctx)).active;
    const choice = await selectMenu(
      `Gorilator project setup\n${ctx.appDir}\n  ${devStatusText(running, serverPort)}`,
      [
      { label: "General settings", hint: "display name, NSEC, admins" },
      {
        label: "Server and client ports",
        hint: `server ${env.GAME_SERVER_PORT || cfg.port}, client ${
          env.CLIENT_PORT || cfg.clientPort || DEFAULT_CLIENT_PORT
        }`,
      },
      { label: "Colyseus and environment", hint: "monitor auth, stats files" },
      { label: "Tunnel (Cloudflare)", hint: tunnelHint(ctx, env) },
      { label: "Auto-update check interval", hint: updateCheckHint(env.UPDATE_CHECK_HOURS) },
      { label: "Show current settings" },
      { label: "Exit" },
    ]);

    if (choice === 0) await generalSettingsMenu(opts, ctx);
    else if (choice === 1) await portsMenu(opts, ctx);
    else if (choice === 2) await environmentMenu(opts, ctx);
    else if (choice === 3) await cloudflareDevMenu(opts, ctx);
    else if (choice === 4) await updateAutoUpdateInterval(settingsCtx(opts, ctx));
    else if (choice === 5) {
      showCurrentSettings(opts, ctx);
      pause();
    } else return;
  }
}

/** One-line tunnel status for the project menu hint. */
function tunnelHint(ctx: RuntimeContext, env: EnvMap): string {
  if (devTunnelRunning(ctx)) return "temporary — sharing dev";
  if (env.VITE_ALLOWED_HOSTS) return `permanent — ${env.VITE_ALLOWED_HOSTS.split(",")[0]}`;
  return "temporary or permanent";
}

/** Expose the local dev server through a Cloudflare tunnel. Two kinds:
 *  • Temporary — quick tunnels (no account), ephemeral …trycloudflare.com URL.
 *  • Permanent — a named tunnel on your own domain (requires a Cloudflare login).
 *  Either way the dev server runs the client (Vite) and game server on separate
 *  ports, so two ingress routes are used and the client dials the server route
 *  via VITE_SERVER_URL. */
async function cloudflareDevMenu(opts: Options, ctx: RuntimeContext): Promise<void> {
  for (;;) {
    const cfg = loadProjectConfig(ctx, opts);
    const env = readProjectEnv(ctx);
    const serverPort = Number(env.GAME_SERVER_PORT) || cfg.port;
    const tunnelUp = devTunnelRunning(ctx);
    const serverUp = (await projectStatus(ctx)).active;
    const state = readDevTunnelState(ctx);
    const url = tunnelUp ? state?.clientUrl : env.VITE_ALLOWED_HOSTS ? `https://${env.VITE_ALLOWED_HOSTS.split(",")[0]}` : "";
    // Tunnels only make sense once the dev server (with its ports) is up.
    const gate = serverUp ? undefined : "start the dev server first";
    const title = `Tunnel (Cloudflare)\n  ${devStatusText(serverUp, serverPort)}\n${tunnelStatusBlock(ctx, env)}`;
    const choice = await selectMenu(title, [
      { label: "Temporary tunnel (share dev)", hint: gate ?? "quick, no login — …trycloudflare.com URL", disabled: !serverUp },
      { label: "Permanent tunnel", hint: gate ?? "your domain — requires a Cloudflare login", disabled: !serverUp },
      { label: "Stop / remove tunnel", hint: tunnelUp || env.VITE_ALLOWED_HOSTS ? "tear it down" : "nothing active" },
      { label: "Show URL", hint: url || "—" },
      { label: "Back" },
    ]);

    if (choice === 0) await startSharing(opts, ctx);
    else if (choice === 1) await setupPermanentDevTunnel(opts, ctx);
    else if (choice === 2) await stopSharing(opts, ctx);
    else if (choice === 3) {
      log.info(url ? `URL: ${url}` : "No tunnel active — set up a temporary or permanent tunnel first.");
      pause();
    } else return;
  }
}

/** A colored "dev server running/stopped" line for the project menu titles. */
function devStatusText(running: boolean, port: number): string {
  return running
    ? `${log.green("● dev server running")} ${log.dim(`· :${port}`)}`
    : log.yellow("○ dev server stopped");
}

/** Permanent named tunnel for a dev checkout: routes a game host → the Vite
 *  client and a server host → the game server, then points the client at the
 *  server host via VITE_SERVER_URL. Unusual but supported (best-effort). */
async function setupPermanentDevTunnel(opts: Options, ctx: RuntimeContext): Promise<void> {
  const cfg = loadProjectConfig(ctx, opts);
  const env = readProjectEnv(ctx);
  const serverPort = Number(env.GAME_SERVER_PORT) || cfg.port;
  const clientPort = Number(env.CLIENT_PORT) || cfg.clientPort || DEFAULT_CLIENT_PORT;

  const base = process.env.GORILATOR_DOMAIN || ask("Base domain on Cloudflare (e.g. example.com): ").trim();
  if (!base) {
    log.warn("A domain is required for a permanent tunnel. No change made.");
    pause();
    return;
  }
  const gameHost = promptDefault("  Game (client) subdomain", `game.${base}`);
  const serverHost = promptDefault("  Server (WebSocket) subdomain", `api.${base}`);

  // Retire any temporary tunnels first.
  if (devTunnelRunning(ctx)) stopDevTunnels(ctx);

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
  if (!id) {
    log.warn("Could not determine the tunnel id. No change made.");
    pause();
    return;
  }

  writeTunnelConfigRoutes(id, [
    { host: gameHost, port: clientPort },
    { host: serverHost, port: serverPort },
  ]);
  log.info("Creating DNS routes…");
  routeDns(gameHost);
  routeDns(serverHost);
  installTunnelService();

  writeEnvPatch(
    ctx,
    { VITE_SERVER_URL: `https://${serverHost}`, VITE_ALLOWED_HOSTS: `${gameHost},${serverHost}` },
    "Configured a permanent Cloudflare tunnel.",
  );
  log.info("Restarting the dev server so it serves the tunnel hosts…");
  await restartIfRunning(opts, ctx);

  process.stdout.write("\n");
  log.ok(`Permanent tunnel live: https://${gameHost}`);
  log.info("If the dev server wasn't running, start it (pnpm dev) so the tunnel has something to serve.");
  pause();
}

async function startSharing(opts: Options, ctx: RuntimeContext): Promise<void> {
  if (devTunnelRunning(ctx)) stopDevTunnels(ctx);
  const cfg = loadProjectConfig(ctx, opts);
  const env = readProjectEnv(ctx);
  const serverPort = Number(env.GAME_SERVER_PORT) || cfg.port;
  const clientPort = Number(env.CLIENT_PORT) || cfg.clientPort || DEFAULT_CLIENT_PORT;

  // The Tunnel menu only enables this once the dev server is up, but guard
  // anyway in case it's invoked directly.
  if (!(await projectStatus(ctx)).active) {
    log.warn("Dev server isn't running — start it first so the tunnel has something to serve.");
    pause();
    return;
  }

  log.info(`Starting temporary Cloudflare tunnels (client :${clientPort}, server :${serverPort})…`);
  const state = await startDevTunnels(ctx, serverPort, clientPort);
  if (!state.serverUrl || !state.clientUrl) {
    log.warn("Could not capture a tunnel URL yet — the tunnels are starting; try 'Show URL' shortly.");
  }
  // Point the dev client at the server tunnel; Vite bakes this on (re)start.
  if (state.serverUrl) writeEnvPatch(ctx, { VITE_SERVER_URL: state.serverUrl }, "Pointed the client at the server tunnel.");

  log.info("Restarting the dev server so it picks up the tunnel settings…");
  await restartIfRunning(opts, ctx);

  process.stdout.write("\n");
  if (state.clientUrl) {
    log.ok(`Sharing your dev server: ${log.green(state.clientUrl)}`);
    if (state.serverUrl) log.info(`Game server tunnel: ${state.serverUrl}`);
    log.info("Ephemeral URLs — they change each time you restart sharing.");
  }
  pause();
}

/** A multi-line block listing the active tunnel(s) and their URLs for the menu. */
function tunnelStatusBlock(ctx: RuntimeContext, env: EnvMap): string {
  const state = readDevTunnelState(ctx);
  if (devTunnelRunning(ctx) && state) {
    return (
      `  ${log.dim("temporary · sharing dev")}\n` +
      `  client: ${state.clientUrl || log.dim("starting…")}\n` +
      `  server: ${state.serverUrl || log.dim("starting…")}\n`
    );
  }
  if (env.VITE_ALLOWED_HOSTS) {
    const [gameHost, serverHost] = env.VITE_ALLOWED_HOSTS.split(",");
    return (
      `  ${log.dim("permanent")}\n` +
      `  client: https://${gameHost ?? "?"}\n` +
      `  server: https://${serverHost ?? "?"}\n`
    );
  }
  return `  ${log.dim("no tunnel active")}\n`;
}

async function stopSharing(opts: Options, ctx: RuntimeContext): Promise<void> {
  const env = readProjectEnv(ctx);
  let changed = stopDevTunnels(ctx); // temporary quick tunnels
  if (env.VITE_ALLOWED_HOSTS) {
    // Permanent named tunnel: stop the boot service + drop local config.
    if (uninstallTunnelService()) changed = true;
    removeTunnelLocalConfig();
  }
  if (changed) log.ok("Tunnel stopped/removed.");
  else log.info("No active tunnel.");
  // Drop the baked client settings so dev returns to localhost defaults.
  if (env.VITE_SERVER_URL || env.VITE_ALLOWED_HOSTS) {
    writeEnvPatch(ctx, { VITE_SERVER_URL: "", VITE_ALLOWED_HOSTS: "" }, "Cleared tunnel client settings.");
    await restartIfRunning(opts, ctx);
  }
  pause();
}

/** General settings: the server's public identity — display name, Nostr key, and
 *  the admin npubs allowed to call /api/admin/* (NIP-98). Mirrors the system
 *  setup menu (commands/setup.ts). */
async function generalSettingsMenu(opts: Options, ctx: RuntimeContext): Promise<void> {
  for (;;) {
    const env = readProjectEnv(ctx);
    const choice = await selectMenu("General settings", [
      { label: "Server display name", hint: env.SERVER_NAME || DEFAULT_SERVER_NAME },
      { label: "Server NSEC", hint: maskSecret(env.NOSTR_NSEC) },
      { label: "Manage admins (NIP-98)", hint: adminsHint(env.ADMIN_NPUBS) },
      { label: "Back" },
    ]);

    if (choice === 0) await updateServerName(opts, ctx);
    else if (choice === 1) await nsecMenu(opts, ctx);
    else if (choice === 2) await adminsMenu(() => settingsCtx(opts, ctx));
    else return;
  }
}

/** The shared ServerSettingsCtx for the in-repo project: the repo .env, its env
 *  writer, and a dev-server restart (only if it's currently running). */
function settingsCtx(opts: Options, ctx: RuntimeContext): ServerSettingsCtx {
  return {
    env: readProjectEnv(ctx),
    write: (patch, message) => writeEnvPatch(ctx, patch, message),
    restart: () => restartIfRunning(opts, ctx),
  };
}

async function portsMenu(opts: Options, ctx: RuntimeContext): Promise<void> {
  for (;;) {
    const cfg = loadProjectConfig(ctx, opts);
    const env = readProjectEnv(ctx);
    const serverPort = Number(env.GAME_SERVER_PORT) || cfg.port;
    const clientPort = Number(env.CLIENT_PORT) || cfg.clientPort || DEFAULT_CLIENT_PORT;
    const choice = await selectMenu("Project ports", [
      { label: "Update server port", hint: String(serverPort) },
      { label: "Update client port", hint: String(clientPort) },
      { label: "Back" },
    ]);

    if (choice === 0) await updatePort(opts, ctx, "GAME_SERVER_PORT", "Server port", serverPort);
    else if (choice === 1) await updatePort(opts, ctx, "CLIENT_PORT", "Client port", clientPort);
    else return;
  }
}

async function updatePort(
  opts: Options,
  ctx: RuntimeContext,
  key: "GAME_SERVER_PORT" | "CLIENT_PORT",
  label: string,
  current: number,
): Promise<void> {
  const next = promptPort(label, current);
  if (next === current) return;

  writeEnvPatch(ctx, { [key]: String(next) }, `Updated ${key}.`);
  const cfg = loadProjectConfig(ctx, opts);
  saveConfig(
    {
      ...cfg,
      port: key === "GAME_SERVER_PORT" ? next : cfg.port,
      clientPort: key === "CLIENT_PORT" ? next : cfg.clientPort,
    },
    ctx.configPath,
  );
  await restartIfRunning(opts, ctx);
  pause();
}

async function nsecMenu(opts: Options, ctx: RuntimeContext): Promise<void> {
  for (;;) {
    const env = readProjectEnv(ctx);
    const choice = await selectMenu("Server NSEC", [
      { label: "Insert or update NOSTR_NSEC", hint: maskSecret(env.NOSTR_NSEC) },
      { label: "Generate a new NOSTR_NSEC", hint: "server will publish as a new Nostr identity" },
      { label: "Back" },
    ]);

    if (choice === 0) await updateNsec(opts, ctx);
    else if (choice === 1) await generateServerNsec(opts, ctx);
    else return;
  }
}

async function updateNsec(opts: Options, ctx: RuntimeContext): Promise<void> {
  const nsec = ask("Paste server nsec1...: ").trim();
  if (!isValidNsec(nsec)) {
    log.warn("That does not look like an nsec1 secret key. No change made.");
    pause();
    return;
  }
  writeEnvPatch(ctx, { NOSTR_NSEC: nsec }, "Updated server NOSTR_NSEC.");
  await restartIfRunning(opts, ctx);
  pause();
}

async function generateServerNsec(opts: Options, ctx: RuntimeContext): Promise<void> {
  if (!confirm("Generate a new server NSEC? Existing server-signed saves will use a new author.")) {
    return;
  }
  const nsec = generateNsec();
  writeEnvPatch(ctx, { NOSTR_NSEC: nsec }, `Generated server NOSTR_NSEC ${maskSecret(nsec)}.`);
  await restartIfRunning(opts, ctx);
  pause();
}

async function environmentMenu(opts: Options, ctx: RuntimeContext): Promise<void> {
  for (;;) {
    const env = readProjectEnv(ctx);
    const choice = await selectMenu("Colyseus and environment", [
      { label: "Update Colyseus monitor credentials", hint: env.MONITOR_USER || "disabled" },
      { label: "Update server stats file", hint: env.SERVER_STATS_FILE || "default .server-realms.json" },
      { label: "Set custom supported server env var" },
      { label: "Show current environment" },
      { label: "Back" },
    ]);

    if (choice === 0) await updateMonitorCredentials(opts, ctx);
    else if (choice === 1) await updateOptionalEnv(opts, ctx, "SERVER_STATS_FILE", "Server stats file");
    else if (choice === 2) await updateCustomEnv(opts, ctx);
    else if (choice === 3) {
      showCurrentSettings(opts, ctx);
      pause();
    } else return;
  }
}

async function updateServerName(opts: Options, ctx: RuntimeContext): Promise<void> {
  const current = readProjectEnv(ctx).SERVER_NAME || DEFAULT_SERVER_NAME;
  const next = ask(`Server display name [${current}]: `).trim() || current;
  writeEnvPatch(ctx, { SERVER_NAME: next }, "Updated server display name.");
  await restartIfRunning(opts, ctx);
  pause();
}

async function updateMonitorCredentials(opts: Options, ctx: RuntimeContext): Promise<void> {
  const env = readProjectEnv(ctx);
  const currentUser = env.MONITOR_USER || "admin";
  const user = ask(`Monitor user [${currentUser}, "none" disables monitor auth]: `).trim();
  if (user.toLowerCase() === "none") {
    writeEnvPatch(ctx, { MONITOR_USER: "", MONITOR_PASS: "" }, "Disabled monitor auth.");
    await restartIfRunning(opts, ctx);
    pause();
    return;
  }

  const nextUser = user || currentUser;
  const pass = ask("Monitor password [blank generates a new one]: ").trim() || genSecret();
  writeEnvPatch(ctx, { MONITOR_USER: nextUser, MONITOR_PASS: pass }, "Updated monitor credentials.");
  await restartIfRunning(opts, ctx);
  log.ok(`Monitor user ${nextUser}; password ${pass}`);
  pause();
}

async function updateOptionalEnv(
  opts: Options,
  ctx: RuntimeContext,
  key: string,
  label: string,
): Promise<void> {
  const current = readProjectEnv(ctx)[key] || "";
  const next = ask(`${label} [${current || "default"}; "none" clears]: `).trim();
  if (!next) return;
  writeEnvPatch(ctx, { [key]: next.toLowerCase() === "none" ? "" : next }, `Updated ${key}.`);
  await restartIfRunning(opts, ctx);
  pause();
}

async function updateCustomEnv(opts: Options, ctx: RuntimeContext): Promise<void> {
  const allowed = ["MONITOR_USER", "MONITOR_PASS", "SERVER_NAME", "SERVER_STATS_FILE"];
  process.stdout.write(`Supported keys:\n${allowed.map((k) => `  ${k}`).join("\n")}\n`);
  const key = ask("Env key: ").trim();
  if (!allowed.includes(key)) {
    log.warn("Unsupported env key. No change made.");
    pause();
    return;
  }
  const value = ask(`Value for ${key} ("none" clears): `).trim();
  writeEnvPatch(ctx, { [key]: value.toLowerCase() === "none" ? "" : value }, `Updated ${key}.`);
  await restartIfRunning(opts, ctx);
  pause();
}

function saveProjectConfigFromEnv(opts: Options, ctx: RuntimeContext): void {
  const cfg = loadProjectConfig(ctx, opts);
  saveConfig(cfg, ctx.configPath);
  log.ok(`Saved project settings to ${ctx.configPath}`);
}

function writeEnvPatch(ctx: RuntimeContext, patch: Record<string, string>, message: string): void {
  const cur = existsSync(ctx.envPath) ? parseEnv(readFileSync(ctx.envPath, "utf8")) : {};
  writeFileSync(ctx.envPath, renderEnv({ ...cur, ...patch }), { mode: 0o600 });
  log.ok(message);
}

async function restartIfRunning(opts: Options, ctx: RuntimeContext): Promise<void> {
  if (!(await projectStatus(ctx)).active) return;
  log.info("Restarting local dev process...");
  await restartProjectDev(ctx, opts);
}

function showCurrentSettings(opts: Options, ctx: RuntimeContext): void {
  const cfg = loadProjectConfig(ctx, opts);
  const env = readProjectEnv(ctx);
  process.stdout.write(`${log.bold("Project")}\n`);
  process.stdout.write(`  Files: ${ctx.appDir}\n`);
  process.stdout.write(`  Config: ${ctx.configPath}\n\n`);
  process.stdout.write(`${log.bold("Server")}\n`);
  process.stdout.write(`  GAME_SERVER_PORT: ${env.GAME_SERVER_PORT || cfg.port}\n`);
  process.stdout.write(`  CLIENT_PORT:      ${env.CLIENT_PORT || cfg.clientPort || DEFAULT_CLIENT_PORT}\n`);
  process.stdout.write(`  SERVER_NAME:      ${env.SERVER_NAME || DEFAULT_SERVER_NAME}\n`);
  process.stdout.write(`  SERVER_STATS_FILE: ${env.SERVER_STATS_FILE || ".server-realms.json"}\n\n`);
  process.stdout.write(`${log.bold("Nostr")}\n`);
  process.stdout.write(`  NOSTR_NSEC: ${maskSecret(env.NOSTR_NSEC)}\n\n`);
  process.stdout.write(`${log.bold("Colyseus Monitor")}\n`);
  process.stdout.write(`  MONITOR_USER: ${env.MONITOR_USER || "(disabled)"}\n`);
  process.stdout.write(`  MONITOR_PASS: ${maskSecret(env.MONITOR_PASS)}\n`);
}

function promptPort(label: string, current: number): number {
  for (;;) {
    const raw = ask(`${label} [${current}]: `).trim();
    if (!raw) return current;
    const port = Number(raw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    log.warn("Enter a port from 1 to 65535.");
  }
}

function maskSecret(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 16) return "set";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function pause(): void {
  if (canPrompt()) ask("\nPress Enter to continue...");
}
