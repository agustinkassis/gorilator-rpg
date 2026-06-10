#!/usr/bin/env node
/**
 * perf-analyze — summarize and compare the perf logs written under perf-logs/.
 *
 * The data is plain JSONL (one sample per line) or a benchmark .json (a single
 * object with a `metrics` map), so anything can read it — jq, pandas, sqlite. This
 * script is the batteries-included path: it prints a per-metric table (min / avg /
 * p50 / p95 / p99 / max) for every numeric column and every `tag:*` span, and can
 * diff two runs to tell you whether a change actually helped.
 *
 * Usage:
 *   node scripts/perf-analyze.mjs <file.jsonl|bench.json>            # summarize one run
 *   node scripts/perf-analyze.mjs <baseline> <candidate>             # compare two runs
 *   node scripts/perf-analyze.mjs <baseline> <candidate> --gate      # + exit 1 past thresholds
 *   node scripts/perf-analyze.mjs <a> <b> --thresholds='{"fps":-10}' # custom gate limits
 *   node scripts/perf-analyze.mjs <file> --csv                       # emit CSV instead
 *
 * Stats come from the compiled @rpg/shared (percentile/summarize) so the analyzer
 * can never drift from what perfTracker computed at capture time — run
 * `pnpm build:shared` once after a fresh clone.
 *
 * load/compareRuns/checkThresholds are exported for scripts/bench.mjs.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---- stats: the ONE implementation, from the compiled shared package ----

// dist/perf.js is a leaf module (no imports), so bare Node can load it directly —
// the package's index.js can't be used here because tsc emits extensionless
// relative imports that only bundler-style resolvers (Vite/tsx) understand.
let summarize;
try {
  ({ summarize } = await import(
    new URL("../packages/shared/dist/perf.js", import.meta.url).href
  ));
} catch {
  console.error(
    "perf-analyze: @rpg/shared isn't built yet (stats live there).\n" +
      "  Run:  pnpm build:shared\n",
  );
  process.exit(1);
}

// ---- loading ----

/** Load a file into { metrics, sampleCount, meta, src }. Accepts a JSONL sample log
 *  or a benchmark .json (which already carries a `metrics` map). */
export function load(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return { metrics: {}, sampleCount: 0, meta: {}, src: "?" };

  // A benchmark result is one JSON object with a `metrics` map. Try to parse the
  // WHOLE file as JSON first (benchmark files are pretty-printed, so multi-line);
  // if that throws it's a JSONL sample log, handled below.
  if (raw[0] === "{" || raw[0] === "[") {
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.metrics) {
        return { metrics: obj.metrics, sampleCount: obj.sampleCount ?? 0, meta: obj.meta ?? {}, src: obj.src ?? "?" };
      }
    } catch {
      /* not a single JSON object → fall through to JSONL */
    }
  }

  // Otherwise JSONL: one sample per line. Collect every numeric column + tags.
  const cols = {};
  const tagCols = {};
  let count = 0;
  let src = "?";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let s;
    try {
      s = JSON.parse(line);
    } catch {
      continue;
    }
    count++;
    if (src === "?") src = s.tickMs !== undefined ? "server" : "client";
    for (const [k, v] of Object.entries(s)) {
      if (k === "tags") {
        for (const [tk, tv] of Object.entries(v || {})) {
          if (typeof tv === "number") (tagCols[tk] ??= []).push(tv);
        }
      } else if (typeof v === "number" && k !== "t") {
        (cols[k] ??= []).push(v);
      }
    }
  }
  const metrics = {};
  for (const [k, vals] of Object.entries(cols)) metrics[k] = summarize(vals);
  for (const [k, vals] of Object.entries(tagCols)) metrics[`tag:${k}`] = summarize(vals);
  return { metrics, sampleCount: count, meta: {}, src };
}

// ---- comparison + threshold gate ----

/** Diff two runs metric-by-metric (avg-based). Rows are in display order.
 *  `better` follows the direction rule: fps higher-is-better, all else lower. */
export function compareRuns(a, b) {
  const keys = new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)]);
  const rows = [];
  for (const [k] of orderedMetrics(Object.fromEntries([...keys].map((x) => [x, {}])))) {
    const base = a.metrics[k]?.avg;
    const cand = b.metrics[k]?.avg;
    if (base === undefined || cand === undefined) continue;
    const delta = cand - base;
    const pct = base !== 0 ? (delta / Math.abs(base)) * 100 : 0;
    const better = k === "fps" ? delta > 0 : delta < 0;
    rows.push({ metric: k, base, cand, delta, pct, better });
  }
  return rows;
}

/** Default gate: fail when fps drops >10% or any cost metric grows >25%
 *  (server tick / client frame / event-loop lag). Tags are not gated by default —
 *  add `"tag:<name>": <pct>` entries to gate a specific system. */
