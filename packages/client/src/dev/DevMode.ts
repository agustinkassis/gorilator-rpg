import { Scene, Mesh, ArcRotateCamera, Vector3, MeshBuilder, StandardMaterial, Color3 } from "@babylonjs/core";
import { setCameraZoom, getCameraZoom } from "../scene/camera";
import { NetworkClient } from "../net/NetworkClient";
import { PropManager } from "./PropManager";
import { SelectionManager, Selectable } from "./Selection";
import { Inspector, Field, Action } from "./Inspector";
import { LibraryExplorer } from "./LibraryExplorer";
import { ItemLibrary } from "./ItemLibrary";
import { PropDef } from "../scene/props";
import { itemName, allItemDefs, loadItemDefs } from "../items/itemRegistry";
import type { CharacterManager } from "./CharacterManager";
import type { CharacterDef } from "../entities/characterDef";
import type { Game } from "../game/Game";
import type { AnimationTester } from "./AnimationTester";
import type { InventoryUI } from "../ui/inventory";
import type { CharacterImporter } from "./CharacterImporter";
import {
  type DevActionId,
  type DevTuningKey,
  WAVE_FIRST_DELAY_MS,
  WAVE_INTERVAL_BASE_MS,
  WAVE_INTERVAL_STEP_MS,
  WAVE_INTERVAL_MAX_MS,
  WAVE_SPAWN_SPREAD_MS,
  WAVE_SIZE_BASE,
  WAVE_SIZE_PER_PLAYER,
  WAVE_SIZE_PER_WAVE,
  WAVE_SIZE_MAX,
  GOBLIN_LIVE_CAP,
  ATTACK_COOLDOWN_MS,
  ATTACK_WINDUP_MS,
  GOBLIN_ATTACK_COOLDOWN_MS,
  GOBLIN_ATTACK_WINDUP_MS,
  GOBLIN_ATTACK_RANGE,
  GOBLIN_AGGRO_RADIUS,
  GOBLIN_DEAGGRO_RADIUS,
  GOBLIN_HOUSE_DAMAGE,
  DAMAGE_DIVISOR,
  PLAYER_RESPAWN_MS,
  PLAYER_MAX_HP,
  PLAYER_ATTACK,
  PLAYER_ARMOR,
  PLAYER_CRIT_CHANCE,
  MOVE_SPEED,
  SPRINT_SPEED_MULT,
  GOBLIN_MAX_HP,
  GOBLIN_ATTACK,
  GOBLIN_CHASE_SPEED,
  GOBLIN_ARMOR,
  BERSERKER_ATTACK_MULT,
  BERSERKER_DURATION_MS,
  DROP_RATE_MULT,
  ARMOR_K,
  CRIT_MULTIPLIER,
  type BrainId,
} from "@rpg/shared";
import {
  StructureMask,
  MaskPoint,
  cloneStructureMask,
  defaultStructureMask,
  normalizeStructureMask,
} from "../input/FootprintPicker";

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
  private shiftDown = false; // hold Shift while dropping to keep placing copies
  private skipNextPointerUp = false; // click-to-drop fires pointerup after pointerdown; don't drop the fresh copy
  private selection: SelectionManager;
  private inspector: Inspector;
  private explorer: LibraryExplorer;
  private itemLibrary: ItemLibrary;
  private btn: HTMLButtonElement;
  private itemsBtn: HTMLButtonElement;
  private entitiesBtn: HTMLButtonElement;
  private gameplayBtn: HTMLButtonElement;
  private gameplayPanel: HTMLElement;
  private toolsBtn: HTMLButtonElement;
  private toolsPanel: HTMLElement;
  private toolsOpen = false;
  private globalActionsBtn: HTMLButtonElement;
  private globalActionsPanel: HTMLElement;
  private globalActionsOpen = false;
  private animationTester: AnimationTester | null = null; // wired post-construction (main.ts)
  private charImporter: CharacterImporter | null = null; // wired post-construction (main.ts)
  private inventoryUI: InventoryUI | null = null; // wired post-construction (main.ts)
  private slotPopup: HTMLElement | null = null; // dev inventory slot editor popup
  private banner: HTMLElement;
  private timeBar: HTMLElement;
  private timeButtons: { scale: number; el: HTMLButtonElement }[] = [];
  private visibilityControls: Array<(on: boolean) => void> = [];
  private canvas: HTMLCanvasElement | null;
  private charManager: CharacterManager | null = null; // wired post-construction (main.ts)
  private game: Game | null = null; // wired post-construction (main.ts) — for focus + nodeFor
  private maskEdit: MaskEditState | null = null;
  private maskDrag = false;
  private maskMat: StandardMaterial | null = null;
  private maskSelectedMat: StandardMaterial | null = null;
  private characterDefs: CharacterDef[] = [];
  private gameplayOpen = false;
  private activeCategory: GameplayCategory = "Waves";
  private tuningValues = new Map<DevTuningKey, number>();
  private dirtyTuningKeys = new Set<DevTuningKey>();
  private customWaves: WaveDefUI[] = []; // dev-authored per-wave compositions
  private waveCharDefs: { id: string; name: string }[] = []; // spawnable custom characters
  private wavesDirty = false;
  private simBigEl: HTMLElement | null = null; // live enemy-capacity number element
  private instanceNav: { focusKind: string; ids: string[]; label: string; index: number } | null = null;
  private instanceNavEl!: HTMLElement;
  private instanceNavLabel!: HTMLElement;

  /** Wire in placed-character management so they're selectable/draggable/deletable. */
  setCharacterManager(cm: CharacterManager) {
    this.charManager = cm;
  }

  /** Wire in the Game so the library explorer can select + camera-focus entities. */
  setGame(g: Game) {
    this.game = g;
  }

  /** Wire in the Animation Tester so the Tools window can launch it. */
  setAnimationTester(at: AnimationTester) {
    this.animationTester = at;
  }

  /** Wire in the inventory UI so Dev Mode slot-clicks open the set-item popup. */
  setInventoryUI(inv: InventoryUI) {
    this.inventoryUI = inv;
  }

  /** Wire in the Character Importer so the Library's "Add Character" can open it. */
  setCharacterImporter(ci: CharacterImporter) {
    this.charImporter = ci;
  }

  onVisibilityChange(fn: (on: boolean) => void) {
    this.visibilityControls.push(fn);
    fn(this.active);
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
    this.stopMaskEdit();
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

  /** Start browsing every live instance of a kind from the map (Library badge →
   *  close Library → select the first + show the floating ◀/▶ navigator). */
  browseInstances(focusKind: string, ids: string[], label: string) {
    if (!ids.length) return;
    this.instanceNav = { focusKind, ids: ids.slice(), label, index: 0 };
    this.instanceNavEl.style.display = "flex";
    this.focusCurrentInstance();
  }

  /** Move the instance cursor by ±1 (wraps) and re-select/focus that instance. */
  private stepInstance(dir: number) {
    const nav = this.instanceNav;
    if (!nav) return;
    nav.index = (nav.index + dir + nav.ids.length) % nav.ids.length;
    this.focusCurrentInstance();
  }

  private focusCurrentInstance() {
    const nav = this.instanceNav;
    if (!nav) return;
    const ok = this.focusEntity(nav.focusKind, nav.ids[nav.index]);
    this.instanceNavLabel.textContent = `${nav.label}  ${nav.index + 1}/${nav.ids.length}${ok ? "" : " · gone"}`;
  }

  private closeInstanceNav() {
    if (!this.instanceNav) return;
    this.instanceNav = null;
    this.instanceNavEl.style.display = "none";
    this.selectNone();
    this.clearFocus();
  }

  /** Resolve a ground point to any selectable footprint — synced entities, placed
   *  custom characters, or props. */
  private resolveSelAt(point: Vector3 | null): Selectable | null {
    if (!point) return null;
    const hit = this.game?.pickSelectableAt(point);
    if (hit) {
      const n = this.game?.nodeFor(hit.kind, hit.id);
      if (n) return { kind: hit.kind, id: hit.id, root: n.root, meshes: n.meshes };
    }
    const c = this.charManager?.pickAt(point);
    if (c) return { kind: "character", id: c.placement.id, root: c.built.root, meshes: c.built.meshes };
    const p = this.propManager.pickAt(point);
    if (p) return { kind: "prop", id: p.id, root: p.loaded.root, meshes: p.loaded.meshes };
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

    // Custom inventory/gameplay items: create definitions and test-give/drop them.
    const itemsBtn = document.createElement("button");
    itemsBtn.id = "devItemsBtn";
    itemsBtn.textContent = "🎒 Items";
    itemsBtn.style.cssText =
      "position:fixed; right:16px; bottom:168px; z-index:40; cursor:pointer; display:none;" +
      "background:#2a3242; color:#9fe0a0; border:1px solid #4a9a52; border-radius:6px;" +
      "padding:6px 10px; font:12px system-ui,sans-serif;";
    itemsBtn.onclick = () => this.itemLibrary.toggle();
    document.body.appendChild(itemsBtn);
    this.itemsBtn = itemsBtn;

    // Top-left Dev control stack — Gameplay Options, Library, Tools (shared style).
    const stackBtn = (id: string, label: string, top: number) => {
      const b = document.createElement("button");
      b.id = id;
      b.textContent = label;
      b.style.cssText =
        `position:fixed; left:16px; top:${top}px; z-index:61; cursor:pointer; display:none;` +
        "width:204px; box-sizing:border-box; text-align:left;" +
        "background:linear-gradient(180deg,#345044,#1f332c); color:#d9ffd9; border:2px solid #72c979;" +
        "border-radius:8px; padding:9px 14px; font:bold 14px system-ui,sans-serif; letter-spacing:0.2px;" +
        "box-shadow:0 6px 18px #0008, inset 0 0 10px #0004;";
      document.body.appendChild(b);
      return b;
    };

    const globalActionsBtn = stackBtn("devGlobalActionsBtn", "⚡ Global Actions", 16);
    globalActionsBtn.onclick = () => this.toggleGlobalActionsPanel();
    this.globalActionsBtn = globalActionsBtn;

    const gameplayBtn = stackBtn("devGameplayBtn", "⚙ Gameplay Options", 62);
    gameplayBtn.onclick = () => this.toggleGameplayPanel();
    this.gameplayBtn = gameplayBtn;

    // "Library" opens the explorer: browse/spawn every world entity + import models.
    const entitiesBtn = stackBtn("devEntitiesBtn", "📚 Library", 108);
    entitiesBtn.onclick = () => {
      this.closeInstanceNav(); // leaving instance-browse when you reopen the Library
      this.explorer.toggle();
    };
    this.entitiesBtn = entitiesBtn;

    const toolsBtn = stackBtn("devToolsBtn", "🧰 Tools", 154);
    toolsBtn.onclick = () => this.toggleToolsPanel();
    this.toolsBtn = toolsBtn;

    const leftPanelCss = (width: number) =>
      `position:fixed; left:16px; top:200px; width:${width}px; max-height:calc(100vh - 216px); z-index:47; display:none;` +
      "overflow-y:auto; overscroll-behavior:contain; background:#10131af2; color:#e8e8e8; border:2px solid #4a9a52;" +
      "border-radius:10px; box-shadow:0 8px 30px #000a; font:12px/1.45 system-ui,sans-serif;";

    const globalActionsPanel = document.createElement("div");
    globalActionsPanel.id = "devGlobalActionsPanel";
    globalActionsPanel.style.cssText = leftPanelCss(240);
    document.body.appendChild(globalActionsPanel);
    this.globalActionsPanel = globalActionsPanel;
    this.renderGlobalActionsPanel();

    const gameplayPanel = document.createElement("div");
    gameplayPanel.id = "devGameplayPanel";
    gameplayPanel.style.cssText = leftPanelCss(460);
    document.body.appendChild(gameplayPanel);
    this.gameplayPanel = gameplayPanel;
    this.renderGameplayPanel();

    const toolsPanel = document.createElement("div");
    toolsPanel.id = "devToolsPanel";
    toolsPanel.style.cssText = leftPanelCss(240);
    document.body.appendChild(toolsPanel);
    this.toolsPanel = toolsPanel;
    this.renderToolsPanel();

    this.explorer = new LibraryExplorer({
      net: this.net,
      propManager: this.propManager,
      focusEntity: (kind, id) => this.focusEntity(kind, id),
      focusPos: (x, z) => this.focusPos(x, z),
      clearFocus: () => this.clearFocus(),
      browseInstances: (kind, ids, label) => this.browseInstances(kind, ids, label),
      spawnEntity: (kind, label) => this.addSyncedEntity(kind, label),
      placeCharacter: (def) => void this.addCharacterFromDef(def),
      placeModel: (model, name) => void this.addFromModel(model, name),
      uploadModel: (file, name) => void this.uploadModel(file, name),
      openItemLibrary: () => this.itemLibrary.toggle(),
      addCharacter: () => this.charImporter?.openImporter(),
    });
    this.itemLibrary = new ItemLibrary({
      net: this.net,
      spawnWorldItem: (itemId, label) => this.addSyncedEntity(`item:${itemId}`, label),
    });

    const banner = document.createElement("div");
    banner.id = "devModeBanner";
    banner.textContent = "DEV MODE — immortal · click to select";
    banner.style.cssText =
      "position:fixed; bottom:122px; left:50%; transform:translateX(-50%); z-index:60; display:none;" +
      "background:#2a7a32e0; color:#eafaea; border:1px solid #9fe0a0; border-radius:6px;" +
      "padding:4px 12px; font:bold 12px system-ui,sans-serif; letter-spacing:0.5px; pointer-events:none;";
    document.body.appendChild(banner);
    this.banner = banner;

    // Time control: pause / set game speed (scales the whole authoritative sim).
    const bar = document.createElement("div");
    bar.id = "devTimeBar";
    bar.style.cssText =
      "position:fixed; bottom:158px; left:50%; transform:translateX(-50%); z-index:60; display:none; gap:4px;" +
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

    // Floating instance navigator: appears when you click a Library "N in map"
    // badge — steps through every live instance of that kind (◀ prev / next ▶).
    const nav = document.createElement("div");
    nav.id = "devInstanceNav";
    nav.style.cssText =
      "position:fixed; left:50%; top:16px; transform:translateX(-50%); z-index:62; display:none;" +
      "align-items:center; gap:6px; background:#10131af2; color:#d9ffd9; border:2px solid #72c979;" +
      "border-radius:8px; padding:5px 7px; box-shadow:0 6px 18px #0008; font:600 12px system-ui,sans-serif;";
    const navBtn = (label: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "cursor:pointer; min-width:28px; height:26px; background:#223149; color:#dff; border:1px solid #3a4658;" +
        "border-radius:5px; font:700 13px system-ui,sans-serif;";
      return b;
    };
    const navPrev = navBtn("◀");
    navPrev.title = "Previous (←)";
    const navLabel = document.createElement("span");
    navLabel.style.cssText = "min-width:120px; text-align:center; padding:0 4px;";
    const navNext = navBtn("▶");
    navNext.title = "Next (→)";
    const navClose = navBtn("✕");
    navClose.title = "Stop browsing";
    navPrev.onclick = () => this.stepInstance(-1);
    navNext.onclick = () => this.stepInstance(1);
    navClose.onclick = () => this.closeInstanceNav();
    nav.append(navPrev, navLabel, navNext, navClose);
    document.body.appendChild(nav);
    this.instanceNavEl = nav;
    this.instanceNavLabel = navLabel;

    window.addEventListener("keydown", (e) => {
      if (e.key === "Shift") this.shiftDown = true;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "`" || e.key === "~") this.toggle();
      else if (this.instanceNav && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        this.stepInstance(e.key === "ArrowLeft" ? -1 : 1);
      }
      else if (e.key === "Escape" && this.active) {
        if (this.instanceNav) this.closeInstanceNav();
        else if (this.maskEdit) this.stopMaskEdit();
        else this.selectNone();
      }
      else if ((e.key === "Backspace" || e.key === "Delete") && this.active && this.selection.selected) {
        e.preventDefault(); // Backspace would otherwise navigate "back"
        if (this.maskEdit) this.deleteSelectedMaskVertex();
        else this.deleteSelection();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Shift") this.shiftDown = false;
    });
    window.addEventListener("blur", () => {
      this.shiftDown = false;
      this.skipNextPointerUp = false;
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
    this.setScale(0); // entering Dev Mode freezes authoritative gameplay for everyone
    const cam = this.scene.activeCamera as ArcRotateCamera | null;
    if (cam) setCameraZoom(cam, 1.1); // pull the view back 10% to survey while editing
    void this.loadSpawners(); // reflect existing spawners in object inspectors
    void this.loadFeatures(); // generic HP/drop/brain/stat feature config
    void this.loadCharacterDefs(); // custom spawn targets for spawner rules
    void this.loadDrops(); // reflect existing tree/rock drop configs
    void this.loadStructures(); // reflect existing structure loot tables
    this.btn.style.background = "#3a7a40";
    this.btn.style.color = "#fff";
    this.itemsBtn.style.display = "block";
    this.entitiesBtn.style.display = "block";
    this.gameplayBtn.style.display = "block";
    this.toolsBtn.style.display = "block";
    this.globalActionsBtn.style.display = "block";
    this.inventoryUI?.setDevSlotClick((slot) => this.openSlotPopup(slot));
    this.setVisibilityControls(true);
    this.banner.style.display = "block";
    this.timeBar.style.display = "flex";
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
    this.stopMaskEdit();
    this.selection.clear();
    this.btn.style.background = "#2a3242";
    this.btn.style.color = "#9fe0a0";
    this.itemsBtn.style.display = "none";
    this.entitiesBtn.style.display = "none";
    this.gameplayBtn.style.display = "none";
    this.toolsBtn.style.display = "none";
    this.globalActionsBtn.style.display = "none";
    if (this.gameplayOpen) this.closeGameplayPanel();
    else this.gameplayPanel.style.display = "none";
    if (this.toolsOpen) this.closeToolsPanel();
    if (this.globalActionsOpen) this.closeGlobalActionsPanel();
    this.inventoryUI?.setDevSlotClick(null);
    this.closeSlotPopup();
    this.closeInstanceNav();
    this.setVisibilityControls(false);
    this.banner.style.display = "none";
    this.timeBar.style.display = "none";
    this.explorer?.close();
    this.itemLibrary?.close();
    this.clearFocus(); // release the camera back to the player
    const cam = this.scene.activeCamera as ArcRotateCamera | null;
    if (cam) setCameraZoom(cam, 1); // back to the normal play zoom
    this.inspector.hide();
    this.setCursor("default");
  }

  private setVisibilityControls(on: boolean) {
    for (const fn of this.visibilityControls) fn(on);
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

  private toggleGameplayPanel() {
    if (this.gameplayOpen) this.closeGameplayPanel();
    else this.openGameplayPanel();
  }

  private openGameplayPanel() {
    if (this.toolsOpen) this.closeToolsPanel(); // one left-column panel at a time
    if (this.globalActionsOpen) this.closeGlobalActionsPanel();
    this.gameplayOpen = true;
    void this.loadGameplayData(); // custom waves + char defs + resource HP (re-renders)
    this.gameplayPanel.style.display = this.gameplayOpen ? "block" : "none";
    this.gameplayBtn.style.background = this.gameplayOpen
      ? "linear-gradient(180deg,#4a8f4f,#2f6f37)"
      : "linear-gradient(180deg,#345044,#1f332c)";
    this.gameplayBtn.style.color = this.gameplayOpen ? "#fff" : "#d9ffd9";
  }

  private closeGameplayPanel() {
    this.applyPendingGameplayTuning();
    this.gameplayOpen = false;
    this.gameplayPanel.style.display = "none";
    this.gameplayBtn.style.background = "linear-gradient(180deg,#345044,#1f332c)";
    this.gameplayBtn.style.color = "#d9ffd9";
  }

  private applyPendingGameplayTuning() {
    if (!this.dirtyTuningKeys.size) return;
    for (const key of this.dirtyTuningKeys) {
      const control = DEV_TUNING_CONTROLS.find((c) => c.key === key);
      if (!control) continue;
      const value = this.tuningValues.get(key) ?? control.defaultValue;
      this.net.sendDevTune(key, value);
      void this.saveGameplayDefault(key, value);
    }
    this.dirtyTuningKeys.clear();
  }

  private toggleToolsPanel() {
    if (this.toolsOpen) this.closeToolsPanel();
    else this.openToolsPanel();
  }

  private openToolsPanel() {
    if (this.gameplayOpen) this.closeGameplayPanel(); // one left-column panel at a time
    if (this.globalActionsOpen) this.closeGlobalActionsPanel();
    this.toolsOpen = true;
    this.toolsPanel.style.display = "block";
    this.toolsBtn.style.background = "linear-gradient(180deg,#4a8f4f,#2f6f37)";
    this.toolsBtn.style.color = "#fff";
  }

  private closeToolsPanel() {
    this.toolsOpen = false;
    this.toolsPanel.style.display = "none";
    this.toolsBtn.style.background = "linear-gradient(180deg,#345044,#1f332c)";
    this.toolsBtn.style.color = "#d9ffd9";
  }

  /** Build the Tools window: a list of dev tools (Anim Test, …). */
  private renderToolsPanel() {
    this.toolsPanel.innerHTML = "";
    const head = document.createElement("div");
    head.style.cssText =
      "position:sticky; top:0; z-index:1; display:flex; align-items:center; justify-content:space-between;" +
      "padding:8px 10px; background:#1c2230; border-bottom:1px solid #4a9a52;";
    const title = document.createElement("b");
    title.textContent = "Tools";
    title.style.color = "#9fe0a0";
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Close";
    close.style.cssText =
      "width:24px; height:24px; cursor:pointer; background:#2a3242; color:#cfe; border:1px solid #3a4658; border-radius:5px;";
    close.onclick = () => this.closeToolsPanel();
    head.appendChild(title);
    head.appendChild(close);
    this.toolsPanel.appendChild(head);

    const body = document.createElement("div");
    body.style.cssText = "padding:10px; display:flex; flex-direction:column; gap:8px;";
    this.toolsPanel.appendChild(body);

    const tools: { label: string; hint: string; run: () => void }[] = [
      { label: "🎞 Anim Test", hint: "Play local animation clips by key (1–6)", run: () => this.animationTester?.toggle() },
    ];
    for (const tool of tools) {
      const btn = document.createElement("button");
      btn.style.cssText =
        "cursor:pointer; text-align:left; border-radius:6px; border:1px solid #3a4658; background:#222a38;" +
        "color:#e8edf6; padding:8px 10px; font:600 13px system-ui,sans-serif; display:flex; flex-direction:column; gap:2px;";
      const name = document.createElement("span");
      name.textContent = tool.label;
      const hint = document.createElement("span");
      hint.textContent = tool.hint;
      hint.style.cssText = "color:#6f8192; font:11px system-ui,sans-serif;";
      btn.appendChild(name);
      btn.appendChild(hint);
      btn.onclick = () => tool.run();
      body.appendChild(btn);
    }
  }

  private toggleGlobalActionsPanel() {
    if (this.globalActionsOpen) this.closeGlobalActionsPanel();
    else this.openGlobalActionsPanel();
  }

  private openGlobalActionsPanel() {
    if (this.gameplayOpen) this.closeGameplayPanel(); // one left-column panel at a time
    if (this.toolsOpen) this.closeToolsPanel();
    this.globalActionsOpen = true;
    this.globalActionsPanel.style.display = "block";
    this.globalActionsBtn.style.background = "linear-gradient(180deg,#4a8f4f,#2f6f37)";
    this.globalActionsBtn.style.color = "#fff";
  }

  private closeGlobalActionsPanel() {
    this.globalActionsOpen = false;
    this.globalActionsPanel.style.display = "none";
    this.globalActionsBtn.style.background = "linear-gradient(180deg,#345044,#1f332c)";
    this.globalActionsBtn.style.color = "#d9ffd9";
  }

  /** Build the Global Actions window: the high-level dev commands (was the
   *  "Actions" block inside the Gameplay panel). */
  private renderGlobalActionsPanel() {
    this.globalActionsPanel.innerHTML = "";
    const head = document.createElement("div");
    head.style.cssText =
      "position:sticky; top:0; z-index:1; display:flex; align-items:center; justify-content:space-between;" +
      "padding:8px 10px; background:#1c2230; border-bottom:1px solid #4a9a52;";
    const title = document.createElement("b");
    title.textContent = "Global Actions";
    title.style.color = "#9fe0a0";
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Close";
    close.style.cssText =
      "width:24px; height:24px; cursor:pointer; background:#2a3242; color:#cfe; border:1px solid #3a4658; border-radius:5px;";
    close.onclick = () => this.closeGlobalActionsPanel();
    head.appendChild(title);
    head.appendChild(close);
    this.globalActionsPanel.appendChild(head);

    const body = document.createElement("div");
    body.style.cssText = "padding:10px; display:grid; grid-template-columns:1fr 1fr; gap:6px;";
    for (const action of DEV_GLOBAL_ACTIONS) {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.style.cssText =
        "cursor:pointer; min-height:38px; border-radius:6px; border:1px solid #3a4658; color:#fff; font:600 12px system-ui,sans-serif;" +
        (action.danger ? "background:#5a3030;" : "background:#2d6840;");
      btn.onclick = () => this.net.sendDevAction(action.id);
      body.appendChild(btn);
    }
    this.globalActionsPanel.appendChild(body);
  }

  // ---- Dev inventory slot editor (click a slot in Dev Mode) ----

  /** Open a small popup to set the clicked inventory slot's item + quantity. */
  private async openSlotPopup(slot: number) {
    this.closeSlotPopup();
    await loadItemDefs().catch(() => undefined);
    const defs = allItemDefs();

    const pop = document.createElement("div");
    pop.id = "devSlotPopup";
    pop.style.cssText =
      "position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); z-index:90; width:260px;" +
      "background:#10131af7; color:#e8e8e8; border:2px solid #4a9a52; border-radius:10px;" +
      "box-shadow:0 18px 60px #000c; font:12px/1.4 system-ui,sans-serif; overflow:hidden;";

    const head = document.createElement("div");
    head.style.cssText =
      "display:flex; align-items:center; justify-content:space-between; padding:8px 10px;" +
      "background:#1c2230; border-bottom:1px solid #4a9a52;";
    const title = document.createElement("b");
    title.textContent = `Set slot ${slot + 1}`;
    title.style.color = "#9fe0a0";
    const close = document.createElement("button");
    close.textContent = "×";
    close.style.cssText =
      "width:24px; height:24px; cursor:pointer; background:#2a3242; color:#cfe; border:1px solid #3a4658; border-radius:5px;";
    close.onclick = () => this.closeSlotPopup();
    head.append(title, close);

    const body = document.createElement("div");
    body.style.cssText = "padding:10px; display:flex; flex-direction:column; gap:8px;";

    const itemRow = document.createElement("label");
    itemRow.style.cssText = "display:flex; flex-direction:column; gap:3px; color:#9fb0c0;";
    itemRow.append(textSpan("Item"));
    const select = document.createElement("select");
    select.style.cssText =
      "height:30px; background:#0c1018; color:#e8e8e8; border:1px solid #3a4658; border-radius:5px; padding:0 6px;";
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "— (clear slot)";
    select.appendChild(emptyOpt);
    for (const d of defs) {
      const o = document.createElement("option");
      o.value = d.id;
      o.textContent = `${typeof d.icon === "string" && !/^\/|^https?:|^data:/i.test(d.icon) ? d.icon + " " : ""}${d.name}`;
      select.appendChild(o);
    }
    if (defs[0]) select.value = defs[0].id;
    itemRow.appendChild(select);

    const qtyRow = document.createElement("label");
    qtyRow.style.cssText = "display:flex; flex-direction:column; gap:3px; color:#9fb0c0;";
    qtyRow.append(textSpan("Quantity"));
    const qty = document.createElement("input");
    qty.type = "number";
    qty.min = "1";
    qty.max = "999";
    qty.value = "1";
    qty.style.cssText =
      "height:30px; background:#0c1018; color:#e8e8e8; border:1px solid #3a4658; border-radius:5px; padding:0 8px;";
    qtyRow.appendChild(qty);

    const actions = document.createElement("div");
    actions.style.cssText = "display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:2px;";
    const setBtn = document.createElement("button");
    setBtn.textContent = "Set slot";
    setBtn.style.cssText =
      "cursor:pointer; min-height:32px; border-radius:6px; border:1px solid #3a4658; background:#2d6840; color:#fff; font:600 12px system-ui,sans-serif;";
    setBtn.onclick = () => {
      const type = select.value;
      const count = Math.max(1, Math.min(999, Math.round(Number(qty.value) || 1)));
      this.net.sendDevSetSlot(slot, type, count);
      this.closeSlotPopup();
    };
    const createBtn = document.createElement("button");
    createBtn.textContent = "Create new item";
    createBtn.style.cssText =
      "cursor:pointer; min-height:32px; border-radius:6px; border:1px solid #3a4658; background:#222a38; color:#cfe; font:600 12px system-ui,sans-serif;";
    createBtn.onclick = () => {
      this.itemLibrary.show();
      this.closeSlotPopup();
    };
    actions.append(setBtn, createBtn);

    body.append(itemRow, qtyRow, actions);
    pop.append(head, body);
    document.body.appendChild(pop);
    this.slotPopup = pop;
  }

  private closeSlotPopup() {
    this.slotPopup?.remove();
    this.slotPopup = null;
  }

  private renderGameplayPanel() {
    this.gameplayPanel.innerHTML = "";
    const head = document.createElement("div");
    head.style.cssText =
      "position:sticky; top:0; z-index:1; display:flex; align-items:center; justify-content:space-between;" +
      "padding:8px 10px; background:#1c2230; border-bottom:1px solid #4a9a52;";
    const title = document.createElement("b");
    title.textContent = "Gameplay";
    title.style.color = "#9fe0a0";
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Close";
    close.style.cssText =
      "width:24px; height:24px; cursor:pointer; background:#2a3242; color:#cfe; border:1px solid #3a4658; border-radius:5px;";
    close.onclick = () => this.toggleGameplayPanel();
    head.appendChild(title);
    head.appendChild(close);
    this.gameplayPanel.appendChild(head);

    const body = document.createElement("div");
    body.style.cssText = "padding:10px; display:flex; flex-direction:column; gap:12px;";
    this.gameplayPanel.appendChild(body);

    // ---- Big square category buttons (Waves / Player / Combat / Resources) ----
    const catRow = document.createElement("div");
    catRow.style.cssText = "display:grid; grid-template-columns:repeat(4, 1fr); gap:8px;";
    const CATS: { id: GameplayCategory; icon: string; label: string }[] = [
      { id: "Waves", icon: "🌊", label: "Waves" },
      { id: "Player", icon: "🛡️", label: "Player" },
      { id: "Combat", icon: "⚔️", label: "Combat" },
      { id: "Resources", icon: "🌳", label: "Resources" },
    ];
    for (const cat of CATS) {
      const active = this.activeCategory === cat.id;
      const btn = document.createElement("button");
      btn.style.cssText =
        "cursor:pointer; aspect-ratio:1/1; display:flex; flex-direction:column; align-items:center; justify-content:center;" +
        "gap:4px; border-radius:10px; font:700 12px system-ui,sans-serif; transition:all .12s ease;" +
        (active
          ? "background:linear-gradient(180deg,#3f8a4a,#256033); color:#fff; border:2px solid #72c979;" +
            "box-shadow:0 0 0 1px #72c97955, 0 4px 12px #0006;"
          : "background:#1a2230; color:#9fb0c0; border:2px solid #2c3a30;");
      const glyph = document.createElement("div");
      glyph.textContent = cat.icon;
      glyph.style.cssText = "font-size:26px; line-height:1;";
      const lbl = document.createElement("div");
      lbl.textContent = cat.label;
      btn.appendChild(glyph);
      btn.appendChild(lbl);
      btn.onclick = () => {
        this.activeCategory = cat.id;
        this.renderGameplayPanel();
      };
      catRow.appendChild(btn);
    }
    body.appendChild(catRow);

    // ---- Difficulty presets (only on Waves / Combat) ----
    if (this.activeCategory === "Waves" || this.activeCategory === "Combat") {
      const diffWrap = this.gameplaySection("Difficulty preset");
      const diffRow = document.createElement("div");
      diffRow.style.cssText = "display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px;";
      for (const preset of ["Easy", "Normal", "Hard"] as const) {
        const btn = document.createElement("button");
        btn.textContent = preset;
        btn.style.cssText =
          "cursor:pointer; min-height:30px; border-radius:6px; border:1px solid #3a4658; background:#222a38;" +
          "color:#cdd3e0; font:600 12px system-ui,sans-serif;";
        btn.onclick = () => this.applyDifficultyPreset(preset);
        diffRow.appendChild(btn);
      }
      diffWrap.appendChild(diffRow);
      const diffHint = document.createElement("div");
      diffHint.textContent = "Scales enemy HP/attack and wave size together.";
      diffHint.style.cssText = "color:#6f8192; font:10px system-ui,sans-serif;";
      diffWrap.appendChild(diffHint);
      body.appendChild(diffWrap);
    }

    // ---- Live combat estimate (Player / Combat) ----
    if (this.activeCategory === "Player" || this.activeCategory === "Combat") {
      body.appendChild(this.simEstimateBox());
    }

    // ---- Controls for the active category, grouped by section ----
    const divider = document.createElement("div");
    divider.style.cssText = "height:1px; background:#2c3a30; margin:2px 0;";
    body.appendChild(divider);

    let activeSection = "";
    let section: HTMLElement | null = null;
    for (const control of DEV_TUNING_CONTROLS) {
      if (control.category !== this.activeCategory) continue;
      if (control.section !== activeSection) {
        activeSection = control.section;
        section = this.gameplaySection(activeSection);
        body.appendChild(section);
      }
      section?.appendChild(this.tuningRow(control));
    }

    // ---- Per-tab extras ----
    if (this.activeCategory === "Waves") body.appendChild(this.renderWaveEditor());
    if (this.activeCategory === "Resources") body.appendChild(this.renderResourceHp());

    const defaults = document.createElement("button");
    defaults.textContent = "Reset all to defaults";
    defaults.style.cssText =
      "cursor:pointer; border-radius:6px; border:1px solid #3a4658; background:#2a3242; color:#cfe; padding:8px; font:600 12px system-ui,sans-serif;";
    defaults.onclick = () => {
      this.tuningValues.clear();
      for (const c of DEV_TUNING_CONTROLS) this.dirtyTuningKeys.add(c.key);
      this.renderGameplayPanel();
    };
    body.appendChild(defaults);
  }

  /** Current tuned RAW value for a key (pending edit, else built-in default). */
  private tunedRaw(key: DevTuningKey): number {
    const control = DEV_TUNING_CONTROLS.find((c) => c.key === key);
    return this.tuningValues.get(key) ?? control?.defaultValue ?? 0;
  }

  /** Approx how many goblins a single player can handle, from the CURRENT tuned
   *  Player/Combat values + the server damage formula. Deterministic (expected
   *  values, no RNG): kill enemies one-by-one while all alive ones hit back. */
  private computeEnemyCapacity(): number {
    const divisor = Math.max(0.1, this.tunedRaw("damageDivisor"));
    const hit = (atk: number, armor: number, critChance = 0, critMult = 1) => {
      const mitig = armor / (armor + ARMOR_K);
      const base = (atk * (1 - mitig)) / divisor;
      const withCrit = base * (1 + critChance * (critMult - 1));
      return Math.max(1, withCrit);
    };
    const playerDmg = hit(
      this.tunedRaw("playerAttack"),
      GOBLIN_ARMOR,
      this.tunedRaw("playerCritChance"),
      CRIT_MULTIPLIER,
    );
    const playerDps = playerDmg * (1000 / Math.max(50, this.tunedRaw("playerAttackCooldownMs")));
    const enemyHp = Math.max(1, this.tunedRaw("enemyMaxHp"));
    const ttk = enemyHp / Math.max(0.01, playerDps); // seconds to kill one enemy
    const enemyDmg = hit(this.tunedRaw("enemyAttack"), this.tunedRaw("playerArmor"));
    const enemyDps = enemyDmg * (1000 / Math.max(50, this.tunedRaw("enemyAttackCooldownMs")));
    const playerHp = Math.max(1, this.tunedRaw("playerMaxHp"));
    if (enemyDps <= 0 || ttk <= 0) return 999;
    // Sum damage taken killing N enemies (one at a time): enemyDps*ttk * N(N+1)/2 ≤ HP.
    const capacity = playerHp / (enemyDps * ttk);
    const n = Math.floor((-1 + Math.sqrt(1 + 8 * capacity)) / 2);
    return Math.max(0, Math.min(999, n));
  }

  private simEstimateBox(): HTMLElement {
    const n = this.computeEnemyCapacity();
    const box = document.createElement("div");
    box.style.cssText =
      "display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:8px;" +
      "background:linear-gradient(180deg,#1d2b22,#141d18); border:1px solid #3f8c49;";
    const big = document.createElement("div");
    big.textContent = n >= 999 ? "∞" : `~${n}`;
    big.style.cssText = "font:800 24px system-ui,sans-serif; color:#9fe0a0; min-width:46px; text-align:center;";
    this.simBigEl = big; // keep a handle so commits can refresh it without a full re-render
    const txt = document.createElement("div");
    txt.innerHTML =
      `<div style="font-weight:700; color:#e8edf6;">enemies one player can handle</div>` +
      `<div style="color:#6f8192; font-size:10px;">estimate from current Player + Combat settings · updates live</div>`;
    box.append(big, txt);
    return box;
  }

  // ---- Custom wave editor (Waves tab) ----

  /** Load everything the Gameplay panel's richer tabs need, then re-render. */
  private async loadGameplayData() {
    await Promise.all([this.loadCustomWaves(), this.loadWaveCharDefs(), this.loadDrops()]);
    if (this.gameplayOpen) this.renderGameplayPanel();
  }

  private async loadCustomWaves() {
    const BRAINS = ["idle", "passive_patrol", "war_seeker", "attacks_home"];
    try {
      const arr = (await (await fetch("/__waves/list", { cache: "no-store" })).json()) as unknown[];
      this.customWaves = (Array.isArray(arr) ? arr : [])
        .map((w) => {
          const ww = w as { number?: unknown; entries?: unknown };
          const entries = Array.isArray(ww.entries)
            ? ww.entries.map((e) => {
                const ee = e as Record<string, unknown>;
                const brain = String(ee.brain || "attacks_home") as BrainId;
                return {
                  kind: String(ee.kind || "goblin"),
                  count: Math.max(1, Math.round(Number(ee.count) || 1)),
                  brain: BRAINS.includes(brain) ? brain : ("attacks_home" as BrainId),
                  level: ee.level != null ? Math.max(1, Math.round(Number(ee.level))) : undefined,
                } as WaveEntryUI;
              })
            : [];
          return { number: Math.round(Number(ww.number) || 0), entries } as WaveDefUI;
        })
        .filter((w) => w.number > 0)
        .sort((a, b) => a.number - b.number);
    } catch {
      this.customWaves = [];
    }
    this.wavesDirty = false;
  }

  private async loadWaveCharDefs() {
    try {
      const defs = (await (await fetch("/__char/defs", { cache: "no-store" })).json()) as Array<{ id: string; name?: string }>;
      this.waveCharDefs = Array.isArray(defs) ? defs.map((d) => ({ id: d.id, name: d.name || d.id })) : [];
    } catch {
      this.waveCharDefs = [];
    }
  }

  private async saveCustomWaves() {
    this.wavesDirty = false;
    try {
      await fetch("/__waves/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.customWaves),
      });
    } catch (e) {
      console.warn("[waves] save failed", e);
    }
  }

  private renderWaveEditor(): HTMLElement {
    const wrap = this.gameplaySection("Custom waves");
    const hint = document.createElement("div");
    hint.textContent = "Override specific waves. Undefined wave numbers use the default horde.";
    hint.style.cssText = "color:#6f8192; font:10px system-ui,sans-serif;";
    wrap.appendChild(hint);

    const kindOptions = () => [
      { value: "goblin", label: "Goblin" },
      { value: "dummy", label: "Dummy" },
      ...this.waveCharDefs.map((d) => ({ value: d.id, label: d.name })),
    ];
    const BRAIN_OPTS: { value: string; label: string }[] = [
      { value: "attacks_home", label: "Attack home (default)" },
      { value: "war_seeker", label: "Hunt players" },
      { value: "passive_patrol", label: "Patrol" },
      { value: "idle", label: "Idle" },
    ];

    for (const wave of this.customWaves) {
      const card = document.createElement("div");
      card.style.cssText =
        "border:1px solid #2c3a30; border-radius:8px; padding:8px; display:flex; flex-direction:column; gap:6px; background:#141d18;";
      const head = document.createElement("div");
      head.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:8px;";
      const title = document.createElement("label");
      title.style.cssText = "display:flex; align-items:center; gap:6px; color:#9fe0a0; font-weight:700;";
      const numIn = numberInput(wave.number, 1, 999, 1, "56px");
      numIn.onchange = () => {
        wave.number = clampInt(numIn.value, 1, 999);
        void this.saveCustomWaves();
      };
      title.append(document.createTextNode("Wave "), numIn);
      const del = smallDevBtn("✕ wave", "#5a3030", "#ff9a8a");
      del.onclick = () => {
        this.customWaves = this.customWaves.filter((w) => w !== wave);
        void this.saveCustomWaves();
        this.renderGameplayPanel();
      };
      head.append(title, del);
      card.appendChild(head);

      for (const entry of wave.entries) {
        const row = document.createElement("div");
        row.style.cssText = "display:grid; grid-template-columns:1fr 56px 1fr 26px; gap:5px; align-items:center;";
        const kindSel = selectInput(kindOptions(), entry.kind);
        kindSel.onchange = () => {
          entry.kind = kindSel.value;
          void this.saveCustomWaves();
        };
        const countIn = numberInput(entry.count, 1, 200, 1, "100%");
        countIn.onchange = () => {
          entry.count = clampInt(countIn.value, 1, 200);
          void this.saveCustomWaves();
        };
        const brainSel = selectInput(BRAIN_OPTS, entry.brain);
        brainSel.onchange = () => {
          entry.brain = brainSel.value as BrainId;
          void this.saveCustomWaves();
        };
        const rm = smallDevBtn("✕", "#2a3242", "#cfe");
        rm.onclick = () => {
          wave.entries = wave.entries.filter((x) => x !== entry);
          void this.saveCustomWaves();
          this.renderGameplayPanel();
        };
        row.append(kindSel, countIn, brainSel, rm);
        card.appendChild(row);
      }

      const addUnit = smallDevBtn("＋ Add unit", "#222a38", "#cfe");
      addUnit.style.justifySelf = "start";
      addUnit.onclick = () => {
        wave.entries.push({ kind: "goblin", count: 3, brain: "attacks_home" });
        void this.saveCustomWaves();
        this.renderGameplayPanel();
      };
      card.appendChild(addUnit);
      wrap.appendChild(card);
    }

    const addWave = document.createElement("button");
    addWave.textContent = "＋ Add wave";
    addWave.style.cssText =
      "cursor:pointer; min-height:32px; border-radius:6px; border:1px solid #3f8c49; background:#23472b; color:#e8ffe8; font:600 12px system-ui,sans-serif;";
    addWave.onclick = () => {
      const next = this.customWaves.reduce((m, w) => Math.max(m, w.number), 0) + 1;
      this.customWaves.push({ number: next, entries: [{ kind: "goblin", count: 5, brain: "attacks_home" }] });
      void this.saveCustomWaves();
      this.renderGameplayPanel();
    };
    wrap.appendChild(addWave);
    return wrap;
  }

  /** Resources tab: global tree/rock HP (persisted to resources.json, applied live). */
  private renderResourceHp(): HTMLElement {
    const wrap = this.gameplaySection("Resource HP");
    const hint = document.createElement("div");
    hint.textContent = "Total HP of every tree / rock — applies to all instances live.";
    hint.style.cssText = "color:#6f8192; font:10px system-ui,sans-serif;";
    wrap.appendChild(hint);
    for (const kind of ["tree", "rock"] as const) {
      const cfg = this.dropCfg(kind);
      const row = document.createElement("label");
      row.style.cssText = "display:grid; grid-template-columns:1fr 86px 28px; align-items:center; gap:7px;";
      const name = document.createElement("span");
      name.textContent = kind === "tree" ? "Tree HP" : "Rock HP";
      name.style.cssText = "color:#cdd3e0; font-weight:600;";
      const input = numberInput(Number(cfg.hp) || 0, 1, 1_000_000, 1, "100%");
      input.onchange = () => {
        cfg.hp = clampInt(input.value, 1, 1_000_000);
        this.scheduleDropSave(kind);
      };
      const unit = document.createElement("span");
      unit.textContent = "hp";
      unit.style.cssText = "color:#6f8192;";
      row.append(name, input, unit);
      wrap.appendChild(row);
    }
    return wrap;
  }

  /** Scale the difficulty-relevant keys up/down together. Normal restores each
   *  key to its built-in default. Edits go through the same dirty/commit path. */
  private applyDifficultyPreset(preset: "Easy" | "Normal" | "Hard") {
    const factor: Record<typeof preset, number> = { Easy: 0.7, Normal: 1, Hard: 1.5 };
    const keys: DevTuningKey[] = [
      "enemyMaxHp",
      "enemyAttack",
      "waveSizeBase",
      "waveSizeMax",
      "goblinLiveCap",
    ];
    const mult = factor[preset];
    for (const key of keys) {
      const control = DEV_TUNING_CONTROLS.find((c) => c.key === key);
      if (!control) continue;
      const target =
        preset === "Normal"
          ? control.defaultValue
          : Math.max(control.min * control.scale, control.defaultValue * mult);
      const raw = control.integer ? Math.round(target) : target;
      this.tuningValues.set(key, raw);
      this.dirtyTuningKeys.add(key);
    }
    this.renderGameplayPanel();
  }

  private gameplaySection(title: string): HTMLElement {
    const wrap = document.createElement("section");
    wrap.style.cssText = "display:flex; flex-direction:column; gap:7px;";
    const label = document.createElement("div");
    label.textContent = title;
    label.style.cssText = "color:#9fe0a0; font-weight:700; font-size:11px; text-transform:uppercase;";
    wrap.appendChild(label);
    return wrap;
  }

  private tuningRow(control: TuningControl): HTMLElement {
    const row = document.createElement("label");
    row.title = control.description;
    row.style.cssText = "display:grid; grid-template-columns:1fr 78px 40px; align-items:center; gap:7px;";
    const labelBlock = document.createElement("div");
    labelBlock.style.cssText = "display:flex; flex-direction:column; gap:2px; min-width:0;";
    const name = document.createElement("span");
    name.textContent = control.label;
    name.style.cssText = "color:#cdd3e0; font-weight:600; font-size:12px;";
    const desc = document.createElement("span");
    desc.textContent = control.description;
    desc.style.cssText = "color:#6f8192; font-size:10px; line-height:1.25;";
    labelBlock.appendChild(name);
    labelBlock.appendChild(desc);
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = String(control.step);
    const rawValue = this.tuningValues.get(control.key) ?? control.defaultValue;
    input.value = formatTuning(rawValue / control.scale);
    input.style.cssText =
      "width:78px; box-sizing:border-box; background:#0c1018; color:#e8e8e8; border:1px solid #3a4658;" +
      "border-radius:5px; padding:4px 5px; text-align:right; font:12px system-ui,sans-serif;";
    const unit = document.createElement("span");
    unit.textContent = control.unit;
    unit.style.cssText = "color:#6f8192;";
    const commit = () => {
      const displayValue = input.valueAsNumber;
      if (!Number.isFinite(displayValue)) return;
      const clamped = Math.max(control.min, Math.min(control.max, displayValue));
      const raw = control.integer ? Math.round(clamped * control.scale) : clamped * control.scale;
      input.value = formatTuning(raw / control.scale);
      this.tuningValues.set(control.key, raw);
      this.dirtyTuningKeys.add(control.key);
      if (this.simBigEl) {
        const n = this.computeEnemyCapacity();
        this.simBigEl.textContent = n >= 999 ? "∞" : `~${n}`;
      }
    };
    input.onchange = commit;
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
        input.blur();
      }
    };
    row.appendChild(labelBlock);
    row.appendChild(input);
    row.appendChild(unit);
    return row;
  }

  private async saveGameplayDefault(key: DevTuningKey, value: number) {
    try {
      const res = await fetch("/__gameplay/default", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) console.warn("[gameplay] default save failed", await res.text());
    } catch (e) {
      console.warn("[gameplay] default save failed", e);
    }
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
      this.explorer.setStatus(`placed "${out.name}" - drag to position, edit at right`);
    } catch (e) {
      this.explorer.setStatus("place failed: " + (e as Error).message);
    }
  }

  /** Create a real synced entity in authoritative room state, then select/drag it
   *  once the state patch arrives back from the server. */
  private addSyncedEntity(kind: string, label: string) {
    const pos = this.playerPos();
    const id = this.net.sendDevSpawn(kind, pos.x, pos.z);
    const focusKind = focusKindForSpawn(kind);
    this.explorer.setStatus(`placed "${label}" - syncing...`);
    this.explorer.close();
    this.itemLibrary.close();
    window.setTimeout(() => {
      if (this.focusEntity(focusKind, id)) {
        this.beginDragFromSelection();
        this.explorer.setStatus(`placed "${label}" - drag to position, edit at right`);
      }
    }, 180);
  }

  /** Place an existing custom character definition (persist + select for editing). */
  private async addCharacterFromDef(def: CharacterDef) {
    const pos = this.playerPos();
    try {
      const res = await fetch("/__char/place", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defId: def.id, x: pos.x, z: pos.z, rotationY: 0 }),
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json();
      this.explorer.close();
      this.explorer.setStatus(`placed "${def.name || def.id}" - waiting for server entity...`);
      const focus = () => {
        if (this.focusEntity("enemy", out.id)) {
          this.beginDragFromSelection();
          this.explorer.setStatus(`placed "${def.name || def.id}" - drag to position, edit at right`);
        }
      };
      window.setTimeout(focus, 500);
      window.setTimeout(focus, 1700);
    } catch (e) {
      this.explorer.setStatus("place failed: " + (e as Error).message);
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
      this.explorer.setStatus(`imported "${out.name}" - drag to position, edit at right`);
    } catch (e) {
      this.explorer.setStatus("import failed: " + (e as Error).message);
    }
  }

  /** Load a freshly-added prop into the world, select it, and drop straight into
   *  positioning — the model follows the cursor (reusing the drag-to-move), and a
   *  click commits it where it lands. */
  private async spawnAndSelect(def: PropDef) {
    const placed = await this.propManager.place(def);
    const sel: Selectable = { kind: "prop", id: placed.id, root: placed.loaded.root, meshes: placed.loaded.meshes };
    this.selection.select(sel);
    this.showSelection(sel);
    this.explorer.close(); // clear the panel so the cursor can position on the canvas
    this.drag = sel; // arm the follow-drag; the next mouse-move relocates it, a click drops it
    this.setCursor("grabbing");
  }

  private beginDragFromSelection() {
    const sel = this.selection.selected;
    if (!sel || !draggable(sel.kind)) return;
    this.drag = sel;
    this.setCursor("grabbing");
  }

  private selectNone() {
    this.drag = null; // cancel any in-progress placement/follow-drag
    this.skipNextPointerUp = false;
    this.stopMaskEdit();
    this.selection.select(null);
    this.inspector.setSelection(null);
  }

  /** Delete the current selection (Backspace/Delete or the inspector button).
   *  Props/custom characters drop from their manifests; synced entities are
   *  removed server-side. Players remain session-owned and inspect-only. */
  private deleteSelection() {
    const sel = this.selection.selected;
    if (!sel) return;
    this.stopMaskEdit();
    if (spawnable(sel.kind)) void this.deleteSpawnersForOwner(sel.id);
    if (sel.kind === "prop") {
      void this.propManager.persistDelete(sel.id);
      this.selectNone();
    } else if (editableSynced(sel.kind)) {
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
  pointerDown = (point: Vector3 | null, event?: PointerEvent): boolean => {
    if (!this.active) return false;
    if (event) this.shiftDown = event.shiftKey;
    if (this.maskEdit) return this.maskPointerDown(point);
    // A drag in progress without a held button = a just-placed model following the
    // cursor; a click commits (drops) it wherever it currently sits.
    if (this.drag) {
      this.endDrag(true);
      return true;
    }
    const sel = this.resolveSelAt(point);
    if (sel) {
      this.stopMaskEdit();
      this.selection.select(sel);
      this.showSelection(sel);
      // grab draggable objects so the next pointer-moves relocate them
      this.drag = draggable(sel.kind) ? sel : null;
      if (this.drag) this.setCursor("grabbing");
      return true;
    }
    // bare ground (or nothing actionable): deselect, but keep navigation working
    this.selectNone();
    if (point) {
      this.clearFocus(); // walking again → camera resumes following the player
      this.net.sendMove(point.x, point.z);
    }
    return true;
  };

  /** Hover: themed cursor; while dragging, relocate the grabbed object across the
   *  ground plane (props move + persist locally, synced entities send throttled moves). */
  pointerMove = (point: Vector3 | null): boolean => {
    if (!this.active) return false;
    if (this.maskEdit) return this.maskPointerMove(point);
    if (this.drag) {
      if (point) this.dragTo(this.drag, point.x, point.z);
      this.setCursor("grabbing");
      return true;
    }
    const sel = this.resolveSelAt(point);
    this.setCursor(sel ? "grab" : "default");
    return true;
  };

  /** Release ends a button-held drag. */
  pointerUp = (event?: PointerEvent) => {
    if (event) this.shiftDown = event.shiftKey;
    if (this.maskEdit) {
      this.maskDrag = false;
      this.saveMaskEdit();
      return;
    }
    if (this.skipNextPointerUp) {
      this.skipNextPointerUp = false;
      return;
    }
    this.endDrag(false);
  };

  /** Commit the current drag/placement: persist the prop (or send the authoritative
   *  move for a synced entity) at its dropped position, then refresh the inspector.
   *  Holding Shift while dropping leaves this entity placed and creates the next
   *  copy in hand, like RTS shift-construction. */
  private endDrag(fromPointerDown: boolean) {
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
    if (this.shiftDown && copyable(sel.kind)) {
      if (fromPointerDown) this.skipNextPointerUp = true;
      void this.copyForShiftPlacement(sel);
    } else {
      this.setCursor("grab");
    }
  }

  private async copyForShiftPlacement(sel: Selectable) {
    const label = this.labelFor(sel);
    try {
      if (sel.kind === "prop") {
        const placed = this.propManager.get(sel.id);
        if (!placed) return;
        const d = placed.def;
        const meta = {
          model: d.model,
          name: d.name || nameFromModel(d.model),
          x: d.x,
          z: d.z,
          scale: d.scale,
          rotationY: d.rotationY || 0,
          collisionRadius: d.collisionRadius ?? 0,
        };
        const res = await fetch("/__props/place", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(meta),
        });
        if (!res.ok) throw new Error(await res.text());
        const out = await res.json();
        await this.spawnAndSelect({ id: out.id, name: out.name, model: out.model, ...meta });
        this.explorer.setStatus(`placed "${label}" - Shift held, drag the next copy`);
        return;
      }
      if (sel.kind === "character") {
        const c = this.charManager?.get(sel.id);
        if (!c) return;
        const placement = c.placement;
        const res = await fetch("/__char/place", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            defId: c.def.id,
            x: placement.x,
            z: placement.z,
            rotationY: placement.rotationY || 0,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const out = await res.json();
        await this.charManager?.placeNew(c.def, {
          id: out.id,
          x: placement.x,
          z: placement.z,
          rotationY: placement.rotationY || 0,
        });
        const created = this.charManager?.get(out.id);
        if (created) {
          const next: Selectable = {
            kind: "character",
            id: out.id,
            root: created.built.root,
            meshes: created.built.meshes,
          };
          this.selection.select(next);
          this.showSelection(next);
          this.beginDragFromSelection();
          this.explorer.setStatus(`placed "${label}" - Shift held, drag the next copy`);
        }
        return;
      }
      if (editableSynced(sel.kind)) {
        const obj = this.entityObj(sel.kind, sel.id);
        const x = obj?.x ?? sel.root.position.x;
        const z = obj?.z ?? sel.root.position.z;
        const spawnKind = spawnKindFor(sel.kind, obj);
        const id = this.net.sendDevSpawn(spawnKind, x, z);
        const focusKind = focusKindForSpawn(spawnKind);
        window.setTimeout(() => {
          if (this.focusEntity(focusKind, id)) {
            this.beginDragFromSelection();
            this.explorer.setStatus(`placed "${label}" - Shift held, drag the next copy`);
          }
        }, 180);
      }
    } catch (e) {
      this.explorer.setStatus("copy failed: " + (e as Error).message);
      this.setCursor("grab");
    }
  }

  private labelFor(sel: Selectable): string {
    if (sel.kind === "prop") {
      const d = this.propManager.get(sel.id)?.def;
      return d?.name || (d?.model ? nameFromModel(d.model) : sel.kind);
    }
    if (sel.kind === "character") {
      const c = this.charManager?.get(sel.id);
      return c?.def.name || sel.kind;
    }
    const obj = this.entityObj(sel.kind, sel.id);
    if (sel.kind === "enemy") return obj?.kind === "goblin" ? "Goblin" : "Dummy";
    if (sel.kind === "potion") return obj?.kind === "berserker_potion" ? "Berserker Potion" : "Potion";
    if (sel.kind === "item") return itemName(obj?.itemId || sel.id);
    return cap(sel.kind);
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
   *  Players are inspect-only. */
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
      // A concrete prop IS a destructible structure: HP + drops, shared per MODEL
      // (every instance of d.model inherits), so it matches every other structure.
      if ((d.collisionRadius ?? 0) > 0 && d.model) {
        const sobj = this.entityObj("structure", sel.id);
        this.appendDamageableFields("structure", "default", d.model, sel.id, sobj, 50, fields);
        this.appendFeatureDropFields("structure", "default", d.model, sel, fields, actions);
      }
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
    } else if (editableSynced(sel.kind)) {
      const obj = this.entityObj(sel.kind, sel.id);
      const x = obj?.x ?? sel.root.position.x;
      const z = obj?.z ?? sel.root.position.z;
      fields = [
        { kind: "number", label: "x", value: round(x), step: 0.5, onChange: (v) => this.net.sendDevMove(sel.kind, sel.id, v, this.entityObj(sel.kind, sel.id)?.z ?? z) },
        { kind: "number", label: "z", value: round(z), step: 0.5, onChange: (v) => this.net.sendDevMove(sel.kind, sel.id, this.entityObj(sel.kind, sel.id)?.x ?? x, v) },
      ];
      if (sel.kind === "tree") this.appendDamageableFields("tree", "default", "tree", sel.id, obj, 10, fields);
      if (sel.kind === "enemy" && obj?.maxHp !== undefined) {
        this.appendCharacterFields(sel, obj, fields);
      }
      if (sel.kind === "rock" && obj?.radius !== undefined) {
        this.appendDamageableFields("rock", "default", "rock", sel.id, obj, 10, fields);
        fields.push({ kind: "readonly", label: "radius", value: obj.radius.toFixed(2) }); // collision follows the move
      }
      if (sel.kind === "house") {
        this.appendDamageableFields("house", "default", "house", sel.id, obj, 50, fields);
        const hp = obj?.maxHp ?? 0;
        fields.push({ kind: "readonly", label: "note", value: hp <= 0 ? "indestructible (HP 0)" : "set HP 0 = indestructible" });
      }
      actions = [{ label: "Delete", danger: true, onClick: () => this.deleteSelection() }];
    } else if (sel.kind === "player") {
      const obj = this.entityObj("player", sel.id);
      fields = [
        { kind: "readonly", label: "x", value: round(sel.root.position.x).toString() },
        { kind: "readonly", label: "z", value: round(sel.root.position.z).toString() },
      ];
      if (obj) this.appendCharacterFields(sel, obj, fields);
    } else {
      // player / static: inspect-only
      const obj = this.entityObj(sel.kind, sel.id);
      fields = [
        { kind: "readonly", label: "x", value: round(sel.root.position.x).toString() },
        { kind: "readonly", label: "z", value: round(sel.root.position.z).toString() },
      ];
      if (obj?.radius !== undefined) fields.push({ kind: "readonly", label: "radius", value: obj.radius.toFixed(2) });
    }

    if (sel.kind === "house") this.appendStructureMaskFields(sel, fields, actions);
    if (sel.kind === "tree" || sel.kind === "rock" || sel.kind === "house")
      this.appendFeatureDropFields(sel.kind, "default", sel.kind, sel, fields, actions);
    if (sel.kind === "enemy") {
      const obj = this.entityObj(sel.kind, sel.id);
      this.appendFeatureDropFields(obj?.kind || "npc", "instance", sel.id, sel, fields, actions, obj?.modelId);
    }
    // Any object (house/prop/tree/rock) can be turned into a goblin spawner.
    if (spawnable(sel.kind)) this.appendSpawnerFields(sel, fields, actions);
    this.inspector.setSelection(`${sel.kind} · ${shortId(sel.id)}`, fields, actions);
  }

  /** Shared HP + alive fields for any damageable entity (tree/rock/house/structure).
   *  HP is stored on the feature config (`scope`/`key` — kind-level for resources,
   *  MODEL-level for structures so every instance shares it) and pushed live to the
   *  selected entity via dev_set. Unifies what used to be duplicated per kind. */
  private appendDamageableFields(
    kind: string,
    scope: "default" | "instance",
    key: string,
    id: string,
    obj: EntityView | null,
    hpStep: number,
    fields: Field[],
  ) {
    const cfg = this.feature(scope, key);
    fields.push({
      kind: "number",
      label: "HP",
      value: obj?.maxHp ?? cfg.hp ?? 0,
      min: 0,
      step: hpStep,
      onChange: (v) => {
        cfg.hp = Math.max(0, Math.round(v));
        this.net.sendDevSet(kind, id, "maxHp", cfg.hp);
        this.scheduleFeatureSave(scope, key);
      },
    });
    fields.push({
      kind: "checkbox",
      label: "alive",
      value: !!obj?.alive,
      onChange: (on) => this.net.sendDevSet(kind, id, "alive", on),
    });
  }

  private appendStructureMaskFields(sel: Selectable, fields: Field[], actions: Action[]) {
    const kind = structureKind(sel.kind);
    if (!kind) return;
    const cfg = this.structureCfg(kind);
    const mask = cfg.mask ?? this.game?.structureMaskFor(kind) ?? defaultStructureMask(kind);
    const editing = this.maskEdit?.kind === kind && this.maskEdit.sel.id === sel.id;
    fields.push({
      kind: "readonly",
      label: "pick mask",
      value: `${mask.points.length} vertices${cfg.mask ? "" : " (default)"}`,
    });
    actions.push({
      label: editing ? "Done mask" : "Edit mask",
      onClick: () => {
        if (editing) {
          this.saveMaskEdit();
          this.stopMaskEdit();
          this.showSelection(sel);
        } else {
          this.beginMaskEdit(sel, kind);
        }
      },
    });
    actions.push({
      label: "Reset mask",
      onClick: () => this.resetStructureMask(sel, kind),
    });
    if (editing) {
      actions.push({
        label: "Delete vertex",
        danger: true,
        onClick: () => this.deleteSelectedMaskVertex(),
      });
    }
  }

  private beginMaskEdit(sel: Selectable, kind: string) {
    this.stopMaskEdit();
    const mask = cloneStructureMask(this.structureCfg(kind).mask ?? this.game?.structureMaskFor(kind) ?? defaultStructureMask(kind));
    this.maskEdit = { kind, sel, mask, selectedIndex: 0, line: null, vertices: [] };
    this.maskDrag = false;
    this.renderMaskEdit();
    this.setCursor("crosshair");
    this.showSelection(sel);
  }

  private resetStructureMask(sel: Selectable, kind: string) {
    const cfg = this.structureCfg(kind);
    delete cfg.mask;
    this.game?.setStructureMask(kind, null);
    if (this.maskEdit?.kind === kind) {
      this.maskEdit.mask = this.game?.structureMaskFor(kind) ?? defaultStructureMask(kind);
      this.maskEdit.selectedIndex = 0;
      this.renderMaskEdit();
    }
    this.scheduleStructureSave(kind);
    this.showSelection(sel);
  }

  private stopMaskEdit() {
    this.disposeMaskEditMeshes();
    this.maskEdit = null;
    this.maskDrag = false;
  }

  private maskPointerDown(point: Vector3 | null): boolean {
    const edit = this.maskEdit;
    if (!edit || !point) return true;
    const local = this.maskLocalPoint(edit, point);
    const v = nearestVertex(edit.mask.points, local);
    if (v.index >= 0 && v.dist <= MASK_VERTEX_HIT) {
      edit.selectedIndex = v.index;
      this.maskDrag = true;
      this.renderMaskEdit();
      return true;
    }
    const edge = nearestEdge(edit.mask.points, local);
    if (edge.index >= 0 && edge.dist <= MASK_EDGE_HIT) {
      edit.mask.points.splice(edge.index + 1, 0, { x: round(local.x), z: round(local.z) });
      edit.selectedIndex = edge.index + 1;
      this.maskDrag = true;
      this.saveMaskEdit();
      this.renderMaskEdit();
      this.showSelection(edit.sel);
      return true;
    }
    return true;
  }

  private maskPointerMove(point: Vector3 | null): boolean {
    const edit = this.maskEdit;
    if (!edit) return false;
    if (this.maskDrag && point && edit.selectedIndex >= 0) {
      const local = this.maskLocalPoint(edit, point);
      edit.mask.points[edit.selectedIndex] = { x: round(local.x), z: round(local.z) };
      this.saveMaskEdit();
      this.renderMaskEdit();
    }
    this.setCursor(this.maskDrag ? "grabbing" : "crosshair");
    return true;
  }

  private deleteSelectedMaskVertex() {
    const edit = this.maskEdit;
    if (!edit || edit.mask.points.length <= 3 || edit.selectedIndex < 0) return;
    edit.mask.points.splice(edit.selectedIndex, 1);
    edit.selectedIndex = Math.min(edit.selectedIndex, edit.mask.points.length - 1);
    this.saveMaskEdit();
    this.renderMaskEdit();
    this.showSelection(edit.sel);
  }

  private saveMaskEdit() {
    const edit = this.maskEdit;
    if (!edit) return;
    const mask = normalizeStructureMask(edit.mask);
    if (!mask) return;
    const cfg = this.structureCfg(edit.kind);
    cfg.mask = cloneStructureMask(mask);
    this.game?.setStructureMask(edit.kind, cfg.mask);
    this.scheduleStructureSave(edit.kind);
  }

  private renderMaskEdit() {
    const edit = this.maskEdit;
    if (!edit) return;
    this.disposeMaskEditMeshes();
    this.ensureMaskMaterials();
    const center = edit.sel.root.position;
    const points = edit.mask.points.map((p) => new Vector3(center.x + p.x, 0.08, center.z + p.z));
    points.push(points[0].clone());
    const line = MeshBuilder.CreateLines(`maskLine-${edit.kind}-${edit.sel.id}`, { points }, this.scene);
    line.color = new Color3(0.2, 0.95, 0.75);
    line.isPickable = false;
    edit.line = line;
    edit.vertices = edit.mask.points.map((p, i) => {
      const box = MeshBuilder.CreateBox(`maskVertex-${edit.kind}-${i}`, { size: i === edit.selectedIndex ? 0.48 : 0.36 }, this.scene);
      box.position.set(center.x + p.x, 0.14, center.z + p.z);
      box.material = i === edit.selectedIndex ? this.maskSelectedMat : this.maskMat;
      box.isPickable = false;
      return box;
    });
  }

  private disposeMaskEditMeshes() {
    const edit = this.maskEdit;
    if (!edit) return;
    edit.line?.dispose();
    for (const v of edit.vertices) v.dispose();
    edit.line = null;
    edit.vertices = [];
  }

  private ensureMaskMaterials() {
    if (!this.maskMat) {
      this.maskMat = new StandardMaterial("devMaskVertex", this.scene);
      this.maskMat.diffuseColor = new Color3(0.12, 0.8, 0.65);
      this.maskMat.emissiveColor = new Color3(0.04, 0.25, 0.2);
      this.maskMat.specularColor = new Color3(0, 0, 0);
    }
    if (!this.maskSelectedMat) {
      this.maskSelectedMat = new StandardMaterial("devMaskVertexSelected", this.scene);
      this.maskSelectedMat.diffuseColor = new Color3(1, 0.82, 0.2);
      this.maskSelectedMat.emissiveColor = new Color3(0.35, 0.22, 0.02);
      this.maskSelectedMat.specularColor = new Color3(0, 0, 0);
    }
  }

  private maskLocalPoint(edit: MaskEditState, point: Vector3): MaskPoint {
    return { x: point.x - edit.sel.root.position.x, z: point.z - edit.sel.root.position.z };
  }

  // ---- generic feature config (HP / drops / brain / stats) ----
  private features: EntityFeatureManifest = { defaults: {}, instances: {} };
  private featureSaveTimer: ReturnType<typeof setTimeout> | null = null;

  async loadFeatures() {
    try {
      this.features = (await (await fetch("/__features/list", { cache: "no-store" })).json()) as EntityFeatureManifest;
      this.features.defaults ??= {};
      this.features.instances ??= {};
    } catch {
      this.features = { defaults: {}, instances: {} };
    }
  }

  private async loadCharacterDefs() {
    try {
      this.characterDefs = (await (await fetch("/__char/defs", { cache: "no-store" })).json()) as CharacterDef[];
    } catch {
      this.characterDefs = [];
    }
  }

  private feature(scope: "default" | "instance", key: string): EntityFeatureCfg {
    const bucket = scope === "default" ? (this.features.defaults ??= {}) : (this.features.instances ??= {});
    let cfg = bucket[key];
    if (!cfg) {
      cfg = {};
      bucket[key] = cfg;
    }
    return cfg;
  }

  private mergedFeature(kind: string, id: string, modelId?: string): EntityFeatureCfg {
    const d = this.features.defaults ?? {};
    const i = this.features.instances ?? {};
    return {
      ...(d[kind] ?? {}),
      ...(modelId ? d[modelId] ?? {} : {}),
      ...(i[id] ?? {}),
      stats: {
        ...((d[kind]?.stats ?? {}) as CharacterStatsCfg),
        ...((modelId ? d[modelId]?.stats ?? {} : {}) as CharacterStatsCfg),
        ...((i[id]?.stats ?? {}) as CharacterStatsCfg),
      },
      drops: i[id]?.drops ?? (modelId ? d[modelId]?.drops : undefined) ?? d[kind]?.drops,
    };
  }

  private scheduleFeatureSave(scope: "default" | "instance", key: string) {
    if (this.featureSaveTimer) clearTimeout(this.featureSaveTimer);
    this.featureSaveTimer = setTimeout(() => void this.saveFeature(scope, key), 300);
  }

  private async saveFeature(scope: "default" | "instance", key: string) {
    const config = scope === "default" ? this.features.defaults?.[key] : this.features.instances?.[key];
    if (!config) return;
    await fetch("/__features/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, key, config }),
    }).catch((e) => console.warn("[features] save failed", e));
  }

  private appendCharacterFields(sel: Selectable, obj: EntityView, fields: Field[]) {
    const kind = sel.kind === "player" ? "player" : obj.kind || "npc";
    const cfg = this.feature("instance", sel.id);
    const stats = cfg.stats ?? (cfg.stats = {});
    const saveStat = (field: keyof CharacterStatsCfg, value: number) => {
      stats[field] = Math.max(0, value);
      if (field === "maxHp") cfg.hp = stats.maxHp;
      this.net.sendDevSet(sel.kind, sel.id, field === "maxHp" ? "maxHp" : field, stats[field] ?? 0);
      this.scheduleFeatureSave("instance", sel.id);
    };
    fields.push({ kind: "readonly", label: "kind", value: kind });
    if (sel.kind === "enemy") {
      fields.push({
        kind: "select",
        label: "brain",
        value: (obj.brain || cfg.brain || (kind === "goblin" ? "attacks_home" : "idle")) as string,
        options: BRAIN_OPTIONS,
        onChange: (v) => {
          cfg.brain = v;
          this.net.sendDevSet("enemy", sel.id, "brain", v);
          this.scheduleFeatureSave("instance", sel.id);
        },
      });
    }
    fields.push(
      { kind: "number", label: "level", value: obj.level ?? stats.level ?? 1, min: 1, step: 1, onChange: (v) => saveStat("level", Math.max(1, Math.round(v))) },
      { kind: "number", label: "HP", value: obj.maxHp ?? stats.maxHp ?? 0, min: 0, step: 5, onChange: (v) => saveStat("maxHp", Math.max(0, Math.round(v))) },
      { kind: "number", label: "current HP", value: obj.hp ?? obj.maxHp ?? 0, min: 0, step: 5, onChange: (v) => this.net.sendDevSet(sel.kind, sel.id, "hp", Math.max(0, Math.round(v))) },
      { kind: "number", label: "attack", value: obj.attack ?? stats.attack ?? 0, min: 0, step: 1, onChange: (v) => saveStat("attack", v) },
      { kind: "number", label: "armor", value: obj.armor ?? stats.armor ?? 0, min: 0, step: 1, onChange: (v) => saveStat("armor", v) },
      { kind: "number", label: "crit %", value: Math.round(((obj.critChance ?? stats.critChance ?? 0) * 100)), min: 0, max: 100, step: 1, onChange: (v) => saveStat("critChance", Math.max(0, Math.min(100, v)) / 100) },
      { kind: "number", label: "move spd", value: obj.moveSpeed ?? stats.moveSpeed ?? 0, min: 0, step: 0.25, onChange: (v) => saveStat("moveSpeed", v) },
      { kind: "number", label: "throw pow", value: obj.throwPower ?? stats.throwPower ?? 1, min: 0, step: 0.1, onChange: (v) => saveStat("throwPower", v) },
    );
    if ((obj.maxHp ?? 0) <= 0) fields.push({ kind: "readonly", label: "note", value: "HP 0 = unkillable" });
  }

  private appendFeatureDropFields(
    kind: string,
    scope: "default" | "instance",
    key: string,
    sel: Selectable,
    fields: Field[],
    actions: Action[],
    modelId?: string,
  ) {
    const cfg = this.feature(scope, key);
    if (!cfg.drops) {
      const merged = this.mergedFeature(kind, key, modelId);
      cfg.drops = merged.drops ? merged.drops.map((d) => ({ ...d })) : [];
    }
    const drops = cfg.drops;
    fields.push({
      kind: "readonly",
      label: "drops",
      value: drops.length ? `${drops.length} rule${drops.length === 1 ? "" : "s"}` : "(none)",
    });
    drops.forEach((drop, i) => {
      fields.push({
        kind: "select",
        label: `drop ${i + 1}`,
        value: drop.item,
        options: [...DROP_ITEMS, { value: "__remove__", label: "Remove" }],
        onChange: (v) => {
          if (v === "__remove__") {
            drops.splice(i, 1);
            this.scheduleFeatureSave(scope, key);
            this.showSelection(sel);
            return;
          }
          drop.item = v;
          this.scheduleFeatureSave(scope, key);
        },
      });
      fields.push(
        { kind: "number", label: "quantity", value: drop.quantity, min: 0, step: 1, onChange: (v) => { drop.quantity = Math.max(0, Math.round(v)); this.scheduleFeatureSave(scope, key); this.showSelection(sel); } },
        { kind: "number", label: "% chance", value: Math.round(drop.probability * 100), min: 0, max: 100, step: 5, onChange: (v) => { drop.probability = Math.max(0, Math.min(100, v)) / 100; this.scheduleFeatureSave(scope, key); } },
        {
          kind: "select",
          label: "trigger",
          value: drop.trigger,
          options: [
            { value: "kill", label: "On kill" },
            { value: "damage", label: "By damage" },
          ],
          onChange: (v) => {
            drop.trigger = v === "damage" ? "damage" : "kill";
            this.scheduleFeatureSave(scope, key);
            this.showSelection(sel);
          },
        },
      );
      if (drop.trigger === "damage") {
        const hp = this.entityObj(sel.kind, sel.id)?.maxHp ?? this.mergedFeature(kind, key, modelId).hp ?? 0;
        fields.push({ kind: "readonly", label: "dmg / item", value: (hp / Math.max(1, drop.quantity)).toFixed(1) });
      }
    });
    actions.push({
      label: "＋ Add drop",
      onClick: () => {
        drops.push({ item: "log", quantity: 1, probability: 1, trigger: "kill" });
        this.scheduleFeatureSave(scope, key);
        this.showSelection(sel);
      },
    });
  }

  // ---- spawners (objects that spawn other entities) ----
  private spawners = new Map<string, SpawnerCfg[]>();
  private spawnerSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pull the current spawner configs so the inspector reflects them. */
  async loadSpawners() {
    try {
      const list = (await (await fetch("/__spawners/list", { cache: "no-store" })).json()) as SpawnerCfg[];
      this.spawners.clear();
      for (const raw of list) {
        if (!raw.ownerId) continue;
        const s = { ...raw, type: raw.type ?? "goblin", behavior: raw.behavior ?? {} };
        const owner = s.ownerId;
        const arr = this.spawners.get(owner) ?? [];
        arr.push(s);
        this.spawners.set(owner, arr);
      }
    } catch {
      /* no dev endpoint — nothing to load */
    }
  }

  /** Append spawn rules to an object's inspector. Each selected owner can have
   *  multiple rules, each with its own target type, frequency, cap and behavior. */
  private appendSpawnerFields(sel: Selectable, fields: Field[], actions: Action[]) {
    // A concrete prop keys its spawner by MODEL, so every instance of that model
    // shares it (a new goblin house spawns goblins like the others). Everything
    // else keys per-instance.
    const def = sel.kind === "prop" ? this.propManager.get(sel.id)?.def : undefined;
    const ownerKey = def && (def.collisionRadius ?? 0) > 0 ? def.model || sel.id : sel.id;
    const rules = this.spawners.get(ownerKey) ?? [];
    fields.push({
      kind: "readonly",
      label: "spawn rules",
      value: rules.length ? `${rules.length}` : "(none)",
    });
    rules.forEach((sp, index) => {
      const b = sp.behavior ?? (sp.behavior = {});
      const stats = b.stats ?? (b.stats = {});
      const spawnValue = sp.modelId ? `character:${sp.modelId}` : sp.type ?? "goblin";
      fields.push({
        kind: "select",
        label: `spawn ${index + 1}`,
        value: spawnValue,
        options: [...BASE_SPAWN_TYPES, ...this.characterDefs.map((d) => ({ value: `character:${d.id}`, label: d.name || d.id }))],
        onChange: (v) => {
          if (v.startsWith("character:")) {
            const defId = v.slice("character:".length);
            const def = this.characterDefs.find((d) => d.id === defId);
            sp.type = "npc";
            sp.modelId = defId;
            sp.label = def?.name || defId;
            b.modelId = defId;
            b.label = sp.label;
          } else {
            sp.type = v;
            sp.modelId = undefined;
            sp.label = undefined;
            b.modelId = undefined;
            b.label = undefined;
          }
          this.scheduleSpawnerSave(sp.id);
          this.showSelection(sel);
        },
      });
      fields.push(this.spawnerNum("interval s", sp.intervalMs / 1000, 0.5, (v) => (sp.intervalMs = Math.max(200, Math.round(v * 1000))), sp));
      fields.push(this.spawnerNum("max alive", sp.cap, 1, (v) => (sp.cap = Math.max(0, Math.round(v))), sp));
      fields.push({
        kind: "select",
        label: "brain",
        value: b.brain ?? "attacks_home",
        options: BRAIN_OPTIONS,
        onChange: (v) => {
          b.brain = v;
          this.scheduleSpawnerSave(sp.id);
        },
      });
      fields.push(
        this.spawnerNum("hp", stats.maxHp ?? b.hp ?? 0, 5, (v) => { stats.maxHp = v || undefined; b.hp = v || undefined; }, sp),
        this.spawnerNum("attack", stats.attack ?? b.attack ?? 0, 5, (v) => { stats.attack = v || undefined; b.attack = v || undefined; }, sp),
        this.spawnerNum("armor", stats.armor ?? 0, 1, (v) => (stats.armor = v || undefined), sp),
        this.spawnerNum("move spd", stats.moveSpeed ?? b.chaseSpeed ?? 0, 0.25, (v) => { stats.moveSpeed = v || undefined; b.chaseSpeed = v || undefined; }, sp),
        this.spawnerNum("atk cd ms", b.attackCooldownMs ?? 0, 100, (v) => (b.attackCooldownMs = v || undefined), sp),
      );
      fields.push({
        kind: "select",
        label: "remove spawn",
        value: "keep",
        options: [
          { value: "keep", label: "Keep" },
          { value: "remove", label: "Remove" },
        ],
        onChange: (v) => {
          if (v !== "remove") return;
          void this.deleteSpawner(sp.id);
          const next = (this.spawners.get(ownerKey) ?? []).filter((s) => s.id !== sp.id);
          if (next.length) this.spawners.set(ownerKey, next);
          else this.spawners.delete(ownerKey);
          this.showSelection(sel);
        },
      });
    });
    actions.push({
      label: "＋ Add spawn",
      onClick: () => {
        const id = `${sel.id}-spawn-${Date.now().toString(36)}`;
        const sp: SpawnerCfg = {
          id,
          ownerId: ownerKey,
          type: "goblin",
          intervalMs: 4000,
          cap: 3,
          behavior: { brain: "attacks_home", stats: {} },
        };
        const next = [...(this.spawners.get(ownerKey) ?? []), sp];
        this.spawners.set(ownerKey, next);
        void this.saveSpawner(id);
        this.showSelection(sel);
      },
    });
  }

  private spawnerNum(label: string, value: number, step: number, set: (v: number) => void, sp: SpawnerCfg): Field {
    return {
      kind: "number",
      label,
      value,
      min: 0,
      step,
      onChange: (v) => {
        set(v);
        this.scheduleSpawnerSave(sp.id);
      },
    };
  }

  private async saveSpawner(id: string) {
    let sp: SpawnerCfg | undefined;
    for (const list of this.spawners.values()) {
      sp = list.find((s) => s.id === id);
      if (sp) break;
    }
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
  private async deleteSpawnersForOwner(ownerId: string) {
    this.spawners.delete(ownerId);
    await fetch("/__spawners/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerId }),
    }).catch((e) => console.warn("[spawner] owner delete failed", e));
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
        : { item: "stone", amount: 11, trigger: "hit", hp: 560 };
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

  // ---- structure config (input masks + legacy loot tables) ----
  private structures = new Map<string, StructureCfg>(); // keyed by structure kind ("house")
  private structureSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pull the current per-structure loot tables so the inspector reflects them. */
  async loadStructures() {
    try {
      const map = (await (await fetch("/__structures/list", { cache: "no-store" })).json()) as Record<string, { loot?: LootEntry[]; mask?: unknown }>;
      this.structures.clear();
      for (const [k, v] of Object.entries(map || {})) {
        const cfg: StructureCfg = { loot: Array.isArray(v?.loot) ? v.loot : [] };
        const mask = normalizeStructureMask(v?.mask);
        if (mask) cfg.mask = mask;
        this.structures.set(k, cfg);
        this.game?.setStructureMask(k, mask);
      }
    } catch {
      /* no dev endpoint — nothing to load */
    }
  }

  private structureCfg(kind: string): StructureCfg {
    let cfg = this.structures.get(kind);
    if (!cfg) {
      cfg = { loot: [] };
      this.structures.set(kind, cfg);
    }
    return cfg;
  }

  /** The loot table for a structure kind (a stable, mutable array the editor edits). */
  private structureLoot(kind: string): LootEntry[] {
    let l = this.structureCfg(kind).loot;
    if (!l) {
      l = [];
      this.structureCfg(kind).loot = l;
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
    const cfg = this.structureCfg(kind);
    await fetch("/__structures/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, loot: cfg.loot ?? [], mask: cfg.mask ?? null }),
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
    const map =
      kind === "tree"
        ? st.trees
        : kind === "player"
          ? st.players
        : kind === "potion"
          ? st.potions
          : kind === "enemy"
            ? st.enemies
            : kind === "rock"
              ? st.rocks
              : kind === "log"
                ? st.logs
                : kind === "stone"
                  ? st.stones
                  : kind === "banana"
                    ? st.bananas
                    : kind === "item"
                      ? st.items
                      : kind === "house"
                        ? st.houses
                        : kind === "structure"
                          ? st.structures
                          : undefined;
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
  kind?: string;
  itemId?: string;
  modelId?: string;
  displayName?: string;
  brain?: string;
  attack?: number;
  armor?: number;
  critChance?: number;
  moveSpeed?: number;
  throwPower?: number;
}

interface StructureCfg {
  loot: LootEntry[];
  mask?: StructureMask;
}

interface MaskEditState {
  kind: string;
  sel: Selectable;
  mask: StructureMask;
  selectedIndex: number;
  line: Mesh | null;
  vertices: Mesh[];
}

const round = (v: number) => Math.round(v * 10) / 10;
const deg = (r: number) => Math.round((r * 180) / Math.PI);
const MASK_VERTEX_HIT = 0.65;
const MASK_EDGE_HIT = 0.5;

const structureKind = (kind: string): string | null => (kind === "house" ? "house" : null);

function nearestVertex(points: MaskPoint[], p: MaskPoint): { index: number; dist: number } {
  let index = -1;
  let dist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i].x - p.x, points[i].z - p.z);
    if (d < dist) {
      index = i;
      dist = d;
    }
  }
  return { index, dist };
}

