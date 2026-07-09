import { Matrix, Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";

const DOM_SCOPES: Record<string, string> = {
  renderCanvas: "main/renderCanvas",
  splash: "ui/splash",
  splashTop: "ui/splash",
  assetLoad: "ui/splash.assetLoad",
  nostrHero: "ui/splash.nostrHero",
  nostrProgress: "ui/splash.nostrProgress",
  status: "main/status",
  versionTag: "main/versionTag",
  worktreePanel: "main/worktreePanel",
  worktreeTag: "main/worktreeTag",
  jsonEditorModal: "main/jsonEditor",
  playerBadge: "ui/playerBadge",
  vitalsGlobe: "ui/vitalsGlobe",
  healthGlobe: "ui/healthGlobe",
  hungerBar: "ui/hungerRing",
  staminaBar: "ui/staminaBar",
  xpBar: "ui/xpBar",
  xpLevelUp: "ui/xpBar.levelUp",
  invBtn: "ui/inventory.button",
  invPanel: "ui/inventory.panel",
  invGrid: "ui/inventory.grid",
  invCursor: "ui/inventory.cursor",
  hotkeyBar: "ui/hotkeyBar",
  topBar: "ui/topBar",
  hbBanner: "ui/topBar.defeatBanner",
  rpgMiniMap: "ui/minimap.corner",
  minimapOverlay: "ui/minimap.overlay",
  mmPlayers: "ui/minimap.players",
  mmTooltip: "ui/minimap.tooltip",
  chatDock: "ui/chat.dock",
  chatLog: "ui/chat.log",
  chatInput: "ui/chat.input",
  chatBackdrop: "ui/chat.backdrop",
  gameMenu: "ui/gameMenu",
  respawnOverlay: "ui/respawnOverlay",
  realmOverlay: "ui/realmOverlay",
};

let stylesInjected = false;

export class DeveloperLabels {
  private enabled = false;
  private domLayer: HTMLDivElement | null = null;
  private sceneLayer: HTMLDivElement | null = null;
  private frameId = 0;
  private sceneObserver: ReturnType<Scene["onAfterRenderObservable"]["add"]> | null = null;
  private domLabels = new Map<HTMLElement, HTMLDivElement>();
  private meshLabels = new Map<number, HTMLDivElement>();
  private domNames = new WeakMap<HTMLElement, string>();
  private meshNames = new WeakMap<AbstractMesh, string>();
  private baseCounts = new Map<string, number>();

  constructor(private scene: Scene) {}

  isEnabled() {
    return this.enabled;
  }

  setEnabled(on: boolean) {
    if (this.enabled === on) return;
    this.enabled = on;
    document.body.classList.toggle("devLabelsOn", on);
    if (on) {
      this.ensureLayers();
      this.syncDomLabels();
      this.syncSceneLabels();
      this.frameId = requestAnimationFrame(this.frame);
      this.sceneObserver = this.scene.onAfterRenderObservable.add(() => this.syncSceneLabels());
    } else {
      this.stop();
      this.clear();
    }
  }

  dispose() {
    this.enabled = false;
    document.body.classList.remove("devLabelsOn");
    this.stop();
    this.clear();
  }

  private frame = () => {
    if (!this.enabled) return;
    this.syncDomLabels();
    this.frameId = requestAnimationFrame(this.frame);
  };

  private stop() {
    if (this.frameId) cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    if (this.sceneObserver) this.scene.onAfterRenderObservable.remove(this.sceneObserver);
    this.sceneObserver = null;
  }

  private clear() {
    for (const label of this.domLabels.values()) label.remove();
    for (const label of this.meshLabels.values()) label.remove();
    this.domLabels.clear();
    this.meshLabels.clear();
    this.domLayer?.remove();
    this.sceneLayer?.remove();
    this.domLayer = null;
    this.sceneLayer = null;
  }

  private ensureLayers() {
    injectStyles();
    if (!this.domLayer) {
      this.domLayer = document.createElement("div");
      this.domLayer.className = "devLabelLayer devLabelDomLayer";
      this.domLayer.dataset.devLabelLayer = "dom";
      document.body.appendChild(this.domLayer);
    }
    if (!this.sceneLayer) {
      this.sceneLayer = document.createElement("div");
      this.sceneLayer.className = "devLabelLayer devLabelSceneLayer";
      this.sceneLayer.dataset.devLabelLayer = "scene";
      document.body.appendChild(this.sceneLayer);
    }
  }

  private syncDomLabels() {
    if (!this.domLayer) return;
    const active = new Set<HTMLElement>();
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      if (!this.shouldLabelElement(el)) continue;
      active.add(el);
      let label = this.domLabels.get(el);
      if (!label) {
        label = this.createLabel("dom");
        this.domLabels.set(el, label);
        this.domLayer.appendChild(label);
      }
      label.textContent = this.nameForElement(el);
      const rect = el.getBoundingClientRect();
      label.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
    }
    for (const [el, label] of this.domLabels) {
      if (active.has(el)) continue;
      label.remove();
      this.domLabels.delete(el);
    }
  }

  private syncSceneLabels() {
    if (!this.sceneLayer) return;
    const camera = this.scene.activeCamera;
    const canvas = this.scene.getEngine().getRenderingCanvas();
    if (!camera || !canvas) {
      this.clearSceneLabels();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const renderWidth = this.scene.getEngine().getRenderWidth();
    const renderHeight = this.scene.getEngine().getRenderHeight();
    const viewport = camera.viewport.toGlobal(renderWidth, renderHeight);
    const transform = this.scene.getTransformMatrix();
    const active = new Set<number>();

    for (const mesh of this.scene.meshes) {
      if (!this.shouldLabelMesh(mesh)) continue;
      const point = this.projectMesh(mesh, transform, viewport);
      if (!point || point.z < 0 || point.z > 1) continue;
      const x = rect.left + (point.x / renderWidth) * rect.width;
      const y = rect.top + (point.y / renderHeight) * rect.height;
      if (x < -40 || y < -20 || x > window.innerWidth + 40 || y > window.innerHeight + 20) continue;

      active.add(mesh.uniqueId);
      let label = this.meshLabels.get(mesh.uniqueId);
      if (!label) {
        label = this.createLabel("scene");
        this.meshLabels.set(mesh.uniqueId, label);
        this.sceneLayer.appendChild(label);
      }
      label.textContent = this.nameForMesh(mesh);
      label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    }

    for (const [id, label] of this.meshLabels) {
      if (active.has(id)) continue;
      label.remove();
      this.meshLabels.delete(id);
    }
  }

  private clearSceneLabels() {
    for (const label of this.meshLabels.values()) label.remove();
    this.meshLabels.clear();
  }

  private createLabel(kind: "dom" | "scene") {
    const label = document.createElement("div");
    label.className = `devLabel devLabel-${kind}`;
    return label;
  }

  private shouldLabelElement(el: HTMLElement) {
    if (el === document.body || el === document.documentElement) return false;
    if (el.closest("[data-dev-label-layer]")) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "link" || tag === "meta" || tag === "br") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return true;
  }

  private shouldLabelMesh(mesh: AbstractMesh) {
    if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0.01) return false;
    if (!mesh.getTotalVertices()) return false;
    return true;
  }

  private projectMesh(mesh: AbstractMesh, transform: Matrix, viewport: Parameters<typeof Vector3.Project>[3]) {
    try {
      const center = mesh.getBoundingInfo().boundingBox.centerWorld;
      return Vector3.Project(center, Matrix.Identity(), transform, viewport);
    } catch {
      return null;
    }
  }

  private nameForElement(el: HTMLElement) {
    const cached = this.domNames.get(el);
    if (cached) return cached;
    const explicit = clean(el.dataset.devLabel ?? "");
    const base = explicit || `${this.scopeForElement(el)}:${this.localElementName(el)}`;
    const name = this.uniqueName(base);
    this.domNames.set(el, name);
    return name;
  }

  private scopeForElement(el: HTMLElement) {
    let cur: HTMLElement | null = el;
    while (cur) {
      const explicit = clean(cur.dataset.devComponent ?? "");
      if (explicit) return explicit;
      if (cur.id && DOM_SCOPES[cur.id]) return DOM_SCOPES[cur.id];
      cur = cur.parentElement;
    }
    return "ui/dom";
  }

  private localElementName(el: HTMLElement) {
    if (el.id) return `#${el.id}`;
    const className = [...el.classList].find((name) => !name.startsWith("devLabel"));
    if (className) return `.${className}`;
    return el.tagName.toLowerCase();
  }

  private nameForMesh(mesh: AbstractMesh) {
    const cached = this.meshNames.get(mesh);
    if (cached) return cached;
    const metadata = mesh.metadata as { devLabel?: unknown } | null;
    const explicit = typeof metadata?.devLabel === "string" ? clean(metadata.devLabel) : "";
    const source = clean(mesh.name || mesh.id || mesh.getClassName());
    const name = explicit || `scene:${source || "mesh"}#${mesh.uniqueId}`;
    this.meshNames.set(mesh, name);
    return name;
  }

  private uniqueName(base: string) {
    const next = (this.baseCounts.get(base) ?? 0) + 1;
    this.baseCounts.set(base, next);
    return next === 1 ? base : `${base}[${next}]`;
  }
}

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .devLabelLayer {
      position: fixed;
      inset: 0;
      z-index: 100000;
      pointer-events: none;
      overflow: hidden;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .devLabel {
      position: fixed;
      left: 0;
      top: 0;
      padding: 1px 3px;
      border-radius: 3px;
      font-size: 9px;
      line-height: 1.15;
      white-space: nowrap;
      text-shadow: 0 1px 2px rgba(0,0,0,0.9);
      box-shadow: 0 1px 4px rgba(0,0,0,0.45);
      will-change: transform;
    }
    .devLabel-dom {
      border: 1px solid rgba(255,212,121,0.68);
      background: rgba(16,12,6,0.78);
      color: #ffe0a8;
    }
    .devLabel-scene {
      border: 1px solid rgba(139,240,170,0.72);
      background: rgba(5,18,10,0.78);
      color: #bff8ca;
    }
  `;
  document.head.appendChild(style);
}
