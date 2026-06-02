import {
  Engine,
  Scene,
  ArcRotateCamera,
  HemisphericLight,
  DirectionalLight,
  Vector3,
  Color3,
  Color4,
  MeshBuilder,
  StandardMaterial,
  SceneLoader,
  PBRMaterial,
  TransformNode,
  AnimationGroup,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

const MODEL_URL = "/models/knight.glb";
const DEG = (r: number) => `${Math.round((r * 180) / Math.PI)}°`;
const V = (v: Vector3) =>
  `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;

/**
 * Standalone 3D inspector for the player model. Toggle with the on-screen button
 * or the C key. Replicates the in-game rig (a `holder` TransformNode that yaws
 * the model, with the glTF `__root__` inside) so orientation behaves exactly like
 * the game. Drag to orbit the camera; the Yaw slider/buttons turn the model.
 *
 * Gizmos: WORLD axes are fixed at the origin; LOCAL axes are parented to the
 * model and rotate with it (X=red, Y=green/up, Z=blue/forward). If the green Y
 * stays vertical at every yaw, the model is upright (no tilt). The readout shows
 * the model's world-space forward(+Z) and up(+Y) live.
 */
export class CharacterDebugWindow {
  private panel: HTMLElement;
  private canvas: HTMLCanvasElement;
  private info: HTMLElement;
  private engine?: Engine;
  private scene?: Scene;
  private camera?: ArcRotateCamera;
  private holder?: TransformNode;
  private groups: AnimationGroup[] = [];
  private curAnim?: AnimationGroup;
  private animIdx = 0;
  private open = false;
  private started = false;
  private yaw = 0;

  constructor() {
    // No visible toolbar button (it cluttered gameplay) — this dev model inspector
    // is toggled with the B key instead (see the keydown handler below).
    const panel = document.createElement("div");
    panel.id = "charDebugPanel";
    panel.style.cssText =
      "position:fixed; right:16px; top:56px; width:440px; height:480px; z-index:50;" +
      "background:#10131af2; border:2px solid #c9a24a; border-radius:10px; display:none;" +
      "flex-direction:column; box-shadow:0 8px 30px #000a; font:12px monospace; color:#e8e8e8; overflow:hidden;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; background:#1c2230; border-bottom:1px solid #c9a24a;">
        <b style="color:#f0d27a;">Character Debug — drag to orbit</b>
        <button id="charDbgClose" style="cursor:pointer; background:#3a2230; color:#fff; border:1px solid #c9a24a; border-radius:4px; padding:2px 8px;">✕</button>
      </div>
      <canvas id="charDbgCanvas" style="width:100%; flex:1; min-height:0; display:block; background:#0b0e14; outline:none;"></canvas>
      <div id="charDbgInfo" style="padding:6px 10px; white-space:pre; line-height:1.45; background:#0d1017; border-top:1px solid #2a3242; font-size:11px;"></div>
      <div style="padding:6px 10px; display:flex; gap:6px; align-items:center; flex-wrap:wrap; border-top:1px solid #2a3242;">
        <span>Yaw</span>
        <input id="charDbgYaw" type="range" min="-180" max="180" value="0" step="1" style="flex:1; min-width:90px;">
        <span id="charDbgYawVal" style="width:38px; text-align:right;">0°</span>
        <button class="charDbgQ" data-yaw="0">N</button>
        <button class="charDbgQ" data-yaw="90">E</button>
        <button class="charDbgQ" data-yaw="180">S</button>
        <button class="charDbgQ" data-yaw="-90">W</button>
        <button id="charDbgAnim">▶ anim</button>
      </div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.canvas = panel.querySelector("#charDbgCanvas") as HTMLCanvasElement;
    this.info = panel.querySelector("#charDbgInfo") as HTMLElement;

    (panel.querySelector("#charDbgClose") as HTMLElement).onclick = () => this.toggle();
    const yawEl = panel.querySelector("#charDbgYaw") as HTMLInputElement;
    const yawVal = panel.querySelector("#charDbgYawVal") as HTMLElement;
    const setYaw = (deg: number) => {
      yawEl.value = String(deg);
      yawVal.textContent = `${deg}°`;
      this.yaw = (deg * Math.PI) / 180;
      if (this.holder) this.holder.rotation.y = this.yaw;
    };
    yawEl.oninput = () => setYaw(+yawEl.value);
    panel.querySelectorAll(".charDbgQ").forEach((b) => {
      (b as HTMLElement).onclick = () => setYaw(+(b as HTMLElement).dataset.yaw!);
    });
    (panel.querySelector("#charDbgAnim") as HTMLElement).onclick = () => this.cycleAnim();

    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "b" || e.key === "B") this.toggle();
    });
    window.addEventListener("resize", () => this.engine?.resize());
    (window as unknown as { __charDbg?: unknown }).__charDbg = this;
  }

  toggle() {
    this.open = !this.open;
    this.panel.style.display = this.open ? "flex" : "none";
    if (this.open && !this.started) {
      void this.start();
    } else if (this.open && this.engine) {
      this.engine.resize();
      this.engine.runRenderLoop(this.renderTick);
    } else if (!this.open) {
      this.engine?.stopRenderLoop(this.renderTick);
    }
  }

  private renderTick = () => {
    this.scene?.render();
    this.updateInfo();
  };

  private async start() {
    this.started = true;
    const engine = new Engine(this.canvas, true, { preserveDrawingBuffer: true });
    this.engine = engine;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.06, 0.09, 1);
    this.scene = scene;

    const cam = new ArcRotateCamera(
      "dbgCam",
      -Math.PI / 2,
      Math.PI / 2.6,
      5.5,
      new Vector3(0, 0.9, 0),
      scene,
    );
    cam.attachControl(this.canvas, true);
    cam.wheelPrecision = 25;
    cam.lowerRadiusLimit = 2;
    cam.upperRadiusLimit = 25;
    cam.minZ = 0.05;
    this.camera = cam;

    new HemisphericLight("dbgHemi", new Vector3(0, 1, 0), scene).intensity = 0.95;
    const dir = new DirectionalLight("dbgDir", new Vector3(-1, -2, -0.5), scene);
    dir.intensity = 1.0;

    // reference grid floor
    const ground = MeshBuilder.CreateGround("dbgGround", { width: 6, height: 6, subdivisions: 12 }, scene);
    const gm = new StandardMaterial("dbgGm", scene);
    gm.wireframe = true;
    gm.emissiveColor = new Color3(0.18, 0.3, 0.24);
    gm.disableLighting = true;
    ground.material = gm;

    this.axis(scene, new Vector3(2.2, 0, 0), new Color3(1, 0.25, 0.25), null); // world X red
    this.axis(scene, new Vector3(0, 2.2, 0), new Color3(0.3, 1, 0.3), null); // world Y green
    this.axis(scene, new Vector3(0, 0, 2.2), new Color3(0.35, 0.55, 1), null); // world Z blue

    const holder = new TransformNode("dbgHolder", scene);
    this.holder = holder;

    try {
      const res = await SceneLoader.ImportMeshAsync("", MODEL_URL, "", scene);
      res.meshes[0].parent = holder; // __root__ under the holder, like the game
      scene.materials.forEach((m) => {
        if (m instanceof PBRMaterial) {
          m.metallic = 0;
          m.roughness = 0.85;
          m.backFaceCulling = true; // see CharacterFactory: fixes back-hemisphere "inversion"
          m.twoSidedLighting = false;
        }
      });
      this.groups = res.animationGroups;
      res.animationGroups.forEach((g) => g.stop());
      const idle = res.animationGroups.find((g) => /idle/i.test(g.name));
      this.curAnim = idle ?? res.animationGroups[0];
      this.animIdx = Math.max(0, res.animationGroups.indexOf(this.curAnim!));
      this.curAnim?.start(true, 1, this.curAnim.from, this.curAnim.to, false);

      // Asymmetric bone markers so any mirror/flip is obvious:
      // R hand = red, L hand = blue, head = green, nose/front = yellow.
      const charMesh = res.meshes.find((m) => m.name === "char1");
      const skel = res.skeletons[0];
      if (charMesh && skel) {
        const mark = (boneName: string, color: Color3, size: number) => {
          const bone = skel.bones.find((b) => b.name === boneName);
          if (!bone) return;
          const s = MeshBuilder.CreateSphere("mk_" + boneName, { diameter: size }, scene);
          const m = new StandardMaterial("mkm_" + boneName, scene);
          m.emissiveColor = color;
          m.disableLighting = true;
          s.material = m;
          s.attachToBone(bone, charMesh);
        };
        mark("RightHand", new Color3(1, 0.15, 0.15), 0.22); // R = red
        mark("LeftHand", new Color3(0.25, 0.5, 1), 0.22); // L = blue
        mark("Head", new Color3(0.3, 1, 0.3), 0.16); // head = green
      }

      // local axes parented to the holder (rotate with the model)
      this.axis(scene, new Vector3(1.4, 0, 0), new Color3(1, 0.4, 0.4), holder);
      this.axis(scene, new Vector3(0, 1.9, 0), new Color3(0.5, 1, 0.5), holder);
      this.axis(scene, new Vector3(0, 0, 1.4), new Color3(0.5, 0.7, 1), holder);
    } catch (e) {
      this.info.textContent = "model load failed: " + (e as Error).message;
    }

    engine.runRenderLoop(this.renderTick);
  }

  private axis(scene: Scene, dir: Vector3, color: Color3, parent: TransformNode | null) {
    const line = MeshBuilder.CreateLines(
      "ax",
      { points: [Vector3.Zero(), dir] },
      scene,
    );
    line.color = color;
    line.isPickable = false;
    if (parent) line.parent = parent;
  }

  private cycleAnim() {
    if (!this.groups.length) return;
    this.curAnim?.stop();
    this.animIdx = (this.animIdx + 1) % this.groups.length;
    this.curAnim = this.groups[this.animIdx];
    this.curAnim.start(true, 1, this.curAnim.from, this.curAnim.to, false);
  }

  private updateInfo() {
    if (!this.camera || !this.holder) return;
    const fwd = this.holder.getDirection(new Vector3(0, 0, 1));
    const up = this.holder.getDirection(new Vector3(0, 1, 0));
    const tilt = Math.round((Math.acos(Math.min(1, Math.max(-1, up.y))) * 180) / Math.PI);
    this.info.textContent =
      `camera  α=${DEG(this.camera.alpha)}  β=${DEG(this.camera.beta)}  r=${this.camera.radius.toFixed(1)}\n` +
      `model   yaw=${DEG(this.holder.rotation.y)}   pos=(${V(this.holder.position)})\n` +
      `forward +Z = (${V(fwd)})\n` +
      `up      +Y = (${V(up)})   tilt-from-vertical=${tilt}°\n` +
      `anim: ${this.curAnim?.name ?? "-"}   ·   axes X=red Y=green(up) Z=blue(fwd)`;
  }
}
