// The install record: where the game lives, what port/ref, which service
// manager was used, and (once `setup` runs) the public Cloudflare hostnames.
// Written to a fixed, platform-specific path during install so a later global
// `gorilator status|start|…` can locate the install.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPath } from "./paths.js";
import { writeFileMaybeSudo } from "./proc.js";

/** What an install created for its Cloudflare tunnel, so update/uninstall touch
 *  ONLY this install's resources (and never another install's). */
export interface TunnelRecord {
  mode: "temporary" | "permanent";
  /** The per-install quick-tunnel service unit/label (temporary). */
  service?: string;
  /** The quick-tunnel log path (temporary). */
  logPath?: string;
  /** The cloudflared tunnel name (permanent, e.g. `gorilator-rpg`). */
  name?: string;
  /** Routed public hostnames (permanent). */
  hosts?: string[];
  /** True when the permanent tunnel uses the shared system `cloudflared` service. */
  sharedService?: boolean;
  /** Last-known public URL (temporary's …trycloudflare.com, or https://host). */
  url?: string;
}

export interface InstallConfig {
  appDir: string;
  port: number;
  /** Dedicated port the client page is served on (separate from the server port). */
  clientPort?: number;
  repo: string;
  ref: string;
  /** "latest" when tracking the newest published release — `update` re-resolves
   *  the newest release tag each run. Absent for a pinned branch/tag ref. */
  channel?: "latest";
  user: string;
  serviceManager: string;
  /** Legacy public client hostname from old split-host setups. */
  clientHost?: string;
  /** Public game hostname set by `gorilator setup` (default `game.*`). */
  serverHost?: string;
  /** What this install created for its Cloudflare tunnel (set by `setup`). */
  tunnel?: TunnelRecord;
}

/** A stable per-install id, derived from the install dir so it needs no
 *  migration and is identical across runs. Keys every per-install tunnel
 *  resource (service name, log) so multiple installs never collide. */
export function installId(cfg: Pick<InstallConfig, "appDir">): string {
  return createHash("sha1").update(cfg.appDir).digest("hex").slice(0, 8);
}

export function loadConfig(path?: string): InstallConfig | null {
  const candidates = path ? [path] : [configPath(), join(homedir(), ".gorilator", "config.json")];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as InstallConfig;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function saveConfig(cfg: InstallConfig, path = configPath()): void {
  writeFileMaybeSudo(path, JSON.stringify(cfg, null, 2) + "\n", 0o644);
}

/** Merge a patch into the existing install record (or create it). */
export function updateConfig(
  patch: Partial<InstallConfig>,
  path?: string,
): InstallConfig | null {
  const cur = loadConfig(path);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  saveConfig(next, path);
  return next;
}
