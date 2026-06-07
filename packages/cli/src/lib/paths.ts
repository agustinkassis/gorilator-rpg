// Per-OS path & identifier resolution. Targets Linux (systemd) and macOS
// (launchd); POSIX assumptions throughout (PATH split on ":").
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const PLATFORM = platform();
export const isLinux = PLATFORM === "linux";
export const isMac = PLATFORM === "darwin";

/** Where the game is cloned. System-wide on Linux, per-user on macOS. */
export function defaultAppDir(): string {
  return isMac ? join(homedir(), ".gorilator", "app") : "/opt/gorilator";
}

export const serverDir = (appDir: string): string => join(appDir, "packages", "server");
export const clientDist = (appDir: string): string => join(appDir, "packages", "client", "dist");
export const cliEntryPath = (appDir: string): string =>
  join(appDir, "packages", "cli", "dist", "index.js");
export const envFile = (appDir: string): string => join(appDir, ".env");
export const logFile = (appDir: string): string => join(appDir, "gorilator.log");

// --- service identifiers ---
export const SYSTEMD_UNIT = "gorilator.service";
export const SYSTEMD_UNIT_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}`;
export const LAUNCHD_LABEL = "com.gorilator.daemon";
export const launchdPlistPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

// --- cloudflared identifiers ---
export const TUNNEL_NAME = "gorilator-rpg";
/** cloudflared config dir. System-wide on Linux; per-user on macOS (Homebrew). */
export function cloudflaredDir(): string {
  return isMac ? join(homedir(), ".cloudflared") : "/etc/cloudflared";
}

// Quick (temporary) tunnel — a dedicated boot service that runs
// `cloudflared tunnel --url http://localhost:PORT` (ephemeral *.trycloudflare.com,
// no Cloudflare account). Kept separate from the named-tunnel `cloudflared`
// service so the two never collide.
export const QUICK_TUNNEL_SYSTEMD_UNIT = "gorilator-tunnel.service";
export const QUICK_TUNNEL_SYSTEMD_UNIT_PATH = `/etc/systemd/system/${QUICK_TUNNEL_SYSTEMD_UNIT}`;
export const QUICK_TUNNEL_LAUNCHD_LABEL = "com.gorilator.tunnel";
export const quickTunnelPlistPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${QUICK_TUNNEL_LAUNCHD_LABEL}.plist`);
/** Where the quick tunnel's stdout/stderr (incl. the trycloudflare URL) lands. */
export const quickTunnelLog = (): string => join(cloudflaredDir(), "quick-tunnel.log");

/** Fixed, platform-specific location for the install record (so the global
 *  `gorilator` command can find the install on later invocations). */
export function configPath(): string {
  return isMac ? join(homedir(), ".gorilator", "config.json") : "/etc/gorilator/config.json";
}