export const DEFAULT_THRESHOLDS = {
  fps: -10,
  tickMs: 25,
  frameMs: 25,
  loopLagMs: 50,
};

/** Check compare rows against a thresholds map (metric → max allowed % change;
 *  negative limits guard a drop — fps — positive limits guard a rise — costs).
 *  Returns the violations. */
export function checkThresholds(rows, thresholds = DEFAULT_THRESHOLDS) {
  const violations = [];
  for (const row of rows) {
    const limit = thresholds[row.metric];
    if (limit === undefined) continue;
    const breached = limit < 0 ? row.pct <= limit : row.pct >= limit;
    if (breached) violations.push({ ...row, limit });
  }
  return violations;
}

// ---- formatting ----

const f = (n) => (Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2));
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

function printTable(name, data) {
  console.log(`\n# ${name}  (${data.src}, ${data.sampleCount} samples)`);
  if (data.meta && Object.keys(data.meta).length) {
    const m = data.meta;
    console.log(`  env: ${[m.gpu, m.version, m.node, m.platform].filter(Boolean).join(" · ")}`);
  }
  const cols = ["min", "avg", "p50", "p95", "p99", "max"];
  console.log(`  ${pad("metric", 22)}${cols.map((c) => padL(c, 10)).join("")}`);
  console.log(`  ${"-".repeat(22 + cols.length * 10)}`);
  for (const [k, s] of orderedMetrics(data.metrics)) {
    console.log(`  ${pad(k, 22)}${cols.map((c) => padL(f(s[c]), 10)).join("")}`);
  }
}

function printCsv(data) {
  const cols = ["count", "min", "avg", "p50", "p95", "p99", "max"];
  console.log(["metric", ...cols].join(","));
  for (const [k, s] of orderedMetrics(data.metrics)) {
    console.log([k, ...cols.map((c) => s[c])].join(","));
  }
}

function printCompare(rows, a, b, aPath, bPath) {
  console.log(`\n# compare  ${aPath}  →  ${bPath}`);
  console.log(`  baseline: ${a.sampleCount} samples · candidate: ${b.sampleCount} samples`);
  console.log(`  ${pad("metric", 22)}${padL("baseline", 12)}${padL("candidate", 12)}${padL("Δ avg", 11)}${padL("%", 9)}`);
  console.log(`  ${"-".repeat(22 + 12 + 12 + 11 + 9)}`);
  for (const { metric, base, cand, delta, pct, better } of rows) {
    const mark = Math.abs(pct) < 1 ? "  " : better ? "✓ " : "✗ ";
    console.log(
      `  ${pad(metric, 22)}${padL(f(base), 12)}${padL(f(cand), 12)}${padL((delta >= 0 ? "+" : "") + f(delta), 11)}${padL(mark + (pct >= 0 ? "+" : "") + pct.toFixed(0) + "%", 9)}`,
    );
  }
  console.log("\n  ✓ = improvement · ✗ = regression (fps higher-is-better; all else lower-is-better)");
}

/** Stable, readable metric order: the well-known columns first, then tags. */
function orderedMetrics(metrics) {
  const order = [
    "fps", "frameMs", "gpuMs", "heapMB", "drawCalls", "activeMeshes", "triangles",
    "tickMs", "cpuPct", "rssMB", "loopLagMs", "players", "enemies", "entities",
  ];
  const keys = Object.keys(metrics);
  keys.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b); // tags & unknowns alphabetical
  });
  return keys.map((k) => [k, metrics[k]]);
}

// ---- main ----

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const csv = args.includes("--csv");
  const gate = args.includes("--gate");
  const thresholdsArg = args.find((a) => a.startsWith("--thresholds="));
  const files = args.filter((a) => !a.startsWith("--"));

  if (files.length === 0) {
    console.error(
      "usage: node scripts/perf-analyze.mjs <file.jsonl> [candidate.jsonl] [--csv] [--gate] [--thresholds='{...}']",
    );
    process.exit(1);
  }

  if (files.length >= 2) {
    const a = load(files[0]);
    const b = load(files[1]);
    const rows = compareRuns(a, b);
    printCompare(rows, a, b, files[0], files[1]);
    if (gate || thresholdsArg) {
      const thresholds = thresholdsArg
        ? JSON.parse(thresholdsArg.slice("--thresholds=".length))
        : DEFAULT_THRESHOLDS;
      const violations = checkThresholds(rows, thresholds);
      if (violations.length) {
        console.error("\n  GATE FAILED:");
        for (const v of violations) {
          console.error(
            `    ${v.metric}: ${v.pct >= 0 ? "+" : ""}${v.pct.toFixed(1)}% (limit ${v.limit >= 0 ? "+" : ""}${v.limit}%)`,
          );
        }
        process.exit(1);
      }
      console.log("\n  GATE PASSED (all metrics within thresholds)");
    }
  } else {
    const data = load(files[0]);
    if (csv) printCsv(data);
    else printTable(files[0], data);
  }
}
