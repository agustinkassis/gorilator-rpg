// cloudflared helpers — a typed port of the bash CLI's tunnel setup. Installs
// cloudflared, authorizes it, creates/locates the named tunnel, writes its
// ingress config (one public hostname → the game port), routes DNS, and runs it
// as a boot service. Linux (systemd) is the primary target; macOS uses Homebrew.
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as log from "./log.js";
import { TUNNEL_NAME, cloudflaredDir, isLinux, isMac } from "./paths.js";
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
  const credsSrc = join(homedir(), ".cloudflared", `${id}.json`);
  const dir = cloudflaredDir();
  let credsPath = credsSrc;
  if (isLinux) {
    // The system cloudflared service reads from /etc/cloudflared; copy creds there.
    credsPath = join(dir, `${id}.json`);
    runPrivileged("mkdir", ["-p", dir]);
    runPrivileged("cp", [credsSrc, credsPath]);
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

/** Stop the cloudflared boot service when a public tunnel has been configured.
 *  Returns false when the platform has no known service manager or the service
 *  is not installed/running. */
export function stopTunnelService(): boolean {
  if (isLinux) return tryPrivileged("systemctl", ["stop", "cloudflared"]);
  if (which("brew")) return tryRun("brew", ["services", "stop", "cloudflared"]);
  return false;
}

/** Start the cloudflared boot service after the game daemon is healthy again. */
export function startTunnelService(): boolean {
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
  if (isLinux) {
    if (tryPrivileged("systemctl", ["restart", "cloudflared"])) log.ok("Tunnel restarted.");
  } else if (which("brew")) {
    if (tryRun("brew", ["services", "restart", "cloudflared"])) log.ok("Tunnel restarted.");
  } else {
    log.warn("Don't know how to restart cloudflared on this platform — restart it manually.");
  }
}
