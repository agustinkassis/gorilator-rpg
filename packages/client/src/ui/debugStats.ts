import type { Engine, Scene, AbstractMesh, BaseTexture } from "@babylonjs/core";
import { EngineInstrumentation, SceneInstrumentation } from "@babylonjs/core/Instrumentation";

export interface GameDebugStats {
  entities: number;
  players: number;
  potions: number;
  trees: number;
  logs: number;
  rocks: number;
  stones: number;
  bananas: number;
  items: number;
  houses: number;
  thrown: number;
  particleFx: number;
  collecting: number;
  lightnings: number;
}

type BrowserMemory = {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
};

type PerfWithMemory = Performance & { memory?: BrowserMemory };

interface FrameSample {
  dtMs: number;
  updateMs: number;
  renderMs: number;
}

interface TopMesh {
  name: string;
  vertices: number;
  indices: number;
}

const MB = 1024 * 1024;

export class DebugStats {
  private root: HTMLDivElement;
  private summary: HTMLDivElement;
  private activity: HTMLDivElement;
  private graphics: HTMLDivElement;
  private world: HTMLDivElement;
  private resources: HTMLDivElement;
  private topMeshes: HTMLDivElement;
  private sceneInstrumentation: SceneInstrumentation | null = null;
  private engineInstrumentation: EngineInstrumentation | null = null;
  private samples: FrameSample[] = [];
  private lastUpdate = 0;
  private visible = false;
  private gameStats: GameDebugStats | null = null;

