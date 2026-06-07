// `gorilator setup` — interactive configuration for the native deploy. The
// Cloudflare path still wires one public hostname to the game port; the menu
// also exposes server ports, Nostr identity, monitor auth, and supported env.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildClient, pnpmInstall } from "../lib/build.js";
import { logsCmd } from "./service.js";
import { loadConfig, updateConfig, type InstallConfig } from "../lib/config.js";
import type { RuntimeContext } from "../lib/context.js";
import {
  awaitQuickTunnelUrl,
  createTunnel,
  ensureCloudflared,
  getTunnelId,
  installQuickTunnelService,
  installTunnelService,
  isAuthorized,
  login,
  quickTunnelUrl,
  removeQuickTunnelService,
  removeTunnelLocalConfig,
  routeDns,
  TUNNEL_NAME,
  type TunnelMode,
  tunnelLogin,
  tunnelRestart,
  tunnelStatus,
  uninstallTunnelService,
  writeTunnelConfig,
} from "../lib/cloudflare.js";
import { generateNsec, genSecret, isValidNsec, parseEnv, renderEnv } from "../lib/env.js";
import * as log from "../lib/log.js";
import { selectMenu } from "../lib/menu.js";
import {
  adminsHint,
  adminsMenu,
  updateAutoUpdateInterval,
  updateCheckHint,
  type ServerSettingsCtx,
} from "../lib/serverSettings.js";
import type { Options } from "../lib/options.js";
import { envFile } from "../lib/paths.js";
import { waitForHealth } from "../lib/health.js";
import { ask, canPrompt, confirm, isRoot, promptDefault, run, targetUser } from "../lib/proc.js";
import { restartService, startService, statusService } from "../lib/service.js";
import { printPorts, printPublic, readEnvInfo } from "../lib/summary.js";
import { runProjectSetup } from "./projectSetup.js";

type EnvMap = Record<string, string>;

interface SetupContext {
  cfg: InstallConfig;
  appDir: string;
  user: string;
  env: EnvMap;
}

const CLOUDFLARE_ENV_KEYS = [
  "GORILATOR_HOST",
  "GORILATOR_GAME_HOST",
  "GORILATOR_SERVER_HOST",
  "GORILATOR_CLIENT_HOST",
  "GORILATOR_DOMAIN",
];

export async function runSetup(opts: Options, ctx?: RuntimeContext): Promise<void> {
  if (ctx?.kind === "project") {
    await runProjectSetup(opts, ctx);
    return;
  }
  const envDriven = CLOUDFLARE_ENV_KEYS.some((k) => Boolean(process.env[k]));
  if (canPrompt() && !opts.yes && !envDriven) {
    await runSetupMenu(opts);
    return;
  }
  await configureCloudflare(opts, { pauseAtEnd: false });
}

/** Post-install entry: go straight to the tunnel-type chooser (temporary by
 *  default) rather than the whole setup menu. */
export async function setupCloudflare(opts: Options): Promise<void> {
  await configureCloudflare(opts, { pauseAtEnd: false });
}

async function runSetupMenu(opts: Options): Promise<void> {
  for (;;) {
    const ctx = requireInstall(opts);
    const info = readEnvInfo(ctx.appDir, ctx.cfg.port, ctx.cfg.clientPort);
    const choice = await selectMenu(`Gorilator setup\n  ${serverStatusText(info.port)}`, [
      {
        label: "General settings",
        hint: "display name, NSEC, admins",
      },
      {
        label: "Server settings",
        hint: `port ${info.port}${info.clientPort ? `, client ${info.clientPort}` : ", one-port"}`,
      },
      {
        label: "Tunnel (Cloudflare)",
        hint: info.serverHost ? `https://${info.serverHost}` : "not configured",
      },
      {
        label: "Logs",
        hint: "recent, follow, filter",
      },
      {
        label: "Colyseus and environment",
        hint: "monitor auth, stats files",
      },
      {
        label: "Developer",
        hint: ctx.env.GORILATOR_DEV === "1" ? "dev mode ON" : "dev mode off",
      },
      { label: "Show current settings" },
      { label: "Exit" },
    ]);

    switch (choice) {
      case 0:
        await generalSettingsMenu(opts);
        break;
      case 1:
        await serverSettingsMenu(opts);
        break;
      case 2:
        await cloudflareMenu(opts);
        break;
      case 3:
        await logsMenu();
        break;
      case 4:
        await environmentMenu(opts);
        break;
      case 5:
        await developerMenu(opts);
        break;
      case 6:
        showCurrentSettings(requireInstall(opts));
        pause();
        break;
      default:
        return;
    }
  }
}

