import { Scene, Mesh, PickingInfo } from "@babylonjs/core";
import { NetworkClient } from "../net/NetworkClient";
import { PropManager } from "./PropManager";
import { SelectionManager, Selectable } from "./Selection";
import { Inspector, Field, Action } from "./Inspector";
import { PropLibrary } from "./PropLibrary";
import { PropDef } from "../scene/props";

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
  private btn: HTMLButtonElement;
  private addBtn: HTMLButtonElement;
  private banner: HTMLElement;
  private timeBar: HTMLElement;
  private timeButtons: { scale: number; el: HTMLButtonElement }[] = [];
  private canvas: HTMLCanvasElement | null;

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
    addBtn.textContent = "＋ Add model";
    addBtn.style.cssText =
      "position:fixed; right:16px; bottom:240px; z-index:40; cursor:pointer; display:none;" +
      "background:#283; color:#fff; border:1px solid #4a9a52; border-radius:6px;" +
      "padding:6px 10px; font:12px system-ui,sans-serif;";
    addBtn.onclick = () => this.library.toggle();
    document.body.appendChild(addBtn);
    this.addBtn = addBtn;

    const banner = document.createElement("div");
    banner.textContent = "DEV MODE — immortal · click to select";
    banner.style.cssText =
      "position:fixed; top:8px; left:50%; transform:translateX(-50%); z-index:60; display:none;" +
      "background:#2a7a32e0; color:#eafaea; border:1px solid #9fe0a0; border-radius:6px;" +
      "padding:4px 12px; font:bold 12px system-ui,sans-serif; letter-spacing:0.5px; pointer-events:none;";
    document.body.appendChild(banner);
    this.banner = banner;

    // Time control: pause / set game speed (scales the whole authoritative sim).
    const bar = document.createElement("div");
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
  }

  toggle() {
    this.active ? this.exit() : this.enter();
  }

  private enter() {
    this.active = true;
    this.net.sendGodMode(true);
    this.propManager.setPickable(true);
    this.btn.style.background = "#3a7a40";
    this.btn.style.color = "#fff";
    this.addBtn.style.display = "block";
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
    this.selection.clear();
    this.btn.style.background = "#2a3242";
    this.btn.style.color = "#9fe0a0";
    this.addBtn.style.display = "none";
    this.banner.style.display = "none";
    this.timeBar.style.display = "none";
    this.library.close();
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
    const me = r ? (r.state.players.get(r.sessionId) as { x?: number; z?: number } | undefined) : undefined;
    return { x: +(me?.x ?? 0).toFixed(1), z: +(me?.z ?? 0).toFixed(1) };
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
    const sel = this.selection.resolve(pick?.pickedMesh ?? null);
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
    const sel = this.selection.resolve(pick?.pickedMesh ?? null);
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
   *  (which sync back to every client). Rocks/players are inspect-only for now. */
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
    } else if (sel.kind === "tree" || sel.kind === "enemy") {
      const obj = this.entityObj(sel.kind, sel.id);
      const x = obj?.x ?? sel.root.position.x;
      const z = obj?.z ?? sel.root.position.z;
      fields = [
        { kind: "number", label: "x", value: round(x), step: 0.5, onChange: (v) => this.net.sendDevMove(sel.kind, sel.id, v, this.entityObj(sel.kind, sel.id)?.z ?? z) },
        { kind: "number", label: "z", value: round(z), step: 0.5, onChange: (v) => this.net.sendDevMove(sel.kind, sel.id, this.entityObj(sel.kind, sel.id)?.x ?? x, v) },
      ];
      if (sel.kind === "tree") {
        fields.push({ kind: "checkbox", label: "alive", value: !!obj?.alive, onChange: (on) => this.net.sendDevSet("tree", sel.id, "alive", on) });
        if (obj?.maxHp !== undefined) fields.push({ kind: "number", label: "maxHp", value: obj.maxHp, min: 1, step: 10, onChange: (v) => this.net.sendDevSet("tree", sel.id, "maxHp", v) });
      }
      if (sel.kind === "enemy" && obj?.maxHp !== undefined) {
        fields.push({ kind: "number", label: "maxHp", value: obj.maxHp, min: 1, step: 10, onChange: (v) => this.net.sendDevSet("enemy", sel.id, "maxHp", v) });
      }
      actions = [{ label: "Delete", danger: true, onClick: () => this.deleteSelection() }];
    } else if (sel.kind === "potion") {
      // potions sync add/remove but not change → deletable, but not movable here
      fields = [
        { kind: "readonly", label: "x", value: round(sel.root.position.x).toString() },
        { kind: "readonly", label: "z", value: round(sel.root.position.z).toString() },
      ];
      actions = [{ label: "Delete", danger: true, onClick: () => this.deleteSelection() }];
    } else {
      // rock / player / house / static: inspect-only (seeded collision → later phase)
      const obj = this.entityObj(sel.kind, sel.id);
      fields = [
        { kind: "readonly", label: "x", value: round(sel.root.position.x).toString() },
        { kind: "readonly", label: "z", value: round(sel.root.position.z).toString() },
      ];
      if (obj?.radius !== undefined) fields.push({ kind: "readonly", label: "radius", value: obj.radius.toFixed(2) });
      if (sel.kind === "rock" || sel.kind === "house") fields.push({ kind: "readonly", label: "note", value: "edit in a later phase" });
    }

    this.inspector.setSelection(`${sel.kind} · ${shortId(sel.id)}`, fields, actions);
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
    const map = kind === "tree" ? st.trees : kind === "potion" ? st.potions : kind === "enemy" ? st.enemies : kind === "rock" ? st.rocks : undefined;
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

/** Kinds the editor can relocate by dragging. Potions are excluded (the client
 *  has no potion-change channel to reflect a move); rocks/houses are seeded-static
 *  collision and players are dynamic. */
const draggable = (kind: string) => kind === "prop" || kind === "tree" || kind === "enemy";

/** Trim long ids (prop ids are model urls) for the panel title. */
const shortId = (id: string) => (id.length > 22 ? "…" + id.slice(-20) : id);