  constructor(
    private engine: Engine,
    private scene: Scene,
  ) {
    this.root = document.createElement("div");
    this.root.id = "debugStats";
    this.root.style.cssText =
      "position:fixed;left:12px;top:12px;z-index:10000;display:none;width:min(430px,calc(100vw - 24px));" +
      "max-height:calc(100vh - 24px);overflow:auto;background:#070a0ee8;color:#d7f7ea;" +
      "border:1px solid #476b65;border-radius:8px;box-shadow:0 10px 32px #000b;" +
      "font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;backdrop-filter:blur(8px);";

    const header = document.createElement("div");
    header.style.cssText =
      "position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:8px;" +
      "padding:8px 10px;background:#0d151b;border-bottom:1px solid #24413f;";
    const title = document.createElement("div");
    title.textContent = "Activity Monitor";
    title.style.cssText = "font-weight:800;color:#ffffff;font-family:system-ui,sans-serif;font-size:13px;";
    const hint = document.createElement("div");
    hint.textContent = "P";
    hint.title = "Toggle debug stats";
    hint.style.cssText =
      "min-width:22px;text-align:center;padding:2px 6px;border:1px solid #476b65;border-radius:5px;color:#9fe0a0;";
    header.append(title, hint);

    this.summary = this.section();
    this.activity = this.section("Frame / CPU");
    this.graphics = this.section("Graphics");
    this.world = this.section("World Objects");
    this.resources = this.section("Memory / Resources");
    this.topMeshes = this.section("Largest Meshes");

    this.root.append(header, this.summary, this.activity, this.graphics, this.world, this.resources, this.topMeshes);
    document.body.appendChild(this.root);

    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key !== "p" && e.key !== "P") return;
      e.preventDefault();
      this.toggle();
    });
  }

  setScene(scene: Scene) {
    if (this.scene === scene) return;
    this.scene = scene;
    if (this.visible) {
      this.disableInstrumentation();
      this.enableInstrumentation();
    }
  }

  setGameStats(stats: GameDebugStats) {
    this.gameStats = stats;
  }

  beginFrame(): number {
    return performance.now();
  }

  endFrame(frameStartedAt: number, renderStartedAt: number) {
    if (!this.visible) return;
    const now = performance.now();
    this.samples.push({
      dtMs: this.engine.getDeltaTime(),
      updateMs: renderStartedAt - frameStartedAt,
      renderMs: now - renderStartedAt,
    });
    if (this.samples.length > 180) this.samples.shift();
    if (now - this.lastUpdate >= 250) {
      this.lastUpdate = now;
      this.render();
    }
  }

  private toggle() {
    this.visible ? this.hide() : this.show();
  }

  private show() {
    this.visible = true;
    this.root.style.display = "block";
    this.enableInstrumentation();
    this.render();
  }

  private hide() {
    this.visible = false;
    this.root.style.display = "none";
    this.samples.length = 0;
    this.disableInstrumentation();
  }

  private enableInstrumentation() {
    if (!this.sceneInstrumentation) {
      this.sceneInstrumentation = new SceneInstrumentation(this.scene);
      this.sceneInstrumentation.captureActiveMeshesEvaluationTime = true;
      this.sceneInstrumentation.captureAnimationsTime = true;
      this.sceneInstrumentation.captureCameraRenderTime = true;
      this.sceneInstrumentation.captureFrameTime = true;
      this.sceneInstrumentation.captureParticlesRenderTime = true;
      this.sceneInstrumentation.captureRenderTargetsRenderTime = true;
      this.sceneInstrumentation.captureRenderTime = true;
    }
    if (!this.engineInstrumentation) {
      this.engineInstrumentation = new EngineInstrumentation(this.engine);
      this.engineInstrumentation.captureShaderCompilationTime = true;
      try {
        this.engineInstrumentation.captureGPUFrameTime = true;
      } catch {
        // GPU timer queries are browser/GPU dependent; the rest of the monitor is still useful.
      }
    }
  }

  private disableInstrumentation() {
    this.sceneInstrumentation?.dispose();
    this.engineInstrumentation?.dispose();
    this.sceneInstrumentation = null;
    this.engineInstrumentation = null;
  }

  private render() {
    const fps = this.engine.getFps();
    const avgDt = this.average((s) => s.dtMs);
    const avgUpdate = this.average((s) => s.updateMs);
    const avgRender = this.average((s) => s.renderMs);
    const totalFrame = avgUpdate + avgRender;
    const cpuBudget = totalFrame > 0 ? (totalFrame / 16.67) * 100 : 0;

    this.summary.innerHTML =
      `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">` +
      this.metric("FPS", fps.toFixed(0), fps >= 50 ? "#9fe0a0" : fps >= 30 ? "#ffd36a" : "#ff847a") +
      this.metric("Frame", `${avgDt.toFixed(1)}ms`) +
      this.metric("CPU", `${cpuBudget.toFixed(0)}%`) +
      this.metric("Heap", this.heapLabel()) +
      `</div>`;

    const si = this.sceneInstrumentation;
    const ei = this.engineInstrumentation;
    this.activity.innerHTML = this.titled("Frame / CPU", this.rows([
      ["Client update", `${avgUpdate.toFixed(2)} ms`, this.share(avgUpdate, totalFrame)],
      ["Scene render", `${avgRender.toFixed(2)} ms`, this.share(avgRender, totalFrame)],
      ["Active mesh eval", this.ms(si?.activeMeshesEvaluationTimeCounter.current), this.share(si?.activeMeshesEvaluationTimeCounter.current ?? 0, totalFrame)],
      ["Animations", this.ms(si?.animationsTimeCounter.current), this.share(si?.animationsTimeCounter.current ?? 0, totalFrame)],
      ["Particles", this.ms(si?.particlesRenderTimeCounter.current), this.share(si?.particlesRenderTimeCounter.current ?? 0, totalFrame)],
      ["Render targets", this.ms(si?.renderTargetsRenderTimeCounter.current), this.share(si?.renderTargetsRenderTimeCounter.current ?? 0, totalFrame)],
      ["GPU frame", this.gpuMs(ei?.gpuFrameTimeCounter?.current), ""],
      ["Shader compile", this.ms(ei?.shaderCompilationTimeCounter.current), ""],
    ]));

    const activeMeshes = this.scene.getActiveMeshes().length;
    this.graphics.innerHTML = this.titled("Graphics", this.rows([
      ["Draw calls", String(si?.drawCallsCounter.current ?? 0), "batches submitted"],
      ["Meshes", `${activeMeshes} / ${this.scene.meshes.length}`, "active / total"],
      ["Vertices", this.compact(this.scene.totalVerticesPerfCounter.current), "visible"],
      ["Indices", this.compact(this.scene.totalActiveIndicesPerfCounter.current), "active"],
      ["Materials", String(this.scene.materials.length), "scene"],
      ["Textures", String(this.scene.textures.length), "scene"],
      ["Particle systems", String(this.scene.particleSystems.length), `${this.scene.activeParticlesPerfCounter.current} particles`],
      ["Animation groups", String(this.scene.animationGroups.length), this.scene.animationsEnabled ? "enabled" : "paused"],
    ]));

    const gs = this.gameStats;
    this.world.innerHTML = gs
      ? this.titled("World Objects", this.rows([
          ["Characters", String(gs.entities), `${gs.players} players`],
          ["Trees / rocks", `${gs.trees} / ${gs.rocks}`, "resource nodes"],
          ["Drops", String(gs.logs + gs.stones + gs.bananas + gs.potions + gs.items), `${gs.logs} log / ${gs.stones} stone / ${gs.bananas} banana / ${gs.potions} potion / ${gs.items} custom`],
          ["Houses", String(gs.houses), "tracked"],
          ["Thrown items", String(gs.thrown), "flight visuals"],
          ["Particle FX", String(gs.particleFx), "expiring systems"],
          ["Collect FX", String(gs.collecting), "magnet pickups"],
          ["Lightning FX", String(gs.lightnings), "active"],
        ]))
      : this.titled("World Objects", this.rows([["World", "n/a", "game stats not attached"]]));

    const textureBytes = this.estimateTextureBytes();
    this.resources.innerHTML = this.titled("Memory / Resources", this.rows([
      ["JS heap used", this.memoryValue("usedJSHeapSize"), this.memoryValue("totalJSHeapSize") + " allocated"],
      ["Heap limit", this.memoryValue("jsHeapSizeLimit"), "browser reported"],
      ["Texture estimate", textureBytes > 0 ? `${(textureBytes / MB).toFixed(1)} MB` : "n/a", "RGBA mip estimate"],
      ["Render size", `${this.engine.getRenderWidth()}x${this.engine.getRenderHeight()}`, `${this.engine.getHardwareScalingLevel().toFixed(2)} scale`],
      ["DPR", window.devicePixelRatio.toFixed(2), "display"],
    ]));

    this.topMeshes.innerHTML = this.titled("Largest Meshes", this.rows(
      this.largestMeshes().map((m) => [
        m.name,
        this.compact(m.vertices),
        `${this.compact(m.indices)} indices`,
      ]),
    ));
  }

  private section(title?: string): HTMLDivElement {
    const el = document.createElement("div");
    el.style.cssText = "padding:8px 10px;border-bottom:1px solid #17292a;";
    if (title) {
      const h = document.createElement("div");
      h.textContent = title;
      h.style.cssText = "margin-bottom:5px;color:#9fe0a0;font:700 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;";
      el.appendChild(h);
    }
    return el;
  }

  private metric(label: string, value: string, color = "#e6fff6") {
    return (
      `<div style="background:#101922;border:1px solid #203739;border-radius:6px;padding:6px;min-width:0;">` +
      `<div style="color:#89aaa4;font:10px system-ui,sans-serif;text-transform:uppercase;">${label}</div>` +
      `<div style="color:${color};font-size:17px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${value}</div>` +
      `</div>`
    );
  }

  private rows(rows: string[][]): string {
    return rows
      .map(
        ([name, value, note]) =>
          `<div style="display:grid;grid-template-columns:minmax(110px,1fr) auto minmax(78px,.75fr);gap:8px;align-items:center;padding:2px 0;">` +
          `<span style="color:#b5d5cf;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escape(name)}</span>` +
          `<strong style="color:#fff;text-align:right;white-space:nowrap;">${this.escape(value)}</strong>` +
          `<span style="color:#78938f;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escape(note)}</span>` +
          `</div>`,
      )
      .join("");
  }

  private titled(title: string, body: string): string {
    return (
      `<div style="margin-bottom:5px;color:#9fe0a0;font:700 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;">${this.escape(title)}</div>` +
      body
    );
  }

  private average(read: (sample: FrameSample) => number): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((sum, sample) => sum + read(sample), 0) / this.samples.length;
  }

  private share(value: number, total: number): string {
    return total > 0 ? `${Math.round((value / total) * 100)}%` : "";
  }

  private ms(value: number | undefined): string {
    return value === undefined ? "n/a" : `${value.toFixed(2)} ms`;
  }

  private gpuMs(value: number | undefined): string {
    if (value === undefined || value <= 0) return "n/a";
    return `${(value / 1_000_000).toFixed(2)} ms`;
  }

  private compact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(Math.round(value));
  }

  private heapLabel(): string {
    const memory = (performance as PerfWithMemory).memory;
    return memory?.usedJSHeapSize ? `${(memory.usedJSHeapSize / MB).toFixed(0)} MB` : "n/a";
  }

  private memoryValue(key: keyof BrowserMemory): string {
    const value = (performance as PerfWithMemory).memory?.[key];
    return value ? `${(value / MB).toFixed(1)} MB` : "n/a";
  }

  private estimateTextureBytes(): number {
    return this.scene.textures.reduce((sum, texture) => sum + this.textureBytes(texture), 0);
  }

  private textureBytes(texture: BaseTexture): number {
    const size = texture.getSize();
    if (!size.width || !size.height) return 0;
    return size.width * size.height * 4 * 1.33;
  }

  private largestMeshes(): TopMesh[] {
    return this.scene.meshes
      .filter((mesh) => mesh.isEnabled() && !mesh.isDisposed())
      .map((mesh) => ({
        name: this.meshName(mesh),
        vertices: mesh.getTotalVertices(),
        indices: mesh.getTotalIndices(),
      }))
      .filter((mesh) => mesh.vertices > 0 || mesh.indices > 0)
      .sort((a, b) => b.indices + b.vertices - (a.indices + a.vertices))
      .slice(0, 8);
  }

  private meshName(mesh: AbstractMesh): string {
    const md = mesh.metadata as { kind?: string; entityId?: string } | null;
    const prefix = md?.kind ? `${md.kind}:` : "";
    return `${prefix}${mesh.name || mesh.id}`.slice(0, 44);
  }

  private escape(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }
}