/** General settings: the server's public identity — display name, Nostr key, and
 *  the admin npubs allowed to call /api/admin/* (NIP-98). */
async function generalSettingsMenu(opts: Options): Promise<void> {
  for (;;) {
    const ctx = requireInstall(opts);
    const choice = await selectMenu("General settings", [
      { label: "Server display name", hint: ctx.env.SERVER_NAME || "Gorilator Server" },
      { label: "Server NSEC", hint: maskSecret(ctx.env.NOSTR_NSEC) },
      { label: "Manage admins (NIP-98)", hint: adminsHint(ctx.env.ADMIN_NPUBS) },
      { label: "Back" },
    ]);

    if (choice === 0) updateServerName(opts);
    else if (choice === 1) await nsecMenu(opts);
    else if (choice === 2) await adminsMenu(() => settingsCtx(opts));
    else return;
  }
}

/** Developer tools. Currently a single toggle: when ON, `gorilator serve` runs
 *  the live dev server (Vite HMR + tsx, in-game Dev Mode editor) instead of the
 *  production build — see commands/serve.ts. Mock Nostr login stays disabled. */
async function developerMenu(opts: Options): Promise<void> {
  for (;;) {
    const ctx = requireInstall(opts);
    const on = ctx.env.GORILATOR_DEV === "1";
    const choice = await selectMenu(`Developer\n  Dev mode is ${on ? "ON" : "off"}\n`, [
      { label: on ? "Turn dev mode OFF" : "Turn dev mode ON", hint: on ? "back to production build" : "live dev server (Vite + tsx)" },
      { label: "Back" },
    ]);
    if (choice === 0) toggleDevMode(opts, !on);
    else return;
  }
}

function toggleDevMode(opts: Options, on: boolean): void {
  const ctx = requireInstall(opts);
  if (on && !confirm("Run this server in DEVELOPMENT mode (Vite HMR + tsx, in-game Dev Mode editor)? Heavier to run; not for a public production host.")) {
    return;
  }
  if (on) {
    // The dev server runs `pnpm dev` (Vite), whose build-only deps a prebuilt
    // (slim) install skips. Ensure the full dependency set is present first.
    log.info("Ensuring developer dependencies are installed (Vite + build tools)…");
    try {
      pnpmInstall(ctx.appDir);
    } catch (e) {
      log.warn(`Could not install dev dependencies: ${(e as Error).message}`);
    }
  }
  writeEnvPatch(
    ctx,
    { GORILATOR_DEV: on ? "1" : "" },
    on ? "Dev mode ON — the daemon will run the live dev server." : "Dev mode off — back to the production build.",
  );
  restartDaemon();
  pause();
}

async function logsMenu(): Promise<void> {
  for (;;) {
    const choice = await selectMenu("Logs", [
      { label: "Show last 100 lines", hint: "default" },
      { label: "Show last 250 lines" },
      { label: "Follow realtime logs", hint: "Ctrl-C to stop" },
      { label: "Filter recent logs" },
      { label: "Advanced logs" },
      { label: "Back" },
    ]);

    if (choice === 0) {
      logsCmd(undefined, { lines: "100" });
      pause();
    } else if (choice === 1) {
      logsCmd(undefined, { lines: "250" });
      pause();
    } else if (choice === 2) {
      logsCmd(undefined, { lines: "", follow: true });
      return;
    } else if (choice === 3) {
      const filter = ask("Filter text: ").trim();
      if (filter) logsCmd(undefined, { lines: "200", filter });
      pause();
    } else if (choice === 4) {
      const lines = ask("Lines to show [100]: ").trim() || "100";
      const follow = /^y/i.test(ask("Follow realtime? [y/N] "));
      const filter = ask("Filter text [blank for none]: ").trim() || undefined;
      const since = ask('Since [Linux journalctl, e.g. "1 hour ago", blank for none]: ').trim() || undefined;
      logsCmd(undefined, { lines, follow, filter, since });
      if (follow) return;
      pause();
    } else {
      return;
    }
  }
}

