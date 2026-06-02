import { Scene, Mesh, PickingInfo, ArcRotateCamera } from "@babylonjs/core";
import { setCameraZoom, getCameraZoom } from "../scene/camera";
import { NetworkClient } from "../net/NetworkClient";
import { PropManager } from "./PropManager";
import { SelectionManager, Selectable } from "./Selection";
import { Inspector, Field, Action } from "./Inspector";
import { PropLibrary } from "./PropLibrary";
import { LibraryExplorer } from "./LibraryExplorer";
import { PropDef } from "../scene/props";
import type { CharacterManager } from "./CharacterManager";
import type { Game } from "../game/Game";

/**
 * Dev Mode: a master toggle (button, or the ` backtick key) that turns the live
 * game into a world editor. While active the local player is immortal and a
 * left-click selects any world object (imported prop or synced entity) instead of
 * issuing the normal move/attack — clicking bare ground still walks the player so
 * you can navigate. The Inspector shows the selection's properties.
 *
 * Editing/relocation/deletion + the model library are layered on in later phases;
 * this is the shell + selection + immortality.
 */
export class DevMode {
  active = false;
  private drag: Selectable | null = null; // object currently being dragged on the ground
  private lastDragSend = 0; // throttle clock for synced-entity drag moves
  private selection: SelectionManager;
  private inspector: Inspector;
  private library: PropLibrary;
  private explorer: LibraryExplorer;
  private btn: HTMLButtonElement;
  private addBtn: HTMLButtonElement;
  private entitiesBtn: HTMLButtonElement;
  private banner: HTMLElement;
  private timeBar: HTMLElement;
  private timeButtons: { scale: number; el: HTMLButtonElement }[] = [];
  private canvas: HTMLCanvasElement | null;
  private charManager: CharacterManager | null = null; // wired post-construction (main.ts)
  private game: Game | null = null; // wired post-construction (main.ts) — for focus + nodeFor

  /** Wire in placed-character management so they're selectable/draggable/deletable. */
  setCharacterManager(cm: CharacterManager) {
    this.charManager = cm;
  }

  /** Wire in the Game so the library explorer can select + camera-focus entities. */
  setGame(g: Game) {
    this.game = g;
  }

  /** Library-explorer hook: select + highlight an entity by (kind,id), open its
   *  inspector, and pan/hold the camera on it. Resolves props/characters via their
   *  managers and synced entities via Game. Returns true if the entity was found. */
  focusEntity(kind: string, id: string): boolean {
    let sel: Selectable | null = null;
    if (kind === "prop") {
      const p = this.propManager.get(id);
      if (p) sel = { kind: "prop", id, root: p.loaded.root, meshes: p.loaded.meshes };
    } else if (kind === "character") {
      const c = this.charManager?.get(id);
      if (c) sel = { kind: "character", id, root: c.built.root, meshes: c.built.meshes };
    } else {
      const n = this.game?.nodeFor(kind, id);
      if (n) sel = { kind, id, root: n.root, meshes: n.meshes };
    }
    if (!sel) return false;
    this.drag = null; // focusing is not a drag
    this.selection.select(sel);
    this.showSelection(sel);
    this.game?.focusOn(sel.root.position.x, sel.root.position.z);
    return true;
  }

  /** Pan/hold the camera on a bare world point (for static structures like crates
   *  that have no selectable mesh); clears any current selection. */
  focusPos(x: number, z: number) {
    this.selectNone();
    this.game?.focusOn(x, z);
  }

  /** Release the camera so it resumes following the local player. */
  clearFocus() {
    this.game?.clearFocus();
  }

  /** Resolve a picked mesh to any selectable — props/synced entities, or a placed
   *  custom character. */
  private resolveSel(mesh: Parameters<SelectionManager["resolve"]>[0]): Selectable | null {
    const s = this.selection.resolve(mesh);
    if (s) return s;
    const c = this.charManager?.resolve(mesh);
    if (c) return { kind: "character", id: c.placement.id, root: c.built.root, meshes: c.built.meshes };
    return null;
  }

