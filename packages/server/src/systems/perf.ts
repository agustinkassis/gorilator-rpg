import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { cpus } from "node:os";
import {
  performance,
  monitorEventLoopDelay,
  type IntervalHistogram,
} from "node:perf_hooks";
import {
  ServerPerfSample,
  BenchmarkResult,
  MetricSummary,
  summarize,
} from "@rpg/shared";

/** Entity counts the room hands the tracker each tick (cheap to read from state). */
export interface TickCounts {
  players: number;
  enemies: number;
  entities: number; // all synced entities (players + enemies + resources + items)
}

const DEFAULT_CAP = 6000; // ~5 min at 20 Hz — in-memory ring for /api/perf + benchmarks
const FLUSH_MS = 5000; // how often buffered samples are appended to the JSONL log

/**
 * Server performance tracker — the CPU/memory/tick analogue of {@link realmTracker}.
 * The room calls {@link recordTick} once per simulation tick with the tick's wall
 * time + entity counts; {@link span}/{@link add} attribute work to named tags. It
 * keeps a rolling in-memory ring (always; powers GET /api/perf and benchmarks) and,
 * when `PERF_LOG=1`, appends every sample to a JSONL file under perf-logs/ for
 * offline analysis. See docs/performance.md.
 */
class ServerPerfTracker {
  private ring: ServerPerfSample[] = [];
  private writeBuf: ServerPerfSample[] = [];
  private readonly cap = DEFAULT_CAP;

  private started = false;
  private readonly diskLog = process.env.PERF_LOG === "1"; // opt-in continuous JSONL
  private readonly dir =
    process.env.PERF_LOG_DIR?.trim() || resolve(process.cwd(), "perf-logs");
  private logFile = "";

  private hist: IntervalHistogram | null = null;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = performance.now();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  // Per-tick tag accumulator (span ms / counters); folded into each sample.
  private tagAccum = new Map<string, number>();
  private openSpans = new Map<string, number>();

  private bench: {
    label: string;
    startedAt: number;
    durationMs: number;
    samples: ServerPerfSample[];
    resolve: (r: BenchmarkResult) => void;
  } | null = null;

  /** Start the event-loop-delay monitor and (if enabled) the disk flush loop.
   *  Idempotent — call once at server startup. */
  init(): void {
    if (this.started) return;
    this.started = true;
    this.hist = monitorEventLoopDelay({ resolution: 10 });
    this.hist.enable();
    if (this.diskLog) {
      this.ensureDir();
      this.logFile = join(this.dir, `server-${stamp()}.jsonl`);
      this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
      this.flushTimer.unref?.(); // don't keep the process alive just for the flush
      console.log(`[perf] server logging → ${this.logFile}`);
    }
    console.log(
      `[perf] tracker up (disk log ${this.diskLog ? "ON" : "off — set PERF_LOG=1 to record"})`,
    );
  }

  // ---- tagging ----