function nearestEdge(points: MaskPoint[], p: MaskPoint): { index: number; dist: number } {
  let index = -1;
  let dist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = pointSegmentDistance(p, points[i], points[(i + 1) % points.length]);
    if (d < dist) {
      index = i;
      dist = d;
    }
  }
  return { index, dist };
}

function pointSegmentDistance(p: MaskPoint, a: MaskPoint, b: MaskPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 <= 1e-8) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

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

/** Kinds the editor can relocate by dragging. The house is rendered as the
 *  seeded home objective for now, and players are session-driven. */
const draggable = (kind: string) =>
  kind === "prop" || kind === "character" || editableSynced(kind);

/** Kinds that can continue placing copies with Shift held on drop. */
const copyable = (kind: string) =>
  kind === "prop" || kind === "character" || editableSynced(kind);

/** Synced runtime entities that Dev Mode can move/delete through the server. */
const editableSynced = (kind: string) =>
  kind === "tree" ||
  kind === "enemy" ||
  kind === "rock" ||
  kind === "potion" ||
  kind === "log" ||
  kind === "stone" ||
  kind === "banana" ||
  kind === "item" ||
  kind === "house";

const spawnKindFor = (kind: string, obj: EntityView | null): string => {
  if (kind === "enemy") return obj?.kind === "goblin" ? "goblin" : "dummy";
  if (kind === "potion") return obj?.kind === "berserker_potion" ? "berserker_potion" : "potion";
  if (kind === "item") return `item:${obj?.itemId || ""}`;
  return kind;
};

