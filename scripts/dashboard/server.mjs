import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEV_ADMIN_NPUBS, portsFor } from "../wt-launch.mjs";
import {
  applyStatus,
  applyVerdict,
  matchAllowlist,
  normalizePlan,
  PLAN_REL,
  RingBuffer,
  reconcileWorktrees,
  safeJoin,
  splitLines,
  stripAnsi,
} from "./lib.mjs";

/**
 * The global test-plan dashboard (`pnpm dashboard`): one kanban board across
 * EVERY worktree — the agent authors <worktree>/.gorilator/test-plan.json and
 * keeps statuses truthful; this server aggregates the plans, drives Test
 * actions (start a Feature Lab scenario stack, run an allowlisted command,
 * serve a doc), and records the human's Verified/Rejected verdicts back into
 * the plan files for the agent. Docs: docs/test-dashboard.md.
 *
 * Security posture: binds 127.0.0.1 only + rejects foreign Host headers (this
 * process spawns commands); run commands come from plan files and must
 * exact-match lib.mjs RUN_ALLOWLIST (argv spawn, never a shell); file serving
 * is worktree-rooted with traversal guards and an extension allowlist.
 */

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const REQUESTED_PORT = Number(process.env.DASHBOARD_PORT) || 7300;
const POLL_GIT_TTL_MS = 5_000;
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const STACK_MARKER_REL = ".gorilator/dashboard-stack.json";
const STACK_LOG_REL = ".gorilator/stack.log";
const DEV_STATE_REL = ".gorilator/dev-state.json";

// ---------- tiny http helpers (same shapes as vite.config.ts dev endpoints) ----------

function collectBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

const sendJson = (res, obj, code = 200) => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
};

const fail = (res, code, msg) => {
  res.statusCode = code;
  res.end(msg);
};

function pnpmCommand() {
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm/i.test(execPath)) return [process.execPath, execPath];
  return ["pnpm"];
}

// ---------- git / worktree discovery ----------

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 5_000 });
  return stdout;
}

/** All worktrees with branches, from `git worktree list --porcelain`. The
 *  first entry is the MAIN tree — that ordering is guaranteed by git. */
async function gitWorktreesDetailed(cwd) {
  const out = await git(["worktree", "list", "--porcelain"], cwd);
  const entries = [];
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { dir: line.slice("worktree ".length).trim(), branch: null };
      entries.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    }
  }
  return entries;
}

const gitCache = new Map(); // dir → { at, branch, dirty }
async function gitInfo(dir) {
  const cached = gitCache.get(dir);
  if (cached && Date.now() - cached.at < POLL_GIT_TTL_MS) return cached;
  const info = { at: Date.now(), branch: null, dirty: null };
  try {
    info.branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
  } catch {
    /* mid-rebase / broken tree — degrade */
  }
  try {
    info.dirty = (await git(["status", "--porcelain"], dir)).trim().length > 0;
  } catch {
    /* ignore */
  }
  gitCache.set(dir, info);
  return info;
}

// ---------- per-worktree files ----------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ports a worktree's own .claude/launch.json declares (the tooling's source
 *  of truth — it can predate hash-scheme changes), or null. */
function launchJsonPorts(dir) {
  const launch = readJson(join(dir, ".claude/launch.json"));
  const cfg = launch?.configurations?.find?.((c) => Array.isArray(c.runtimeArgs));
  if (!cfg) return null;
  const blob = cfg.runtimeArgs.join(" ");
  const client = Number(/CLIENT_PORT=(\d+)/.exec(blob)?.[1]) || Number(cfg.port) || null;
  const server = Number(/GAME_SERVER_PORT=(\d+)/.exec(blob)?.[1]) || null;
  return client && server ? { client, server } : null;
}

/** Requested ports for a tree: a live dev-state.json (pid alive) wins with the
 *  RESOLVED ports; then the tree's own launch.json; then the deterministic
 *  hashed block (worktrees) or the classic defaults (main root). */
