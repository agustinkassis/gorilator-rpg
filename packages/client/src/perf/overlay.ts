import type { PerfTracker } from "./PerfTracker";
import type { BabylonProbes } from "./babylonProbes";
import type { MetricSummary } from "@rpg/shared";

const SERVER_POLL_MS = 1000; // how often to pull /api/perf for the server line
const BENCH_DEFAULT_MS = 10_000;

/**
 * The on-screen performance HUD (toggle with F3, or `?perf` in the URL). It is the
 * visible face of the {@link PerfTracker}: live client metrics, a polled server
 * line, the loudest tags, and one-click benchmark / save controls.
 *
 * Opening it switches on the heavy Babylon captures (CPU + GPU frame time); closing
 * it switches them back off — except while a benchmark is mid-run — so the overlay
 * never quietly taxes the frame it's measuring. See docs/performance.md.
 */
export class PerfOverlay {
  private panel: HTMLDivElement;
  private body: HTMLDivElement;
  private benchBtn: HTMLButtonElement;
  private labelInput: HTMLInputElement;
  private status: HTMLDivElement;
  private open = false;
  private raf = 0;

  private server: Record<string, unknown> | null = null;
  private serverTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private perf: PerfTracker,
    private probes: BabylonProbes,
    private serverHttpBase: string,
  ) {
    const panel = document.createElement("div");
    panel.id = "perfOverlay";
    panel.style.cssText =
      "position:fixed; right:12px; top:40px; width:300px; z-index:60; display:none;" +
      "background:#0c0f16f2; border:1px solid #c9a24a; border-radius:8px;" +
      "box-shadow:0 8px 28px #000a; font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;" +
      "color:#e6e9f0; overflow:hidden; user-select:none;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;
                  padding:5px 9px; background:#161c28; border-bottom:1px solid #c9a24a;">
        <b style="color:#f0d27a; letter-spacing:.3px;">⚡ PERF · F3</b>
        <span id="perfClose" style="cursor:pointer; color:#8b93a7; padding:0 4px;">✕</span>
      </div>
      <div id="perfBody" style="padding:8px 9px; white-space:pre; min-height:120px;"></div>
      <div style="display:flex; gap:5px; align-items:center; padding:7px 9px;
                  border-top:1px solid #2a3242; background:#0d1017;">
        <input id="perfLabel" type="text" placeholder="benchmark label" spellcheck="false"
               style="flex:1; min-width:0; background:#11151f; color:#e6e9f0;
                      border:1px solid #2a3242; border-radius:4px; padding:3px 6px; font:inherit;">
        <button id="perfBench" style="${btn("#2a3a24", "#7bd17b")}">● 10s</button>
      </div>
      <div style="display:flex; gap:5px; padding:0 9px 8px; background:#0d1017;">
        <button id="perfSave" style="${btn("#1c2230", "#cdd3e0")}">Save log</button>
        <button id="perfDownload" style="${btn("#1c2230", "#cdd3e0")}">Download</button>
        <button id="perfClear" style="${btn("#2e1f24", "#e0a0a0")}">Clear</button>
      </div>
      <div id="perfStatus" style="padding:0 9px 8px; color:#8b93a7; min-height:13px; background:#0d1017;"></div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.body = panel.querySelector("#perfBody") as HTMLDivElement;
    this.benchBtn = panel.querySelector("#perfBench") as HTMLButtonElement;
    this.labelInput = panel.querySelector("#perfLabel") as HTMLInputElement;
    this.status = panel.querySelector("#perfStatus") as HTMLDivElement;

    (panel.querySelector("#perfClose") as HTMLElement).onclick = () => this.toggle();
    this.benchBtn.onclick = () => void this.runBenchmark();
    (panel.querySelector("#perfSave") as HTMLElement).onclick = () => void this.saveLog();
    (panel.querySelector("#perfDownload") as HTMLElement).onclick = () =>
      this.perf.download(`perf-log-${Date.now()}.jsonl`);
    (panel.querySelector("#perfClear") as HTMLElement).onclick = () => {
      this.perf.clear();
      this.flash("ring cleared");
    };

    window.addEventListener("keydown", (e) => {
      if (e.key !== "F3") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      this.toggle();
    });
  }

  toggle() {
    this.open = !this.open;
    this.panel.style.display = this.open ? "block" : "none";
    // Heavy captures (CPU+GPU frame time) follow the overlay, but never switch off
    // out from under an in-flight benchmark.
    this.probes.setHeavyCapture(this.open || this.perf.isBenchmarking());
    if (this.open) {
      this.pollServer();
      this.serverTimer = setInterval(() => this.pollServer(), SERVER_POLL_MS);
      this.loop();
    } else {
      cancelAnimationFrame(this.raf);
      if (this.serverTimer) clearInterval(this.serverTimer);
      this.serverTimer = null;
    }
  }

  private loop = () => {
    if (!this.open) return;
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  private async runBenchmark() {
    if (this.perf.isBenchmarking()) return;
    const label = this.labelInput.value.trim() || "run";
    this.probes.setHeavyCapture(true); // make sure frame/GPU time is captured for the window
    this.flash(`benchmarking "${label}"…`);
    const result = await this.perf.startBenchmark(label, BENCH_DEFAULT_MS);
    if (!this.open) this.probes.setHeavyCapture(false);
    const fps = result.metrics.fps;
    this.flash(
      fps
        ? `saved bench-${label}: fps avg ${fps.avg.toFixed(0)} · p95-low ${fps.p95.toFixed(0)} · 1%-low ${minName(result.metrics)}`
        : `saved bench-${label} (${result.sampleCount} samples)`,
    );
  }

  private async saveLog() {
    await this.perf.save(`perf-log-${Date.now()}.jsonl`);
    this.flash(`saved ${this.perf.size()} samples`);
  }

  private async pollServer() {
    try {
      const res = await fetch(`${this.serverHttpBase}/api/perf`, { cache: "no-store" });
      this.server = res.ok ? await res.json() : null;
    } catch {
      this.server = null;
    }
  }

  private render() {
    const live = this.perf.summary(1).metrics; // last ~1s
    const latest = this.perf.latest();
    const fps = live.fps;
    const gpuTimer = this.perf.meta.gpuTimer === true;

    const lines: string[] = [];
    lines.push(
      `${colorFps(fps ? fps.avg : 0)}  fps  ${fmt(fps, 0)}  (1%low ${fps ? oneLow(fps).toFixed(0) : "–"})`,
    );
    lines.push(`frame   ${fmtMs(live.frameMs)}   gpu ${gpuTimer ? fmtMs(live.gpuMs) : "n/a"}`);
    lines.push(`heap    ${live.heapMB ? live.heapMB.avg.toFixed(0) + " MB" : "n/a (Chromium only)"}`);
    lines.push(
      `draws ${num(latest?.drawCalls)}  mesh ${num(latest?.activeMeshes)}  tris ${kfmt(latest?.triangles)}`,
    );

    // The loudest custom tags this second (span ms / counters), biggest first.
    const tags = Object.entries(live)
      .filter(([k]) => k.startsWith("tag:"))
      .map(([k, v]) => [k.slice(4), (v as MetricSummary).avg] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    if (tags.length) {
      lines.push("\x1b" /* spacer marker, replaced below */);
      lines.push("tags (avg/frame)");
      for (const [k, v] of tags) lines.push(`  ${k.padEnd(16).slice(0, 16)} ${v.toFixed(3)}`);
    }

    // Server line (polled). The shape is perfTracker.snapshot() from the server.
    lines.push("\x1b");
    lines.push(this.renderServer());

    this.body.textContent = lines.join("\n").replace(/\x1b/g, "─".repeat(34));

    if (this.perf.isBenchmarking()) {
      const pct = Math.round(this.perf.benchmarkProgress() * 100);
      this.benchBtn.textContent = `● ${pct}%`;
      this.benchBtn.disabled = true;
    } else {
      this.benchBtn.textContent = "● 10s";
      this.benchBtn.disabled = false;
    }
  }

  private renderServer(): string {
    const s = this.server as
      | { latest?: Record<string, number>; window?: { metrics?: Record<string, MetricSummary> }; benchmarking?: string | null }
      | null;
    if (!s || !s.latest) return "server  offline / no /api/perf";
    const m = s.window?.metrics ?? {};
    const L = s.latest;
    const out = [
      `server  cpu ${num(L.cpuPct)}%  tick ${fmtMs(m.tickMs)}`,
      `        rss ${num(L.rssMB)}MB  heap ${num(L.heapMB)}MB  lag ${num(L.loopLagMs)}ms`,
      `        players ${num(L.players)}  enemies ${num(L.enemies)}  ent ${num(L.entities)}`,
    ];
    if (s.benchmarking) out.push(`        ⏺ benchmarking "${s.benchmarking}"`);
    return out.join("\n");
  }

  private flash(msg: string) {
    this.status.textContent = msg;
  }
}

// ---- formatting helpers ----

function btn(bg: string, fg: string): string {
  return (
    `cursor:pointer; background:${bg}; color:${fg}; border:1px solid #2a3242;` +
    `border-radius:4px; padding:3px 8px; font:inherit; flex:1;`
  );
}
const fmt = (s: MetricSummary | undefined, dp: number) => (s ? s.avg.toFixed(dp) : "–");
const fmtMs = (s: MetricSummary | undefined) => (s ? `${s.avg.toFixed(2)}ms` : "–");
const num = (v: number | undefined) => (v === undefined || v === null ? "–" : String(v));
const kfmt = (v: number | undefined) =>
  v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v);
/** A cheap "1% low" proxy: the worst (lowest) recent fps ≈ the p1 of fps. */
const oneLow = (s: MetricSummary) => s.min;
const minName = (m: Record<string, MetricSummary>) => (m.fps ? m.fps.min.toFixed(0) : "–");
function colorFps(avg: number): string {
  if (avg >= 55) return "🟢";
  if (avg >= 30) return "🟡";
  return "🔴";
}
