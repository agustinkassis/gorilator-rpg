# Performance tracking & benchmarking

A built-in performance pipeline for the two things that actually move the needle in
this game: the **client** frame budget (FPS, CPU frame time, GPU frame time, JS
heap) and the **server** tick budget (CPU, memory, tick time, event-loop lag). It
samples continuously, lets you tag any piece of work, captures labelled
**benchmarks**, and stores everything as **analyze-ready JSONL** so you can prove a
change helped instead of guessing.

> TL;DR — press **F3** in-game for the live overlay. Click **● 10s** to record a
> benchmark. Run `pnpm perf perf-logs/<file>` to read it, or
> `pnpm perf <baseline> <candidate>` to diff two runs.

> This page documents **how the tooling works**. For the ongoing **benchmarking
> process, scenarios, findings, and the optimization backlog**, see the living
> [performance-research.md](performance-research.md).

---

## 1. The shape of the system

```
            CLIENT (browser, Babylon)                      SERVER (Node, Colyseus)
  ┌───────────────────────────────────┐         ┌────────────────────────────────────┐
  scene.onAfterRender ─► babylonProbes           setSimulationInterval ─► perf.span(…)
        │ fps, draw calls, meshes, tris │              │  per-system span times        │
        │ + frame/GPU ms (heavy capture)│              │  tickMs, cpu%, rss, heap, lag  │
        ▼                               │              ▼                                │
   PerfTracker (ring buffer + tags) ────┘        perfTracker (ring buffer + tags) ──────┘
        │  window.__perf                                │  GET /api/perf
        ▼                                               ▼
   F3 overlay · save() ─► POST /__perf/save        JSONL (PERF_LOG=1) · bench-*.json
        │                                               │
        └──────────────► perf-logs/ ◄───────────────────┘
                              │
                              ▼
                  pnpm perf  (scripts/perf-analyze.mjs) · jq · pandas
```

Two design rules make the numbers trustworthy:

- **Always-on sampling is cheap.** Every frame/tick records FPS, counts and tag
  totals — a handful of counter reads. This runs all the time so data is already
  there when you open the overlay.
- **Heavy capture is opt-in.** The expensive measurements — Babylon's CPU
  frame-time wrap and the GPU timer query — perturb the very frame they measure, so
  they switch on **only while the overlay is open or a benchmark is running**. On
  the server, continuous disk logging is gated behind `PERF_LOG=1`.

Source files:

| Area | File |
| --- | --- |
| Shared types + stats (percentiles, summaries) | [`packages/shared/src/perf.ts`](../packages/shared/src/perf.ts) |
| Client tracker (ring buffer, tags, benchmark, save) | [`packages/client/src/perf/PerfTracker.ts`](../packages/client/src/perf/PerfTracker.ts) |
| Babylon probes (engine/scene instrumentation) | [`packages/client/src/perf/babylonProbes.ts`](../packages/client/src/perf/babylonProbes.ts) |
| F3 overlay | [`packages/client/src/perf/overlay.ts`](../packages/client/src/perf/overlay.ts) |
| Server tracker (CPU/mem/tick, `/api/perf`, JSONL) | [`packages/server/src/systems/perf.ts`](../packages/server/src/systems/perf.ts) |
| Analyzer CLI | [`scripts/perf-analyze.mjs`](../scripts/perf-analyze.mjs) |

---

## 2. The in-game overlay (F3)

Press **F3** (or load the page with **`?perf`**) to toggle it. Opening it turns on
the heavy client captures; closing it turns them back off.

```
⚡ PERF · F3
🟢  fps  60   (1%low 54)
frame   4.20ms   gpu 2.10ms
heap    128 MB
draws 82  mesh 210  tris 150k
──────────────────────────────────
tags (avg/frame)
  scene.render      3.900
  game.update       0.620
  minimap           0.180
──────────────────────────────────
server  cpu 18%  tick 1.40ms
        rss 92MB  heap 41MB  lag 0.30ms
        players 1  enemies 24  ent 312
```

- **fps** colour: 🟢 ≥55 · 🟡 ≥30 · 🔴 <30. `1%low` is the worst recent frame — the
  number that captures stutter that an average hides.