async function serverSettingsMenu(opts: Options): Promise<void> {
  for (;;) {
    const ctx = requireInstall(opts);
    const port = Number(ctx.env.GAME_SERVER_PORT) || ctx.cfg.port;
    const clientPort = Number(ctx.env.CLIENT_PORT) || ctx.cfg.clientPort || 0;
    const choice = await selectMenu("Server settings", [
      { label: "Update server port", hint: String(port) },
      { label: "Update optional client port", hint: clientPort ? String(clientPort) : "disabled" },
      { label: "Use one-port mode", hint: "client + WebSocket + monitor on server port" },
      { label: "Auto-update check interval", hint: updateCheckHint(ctx.env.UPDATE_CHECK_HOURS) },
      { label: "Back" },
    ]);

    if (choice === 0) await updateServerPort(opts, port);
    else if (choice === 1) await updateClientPort(opts, clientPort);
    else if (choice === 2) await setOnePortMode(opts);
    else if (choice === 3) await updateAutoUpdateInterval(settingsCtx(opts));
    else return;
  }
}

/** The shared ServerSettingsCtx for a system install: the install .env, the
 *  (sudo-aware) env writer, and the daemon restart. */
function settingsCtx(opts: Options): ServerSettingsCtx {
  const ctx = requireInstall(opts);
  return {
    env: ctx.env,
    write: (patch, message) => writeEnvPatch(ctx, patch, message),
    restart: restartDaemon,
  };
}

async function updateServerPort(opts: Options, current: number): Promise<void> {
  const next = promptPort("Server port", current, false);
  if (!next || next === current) return;

  const ctx = requireInstall(opts);
  const clientPort = Number(ctx.env.CLIENT_PORT) || ctx.cfg.clientPort || 0;
  writeEnvPatch(ctx, { GAME_SERVER_PORT: String(next) }, "Updated server port.");
  updateConfig({ port: next });
  rebuildClientForPorts(ctx.appDir, next, clientPort);
  restartDaemon();
  printPorts(readEnvInfo(ctx.appDir, next, clientPort || undefined));
  pause();
}

async function updateClientPort(opts: Options, current: number): Promise<void> {
  const next = promptPort("Optional client port (0 disables it)", current, true);
  if (next === current) return;

  const ctx = requireInstall(opts);
  const serverPort = Number(ctx.env.GAME_SERVER_PORT) || ctx.cfg.port;
  writeEnvPatch(
    ctx,
    {
      CLIENT_PORT: next ? String(next) : "",
      VITE_SAME_ORIGIN: next ? "" : "1",
    },
    next ? "Updated optional client port." : "Disabled optional client port.",
  );
  updateConfig({ clientPort: next || undefined });
  rebuildClientForPorts(ctx.appDir, serverPort, next);
  restartDaemon();
  printPorts(readEnvInfo(ctx.appDir, serverPort, next || undefined));
  pause();
}

async function setOnePortMode(opts: Options): Promise<void> {
  const ctx = requireInstall(opts);
  if (!ctx.env.CLIENT_PORT && ctx.env.VITE_SAME_ORIGIN === "1") {
    log.ok("Already in one-port same-origin mode.");
    pause();
    return;
  }
  const serverPort = Number(ctx.env.GAME_SERVER_PORT) || ctx.cfg.port;
  writeEnvPatch(
    ctx,
    {
      CLIENT_PORT: "",
      CLIENT_HOSTNAME: "",
      VITE_SERVER_URL: "",
      VITE_SAME_ORIGIN: "1",
    },
    "Updated to one-port same-origin mode.",
  );
  updateConfig({ clientPort: undefined, clientHost: undefined });
  rebuildClientForPorts(ctx.appDir, serverPort, 0);
  restartDaemon();
  printPorts(readEnvInfo(ctx.appDir, serverPort));
  pause();
}