  /** Time a synchronous section and attribute its ms to `tag` for this tick. */
  span<T>(tag: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.tagAccum.set(tag, (this.tagAccum.get(tag) ?? 0) + (performance.now() - t0));
    }
  }
  /** Add `n` to a tag (a counter/gauge — e.g. perf.add("goblinsSpawned", k)). */
  add(tag: string, n = 1) {
    this.tagAccum.set(tag, (this.tagAccum.get(tag) ?? 0) + n);
  }
  begin(tag: string) {
    this.openSpans.set(tag, performance.now());
  }
  end(tag: string) {
    const t0 = this.openSpans.get(tag);
    if (t0 === undefined) return;
    this.openSpans.delete(tag);
    this.add(tag, performance.now() - t0);
  }

  // ---- sampling ----

  /** Record one simulation tick. `tickMs` is the wall time the tick body took
   *  (measure it in the room around the systems). */
  recordTick(tickMs: number, counts: TickCounts): void {
    if (!this.started) return;

    const now = performance.now();
    const cpu = process.cpuUsage(this.lastCpu); // micros of user+system since last
    const dtMs = now - this.lastCpuAt;
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const cpuPct = dtMs > 0 ? round(((cpu.user + cpu.system) / 1000 / dtMs) * 100, 1) : 0;

    const mem = process.memoryUsage();
    // `mean` is NaN until the loop has idled at least once between ticks (e.g. a
    // synchronous burst at startup) — coerce that to 0 so no sample carries NaN
    // (which JSON would silently turn into null and poison the summaries).
    const lagMean = this.hist ? this.hist.mean : NaN;
    const loopLagMs = Number.isFinite(lagMean) ? round(lagMean / 1e6, 2) : 0; // ns → ms
    this.hist?.reset();

    const tags: Record<string, number> = {};
    for (const [k, v] of this.tagAccum) tags[k] = round(v, 3);
    this.tagAccum.clear();

    const sample: ServerPerfSample = {
      t: Date.now(),
      tickMs: round(tickMs, 3),
      cpuPct,
      rssMB: round(mem.rss / 1048576, 1),
      heapMB: round(mem.heapUsed / 1048576, 1),
      loopLagMs,
      players: counts.players,
      enemies: counts.enemies,
      entities: counts.entities,
      tags,
    };

    this.ring.push(sample);
    if (this.ring.length > this.cap) this.ring.shift();
    if (this.diskLog) this.writeBuf.push(sample);
    if (this.bench) {
      this.bench.samples.push(sample);
      if (sample.t - this.bench.startedAt >= this.bench.durationMs) this.finishBenchmark();
    }
  }

  // ---- API snapshot (GET /api/perf) ----

  /** Latest sample + a short rolling summary, for the HTTP endpoint + overlay. */
  snapshot(): Record<string, unknown> {
    const latest = this.ring.length ? this.ring[this.ring.length - 1] : null;
    const cutoff = Date.now() - 5000;
    let i = this.ring.length;
    while (i > 0 && this.ring[i - 1].t >= cutoff) i--;
    const win = this.ring.slice(i);
    return {
      enabled: this.started,
      diskLog: this.diskLog,
      latest,
      window: { seconds: 5, samples: win.length, metrics: summarizeServer(win) },
      benchmarking: this.bench?.label ?? null,
      ringSize: this.ring.length,
      updatedAt: Date.now(),
    };
  }

  // ---- benchmark ----

  /** Capture a labelled window and resolve with its summary (also written to
   *  perf-logs/bench-*.json). */
  startBenchmark(label: string, durationMs = 15_000): Promise<BenchmarkResult> {
    if (this.bench) this.finishBenchmark();
    return new Promise<BenchmarkResult>((resolve) => {
      this.bench = { label, startedAt: Date.now(), durationMs, samples: [], resolve };
    });
  }
  isBenchmarking() {
    return this.bench !== null;
  }

  private finishBenchmark(): void {
    const b = this.bench;
    if (!b) return;
    this.bench = null;
    const result: BenchmarkResult = {
      label: b.label,
      src: "server",
      startedAt: b.startedAt,
      durationMs: Date.now() - b.startedAt,
      sampleCount: b.samples.length,
      metrics: summarizeServer(b.samples),
      meta: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: cpuCount(),
        pid: process.pid,
      },
    };
    this.ensureDir();
    try {
      writeFileSync(
        join(this.dir, `bench-${slug(b.label)}-${b.startedAt}.json`),
        JSON.stringify(result, null, 2),
      );
    } catch (err) {
      console.warn("[perf] could not write benchmark result", err);
    }
    b.resolve(result);
  }

  // ---- disk ----

  private ensureDir() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }
  private flush() {
    if (!this.writeBuf.length) return;
    const lines = this.writeBuf.map((s) => JSON.stringify(s)).join("\n") + "\n";
    this.writeBuf = [];
    try {
      appendFileSync(this.logFile, lines);
    } catch (err) {
      console.warn("[perf] log flush failed", err);
    }
  }
}

// ---- helpers ----

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Filesystem-safe timestamp for log filenames, e.g. 20260602-143012. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function slug(s: string): string {
  return (
    String(s || "run")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "run"
  );
}

function cpuCount(): number {
  try {
    return cpus().length;
  } catch {
    return 0;
  }
}

/** Collapse server samples into per-metric summaries (numeric columns + `tag:*`). */
function summarizeServer(samples: ServerPerfSample[]): Record<string, MetricSummary> {
  const cols: Record<string, number[]> = {
    tickMs: [],
    cpuPct: [],
    rssMB: [],
    heapMB: [],
    loopLagMs: [],
    players: [],
    enemies: [],
    entities: [],
  };
  const tagCols: Record<string, number[]> = {};
  for (const s of samples) {
    cols.tickMs.push(s.tickMs);
    cols.cpuPct.push(s.cpuPct);
    cols.rssMB.push(s.rssMB);
    cols.heapMB.push(s.heapMB);
    cols.loopLagMs.push(s.loopLagMs);
    cols.players.push(s.players);
    cols.enemies.push(s.enemies);
    cols.entities.push(s.entities);
    for (const k in s.tags) (tagCols[k] ??= []).push(s.tags[k]);
  }
  const out: Record<string, MetricSummary> = {};
  for (const k in cols) if (cols[k].length) out[k] = summarize(cols[k]);
  for (const k in tagCols) out[`tag:${k}`] = summarize(tagCols[k]);
  return out;
}

/** Server-wide singleton (the game runs a single room). */
export const perfTracker = new ServerPerfTracker();
