#!/usr/bin/env node
/**
 * bench — repeatable server benchmark with a regression gate.
 *
 *   pnpm bench                     # run the default scenario, gate vs perf-baselines/
 *   pnpm bench --update-baseline   # (re)record the baseline instead of gating
 *   pnpm bench --duration=30000    # longer capture window (default 15s)
 *   pnpm bench --scenario=idle     # scenario label (default "idle")
 *   pnpm bench --thresholds='{"tickMs":10}'   # override gate limits
 *
 * What it does: boots the game server with GORILATOR_TEST=1 (deterministic — no
 * goblin waves, room pre-created so the 20Hz sim ticks with no client), waits for
 * /healthz, POSTs /api/bench, then compares the BenchmarkResult against the
 * committed perf-baselines/<scenario>.json using the same compare/threshold logic
 * as `pnpm perf` (scripts/perf-analyze.mjs). Exits non-zero past the thresholds.
 *
 * Baselines are machine-specific by nature — refresh deliberately with
 * --update-baseline after intentional perf changes, on the machine that gates.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkThresholds, compareRuns, DEFAULT_THRESHOLDS } from "./perf-analyze.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const scenario = (args.find((a) => a.startsWith("--scenario=")) ?? "--scenario=idle").split("=")[1];
const durationMs = Number((args.find((a) => a.startsWith("--duration=")) ?? "--duration=15000").split("=")[1]);
const thresholdsArg = args.find((a) => a.startsWith("--thresholds="));
const thresholds = thresholdsArg
  ? JSON.parse(thresholdsArg.slice("--thresholds=".length))
  : DEFAULT_THRESHOLDS;

const PORT = 14690; // fixed, clear of dev (5173/2567), worktree blocks (4100-7090) and e2e (1462x)
const baselineDir = join(root, "perf-baselines");
const baselinePath = join(baselineDir, `${scenario}.json`);

function log(msg) {
  console.log(`[bench] ${msg}`);
}

async function waitFor(url, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

log(`booting server on :${PORT} (GORILATOR_TEST=1, scenario "${scenario}")`);
const server = spawn("pnpm", ["--filter", "@rpg/server", "dev"], {
  cwd: root,
  env: {
    ...process.env,
    GAME_SERVER_PORT: String(PORT),
    GORILATOR_TEST: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => {
  serverLog += d;
});
server.stderr.on("data", (d) => {
  serverLog += d;
});

function shutdown() {
  if (!server.killed) server.kill("SIGINT");
}
process.on("exit", shutdown);
process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});

try {
  await waitFor(`http://localhost:${PORT}/healthz`);
  // Make sure the pre-created room is actually ticking before sampling.
  const perfUrl = `http://localhost:${PORT}/api/perf`;
  const until = Date.now() + 30_000;
  let ticking = false;
  while (Date.now() < until && !ticking) {
    try {
      const snap = await (await fetch(perfUrl)).json();
      ticking = snap?.latest != null;
    } catch {
      /* retry */
    }
    if (!ticking) await new Promise((r) => setTimeout(r, 250));
  }
  if (!ticking) throw new Error("simulation never started ticking (no /api/perf samples)");

  log(`capturing ${durationMs}ms…`);
  const res = await fetch(`http://localhost:${PORT}/api/bench`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: scenario, durationMs }),
    signal: AbortSignal.timeout(durationMs + 30_000),
  });
  if (!res.ok) throw new Error(`POST /api/bench → ${res.status}: ${await res.text()}`);
  const result = await res.json();
  log(`captured ${result.sampleCount} samples over ${result.durationMs}ms`);

  if (updateBaseline || !existsSync(baselinePath)) {
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(result, null, 2)}\n`);
    log(
      updateBaseline
        ? `baseline updated: ${baselinePath}`
        : `no baseline existed — recorded ${baselinePath} (gate skipped on first run)`,
    );
    process.exit(0);
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const rows = compareRuns(
    { metrics: baseline.metrics, sampleCount: baseline.sampleCount },
    { metrics: result.metrics, sampleCount: result.sampleCount },
  );
  console.log(`\n  ${"metric".padEnd(22)}${"baseline".padStart(12)}${"candidate".padStart(12)}${"%".padStart(9)}`);
  console.log(`  ${"-".repeat(55)}`);
  for (const r of rows) {
    const mark = Math.abs(r.pct) < 1 ? " " : r.better ? "✓" : "✗";
    console.log(
      `  ${r.metric.padEnd(22)}${r.base.toFixed(2).padStart(12)}${r.cand.toFixed(2).padStart(12)}${(mark + (r.pct >= 0 ? "+" : "") + r.pct.toFixed(0) + "%").padStart(9)}`,
    );
  }

  const violations = checkThresholds(rows, thresholds);
  if (violations.length) {
    console.error("\n[bench] GATE FAILED:");
    for (const v of violations) {
      console.error(
        `  ${v.metric}: ${v.pct >= 0 ? "+" : ""}${v.pct.toFixed(1)}% (limit ${v.limit >= 0 ? "+" : ""}${v.limit}%)`,
      );
    }
    console.error("\n  Intentional change? Refresh with: pnpm bench:update");
    process.exit(1);
  }
  log("GATE PASSED (all metrics within thresholds)");
  process.exit(0);
} catch (err) {
  console.error(`[bench] ${err instanceof Error ? err.message : err}`);
  if (serverLog) console.error(`\n--- server log tail ---\n${serverLog.split("\n").slice(-25).join("\n")}`);
  process.exit(1);
} finally {
  shutdown();
}
