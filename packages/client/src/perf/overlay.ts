import type { PerfTracker } from "./PerfTracker";
import type { BabylonProbes } from "./babylonProbes";
import type { MetricSummary, ResourceItem } from "@rpg/shared";

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
  private expandBtn: HTMLButtonElement;
  private breakdownEl: HTMLDivElement;
  private open = false;
  private expanded = false;
  private lastBreakdownAt = 0;
  private raf = 0;

  private server: Record<string, unknown> | null = null;
  private serverTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private perf: PerfTracker,
    private probes: BabylonProbes,
    private serverHttpBase: string,
  ) {
    injectBreakdownStyles();
    const panel = document.createElement("div");
    panel.id = "perfOverlay";
    panel.style.cssText =
      "position:fixed; right:12px; top:12px; width:340px; max-height:calc(100vh - 24px); z-index:2147483647; display:none;" +
      "background:#0c0f16f2; border:1px solid #c9a24a; border-radius:8px;" +
      "box-shadow:0 8px 28px #000a; font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;" +
      "color:#e6e9f0; overflow:auto; user-select:none;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;
                  padding:5px 9px; background:#161c28; border-bottom:1px solid #c9a24a; position:sticky; top:0;">
        <b style="color:#f0d27a; letter-spacing:.3px;">⚡ PERF · F3</b>
        <span id="perfClose" style="cursor:pointer; color:#8b93a7; padding:0 4px;">✕</span>
      </div>
      <div id="perfBody" style="padding:8px 9px; white-space:pre; min-height:120px;"></div>
      <button id="perfExpand" style="display:block; width:100%; text-align:left; cursor:pointer;
              background:#11161f; color:#cdd3e0; border:0; border-top:1px solid #2a3242;
              padding:5px 9px; font:inherit;">▸ What's heavy</button>
      <div id="perfBreakdown" style="display:none; padding:4px 9px 8px; background:#0a0d14;"></div>
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
    this.expandBtn = panel.querySelector("#perfExpand") as HTMLButtonElement;
    this.breakdownEl = panel.querySelector("#perfBreakdown") as HTMLDivElement;

    (panel.querySelector("#perfClose") as HTMLElement).onclick = () => this.toggle();
    this.expandBtn.onclick = () => this.toggleExpand();
    this.benchBtn.onclick = () => void this.runBenchmark();
    (panel.querySelector("#perfSave") as HTMLElement).onclick = () => void this.saveLog();
    (panel.querySelector("#perfDownload") as HTMLElement).onclick = () =>
      this.perf.download(`perf-log-${Date.now()}.jsonl`);
    (panel.querySelector("#perfClear") as HTMLElement).onclick = () => {
      this.perf.clear();
      this.flash("ring cleared");
    };
    // The slowdowns "save"/"clear" links are re-rendered each frame, so handle them
    // by delegation (one listener) instead of rebinding.
    this.breakdownEl.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).id;
      if (id === "pfSlowSave") {
        void this.perf.saveSlowReport().then(() => this.flash(`saved ${this.perf.slowCount()} slowdowns`));
      } else if (id === "pfSlowClear") {
        this.perf.clearSlowdowns();
        this.renderBreakdown(true);
        this.flash("slowdowns cleared");
      } else if (id === "pfProfile") {
        this.probes.setHeavyCapture(true); // ensure the sub-phase timers are filled
        void this.perf.captureRenderProfile().then((p) =>
          this.flash(p ? `saved render profile · top: ${p.byCategory[0]?.kind ?? "?"}` : "profile unavailable"),
        );
      }
    });

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
    const currentFps = latest?.fps;
    const gpuTimer = this.perf.meta.gpuTimer === true;

    const lines: string[] = [];
    lines.push(
      `${colorFps(currentFps ?? fps?.avg ?? 0)}  fps  now ${fmtNum(currentFps, 0)}  avg ${fmt(fps, 0)}  min ${fmtMin(fps, 0)}  max ${fmtMax(fps, 0)}`,
    );
    lines.push(`        1%low ${fps ? oneLow(fps).toFixed(0) : "–"}  samples ${fps?.count ?? 0}`);
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

    // Expand button: badge with the captured-slowdown count, reddened while unseen
    // so a dip that happened with the panel collapsed still gets your attention.
    const sc = this.perf.slowCount();
    this.expandBtn.textContent = `${this.expanded ? "▾" : "▸"} What's heavy${sc ? `   ⚠ ${sc}` : ""}`;
    this.expandBtn.style.color = this.perf.unseenSlowdowns() > 0 ? "#ffb4a8" : "#cdd3e0";
    if (this.expanded) this.renderBreakdown();
  }

  private toggleExpand() {
    this.expanded = !this.expanded;
    this.breakdownEl.style.display = this.expanded ? "block" : "none";
    if (this.expanded) {
      this.perf.markSlowdownsSeen();
      this.renderBreakdown(true);
    }
  }

  /** Render the "what's consuming resources" drill-down: reasons (span ms),
   *  elements (renderables), entities (game objects), and the captured slowdowns.
   *  Throttled — the mesh scan behind `elements` needn't run every frame. */
  private renderBreakdown(force = false) {
    if (!this.expanded) return;
    const now = Date.now();
    if (!force && now - this.lastBreakdownAt < 200) return;
    this.lastBreakdownAt = now;
    const b = this.perf.breakdown(1);
    this.breakdownEl.innerHTML =
      `<div class="pf-hd" style="display:flex;justify-content:space-between;align-items:center;margin-top:1px;">` +
      `<span>Heaviest now</span><a id="pfProfile" class="pf-link">📷 save render profile</a></div>` +
      listHtml("Reasons — ms / frame", b.reasons, "#e0b15a") +
      listHtml("Scene render — by element (tris)", b.render, "#d98c54") +
      listHtml("Elements — renderables", b.elements, "#5aa9e6") +
      listHtml("Entities — game objects", b.entities, "#7bd17b") +
      this.slowdownsHtml();
  }

  private slowdownsHtml(): string {
    const events = this.perf.slowdowns();
    const head =
      `<div class="pf-hd" style="display:flex;justify-content:space-between;align-items:center;">` +
      `<span>⚠ Slowdowns (${events.length})</span><span>` +
      (events.length ? `<a id="pfSlowSave" class="pf-link">save</a> · <a id="pfSlowClear" class="pf-link">clear</a>` : "") +
      `</span></div>`;
    if (!events.length) {
      return head + `<div class="pf-empty">none yet — fps has stayed ≥ ${this.perf.slowFpsThreshold}</div>`;
    }
    const rows = events
      .slice(0, 8)
      .map(
        (e) =>
          `<div class="pf-srow"><span class="pf-slow">${colorFps(e.fps)} ${e.fps.toFixed(0)}fps</span>` +
          `<span class="pf-stime">${clock(e.t)} · ${esc(e.cause)}</span></div>`,
      )
      .join("");
    return head + rows;
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
const fmtNum = (v: number | undefined, dp: number) => (v === undefined || v === null ? "–" : v.toFixed(dp));
const fmtMin = (s: MetricSummary | undefined, dp: number) => (s ? s.min.toFixed(dp) : "–");
const fmtMax = (s: MetricSummary | undefined, dp: number) => (s ? s.max.toFixed(dp) : "–");
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

// ---- breakdown rendering ----

/** A titled, heaviest-first list with a proportional bar per row. `ms` values show
 *  two decimals; everything else is compacted (1.4m / 732). */
function listHtml(title: string, items: ResourceItem[], color: string): string {
  if (!items.length) return `<div class="pf-hd">${title}</div><div class="pf-empty">—</div>`;
  const top = items.slice(0, 7);
  const max = Math.max(1, ...top.map((i) => i.value));
  const rows = top
    .map((i) => {
      const pct = Math.max(2, Math.round((i.value / max) * 100));
      const note = i.note ? ` <em>${esc(i.note)}</em>` : "";
      const val = i.unit === "ms" ? i.value.toFixed(2) : compact(i.value);
      const unit = i.unit ? ` <i>${esc(i.unit)}</i>` : "";
      return (
        `<div class="pf-item"><div class="pf-row">` +
        `<span class="pf-lbl">${esc(i.label)}${note}</span>` +
        `<span class="pf-val">${val}${unit}</span></div>` +
        `<div class="pf-bar"><div style="width:${pct}%;background:${color}"></div></div></div>`
      );
    })
    .join("");
  return `<div class="pf-hd">${title}</div>${rows}`;
}

function compact(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString();
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** Inject the breakdown row/bar styles once. */
function injectBreakdownStyles() {
  if (document.getElementById("perfBreakdownStyles")) return;
  const s = document.createElement("style");
  s.id = "perfBreakdownStyles";
  s.textContent = `
    #perfBreakdown .pf-hd { color:#f0d27a; font-weight:700; margin:7px 0 3px; }
    #perfBreakdown .pf-hd:first-child { margin-top:1px; }
    #perfBreakdown .pf-item { margin:2px 0; }
    #perfBreakdown .pf-row { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
    #perfBreakdown .pf-lbl { color:#cdd3e0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #perfBreakdown .pf-lbl em { color:#6b7487; font-style:normal; }
    #perfBreakdown .pf-val { color:#fff; white-space:nowrap; }
    #perfBreakdown .pf-val i { color:#8b93a7; font-style:normal; }
    #perfBreakdown .pf-bar { height:3px; background:#1c2230; border-radius:2px; overflow:hidden; margin-top:2px; }
    #perfBreakdown .pf-bar > div { height:100%; }
    #perfBreakdown .pf-empty { color:#6b7487; padding:1px 0; }
    #perfBreakdown .pf-srow { display:flex; justify-content:space-between; gap:8px; padding:1px 0; }
    #perfBreakdown .pf-slow { color:#e0a0a0; white-space:nowrap; }
    #perfBreakdown .pf-stime { color:#8b93a7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #perfBreakdown .pf-link { color:#7fb0e0; cursor:pointer; text-decoration:underline; }
  `;
  document.head.appendChild(s);
}
