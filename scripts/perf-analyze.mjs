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
 *   node scripts/perf-analyze.mjs <baseline> <candidate>            # compare two runs
 *   node scripts/perf-analyze.mjs <file> --csv                      # emit CSV instead
 *
 * No dependencies — runs on a bare Node ≥ 18.
 */
import { readFileSync } from "node:fs";

// ---- stats (kept in sync with packages/shared/src/perf.ts) ----

function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const rank = (Math.max(0, Math.min(100, p)) / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] * (hi - rank) + sortedAsc[hi] * (rank - lo);
}

function summarize(values) {
  const n = values.length;
  if (n === 0) return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    avg: sum / n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

// ---- loading ----

/** Load a file into { metrics, sampleCount, meta, src }. Accepts a JSONL sample log
 *  or a benchmark .json (which already carries a `metrics` map). */
function load(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return { metrics: {}, sampleCount: 0, meta: {}, src: "?" };

  // A benchmark result: one JSON object with a metrics map.
  if (raw[0] === "{" && !raw.includes("\n")) {
    const obj = JSON.parse(raw);
    if (obj.metrics) {
      return { metrics: obj.metrics, sampleCount: obj.sampleCount ?? 0, meta: obj.meta ?? {}, src: obj.src ?? "?" };
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

function printCompare(a, b, aPath, bPath) {
  console.log(`\n# compare  ${aPath}  →  ${bPath}`);
  console.log(`  baseline: ${a.sampleCount} samples · candidate: ${b.sampleCount} samples`);
  console.log(`  ${pad("metric", 22)}${padL("baseline", 12)}${padL("candidate", 12)}${padL("Δ avg", 11)}${padL("%", 9)}`);
  console.log(`  ${"-".repeat(22 + 12 + 12 + 11 + 9)}`);
  const keys = new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)]);
  for (const [k] of orderedMetrics(Object.fromEntries([...keys].map((x) => [x, {}])))) {
    const av = a.metrics[k]?.avg;
    const bv = b.metrics[k]?.avg;
    if (av === undefined || bv === undefined) continue;
    const d = bv - av;
    const pct = av !== 0 ? (d / Math.abs(av)) * 100 : 0;
    // Lower is better for everything EXCEPT fps; mark the helpful direction.
    const better = k === "fps" ? d > 0 : d < 0;
    const mark = Math.abs(pct) < 1 ? "  " : better ? "✓ " : "✗ ";
    console.log(
      `  ${pad(k, 22)}${padL(f(av), 12)}${padL(f(bv), 12)}${padL((d >= 0 ? "+" : "") + f(d), 11)}${padL(mark + (pct >= 0 ? "+" : "") + pct.toFixed(0) + "%", 9)}`,
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

const args = process.argv.slice(2);
const csv = args.includes("--csv");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("usage: node scripts/perf-analyze.mjs <file.jsonl> [candidate.jsonl] [--csv]");
  process.exit(1);
}

if (files.length >= 2) {
  printCompare(load(files[0]), load(files[1]), files[0], files[1]);
} else {
  const data = load(files[0]);
  if (csv) printCsv(data);
  else printTable(files[0], data);
}