function portsForTree(dir, isMain) {
  const requested =
    launchJsonPorts(dir) ?? (isMain ? { client: 5173, server: 2567 } : portsFor(dir));
  const state = readJson(join(dir, DEV_STATE_REL));
  if (state && pidAlive(state.pid)) {
    return {
      client: Number(state.clientPort) || requested.client,
      server: Number(state.serverPort) || requested.server,
      live: true,
      pid: state.pid,
    };
  }
  return { ...requested, live: false };
}

async function probeStack(serverPort) {
  try {
    const health = await fetch(`http://127.0.0.1:${serverPort}/healthz`, {
      signal: AbortSignal.timeout(400),
    });
    if (!health.ok) return { up: false };
    let activeScenario = null;
    try {
      const status = await fetch(`http://127.0.0.1:${serverPort}/api/status`, {
        signal: AbortSignal.timeout(600),
      });
      const body = await status.json();
      activeScenario = body?.activeScenario ?? null;
    } catch {
      /* status is best-effort */
    }
    return { up: true, activeScenario };
  } catch {
    return { up: false };
  }
}

// ---------- state assembly ----------

let mainRoot = null; // resolved once at boot

async function listWorktrees() {
  const gitList = await gitWorktreesDetailed(mainRoot ?? process.cwd());
  if (!mainRoot && gitList.length) mainRoot = gitList[0].dir;
  const manifest = readJson(join(mainRoot ?? process.cwd(), ".claude/worktrees-manifest.json"));
  const manifestEntries = Array.isArray(manifest?.worktrees) ? manifest.worktrees : [];
  return reconcileWorktrees(manifestEntries, gitList, (d) => existsSync(d));
}

async function assembleState() {
  reapDeadStacks();
  const entries = await listWorktrees();
  const worktrees = await Promise.all(
    entries.map(async ({ dir }) => {
      const isMain = dir === mainRoot;
      const info = await gitInfo(dir);
      const ports = portsForTree(dir, isMain);
      const stack = await probeStack(ports.server);
      const planRaw = readText(join(dir, PLAN_REL));
      const normalized = planRaw === null ? null : normalizePlan(planRaw);
      const managed = stacks.has(dir);
      const run = lastRunFor(dir);
      return {
        dir,
        isMain,
        name: readText(join(dir, ".gorilator/worktree-name"))?.trim() || basename(dir),
        branch: info.branch,
        targetBranch: readJson(join(dir, "codex-workflow.json"))?.targetBranch ?? null,
        dirty: info.dirty,
        ports: { client: ports.client, server: ports.server },
        stack: {
          up: stack.up,
          activeScenario: stack.activeScenario ?? null,
          managed,
          starting: startingStacks.has(dir),
          clientUrl: `http://localhost:${ports.client}/`,
        },
        plan: normalized?.plan ?? null,
        planError: normalized?.error ?? null,
        planWarnings: normalized?.warnings?.length ? normalized.warnings : undefined,
        run,
      };
    }),
  );
  // Two trees claiming the same ports (stale launch.json copies) would make a
  // running stack show "up" on both lanes — surface it instead of guessing.
  const byServerPort = new Map();
  for (const wt of worktrees) {
    const list = byServerPort.get(wt.ports.server) ?? [];
    list.push(wt);
    byServerPort.set(wt.ports.server, list);
  }
  for (const list of byServerPort.values()) {
    if (list.length > 1) for (const wt of list) wt.portConflict = true;
  }

  const payload = { mainRoot, dashboardPid: process.pid, worktrees };
  // Content hash (timestamps excluded by construction) so the UI can skip renders.
  const { createHash } = await import("node:crypto");
  payload.hash = createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
  payload.updatedAt = new Date().toISOString();
  return payload;
}

/** dir must be one of the CURRENT worktrees (exact match) — the only accepted
 *  dir values for anything that writes files or spawns processes. */
