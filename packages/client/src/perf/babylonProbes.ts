import {
  Engine,
  Scene,
  EngineInstrumentation,
  SceneInstrumentation,
} from "@babylonjs/core";
import type { PerfTracker } from "./PerfTracker";
import { renderLoadByCategory } from "./breakdown";

export interface BabylonProbes {
  /** Toggle the EXPENSIVE captures (CPU frame-time wrap, the scene-render sub-phase
   *  timers, GPU timer query, and per-kind geometry tags). Off by default so
   *  always-on sampling doesn't perturb what it measures — the overlay and
   *  benchmarks turn it on for the duration they're active. */
  setHeavyCapture(on: boolean): void;
  /** Whether the GPU timer-query extension is available (else gpuMs stays null). */
  gpuSupported(): boolean;
  /** The current scene-render sub-phase timings (ms) — empty unless heavy capture
   *  is on. Feeds the deep render profile. */
  renderPhases(): Record<string, number>;
  dispose(): void;
}

const GEO_RECOMPUTE_MS = 250; // re-scan meshes for per-kind geometry tags this often

type GpuTimingEngine = Engine & { getGPUFrameTimeCounter?: unknown };

/**
 * Wire Babylon's engine + scene instrumentation into a {@link PerfTracker}. Every
 * rendered frame it reads FPS, draw calls, active meshes and triangles (cheap), and
 * — while heavy capture is on — decomposes the frame:
 *
 *  - CPU + GPU frame time
 *  - the scene-render SUB-PHASES as `render.*` ms tags: where render time actually
 *    goes (shadows/render-targets, particles, animations, active-mesh culling, the
 *    main pass) — this is `scene.render` expanded into categories
 *  - the render load attributed to each game-element KIND as `geo:<kind>` triangle
 *    tags (goblin, tree, house…), so logs + benchmarks show what's heavy to draw
 *
 * GPU frame time needs `EXT_disjoint_timer_query`; when absent `gpuMs` is null
 * rather than a misleading 0. See docs/performance.md.
 */
export function attachBabylonProbes(
  engine: Engine,
  scene: Scene,
  perf: PerfTracker,
): BabylonProbes {
  const engineInstr = new EngineInstrumentation(engine);
  const sceneInstr = new SceneInstrumentation(scene);

  const gpuSupported =
    !!engine.getCaps().timerQuery &&
    typeof (engine as GpuTimingEngine).getGPUFrameTimeCounter === "function";
  let heavy = false;
  let lastGeoAt = 0;
  let geoCache: { kind: string; triangles: number }[] = [];

  const setHeavyCapture = (on: boolean) => {
    heavy = on;
    // Whole-frame + sub-phase timers (each wraps a render phase, so they're only on
    // while diagnosing). These decompose scene.render.
    sceneInstr.captureFrameTime = on;
    sceneInstr.captureRenderTime = on; // the main render pass
    sceneInstr.captureActiveMeshesEvaluationTime = on; // frustum culling / active selection
    sceneInstr.captureAnimationsTime = on; // skeletal + node animation eval
    sceneInstr.captureParticlesRenderTime = on; // particle systems
    sceneInstr.captureRenderTargetsRenderTime = on; // shadow maps + RTTs
    engineInstr.captureGPUFrameTime = on && gpuSupported;
    if (!on) {
      lastGeoAt = 0;
      geoCache = [];
    }
  };

  // Stamp the GPU/UA into the tracker meta so a benchmark records WHERE it ran.
  try {
    const gl = engine.getGlInfo();
    perf.meta = {
      ...perf.meta,
      version: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev",
      gpu: gl.renderer,
      gpuVendor: gl.vendor,
      gpuTimer: gpuSupported,
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
    };
  } catch {
    /* getGlInfo can throw on a lost context — meta is best-effort */
  }

  const renderPhases = (): Record<string, number> => {
    if (!heavy) return {};
    return {
      main: sceneInstr.renderTimeCounter.current,
      shadows: sceneInstr.renderTargetsRenderTimeCounter.current,
      particles: sceneInstr.particlesRenderTimeCounter.current,
      animations: sceneInstr.animationsTimeCounter.current,
      activeMeshEval: sceneInstr.activeMeshesEvaluationTimeCounter.current,
      frame: sceneInstr.frameTimeCounter.current,
    };
  };

  const obs = scene.onAfterRenderObservable.add(() => {
    let gpuNs = 0;
    if (heavy && gpuSupported) {
      try {
        const gpuCounter = engineInstr.gpuFrameTimeCounter; // Nullable<PerfCounter>
        gpuNs = gpuCounter ? gpuCounter.current : 0;
      } catch {
        gpuNs = 0;
      }
    }

    if (heavy) {
      // scene.render → its sub-phases (ms), as reasons/tags the log + benchmark keep.
      perf.add("render.main", sceneInstr.renderTimeCounter.current);
      perf.add("render.shadows", sceneInstr.renderTargetsRenderTimeCounter.current);
      perf.add("render.particles", sceneInstr.particlesRenderTimeCounter.current);
      perf.add("render.animations", sceneInstr.animationsTimeCounter.current);
      perf.add("render.activeMeshEval", sceneInstr.activeMeshesEvaluationTimeCounter.current);

      // Per-element render load (triangles by game kind), as `geo:<kind>` tags so a
      // benchmark/log shows which category is heaviest to draw over time. The mesh
      // scan is throttled; the cached values are emitted every frame.
      const now = performance.now();
      if (now - lastGeoAt >= GEO_RECOMPUTE_MS) {
        lastGeoAt = now;
        geoCache = renderLoadByCategory(scene).map((c) => ({ kind: c.kind, triangles: c.triangles }));
      }
      for (const c of geoCache) perf.add(`geo:${c.kind}`, c.triangles);
    }

    perf.setFrameMetrics({
      fps: engine.getFps(),
      frameMs: heavy ? sceneInstr.frameTimeCounter.current : null,
      gpuMs: gpuNs > 0 ? gpuNs / 1e6 : null, // ns → ms
      drawCalls: sceneInstr.drawCallsCounter.current,
      activeMeshes: scene.getActiveMeshes().length,
      triangles: Math.round(scene.getActiveIndices() / 3),
    });
    perf.tick();
  });

  return {
    setHeavyCapture,
    gpuSupported: () => gpuSupported,
    renderPhases,
    dispose() {
      scene.onAfterRenderObservable.remove(obs);
      sceneInstr.dispose();
      engineInstr.dispose();
    },
  };
}