async function nsecMenu(opts: Options): Promise<void> {
  for (;;) {
    const ctx = requireInstall(opts);
    const choice = await selectMenu("Server NSEC", [
      { label: "Insert or update NOSTR_NSEC", hint: maskSecret(ctx.env.NOSTR_NSEC) },
      { label: "Generate a new NOSTR_NSEC", hint: "server will publish as a new Nostr identity" },
      { label: "Back" },
    ]);

    if (choice === 0) updateNsec(opts);
    else if (choice === 1) generateServerNsec(opts);
    else return;
  }
}

function updateNsec(opts: Options): void {
  const nsec = ask("Paste server nsec1...: ").trim();
  if (!isValidNsec(nsec)) {
    log.warn("That does not look like an nsec1 secret key. No change made.");
    pause();
    return;
  }
  const ctx = requireInstall(opts);
  writeEnvPatch(ctx, { NOSTR_NSEC: nsec }, "Updated server NOSTR_NSEC.");
  restartDaemon();
  pause();
}

function generateServerNsec(opts: Options): void {
  if (!confirm("Generate a new server NSEC? Existing server-signed saves will use a new author.")) {
    return;
  }
  const ctx = requireInstall(opts);
  const nsec = generateNsec();
  writeEnvPatch(ctx, { NOSTR_NSEC: nsec }, `Generated server NOSTR_NSEC ${maskSecret(nsec)}.`);
  restartDaemon();
  pause();
}

async function cloudflareMenu(opts: Options): Promise<void> {
  for (;;) {
    const ctx = requireInstall(opts);
    const running = serverRunning();
    const gate = running ? undefined : "start the server first";
    const choice = await selectMenu(
      `Tunnel (Cloudflare)\n  ${serverStatusText(Number(ctx.env.GAME_SERVER_PORT) || ctx.cfg.port)}\n  ${tunnelStatusLine(ctx.env)}`,
      [
        { label: "Set up temporary tunnel", hint: gate ?? "quick, no login — …trycloudflare.com URL", disabled: !running },
        { label: "Set up permanent tunnel", hint: gate ?? "your domain — requires a Cloudflare login", disabled: !running },
        { label: "Remove Cloudflare settings", hint: "local service/config only" },
        { label: "Tunnel status" },
        { label: "Authorize Cloudflare login", hint: "for permanent tunnels" },
        { label: "Restart tunnel" },
        { label: "Back" },
      ],
    );

    if (choice === 0) await configureCloudflare(opts, { mode: "temporary" });
    else if (choice === 1) await configureCloudflare(opts, { mode: "permanent" });
    else if (choice === 2) removeCloudflare(opts);
    else if (choice === 3) {
      tunnelStatus();
      pause();
    } else if (choice === 4) {
      tunnelLogin();
      pause();
    } else if (choice === 5) {
      tunnelRestart();
      pause();
    } else return;
  }
}

/** Whether the daemon service is currently active (best-effort). */
function serverRunning(): boolean {
  try {
    return statusService().active;
  } catch {
    return false;
  }
}

/** A colored "server running/stopped" line for the menu titles. */
function serverStatusText(port: number): string {
  return serverRunning()
    ? `${log.green("● server running")} ${log.dim(`· :${port}`)}`
    : log.yellow("○ server stopped");
}

/** A one-line description of the active tunnel + its live URL for the menu. */
function tunnelStatusLine(env: EnvMap): string {
  if (env.TUNNEL_MODE === "temporary") {
    // Prefer the live URL from the running quick tunnel (it changes on restart);
    // fall back to the last-saved host.
    const live = quickTunnelUrl();
    const url = live || (env.SERVER_HOSTNAME ? `https://${env.SERVER_HOSTNAME}` : "");
    return `temporary${url ? ` · ${url}` : " · starting…"}`;
  }
  if (env.TUNNEL_MODE === "permanent" || env.SERVER_HOSTNAME) {
    return `permanent · https://${env.SERVER_HOSTNAME || "?"}`;
  }
  return "not configured";
}