const focusKindForSpawn = (kind: string): string =>
  kind === "goblin" || kind === "dummy"
    ? "enemy"
    : kind === "berserker_potion"
      ? "potion"
      : kind.startsWith("item:")
        ? "item"
        : kind;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const nameFromModel = (model: string) => model.split("/").pop()?.replace(/\.glb$/i, "") || model;

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
  { value: "berserker_potion", label: "Berserker Potion" },
];

const BRAIN_OPTIONS = [
  { value: "idle", label: "Idle" },
  { value: "passive_patrol", label: "Passive patrol" },
  { value: "war_seeker", label: "War seeker" },
  { value: "attacks_home", label: "Attacks home" },
];

const BASE_SPAWN_TYPES = [
  { value: "goblin", label: "Goblin" },
  { value: "dummy", label: "Dummy" },
  { value: "potion", label: "Potion" },
  { value: "berserker_potion", label: "Berserker Potion" },
  { value: "banana", label: "Banana" },
  { value: "log", label: "Log" },
  { value: "stone", label: "Stone" },
  { value: "tree", label: "Tree" },
  { value: "rock", label: "Rock" },
];

interface GameplayAction {
  id: DevActionId;
  label: string;
  danger?: boolean;
}

const DEV_GLOBAL_ACTIONS: GameplayAction[] = [
  { id: "reset_realm", label: "Start Over", danger: true },
  { id: "force_next_wave", label: "Next Wave" },
  { id: "previous_wave", label: "Previous Wave" },
  { id: "kill_all_enemies", label: "Kill Enemies", danger: true },
  { id: "kick_players", label: "Kick Players", danger: true },
  { id: "level_up_player", label: "Level Up Current Player" },
];

