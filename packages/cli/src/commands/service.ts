// `gorilator start|stop|restart|status|logs` — drive the OS service.
import { loadConfig } from "../lib/config.js";
import type { RuntimeContext } from "../lib/context.js";
import { probeHealth } from "../lib/health.js";
import * as log from "../lib/log.js";
import type { Options } from "../lib/options.js";
import { defaultAppDir } from "../lib/paths.js";
import {
  logsProjectDev,
  printProjectStatus,
  restartProjectDev,
  startProjectDev,
  stopProjectDev,
} from "../lib/projectDev.js";
import {
  logsService,
  manager,
  restartService,
  startService,
  statusService,
  stopService,
} from "../lib/service.js";
import { printPackageVersions, printPorts, printPublic, readEnvInfo } from "../lib/summary.js";

export async function startCmd(ctx?: RuntimeContext, opts?: Options): Promise<void> {
  if (ctx?.kind === "project") {
    await startProjectDev(ctx, requireOptions(opts));
    return;
  }
  startService();
  log.ok("Started.");
  // Show where it now listens so the user knows what to point a tunnel/browser at.
  const cfg = loadConfig();
  const appDir = cfg?.appDir ?? defaultAppDir();
  const info = readEnvInfo(appDir, cfg?.port ?? 2567, cfg?.clientPort);
  printPorts(info);
  printPublic(info);
}

export async function stopCmd(ctx?: RuntimeContext): Promise<void> {
  if (ctx?.kind === "project") {
    await stopProjectDev(ctx);
    return;
  }
  stopService();
  log.ok("Stopped.");
}

export async function restartCmd(ctx?: RuntimeContext, opts?: Options): Promise<void> {
  if (ctx?.kind === "project") {
    await restartProjectDev(ctx, requireOptions(opts));
    return;
  }
  restartService();
  log.ok("Restarted.");
}

export interface LogsFlags {
  lines?: string;
  follow?: boolean;
  "no-follow"?: boolean;
  filter?: string;
  since?: string;
}

export function logsCmd(ctx?: RuntimeContext, flags: LogsFlags = {}): void {
  if (ctx?.kind === "project") {
    logsProjectDev(ctx);
    return;
  }
  const cfg = loadConfig();
  const lines = parseLines(flags.lines);
  const follow = Boolean(flags.follow) && !flags["no-follow"];
  if (flags.filter) log.info(`Filtering logs by: ${flags.filter}`);
  if (follow) log.info("Following logs in realtime. Press Ctrl-C to stop.");
  logsService(cfg?.appDir ?? defaultAppDir(), {
    lines,
    follow,
    filter: flags.filter,
    since: flags.since,
  });
}

function parseLines(raw: string | undefined): number {
  if (!raw) return 100;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n <= 10000) return n;
  log.warn(`Invalid --lines value '${raw}', using 100.`);
  return 100;
}

/** `gorilator status` (alias `info`) — service state + health + ports + URLs. */
export async function statusCmd(ctx?: RuntimeContext, opts?: Options): Promise<void> {
  if (ctx?.kind === "project") {
    await printProjectStatus(ctx, requireOptions(opts));
    return;
  }
  const cfg = loadConfig();
  const s = statusService();
  const state = s.active ? log.green("active") : log.yellow("inactive");
  process.stdout.write(`${log.bold("Service")} (${manager()}): ${state}\n`);
  if (cfg) {
    const info = readEnvInfo(cfg.appDir, cfg.port, cfg.clientPort);
    const healthy = await probeHealth(info.port);
    printPorts(info, healthy);
    process.stdout.write(`  Files  : ${cfg.appDir}  (ref ${cfg.ref})\n`);
    printPackageVersions(cfg.appDir);
    printPublic(info);
  } else {
    printPackageVersions(process.cwd());
    log.warn("No install record found — run 'gorilator install' first.");
  }
  if (s.raw) process.stdout.write(`\n${log.dim(s.raw)}\n`);
}

function requireOptions(opts: Options | undefined): Options {
  if (!opts) log.die("Internal error: project commands require resolved options.");
  return opts;
}
