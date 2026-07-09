import { resolve, sep } from "node:path";

/**
 * Pure helpers for the test-plan dashboard (scripts/dashboard/server.mjs).
 * Everything here is side-effect free and unit-tested (lib.test.mjs) — the
 * server stays a thin I/O shell around these.
 *
 * The test plan lives per worktree at .gorilator/test-plan.json (gitignored),
 * authored/updated by the agent (.claude/skills/test-plan) and mutated by the
 * dashboard only for STATUS + VERDICT fields.
 */

export const PLAN_REL = ".gorilator/test-plan.json";
export const TASK_STATUSES = ["planned", "in_progress", "ready", "verified", "rejected"];
export const TASK_KINDS = ["feature", "bugfix", "optimization", "docs"];
export const TEST_TYPES = ["scenario", "cli", "doc", "manual"];

/** Commands the dashboard may execute — exact-match, argv-spawned (no shell).
 *  Deliberately tight: named pnpm scripts + a few read-only node scripts. */
export const RUN_ALLOWLIST = [
  /^pnpm (test|typecheck|lint|e2e|e2e:game|bench|version:check|test:dashboard)$/,
  /^pnpm --filter @rpg\/(server|shared|client) (test|typecheck|lint)$/,
  /^node scripts\/(bench|perf-analyze|check-versions)\.mjs((?: [\w.@:=/-]+)*)$/,
];

/** Validate a command against the allowlist → argv array, or null. */
export function matchAllowlist(command) {
  const cmd = String(command ?? "").trim();
  if (!cmd || !RUN_ALLOWLIST.some((re) => re.test(cmd))) return null;
  // Exact-match regexes above guarantee no shell metacharacters survive, but
  // belt-and-braces: refuse anything that could smuggle shell syntax.
  if (/[;&|<>$`\\"'\n]/.test(cmd)) return null;
  return cmd.split(/ +/);
}

/** Parse + validate a raw test-plan JSON string. Never throws.
 *  → { plan, warnings[] } or { error }. Coerces unknown statuses/kinds and
 *  drops malformed tasks (reported in warnings). */
export function normalizePlan(raw) {
  if (raw == null || raw === "") return { error: "empty" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `invalid JSON: ${err instanceof Error ? err.message : err}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "plan must be a JSON object" };
  }
  const warnings = [];
  const plan = {
    v: 1,
    feature: typeof parsed.feature === "string" ? parsed.feature : "",
    issue:
      Number.isFinite(Number(parsed.issue)) && parsed.issue != null
        ? Number(parsed.issue)
        : undefined,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    tasks: [],
  };
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  if (!Array.isArray(parsed.tasks)) warnings.push("tasks is not an array");
  const seen = new Set();
  for (const t of rawTasks) {
    if (!t || typeof t !== "object" || typeof t.id !== "string" || !t.id.trim()) {
      warnings.push("dropped a task without a string id");
      continue;
    }
    const id = t.id.trim();
    if (seen.has(id)) {
      warnings.push(`dropped duplicate task id "${id}"`);
      continue;
    }
    seen.add(id);
    const status = TASK_STATUSES.includes(t.status) ? t.status : "planned";
    if (status !== t.status) warnings.push(`task "${id}": unknown status "${t.status}" → planned`);
    const kind = TASK_KINDS.includes(t.kind) ? t.kind : "feature";
    let test;
    if (t.test && typeof t.test === "object" && TEST_TYPES.includes(t.test.type)) {
      test = {
        type: t.test.type,
        scenario: typeof t.test.scenario === "string" ? t.test.scenario : undefined,
        command: typeof t.test.command === "string" ? t.test.command : undefined,
        path: typeof t.test.path === "string" ? t.test.path : undefined,
        steps: Array.isArray(t.test.steps) ? t.test.steps.map(String) : undefined,
      };
    } else if (t.test) {
      warnings.push(`task "${id}": unrecognized test block dropped`);
    }
    plan.tasks.push({
      id,
      title: typeof t.title === "string" && t.title.trim() ? t.title : id,
      kind,
      status,
      details: typeof t.details === "string" ? t.details : undefined,
      expected: typeof t.expected === "string" ? t.expected : undefined,
      test,
      verdict: t.verdict && typeof t.verdict === "object" ? t.verdict : undefined,
      verdictHistory: Array.isArray(t.verdictHistory) ? t.verdictHistory : [],
    });
  }
  return { plan, warnings };
}