type GameplayCategory = "Waves" | "Player" | "Combat" | "Resources";

interface WaveEntryUI {
  kind: string;
  count: number;
  brain: BrainId;
  level?: number;
}
interface WaveDefUI {
  number: number;
  entries: WaveEntryUI[];
}

interface TuningControl {
  key: DevTuningKey;
  label: string;
  category: GameplayCategory;
  section: string;
  description: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  scale: number;
  integer?: boolean;
}

const sec = 1000;
const DEV_TUNING_CONTROLS: TuningControl[] = [
  // ===================== WAVES =====================
  {
    key: "waveFirstDelayMs",
    label: "First wave delay",
    category: "Waves",
    section: "Wave timing",
    description: "Grace period before the very first goblin wave marches in.",
    defaultValue: WAVE_FIRST_DELAY_MS,
    min: 0,
    max: 600,
    step: 1,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "waveIntervalBaseMs",
    label: "Rest base",
    category: "Waves",
    section: "Wave timing",
    description: "Calm time after wave 1 before the next wave starts.",
    defaultValue: WAVE_INTERVAL_BASE_MS,
    min: 0,
    max: 900,
    step: 1,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "waveIntervalStepMs",
    label: "Rest per wave",
    category: "Waves",
    section: "Wave timing",
    description: "Extra rest added after each successive wave (escalation).",
    defaultValue: WAVE_INTERVAL_STEP_MS,
    min: 0,
    max: 300,
    step: 1,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "waveIntervalMaxMs",
    label: "Rest max",
    category: "Waves",
    section: "Wave timing",
    description: "Upper limit on how long the rest between waves can grow.",
    defaultValue: WAVE_INTERVAL_MAX_MS,
    min: 0,
    max: 1800,
    step: 1,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "waveSpawnSpreadMs",
    label: "Spawn spread",
    category: "Waves",
    section: "Wave timing",
    description: "Window over which a wave's goblins trickle in (vs. all at once).",
    defaultValue: WAVE_SPAWN_SPREAD_MS,
    min: 0,
    max: 300,
    step: 1,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "waveSizeBase",
    label: "Size base",
    category: "Waves",
    section: "Wave size",
    description: "Goblins in the first wave before any scaling.",
    defaultValue: WAVE_SIZE_BASE,
    min: 0,
    max: 200,
    step: 1,
    unit: "",
    scale: 1,
    integer: true,
  },
  {
    key: "waveSizePerPlayer",
    label: "Per player",
    category: "Waves",
    section: "Wave size",
    description: "Extra goblins added for each live defender.",
    defaultValue: WAVE_SIZE_PER_PLAYER,
    min: 0,
    max: 50,
    step: 1,
    unit: "",
    scale: 1,
    integer: true,
  },
  {
    key: "waveSizePerWave",
    label: "Per wave",
    category: "Waves",
    section: "Wave size",
    description: "Extra goblins added for each wave number (difficulty ramp).",
    defaultValue: WAVE_SIZE_PER_WAVE,
    min: 0,
    max: 50,
    step: 1,
    unit: "",
    scale: 1,
    integer: true,
  },
  {
    key: "waveSizeMax",
    label: "Size max",
    category: "Waves",
    section: "Wave size",
    description: "Hard cap on the number of goblins in a single wave.",
    defaultValue: WAVE_SIZE_MAX,
    min: 1,
    max: 500,
    step: 1,
    unit: "",
    scale: 1,
    integer: true,
  },
  {
    key: "goblinLiveCap",
    label: "Live cap",
    category: "Waves",
    section: "Wave size",
    description: "Max goblins alive at once; the next wave waits if exceeded.",
    defaultValue: GOBLIN_LIVE_CAP,
    min: 0,
    max: 500,
    step: 1,
    unit: "",
    scale: 1,
    integer: true,
  },

  // ===================== PLAYER =====================
  {
    key: "playerMaxHp",
    label: "Starting HP",
    category: "Player",
    section: "Starting stats",
    description: "Health a fresh (level 1) player spawns with.",
    defaultValue: PLAYER_MAX_HP,
    min: 1,
    max: 100000,
    step: 1,
    unit: "hp",
    scale: 1,
    integer: true,
  },
  {
    key: "playerAttack",
    label: "Starting attack",
    category: "Player",
    section: "Starting stats",
    description: "Base attack power before armor mitigation and level growth.",
    defaultValue: PLAYER_ATTACK,
    min: 0,
    max: 100000,
    step: 1,
    unit: "",
    scale: 1,
  },
  {
    key: "playerArmor",
    label: "Starting armor",
    category: "Player",
    section: "Starting stats",
    description: "Damage mitigation; higher armor means incoming hits hurt less.",
    defaultValue: PLAYER_ARMOR,
    min: 0,
    max: 100000,
    step: 1,
    unit: "",
    scale: 1,
  },
  {
    key: "playerCritChance",
    label: "Crit chance",
    category: "Player",
    section: "Starting stats",
    description: "Chance for a player hit to land a critical (extra-damage) blow.",
    defaultValue: PLAYER_CRIT_CHANCE,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    scale: 0.01,
  },
  {
    key: "playerMoveSpeed",
    label: "Move speed",
    category: "Player",
    section: "Starting stats",
    description: "Base walking/running speed in world units per second.",
    defaultValue: MOVE_SPEED,
    min: 0.1,
    max: 100,
    step: 0.1,
    unit: "u/s",
    scale: 1,
  },
  {
    key: "sprintSpeedMult",
    label: "Sprint multiplier",
    category: "Player",
    section: "Starting stats",
    description: "Speed multiplier while sprinting (drains stamina).",
    defaultValue: SPRINT_SPEED_MULT,
    min: 1,
    max: 10,
    step: 0.05,
    unit: "×",
    scale: 1,
  },
  {
    key: "playerRespawnMs",
    label: "Respawn delay",
    category: "Player",
    section: "Respawn",
    description: "Time a dead player waits before returning to the fight.",
    defaultValue: PLAYER_RESPAWN_MS,
    min: 0,
    max: 120,
    step: 0.5,
    unit: "s",
    scale: sec,
    integer: true,
  },

  // ===================== COMBAT =====================
  {
    key: "playerAttackCooldownMs",
    label: "Player cooldown",
    category: "Combat",
    section: "Player attack",
    description: "Minimum time between consecutive player swings.",
    defaultValue: ATTACK_COOLDOWN_MS,
    min: 0,
    max: 10,
    step: 0.05,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "playerAttackWindupMs",
    label: "Player windup",
    category: "Combat",
    section: "Player attack",
    description: "Delay from starting a swing until the hit actually lands.",
    defaultValue: ATTACK_WINDUP_MS,
    min: 0,
    max: 5,
    step: 0.05,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "enemyMaxHp",
    label: "Enemy HP",
    category: "Combat",
    section: "Enemy stats",
    description: "Base goblin health (scaled up by goblin level).",
    defaultValue: GOBLIN_MAX_HP,
    min: 1,
    max: 100000,
    step: 1,
    unit: "hp",
    scale: 1,
    integer: true,
  },
  {
    key: "enemyAttack",
    label: "Enemy attack",
    category: "Combat",
    section: "Enemy stats",
    description: "Base goblin attack power before player armor and divisor.",
    defaultValue: GOBLIN_ATTACK,
    min: 0,
    max: 100000,
    step: 1,
    unit: "",
    scale: 1,
  },
  {
    key: "enemyMoveSpeed",
    label: "Enemy speed",
    category: "Combat",
    section: "Enemy stats",
    description: "Goblin chase speed in world units per second.",
    defaultValue: GOBLIN_CHASE_SPEED,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "u/s",
    scale: 1,
  },
  {
    key: "enemyAttackCooldownMs",
    label: "Enemy cooldown",
    category: "Combat",
    section: "Enemy attack",
    description: "Minimum time between goblin swings.",
    defaultValue: GOBLIN_ATTACK_COOLDOWN_MS,
    min: 0,
    max: 20,
    step: 0.05,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "enemyAttackWindupMs",
    label: "Enemy windup",
    category: "Combat",
    section: "Enemy attack",
    description: "Delay from a goblin starting a swing until its hit lands.",
    defaultValue: GOBLIN_ATTACK_WINDUP_MS,
    min: 0,
    max: 10,
    step: 0.05,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "enemyAttackRange",
    label: "Enemy range",
    category: "Combat",
    section: "Enemy attack",
    description: "How close a goblin must be to land a melee hit.",
    defaultValue: GOBLIN_ATTACK_RANGE,
    min: 0.2,
    max: 20,
    step: 0.1,
    unit: "u",
    scale: 1,
  },
  {
    key: "enemyAggroRadius",
    label: "Aggro radius",
    category: "Combat",
    section: "Enemy brain",
    description: "Range at which a goblin notices and starts chasing a player.",
    defaultValue: GOBLIN_AGGRO_RADIUS,
    min: 0,
    max: 80,
    step: 0.5,
    unit: "u",
    scale: 1,
  },
  {
    key: "enemyDeaggroRadius",
    label: "Deaggro radius",
    category: "Combat",
    section: "Enemy brain",
    description: "Range at which a chasing goblin gives up and returns home.",
    defaultValue: GOBLIN_DEAGGRO_RADIUS,
    min: 0,
    max: 120,
    step: 0.5,
    unit: "u",
    scale: 1,
  },
  {
    key: "goblinHouseDamage",
    label: "House damage",
    category: "Combat",
    section: "Enemy brain",
    description: "Damage each goblin swing deals to the house (La Crypta).",
    defaultValue: GOBLIN_HOUSE_DAMAGE,
    min: 0,
    max: 1000,
    step: 1,
    unit: "hp",
    scale: 1,
  },
  {
    key: "damageDivisor",
    label: "Damage divisor",
    category: "Combat",
    section: "Damage",
    description: "Global divisor on all computed damage; higher = softer combat.",
    defaultValue: DAMAGE_DIVISOR,
    min: 0.1,
    max: 100,
    step: 0.1,
    unit: "",
    scale: 1,
  },
  {
    key: "berserkerAttackMult",
    label: "Berserker attack",
    category: "Combat",
    section: "Berserker buff",
    description: "Attack multiplier while the berserker potion buff is active.",
    defaultValue: BERSERKER_ATTACK_MULT,
    min: 1,
    max: 50,
    step: 0.1,
    unit: "×",
    scale: 1,
  },
  {
    key: "berserkerDurationMs",
    label: "Berserker duration",
    category: "Combat",
    section: "Berserker buff",
    description: "How long the berserker potion buff lasts.",
    defaultValue: BERSERKER_DURATION_MS,
    min: 0,
    max: 600,
    step: 1,
    unit: "s",
    scale: sec,
    integer: true,
  },
  {
    key: "dropRateMult",
    label: "Drop rate",
    category: "Resources",
    section: "Drops",
    description: "Global multiplier on ALL drop chances (loot, bananas, potions).",
    defaultValue: DROP_RATE_MULT,
    min: 0,
    max: 10,
    step: 0.1,
    unit: "×",
    scale: 1,
  },
];

