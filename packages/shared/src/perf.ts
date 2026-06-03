/**
 * Shared performance-metric types + pure aggregation helpers, used by BOTH the
 * client (Babylon FPS / GPU / JS heap) and the server (CPU / memory / tick), so
 * every perf artefact — live JSONL samples and benchmark summaries alike — has ONE
 * analyze-ready shape. See docs/performance.md for the full pipeline.
 *
 * Nothing here touches Babylon, Node, or Colyseus: it's plain data + math, safe to
 * import into either runtime (and into the analyzer script).
 */

/** Statistical summary of one metric over a window of samples. Units are whatever
 *  the metric is in (ms, MB, fps, count…); the metric's key carries the unit. */
export interface MetricSummary {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number; // median
  p95: number;
  p99: number;
}

export const EMPTY_SUMMARY: MetricSummary = {
  count: 0,
  min: 0,
  max: 0,
  avg: 0,
  p50: 0,
  p95: 0,
  p99: 0,
};

/** Linear-interpolated percentile (p in 0..100) of an ALREADY ascending-sorted
 *  array. Returns 0 for an empty input. */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const rank = (Math.max(0, Math.min(100, p)) / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] * (hi - rank) + sortedAsc[hi] * (rank - lo);
}

/** Collapse a list of raw readings into a MetricSummary (sorts a copy; input is
 *  left untouched). */
export function summarize(values: number[]): MetricSummary {
  const n = values.length;
  if (n === 0) return { ...EMPTY_SUMMARY };
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of values) sum += v;
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

/**
 * One CLIENT frame sample — a single row of a client JSONL log. A field is `null`
 * when the platform can't measure it: `gpuMs` needs the GPU timer-query extension,
 * `heapMB` is Chromium-only, and `frameMs`/`gpuMs` are only filled while the heavy
 * captures are on (overlay open or a benchmark running). See docs/performance.md.
 */
export interface ClientPerfSample {
  t: number; // epoch ms
  fps: number;
  frameMs: number | null; // CPU time to build the frame (scene instrumentation)
  gpuMs: number | null; // GPU frame time (EXT_disjoint_timer_query)
  heapMB: number | null; // JS heap used (Chromium performance.memory)
  drawCalls: number;
  activeMeshes: number;
  triangles: number; // active indices / 3
  tags: Record<string, number>; // custom tagged spans (ms) / counters, this frame
}

/** One SERVER tick sample — a single row of a server JSONL log. */
export interface ServerPerfSample {
  t: number; // epoch ms
  tickMs: number; // wall time to run the simulation tick body
  cpuPct: number; // process CPU % since the previous sample
  rssMB: number; // resident set size
  heapMB: number; // V8 heap used
  loopLagMs: number; // event-loop delay (perf_hooks monitorEventLoopDelay, mean)
  players: number;
  enemies: number;
  entities: number; // total synced entities (players + enemies + resources + items)
  tags: Record<string, number>; // per-system span times (ms) this tick
}

/**
 * A stored benchmark result — the summary of one labelled capture window. This is
 * the unit you diff before/after a change (baseline vs candidate). `metrics` is
 * keyed by the raw metric name (fps, frameMs, cpuPct…) plus `tag:<name>` for every
 * custom span seen during the run.
 */
export interface BenchmarkResult {
  label: string;
  src: "client" | "server";
  startedAt: number; // epoch ms
  durationMs: number;
  sampleCount: number;
  metrics: Record<string, MetricSummary>;
  meta: Record<string, unknown>; // env: app version + GPU/UA (client) or node/host (server)
}

/** One ranked contributor in a {@link PerfBreakdown} — a thing that costs resources.
 *  `value` is in `unit` (ms for spans, a raw count for entities/draw calls, etc.);
 *  the lists are sorted by `value` descending so the heaviest is always first. */
export interface ResourceItem {
  label: string;
  value: number;
  unit: string; // "ms" | "draws" | "tris" | "count" | "fx" | "MB"
  note?: string; // optional context (e.g. "240 of 312 entities")
}

/** A ranked "what's consuming resources right now" snapshot, split four ways:
 *  - reasons:  attributed COST — the perf spans/tags incl. the scene.render
 *              sub-phases (render.shadows/particles/animations/…), why time goes
 *  - render:   the scene render load attributed to each game-element KIND (goblin,
 *              tree, house…) by triangles + mesh batches — what's heavy to draw
 *  - elements: renderables — draw calls, particles, the biggest individual meshes
 *  - entities: game-object counts by category (players, goblins, trees, drops…) */
export interface PerfBreakdown {
  reasons: ResourceItem[];
  render: ResourceItem[];
  elements: ResourceItem[];
  entities: ResourceItem[];
}

/** Render load attributed to one game-element kind (grouped from the active meshes
 *  by their `metadata.kind`). The triangle total is the best on-the-frame proxy for
 *  "how expensive is this category to draw"; `draws` ≈ its sub-mesh batches. */
export interface RenderCategory {
  kind: string;
  meshes: number;
  draws: number;
  triangles: number;
}

/** A deep one-shot render snapshot — the "save the details for later" artefact. It
 *  pairs the engine sub-phase timings (where render time goes) with the per-element
 *  load (what is heavy to draw) and the heaviest individual meshes, so a lag source
 *  can be pinned down offline. Written to perf-logs/render-profile-<ts>.json. */
export interface RenderProfile {
  t: number;
  fps: number;
  frameMs: number | null;
  gpuMs: number | null;
  phases: Record<string, number>; // scene.render sub-phase ms (shadows, particles, main…)
  totals: {
    drawCalls: number;
    activeMeshes: number;
    totalMeshes: number;
    triangles: number;
    particleSystems: number;
    activeParticles: number;
    materials: number;
    textures: number;
  };
  byCategory: RenderCategory[];
  topMeshes: { name: string; triangles: number; vertices: number }[];
  meta: Record<string, unknown>;
}

/** A captured frame-rate dip: when FPS falls below the slow threshold the tracker
 *  snapshots WHY (the breakdown at that moment) so a stutter can be diagnosed after
 *  the fact, even if nobody had the overlay open. `cause` is the single loudest
 *  reason, for a one-line read. */
export interface SlowEvent {
  t: number; // epoch ms
  fps: number;
  frameMs: number | null;
  cause: string;
  breakdown: PerfBreakdown;
}