  constructor(
    private scene: Scene,
    private ground: Mesh,
    private net: NetworkClient,
    private propManager: PropManager,
  ) {
    this.selection = new SelectionManager(scene, propManager);
    this.inspector = new Inspector();
    this.library = new PropLibrary({
      onPlace: (model, name) => void this.addFromModel(model, name),
      onUpload: (file, name) => void this.uploadModel(file, name),
    });
    this.canvas = scene.getEngine().getRenderingCanvas();

    const btn = document.createElement("button");
    btn.id = "devModeBtn";
    btn.textContent = "🛠 Dev Mode (`)";
    btn.style.cssText =
      "position:fixed; right:16px; bottom:204px; z-index:40; cursor:pointer;" +
      "background:#2a3242; color:#9fe0a0; border:1px solid #4a9a52; border-radius:6px;" +
      "padding:6px 10px; font:12px system-ui,sans-serif;";
    btn.onclick = () => this.toggle();
    document.body.appendChild(btn);
    this.btn = btn;

    // "Add model" opens the library; only shown while editing.
    const addBtn = document.createElement("button");
    addBtn.id = "devAddModelBtn";
    addBtn.textContent = "＋ Add model";
    addBtn.style.cssText =
      "position:fixed; right:16px; bottom:240px; z-index:40; cursor:pointer; display:none;" +
      "background:#283; color:#fff; border:1px solid #4a9a52; border-radius:6px;" +
      "padding:6px 10px; font:12px system-ui,sans-serif;";
    addBtn.onclick = () => this.library.toggle();
    document.body.appendChild(addBtn);
    this.addBtn = addBtn;

    // "Entities" opens the library explorer: browse + camera-focus every world entity.
    const entitiesBtn = document.createElement("button");
    entitiesBtn.id = "devEntitiesBtn";
    entitiesBtn.textContent = "🗂 Entities";
    entitiesBtn.style.cssText =
      "position:fixed; right:16px; bottom:312px; z-index:40; cursor:pointer; display:none;" +
      "background:#2a3242; color:#9fe0a0; border:1px solid #4a9a52; border-radius:6px;" +
      "padding:6px 10px; font:12px system-ui,sans-serif;";
    entitiesBtn.onclick = () => this.explorer.toggle();
    document.body.appendChild(entitiesBtn);
    this.entitiesBtn = entitiesBtn;

    this.explorer = new LibraryExplorer({
      net: this.net,
      propManager: this.propManager,
      focusEntity: (kind, id) => this.focusEntity(kind, id),
      focusPos: (x, z) => this.focusPos(x, z),
      clearFocus: () => this.clearFocus(),
    });

    const banner = document.createElement("div");
    banner.id = "devModeBanner";
    banner.textContent = "DEV MODE — immortal · click to select";
    banner.style.cssText =
      "position:fixed; top:8px; left:50%; transform:translateX(-50%); z-index:60; display:none;" +
      "background:#2a7a32e0; color:#eafaea; border:1px solid #9fe0a0; border-radius:6px;" +
      "padding:4px 12px; font:bold 12px system-ui,sans-serif; letter-spacing:0.5px; pointer-events:none;";
    document.body.appendChild(banner);
    this.banner = banner;

    // Time control: pause / set game speed (scales the whole authoritative sim).
    const bar = document.createElement("div");
    bar.id = "devTimeBar";
    bar.style.cssText =
      "position:fixed; top:36px; left:50%; transform:translateX(-50%); z-index:60; display:none; gap:4px;" +
      "background:#10131ae8; border:1px solid #4a9a52; border-radius:8px; padding:4px 6px; box-shadow:0 4px 16px #0008;";
    const SPEEDS: { label: string; scale: number }[] = [
      { label: "⏸", scale: 0 },
      { label: "0.5×", scale: 0.5 },
      { label: "1×", scale: 1 },
      { label: "2×", scale: 2 },
      { label: "4×", scale: 4 },
    ];
    this.timeButtons = SPEEDS.map((s) => {
      const b = document.createElement("button");
      b.textContent = s.label;
      b.title = s.scale === 0 ? "Pause" : `${s.scale}× speed`;
      b.style.cssText =
        "cursor:pointer; min-width:34px; background:#2a3242; color:#cfe; border:1px solid #3a4658;" +
        "border-radius:5px; padding:3px 7px; font:12px system-ui,sans-serif;";
      b.onclick = () => this.setScale(s.scale);
      bar.appendChild(b);
      return { scale: s.scale, el: b };
    });
    document.body.appendChild(bar);
    this.timeBar = bar;

    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "`" || e.key === "~") this.toggle();
      else if (e.key === "Escape" && this.active) this.selectNone();
      else if ((e.key === "p" || e.key === "P") && this.active) this.togglePause();
      else if ((e.key === "Backspace" || e.key === "Delete") && this.active && this.selection.selected) {
        e.preventDefault(); // Backspace would otherwise navigate "back"
        this.deleteSelection();
      }
    });

    // Dev Mode only: scroll to zoom the camera out (up to 6×) to survey the map.
    this.canvas?.addEventListener(
      "wheel",
      (e) => {
        if (!this.active) return;
        const cam = this.scene.activeCamera as ArcRotateCamera | null;
        if (!cam) return;
        e.preventDefault();
        const step = e.deltaY > 0 ? 1.15 : 1 / 1.15; // down = out, up = in
        setCameraZoom(cam, getCameraZoom() * step);
      },
      { passive: false },
    );
  }

  toggle() {
    this.active ? this.exit() : this.enter();
  }

  private enter() {
    this.active = true;
    this.net.sendGodMode(true);
    this.propManager.setPickable(true);
    this.charManager?.setPickable(true);
    this.game?.setHousePickable(true); // the house is selectable only while editing
    void this.loadSpawners(); // reflect existing spawners in object inspectors
    void this.loadDrops(); // reflect existing tree/rock drop configs
    void this.loadStructures(); // reflect existing structure loot tables
    this.btn.style.background = "#3a7a40";
    this.btn.style.color = "#fff";
    this.addBtn.style.display = "block";
    this.entitiesBtn.style.display = "block";
    this.banner.style.display = "block";
    this.timeBar.style.display = "flex";
    this.reflectScale(this.net.room?.state.timeScale ?? 1); // show current speed, don't change it
    this.inspector.show();
    this.selectNone();
  }

  private exit() {
    this.active = false;
    this.net.sendGodMode(false);
    this.net.sendDevTime(1); // resume normal speed — never leave the game paused for everyone
    this.propManager.setPickable(false);
    this.charManager?.setPickable(false);
    this.game?.setHousePickable(false); // back to click-through in normal play
    this.selection.clear();
    this.btn.style.background = "#2a3242";
    this.btn.style.color = "#9fe0a0";
    this.addBtn.style.display = "none";
    this.entitiesBtn.style.display = "none";
    this.banner.style.display = "none";
    this.timeBar.style.display = "none";
    this.library.close();
    this.explorer?.close();
    this.clearFocus(); // release the camera back to the player
    const cam = this.scene.activeCamera as ArcRotateCamera | null;
    if (cam) setCameraZoom(cam, 1); // back to the normal play zoom
    this.inspector.hide();
    this.setCursor("default");
  }

  /** Pause ⇄ resume (1×). */
  private togglePause() {
    this.setScale((this.net.room?.state.timeScale ?? 1) > 0 ? 0 : 1);
  }

  /** Set the authoritative game speed (0 = paused) and reflect it in the UI. */
  private setScale(scale: number) {
    this.net.sendDevTime(scale);
    this.reflectScale(scale);
  }

  /** Update the speed buttons + banner to show the active scale (no network send). */
  private reflectScale(scale: number) {
    for (const b of this.timeButtons) {
      const active = b.scale === scale;
      b.el.style.background = active ? "#3a7a40" : "#2a3242";
      b.el.style.color = active ? "#fff" : "#cfe";
    }
    this.banner.textContent =
      scale === 0 ? "DEV MODE — ⏸ PAUSED · click to select" : `DEV MODE — ${scale}× · immortal · click to select`;
  }

  // ---- adding props (library + upload) ----

  /** The local player's position (place new props at the player), or origin. */
  private playerPos(): { x: number; z: number } {
    const r = this.net.room;
    const me = r
      ? (r.state.players.get(r.sessionId) as { x?: number; z?: number; rotY?: number } | undefined)
      : undefined;
    if (!me) return { x: 0, z: 0 };
    return frontOfPlayer({ x: me.x ?? 0, z: me.z ?? 0, rotY: me.rotY });
  }

  /** Place an existing model into the world (persist + select for editing). */
  private async addFromModel(model: string, name: string) {
    const pos = this.playerPos();
    const meta = { model, name, x: pos.x, z: pos.z, scale: 5, rotationY: 0, collisionRadius: 0 };
    try {
      const res = await fetch("/__props/place", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(meta),
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json();
      await this.spawnAndSelect({ id: out.id, name: out.name, model: out.model, x: pos.x, z: pos.z, scale: 5, rotationY: 0 });
      this.library.setStatus(`✓ placed "${out.name}" — drag to position, edit at right`);
    } catch (e) {
      this.library.setStatus("place failed: " + (e as Error).message);
    }
  }

  /** Upload a new .glb, place it at the player, persist + select it. */
  private async uploadModel(file: File, name: string) {
    const pos = this.playerPos();
    const meta = { name, x: pos.x, z: pos.z, scale: 5, rotationY: 0, collisionRadius: 0 };
    try {
      const res = await fetch(`/__props/add?meta=${encodeURIComponent(JSON.stringify(meta))}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json();
      await this.spawnAndSelect({ id: out.id, name: out.name, model: out.model, x: pos.x, z: pos.z, scale: 5, rotationY: 0 });
      this.library.setStatus(`✓ imported "${out.name}" — drag to position, edit at right`);
    } catch (e) {
      this.library.setStatus("import failed: " + (e as Error).message);
    }
  }

  /** Load a freshly-added prop into the world, select it, and drop straight into
   *  positioning — the model follows the cursor (reusing the drag-to-move), and a
   *  click commits it where it lands. */
  private async spawnAndSelect(def: PropDef) {
    const placed = await this.propManager.place(def);
    this.propManager.setPickable(true); // keep the new prop selectable while editing
    const sel: Selectable = { kind: "prop", id: placed.id, root: placed.loaded.root, meshes: placed.loaded.meshes };
    this.selection.select(sel);
    this.showSelection(sel);
    this.library.close(); // clear the panel so the cursor can position on the canvas
    this.drag = sel; // arm the follow-drag; the next mouse-move relocates it, a click drops it
    this.setCursor("grabbing");
  }

  private selectNone() {
    this.drag = null; // cancel any in-progress placement/follow-drag
    this.selection.select(null);
    this.inspector.setSelection(null);
  }

  /** Delete the current selection (Backspace/Delete or the inspector button).
   *  Props drop from the manifest + their file; synced entities are removed
   *  server-side. Inspect-only kinds (rock/player/house) are left untouched. */
  private deleteSelection() {
    const sel = this.selection.selected;
    if (!sel) return;
    if (sel.kind === "prop") {
      void this.propManager.persistDelete(sel.id);
      this.selectNone();
    } else if (sel.kind === "tree" || sel.kind === "enemy" || sel.kind === "potion") {
      this.net.sendDevDelete(sel.kind, sel.id);
      this.selectNone();
    } else if (sel.kind === "character") {
      void this.charManager?.remove(sel.id);
      this.selectNone();
    }
  }

  // ---- pointer hooks, called by ClickToMove before its gameplay logic ----

  /** True while Dev Mode owns the pointer (ClickToMove should defer to us). */
  isActive = () => this.active;

  /** Left-click: select the object under the cursor (and begin dragging it), or
   *  walk to bare ground. Returns true to consume the event (always, while active). */
  pointerDown = (pick: PickingInfo | null): boolean => {
    if (!this.active) return false;
    // A drag in progress without a held button = a just-placed model following the
    // cursor; a click commits (drops) it wherever it currently sits.
    if (this.drag) {
      this.endDrag();
      return true;
    }
    const sel = this.resolveSel(pick?.pickedMesh ?? null);
    if (sel) {
      this.selection.select(sel);
      this.showSelection(sel);
      // grab draggable objects so the next pointer-moves relocate them
      this.drag = draggable(sel.kind) ? sel : null;
      if (this.drag) this.setCursor("grabbing");
      return true;
    }
    // bare ground (or nothing actionable): deselect, but keep navigation working
    this.selectNone();
    if (pick?.hit && pick.pickedMesh === this.ground && pick.pickedPoint) {
      this.clearFocus(); // walking again → camera resumes following the player
      this.net.sendMove(pick.pickedPoint.x, pick.pickedPoint.z);
    }
    return true;
  };

  /** Hover: themed cursor; while dragging, relocate the grabbed object across the
   *  ground plane (props move + persist locally, synced entities send throttled moves). */
  pointerMove = (pick: PickingInfo | null): boolean => {
    if (!this.active) return false;
    if (this.drag) {
      const g = this.groundPoint();
      if (g) this.dragTo(this.drag, g.x, g.z);
      this.setCursor("grabbing");
      return true;
    }
    const sel = this.resolveSel(pick?.pickedMesh ?? null);
    this.setCursor(sel ? "grab" : "default");
    return true;
  };

  /** Release ends a button-held drag. */
  pointerUp = () => {
    this.endDrag();
  };

  /** Commit the current drag/placement: persist the prop (or send the authoritative
   *  move for a synced entity) at its dropped position, then refresh the inspector. */
  private endDrag() {
    const sel = this.drag;
    this.drag = null;
    if (!sel) return;
    if (sel.kind === "prop") {
      void this.propManager.persistUpdate(sel.id);
    } else if (sel.kind === "character") {
      void this.charManager?.persist(sel.id);
    } else {
      const o = this.entityObj(sel.kind, sel.id);
      if (o?.x !== undefined && o?.z !== undefined) this.net.sendDevMove(sel.kind, sel.id, o.x, o.z);
    }
    this.showSelection(sel); // refresh the x/z fields to the dropped position
    this.setCursor("grab");
  }

  /** The world point on the ground under the cursor (ignores other meshes). */
  private groundPoint(): { x: number; z: number } | null {
    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m === this.ground);
    return pick?.hit && pick.pickedPoint ? { x: pick.pickedPoint.x, z: pick.pickedPoint.z } : null;
  }

  /** Move the dragged object to a ground point (per-kind: prop vs synced). */
  private dragTo(sel: Selectable, px: number, pz: number) {
    if (sel.kind === "prop") {
      const placed = this.propManager.get(sel.id);
      if (!placed) return;
      placed.def.x = round(px);
      placed.def.z = round(pz);
      this.propManager.applyDef(sel.id);
      this.schedulePersist(sel.id);
    } else if (sel.kind === "character") {
      this.charManager?.move(sel.id, round(px), round(pz)); // live; persisted on release
    } else {
      const now = performance.now();
      if (now - this.lastDragSend < 80) return; // throttle server moves
      this.lastDragSend = now;
      this.net.sendDevMove(sel.kind, sel.id, px, pz);
    }
  }

  private setCursor(c: string) {
    if (this.canvas) this.canvas.style.cursor = c;
  }

  /** Render the selection's properties + editing controls. Props edit locally and
   *  persist to props.json; synced entities send authoritative edits to the server
   *  (which sync back to every client; rocks also refresh pathfinding collision).
   *  Players/house are inspect-only for now. */
  private showSelection(sel: Selectable) {
    const persist = () => this.schedulePersist(sel.id);
    let fields: Field[] = [];
    let actions: Action[] = [];

    if (sel.kind === "prop") {
      const placed = this.propManager.get(sel.id);
      if (!placed) return;
      const d = placed.def;
      const reapply = () => this.propManager.applyDef(sel.id);
      fields = [
        { kind: "text", label: "name", value: d.name, onChange: (v) => { d.name = v || "prop"; persist(); } },
        { kind: "number", label: "x", value: round(d.x), step: 0.5, onChange: (v) => { d.x = v; reapply(); persist(); } },
        { kind: "number", label: "z", value: round(d.z), step: 0.5, onChange: (v) => { d.z = v; reapply(); persist(); } },
        { kind: "range", label: "scale", value: d.scale, min: 0.5, max: 40, step: 0.5, onChange: (v) => { d.scale = v; if ((d.collisionRadius ?? 0) > 0) d.collisionRadius = +(v / 2).toFixed(2); reapply(); persist(); } },
        { kind: "range", label: "rot°", value: deg(d.rotationY), min: 0, max: 360, step: 1, onChange: (v) => { d.rotationY = (v * Math.PI) / 180; reapply(); persist(); } },
        { kind: "checkbox", label: "concrete", value: (d.collisionRadius ?? 0) > 0, onChange: (on) => { d.collisionRadius = on ? +(d.scale / 2).toFixed(2) : 0; void this.propManager.persistUpdate(sel.id); } },
      ];
      actions = [{ label: "Delete", danger: true, onClick: () => this.deleteSelection() }];
    } else if (sel.kind === "character") {
      const cm = this.charManager;
      const c = cm?.get(sel.id);
      const px = round(c?.placement.x ?? sel.root.position.x);
      const pz = round(c?.placement.z ?? sel.root.position.z);
      fields = [
        { kind: "readonly", label: "name", value: c?.def.name ?? sel.id },
        { kind: "number", label: "x", value: px, step: 0.5, onChange: (v) => { cm?.move(sel.id, v, cm?.get(sel.id)?.placement.z ?? pz); void cm?.persist(sel.id); } },
        { kind: "number", label: "z", value: pz, step: 0.5, onChange: (v) => { cm?.move(sel.id, cm?.get(sel.id)?.placement.x ?? px, v); void cm?.persist(sel.id); } },
        { kind: "range", label: "rot°", value: deg(c?.placement.rotationY ?? 0), min: 0, max: 360, step: 1, onChange: (v) => { cm?.setRotation(sel.id, (v * Math.PI) / 180); void cm?.persist(sel.id); } },
      ];
      actions = [{ label: "Delete", danger: true, onClick: () => this.deleteSelection() }];
    } else if (sel.kind === "tree" || sel.kind === "enemy" || sel.kind === "rock") {
      const obj = this.entityObj(sel.kind, sel.id);
      const x = obj?.x ?? sel.root.position.x;
      const z = obj?.z ?? sel.root.position.z;
      fields = [
        { kind: "number", label: "x", value: round(x), step: 0.5, onChange: (v) => this.net.sendDevMove(sel.kind, sel.id, v, this.entityObj(sel.kind, sel.id)?.z ?? z) },
        { kind: "number", label: "z", value: round(z), step: 0.5, onChange: (v) => this.net.sendDevMove(sel.kind, sel.id, this.entityObj(sel.kind, sel.id)?.x ?? x, v) },
      ];
      if (sel.kind === "tree") {
        // HP is owned per-kind by the Drops "total HP" control (applies to every tree),
        // so no per-instance maxHp here — just the alive/stump toggle.
        fields.push({ kind: "checkbox", label: "alive", value: !!obj?.alive, onChange: (on) => this.net.sendDevSet("tree", sel.id, "alive", on) });
      }
      if (sel.kind === "enemy" && obj?.maxHp !== undefined) {
        fields.push({ kind: "number", label: "maxHp", value: obj.maxHp, min: 1, step: 10, onChange: (v) => this.net.sendDevSet("enemy", sel.id, "maxHp", v) });
      }
      if (sel.kind === "rock" && obj?.radius !== undefined) {
        fields.push({ kind: "readonly", label: "radius", value: obj.radius.toFixed(2) }); // collision follows the move
      }
      actions = [{ label: "Delete", danger: true, onClick: () => this.deleteSelection() }];
    } else if (sel.kind === "potion") {
      // potions sync add/remove but not change → deletable, but not movable here
      fields = [
        { kind: "readonly", label: "x", value: round(sel.root.position.x).toString() },
        { kind: "readonly", label: "z", value: round(sel.root.position.z).toString() },
      ];
      actions = [{ label: "Delete", danger: true, onClick: () => this.deleteSelection() }];
    } else if (sel.kind === "house") {
      // A structure: editable HP, where 0 = INDESTRUCTIBLE (server ignores all damage).
      const obj = this.entityObj("house", sel.id);
      const hp = obj?.maxHp ?? 0;
      fields = [
        { kind: "readonly", label: "x", value: round(sel.root.position.x).toString() },
        { kind: "readonly", label: "z", value: round(sel.root.position.z).toString() },
        { kind: "number", label: "HP", value: hp, min: 0, step: 50, onChange: (v) => { this.net.sendDevSet("house", sel.id, "maxHp", Math.max(0, Math.round(v))); } },
        { kind: "readonly", label: "note", value: hp <= 0 ? "⛨ indestructible (HP 0)" : "set HP 0 = indestructible" },
      ];
      this.appendLootFields("house", sel, fields, actions); // items dropped when destroyed
    } else {
      // player / static: inspect-only
      const obj = this.entityObj(sel.kind, sel.id);
      fields = [
        { kind: "readonly", label: "x", value: round(sel.root.position.x).toString() },
        { kind: "readonly", label: "z", value: round(sel.root.position.z).toString() },
      ];
      if (obj?.radius !== undefined) fields.push({ kind: "readonly", label: "radius", value: obj.radius.toFixed(2) });
    }

    // Trees & rocks are resources — let the editor tune what/how much they drop.
    if (isResource(sel.kind)) this.appendDropFields(sel, fields);
    // Any object (house/prop/tree/rock) can be turned into a goblin spawner.
    if (spawnable(sel.kind)) this.appendSpawnerFields(sel, fields);
    this.inspector.setSelection(`${sel.kind} · ${shortId(sel.id)}`, fields, actions);
  }

  // ---- goblin spawners (objects that spawn goblins) ----
  private spawners = new Map<string, SpawnerCfg>();
  private spawnerSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pull the current spawner configs so the inspector reflects them. */
  async loadSpawners() {
    try {
      const list = (await (await fetch("/__spawners/list", { cache: "no-store" })).json()) as SpawnerCfg[];
      this.spawners.clear();
      for (const s of list) this.spawners.set(s.id, { ...s, behavior: s.behavior ?? {} });
    } catch {
      /* no dev endpoint — nothing to load */
    }
  }

  /** Append the "spawns goblins" toggle + frequency/cap + per-spawner goblin
   *  behavior to an object's inspector. 0 in a behavior field = use the default. */
  private appendSpawnerFields(sel: Selectable, fields: Field[]) {
    const existing = this.spawners.get(sel.id);
    fields.push({
      kind: "checkbox",
      label: "spawns goblins",
      value: !!existing,
      onChange: (on) => {
        if (on) {
          const sp: SpawnerCfg = existing ?? {
            id: sel.id,
            x: round(sel.root.position.x),
            z: round(sel.root.position.z),
            intervalMs: 4000,
            cap: 3,
            behavior: {},
          };
          this.spawners.set(sel.id, sp);
          void this.saveSpawner(sel.id);
        } else {
          this.spawners.delete(sel.id);
          void this.deleteSpawner(sel.id);
        }
        this.showSelection(sel); // re-render to show/hide the controls
      },
    });
    const sp = this.spawners.get(sel.id);
    if (!sp) return;
    const num = (label: string, value: number, step: number, set: (v: number) => void): Field => ({
      kind: "number",
      label,
      value,
      min: 0,
      step,
      onChange: (v) => {
        set(v);
        sp.x = round(sel.root.position.x); // keep the spawner at the object
        sp.z = round(sel.root.position.z);
        this.scheduleSpawnerSave(sel.id);
      },
    });
    const b = sp.behavior;
    fields.push(
      num("interval s", sp.intervalMs / 1000, 0.5, (v) => (sp.intervalMs = Math.max(200, Math.round(v * 1000)))),
      num("max alive", sp.cap, 1, (v) => (sp.cap = Math.max(0, Math.round(v)))),
      num("goblin hp", b.hp ?? 0, 5, (v) => (b.hp = v || undefined)),
      num("goblin dmg", b.attack ?? 0, 5, (v) => (b.attack = v || undefined)),
      num("aggro range", b.aggroRadius ?? 0, 1, (v) => (b.aggroRadius = v || undefined)),
      num("chase spd", b.chaseSpeed ?? 0, 0.5, (v) => (b.chaseSpeed = v || undefined)),
      num("atk cd ms", b.attackCooldownMs ?? 0, 100, (v) => (b.attackCooldownMs = v || undefined)),
      num("house dmg", b.houseDamage ?? 0, 1, (v) => (b.houseDamage = v || undefined)),
    );
  }

  private async saveSpawner(id: string) {
    const sp = this.spawners.get(id);
    if (!sp) return;
    await fetch("/__spawners/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sp),
    }).catch((e) => console.warn("[spawner] save failed", e));
  }
  private async deleteSpawner(id: string) {
    await fetch("/__spawners/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch((e) => console.warn("[spawner] delete failed", e));
  }
  private scheduleSpawnerSave(id: string) {
    if (this.spawnerSaveTimer) clearTimeout(this.spawnerSaveTimer);
    this.spawnerSaveTimer = setTimeout(() => void this.saveSpawner(id), 300);
  }

  // ---- resource drops (trees & rocks: which item, how much) ----
  private drops = new Map<string, DropCfg>(); // keyed by resource kind ("tree"/"rock")
  private dropSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pull the current per-kind drop configs so resource inspectors reflect them. */
  async loadDrops() {
    try {
      const map = (await (await fetch("/__resources/list", { cache: "no-store" })).json()) as Record<string, DropCfg>;
      this.drops.clear();
      for (const [k, v] of Object.entries(map || {})) this.drops.set(k, v);
    } catch {
      /* no dev endpoint — inspectors fall back to the built-in defaults */
    }
  }

  /** Drop config for a resource kind: the authored value, else the built-in default
   *  (mirrors the server's DEFAULTS, incl. HP = TREE_HP 60 / ROCK_HP 560). Backfills
   *  any missing fields so an older resources.json (no hp/trigger) still resolves. */
  private dropCfg(kind: string): DropCfg {
    const def: DropCfg =
      kind === "tree"
        ? { item: "log", amount: 1, trigger: "kill", hp: 60 }
        : { item: "stone", amount: 28, trigger: "hit", hp: 560 };
    const c = this.drops.get(kind);
    if (!c) {
      this.drops.set(kind, def);
      return def;
    }
    const m = c as Partial<DropCfg>; // backfill in place (stable reference for edits)
    if (m.item == null) m.item = def.item;
    if (m.amount == null) m.amount = def.amount;
    if (m.trigger == null) m.trigger = def.trigger;
    if (m.hp == null) m.hp = def.hp;
    return c;
  }

  /** Append the "Drops" controls to a tree/rock inspector: which item, how many,
   *  total HP, and the trigger (full-on-kill vs progressive-on-hit). HP/amount drives
   *  the progressive drop rate. Edits apply to EVERY resource of this kind (per-type
   *  config), committed server-side on save. */
  private appendDropFields(sel: Selectable, fields: Field[]) {
    const c = this.dropCfg(sel.kind);
    fields.push({
      kind: "select",
      label: "drops",
      value: c.item,
      options: DROP_ITEMS,
      onChange: (v) => {
        c.item = v;
        this.scheduleDropSave(sel.kind);
      },
    });
    fields.push({
      kind: "number",
      label: "amount",
      value: c.amount,
      min: 0,
      step: 1,
      onChange: (v) => {
        c.amount = Math.max(0, Math.round(v));
        this.scheduleDropSave(sel.kind);
        this.showSelection(sel); // refresh the dmg/item hint
      },
    });
    fields.push({
      kind: "number",
      label: "total HP",
      value: c.hp,
      min: 1,
      step: 10,
      onChange: (v) => {
        c.hp = Math.max(1, Math.round(v));
        this.scheduleDropSave(sel.kind);
        this.showSelection(sel); // refresh the dmg/item hint
      },
    });
    fields.push({
      kind: "select",
      label: "trigger",
      value: c.trigger,
      options: [
        { value: "kill", label: "On kill (full)" },
        { value: "hit", label: "Progressive (hit)" },
      ],
      onChange: (v) => {
        c.trigger = v === "kill" ? "kill" : "hit";
        this.scheduleDropSave(sel.kind);
        this.showSelection(sel); // show/hide the dmg/item hint
      },
    });
    if (c.trigger === "hit") {
      fields.push({
        kind: "readonly",
        label: "dmg / item",
        value: (c.hp / Math.max(1, c.amount)).toFixed(1),
      });
    }
  }

  private async saveDrop(kind: string) {
    const c = this.drops.get(kind);
    if (!c) return;
    await fetch("/__resources/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, ...c }),
    }).catch((e) => console.warn("[drops] save failed", e));
  }
  private scheduleDropSave(kind: string) {
    if (this.dropSaveTimer) clearTimeout(this.dropSaveTimer);
    this.dropSaveTimer = setTimeout(() => void this.saveDrop(kind), 300);
  }

  // ---- structure loot tables (items dropped when a structure is destroyed) ----
  private structures = new Map<string, LootEntry[]>(); // keyed by structure kind ("house")
  private structureSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pull the current per-structure loot tables so the inspector reflects them. */
  async loadStructures() {
    try {
      const map = (await (await fetch("/__structures/list", { cache: "no-store" })).json()) as Record<string, { loot?: LootEntry[] }>;
      this.structures.clear();
      for (const [k, v] of Object.entries(map || {})) this.structures.set(k, Array.isArray(v?.loot) ? v.loot : []);
    } catch {
      /* no dev endpoint — nothing to load */
    }
  }

  /** The loot table for a structure kind (a stable, mutable array the editor edits). */
  private structureLoot(kind: string): LootEntry[] {
    let l = this.structures.get(kind);
    if (!l) {
      l = [];
      this.structures.set(kind, l);
    }
    return l;
  }

  /** Append the loot-table editor: one row per drop (item + amount + % chance) plus a
   *  "＋ Add drop" action. Each item select carries a "✕ remove" option. On destroy the
   *  server rolls each entry independently. */
  private appendLootFields(kind: string, sel: Selectable, fields: Field[], actions: Action[]) {
    const loot = this.structureLoot(kind);
    fields.push({
      kind: "readonly",
      label: "drops on destroy",
      value: loot.length ? `${loot.length} item${loot.length === 1 ? "" : "s"}` : "(none)",
    });
    loot.forEach((e, i) => {
      fields.push({
        kind: "select",
        label: `• item ${i + 1}`,
        value: e.item,
        options: [...DROP_ITEMS, { value: "__remove__", label: "✕ remove" }],
        onChange: (v) => {
          if (v === "__remove__") {
            loot.splice(i, 1);
            this.scheduleStructureSave(kind);
            this.showSelection(sel);
            return;
          }
          e.item = v;
          this.scheduleStructureSave(kind);
        },
      });
      fields.push({
        kind: "number",
        label: "amount",
        value: e.amount,
        min: 0,
        step: 1,
        onChange: (v) => {
          e.amount = Math.max(0, Math.round(v));
          this.scheduleStructureSave(kind);
        },
      });
      fields.push({
        kind: "number",
        label: "% chance",
        value: Math.round(e.probability * 100),
        min: 0,
        max: 100,
        step: 5,
        onChange: (v) => {
          e.probability = Math.max(0, Math.min(100, v)) / 100;
          this.scheduleStructureSave(kind);
        },
      });
    });
    actions.push({
      label: "＋ Add drop",
      onClick: () => {
        loot.push({ item: "log", amount: 1, probability: 1 });
        this.scheduleStructureSave(kind);
        this.showSelection(sel);
      },
    });
  }

  private async saveStructure(kind: string) {
    const loot = this.structures.get(kind) ?? [];
    await fetch("/__structures/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, loot }),
    }).catch((e) => console.warn("[structures] save failed", e));
  }
  private scheduleStructureSave(kind: string) {
    if (this.structureSaveTimer) clearTimeout(this.structureSaveTimer);
    this.structureSaveTimer = setTimeout(() => void this.saveStructure(kind), 300);
  }

  /** Debounce prop persistence so dragging a slider/object doesn't spam the endpoint. */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private schedulePersist(id: string) {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.propManager.persistUpdate(id), 300);
  }

  /** The synced schema object for a selection (best-effort), for current values. */
  private entityObj(kind: string, id: string): EntityView | null {
    const st = this.net.room?.state as unknown as
      | Record<string, { get(id: string): EntityView | undefined } | undefined>
      | undefined;
    if (!st) return null;
    const map = kind === "tree" ? st.trees : kind === "potion" ? st.potions : kind === "enemy" ? st.enemies : kind === "rock" ? st.rocks : kind === "house" ? st.houses : undefined;
    return map?.get(id) ?? null;
  }
}

interface EntityView {
  x?: number;
  z?: number;
  hp?: number;
  maxHp?: number;
  alive?: boolean;
  radius?: number;
  level?: number;
}

const round = (v: number) => Math.round(v * 10) / 10;
const deg = (r: number) => Math.round((r * 180) / Math.PI);

/** A spawn point a few units in front of the player's facing, so newly-created
 *  entities (props, characters) land NEXT TO the player instead of clipping through
 *  them. `rotY` is the player's facing (forward = sin/cos rotY, as the sim uses). */
export function frontOfPlayer(
  p: { x: number; z: number; rotY?: number },
  dist = 4,
): { x: number; z: number } {
  const a = p.rotY ?? 0;
  return { x: round(p.x + Math.sin(a) * dist), z: round(p.z + Math.cos(a) * dist) };
}

/** Kinds the editor can relocate by dragging. Potions are excluded (the client
 *  has no potion-change channel to reflect a move); the house is seeded-static
 *  collision (later phase) and players are dynamic. */
const draggable = (kind: string) =>
  kind === "prop" || kind === "tree" || kind === "enemy" || kind === "rock" || kind === "character";

/** Kinds that can be turned into a goblin spawner (any non-character object). */
const spawnable = (kind: string) =>
  kind === "prop" || kind === "tree" || kind === "rock" || kind === "house";

/** Resource kinds with a tunable drop table (what/how much they yield). */
const isResource = (kind: string) => kind === "tree" || kind === "rock";

/** Items a resource can be configured to drop (must match the server's dropItem). */
const DROP_ITEMS = [
  { value: "log", label: "Log" },
  { value: "stone", label: "Stone" },
  { value: "banana", label: "Banana" },
  { value: "potion", label: "Potion" },
];

/** Per-resource-kind drop config (mirrors the server/Vite DropCfg). */
interface DropCfg {
  item: string;
  amount: number;
  trigger: "hit" | "kill";
  hp: number; // total health; progressive drop rate = hp / amount damage per item
}

/** One entry in a structure's loot table (mirrors the server/Vite LootEntry). */
interface LootEntry {
  item: string;
  amount: number;
  probability: number; // 0..1 independent chance to drop this entry on destroy
}

interface SpawnerCfg {
  id: string;
  x: number;
  z: number;
  intervalMs: number;
  cap: number;
  behavior: {
    hp?: number;
    attack?: number;
    aggroRadius?: number;
    chaseSpeed?: number;
    attackCooldownMs?: number;
    houseDamage?: number;
  };
}

/** Trim long ids (prop ids are model urls) for the panel title. */
const shortId = (id: string) => (id.length > 22 ? "…" + id.slice(-20) : id);
