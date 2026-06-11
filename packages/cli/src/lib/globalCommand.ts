// Helpers for making the installed `gorilator` command durable. `npx` places a
// temporary shim on PATH while it runs; that must not count as a real install.
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import * as log from "./log.js";
import { isMac } from "./paths.js";
import {
  activateNpmGlobalBin,
  isRoot,
  pathDirs as getPathDirs,
  tryPrivileged,
  tryRun,
  which,
} from "./proc.js";

export function isTemporaryNpxCommand(commandPath: string): boolean {
  const normalized = commandPath.replace(/\\/g, "/");
  return normalized.includes("/_npx/") || normalized.includes("/.npm/_npx/");
}

export function durableGorilatorOnPath(): string | null {
  const found = which("gorilator");
  if (!found || isTemporaryNpxCommand(found)) return null;
  return found;
}

/** Refresh the globally-installed `gorilator` command so it matches an updated
 *  checkout (used by `gorilator update`). No-op when the global command is the
 *  in-repo wrapper symlink (it already tracks the checkout) or an npx shim.
 *  Otherwise reinstalls the global command FROM the checkout's `packages/cli`, so
 *  it exactly matches the just-updated code regardless of what's on npm (avoids
 *  any chance of downgrading). Best-effort — never throws. */
export function refreshGlobalCli(appDir: string): void {
  const found = durableGorilatorOnPath();
  if (!found) {
    log.info("No durable global 'gorilator' command found — skipping global CLI refresh.");
    return;
  }
  if (isWrapperShim(found)) {
    log.ok("Global 'gorilator' is the in-repo wrapper — it already tracks the updated checkout.");
    return;
  }
  const cliDir = join(appDir, "packages", "cli");
  if (!existsSync(join(cliDir, "package.json"))) {
    log.warn("The checkout has no packages/cli — skipping global CLI refresh.");
    return;
  }
  const version = checkoutCliVersion(appDir);
  log.info(`Refreshing the global gorilator command from the updated checkout${version ? ` (${version})` : ""}…`);
  if (npmInstallGlobal(cliDir)) {
    activateNpmGlobalBin();
    log.ok(`Global 'gorilator' command updated${version ? ` to ${version}` : ""}.`);
    return;
  }
  log.warn(`Could not refresh the global gorilator command — run 'npm i -g ${cliDir}' manually.`);
}

function checkoutCliVersion(appDir: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(appDir, "packages", "cli", "package.json"), "utf8"),
    ) as { version?: string };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version : null;
  } catch {
    return null;
  }
}

function npmInstallGlobal(target: string): boolean {
  if (tryRun("npm", ["install", "-g", target])) return true;
  if (!isRoot() && tryRun("sudo", ["npm", "install", "-g", target])) return true;
  return false;
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
  return new Set(getPathDirs());
}

function tryDirectOrPrivileged(cmd: string, args: string[]): boolean {
  const direct = spawnSync(cmd, args, { stdio: "ignore" });
  if (!direct.error && direct.status === 0) return true;
  if (isRoot()) return false;
  return tryPrivileged(cmd, args);
}