async function resolveWorktreeDir(raw) {
  const dir = String(raw ?? "");
  const entries = await listWorktrees();
  return entries.some((e) => e.dir === dir) ? dir : null;
}

// ---------- plan mutations (atomic, concurrent-writer safe) ----------

function mutatePlan(dir, mutate) {
  const path = join(dir, PLAN_REL);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = existsSync(path) ? statSync(path).mtimeMs : null;
    const raw = readText(path);
    if (raw === null) return { error: "no test plan in this worktree yet" };
    const normalized = normalizePlan(raw);
    if (normalized.error) return { error: `plan unreadable: ${normalized.error}` };
    const result = mutate(normalized.plan);
    if (result.error) return result;
    const after = existsSync(path) ? statSync(path).mtimeMs : null;
    if (before !== after) continue; // the agent wrote meanwhile — reread and retry
    result.plan.updatedAt = new Date().toISOString();
    const tmp = `${path}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(result.plan, null, 2)}\n`);
    renameSync(tmp, path); // atomic on the same filesystem
    return { ok: true };
  }
  return { error: "plan file kept changing — try again" };
}

// ---------- run manager (allowlisted commands) ----------

let runSeq = 0;
const runs = new Map(); // id → run
const activeRunByDir = new Map(); // dir → id

function lastRunFor(dir) {
  let latest = null;
  for (const run of runs.values()) {
    if (run.dir !== dir) continue;
    if (!latest || run.startedAt > latest.startedAt) latest = run;
  }
  if (!latest) return null;
  return {
    id: latest.id,
    command: latest.command,
    running: !latest.done,
    exitCode: latest.exitCode,
    startedAt: latest.startedAt,
    taskId: latest.taskId ?? null,
  };
}

function startRun({ dir, command, argv, taskId, label, onExit }) {
  if (activeRunByDir.has(dir))
    return { error: "a run is already live in this worktree", code: 409 };
  const id = `run-${++runSeq}`;
  const ring = new RingBuffer();
  const [head, ...rest] = argv;
  const cmd = head === "pnpm" ? pnpmCommand() : [head];
  const child = spawn(cmd[0], [...cmd.slice(1), ...rest], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
  });
  const run = {
    id,
    dir,
    command,
    taskId,
    label,
    pid: child.pid,
    ring,
    done: false,
    exitCode: null,
    startedAt: Date.now(),
  };
  runs.set(id, run);
  activeRunByDir.set(dir, id);
  ring.push(`$ ${command}`);
  const out = splitLines((l) => ring.push(l));
  const err = splitLines((l) => ring.push(l));
  child.stdout.on("data", (c) => out.push(c));
  child.stderr.on("data", (c) => err.push(c));
  const watchdog = setTimeout(() => killRun(id, "timed out"), RUN_TIMEOUT_MS);
  child.on("exit", (code, signal) => {
    clearTimeout(watchdog);
    out.flush();
    err.flush();
    run.done = true;
    run.exitCode = code ?? (signal ? 1 : 0);
    ring.push(`— exited ${run.exitCode}${signal ? ` (${signal})` : ""}`);
    if (activeRunByDir.get(dir) === id) activeRunByDir.delete(dir);
    try {
      onExit?.(run.exitCode, ring);
    } catch (e) {
      ring.push(`post-run hook failed: ${e.message}`);
    }
    pruneRuns(dir);
  });
  child.on("error", (e) => {
    run.done = true;
    run.exitCode = 127;
    ring.push(`spawn failed: ${e.message}`);
    if (activeRunByDir.get(dir) === id) activeRunByDir.delete(dir);
  });
  return { id };
}

function pruneRuns(dir) {
  const finished = [...runs.values()].filter((r) => r.dir === dir && r.done);
  finished.sort((a, b) => b.startedAt - a.startedAt);
  for (const stale of finished.slice(5)) runs.delete(stale.id);
}

