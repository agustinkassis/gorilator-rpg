// cloudflared helpers — a typed port of the bash CLI's tunnel setup. Installs
// cloudflared, authorizes it, creates/locates the named tunnel, writes its
// ingress config (one public hostname → the game port), routes DNS, and runs it
// as a boot service. Linux (systemd) is the primary target; macOS uses Homebrew.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { parseEnv } from "./env.js";
import * as log from "./log.js";
import {
  cloudflaredDir,
  envFile,
  isLinux,
  isMac,
  QUICK_TUNNEL_LAUNCHD_LABEL,
  QUICK_TUNNEL_SYSTEMD_UNIT,
  QUICK_TUNNEL_SYSTEMD_UNIT_PATH,
  quickTunnelLog,
  quickTunnelPlistPath,
  TUNNEL_NAME,
} from "./paths.js";
import {
  capture,
  run,
  runPrivileged,
  tryPrivileged,
  tryRun,
  which,
  writeFileMaybeSudo,
} from "./proc.js";

export { TUNNEL_NAME };

export type TunnelMode = "temporary" | "permanent";

/** The configured tunnel mode for the current install, or null if unset/none.
 *  Read from TUNNEL_MODE in the install's .env so tunnel start/stop/restart and
 *  status act on the right service (quick vs named). */
export function activeTunnelMode(): TunnelMode | null {
  const cfg = loadConfig();
  if (!cfg) return null;
  try {
    const env = parseEnv(readFileSync(envFile(cfg.appDir), "utf8"));
    if (env.TUNNEL_MODE === "temporary" || env.TUNNEL_MODE === "permanent") return env.TUNNEL_MODE;
  } catch {
    /* no .env yet */
  }
  return null;
}

/** Map the host architecture to cloudflared's Debian package suffix. */
function debArch(): string | null {
  const a = capture("dpkg", ["--print-architecture"]) ?? process.arch;
  if (a === "amd64" || a === "x64" || a === "x86_64") return "amd64";
  if (a === "arm64" || a === "aarch64") return "arm64";
  if (a === "armhf" || a === "arm" || a === "armv7l") return "armhf";
  return null;
}

/** Ensure cloudflared is installed (arch-matched .deb on Debian/Ubuntu, Homebrew
 *  on macOS). */
function ensureCurl(): void {
  if (which("curl")) return;
  if (isLinux && which("apt-get")) {
    log.info("Installing curl for cloudflared download…");
    runPrivileged("apt-get", ["update", "-y"]);
    runPrivileged("apt-get", ["install", "-y", "ca-certificates", "curl"]);
    return;
  }
  log.die("curl is required to download cloudflared. Install curl and re-run 'gorilator setup'.");
}

