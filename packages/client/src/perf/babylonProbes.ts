import {
  Engine,
  Scene,
  EngineInstrumentation,
  SceneInstrumentation,
} from "@babylonjs/core";
import type { PerfTracker } from "./PerfTracker";

export interface BabylonProbes {
  /** Toggle the EXPENSIVE captures (GPU timer query + CPU frame-time wrap). Off by
   *  default so always-on sampling doesn't perturb what it measures — the overlay
   *  and benchmarks turn it on for the duration they're active. */
  setHeavyCapture(on: boolean): void;
  /** Whether the GPU timer-query extension is available (else gpuMs stays null). */
  gpuSupported(): boolean;
  dispose(): void;
}

/**
 * Wire Babylon's engine + scene instrumentation into a {@link PerfTracker}: after
 * every rendered frame it reads FPS, draw calls, active meshes and triangles (all
 * cheap), plus — while heavy capture is on — the CPU frame time and GPU frame time,
 * then emits one sample.
 *
 * The GPU frame time needs `EXT_disjoint_timer_query`, which many WebGL2/ANGLE
 * (Metal/DX) backends don't expose; when absent, `gpuMs` is reported as null rather
 * than a misleading 0. See docs/performance.md for the caveats.
 */
export function attachBabylonProbes(
  engine: Engine,
  scene: Scene,
  perf: PerfTracker,
): BabylonProbes {
  const engineInstr = new EngineInstrumentation(engine);
  const sceneInstr = new SceneInstrumentation(scene);

  const gpuSupported = !!engine.getCaps().timerQuery;
  let heavy = false;

  const setHeavyCapture = (on: boolean) => {
    heavy = on;
    sceneInstr.captureFrameTime = on;
    engineInstr.captureGPUFrameTime = on && gpuSupported;
  };

  // Stamp the GPU/UA into the tracker meta so a benchmark records WHERE it ran
  // (the same scene at 60fps on an M3 vs an integrated GPU is a different result).
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

  const obs = scene.onAfterRenderObservable.add(() => {
    const gpuCounter = engineInstr.gpuFrameTimeCounter; // Nullable<PerfCounter>
    const gpuNs = heavy && gpuSupported && gpuCounter ? gpuCounter.current : 0;
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
    dispose() {
      scene.onAfterRenderObservable.remove(obs);
      sceneInstr.dispose();
      engineInstr.dispose();
    },
  };
}