function removeCloudflare(opts: Options): void {
  if (!confirm("Remove local Cloudflare tunnel service/config and clear public host env?")) return;
  const ctx = requireInstall(opts);
  let removed = uninstallTunnelService();
  removed = removeQuickTunnelService() || removed;
  if (removed) log.ok("Cloudflare tunnel service stopped/removed.");
  else log.warn("No local Cloudflare tunnel service was removed.");
  removeTunnelLocalConfig();
  writeEnvPatch(
    ctx,
    {
      TUNNEL_MODE: "",
      CLIENT_HOSTNAME: "",
      SERVER_HOSTNAME: "",
      PLAY_URL: "",
      VITE_SERVER_URL: "",
      VITE_SAME_ORIGIN: "1",
    },
    "Cleared Cloudflare environment settings.",
  );
  updateConfig({ clientHost: undefined, serverHost: undefined });
  restartDaemon();
  pause();
}

async function environmentMenu(opts: Options): Promise<void> {
  for (;;) {
    const ctx = requireInstall(opts);
    const choice = await selectMenu("Colyseus and environment", [
      { label: "Update Colyseus monitor credentials", hint: ctx.env.MONITOR_USER || "disabled" },
      { label: "Update server stats file", hint: ctx.env.SERVER_STATS_FILE || "default .server-realms.json" },
      { label: "Set custom supported server env var" },
      { label: "Show current environment" },
      { label: "Back" },
    ]);

    if (choice === 0) updateMonitorCredentials(opts);
    else if (choice === 1) updateOptionalEnv(opts, "SERVER_STATS_FILE", "Server stats file");
    else if (choice === 2) updateCustomEnv(opts);
    else if (choice === 3) {
      showCurrentSettings(requireInstall(opts));
      pause();
    } else return;
  }
}

function updateServerName(opts: Options): void {
  const ctx = requireInstall(opts);
  const current = ctx.env.SERVER_NAME || "Gorilator Server";
  const next = ask(`Server display name [${current}]: `).trim() || current;
  writeEnvPatch(ctx, { SERVER_NAME: next }, "Updated server display name.");
  restartDaemon();
  pause();
}

function updateMonitorCredentials(opts: Options): void {
  const ctx = requireInstall(opts);
  const currentUser = ctx.env.MONITOR_USER || "admin";
  const user = ask(`Monitor user [${currentUser}, "none" disables monitor auth]: `).trim();
  if (user.toLowerCase() === "none") {
    writeEnvPatch(ctx, { MONITOR_USER: "", MONITOR_PASS: "" }, "Disabled monitor auth.");
    restartDaemon();
    pause();
    return;
  }

  const nextUser = user || currentUser;
  const pass = ask("Monitor password [blank generates a new one]: ").trim() || genSecret();
  writeEnvPatch(ctx, { MONITOR_USER: nextUser, MONITOR_PASS: pass }, "Updated monitor credentials.");
  restartDaemon();
  log.ok(`Monitor user ${nextUser}; password ${pass}`);
  pause();
}

function updateOptionalEnv(opts: Options, key: string, label: string): void {
  const ctx = requireInstall(opts);
  const current = ctx.env[key] || "";
  const next = ask(`${label} [${current || "default"}; "none" clears]: `).trim();
  if (!next) return;
  writeEnvPatch(ctx, { [key]: next.toLowerCase() === "none" ? "" : next }, `Updated ${key}.`);
  restartDaemon();
  pause();
}

function updateCustomEnv(opts: Options): void {
  const allowed = [
    "MONITOR_USER",
    "MONITOR_PASS",
    "SERVER_NAME",
    "SERVER_STATS_FILE",
  ];
  process.stdout.write(`Supported keys:\n${allowed.map((k) => `  ${k}`).join("\n")}\n`);
  const key = ask("Env key: ").trim();
  if (!allowed.includes(key)) {
    log.warn("Unsupported env key. No change made.");
    pause();
    return;
  }
  const value = ask(`Value for ${key} ("none" clears): `).trim();
  const ctx = requireInstall(opts);
  writeEnvPatch(ctx, { [key]: value.toLowerCase() === "none" ? "" : value }, `Updated ${key}.`);
  restartDaemon();
  pause();
}

