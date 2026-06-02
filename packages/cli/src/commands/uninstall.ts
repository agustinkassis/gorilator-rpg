// `gorilator uninstall` — stop and remove Gorilator from the local machine.
import { existsSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import {
  removeTunnelLocalConfig,
  uninstallTunnelService,
} from "../lib/cloudflare.js";
import { loadConfig } from "../lib/config.js";
import { removeWrapperGlobalCommands } from "../lib/globalCommand.js";
import * as log from "../lib/log.js";
import type { Options } from "../lib/options.js";
import { configPath } from "../lib/paths.js";
import { confirm, isRoot, tryPrivileged, tryRun, which } from "../lib/proc.js";
import { uninstallService } from "../lib/service.js";

export function uninstall(opts: Options): void {
  const cfg = loadConfig();
  const appDir = cfg?.appDir ?? opts.appDir;
  const details = [
    "stop and unregister the Gorilator daemon",
    opts.keepTunnel ? "keep the local cloudflared tunnel service/config" : "stop and remove local cloudflared service/config",
    opts.keepCommand ? "keep the global gorilator command" : "remove the global gorilator command",
    opts.keepFiles ? `keep installed files at ${appDir}` : `remove installed files at ${appDir}`,
  ];
  process.stdout.write(`This will:\n  - ${details.join("\n  - ")}\n`);
  if (!confirm("Continue uninstalling Gorilator from this machine?", opts.yes)) {
    log.info("Aborted.");
    return;
  }

  removeDaemon();
  if (!opts.keepTunnel) removeTunnel();
  removeInstallRecord();
  if (!opts.keepCommand) removeGlobalCommand();
  if (!opts.keepFiles) removeInstalledFiles(appDir);

  log.ok("Gorilator uninstall complete.");
  if (!opts.keepTunnel) {
    log.info(
      "Cloudflare account-level tunnel/DNS resources are left untouched. Delete them in Cloudflare if you no longer need them.",
    );
  }
  if (opts.keepFiles) log.info(`Files kept at ${appDir}.`);
}

function removeDaemon(): void {
  try {
    uninstallService();
  } catch (err) {
    log.warn(`Could not remove Gorilator daemon cleanly: ${(err as Error).message}`);
  }
}

function removeTunnel(): void {
  if (uninstallTunnelService()) log.ok("cloudflared service stopped/removed.");
  else log.warn("No local cloudflared service was removed.");
  removeTunnelLocalConfig();
  log.ok("Local cloudflared config/credentials removed.");
}

function removeInstallRecord(): void {
  const paths = [configPath(), join(homedir(), ".gorilator", "config.json")];
  for (const p of new Set(paths)) removePath(p, { recursive: false });
  // Linux keeps the record in /etc/gorilator; macOS keeps it under ~/.gorilator
  // beside the app dir, so only remove the now-empty config directory.
  removePath(dirname(configPath()), { recursive: true, emptyOnly: true });
}

function removeGlobalCommand(): void {
  const removedWrapper = removeWrapperGlobalCommands();
  if (!which("npm")) {
    if (removedWrapper) {
      log.ok("Global gorilator command removed.");
      return;
    }
    log.warn("npm not found; could not remove the global gorilator command.");
    return;
  }
  if (tryRun("npm", ["uninstall", "-g", "gorilator"])) {
    log.ok("Global gorilator command removed.");
    return;
  }
  if (!isRoot() && tryRun("sudo", ["npm", "uninstall", "-g", "gorilator"])) {
    log.ok("Global gorilator command removed.");
    return;
  }
  if (removedWrapper) {
    log.ok("Global gorilator wrapper command removed.");
    return;
  }
  log.warn("Could not remove the global gorilator command; run: npm uninstall -g gorilator");
}

function removeInstalledFiles(appDir: string): void {
  const target = resolve(appDir);
  if (!isSafeAppDir(target)) {
    log.warn(`Refusing to remove ${target}; it does not look like a Gorilator install.`);
    log.warn("Remove it manually after checking the path.");
    return;
  }
  removePath(target, { recursive: true });
  log.ok(`Installed files removed: ${target}`);
}

function isSafeAppDir(appDir: string): boolean {
  const root = parse(appDir).root;
  if (appDir === root || appDir === resolve(homedir())) return false;
  try {
    const rootPkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as {
      name?: string;
    };
    const cliPkg = JSON.parse(
      readFileSync(join(appDir, "packages", "cli", "package.json"), "utf8"),
    ) as { name?: string };
    return rootPkg.name === "rpg-online" && cliPkg.name === "gorilator";
  } catch {
    return false;
  }
}

function removePath(
  path: string,
  opts: { recursive: boolean; emptyOnly?: boolean },
): void {
  if (!existsSync(path)) return;
  if (opts.emptyOnly) {
    try {
      rmdirSync(path);
    } catch {
      /* Directory still contains something else; keep it. */
    }
    return;
  }
  try {
    rmSync(path, {
      recursive: opts.recursive,
      force: true,
      maxRetries: 2,
    });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (opts.emptyOnly || (code !== "EACCES" && code !== "EPERM")) return;
  }

  const args = opts.recursive ? ["-rf", path] : ["-f", path];
  tryPrivileged("rm", args);
}