- **frame / gpu** appear only while the overlay/benchmark is active. `gpu n/a` means
  the GPU timer-query extension isn't available on this browser/GPU (see Caveats).
- **heap** is Chromium-only (`performance.memory`); other browsers show `n/a`.
- **tags** are the loudest custom spans this second (see §3).
- **server** line is polled from `GET /api/perf` once a second.

Controls: type a **label** and click **● 10s** to record a benchmark; **Save log**
writes the ring buffer to `perf-logs/`; **Download** hands you the file directly;
**Clear** empties the in-memory ring.

### "What's heavy" — the breakdown + slowdown capture

Click **▸ What's heavy** to expand a ranked drill-down of what's consuming
resources, in three lists (each heaviest-first, with a proportional bar):

```
▾ What's heavy   ⚠ 2
Reasons — ms / frame
  scene.render      6.62 ms  ███████████
  game.update       0.63 ms  █
Elements — renderables
  triangles      3.1m tris   ███████████
  house:node0    1.7m tris   ██████
  draw calls     734 draws   ██
Entities — game objects
  trees          120         ███████████
  drops          66          ██████
  rocks          45          ████
⚠ Slowdowns (2)              save · clear
  🔴 33fps  14:21:07 · scene.render
  🟡 41fps  14:20:55 · game.update
```

- **Reasons** = the perf spans (the *why*: where frame time goes) — see §3.
- **Elements** = renderables: draw calls, triangles, particle systems, and the
  individual **heaviest meshes** (named by game `kind`, e.g. `house:node0`).
