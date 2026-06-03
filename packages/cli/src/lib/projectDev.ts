import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:http";
import { dirname, join } from "node:path";
import { ensureNode, ensurePnpm } from "./build.js";
import { loadProjectConfig, type ProjectDevState, type RuntimeContext } from "./context.js";
import { probeHealth } from "./health.js";
import * as log from "./log.js";
import type { Options } from "./options.js";
import { run, tryRun } from "./proc.js";
import { readEnvInfo } from "./summary.js";

export interface ProjectStatus {
  state: ProjectDevState | null;
  active: boolean;
  stale: boolean;
  serverHealthy: boolean;
  clientActive: boolean;
}

export async function startProjectDev(ctx: RuntimeContext, opts: Options): Promise<void> {
  assertProject(ctx);
  const current = readProjectState(ctx);
  if (current && isPidRunning(current.pid)) {
    log.ok(`Local Gorilator dev is already running (pid ${current.pid}).`);
    await printProjectStatus(ctx, opts);
    return;
  }
  if (current) removeProjectState(ctx);

  ensureNode();
  ensurePnpm();
  ensureLocalDir(ctx);

  const cfg = loadProjectConfig(ctx, opts);
  const logFd = openSync(ctx.logPath!, "a");
  const env = {
    ...process.env,
    GAME_SERVER_PORT: String(cfg.port),
    CLIENT_PORT: String(cfg.clientPort ?? 5173),
    GORILATOR_STATE_FILE: ctx.statePath!,
  };

  const child = spawn(process.execPath, [join(ctx.appDir, "scripts", "dev.mjs")], {
    cwd: ctx.appDir,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();

  if (!child.pid) {
    log.die("Could not start the local dev process.");
  }

  const startedAt = new Date().toISOString();
  writeProjectState(ctx, {
    root: ctx.appDir,
    pid: child.pid,
    serverPort: cfg.port,
    clientPort: cfg.clientPort ?? 5173,
    requestedServerPort: cfg.port,
    requestedClientPort: cfg.clientPort ?? 5173,
    startedAt,
  });

  log.ok(`Started local Gorilator dev (pid ${child.pid}).`);
  await waitForStateRefresh(ctx, child.pid, startedAt);
  await printProjectStatus(ctx, opts);
  process.stdout.write(`  Logs   : ${ctx.logPath}\n`);
}

export async function stopProjectDev(ctx: RuntimeContext): Promise<void> {
  assertProject(ctx);
  const state = readProjectState(ctx);
  if (!state) {
    log.warn("Local Gorilator dev is not running.");
    return;
  }

  if (isPidRunning(state.pid)) {
    terminateProcessGroup(state.pid);
    await waitForExit(state.pid, 8000);
  }
  removeProjectState(ctx);
  log.ok("Stopped local Gorilator dev.");
}

export async function restartProjectDev(ctx: RuntimeContext, opts: Options): Promise<void> {
  await stopProjectDev(ctx);
  await startProjectDev(ctx, opts);
}

export async function projectStatus(ctx: RuntimeContext): Promise<ProjectStatus> {
  assertProject(ctx);
  const state = readProjectState(ctx);
  const active = state ? isPidRunning(state.pid) : false;
  const stale = Boolean(state && !active);
  if (stale) removeProjectState(ctx);
  const serverPort = state?.serverPort;
  const clientPort = state?.clientPort;
  return {
    state: stale ? null : state,
    active,
    stale,
    serverHealthy: active && serverPort ? await probeHealth(serverPort) : false,
    clientActive: active && clientPort ? await probeHttp(clientPort) : false,
  };
}

export async function printProjectStatus(ctx: RuntimeContext, opts: Options): Promise<void> {
  assertProject(ctx);
  const cfg = loadProjectConfig(ctx, opts);
  const status = await projectStatus(ctx);
  const state = status.state;
  const label = status.active ? log.green("active") : log.yellow("inactive");
  process.stdout.write(`${log.bold("Project")} local dev: ${label}\n`);
  process.stdout.write(`  Files  : ${ctx.appDir}\n`);
  if (state) {
    const info = readEnvInfo(ctx.appDir, state.serverPort, state.clientPort);
    process.stdout.write(`  PID    : ${state.pid}\n`);
    process.stdout.write(`  Since  : ${state.startedAt}\n`);
    process.stdout.write(
      `  Client : http://localhost:${state.clientPort}  ${
        status.clientActive ? log.green("(ok)") : log.yellow("(starting...)")
      }\n`,
    );
    process.stdout.write(
      `  Server : http://localhost:${state.serverPort}  ${
        status.serverHealthy ? log.green("(ok)") : log.yellow("(starting...)")
      }\n`,
    );
    const creds = info.monitorUser
      ? `  (user ${info.monitorUser}${info.monitorPass ? ` · pass ${info.monitorPass}` : ""})`
      : "";
    process.stdout.write(`  Monitor: http://localhost:${state.serverPort}/colyseus${creds}\n`);
    if (
      state.serverPort !== state.requestedServerPort ||
      state.clientPort !== state.requestedClientPort
    ) {
      process.stdout.write(
        `  Ports  : requested server ${state.requestedServerPort}, client ${state.requestedClientPort}\n`,
      );
    }
  } else {
    const info = readEnvInfo(ctx.appDir, cfg.port, cfg.clientPort);
    process.stdout.write(`  Client : http://localhost:${info.clientPort ?? 5173}\n`);
    process.stdout.write(`  Server : http://localhost:${info.port}\n`);
    process.stdout.write(`  Monitor: http://localhost:${info.port}/colyseus\n`);
    if (status.stale) log.warn("Removed stale local dev state.");
  }
}

export function logsProjectDev(ctx: RuntimeContext): void {
  assertProject(ctx);
  ensureLocalDir(ctx);
  if (!existsSync(ctx.logPath!)) writeFileSync(ctx.logPath!, "");
  spawnSync("tail", ["-n", "100", "-f", ctx.logPath!], { stdio: "inherit" });
}

export async function updateProjectDev(ctx: RuntimeContext, opts: Options): Promise<void> {
  assertProject(ctx);
  const wasRunning = (await projectStatus(ctx)).active;
  if (wasRunning) await stopProjectDev(ctx);

  const branch = capture("git", ["branch", "--show-current"], ctx.appDir);
  if (branch) {
    log.info(`Pulling latest commits for ${branch} (fast-forward only)...`);
    if (!tryRun("git", ["pull", "--ff-only"], { cwd: ctx.appDir })) {
      log.warn("Git pull failed or was not a fast-forward; continuing with local files.");
    }
  } else {
    log.warn("Detached HEAD; skipping git pull for the local checkout.");
  }

  ensurePnpm();
  run("pnpm", ["install", "--frozen-lockfile"], { cwd: ctx.appDir });
  run("pnpm", ["--filter", "@rpg/shared", "build"], { cwd: ctx.appDir });
  log.ok("Project dependencies and shared build are up to date.");

  if (wasRunning) await startProjectDev(ctx, opts);
}

export function writeProjectState(ctx: RuntimeContext, state: ProjectDevState): void {
  assertProject(ctx);
  ensureLocalDir(ctx);
  writeFileSync(ctx.statePath!, JSON.stringify(state, null, 2) + "\n", { mode: 0o644 });
}

export function readProjectState(ctx: RuntimeContext): ProjectDevState | null {
  assertProject(ctx);
  if (!existsSync(ctx.statePath!)) return null;
  try {
    const raw = JSON.parse(readFileSync(ctx.statePath!, "utf8")) as Partial<ProjectDevState>;
    if (
      typeof raw.root !== "string" ||
      typeof raw.pid !== "number" ||
      typeof raw.serverPort !== "number" ||
      typeof raw.clientPort !== "number" ||
      typeof raw.requestedServerPort !== "number" ||
      typeof raw.requestedClientPort !== "number" ||
      typeof raw.startedAt !== "string"
    ) {
      return null;
    }
    return raw as ProjectDevState;
  } catch {
    return null;
  }
}

function ensureLocalDir(ctx: RuntimeContext): void {
  mkdirSync(dirname(ctx.configPath), { recursive: true });
}

function removeProjectState(ctx: RuntimeContext): void {
  try {
    unlinkSync(ctx.statePath!);
  } catch {
    /* already gone */
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function terminateProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
    return;
  } catch {
    /* fall back to the parent pid */
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidRunning(pid)) return;
    await sleep(250);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function waitForStateRefresh(
  ctx: RuntimeContext,
  pid: number,
  fallbackStartedAt: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const state = readProjectState(ctx);
    if (state?.pid === pid && state.startedAt !== fallbackStartedAt) return;
    await sleep(100);
  }
}

function probeHttp(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/", timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve(Boolean(res.statusCode && res.statusCode < 500)));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function capture(cmd: string, args: string[], cwd: string): string | null {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertProject(ctx: RuntimeContext): void {
  if (ctx.kind !== "project") log.die("This command requires a Gorilator project directory.");
}