function killRun(id, why = "killed") {
  const run = runs.get(id);
  if (!run || run.done) return false;
  run.ring.push(`— ${why}`);
  try {
    process.kill(-run.pid, "SIGINT");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (!run.done) {
      try {
        process.kill(-run.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }, 5_000);
  return true;
}

// ---------- stack manager (dev stacks per worktree) ----------

const stacks = new Map(); // dir → { pid, scenario, startedAt, adopted }
const startingStacks = new Set();

// Stack stdout/stderr goes to <dir>/.gorilator/stack.log, NOT pipes: a piped
// detached child dies on EPIPE the moment this dashboard is killed, orphaning
// the game's own children. A file keeps the stack independent — and its log
// readable — across dashboard restarts.
function stackLog(dir, line) {
  try {
    appendFileSync(join(dir, STACK_LOG_REL), `${line}\n`);
  } catch {
    /* best-effort */
  }
}

function adoptExistingStacks(entries) {
  for (const { dir } of entries) {
    const marker = readJson(join(dir, STACK_MARKER_REL));
    if (!marker) continue;
    if (pidAlive(marker.pid)) {
      stacks.set(dir, {
        pid: marker.pid,
        scenario: marker.scenario ?? null,
        startedAt: marker.startedAt ?? Date.now(),
        adopted: true,
      });
      stackLog(dir, `(re-adopted running stack, pid ${marker.pid})`);
      console.log(`[dashboard] re-adopted stack in ${dir} (pid ${marker.pid})`);
    } else {
      try {
        unlinkSync(join(dir, STACK_MARKER_REL));
      } catch {
        /* gone */
      }
    }
  }
}

/** Adopted stacks have no child handle — reap map entries whose pid died. */
function reapDeadStacks() {
  for (const [dir, rec] of stacks) {
    if (pidAlive(rec.pid)) continue;
    stacks.delete(dir);
    startingStacks.delete(dir);
    stackLog(dir, "— stack process gone");
    try {
      unlinkSync(join(dir, STACK_MARKER_REL));
    } catch {
      /* gone */
    }
  }
}

function startStack(dir, isMain, scenario) {
  if (stacks.has(dir) && pidAlive(stacks.get(dir).pid)) {
    return { error: "a managed stack is already running here", code: 409 };
  }
  const ports = launchJsonPorts(dir) ?? (isMain ? { client: 5173, server: 2567 } : portsFor(dir));
  const cmd = pnpmCommand();
  const scriptPath = join(dir, "scripts/dev.mjs");
  let logFd;
  try {
    mkdirSync(join(dir, ".gorilator"), { recursive: true });
    logFd = openSync(join(dir, STACK_LOG_REL), "w"); // fresh start, fresh log
  } catch (e) {
    return { error: `cannot open stack log: ${e.message}`, code: 500 };
  }
  writeFileSync(logFd, `$ node scripts/dev.mjs${scenario ? `  (scenario: ${scenario})` : ""}\n`);
  const child = spawn(process.execPath, [scriptPath], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      npm_execpath: cmd.length > 1 ? cmd[1] : process.env.npm_execpath,
      CLIENT_PORT: String(ports.client),
      GAME_SERVER_PORT: String(ports.server),
      ADMIN_NPUBS: process.env.ADMIN_NPUBS ?? DEV_ADMIN_NPUBS,
      ...(scenario ? { GORILATOR_SCENARIO: scenario } : {}),
    },
  });
  closeSync(logFd); // the child holds its own dup
  const rec = { pid: child.pid, scenario: scenario ?? null, startedAt: Date.now(), adopted: false };
  stacks.set(dir, rec);
  startingStacks.add(dir);
  child.on("exit", (code) => {
    stackLog(dir, `— stack exited ${code ?? "?"}`);
    startingStacks.delete(dir);
    if (stacks.get(dir)?.pid === child.pid) stacks.delete(dir);
    try {
      unlinkSync(join(dir, STACK_MARKER_REL));
    } catch {
      /* gone */
    }
  });
  child.on("error", (e) => stackLog(dir, `spawn failed: ${e.message}`));
  child.on("spawn", () => {
    try {
      writeFileSync(
        join(dir, STACK_MARKER_REL),
        `${JSON.stringify({ pid: child.pid, scenario: scenario ?? null, startedAt: Date.now() }, null, 2)}\n`,
      );
    } catch {
      /* marker is best-effort */
    }
  });
  // "starting" clears once healthz answers (the poll loop flips stack.up).
  setTimeout(() => startingStacks.delete(dir), 60_000);
  return { pid: child.pid, ports };
}