export function ensureCloudflared(): void {
  if (which("cloudflared")) {
    log.ok(`cloudflared present: ${capture("cloudflared", ["--version"]) ?? "installed"}`);
    return;
  }
  if (isMac) {
    if (which("brew")) {
      log.info("Installing cloudflared (brew)…");
      run("brew", ["install", "cloudflared"]);
      log.ok("cloudflared installed.");
      return;
    }
    log.die("cloudflared is required. Install it (brew install cloudflared) and re-run 'gorilator setup'.");
  }
  if (isLinux && which("dpkg")) {
    const arch = debArch();
    if (!arch) {
      log.die("Unsupported architecture for the cloudflared .deb — install cloudflared manually and re-run.");
    }
    const deb = `/tmp/cloudflared-${arch}.deb`;
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb`;
    log.info(`Downloading cloudflared (${arch})…`);
    ensureCurl();
    run("curl", ["-fsSL", "-o", deb, url]);
    if (!tryPrivileged("dpkg", ["-i", deb])) tryPrivileged("apt-get", ["install", "-f", "-y"]);
    log.ok("cloudflared installed.");
    return;
  }
  log.die("cloudflared is required but not installed. Install it manually and re-run 'gorilator setup'.");
}

/** Whether cloudflared has a cert (i.e. the user has authorized a zone). */
export function isAuthorized(): boolean {
  return existsSync(join(homedir(), ".cloudflared", "cert.pem"));
}

/** Open the browser-based authorization flow (writes ~/.cloudflared/cert.pem). */
export function login(): void {
  run("cloudflared", ["tunnel", "login"]);
}

/** Look up an existing tunnel's UUID by name, or null. */
export function getTunnelId(name = TUNNEL_NAME): string | null {
  const out = capture("cloudflared", ["tunnel", "list"]);
  if (!out) return null;
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2 && cols[1] === name) return cols[0];
  }
  return null;
}

/** Create the named tunnel (writes ~/.cloudflared/<id>.json credentials). */
export function createTunnel(name = TUNNEL_NAME): void {
  run("cloudflared", ["tunnel", "create", name]);
}

/** Return a local credentials JSON file for the tunnel. Existing tunnels may be
 *  visible through `cloudflared tunnel list` even when this machine lacks the
 *  `<id>.json` file, so fetch it with the token helper before configuring the
 *  service. */
function ensureTunnelCredentials(id: string): string {
  const creds = join(homedir(), ".cloudflared", `${id}.json`);
  if (existsSync(creds)) return creds;

  log.warn(`Tunnel '${id}' exists, but local credentials are missing at ${creds}.`);
  log.info("Fetching tunnel credentials...");
  mkdirSync(dirname(creds), { recursive: true });
  if (tryRun("cloudflared", ["tunnel", "token", "--cred-file", creds, id]) && existsSync(creds)) {
    log.ok("Tunnel credentials saved locally.");
    return creds;
  }

  log.die(
    `Could not fetch credentials for tunnel '${id}'. Run ` +
      `cloudflared tunnel token --cred-file ${creds} ${id} and retry, ` +
      "or remove the old Cloudflare tunnel and run setup again.",
  );
}

/** Render the ingress config: the public hostname maps to the local game port
 *  (one native process serves the client page, WebSocket/API, and monitor). */
function renderConfig(
  id: string,
  credsPath: string,
  routes: { host: string; port: number }[],
): string {
  const ingress = routes
    .map((r) => `  - hostname: ${r.host}\n    service: http://localhost:${r.port}`)
    .join("\n");
  return `tunnel: ${id}
credentials-file: ${credsPath}
ingress:
${ingress}
  - service: http_status:404
`;
}

/** Write config.yml (+ copy credentials into the system dir on Linux). */
export function writeTunnelConfig(
  id: string,
  host: string,
  port: number,
): void {
  const credsSrc = ensureTunnelCredentials(id);
  const dir = cloudflaredDir();
  let credsPath = credsSrc;
  if (isLinux) {
    // The system cloudflared service reads from /etc/cloudflared; copy creds there.
    credsPath = join(dir, `${id}.json`);
    runPrivileged("mkdir", ["-p", dir]);
    runPrivileged("cp", [credsSrc, credsPath]);
    runPrivileged("chmod", ["600", credsPath]);
  }
  log.info(`Writing ${join(dir, "config.yml")}…`);
  writeFileMaybeSudo(
    join(dir, "config.yml"),
    renderConfig(id, credsPath, [{ host, port }]),
    0o644,
  );
}

/** Point a hostname's DNS at the tunnel (idempotent; warns if it already exists). */
export function routeDns(host: string, name = TUNNEL_NAME): void {
  if (!tryRun("cloudflared", ["tunnel", "route", "dns", name, host])) {
    log.warn(`DNS for ${host} may already exist (skipped).`);
  }
}

/** Install + start cloudflared as a boot service that runs the configured tunnel. */
export function installTunnelService(): void {
  if (isLinux) {
    tryPrivileged("cloudflared", ["service", "install"]);
    tryPrivileged("systemctl", ["enable", "--now", "cloudflared"]);
    log.ok("cloudflared is running and enabled on boot.");
    return;
  }
  if (which("brew")) {
    tryRun("brew", ["services", "restart", "cloudflared"]);
    log.ok("cloudflared started via brew services.");
    return;
  }
  tryRun("cloudflared", ["service", "install"]);
  log.ok("cloudflared service installed.");
}

/** Stop the active tunnel boot service (quick or named). Returns false when the
 *  platform has no known service manager or the service is not installed. */
export function stopTunnelService(): boolean {
  if (activeTunnelMode() === "temporary") return stopQuickTunnelService();
  if (isLinux) return tryPrivileged("systemctl", ["stop", "cloudflared"]);
  if (which("brew")) return tryRun("brew", ["services", "stop", "cloudflared"]);
  return false;
}

/** Start the active tunnel boot service (quick or named). */
export function startTunnelService(): boolean {
  if (activeTunnelMode() === "temporary") return startQuickTunnelService();
  if (isLinux) return tryPrivileged("systemctl", ["start", "cloudflared"]);
  if (which("brew")) return tryRun("brew", ["services", "start", "cloudflared"]);
  return false;
}

/** Stop and unregister the local cloudflared boot service. This intentionally
 *  does not uninstall the cloudflared binary because it may be shared by other
 *  tunnels or installed by a package manager. */
export function uninstallTunnelService(): boolean {
  let changed = false;
  if (isLinux) {
    changed = tryPrivileged("systemctl", ["stop", "cloudflared"]) || changed;
    changed = tryPrivileged("systemctl", ["disable", "cloudflared"]) || changed;
    if (which("cloudflared")) {
      changed = tryPrivileged("cloudflared", ["service", "uninstall"]) || changed;
    }
    changed = tryPrivileged("systemctl", ["daemon-reload"]) || changed;
    return changed;
  }
  if (which("brew")) {
    changed = tryRun("brew", ["services", "stop", "cloudflared"]) || changed;
  } else if (which("cloudflared")) {
    changed = tryRun("cloudflared", ["service", "uninstall"]) || changed;
  }
  return changed;
}

/** Remove the local config/credentials files that `gorilator setup` writes.
 *  This leaves ~/.cloudflared/cert.pem and the remote Cloudflare tunnel/DNS
 *  untouched; those are account-level resources, not local system state. */
export function removeTunnelLocalConfig(name = TUNNEL_NAME): void {
  const id = which("cloudflared") ? getTunnelId(name) : null;
  const paths = [
    join(cloudflaredDir(), "config.yml"),
    id ? join(cloudflaredDir(), `${id}.json`) : null,
    id ? join(homedir(), ".cloudflared", `${id}.json`) : null,
  ].filter((p): p is string => Boolean(p));

  if (isLinux) {
    for (const p of paths) tryPrivileged("rm", ["-f", p]);
    return;
  }
  for (const p of paths) {
    try {
      rmSync(p, { force: true });
    } catch {
      tryRun("rm", ["-f", p]);
    }
  }
}

// --- `gorilator tunnel <login|status|restart>` ---
export function tunnelLogin(): void {
  login();
}

export function tunnelStatus(): void {
  if (activeTunnelMode() === "temporary") {
    if (isLinux) tryPrivileged("systemctl", ["status", QUICK_TUNNEL_SYSTEMD_UNIT, "--no-pager"]);
    else tryRun("launchctl", ["list", QUICK_TUNNEL_LAUNCHD_LABEL]);
    const url = quickTunnelUrl();
    log.info(url ? `Temporary tunnel URL: ${url}` : "Temporary tunnel URL not captured yet.");
    return;
  }
  if (isLinux) {
    tryPrivileged("systemctl", ["status", "cloudflared", "--no-pager"]);
  } else if (which("brew")) {
    tryRun("brew", ["services", "info", "cloudflared"]);
  } else {
    const id = getTunnelId();
    log.info(id ? `Tunnel '${TUNNEL_NAME}' exists (${id}).` : `Tunnel '${TUNNEL_NAME}' not found.`);
  }
}

export function tunnelRestart(): void {
  if (activeTunnelMode() === "temporary") {
    if (restartQuickTunnelService()) log.ok("Temporary tunnel restarted (URL may change).");
    else log.warn("Could not restart the temporary tunnel service.");
    return;
  }
  if (isLinux) {
    if (tryPrivileged("systemctl", ["restart", "cloudflared"])) log.ok("Tunnel restarted.");
  } else if (which("brew")) {
    if (tryRun("brew", ["services", "restart", "cloudflared"])) log.ok("Tunnel restarted.");
  } else {
    log.warn("Don't know how to restart cloudflared on this platform — restart it manually.");
  }
}

// --- Temporary (quick) tunnel: ephemeral *.trycloudflare.com, no account ---

/** Extract the most recent quick-tunnel URL from cloudflared's log output. */
export function extractQuickTunnelUrl(logText: string): string | null {
  const m = logText.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
  return m && m.length ? m[m.length - 1] : null;
}

function readQuickLog(): string {
  const p = quickTunnelLog();
  try {
    return readFileSync(p, "utf8");
  } catch {
    // /etc/cloudflared may be root-owned when read by a non-root status call.
    if (isLinux) return capture("sudo", ["-n", "cat", p]) ?? "";
    return "";
  }
}

/** The current temporary tunnel URL (https://…trycloudflare.com), or null. */
export function quickTunnelUrl(): string | null {
  return extractQuickTunnelUrl(readQuickLog());
}

function renderQuickUnit(cf: string, port: number, logPath: string): string {
  return `[Unit]
Description=Gorilator quick Cloudflare tunnel (temporary)
Documentation=https://github.com/agustinkassis/gorilator-rpg
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${cf} tunnel --no-autoupdate --url http://localhost:${port}
Restart=on-failure
RestartSec=3
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=multi-user.target
`;
}

function renderQuickPlist(cf: string, port: number, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${QUICK_TUNNEL_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cf}</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>--url</string>
    <string>http://localhost:${port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

/** Install + start the quick-tunnel boot service for the given local port. The
 *  log is truncated first so {@link quickTunnelUrl} reads the fresh URL. */
export function installQuickTunnelService(port: number): void {
  ensureCloudflared();
  const cf = which("cloudflared") ?? "cloudflared";
  const logPath = quickTunnelLog();
  const dir = cloudflaredDir();

  if (isLinux) {
    runPrivileged("mkdir", ["-p", dir]);
    tryPrivileged("rm", ["-f", logPath]);
    log.info(`Writing ${QUICK_TUNNEL_SYSTEMD_UNIT_PATH}…`);
    writeFileMaybeSudo(QUICK_TUNNEL_SYSTEMD_UNIT_PATH, renderQuickUnit(cf, port, logPath), 0o644);
    runPrivileged("systemctl", ["daemon-reload"]);
    runPrivileged("systemctl", ["enable", QUICK_TUNNEL_SYSTEMD_UNIT]);
    runPrivileged("systemctl", ["restart", QUICK_TUNNEL_SYSTEMD_UNIT]);
    log.ok("Temporary tunnel service running and enabled on boot.");
    return;
  }

  mkdirSync(dir, { recursive: true });
  try {
    rmSync(logPath, { force: true });
  } catch {
    /* ignore */
  }
  const plist = quickTunnelPlistPath();
  mkdirSync(dirname(plist), { recursive: true });
  log.info(`Writing ${plist}…`);
  writeFileMaybeSudo(plist, renderQuickPlist(cf, port, logPath), 0o644);
  tryRun("launchctl", ["unload", "-w", plist]);
  tryRun("launchctl", ["load", "-w", plist]);
  log.ok("Temporary tunnel agent running and enabled at login.");
}

export function startQuickTunnelService(): boolean {
  if (isLinux) return tryPrivileged("systemctl", ["start", QUICK_TUNNEL_SYSTEMD_UNIT]);
  return tryRun("launchctl", ["start", QUICK_TUNNEL_LAUNCHD_LABEL]);
}

export function stopQuickTunnelService(): boolean {
  if (isLinux) return tryPrivileged("systemctl", ["stop", QUICK_TUNNEL_SYSTEMD_UNIT]);
  return tryRun("launchctl", ["stop", QUICK_TUNNEL_LAUNCHD_LABEL]);
}

export function restartQuickTunnelService(): boolean {
  if (isLinux) return tryPrivileged("systemctl", ["restart", QUICK_TUNNEL_SYSTEMD_UNIT]);
  stopQuickTunnelService();
  return startQuickTunnelService();
}

/** Stop, disable, and remove the quick-tunnel boot service + its log. */
export function removeQuickTunnelService(): boolean {
  let changed = false;
  if (isLinux) {
    changed = tryPrivileged("systemctl", ["stop", QUICK_TUNNEL_SYSTEMD_UNIT]) || changed;
    changed = tryPrivileged("systemctl", ["disable", QUICK_TUNNEL_SYSTEMD_UNIT]) || changed;
    changed = tryPrivileged("rm", ["-f", QUICK_TUNNEL_SYSTEMD_UNIT_PATH]) || changed;
    tryPrivileged("rm", ["-f", quickTunnelLog()]);
    tryPrivileged("systemctl", ["daemon-reload"]);
    return changed;
  }
  changed = tryRun("launchctl", ["unload", "-w", quickTunnelPlistPath()]) || changed;
  try {
    rmSync(quickTunnelPlistPath(), { force: true });
    rmSync(quickTunnelLog(), { force: true });
    changed = true;
  } catch {
    /* ignore */
  }
  return changed;
}

/** Poll the quick-tunnel log until cloudflared prints its URL (or time out). */
export async function awaitQuickTunnelUrl(timeoutMs = 20_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const url = quickTunnelUrl();
    if (url) return url;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}