/** Set a task's status. → { plan, changed } | { error }. */
export function applyStatus(plan, taskId, status) {
  if (!TASK_STATUSES.includes(status)) return { error: `unknown status "${status}"` };
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return { error: `unknown task "${taskId}"` };
  const changed = task.status !== status;
  task.status = status;
  return { plan, changed };
}

/** Record the human's verdict. Legal from "ready" (the normal path) and from
 *  "verified" (the human changes their mind and re-rejects a passed task). Any
 *  prior verdict goes to history. */
export function applyVerdict(plan, taskId, result, note = "", now = new Date().toISOString()) {
  if (result !== "verified" && result !== "rejected") {
    return { error: `verdict must be verified|rejected, got "${result}"` };
  }
  if (result === "rejected" && !String(note).trim()) {
    return { error: "a rejection needs a note — tell the agent what was wrong" };
  }
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return { error: `unknown task "${taskId}"` };
  if (task.status !== "ready" && task.status !== "verified") {
    return { error: `verdicts apply to ready/verified tasks (task is "${task.status}")` };
  }
  if (task.verdict) task.verdictHistory = [...(task.verdictHistory ?? []), task.verdict];
  task.verdict = { result, note: String(note), at: now, by: "dashboard" };
  task.status = result;
  return { plan, changed: true };
}

/** Reopen a settled (verified/rejected) task back to "ready" for re-testing.
 *  The current verdict is archived to history and cleared. */
export function reopenTask(plan, taskId) {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return { error: `unknown task "${taskId}"` };
  if (task.status !== "verified" && task.status !== "rejected") {
    return { error: `only settled tasks reopen (task is "${task.status}")` };
  }
  if (task.verdict) {
    task.verdictHistory = [...(task.verdictHistory ?? []), task.verdict];
    task.verdict = undefined;
  }
  task.status = "ready";
  return { plan, changed: true };
}

/** Reconcile the (possibly stale) worktrees manifest with `git worktree list`.
 *  Union by dir, drop entries whose dir no longer exists. → [{dir, branch}] */
export function reconcileWorktrees(manifestEntries, gitEntries, exists) {
  const byDir = new Map();
  for (const e of gitEntries ?? []) {
    if (e?.dir) byDir.set(e.dir, { dir: e.dir, branch: e.branch ?? null });
  }
  for (const e of manifestEntries ?? []) {
    if (e?.dir && !byDir.has(e.dir)) byDir.set(e.dir, { dir: e.dir, branch: e.branch ?? null });
  }
  return [...byDir.values()].filter((e) => exists(e.dir));
}

/** Line-oriented ring buffer with monotonically increasing sequence numbers,
 *  so pollers can resume with `read(fromSeq)` and detect drops. */
export class RingBuffer {
  constructor(maxLines = 2000, maxBytes = 512 * 1024) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.lines = []; // { seq, text }
    this.bytes = 0;
    this.nextSeq = 0;
  }

  push(text) {
    const line = { seq: this.nextSeq++, text: String(text) };
    this.lines.push(line);
    this.bytes += line.text.length;
    while (
      this.lines.length > this.maxLines ||
      (this.bytes > this.maxBytes && this.lines.length > 1)
    ) {
      const dropped = this.lines.shift();
      this.bytes -= dropped.text.length;
    }
    return line.seq;
  }

  /** Lines with seq >= fromSeq. `dropped` is true when the caller missed some. */
  read(fromSeq = 0) {
    const first = this.lines.length ? this.lines[0].seq : this.nextSeq;
    const lines = this.lines.filter((l) => l.seq >= fromSeq);
    return { lines: lines.map((l) => l.text), next: this.nextSeq, dropped: fromSeq < first };
  }
}

/** Strip ANSI color/control sequences — vitest et al ignore FORCE_COLOR=0 under some TTY shims. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g");
export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, "");
}

/** Stateful chunk→lines splitter (the dev.mjs prefixStream pattern). */
export function splitLines(onLine) {
  let pending = "";
  return {
    push(chunk) {
      pending += stripAnsi(chunk.toString());
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    flush() {
      if (pending) onLine(pending);
      pending = "";
    },
  };
}

/** Join `relPath` under `rootDir`, refusing traversal/absolute escapes. */
export function safeJoin(rootDir, relPath) {
  const rel = String(relPath ?? "");
  if (!rel || rel.includes("\0")) return null;
  const abs = resolve(rootDir, rel);
  const root = resolve(rootDir);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}