function stopStack(dir) {
  const rec = stacks.get(dir);
  if (!rec) return { error: "no managed stack for this worktree", code: 404 };
  const escalate = (signal, delay) =>
    setTimeout(() => {
      if (pidAlive(rec.pid)) {
        try {
          process.kill(-rec.pid, signal);
        } catch {
          /* gone */
        }
      }
    }, delay);
  try {
    process.kill(-rec.pid, "SIGINT");
  } catch {
    try {
      process.kill(rec.pid, "SIGINT");
    } catch {
      /* gone */
    }
  }
  escalate("SIGTERM", 5_000);
  escalate("SIGKILL", 10_000);
  stackLog(dir, "— stop requested");
  return { ok: true };
}

// ---------- worktree seeding (the dashboard → agent hand-off) ----------

/** After `wt.mjs <name>` succeeds: drop the user's brief where the agent looks
 *  first (.gorilator/brief.md, per the test-plan skill), seed an empty plan so
 *  the lane appears immediately, and print the one command that connects a
 *  Claude Code session to the new tree. */
function seedWorktree(name, brief, ring) {
  const dir = join(mainRoot, ".claude/worktrees", name);
  if (!existsSync(dir)) {
    ring.push(`(expected worktree at ${dir} but it isn't there — skipping seed)`);
    return;
  }
  try {
    mkdirSync(join(dir, ".gorilator"), { recursive: true });
    if (brief) {
      writeFileSync(
        join(dir, ".gorilator/brief.md"),
        `# Brief: ${name}\n\n${brief}\n\n> Written from the test-plan dashboard. Agent: author .gorilator/test-plan.json from this brief (one task per verifiable behavior), then implement.\n`,
      );
      ring.push("→ brief saved to .gorilator/brief.md");
    }
    if (!existsSync(join(dir, PLAN_REL))) {
      writeFileSync(
        join(dir, PLAN_REL),
        `${JSON.stringify({ v: 1, feature: name, updatedAt: new Date().toISOString(), tasks: [] }, null, 2)}\n`,
      );
    }
    ring.push("");
    ring.push("→ worktree ready. Connect the agent:");
    ring.push(
      `→   cd ${dir} && claude${brief ? ' "Read .gorilator/brief.md and take it from there"' : ""}`,
    );
    ring.push("→ its lane is already on the board — cards appear as the agent authors the plan");
  } catch (e) {
    ring.push(`seed failed: ${e.message}`);
  }
}

// ---------- file serving (docs / presentations) ----------