interface CloudflareCtx {
  appDir: string;
  port: number;
  user: string;
  env: EnvMap;
  /** Whether the client bundle is already built same-origin (skip rebuild). */
  sameOrigin: boolean;
}

async function configureCloudflare(
  opts: Options,
  { pauseAtEnd = true, mode: forcedMode }: { pauseAtEnd?: boolean; mode?: TunnelMode } = {},
): Promise<void> {
  const cfg = loadConfig();
  const appDir = cfg?.appDir ?? opts.appDir;
  const ef = envFile(appDir);
  const env = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  const cf: CloudflareCtx = {
    appDir,
    port: cfg?.port ?? opts.port,
    user: cfg?.user ?? targetUser(),
    env,
    sameOrigin: env.VITE_SAME_ORIGIN === "1" && !env.VITE_SERVER_URL && !env.CLIENT_PORT,
  };

  const mode = forcedMode ?? (await resolveTunnelMode(opts, env));
  if (mode === "temporary") await setupTemporaryTunnel(cf);
  else await setupPermanentTunnel(cf);
  if (pauseAtEnd) pause();
}

/** Decide temporary vs permanent. A domain/host in the environment forces a
 *  permanent (named) tunnel; otherwise temporary is the default — chosen
 *  interactively when possible, else taken as the no-login default. */
async function resolveTunnelMode(opts: Options, env: EnvMap): Promise<TunnelMode> {
  if (CLOUDFLARE_ENV_KEYS.some((k) => Boolean(process.env[k]))) return "permanent";
  if (!canPrompt() || opts.yes) return "temporary";
  const current = (env.TUNNEL_MODE as TunnelMode) || undefined;
  const choice = await selectMenu(
    `Cloudflare tunnel type${current ? ` (current: ${current})` : ""}`,
    [
      { label: "Temporary", hint: "quick, no login — random …trycloudflare.com URL" },
      { label: "Permanent", hint: "your own domain — requires a Cloudflare login" },
    ],
  );
  return choice === 1 ? "permanent" : "temporary";
}

/** Temporary (quick) tunnel: a boot service runs `cloudflared tunnel --url`, no
 *  Cloudflare account needed. The public URL is ephemeral (…trycloudflare.com)
 *  and may change if the tunnel restarts; the same-origin client copes with that. */
