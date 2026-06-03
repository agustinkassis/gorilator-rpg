import {
  ClientPerfSample,
  BenchmarkResult,
  MetricSummary,
  PerfBreakdown,
  RenderProfile,
  ResourceItem,
  SlowEvent,
  summarize,
} from "@rpg/shared";

/** The live elements/entities/render-load source (set from main.ts; reads scene + game). */
type BreakdownProvider = () => {
  render: ResourceItem[];
  elements: ResourceItem[];
  entities: ResourceItem[];
};

/** Per-frame metrics the Babylon probes push in once per rendered frame. */
export interface FrameMetrics {
  fps: number;
  frameMs: number | null; // null while the heavy CPU-frame-time capture is off
  gpuMs: number | null; // null when the GPU timer query is unsupported / capture off
  drawCalls: number;
  activeMeshes: number;
  triangles: number;
}

const DEFAULT_CAP = 10_800; // ~3 min at 60 fps — the live ring-buffer ceiling
const SLOW_RECAPTURE_MS = 2000; // while sustained-slow, re-snapshot the culprits this often
const SLOW_EVENT_CAP = 60; // keep the most recent N slowdowns

/**
 * The client-side performance tracker: a frame-rate ring buffer plus a tagged
 * accumulator, with benchmark capture and disk/download persistence.
 *
 * It is deliberately Babylon-agnostic — `babylonProbes` reads the engine/scene
 * counters and feeds them in via {@link setFrameMetrics}, and {@link tick} emits a
 * sample. The tagging API ({@link span}/{@link add}) is the "track any resource use
 * with a tag and store it" surface: anything you wrap is summarized + saved
 * alongside the frame metrics. See docs/performance.md.
 */
export class PerfTracker {
  private ring: ClientPerfSample[] = [];
  private readonly cap: number;
  private enabled = true;

  private frame: FrameMetrics | null = null; // latest probe reading (null until 1st frame)

  // Per-frame tag accumulator (ms for spans, arbitrary numbers for counters/gauges).
  // Folded into each emitted sample, then cleared.
  private tagAccum = new Map<string, number>();
  private openSpans = new Map<string, number>();

  // Active benchmark capture: collects samples until its deadline, then resolves.
  private bench: {
    label: string;
    startedAt: number;
    durationMs: number;
    samples: ClientPerfSample[];
    resolve: (r: BenchmarkResult) => void;
  } | null = null;

  /** Environment metadata stamped onto benchmark results (set by the probes). */
  meta: Record<string, unknown> = {};

