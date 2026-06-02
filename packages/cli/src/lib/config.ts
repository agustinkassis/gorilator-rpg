// The install record: where the game lives, what port/ref, which service
// manager was used, and (once `setup` runs) the public Cloudflare hostnames.
// Written to a fixed, platform-specific path during install so a later global
// `gorilator status|start|…` can locate the install.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPath } from "./paths.js";
import { writeFileMaybeSudo } from "./proc.js";

export interface InstallConfig {
  appDir: string;
  port: number;
  /** Dedicated port the client page is served on (separate from the server port). */
  clientPort?: number;
  repo: string;
  ref: string;
  user: string;
  serviceManager: string;
  /** Legacy public client hostname from old split-host setups. */
  clientHost?: string;
  /** Public game hostname set by `gorilator setup` (default `game.*`). */
  serverHost?: string;
}

export function loadConfig(): InstallConfig | null {
  const candidates = [configPath(), join(homedir(), ".gorilator", "config.json")];
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

export function saveConfig(cfg: InstallConfig): void {
  writeFileMaybeSudo(configPath(), JSON.stringify(cfg, null, 2) + "\n", 0o644);
}

/** Merge a patch into the existing install record (or create it). */
export function updateConfig(patch: Partial<InstallConfig>): InstallConfig | null {
  const cur = loadConfig();
  if (!cur) return null;
  const next = { ...cur, ...patch };
  saveConfig(next);
  return next;
}