const FILE_TYPES = {
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function serveWorktreeFile(res, dir, relPath) {
  const abs = safeJoin(dir, relPath);
  if (!abs) return fail(res, 400, "bad path");
  const type = FILE_TYPES[extname(abs).toLowerCase()];
  if (!type)
    return fail(res, 415, `unsupported file type (allowed: ${Object.keys(FILE_TYPES).join(" ")})`);
  if (!existsSync(abs)) return fail(res, 404, "not found");
  res.setHeader("content-type", type);
  if (abs.endsWith(".pptx"))
    res.setHeader("content-disposition", `attachment; filename="${basename(abs)}"`);
  createReadStream(abs)
    .on("error", () => fail(res, 500, "read error"))
    .pipe(res);
}

// ---------- static dashboard assets ----------

const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

// ---------- router ----------

async function handle(req, res) {
  const host = String(req.headers.host ?? "");
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    return fail(res, 403, "dashboard is localhost-only");
  }
  const url = new URL(req.url ?? "/", `http://${host}`);
  const route = `${req.method} ${url.pathname}`;

  const staticFile = req.method === "GET" ? STATIC_FILES[url.pathname] : undefined;
  if (staticFile) {
    res.setHeader("content-type", staticFile.type);
    res.end(readFileSync(join(here, "public", staticFile.file)));
    return;
  }

  if (route === "GET /api/state") {
    return sendJson(res, await assembleState());
  }

  if (route === "POST /api/task/status" || route === "POST /api/task/verdict") {
    const body = JSON.parse((await collectBody(req)).toString("utf8") || "{}");
    const dir = await resolveWorktreeDir(body.dir);
    if (!dir) return fail(res, 400, "unknown worktree dir");
    const result = mutatePlan(dir, (plan) =>
      route.endsWith("status")
        ? applyStatus(plan, String(body.taskId ?? ""), String(body.status ?? ""))
        : applyVerdict(
            plan,
            String(body.taskId ?? ""),
            String(body.result ?? ""),
            String(body.note ?? ""),
          ),
    );
    return result.error ? fail(res, 422, result.error) : sendJson(res, { ok: true });
  }

  if (route === "POST /api/run") {
    const body = JSON.parse((await collectBody(req)).toString("utf8") || "{}");
    const dir = await resolveWorktreeDir(body.dir);
    if (!dir) return fail(res, 400, "unknown worktree dir");
    const taskId = String(body.taskId ?? "");
    const normalized = normalizePlan(readText(join(dir, PLAN_REL)) ?? "");
    const task = normalized.plan?.tasks.find((t) => t.id === taskId);
    const command = task?.test?.command; // plan-sourced ONLY — the client never sends commands
    if (!command) return fail(res, 404, "task has no cli test command");
    const argv = matchAllowlist(command);
    if (!argv) {
      return fail(
        res,
        403,
        `command not allowlisted: ${command}\nSee RUN_ALLOWLIST in scripts/dashboard/lib.mjs`,
      );
    }
    const started = startRun({ dir, command, argv, taskId });
    return started.error ? fail(res, started.code ?? 500, started.error) : sendJson(res, started);
  }

  if (route === "GET /api/run/log") {
    const run = runs.get(String(url.searchParams.get("id")));
    if (!run) return fail(res, 404, "unknown run");
    const from = Number(url.searchParams.get("from")) || 0;
    return sendJson(res, {
      ...run.ring.read(from),
      done: run.done,
      exitCode: run.exitCode,
      command: run.command,
    });
  }

  if (route === "POST /api/run/kill") {
    const body = JSON.parse((await collectBody(req)).toString("utf8") || "{}");
    return killRun(String(body.id ?? ""))
      ? sendJson(res, { ok: true })
      : fail(res, 404, "no such live run");
  }

  if (route === "POST /api/stack/start") {
    const body = JSON.parse((await collectBody(req)).toString("utf8") || "{}");
    const dir = await resolveWorktreeDir(body.dir);
    if (!dir) return fail(res, 400, "unknown worktree dir");
    const isMain = dir === mainRoot;
    const ports = portsForTree(dir, isMain);
    const probe = await probeStack(ports.server);
    if (probe.up) {
      return sendJson(res, { error: "already-running", managed: stacks.has(dir) }, 409);
    }
    const scenario = body.scenario ? String(body.scenario) : undefined;
    if (scenario && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(scenario))
      return fail(res, 400, "bad scenario name");
    const started = startStack(dir, isMain, scenario);
    return started.error ? fail(res, started.code ?? 500, started.error) : sendJson(res, started);
  }

  if (route === "POST /api/stack/stop") {
    const body = JSON.parse((await collectBody(req)).toString("utf8") || "{}");
    const dir = await resolveWorktreeDir(body.dir);
    if (!dir) return fail(res, 400, "unknown worktree dir");
    const result = stopStack(dir);
    return result.error ? fail(res, result.code ?? 500, result.error) : sendJson(res, result);
  }

  if (route === "GET /api/stack/log") {
    const dir = await resolveWorktreeDir(url.searchParams.get("dir"));
    if (!dir) return fail(res, 400, "unknown worktree dir");
    const rec = stacks.get(dir);
    const logPath = join(dir, STACK_LOG_REL);
    // File-backed (survives dashboard restarts); `from`/`next` are byte offsets.
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      return sendJson(res, {
        lines: [],
        next: 0,
        dropped: false,
        pid: rec?.pid ?? null,
        scenario: rec?.scenario ?? null,
      });
    }
    let from = Number(url.searchParams.get("from")) || 0;
    let dropped = false;
    const CAP = 256 * 1024;
    if (from > size) {
      from = 0; // log was rotated by a fresh start
      dropped = true;
    }
    if (size - from > CAP) {
      from = size - CAP;
      dropped = true;
    }
    let lines = [];
    if (size > from) {
      const buf = Buffer.alloc(size - from);
      const fd = openSync(logPath, "r");
      try {
        readSync(fd, buf, 0, buf.length, from);
      } finally {
        closeSync(fd);
      }
      lines = stripAnsi(buf.toString("utf8"))
        .split("\n")
        .filter((l, i, a) => l !== "" || i < a.length - 1);
    }
    return sendJson(res, {
      lines,
      next: size,
      dropped,
      pid: rec?.pid ?? null,
      scenario: rec?.scenario ?? null,
    });
  }

  if (route === "POST /api/worktree/create") {
    const body = JSON.parse((await collectBody(req)).toString("utf8") || "{}");
    const name = String(body.name ?? "");
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) return fail(res, 400, "bad worktree name");
    const brief = typeof body.brief === "string" ? body.brief.trim().slice(0, 8000) : "";
    // Runs through the run manager (streams the pnpm-install output). The argv
    // is server-constructed — not user text — so it bypasses the plan allowlist.
    const started = startRun({
      dir: mainRoot,
      command: `node scripts/wt.mjs ${name}`,
      argv: ["node", "scripts/wt.mjs", name],
      label: `new worktree ${name}`,
      onExit: (code, ring) => {
        if (code !== 0) return;
        seedWorktree(name, brief, ring);
      },
    });
    return started.error ? fail(res, started.code ?? 500, started.error) : sendJson(res, started);
  }

  if (route === "GET /api/file") {
    const dir = await resolveWorktreeDir(url.searchParams.get("dir"));
    if (!dir) return fail(res, 400, "unknown worktree dir");
    return serveWorktreeFile(res, dir, url.searchParams.get("path"));
  }

  fail(res, 404, "not found");
}

// ---------- boot ----------

function canListen(port) {
  return new Promise((res) => {
    const probe = createNetServer();
    probe.once("error", () => res(false));
    probe.once("listening", () => probe.close(() => res(true)));
    probe.listen(port, HOST);
  });
}

async function findFreePort(preferred) {
  for (let port = preferred; port < preferred + 50; port++) {
    if (await canListen(port)) return port;
  }
  throw new Error(`no free port near ${preferred}`);
}

function shutdown() {
  for (const id of runs.keys()) killRun(id, "dashboard shutting down");
  for (const dir of stacks.keys()) stopStack(dir);
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const entriesAtBoot = await listWorktrees();
adoptExistingStacks(entriesAtBoot);

const port = await findFreePort(REQUESTED_PORT);
const server = createHttpServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[dashboard]", err);
    if (!res.headersSent) fail(res, 500, String(err?.message ?? err));
  });
});
server.listen(port, HOST, () => {
  console.log(`[dashboard] test-plan dashboard → http://localhost:${port}/`);
  console.log(`[dashboard] tracking ${entriesAtBoot.length} worktree(s) from ${mainRoot}`);
});