async function setupTemporaryTunnel(cf: CloudflareCtx): Promise<void> {
  log.info("Setting up a temporary Cloudflare tunnel (quick, no Cloudflare account)…");
  if (cf.env.TUNNEL_MODE === "permanent") {
    if (uninstallTunnelService()) log.ok("Stopped the previous permanent tunnel service.");
    removeTunnelLocalConfig();
  }
  // Tunnel the port the server actually serves on right now.
  const port = Number(cf.env.GAME_SERVER_PORT) || cf.port;

  // Build same-origin + (re)start the daemon FIRST, and confirm it's healthy, so
  // the tunnel has something to serve before we expose it.
  mergeEnv(
    cf.appDir,
    cf.user,
    {
      TUNNEL_MODE: "temporary",
      VITE_SERVER_URL: "",
      VITE_SAME_ORIGIN: "1",
      CLIENT_PORT: "",
      CLIENT_HOSTNAME: "",
    },
    "Preparing the server for a temporary Cloudflare tunnel.",
  );
  updateConfig({ clientPort: undefined, clientHost: undefined });
  rebuildSameOriginIfNeeded(cf);
  restartDaemonForTunnel();
  if (!(await ensureServing(port))) {
    log.warn(`The server isn't answering on :${port} yet — the tunnel may 502 until it is. Check 'gorilator logs'.`);
  }

  // Now expose the running server.
  installQuickTunnelService(port);
  log.info("Waiting for the tunnel URL…");
  const url = await awaitQuickTunnelUrl();
  const host = url ? url.replace(/^https?:\/\//, "") : "";
  mergeEnv(
    cf.appDir,
    cf.user,
    { SERVER_HOSTNAME: host, PLAY_URL: url ?? "" },
    url ? "Saved the temporary tunnel URL." : "Temporary tunnel configured.",
  );
  updateConfig({ serverHost: host || undefined });

  process.stdout.write("\n");
  if (url) {
    log.ok(`Temporary tunnel is live: ${log.green(url)}`);
    log.info(
      "This URL is ephemeral — it changes if the tunnel restarts. For a stable address, switch to a permanent tunnel.",
    );
  } else {
    log.warn(
      "The tunnel service started but no URL was captured yet — run 'gorilator tunnel status' in a few seconds.",
    );
  }
}

/** Make sure the daemon is answering on `port` before exposing it: quick health
 *  check, then start the service and wait if it isn't up. */
async function ensureServing(port: number): Promise<boolean> {
  if (await waitForHealth(port, 8000)) return true;
  log.info("Server isn't responding yet — starting it…");
  try {
    startService();
  } catch (e) {
    log.warn(`Could not start the daemon: ${(e as Error).message}`);
  }
  return waitForHealth(port);
}

/** Permanent (named) tunnel: requires `cloudflared login` and your own domain;
 *  routes a stable hostname's DNS at the tunnel. */
async function setupPermanentTunnel(cf: CloudflareCtx): Promise<void> {
  log.info("Configuring a permanent Cloudflare tunnel (one public hostname -> the game port).");
  const publicHost = resolvePublicHost();
  log.ok(`Tunneling: ${publicHost} -> :${cf.port} (client + WebSocket + monitor + API)`);

  if (cf.env.TUNNEL_MODE === "temporary") {
    if (removeQuickTunnelService()) log.ok("Stopped the previous temporary tunnel.");
  }

  ensureCloudflared();
  if (!isAuthorized()) {
    log.info("Authorize cloudflared - a browser opens (or copy the printed URL); pick your domain:");
    login();
  } else {
    log.ok("cloudflared already authorized.");
  }

  let id = getTunnelId(TUNNEL_NAME);
  if (!id) {
    log.info(`Creating tunnel '${TUNNEL_NAME}'...`);
    createTunnel(TUNNEL_NAME);
    id = getTunnelId(TUNNEL_NAME);
  } else {
    log.ok(`Tunnel '${TUNNEL_NAME}' already exists (${id}).`);
  }
  if (!id) log.die("Could not determine the tunnel id.");

  writeTunnelConfig(id, publicHost, cf.port);
  log.info("Creating DNS routes...");
  routeDns(publicHost);
  installTunnelService();

  mergeEnv(
    cf.appDir,
    cf.user,
    {
      TUNNEL_MODE: "permanent",
      VITE_SERVER_URL: "",
      VITE_SAME_ORIGIN: "1",
      CLIENT_PORT: "",
      CLIENT_HOSTNAME: "",
      SERVER_HOSTNAME: publicHost,
      PLAY_URL: `https://${publicHost}`,
    },
    "Updated Cloudflare environment settings.",
  );
  updateConfig({ clientPort: undefined, clientHost: undefined, serverHost: publicHost });

  rebuildSameOriginIfNeeded(cf);
  restartDaemonForTunnel();

  const info = readEnvInfo(cf.appDir, cf.port);
  process.stdout.write("\n");
  log.ok("Gorilator Cloudflare tunnel is live - the game is public.");
  printPublic(info);
  process.stdout.write("\n");
  printPorts(info);
}

function rebuildSameOriginIfNeeded(cf: CloudflareCtx): void {
  if (cf.sameOrigin) {
    log.ok("Client bundle is already same-origin; skipping rebuild.");
    return;
  }
  log.info("Rebuilding the client for same-origin HTTPS/WSS...");
  buildClient(cf.appDir);
}

function restartDaemonForTunnel(): void {
  log.info("Restarting the daemon to serve the new client bundle...");
  try {
    restartService();
  } catch (e) {
    log.warn(`Restart failed: ${(e as Error).message}`);
  }
}

function resolvePublicHost(): string {
  const publicHost =
    process.env.GORILATOR_HOST ||
    process.env.GORILATOR_GAME_HOST ||
    process.env.GORILATOR_SERVER_HOST ||
    process.env.GORILATOR_CLIENT_HOST;
  if (publicHost) return publicHost;

  const base = process.env.GORILATOR_DOMAIN || ask("Base domain on Cloudflare (e.g. example.com): ");
  if (!base) log.die("A domain is required (set GORILATOR_DOMAIN or answer the prompt).");
  return promptDefault("  Game subdomain", `game.${base}`);
}

function requireInstall(opts: Options): SetupContext {
  const cfg = loadConfig();
  if (!cfg) log.die("No install record found - run 'gorilator install' first.");
  const appDir = cfg.appDir || opts.appDir;
  return {
    cfg,
    appDir,
    user: cfg.user || targetUser(),
    env: readEnv(appDir),
  };
}

function readEnv(appDir: string): EnvMap {
  const ef = envFile(appDir);
  return existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
}

function writeEnvPatch(ctx: SetupContext, patch: Record<string, string>, message: string): void {
  mergeEnv(ctx.appDir, ctx.user, patch, message);
}

/** Merge a patch into the install's .env, preserving every other key. Re-chowns
 *  to the daemon user when we wrote it as root. Empty values clear keys. */
function mergeEnv(
  appDir: string,
  user: string,
  patch: Record<string, string>,
  message: string,
): void {
  const ef = envFile(appDir);
  const cur = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  writeFileSync(ef, renderEnv({ ...cur, ...patch }), { mode: 0o600 });
  if (isRoot() && user !== "root") run("chown", [user, ef]);
  log.ok(message);
}

function rebuildClientForPorts(appDir: string, serverPort: number, clientPort: number): void {
  if (clientPort && clientPort !== serverPort) {
    log.info(`Rebuilding the client for optional client port -> ws://<host>:${serverPort}...`);
    buildClient(appDir, { serverPort });
    return;
  }
  log.info("Rebuilding the client for one-port same-origin mode...");
  buildClient(appDir);
}

function restartDaemon(): void {
  log.info("Restarting the daemon...");
  try {
    restartService();
    log.ok("Daemon restarted.");
  } catch (e) {
    log.warn(`Restart failed: ${(e as Error).message}`);
  }
}

function promptPort(label: string, current: number, allowDisable: boolean): number {
  for (;;) {
    const raw = ask(`${label} [${current || "disabled"}]: `).trim();
    if (!raw) return current;
    if (allowDisable && (raw === "0" || raw.toLowerCase() === "none")) return 0;
    const port = Number(raw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    log.warn("Enter a port from 1 to 65535, or 0/none when disabling is allowed.");
  }
}

function maskSecret(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 16) return "set";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function showCurrentSettings(ctx: SetupContext): void {
  const env = ctx.env;
  process.stdout.write(`${log.bold("Install")}\n`);
  process.stdout.write(`  Files: ${ctx.appDir}\n`);
  process.stdout.write(`  Ref:   ${ctx.cfg.ref}\n\n`);
  process.stdout.write(`${log.bold("Server")}\n`);
  process.stdout.write(`  GAME_SERVER_PORT: ${env.GAME_SERVER_PORT || ctx.cfg.port}\n`);
  process.stdout.write(`  CLIENT_PORT:      ${env.CLIENT_PORT || "(disabled)"}\n`);
  process.stdout.write(`  SERVER_NAME:      ${env.SERVER_NAME || "Gorilator Server"}\n`);
  process.stdout.write(`  SERVER_STATS_FILE: ${env.SERVER_STATS_FILE || ".server-realms.json"}\n\n`);
  process.stdout.write(`${log.bold("Nostr")}\n`);
  process.stdout.write(`  NOSTR_NSEC: ${maskSecret(env.NOSTR_NSEC)}\n\n`);
  process.stdout.write(`${log.bold("Colyseus Monitor")}\n`);
  process.stdout.write(`  MONITOR_USER: ${env.MONITOR_USER || "(disabled)"}\n`);
  process.stdout.write(`  MONITOR_PASS: ${maskSecret(env.MONITOR_PASS)}\n\n`);
  process.stdout.write(`${log.bold("Cloudflare")}\n`);
  process.stdout.write(`  SERVER_HOSTNAME: ${env.SERVER_HOSTNAME || "(not configured)"}\n`);
  process.stdout.write(`  PLAY_URL:        ${env.PLAY_URL || "(not configured)"}\n`);
}

function pause(): void {
  if (canPrompt()) ask("\nPress Enter to continue...");
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
