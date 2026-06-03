# Performance research & benchmarking log

Performance is a **first-class, ongoing concern** for Gorilator — a browser game with
a big world, shadows, particles, and a 16-player authoritative server. This document
is the **living research journal**: the repeatable benchmarking *process*, the
*scenarios* we measure, the dated *findings*, and the prioritized *optimization
backlog*. Append to it every time you profile.

It sits on top of the tooling in [performance.md](performance.md) (the F3 overlay,
the tags, `pnpm perf`, the render profile). Read that first for *how the tools work*;
this doc is *how we use them to make the game faster, over time*.

> **The loop:** reach a scenario → benchmark + render profile → record findings here
> → pick the top item from the backlog → change one thing → re-benchmark → diff →
> keep it if it won, log the result. Evidence, not vibes.

---

## 1. The benchmarking process

A run is only useful if it's **reproducible** and **recorded**. Every benchmark:

1. **Reach a known scenario** (§2). Same scenario for baseline and candidate — an
   idle field and a wave-8 siege are different benchmarks; label them so.
2. **Capture** (F3 overlay, or the console):
   - `__perf.startBenchmark("<scenario>-<before|after|note>", 10000)` (or the **● 10s**
     button) → a `bench-*.json` summary in `perf-logs/`.
   - **📷 save render profile** (or `__perf.captureRenderProfile()`) → a
     `render-profile-*.json` with the sub-phase timings + per-element load + heaviest
     meshes. Always grab one — it's the deepest single snapshot.
   - If a stutter occurred, the **Slowdowns** were auto-captured; **save** them.
   - For continuous frame data, **Save log** dumps the JSONL ring buffer.
3. **Analyze**: `pnpm perf perf-logs/<file>` for one run; `pnpm perf <baseline>
   <candidate>` to diff (✓ improvement / ✗ regression). `jq` the render profile for
   detail: `jq '.phases, .byCategory[:5], .totals' perf-logs/render-profile-*.json`.
4. **Record** an entry in §4 below (use the template in §6). Keep the artefacts —
   `perf-logs/` is gitignored, so name them clearly and they persist locally for
   diffing.

### Read the right number

`fps` is **display-capped** (60/120) and smoothed, so a "60" can hide a 35 ms frame.
Trust **`frameMs`** (CPU build time) and the **`render.*` sub-phases** for the truth;
use `p95`/`p99`/`max`, not just `avg` — stutter lives in the tail. `gpuMs` needs the
GPU timer-query extension (often absent on Metal/ANGLE) and real rAF frames to
resolve; when it's `null`, lean on `frameMs` + phase split to tell CPU- vs GPU-bound.

---

## 2. Standard scenarios

Measure the same situations each time so numbers are comparable across builds.

| ID | Scenario | How to reach it | Stresses |
| --- | --- | --- | --- |
| **S1** | **Early-game solo** | Join, stand near La Crypta, no wave yet | Static geometry, shadows, culling — the *baseline* |
| **S2** | **Mid-siege (≈wave 5)** | Play ~10 min, or dev-spawn goblins / force waves | Goblin AI, FX, draw calls, animations under load |
| **S3** | **Late-siege (≈wave 10)** | Survive to a high wave | Peak entity + particle count |
| **S4** | **Multiplayer (N clients)** | N browsers join one room | Server `tickMs`, `loopLagMs`, state-sync bandwidth |