- **Entities** = game-object counts by category (reused from the `P` Activity
  Monitor's `game.debugStats()`).

**Automatic slowdown tracking.** The moment FPS drops below the slow threshold
(default **50**; set `__perf.slowFpsThreshold`), the tracker snapshots *why* —
the full breakdown at that instant — into a **Slowdowns** log, on the dip's onset
and every ~2 s while it persists. **This runs even with the overlay closed**, so a
stutter during real play is captured for you to inspect later; the **⚠ N** badge on
the expand button counts what's been captured (and reddens until you look). Each
entry records the dip FPS, the time, the single loudest `cause`, and the complete
reasons/elements/entities snapshot. **save** writes them to
`perf-logs/slowdowns-<ts>.json` (`__perf.saveSlowReport()`); **clear** resets the
log. Because tags are always-on, the captured reasons are populated whether or not
heavy capture was running.

### Going deeper: `scene.render` decomposed

A single `scene.render` span tells you the GPU-facing work is expensive but not
*why*. While heavy capture is on (overlay open / benchmark), the Babylon probes
break it into **sub-phases** — emitted as `render.*` reasons (ms), so they're logged,
benchmarked, and analyzed like any tag:

| Reason | What it times | If it's high… |
| --- | --- | --- |
| `render.shadows` | shadow maps + render targets | shrink the shadow map, cull casters, fewer/looser lights |
| `render.activeMeshEval` | frustum culling / active-mesh selection | too many meshes evaluated — freeze static meshes, merge, instance |
| `render.main` | the main forward pass | overdraw, material/shader cost, draw-call count |
| `render.animations` | skeletal + node animation eval | too many animated skeletons on screen |
| `render.particles` | particle systems | cap particle counts, pool/limit simultaneous FX |

Alongside, the render load is **attributed to each game-element kind** (by walking
the active meshes and grouping on `metadata.kind`), shown in the
**Scene render — by element** list and logged as `geo:<kind>` triangle tags
(`geo:house`, `geo:goblin`, `geo:tree`…). This answers *which element* is heavy to
draw — e.g. one `house` mesh at 1.6M triangles dominating the shadow pass.

> Real example from this game: `render.shadows ≈ 5–10 ms` and `render.activeMeshEval`
> with a p99 spike, traced to `geo:house = 1.66M tris` — the house geometry is the
> shadow-pass bottleneck.

**Render profile (deep snapshot).** Click **📷 save render profile** in the panel (or
`__perf.captureRenderProfile()`) to write a `render-profile-<ts>.json` pairing the
sub-phase timings with scene totals (draw calls, materials, textures), the full
per-kind load, and the 16 heaviest individual meshes — the "save the details for
later" artefact. Inspect it directly or with `jq`:
```bash
jq '.phases, .byCategory[:5], .totals' perf-logs/render-profile-*.json
```

---

## 3. Tagging any resource usage

The core idea: **wrap any work in a tag and it's measured, summarized, and stored**
alongside the frame/tick metrics — automatically appearing in the overlay, the
benchmark summary, and the JSONL `tags` field.

### Client — `window.__perf` (or the `perf` instance in `main.ts`)

```ts
// Time a synchronous section (ms accumulate under the tag, per frame):
perf.span("ai.flock", () => updateFlocking(dt));

// Manual start/stop when you can't wrap a single callback:
perf.begin("pathfind");
const path = computePath(a, b);
perf.end("pathfind");

// Count or accumulate a gauge (not a timer):
perf.add("bananasThrown");          // +1
perf.add("net.bytesIn", msg.length); // +N
```

The render loop already tags `game.update`, `minimap`, and `scene.render`
([main.ts](../packages/client/src/main.ts)). Add your own around anything you
suspect.

### Server — the `perfTracker` singleton

```ts
import { perfTracker } from "../systems/perf";

perfTracker.span("pathfinding", () => runAStar(state));
perfTracker.add("goblinsSpawned", n);
```

Every system in the simulation tick is already wrapped — `movement`, `combat`,
`goblinAi`, `separation`, `waves`, `spawners`, `resources`, `bananas`, `pickups`
([GameRoom.ts](../packages/server/src/rooms/GameRoom.ts)) — so a `tickMs` spike
traces straight to the system that caused it.

> Convention: a **span** tag is milliseconds; a **counter** tag is a raw count.
> Name counters distinctly (`*.count`, `*Spawned`, `*.bytes`) so you don't confuse
> the two when reading a summary.

---

## 4. Running a benchmark

A benchmark is a labelled capture window. It computes a per-metric summary
(min/avg/p50/p95/p99/max) for every metric **and every tag**, stamps the
environment (GPU, app version, or Node/OS), and writes a `bench-<label>-<ts>.json`
to `perf-logs/`. That JSON is the unit you diff before/after a change.

**Client (overlay):** type a label, click **● 10s**.

**Client (console):**
```js
await __perf.startBenchmark("siege-wave-8", 15000)   // 15s; auto-saved
```

**Server (console / REPL with the tracker in scope):**
```ts
await perfTracker.startBenchmark("siege-wave-8", 20000)
```

Pick a window that captures the scenario you care about (an idle field vs. a wave-8
siege are different benchmarks — label them so). Run the **same** scenario for
baseline and candidate.

---

## 5. Where the data lives & its format

Everything lands in **`perf-logs/`** at the repo root (gitignored). The client
writes there via a dev-only Vite endpoint (`POST /__perf/save`); in a production
build with no dev server, **Save** falls back to a browser download. The server
writes there directly when `PERF_LOG=1`.

| Artefact | Written by | Format |
| --- | --- | --- |
| `perf-log-<ts>.jsonl` | client **Save log** | one `ClientPerfSample` per line |
| `server-<stamp>.jsonl` | server, `PERF_LOG=1` | one `ServerPerfSample` per line |
| `bench-<label>-<ts>.json` | any benchmark | one `BenchmarkResult` object |
| `slowdowns-<ts>.json` | overlay **save** / `saveSlowReport()` | captured `SlowEvent[]` + env |
| `render-profile-<ts>.json` | 📷 button / `captureRenderProfile()` | sub-phase ms + per-kind load + heaviest meshes |

The types are the single source of truth — see
[`packages/shared/src/perf.ts`](../packages/shared/src/perf.ts).

**Client sample** (one JSONL line; `null` = unmeasurable on this platform):
```json
{"t":1717360000000,"fps":59.8,"frameMs":4.2,"gpuMs":2.1,"heapMB":128.4,
 "drawCalls":82,"activeMeshes":210,"triangles":150000,
 "tags":{"scene.render":3.9,"game.update":0.62}}
```

**Server sample** (one JSONL line):
```json
{"t":1717360000050,"tickMs":1.4,"cpuPct":18.2,"rssMB":92.1,"heapMB":41.3,
 "loopLagMs":0.3,"players":1,"enemies":24,"entities":312,
 "tags":{"movement":0.21,"combat":0.34,"goblinAi":0.55}}
```

**Benchmark result:**
```json
{"label":"siege-wave-8","src":"client","startedAt":1717360000000,"durationMs":15000,
 "sampleCount":890,"metrics":{"fps":{"count":890,"min":41,"avg":58.2,"p50":60,
 "p95":48,"p99":43,"max":62}, "tag:scene.render":{...}},
 "meta":{"gpu":"Apple M3","version":"1.2.0","gpuTimer":false}}
```

Because it's flat JSON, **anything** can read it:
```bash
# median fps straight from a JSONL log with jq
jq -s 'map(.fps) | sort | .[length/2|floor]' perf-logs/perf-log-*.jsonl
```

---

## 6. Analyzing — `pnpm perf`

The bundled analyzer ([scripts/perf-analyze.mjs](../scripts/perf-analyze.mjs)) needs
no dependencies and reads either a JSONL log or a benchmark JSON.

```bash
# Summarize one run (min/avg/p50/p95/p99/max for every metric + tag)
pnpm perf perf-logs/perf-log-1717360000000.jsonl

# Diff two runs — did the change help? (✓ improvement / ✗ regression)
pnpm perf perf-logs/baseline.jsonl perf-logs/candidate.jsonl

# Emit CSV for a spreadsheet / pandas
pnpm perf perf-logs/server-20260602-143012.jsonl --csv
```

The compare view knows fps is higher-is-better and everything else is
lower-is-better, so the ✓/✗ markers point you straight at real wins and
regressions:

```
  metric                    baseline   candidate      Δ avg        %
  ------------------------------------------------------------------
  fps                           60.0        52.2      -7.87   ✗ -13%
  frameMs                       10.0        11.6      +1.53   ✗ +15%
  tag:scene.render              8.46        9.93      +1.47   ✗ +17%
```

For deeper work, load the JSONL into pandas:
```python
import pandas as pd, json
df = pd.read_json("perf-logs/perf-log-...jsonl", lines=True)
print(df.fps.describe(percentiles=[.5,.95,.99]))
tags = pd.json_normalize(df.tags)         # one column per tag
```

---

## 7. The improvement workflow

The whole point: change things with evidence, not vibes.

1. **Reproduce a scenario** you can run identically twice (e.g. solo, stand at La
   Crypta through one full wave). Idle and siege are different — benchmark each.
2. **Baseline.** Open F3, label it `wave8-before`, click ● 10s. It's saved to
   `perf-logs/`.
3. **Read it.** `pnpm perf perf-logs/bench-wave8-before-*.json`. Note the worst
   metric and which `tag:*` dominates — that's your target.
4. **Change one thing.** Fewer draw calls? Cheaper shader? Throttle a system? Use
   the dominant tag to aim.
5. **Candidate.** Same scenario, label `wave8-after`, ● 10s.
6. **Diff.** `pnpm perf …before….json …after….json`. Keep the change only if the
   target metric improved without a worse regression elsewhere (watch p95/p99 and
   `1%low`, not just averages — stutter lives in the tail).
7. **Commit the result** (or paste the diff in the PR) so the win is on record.

### Where to look when a metric is bad

| Symptom | First suspects |
| --- | --- |
| Low **fps**, high **frameMs** (CPU-bound) | `tag:game.update`, per-entity work, GUI/DOM churn, too many `update()` loops |
| Low fps, **frameMs** low but **gpuMs** high (GPU-bound) | `drawCalls`, `triangles`, overdraw, shadow map size, particle counts, post-FX |
| Many **drawCalls** | un-instanced meshes; merge/instance/freeze static geometry |
| **heapMB** climbing over time | a leak — meshes/materials/particles/observers not disposed on entity removal |
| High server **tickMs** / **loopLagMs** | the loudest `tag:*` system (`combat`, `goblinAi`, `separation` scale with entity count) |
| Server **rssMB** climbing | un-cleared maps/state per session; check `onLeave` cleanup |

---

## 8. Metrics reference

### Client (per frame)

| Metric | Unit | How it's measured | Notes |
| --- | --- | --- | --- |
| `fps` | frames/s | `engine.getFps()` (smoothed) | always on |
| `frameMs` | ms | Babylon `SceneInstrumentation.frameTimeCounter` | heavy capture only |
| `gpuMs` | ms | `EngineInstrumentation.gpuFrameTimeCounter` | needs GPU timer ext; else `null` |
| `heapMB` | MB | `performance.memory.usedJSHeapSize` | Chromium only; else `null` |
| `drawCalls` | count | `SceneInstrumentation.drawCallsCounter` | always on |
| `activeMeshes` | count | `scene.getActiveMeshes().length` | meshes drawn this frame |
| `triangles` | count | `scene.getActiveIndices() / 3` | triangles submitted |
| `tag:*` | ms / count | your `perf.span` / `perf.add` | always on |

### Server (per tick, 20 Hz)

| Metric | Unit | How it's measured | Notes |
| --- | --- | --- | --- |
| `tickMs` | ms | wall time around the tick body | budget is 50 ms (20 Hz) |
| `cpuPct` | % | `process.cpuUsage()` delta / wall delta | per-core; can exceed 100 with threads |
| `rssMB` | MB | `process.memoryUsage().rss` | resident set size |
| `heapMB` | MB | `process.memoryUsage().heapUsed` | V8 heap |
| `loopLagMs` | ms | `perf_hooks.monitorEventLoopDelay()` mean | event-loop delay between ticks |
| `players` / `enemies` / `entities` | count | live state map sizes | load to read cost against |
| `tag:*` | ms / count | per-system spans | every system is wrapped |

---

## 9. Caveats (read these before trusting a number)

- **GPU frame time often isn't available.** It needs `EXT_disjoint_timer_query`,
  which many WebGL2/ANGLE backends (Metal on macOS, some D3D) don't expose — the
  overlay shows `gpu n/a` and `gpuMs` is `null` rather than a fake 0. FPS,
  `frameMs`, draw calls and triangles still tell you whether you're CPU- or
  GPU-bound.
- **`heapMB` is Chromium-only.** `performance.memory` is non-standard; Firefox/Safari
  report `null`. Use Chrome for memory work.
- **Heavy capture has overhead.** Wrapping render in timers (and especially the GPU
  query) costs a little. That's why it's off until you open the overlay — but it
  also means an open overlay slightly lowers the fps it reports. For a clean number,
  benchmark and read the file; don't eyeball the live overlay while profiling.
- **Server disk logging is opt-in.** Continuous JSONL only writes with `PERF_LOG=1`
  (set `PERF_LOG_DIR` to relocate it). `/api/perf` and benchmarks work regardless.
  `perf-logs/` is gitignored and grows over time — prune it.
- **CPU% is per-core.** A multi-threaded process can read >100%. Compare against
  itself across runs, not as an absolute.

---

## 10. Cheat sheet

```bash
# In-game
F3                      # toggle the overlay (or load with ?perf)
▸ What's heavy          # expand the elements/entities/reasons breakdown
●  10s button           # record + auto-save a benchmark

# Console (client)
__perf.startBenchmark("label", 10000)   # benchmark → perf-logs/
__perf.save("my-log.jsonl")             # dump the ring buffer
__perf.summary(5)                       # last 5s summary, in-memory
__perf.breakdown()                      # live {reasons, render, elements, entities}
__perf.slowdowns()                      # captured FPS-dip snapshots
__perf.saveSlowReport()                 # slowdowns → perf-logs/slowdowns-*.json
__perf.captureRenderProfile()           # deep render snapshot → render-profile-*.json
__perf.slowFpsThreshold = 55            # tune what counts as "slow"

# Server
PERF_LOG=1 pnpm dev:server              # continuous JSONL → perf-logs/
curl -s localhost:2567/api/perf | jq    # live snapshot

# Analyze
pnpm perf perf-logs/<file>              # summarize one run
pnpm perf <baseline> <candidate>        # diff two runs (✓/✗)
pnpm perf perf-logs/<file> --csv        # CSV for a spreadsheet
```

---

## 11. Continuous research

Performance is an ongoing effort, not a one-off. The repeatable **process**, the
**scenarios** we benchmark, the dated **findings**, and the prioritized
**optimization backlog** live in [performance-research.md](performance-research.md)
— the living journal. Profile, then log it there so the next change starts from
evidence. (Current headline from the latest baseline: the **shadow pass** dominates
the frame, rooted in a ~1.66 M-triangle house mesh — see the backlog.)