const formatTuning = (v: number) =>
  Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, "");

/** A small muted field-label span for popups. */
const textSpan = (text: string): HTMLElement => {
  const s = document.createElement("span");
  s.textContent = text;
  s.style.cssText = "font:11px system-ui,sans-serif;";
  return s;
};

const clampInt = (s: string, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(Number(s) || min)));

const numberInput = (value: number, min: number, max: number, step: number, width = "86px"): HTMLInputElement => {
  const i = document.createElement("input");
  i.type = "number";
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(value);
  i.style.cssText =
    `width:${width}; box-sizing:border-box; background:#0c1018; color:#e8e8e8; border:1px solid #3a4658;` +
    "border-radius:5px; padding:4px 5px; text-align:right; font:12px system-ui,sans-serif;";
  return i;
};

const selectInput = (options: { value: string; label: string }[], selected: string): HTMLSelectElement => {
  const s = document.createElement("select");
  s.style.cssText =
    "min-width:0; width:100%; box-sizing:border-box; height:28px; background:#0c1018; color:#e8e8e8;" +
    "border:1px solid #3a4658; border-radius:5px; padding:0 4px; font:12px system-ui,sans-serif;";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    s.appendChild(opt);
  }
  s.value = selected;
  return s;
};

const smallDevBtn = (label: string, bg: string, color: string): HTMLButtonElement => {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    `cursor:pointer; border-radius:5px; border:1px solid #3a4658; background:${bg}; color:${color};` +
    "padding:4px 8px; font:600 12px system-ui,sans-serif;";
  return b;
};

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
  ownerId: string;
  type?: string;
  modelId?: string;
  label?: string;
  intervalMs: number;
  cap: number;
  behavior: {
    hp?: number;
    attack?: number;
    aggroRadius?: number;
    chaseSpeed?: number;
    attackCooldownMs?: number;
    houseDamage?: number;
    brain?: string;
    modelId?: string;
    label?: string;
    stats?: CharacterStatsCfg;
  };
}

interface CharacterStatsCfg {
  maxHp?: number;
  attack?: number;
  armor?: number;
  critChance?: number;
  moveSpeed?: number;
  throwPower?: number;
  level?: number;
  xp?: number;
}

interface FeatureDropCfg {
  item: string;
  quantity: number;
  probability: number;
  trigger: "kill" | "damage";
}

interface EntityFeatureCfg {
  hp?: number;
  brain?: string;
  stats?: CharacterStatsCfg;
  drops?: FeatureDropCfg[];
}

interface EntityFeatureManifest {
  defaults?: Record<string, EntityFeatureCfg>;
  instances?: Record<string, EntityFeatureCfg>;
}

/** Trim long ids (prop ids are model urls) for the panel title. */
const shortId = (id: string) => (id.length > 22 ? "…" + id.slice(-20) : id);