For S2/S3 without waiting, use Dev Mode (`` ` ``) to spawn goblins / fast-forward
waves; note in the log that it was dev-forced (spawn distribution differs from a real
wave). S4 is measured server-side via `GET /api/perf` (run with `PERF_LOG=1`).

---

## 3. Current bottleneck picture (summary)

As of the **2026-06-03 baseline** (§4), in priority order:

1. **🔴 Shadow pass (`render.shadows`)** — ~16 ms average, spiking to **120–170 ms**.
   The single biggest cost by a wide margin. Driven by an enormous shadow caster.
2. **🟠 Active-mesh evaluation / culling (`render.activeMeshEval`)** — ~6 ms,
   p99 ~22 ms. 3,000+ meshes are frustum-evaluated every frame.
3. **🟡 Draw calls (≈1,800) & materials (≈155)** — driver overhead; cheap now
   (`render.main` ~1.5 ms) but scales badly with entity count.
4. **🔴 Root cause: the La Crypta house mesh is ~1.66 M triangles in one mesh** — it
   dominates both the shadow pass and the active triangle total.

The actual forward draw (`render.main`) is cheap — **this is a geometry/shadow
problem, not a shader/fill problem.**

---

## 4. Research log

Newest first. Each entry: date, build, scenario, machine, the numbers, the reading,
and any action taken.

### 2026-06-03 — Baseline (S1 early-game solo)

- **Build:** local `main` (v0.1.4-wip), client perf pipeline + deep render attribution.
- **Machine:** Apple **M4 Pro** (ANGLE Metal), DPR per display.
- **Method:** `__perf.startBenchmark("baseline-earlygame", 3000)` + render profile,
  in an isolated dev preview. ⚠️ Captured by pumping `scene.render()` in a
  background tab (rAF paused), so **`fps` is unreliable and `gpuMs`/`scene.render`
  spans are null** — but the instrumentation sub-phases, `geo:*` load, and scene
  totals are accurate. Artefacts: `perf-logs/bench-baseline-earlygame-*.json`,
  `perf-logs/render-profile-*.json`.

**Frame (ms):**

| metric | avg | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| `frameMs` | 35.1 | 47.3 | 243 | 275 |
| `render.shadows` | **16.5** | 24.9 | **123** | **172** |
| `render.activeMeshEval` | 6.07 | 7.0 | 22.0 | 28.3 |
| `render.main` | 1.53 | 4.8 | 9.8 | 11.7 |
| `render.animations` | 0.70 | 1.8 | 5.6 | 8.3 |
| `render.particles` | 0.06 | 0.2 | 0.45 | 0.5 |

**Scene totals:** draw calls **1,806** · active meshes 35 / **3,270 total** ·
active triangles **5.09 M** · materials **155** · textures 32 · particle systems 1.

**Render load by element (triangles):**

| kind | triangles | meshes |
| --- | --- | --- |
| **house** | **1,660,463** | 1 |
| prop | 35,453 | 1 |
| player | 6,204 | 4 |
| tree | 448 | 16 |
| rock | 20 | 1 |

**Reading:** Even *idle and alone*, the frame is **over budget** (35 ms avg ≈ 28 fps
of real CPU work, with 240 ms+ spikes). The shadow pass alone exceeds a 16.7 ms
frame. The cause is the **house mesh at 1.66 M triangles** being re-rendered into the
shadow map every frame; `render.main` (the visible draw) is trivial by comparison, so
this is geometry/shadow cost, not fill/shader cost. Culling 3,270 meshes adds ~6 ms.
Draw calls (1,806) are high for an early-game scene and will hurt more under siege.

**Actions:** none yet — this is the baseline. See the backlog (§5); start at **P0**.

> **Next run to do:** S2 mid-siege (≈wave 5) to capture goblin-AI animations, FX, and
> draw-call growth under load, and an **S4** server run (`PERF_LOG=1`) for `tickMs`.

---

## 5. Optimization backlog

Prioritized hypotheses. Pick the top open item, change **one thing**, re-benchmark
S1 (and S2 when reachable), diff, and log the result. Update **Status** as you go.

| # | Target | Hypothesis / action | Expected | Status |
| --- | --- | --- | --- | --- |
| P0 | **Shadow pass (16 ms)** | Give the house a **low-poly shadow-caster proxy** (or exclude it from the shadow map / bake a blob shadow). The 1.66 M-tri mesh shouldn't be a live shadow caster. | −10…15 ms frame | open |
| P0 | **House geometry (1.66 M tris)** | **Decimate / LOD** the house GLB (target <100 k). It's the root cause of both shadow + triangle cost. | huge | open |
| P1 | **Culling (6 ms)** | `freezeWorldMatrix()` static meshes + a **selection octree** (`scene.createOrUpdateSelectionOctree()`); cut total mesh count (3,270 is high). | −3…5 ms | open |
| P1 | **Draw calls (1,806)** | **Instance** repeated meshes (trees, rocks, goblins) and **merge** static props; share materials. | lower driver overhead, scales under siege | open |
| P2 | **Materials (155)** | Atlas / share materials to cut state changes in the main pass. | minor now, helps at scale | open |
| P2 | **Shadow map** | Shrink shadow-map resolution / tighten the frustum to the player; cache for static-only casters. | −shadow ms | open |
| P3 | **Spike source** | Investigate the 172 ms shadow / 275 ms frame spikes (shadow-map refresh? caster entering frustum?) via the Slowdowns capture. | kills stutter | open |

---

## 6. Log entry template

Copy this into §4 (newest first) for each profiling session:

```markdown
### YYYY-MM-DD — <title> (<scenario id>)

- **Build:** <branch / version / what changed>
- **Machine:** <CPU/GPU, DPR>
- **Method:** <overlay ● 10s | __perf.startBenchmark(...)>; artefacts: perf-logs/<files>

| metric | avg | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| frameMs | | | | |
| render.shadows | | | | |
| render.activeMeshEval | | | | |
| render.main | | | | |

**Totals:** draw calls · meshes · triangles · materials
**Reading:** <what the numbers say — CPU vs GPU, the dominant phase, the heavy kind>
**Action:** <backlog item attempted + before→after diff (`pnpm perf a b`) + keep/revert>
```

---

## 7. Tracking & cadence

- **Every render-affecting change** (new model, light, FX, shadow tweak, entity-count
  change): run **S1** before/after and `pnpm perf` diff. A regression in
  `render.*`/`frameMs` blocks the change unless justified.
- **Each milestone / wave-balance change:** run **S2** (and **S4** if multiplayer
  touched) and add a log entry.
- Keep the **baseline artefacts** in `perf-logs/` so any future build can be diffed
  against the same reference; when a P-item lands, record the new baseline.
- This doc is the source of truth for "what's slow and what we're doing about it" —
  keep §3 (summary) and §5 (backlog) current as findings change.
