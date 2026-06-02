// Helpers for making the installed `gorilator` command durable. `npx` places a
// temporary shim on PATH while it runs; that must not count as a real install.
import { lstatSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import * as log from "./log.js";
import { isMac } from "./paths.js";
import { isRoot, tryPrivileged, which } from "./proc.js";

export function isTemporaryNpxCommand(commandPath: string): boolean {
  const normalized = commandPath.replace(/\\/g, "/");
  return normalized.includes("/_npx/") || normalized.includes("/.npm/_npx/");
}

export function durableGorilatorOnPath(): string | null {
  const found = which("gorilator");
  if (!found || isTemporaryNpxCommand(found)) return null;
  return found;
}

export function installWrapperGlobalCommand(appDir: string): string | null {
  const wrapper = join(appDir, "cli", "gorilator");
  const shim = preferredShimPath();
  log.info(`Linking the global gorilator command at ${shim}...`);

  if (!tryDirectOrPrivileged("mkdir", ["-p", dirname(shim)])) {
    log.warn(`Could not create ${dirname(shim)}.`);
    return null;
  }
  if (!tryDirectOrPrivileged("chmod", ["+x", wrapper])) {
    log.warn(`Could not make ${wrapper} executable.`);
    return null;
  }
  if (!tryDirectOrPrivileged("ln", ["-sfn", wrapper, shim])) {
    log.warn(`Could not link ${shim} -> ${wrapper}.`);
    return null;
  }

  log.ok(`Global 'gorilator' command linked at ${shim}.`);
  if (!pathDirs().has(dirname(shim))) {
    log.warn(`${dirname(shim)} is not in this shell's PATH. Add it to PATH or open a login shell.`);
  }
  return shim;
}

export function removeWrapperGlobalCommands(): boolean {
  let removed = false;
  for (const shim of candidateShimPaths()) {
    if (!isWrapperShim(shim)) continue;
    if (tryDirectOrPrivileged("rm", ["-f", shim])) removed = true;
  }
  return removed;
}

function preferredShimPath(): string {
  const dirs = pathDirs();
  const candidates = isMac ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin"];
  return join(candidates.find((dir) => dirs.has(dir)) ?? candidates[0], "gorilator");
}

function candidateShimPaths(): string[] {
  const paths = ["/usr/local/bin/gorilator", "/opt/homebrew/bin/gorilator"];
  const found = durableGorilatorOnPath();
  if (found) paths.unshift(found);
  return [...new Set(paths)];
}

function isWrapperShim(shim: string): boolean {
  try {
    if (!lstatSync(shim).isSymbolicLink()) return false;
    const target = readlinkSync(shim);
    const absoluteTarget = target.startsWith("/") ? target : resolve(dirname(shim), target);
    return absoluteTarget.replace(/\\/g, "/").endsWith("/cli/gorilator");
  } catch {
    return false;
  }
}

function pathDirs(): Set<string> {
  return new Set((process.env.PATH ?? "").split(":").filter(Boolean));
}

function tryDirectOrPrivileged(cmd: string, args: string[]): boolean {
  const direct = spawnSync(cmd, args, { stdio: "ignore" });
  if (!direct.error && direct.status === 0) return true;
  if (isRoot()) return false;
  return tryPrivileged(cmd, args);
}