  // ---- slow-frame ("what's slow") auto-tracking ----
  /** FPS at or below this is "slow" → the tracker snapshots the culprits. */
  slowFpsThreshold = 50;
  /** Supplies the live render/elements/entities lists (set from main.ts; reads the
   *  scene + game). Null until wired — reasons (span tags) still work without it. */
  private breakdownProvider: BreakdownProvider | null = null;
  /** Supplies the deep render profile (set from main.ts; reads scene + probe phases). */
  private renderProfileProvider: (() => RenderProfile) | null = null;
  private slowEvents: SlowEvent[] = [];
  private slowSince: number | null = null; // when the current dip began (null = not slow)
  private lastSlowCaptureAt = 0;
  private unseenSlow = 0; // new slowdowns since the overlay last looked

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }
  isEnabled() {
    return this.enabled;
  }

  /** The probes call this each frame with freshly-read engine/scene counters. */
  setFrameMetrics(m: FrameMetrics) {
    this.frame = m;
  }

  // ---- tagging: "track any resource usage with a tag and store it" ----

  /** Add `n` to a tag's running total for the current frame — a counter or gauge.
   *  e.g. `perf.add("bananasThrown")` or `perf.add("net.bytesIn", len)`. */
  add(tag: string, n = 1) {
    if (!this.enabled) return;
    this.tagAccum.set(tag, (this.tagAccum.get(tag) ?? 0) + n);
  }

  /** Time a synchronous section and accumulate its ms under `tag`. Returns the
   *  function's value, so it wraps an existing call inline:
   *  `const r = perf.span("entities.update", () => game.update(dt));` */
  span<T>(tag: string, fn: () => T): T {
    if (!this.enabled) return fn();
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.tagAccum.set(tag, (this.tagAccum.get(tag) ?? 0) + (performance.now() - t0));
    }
  }

  /** Manual span start; pair with {@link end}. For sections you can't wrap in a
   *  single callback. A second begin(tag) before end(tag) restarts the timer. */
  begin(tag: string) {
    if (this.enabled) this.openSpans.set(tag, performance.now());
  }
  end(tag: string) {
    const t0 = this.openSpans.get(tag);
    if (t0 === undefined) return;
    this.openSpans.delete(tag);
    this.add(tag, performance.now() - t0);
  }

  // ---- sampling ----

  /** Emit one sample from the latest frame metrics + accumulated tags. Call once
   *  per rendered frame, after setFrameMetrics. Cheap — safe to call always. */
  tick() {
    if (!this.enabled || !this.frame) return;

    const tags: Record<string, number> = {};
    for (const [k, v] of this.tagAccum) tags[k] = round(v, 3);
    this.tagAccum.clear();

    const sample: ClientPerfSample = {
      t: Date.now(),
      fps: round(this.frame.fps, 1),
      frameMs: this.frame.frameMs === null ? null : round(this.frame.frameMs, 3),
      gpuMs: this.frame.gpuMs === null ? null : round(this.frame.gpuMs, 3),
      heapMB: readHeapMB(),
      drawCalls: this.frame.drawCalls,
      activeMeshes: this.frame.activeMeshes,
      triangles: this.frame.triangles,
      tags,
    };

    this.ring.push(sample);
    if (this.ring.length > this.cap) this.ring.shift();

    if (this.bench) {
      this.bench.samples.push(sample);
      if (sample.t - this.bench.startedAt >= this.bench.durationMs) this.finishBenchmark();
    }

    this.detectSlow(sample); // auto-capture the culprits when the frame rate dips
  }

  // ---- slow-frame tracking: "start tracking the reasons when fps gets slow" ----

  /** Wire the render/elements/entities source (the scene + game). Reasons (span
   *  tags) are the tracker's own, so a breakdown is partial-but-useful without it. */
  setBreakdownProvider(fn: BreakdownProvider) {
    this.breakdownProvider = fn;
  }

  /** Wire the deep render-profile source (scene + the probe's sub-phase timings). */
  setRenderProfileProvider(fn: () => RenderProfile) {
    this.renderProfileProvider = fn;
  }

  /** The live "what's consuming resources" snapshot: reasons = this tracker's span
   *  tags over the last `seconds` (sorted by ms — incl. the scene.render sub-phases;
   *  the `geo:*` geometry tags are excluded, they're surfaced in `render` instead),
   *  render/elements/entities from the provider. Backs the overlay's expand panel. */
  breakdown(seconds = 1): PerfBreakdown {
    const reasons: ResourceItem[] = [];
    const m = this.summary(seconds).metrics;
    for (const k in m) {
      if (!k.startsWith("tag:") || k.startsWith("tag:geo:")) continue; // geo:* are tris, not ms
      reasons.push({ label: k.slice(4), value: round(m[k].avg, 3), unit: "ms" });
    }
    reasons.sort((a, b) => b.value - a.value);
    const ext = this.breakdownProvider?.() ?? { render: [], elements: [], entities: [] };
    return { reasons, render: ext.render, elements: ext.elements, entities: ext.entities };
  }

  /** Capture + save a deep render profile (sub-phase timings + per-element load +
   *  heaviest meshes) to perf-logs/render-profile-<ts>.json. Returns it too. */
  async captureRenderProfile(): Promise<RenderProfile | null> {
    const profile = this.renderProfileProvider?.();
    if (!profile) return null;
    await this.save(`render-profile-${profile.t}.json`, JSON.stringify(profile, null, 2), "benchmark");
    return profile;
  }

  /** On each sample: if FPS is below the threshold, snapshot the culprits — once on
   *  the dip's onset, then periodically while it persists. */
  private detectSlow(sample: ClientPerfSample) {
    if (sample.fps >= this.slowFpsThreshold) {
      this.slowSince = null;
      return;
    }
    const onset = this.slowSince === null;
    if (onset) this.slowSince = sample.t;
    if (!onset && sample.t - this.lastSlowCaptureAt < SLOW_RECAPTURE_MS) return;

    this.lastSlowCaptureAt = sample.t;
    const breakdown = this.breakdown(0.5); // a tight window around the dip
    this.slowEvents.push({
      t: sample.t,
      fps: sample.fps,
      frameMs: sample.frameMs,
      cause: breakdown.reasons[0]?.label ?? "unknown",
      breakdown,
    });
    if (this.slowEvents.length > SLOW_EVENT_CAP) this.slowEvents.shift();
    this.unseenSlow++;
  }

  /** Captured slowdowns, most recent first. */
  slowdowns(): SlowEvent[] {
    return [...this.slowEvents].reverse();
  }
  slowCount() {
    return this.slowEvents.length;
  }
  /** Count of slowdowns captured since the overlay last viewed them (for a badge). */
  unseenSlowdowns() {
    return this.unseenSlow;
  }
  markSlowdownsSeen() {
    this.unseenSlow = 0;
  }
  clearSlowdowns() {
    this.slowEvents = [];
    this.unseenSlow = 0;
    this.slowSince = null;
  }

  /** Persist the captured slowdowns (+ env) for offline analysis. */
  async saveSlowReport(): Promise<void> {
    const report = {
      src: "client",
      capturedAt: Date.now(),
      slowFpsThreshold: this.slowFpsThreshold,
      count: this.slowEvents.length,
      meta: { ...this.meta },
      events: this.slowEvents,
    };
    await this.save(`slowdowns-${Date.now()}.json`, JSON.stringify(report, null, 2), "benchmark");
  }

  // ---- live read (for the overlay) ----

  latest(): ClientPerfSample | null {
    return this.ring.length ? this.ring[this.ring.length - 1] : null;
  }

  /** Summaries over the last `seconds` of samples, keyed by metric + `tag:*`. */
  summary(seconds = 2): { metrics: Record<string, MetricSummary>; sampleCount: number } {
    const cutoff = Date.now() - seconds * 1000;
    let i = this.ring.length;
    while (i > 0 && this.ring[i - 1].t >= cutoff) i--;
    const win = this.ring.slice(i);
    return { metrics: summarizeSamples(win), sampleCount: win.length };
  }

  // ---- benchmark ----

  /** Capture a labelled window and resolve with its summary (also auto-saved to
   *  perf-logs/). Starting one while another runs finalizes the first. */
  startBenchmark(label: string, durationMs = 10_000): Promise<BenchmarkResult> {
    if (this.bench) this.finishBenchmark();
    return new Promise<BenchmarkResult>((resolve) => {
      this.bench = { label, startedAt: Date.now(), durationMs, samples: [], resolve };
    });
  }
  isBenchmarking() {
    return this.bench !== null;
  }
  benchmarkLabel(): string | null {
    return this.bench?.label ?? null;
  }
  /** 0..1 progress of the active benchmark (0 when none). */
  benchmarkProgress(): number {
    if (!this.bench) return 0;
    return Math.min(1, (Date.now() - this.bench.startedAt) / this.bench.durationMs);
  }

  private finishBenchmark() {
    const b = this.bench;
    if (!b) return;
    this.bench = null;
    const result: BenchmarkResult = {
      label: b.label,
      src: "client",
      startedAt: b.startedAt,
      durationMs: Date.now() - b.startedAt,
      sampleCount: b.samples.length,
      metrics: summarizeSamples(b.samples),
      meta: { ...this.meta },
    };
    void this.save(
      `bench-${slug(b.label)}-${b.startedAt}.json`,
      JSON.stringify(result, null, 2),
      "benchmark",
    );
    b.resolve(result);
  }

  // ---- export / persistence ----

  /** The whole ring as JSONL (one ClientPerfSample per line). */
  toJSONL(): string {
    return this.ring.map((s) => JSON.stringify(s)).join("\n");
  }

  /** Persist to perf-logs/ via the dev endpoint; falls back to a browser download
   *  when the endpoint is unavailable (a production build with no Vite server). */
  async save(name: string, body?: string, kind: "log" | "benchmark" = "log"): Promise<void> {
    const payload = body ?? this.toJSONL();
    try {
      const res = await fetch(`/__perf/save?name=${encodeURIComponent(name)}&kind=${kind}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: payload,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`[perf] saved ${name} (${payload.length} B) → perf-logs/`);
    } catch {
      this.download(name, payload); // no dev endpoint → hand the file to the browser
    }
  }

  /** Trigger a browser download of the data (works in any build). */
  download(name: string, body?: string) {
    const blob = new Blob([body ?? this.toJSONL()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  clear() {
    this.ring = [];
  }
  size() {
    return this.ring.length;
  }
}

// ---- helpers ----

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** JS heap used, in MB, from the non-standard Chromium `performance.memory`; null
 *  on engines that don't expose it (Firefox/Safari). */
function readHeapMB(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? round(mem.usedJSHeapSize / 1048576, 1) : null;
}

function slug(s: string): string {
  return (
    String(s || "run")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "run"
  );
}

/** Collapse client samples into per-metric summaries: every numeric column plus
 *  every tag ever seen (under a `tag:` prefix). Null readings are skipped so an
 *  unsupported metric simply yields no summary instead of polluting one with 0s. */
function summarizeSamples(samples: ClientPerfSample[]): Record<string, MetricSummary> {
  const cols: Record<string, number[]> = {
    fps: [],
    frameMs: [],
    gpuMs: [],
    heapMB: [],
    drawCalls: [],
    activeMeshes: [],
    triangles: [],
  };
  const tagCols: Record<string, number[]> = {};
  for (const s of samples) {
    cols.fps.push(s.fps);
    if (s.frameMs !== null) cols.frameMs.push(s.frameMs);
    if (s.gpuMs !== null) cols.gpuMs.push(s.gpuMs);
    if (s.heapMB !== null) cols.heapMB.push(s.heapMB);
    cols.drawCalls.push(s.drawCalls);
    cols.activeMeshes.push(s.activeMeshes);
    cols.triangles.push(s.triangles);
    for (const k in s.tags) (tagCols[k] ??= []).push(s.tags[k]);
  }
  const out: Record<string, MetricSummary> = {};
  for (const k in cols) if (cols[k].length) out[k] = summarize(cols[k]);
  for (const k in tagCols) out[`tag:${k}`] = summarize(tagCols[k]);
  return out;
}
