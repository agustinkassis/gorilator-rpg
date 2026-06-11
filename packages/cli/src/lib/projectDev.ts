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
import {
  gitWorktreeName,
  loadProjectConfig,
  readProjectEnv,
  type ProjectDevState,
  type RuntimeContext,
} from "./context.js";
import { probeHealth } from "./health.js";
import * as log from "./log.js";
import { Stepper } from "./progress.js";
import type { Options } from "./options.js";
import { run, tryRun } from "./proc.js";
import { printField, printPackageVersions, printSection, readEnvInfo } from "./summary.js";

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
  // Merge the project's .env so its vars reach the dev process — notably any
  // VITE_* (e.g. VITE_SERVER_URL / VITE_ALLOWED_HOSTS set by the tunnel menu),
  // which Vite picks up from process.env. The explicit ports below win.
  const env = {
    ...process.env,
    ...readProjectEnv(ctx),
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
  await trackProjectServices(ctx, child.pid);
  await printProjectStatus(ctx, opts);
  process.stdout.write(`  Logs   : ${ctx.logPath}\n`);
}

/** Live per-service spinner while the dev server and Vite client come up. Each
 *  tracks until its port answers (or the dev process dies / times out), and
 *  surfaces the relevant log error inline if it doesn't. */
async function trackProjectServices(ctx: RuntimeContext, pid: number): Promise<void> {
  const state = readProjectState(ctx);
  if (!state) return;
  const ui = new Stepper("Starting services", [
    { key: "server", label: `Game server :${state.serverPort}`, estimateMs: 12_000 },
    { key: "client", label: `Client (Vite) :${state.clientPort}`, estimateMs: 16_000 },
  ]);
  ui.start();
  try {
    const serverUp = await ui.run("server", () =>
      pollUntilUp(() => probeHealth(state.serverPort), pid),
    );
    if (!serverUp) ui.fail("server", devError(ctx) ?? "did not come up — check the logs");
    const clientUp = await ui.run("client", () => pollUntilUp(() => probeHttp(state.clientPort), pid));
    if (!clientUp) ui.fail("client", devError(ctx) ?? "did not come up — check the logs");
  } finally {
    ui.finish();
  }
}

/** Poll `check` until it succeeds, the dev process exits, or the timeout. */
async function pollUntilUp(
  check: () => Promise<boolean>,
  pid: number,
  totalMs = 25_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await check()) return true;
    if (!isPidRunning(pid)) return false; // the dev process bailed
    await sleep(400);
  }
  return false;
}

/** The most recent error-looking line from the dev log, for inline reporting. */
function devError(ctx: RuntimeContext): string | null {
  try {
    const lines = readFileSync(ctx.logPath!, "utf8").split(/\r?\n/).filter(Boolean).slice(-80);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/error|EADDRINUSE|already in use|Exit status [1-9]|ELIFECYCLE|exited unexpectedly|failed/i.test(lines[i])) {
        return lines[i].replace(/^\[\w+\]\s*/, "").trim().slice(0, 100);
      }
    }
    return null;
  } catch {
    return null;
  }
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
  printSection("Gorilator Status");
  printField("Mode", "local project");
  printField("State", label);
  printField("Files", ctx.appDir);
  printField("Ref", cfg.ref);
  const wt = gitWorktreeName(ctx.appDir);
  if (wt) printField("Worktree", wt);
  printField("Environment", "development (dev server)");
  if (state) {
    const info = readEnvInfo(ctx.appDir, state.serverPort, state.clientPort);
    printField("PID", String(state.pid));
    printField("Since", state.startedAt);
    process.stdout.write("\n");
    printSection("Local URLs");
    printField(
      "Client",
      `http://localhost:${state.clientPort}  ${
        status.clientActive ? log.green("(ok)") : log.yellow("(starting...)")
      }`,
    );
    printField(
      "Server",
      `http://localhost:${state.serverPort}  ${
        status.serverHealthy ? log.green("(ok)") : log.yellow("(starting...)")
      }`,
    );
    const creds = info.monitorUser
      ? `  (user ${info.monitorUser}${info.monitorPass ? ` · pass ${info.monitorPass}` : ""})`
      : "";
    printField("Monitor", `http://localhost:${state.serverPort}/colyseus${creds}`);
    if (
      state.serverPort !== state.requestedServerPort ||
      state.clientPort !== state.requestedClientPort
    ) {
      printField(
        "Requested",
        `server ${state.requestedServerPort}, client ${state.requestedClientPort}`,
      );
    }
  } else {
    const info = readEnvInfo(ctx.appDir, cfg.port, cfg.clientPort);
    process.stdout.write("\n");
    printSection("Local URLs");
    printField("Client", `http://localhost:${info.clientPort ?? 5173}`);
    printField("Server", `http://localhost:${info.port}`);
    printField("Monitor", `http://localhost:${info.port}/colyseus`);
    if (status.stale) log.warn("Removed stale local dev state.");
  }
  process.stdout.write("\n");
  printPackageVersions(ctx.appDir, { heading: true });
}

export function logsProjectDev(ctx: RuntimeContext, { follow = true }: { follow?: boolean } = {}): void {
  assertProject(ctx);
  ensureLocalDir(ctx);
  if (!existsSync(ctx.logPath!)) writeFileSync(ctx.logPath!, "");
  const args = ["-n", "100", ...(follow ? ["-f"] : []), ctx.logPath!];
  spawnSync("tail", args, { stdio: "inherit" });
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
    // Use "localhost" (not 127.0.0.1) so the probe reaches a server bound to
    // IPv6 ::1 — Vite's dev server listens on ::1 only, so an IPv4-only probe
    // would report it "starting…" forever even when it's up.
    const req = get({ host: "localhost", port, path: "/", timeout: timeoutMs }, (res) => {
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
