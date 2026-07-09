import {
  type ArcRotateCamera,
  Color3,
  TransformNode,
  type AbstractMesh,
  Vector3,
  Matrix,
  type ParticleSystem,
  MeshBuilder,
  DynamicTexture,
  Texture,
  StandardMaterial,
} from "@babylonjs/core";
import {
  type Player,
  type Enemy,
  type Potion,
  type Tree,
  type Log,
  type Rock,
  type Stone,
  type Banana,
  type Item,
  type House,
  type Structure,
  AnimState,
  type DamageEvent,
  type KillEvent,
  type HealEvent,
  type XpEvent,
  type BananaThrowEvent,
  PLAYER_RESPAWN_MS,
  SACRED_CIRCLE_RADIUS,
} from "@rpg/shared";
import type { CharacterFactory } from "../entities/CharacterFactory";
import { Entity } from "../entities/Entity";
import { buildPotion, type PotionModel } from "../entities/models/potion";
import {
  buildBerserkerPotion,
  type BerserkerPotionModel,
} from "../entities/models/berserkerPotion";
import { buildTree, type TreeModel } from "../entities/models/tree";
import { buildLog, type LogModel } from "../entities/models/log";
import { buildRock, type RockModel } from "../entities/models/rock";
import { buildStone, type StoneModel } from "../entities/models/stone";
import { buildBanana, type BananaModel } from "../entities/models/banana";
import { buildStoneShot } from "../entities/models/stoneShot";
import type { HouseModel } from "../entities/models/house";
import { buildLightning, type Lightning } from "../fx/lightning";
import { makeBananaTrail, makeBananaBurst } from "../fx/bananaFx";
import { makeLevelUpExplosion } from "../fx/explosion";
import { makeBloodBurst } from "../fx/bloodFx";
import { makeSacredCircleFx, type SacredCircleFx } from "../fx/sacredCircleFx";
import { DamageFx } from "../fx/damageFx";
import { type DropAnim, startDrop, updateDrop } from "../fx/dropAnim";
import type { HUD } from "../ui/hud";
import type { GameDebugStats } from "../ui/debugStats";
import type { AudioManager } from "../audio/AudioManager";
import type { AnimationDebugClip } from "../entities/Entity";
import {
  FootprintPicker,
  type PickResult,
  type StructureMask,
  cloneStructureMask,
  defaultStructureMask,
  normalizeStructureMask,
} from "../input/FootprintPicker";
import { smooth } from "../util/math";
import { applyTransform, bounds, importModel } from "../scene/props";
import { getCameraZoom } from "../scene/camera";
import { itemDef, itemIcon, loadItemDefs } from "../items/itemRegistry";
import type { ContactShadowShape, ShadowHandle, ShadowRuntime } from "../scene/contactShadows";

interface ServerView {
  x: number;
  z: number;
  rotY: number;
  scale?: number;
  hp: number;
  maxHp: number;
  state: AnimState;
  level: number;
  sprinting?: boolean; // players only; enemies leave it undefined → no run-speed boost
  berserkerMs?: number; // players only; ms remaining on the berserker buff (0 = none)
  modelId?: string;
  displayName?: string;
  kind?: string;
}

/** One parabolic leg of a thrown banana's path (the throw, then each bounce). */
interface Hop {
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  peak: number; // apex height of this arc
  dur: number; // seconds
  launchY: number; // start height (hand height for the throw, ground for bounces)
  arcFrac?: number; // throw hop: draw only the first `frac` of a full arc (clipped at a prop)
}

/** A banana mid-flight (purely visual; the server resolves the hit + landing).
 *  Arcs to the landing, then bounces in place with speed-scaled energy, trailing
 *  sparks and puffing dust at each ground contact. On settling it seamlessly
 *  hands off to the real (server-spawned) collectible resting at the same spot. */
interface ThrownBanana {
  model: BananaModel;
  shadow: ShadowHandle;
  hops: Hop[];
  hopIndex: number;
  t: number; // time into the current hop
  impact: number; // bounce/particle strength (≈ throw speed)
  fade: number; // fade-out progress if no collectible is there to hand off to
  trail?: ParticleSystem;
  landingX: number;
  landingZ: number;
  item: "banana" | "stone"; // which impact sound to play when it lands
  collectibleId?: string; // the hidden collectible to reveal when this settles
}

/** A short-lived particle system being aged out then disposed. */
interface ParticleFx {
  ps: ParticleSystem;
  ttl: number;
}

const THROW_GROUND_Y = 0.18; // resting height of a banana on the ground
const CLICK_ASSIST_RADIUS = 1.7; // a click this close to a target (world units) still hits it
const THROW_RESTITUTION = 0.42; // each bounce keeps this fraction of the last's energy
const TREE_PICK_RADIUS = 1.65;
const LOG_PICK_RADIUS = 1.1;
const STONE_PICK_RADIUS = 1.05;
const POTION_PICK_RADIUS = 1.05;
const BANANA_PICK_RADIUS = 1.05;

const PICK_PRIORITY = {
  character: 80,
  collectible: 70,
  resource: 50,
  structure: 30,
};

function treeResourceKind(tree: Tree, id: string): "tree" | "bush" {
  return tree.kind === "bush" || id.includes("bush") ? "bush" : "tree";
}

/** Minimal collectible model shape (potion/log/stone/banana all satisfy this). */
interface CollectibleModel {
  root: TransformNode;
  meshes: AbstractMesh[];
  dispose(): void;
}

/** A just-grabbed item being sucked into the collector (magnet + shrink + fade). */
interface CollectFx {
  model: CollectibleModel;
  target: Entity; // the player it flies toward
  t: number;
  dur: number;
  startPos: Vector3;
  startScale: Vector3;
}

const COLLECT_DUR = 0.42; // seconds the magnet-collect animation lasts
const COLLECT_MAGNET_MAX_DIST = 6; // don't magnet to a player farther than this (safety)
const COLLECT_AIM_Y = 1.1; // fly the item up to ~chest height as it reaches the player
const CRYPTA_DAMAGE_FEEDBACK_STEP = 10;
const CRYPTA_DAMAGE_FEEDBACK_COOLDOWN_MS = 4000;

const DUMMY_TINT = new Color3(0.72, 0.3, 0.26);

/**
 * Owns the set of live world objects (characters, potions, trees, logs) and maps
 * Colyseus state callbacks onto them. Also pans the isometric camera to follow
 * the local player each frame.
 */
export class Game {
  private entities = new Map<string, Entity>();
  private pendingEnemies = new Set<string>();
  private pendingEnemyViews = new Map<string, Enemy>();
  private potions = new Map<string, (PotionModel | BerserkerPotionModel) & { bob: number; drop?: DropAnim }>();
  private trees = new Map<string, TreeModel & { kind: "tree" | "bush"; hp: number; maxHp: number; alive: boolean; x: number; z: number; rotY: number; scale: number }>();
  private logs = new Map<string, LogModel & { bob: number; drop?: DropAnim }>();
  private rocks = new Map<string, RockModel & { hp: number; maxHp: number; alive: boolean; x: number; z: number; rotY: number; scale: number }>();
  private stones = new Map<string, StoneModel & { bob: number; drop?: DropAnim }>();
  private bananas = new Map<string, BananaModel & { spin: number; drop?: DropAnim }>();
  private items = new Map<string, CollectibleModel & { bob: number; drop?: DropAnim; itemId: string; restY: number }>();
  private pendingItems = new Set<string>();
  private removedItems = new Set<string>();
  private houses = new Map<string, { hp: number; maxHp: number; alive: boolean; x: number; z: number; radius: number; scale: number; anchor: TransformNode; visual?: TransformNode; meshes?: AbstractMesh[] }>();
  private contactShadows = new Map<string, ShadowHandle>();
  private characterShadeRadii = new Map<string, number>();
  private houseModel: HouseModel | null = null; // the loaded house glb (to hide on collapse)
  private housePickable = false;
  // Destructible concrete structures (the prop is the visual; this tracks HP + the
  // floating HP bar). On destroy we hide the prop via the prop manager.
  private structures = new Map<string, { hp: number; maxHp: number; anchor: TransformNode }>();
  private structureProps: { get(id: string): { loaded: { root: TransformNode } } | undefined } | null = null;
  private healingCircle: SacredCircleFx | null = null;
  private thrown: ThrownBanana[] = [];
  private particleFx: ParticleFx[] = []; // expiring banana trails/puffs
  private collecting: CollectFx[] = []; // items animating into a collector
  private playerIds = new Set<string>(); // entity ids that are players (magnet targets)
  private playerLevels = new Map<string, number>(); // last seen level, to detect level-ups
  private footprints = new FootprintPicker();
  private structureMasks = new Map<string, StructureMask>();
  private rootBaseScales = new WeakMap<TransformNode, number>();
  private lightnings: Lightning[] = [];
  private deadElapsed: number | null = null; // seconds the local player has been dead
  private dropsEnabled = false; // gate the loot-pop so the initial world sync doesn't all pop at once
  private damageFx: DamageFx | null = null; // local-player hurt feedback (flash/shake/low-HP)
  private cryptaDamageSinceFeedback = 0;
  private cryptaFeedbackReadyAt = 0;
  private audio: AudioManager | null = null; // sound effects + music (set after construction)
  private focusOverride: { x: number; z: number } | null = null; // dev: hold camera off the player
  localId: string | null = null;

  constructor(
    private camera: ArcRotateCamera,
    private factory: CharacterFactory,
    private hud: HUD,
    private shadows: ShadowRuntime,
  ) {
    const canvas = camera.getScene().getEngine().getRenderingCanvas();
    if (canvas) this.damageFx = new DamageFx(canvas);
    void this.loadStructureMasks();
  }

  setLocalId(id: string) {
    this.localId = id;
    for (const [eid, entity] of this.entities) this.upsertCharacterFootprint(eid, entity);
    // Enable the loot-pop shortly after joining, so the initial burst of existing
    // world items (synced on connect) lands quietly — only items dropped DURING
    // play pop into the air.
    setTimeout(() => {
      this.dropsEnabled = true;
    }, 800);
  }

  /** Wire in the sound system (effects + music). */
  setAudio(audio: AudioManager) {
    this.audio = audio;
  }

  /** Dev Mode: suppress all local-player hurt feedback (red flash, camera shake,
   *  low-HP vignette, white alert) so the screen stays clean while editing. */
  setDamageFxSuppressed(on: boolean) {
    this.damageFx?.setSuppressed(on);
  }

  /** Dev Mode: toggle the local player's ghost look (translucent + floating)
   *  while the game is paused. Idempotent. */
  setGhost(on: boolean) {
    const local = this.localId ? this.entities.get(this.localId) : null;
    local?.setGhost(on);
  }

  /** While paused, drive ONLY the local player (ghost free-roam) + camera at real
   *  (unscaled) dt, so it roams as the rest of the world stays frozen. */
  updateGhost(dt: number) {
    const local = this.localId ? this.entities.get(this.localId) : null;
    if (!local) return;
    local.update(dt); // interpolate toward the server's ghost-moved position
    const t = this.camera.target;
    const f = smooth(dt, 0.12);
    const focus = this.focusOverride; // dev: explorer may be holding the camera off the player
    const tx = focus ? focus.x : local.root.position.x;
    const tz = focus ? focus.z : local.root.position.z;
    t.x += (tx - t.x) * f;
    t.z += (tz - t.z) * f;
    t.y = 1;
  }

  /** Flash a character white when the player picks it as an attack target. */
  flashSelectTarget(id: string) {
    this.entities.get(id)?.flashSelect();
  }

  /** Dev Mode: pan the isometric camera to a world point and HOLD it there
   *  (overriding the player-follow) until clearFocus(). The library explorer uses
   *  this to jump to a selected entity anywhere on the map. */
  focusOn(x: number, z: number) {
    this.focusOverride = { x, z };
  }
  /** Stop holding a dev camera focus; the view resumes following the local player. */
  clearFocus() {
    this.focusOverride = null;
  }

  /** Dev Mode: resolve a synced entity's holder node + meshes by (kind, id) so the
   *  editor can select/highlight it without a mesh pick. Props/characters are owned
   *  by their own managers (not here); returns null if absent. */
  nodeFor(kind: string, id: string): { root: TransformNode; meshes: AbstractMesh[] } | null {
    const wrap = (root?: TransformNode | null) =>
      root ? { root, meshes: root.getChildMeshes(false) } : null;
    switch (kind) {
      case "player":
      case "enemy": {
        const e = this.entities.get(id);
        return e ? { root: e.root, meshes: e.meshes } : null;
      }
      case "tree":
      case "bush":
        return wrap(this.trees.get(id)?.root);
      case "rock":
        return wrap(this.rocks.get(id)?.root);
      case "log":
        return wrap(this.logs.get(id)?.root);
      case "stone":
        return wrap(this.stones.get(id)?.root);
      case "potion":
        return wrap(this.potions.get(id)?.root);
      case "banana":
        return wrap(this.bananas.get(id)?.root);
      case "item":
        return wrap(this.items.get(id)?.root);
      case "house": {
        const h = this.houses.get(id);
        if (!h) return null;
        return { root: h.visual ?? h.anchor, meshes: h.meshes ?? h.anchor.getChildMeshes(false) };
      }
      default:
        return null;
    }
  }

  /** Normal play picking: active, targetable footprints only. */
  pickTargetAt = (point: Vector3): PickResult | null =>
    this.footprints.pick({ x: point.x, z: point.z });

  /** Dev Mode picking: include inactive footprints, but keep the local player click-through. */
  pickSelectableAt = (point: Vector3): PickResult | null => {
    const hit = this.footprints.pick({ x: point.x, z: point.z }, { includeInactive: true });
    return hit?.id === this.localId ? null : hit;
  };

  private rememberBaseScale(root: TransformNode) {
    if (!this.rootBaseScales.has(root)) this.rootBaseScales.set(root, root.scaling.x || 1);
  }

  private applySyncedTransform(
    root: TransformNode,
    view: { x: number; z: number; rotY?: number; scale?: number },
    y: number,
  ) {
    this.rememberBaseScale(root);
    const scale = Number.isFinite(view.scale) ? Math.max(0.05, Number(view.scale)) : 1;
    root.position.set(view.x, y, view.z);
    root.rotation.y = view.rotY ?? 0;
    root.scaling.setAll((this.rootBaseScales.get(root) ?? 1) * scale);
  }

  structureMaskFor(kind: string): StructureMask {
    return cloneStructureMask(this.structureMasks.get(kind) ?? defaultStructureMask(kind));
  }

  setStructureMask(kind: string, mask: StructureMask | null) {
    const clean = mask ? normalizeStructureMask(mask) : null;
    if (clean) this.structureMasks.set(kind, clean);
    else this.structureMasks.delete(kind);
    if (kind === "house") {
      for (const [id, h] of this.houses) this.upsertHouseFootprint(id, h.x, h.z, h.radius, h.scale, h.alive);
    }
  }

  private async loadStructureMasks() {
    try {
      const res = await fetch("/structures.json", { cache: "no-store" });
      if (!res.ok) return;
      const cfg = (await res.json()) as Record<string, { mask?: unknown }>;
      for (const [kind, value] of Object.entries(cfg || {})) {
        const mask = normalizeStructureMask(value?.mask);
        if (mask) this.structureMasks.set(kind, mask);
      }
      for (const [id, h] of this.houses) this.upsertHouseFootprint(id, h.x, h.z, h.radius, h.scale, h.alive);
    } catch {
      /* no structure mask config yet — defaults cover the current world */
    }
  }

  private upsertCharacterFootprint(id: string, entity: Entity) {
    const kind = (entity.root.metadata as { kind?: string } | null)?.kind ?? "enemy";
    this.footprints.upsert({
      id,
      kind,
      x: entity.root.position.x,
      z: entity.root.position.z,
      shape: { type: "circle", radius: CLICK_ASSIST_RADIUS },
      priority: PICK_PRIORITY.character,
      active: id !== this.localId && entity.hp > 0,
    });
  }

  private upsertCircleFootprint(
    kind: string,
    id: string,
    x: number,
    z: number,
    radius: number,
    priority: number,
    active = true,
  ) {
    this.footprints.upsert({
      id,
      kind,
      x,
      z,
      shape: { type: "circle", radius },
      priority,
      active,
    });
  }

  private upsertHouseFootprint(id: string, x: number, z: number, radius: number, scale: number, active: boolean) {
    const mask = cloneStructureMask(this.structureMasks.get("house") ?? defaultStructureMask("house"));
    const s = Math.max(0.05, scale || 1);
    mask.points = mask.points.map((p) => ({ x: p.x * s, z: p.z * s }));
    this.footprints.upsert({
      id,
      kind: "house",
      x,
      z,
      shape: mask ?? { type: "circle", radius: Math.max(1, radius * s) },
      priority: PICK_PRIORITY.structure,
      active,
    });
  }

  // ---- player callbacks ----
  addPlayer(p: Player, id: string) {
    if (this.entities.has(id)) return;
    const accent = Color3.FromHSV(p.hue, 0.7, 1.0);
    const entity = new Entity(id, this.factory.spawn("player", accent), id === this.localId);
    entity.name = p.name;
    entity.respawnFx = true; // players fade out on death + return with a lightning strike
    entity.onRespawn = (x, z) => this.showLightning(x, z);
    this.playerIds.add(id); // a magnet target for collected items
    this.playerLevels.set(id, p.level); // baseline, so we can detect level-ups
    this.register(entity, p, false);
  }

  changePlayer(p: Player, id: string) {
    this.apply(id, p);
    const prev = this.playerLevels.get(id);
    if (prev !== undefined && p.level > prev) this.explodeLevelUp(id); // a level-up — everybody sees it
    this.playerLevels.set(id, p.level);
  }

  /** Golden burst on a player who just leveled up (rendered on every client). */
  private explodeLevelUp(id: string) {
    const ent = this.entities.get(id);
    if (!ent) return;
    const ps = makeLevelUpExplosion(
      this.camera.getScene(),
      ent.root.position.x,
      0.6,
      ent.root.position.z,
    );
    this.particleFx.push({ ps, ttl: 1.3 });
    this.audio?.levelUp({ x: ent.root.position.x, z: ent.root.position.z });
  }

  removePlayer(id: string) {
    this.playerIds.delete(id);
    this.playerLevels.delete(id);
    this.unregister(id);
  }

  // ---- enemy callbacks ----
  addEnemy(e: Enemy, id: string) {
    if (this.entities.has(id) || this.pendingEnemies.has(id)) return;
    if (e.modelId) {
      this.pendingEnemies.add(id);
      this.pendingEnemyViews.set(id, e);
      void this.factory
        .spawnCustom(e.modelId)
        .then((spawned) => {
          if (!this.pendingEnemies.has(id)) return;
          this.pendingEnemies.delete(id);
          const view = this.pendingEnemyViews.get(id) ?? e;
          this.pendingEnemyViews.delete(id);
          if (this.entities.has(id)) return;
          const fallback = () => this.factory.spawn(view.kind === "goblin" ? "goblin" : "enemy", DUMMY_TINT);
          const entity = new Entity(id, spawned ?? fallback(), false);
          entity.name = view.displayName || "NPC";
          entity.corpseFx = view.kind === "goblin";
          this.register(entity, view, true);
        })
        .catch((err) => {
          if (!this.pendingEnemies.has(id)) return;
          this.pendingEnemies.delete(id);
          const view = this.pendingEnemyViews.get(id) ?? e;
          this.pendingEnemyViews.delete(id);
          console.warn(`[char] failed to spawn custom enemy ${e.modelId}`, err);
          const entity = new Entity(id, this.factory.spawn("enemy", DUMMY_TINT), false);
          entity.name = view.displayName || "NPC";
          this.register(entity, view, true);
        });
      return;
    }
    const isGoblin = e.kind === "goblin";
    const spawned = this.factory.spawn(isGoblin ? "goblin" : "enemy", DUMMY_TINT);
    const entity = new Entity(id, spawned, false);
    entity.name = e.displayName || (isGoblin ? "Goblin" : e.kind === "npc" ? "NPC" : "Dummy"); // the nameplate appends " Lv.N"
    entity.corpseFx = isGoblin; // dead goblins fade out, then respawn at their home
    this.register(entity, e, true);
  }

  changeEnemy(e: Enemy, id: string) {
    if (this.pendingEnemies.has(id)) this.pendingEnemyViews.set(id, e);
    this.apply(id, e);
  }

  removeEnemy(id: string) {
    this.pendingEnemies.delete(id);
    this.pendingEnemyViews.delete(id);
    this.unregister(id);
  }

  // ---- potion callbacks ----
  addPotion(p: Potion, id: string) {
    if (this.potions.has(id)) return;
    const scene = this.camera.getScene();
    // Use the appropriate model depending on the potion kind synced from the server.
    const model =
      p.kind === "berserker_potion"
        ? buildBerserkerPotion(scene)
        : buildPotion(scene);
    this.applySyncedTransform(model.root, p, 0.2);
    model.root.metadata = { entityId: id, kind: "potion" };
    for (const mesh of model.meshes) {
      mesh.metadata = { entityId: id, kind: "potion" };
      this.receiveContactShadow(mesh);
    }
    this.addContactShadow("potion", id, model.root, "pickup", 0.9, 1.1, 0.24, model.meshes);
    this.potions.set(id, {
      ...model,
      bob: Math.random() * Math.PI * 2,
      drop: this.dropsEnabled ? startDrop(0.25) : undefined,
    });
    this.upsertCircleFootprint("potion", id, p.x, p.z, POTION_PICK_RADIUS * (p.scale || 1), PICK_PRIORITY.collectible);
  }

  changePotion(p: Potion, id: string) {
    const pot = this.potions.get(id);
    if (!pot) return;
    this.applySyncedTransform(pot.root, p, pot.root.position.y);
    this.upsertCircleFootprint("potion", id, p.x, p.z, POTION_PICK_RADIUS * (p.scale || 1), PICK_PRIORITY.collectible);
  }

  removePotion(id: string) {
    const pot = this.potions.get(id);
    if (!pot) return;
    this.potions.delete(id);
    this.footprints.remove("potion", id);
    this.removeContactShadow("potion", id);
    this.startCollect(pot); // fly into the collector, shrink + fade
  }

  // ---- tree callbacks ----
  addTree(t: Tree, id: string) {
    if (this.trees.has(id)) return;
    const scene = this.camera.getScene();
    const resourceKind = treeResourceKind(t, id);
    const treeVariant = resourceKind === "bush" ? "bush" : "tree";
    const model = buildTree(scene, treeVariant);
    this.applySyncedTransform(model.root, t, 0);
    model.root.metadata = { entityId: id, kind: resourceKind };
    model.setAlive(t.alive);
    for (const mesh of model.meshes) this.receiveContactShadow(mesh);
    const treeScale = t.scale || 1;
    this.addContactShadow("tree", id, model.root, "structure", 2.6 * treeScale, 3.2 * treeScale, 0.42, model.meshes, true);
    const tm = { ...model, kind: resourceKind, hp: t.hp, maxHp: t.maxHp, alive: t.alive, x: t.x, z: t.z, rotY: t.rotY ?? 0, scale: treeScale };
    this.trees.set(id, tm);
    this.upsertCircleFootprint(resourceKind, id, t.x, t.z, TREE_PICK_RADIUS * (t.scale || 1), PICK_PRIORITY.resource, t.alive && t.hp > 0);
    // HP bar floats above the crown; it only appears once the tree is chopped.
    const anchor = new TransformNode(`treeBar-${id}`, scene);
    anchor.parent = model.root;
    anchor.position.y = treeVariant === "bush" ? 1.45 : 5.9;
    this.hud.addResource(id, anchor, () => tm.hp, () => tm.maxHp, "#7bd17b");
  }

  changeTree(t: Tree, id: string) {
    const tm = this.trees.get(id);
    if (!tm) return;
    const nextResourceKind = treeResourceKind(t, id);
    const previousResourceKind = tm.kind;
    const resourceKindChanged = tm.kind !== nextResourceKind;
    const modelStateChanged = tm.alive !== t.alive;
    const nextScale = t.scale || 1;
    const nextRotY = t.rotY ?? 0;
    const transformChanged =
      Math.abs(tm.x - t.x) > 1e-4 ||
      Math.abs(tm.z - t.z) > 1e-4 ||
      Math.abs(tm.rotY - nextRotY) > 1e-4 ||
      Math.abs(tm.scale - nextScale) > 1e-4;
    tm.hp = t.hp;
    tm.maxHp = t.maxHp;
    tm.alive = t.alive;
    tm.kind = nextResourceKind;
    tm.x = t.x;
    tm.z = t.z;
    tm.rotY = nextRotY;
    tm.scale = nextScale;
    tm.setAlive(t.alive);
    tm.root.metadata = { entityId: id, kind: nextResourceKind };
    this.applySyncedTransform(tm.root, t, 0); // HP bar is parented, so it tags along
    const alive = t.alive && t.hp > 0;
    const shadowW = (alive ? 2.6 : 1.0) * nextScale;
    const shadowD = (alive ? 3.2 : 1.1) * nextScale;
    const shadowOpacity = alive ? 0.42 : 0.22;
    if (modelStateChanged || transformChanged) {
      this.addContactShadow("tree", id, tm.root, "structure", shadowW, shadowD, shadowOpacity, tm.meshes, true);
    } else {
      this.updateContactShadow("tree", id, tm.root, shadowOpacity);
      this.resizeContactShadow("tree", id, shadowW, shadowD);
    }
    if (resourceKindChanged) this.footprints.remove(previousResourceKind, id);
    this.upsertCircleFootprint(nextResourceKind, id, t.x, t.z, TREE_PICK_RADIUS * (t.scale || 1), PICK_PRIORITY.resource, t.alive && t.hp > 0);
    if (modelStateChanged || transformChanged) this.shadows.refreshStaticShadows();
  }

  removeTree(id: string) {
    const tree = this.trees.get(id);
    if (!tree) return;
    this.hud.remove(id);
    this.removeContactShadow("tree", id);
    tree.dispose();
    this.trees.delete(id);
    this.footprints.remove("tree", id);
    this.footprints.remove("bush", id);
  }

  // ---- destructible structure callbacks (concrete props with HP) ----
  /** Wire the prop manager so a destroyed structure can hide its prop visual. */
  setStructureProps(pm: { get(id: string): { loaded: { root: TransformNode } } | undefined }) {
    this.structureProps = pm;
  }

  private setPropVisible(id: string, on: boolean) {
    this.structureProps?.get(id)?.loaded.root.setEnabled(on);
  }

  addStructure(s: Structure, id: string): void {
    this.setPropVisible(id, true); // (re)show in case it was a destroyed instance coming back
    if (this.structures.has(id)) {
      this.changeStructure(s, id);
      return;
    }
    const scene = this.camera.getScene();
    const anchor = new TransformNode(`structBar-${id}`, scene);
    anchor.position.set(s.x, Math.max(3, s.radius * (s.scale || 1) * 1.6), s.z);
    const sm = { hp: s.hp, maxHp: s.maxHp, anchor };
    this.structures.set(id, sm);
    this.hud.addResource(id, anchor, () => sm.hp, () => sm.maxHp, "#d98c54");
    this.upsertCircleFootprint("structure", id, s.x, s.z, Math.max(1, s.radius * (s.scale || 1)), PICK_PRIORITY.resource, s.alive && s.hp > 0);
  }

  changeStructure(s: Structure, id: string): void {
    const sm = this.structures.get(id);
    if (!sm) {
      this.addStructure(s, id);
      return;
    }
    sm.hp = s.hp;
    sm.maxHp = s.maxHp;
    sm.anchor.position.set(s.x, Math.max(3, s.radius * (s.scale || 1) * 1.6), s.z);
    this.upsertCircleFootprint("structure", id, s.x, s.z, Math.max(1, s.radius * (s.scale || 1)), PICK_PRIORITY.resource, s.alive && s.hp > 0);
    if (!s.alive) this.setPropVisible(id, false); // destroyed → hide the prop visual
  }

  removeStructure(id: string) {
    const sm = this.structures.get(id);
    if (!sm) return;
    this.hud.remove(id);
    sm.anchor.dispose();
    this.structures.delete(id);
    this.footprints.remove("structure", id);
  }

  // ---- log callbacks ----
  addLog(l: Log, id: string) {
    if (this.logs.has(id)) return;
    const model = buildLog(this.camera.getScene());
    this.applySyncedTransform(model.root, l, 0.12);
    model.root.metadata = { entityId: id, kind: "log" };
    for (const mesh of model.meshes) {
      mesh.metadata = { entityId: id, kind: "log" };
      this.receiveContactShadow(mesh);
    }
    this.addContactShadow("log", id, model.root, "pickup", 1.0, 1.25, 0.24, model.meshes);
    this.logs.set(id, {
      ...model,
      bob: Math.random() * Math.PI * 2,
      drop: this.dropsEnabled ? startDrop(0.12) : undefined,
    });
    this.upsertCircleFootprint("log", id, l.x, l.z, LOG_PICK_RADIUS * (l.scale || 1), PICK_PRIORITY.collectible);
  }

  changeLog(l: Log, id: string) {
    const log = this.logs.get(id);
    if (!log) return;
    this.applySyncedTransform(log.root, l, log.root.position.y);
    this.upsertCircleFootprint("log", id, l.x, l.z, LOG_PICK_RADIUS * (l.scale || 1), PICK_PRIORITY.collectible);
  }

  removeLog(id: string) {
    const log = this.logs.get(id);
    if (!log) return;
    this.logs.delete(id);
    this.footprints.remove("log", id);
    this.removeContactShadow("log", id);
    this.startCollect(log);
  }

  // ---- rock callbacks ----
  addRock(rock: Rock, id: string) {
    if (this.rocks.has(id)) return;
    const scene = this.camera.getScene();
    const model = buildRock(scene, rock.radius);
    this.applySyncedTransform(model.root, rock, 0);
    model.root.metadata = { entityId: id, kind: "rock" };
    for (const mesh of model.meshes) {
      mesh.metadata = { entityId: id, kind: "rock" };
      this.receiveContactShadow(mesh);
    }
    model.setAlive(rock.alive);
    const rockScale = rock.scale || 1;
    this.addContactShadow(
      "rock",
      id,
      model.root,
      "structure",
      Math.max(1.4, rock.radius * 1.9 * rockScale),
      Math.max(1.6, rock.radius * 2.2 * rockScale),
      0.44,
      model.meshes,
      true,
    );
    const rm = { ...model, hp: rock.hp, maxHp: rock.maxHp, alive: rock.alive, x: rock.x, z: rock.z, rotY: rock.rotY ?? 0, scale: rockScale };
    this.rocks.set(id, rm);
    this.upsertCircleFootprint("rock", id, rock.x, rock.z, Math.max(1, rock.radius * (rock.scale || 1)), PICK_PRIORITY.resource, rock.alive && rock.hp > 0);
    // HP bar floats above the boulder; it only appears once the rock is mined.
    const anchor = new TransformNode(`rockBar-${id}`, scene);
    anchor.parent = model.root;
    anchor.position.y = rock.radius * 1.5 + 0.5;
    this.hud.addResource(id, anchor, () => rm.hp, () => rm.maxHp, "#9fb0c4");
  }

  changeRock(rock: Rock, id: string) {
    const rm = this.rocks.get(id);
    if (!rm) return;
    const modelStateChanged = rm.alive !== rock.alive;
    const nextScale = rock.scale || 1;
    const nextRotY = rock.rotY ?? 0;
    const transformChanged =
      Math.abs(rm.x - rock.x) > 1e-4 ||
      Math.abs(rm.z - rock.z) > 1e-4 ||
      Math.abs(rm.rotY - nextRotY) > 1e-4 ||
      Math.abs(rm.scale - nextScale) > 1e-4;
    rm.hp = rock.hp;
    rm.maxHp = rock.maxHp;
    rm.alive = rock.alive;
    rm.x = rock.x;
    rm.z = rock.z;
    rm.rotY = nextRotY;
    rm.scale = nextScale;
    rm.setAlive(rock.alive);
    this.applySyncedTransform(rm.root, rock, 0); // HP bar is parented, tags along
    const shadowW = rock.alive && rock.hp > 0 ? Math.max(1.4, rock.radius * 1.9 * nextScale) : Math.max(0.9, rock.radius * nextScale);
    const shadowD = rock.alive && rock.hp > 0 ? Math.max(1.6, rock.radius * 2.2 * nextScale) : Math.max(1.0, rock.radius * 1.1 * nextScale);
    const shadowOpacity = rock.alive && rock.hp > 0 ? 0.44 : 0.22;
    if (modelStateChanged || transformChanged) {
      this.addContactShadow("rock", id, rm.root, "structure", shadowW, shadowD, shadowOpacity, rm.meshes, true);
    } else {
      this.updateContactShadow("rock", id, rm.root, shadowOpacity);
      this.resizeContactShadow("rock", id, shadowW, shadowD);
    }
    this.upsertCircleFootprint("rock", id, rock.x, rock.z, Math.max(1, rock.radius * (rock.scale || 1)), PICK_PRIORITY.resource, rock.alive && rock.hp > 0);
    if (modelStateChanged || transformChanged) this.shadows.refreshStaticShadows();
  }

  removeRock(id: string) {
    const r = this.rocks.get(id);
    if (!r) return;
    this.hud.remove(id);
    this.removeContactShadow("rock", id);
    r.dispose();
    this.rocks.delete(id);
    this.footprints.remove("rock", id);
  }

  // ---- house callbacks ----
  /** Receive the loaded house glb handle (so we can hide it when it collapses). */
  setHouseModel(model: HouseModel | null) {
    this.houseModel = model;
    if (!this.houses.has("house-0")) this.houseModel?.hide();
  }

  /** Toggle house model picking. Normal play leaves it off while graphics are debugged. */
  setHousePickable(on: boolean) {
    this.housePickable = on;
    this.houseModel?.setPickable(on);
    for (const h of this.houses.values()) {
      for (const mesh of h.meshes ?? []) mesh.isPickable = on;
    }
  }

  setHealingTowerPosition(x: number, z: number) {
    if (!this.healingCircle) {
      this.healingCircle = makeSacredCircleFx(this.camera.getScene(), SACRED_CIRCLE_RADIUS);
    }
    this.healingCircle.root.position.set(x, 0, z);
    this.healingCircle.setEnabled(true);
  }

  addHouse(h: House, id: string) {
    if (this.houses.has(id)) return;
    const scene = this.camera.getScene();
    // The house glb itself is loaded separately (loadHouse); here we just track its
    // HP and float a bar above the roof. The anchor is a fixed node at the house.
    const anchor = new TransformNode(`houseBar-${id}`, scene);
    anchor.position.set(h.x, 9 * (h.scale || 1), h.z);
    const visual = id === "house-0" ? undefined : this.buildDevHouseVisual(id, h);
    const hm = { hp: h.hp, maxHp: h.maxHp, alive: h.alive, x: h.x, z: h.z, radius: h.radius, scale: h.scale || 1, anchor, visual: visual?.root, meshes: visual?.meshes };
    this.houses.set(id, hm);
    this.upsertHouseFootprint(id, h.x, h.z, h.radius, h.scale || 1, h.alive);
    this.hud.addResource(id, anchor, () => hm.hp, () => hm.maxHp, "#d98c54");
    if (id === "house-0") {
      this.houseModel?.transformTo(h.x, h.z, h.rotY || 0, h.scale || 1);
      if (h.alive) this.houseModel?.show(); // a (re)built house re-shows its model after a wipe
    } else {
      if (visual) {
        this.addContactShadow("house", id, visual.root, "structure", 5.8, 5.0, 0.42, visual.meshes, true);
      }
      visual?.root.setEnabled(h.alive);
      this.setContactShadowEnabled("house", id, h.alive);
      if (visual) this.shadows.refreshStaticShadows();
    }
  }

  changeHouse(h: House, id: string) {
    const hm = this.houses.get(id);
    if (!hm) return;
    hm.hp = h.hp;
    hm.maxHp = h.maxHp;
    hm.alive = h.alive;
    hm.x = h.x;
    hm.z = h.z;
    hm.radius = h.radius;
    hm.scale = h.scale || 1;
    hm.anchor.position.set(h.x, 9 * (h.scale || 1), h.z);
    this.upsertHouseFootprint(id, h.x, h.z, h.radius, h.scale || 1, h.alive);
    if (id === "house-0") {
      this.houseModel?.transformTo(h.x, h.z, h.rotY || 0, h.scale || 1);
      if (!h.alive) this.houseModel?.hide(); // collapsed
      else this.houseModel?.show();
    } else if (hm.visual) {
      this.applySyncedTransform(hm.visual, h, 0);
      hm.visual.setEnabled(h.alive);
      this.updateContactShadow("house", id, hm.visual, 0.42);
      this.setContactShadowEnabled("house", id, h.alive);
      this.shadows.refreshStaticShadows();
    }
  }

  removeHouse(id: string) {
    const hm = this.houses.get(id);
    if (!hm) return;
    this.hud.remove(id);
    this.removeContactShadow("house", id);
    hm.visual?.dispose();
    hm.anchor.dispose();
    this.houses.delete(id);
    this.footprints.remove("house", id);
    if (id === "house-0") this.houseModel?.hide(); // the home is gone — hide the GLB
  }

  private buildDevHouseVisual(id: string, h: House): { root: TransformNode; meshes: AbstractMesh[] } {
    const scene = this.camera.getScene();
    const root = new TransformNode(`devHouse-${id}`, scene);
    this.applySyncedTransform(root, h, 0);
    root.metadata = { entityId: id, kind: "house" };

    const wallMat = new StandardMaterial(`devHouseWall-${id}`, scene);
    wallMat.diffuseColor = new Color3(0.48, 0.36, 0.24);
    wallMat.specularColor = new Color3(0.08, 0.06, 0.04);
    const roofMat = new StandardMaterial(`devHouseRoof-${id}`, scene);
    roofMat.diffuseColor = new Color3(0.34, 0.13, 0.11);
    roofMat.specularColor = new Color3(0.06, 0.03, 0.02);

    const base = MeshBuilder.CreateBox(`devHouseBase-${id}`, { width: 4.8, height: 2.6, depth: 4 }, scene);
    base.position.y = 1.3;
    base.material = wallMat;
    const roof = MeshBuilder.CreateBox(`devHouseRoof-${id}`, { width: 5.6, height: 0.7, depth: 4.8 }, scene);
    roof.position.y = 2.95;
    roof.material = roofMat;
    const meshes = [base, roof];
    for (const mesh of meshes) {
      mesh.parent = root;
      mesh.metadata = { entityId: id, kind: "house" };
      mesh.isPickable = this.housePickable;
      this.receiveContactShadow(mesh);
    }
    return { root, meshes };
  }

  // ---- stone callbacks ----
  addStone(s: Stone, id: string) {
    if (this.stones.has(id)) return;
    const model = buildStone(this.camera.getScene());
    this.applySyncedTransform(model.root, s, 0.12);
    model.root.metadata = { entityId: id, kind: "stone" };
    for (const mesh of model.meshes) {
      mesh.metadata = { entityId: id, kind: "stone" };
      this.receiveContactShadow(mesh);
    }
    this.addContactShadow("stone", id, model.root, "pickup", 1.15, 1.3, 0.42, model.meshes);
    this.stones.set(id, {
      ...model,
      bob: Math.random() * Math.PI * 2,
      drop: this.dropsEnabled ? startDrop(0.12) : undefined,
    });
    this.upsertCircleFootprint("stone", id, s.x, s.z, STONE_PICK_RADIUS * (s.scale || 1), PICK_PRIORITY.collectible);
  }

  changeStone(s: Stone, id: string) {
    const st = this.stones.get(id);
    if (!st) return;
    this.applySyncedTransform(st.root, s, st.root.position.y);
    this.upsertCircleFootprint("stone", id, s.x, s.z, STONE_PICK_RADIUS * (s.scale || 1), PICK_PRIORITY.collectible);
  }

  removeStone(id: string) {
    const st = this.stones.get(id);
    if (!st) return;
    this.stones.delete(id);
    this.footprints.remove("stone", id);
    this.removeContactShadow("stone", id);
    this.startCollect(st);
  }

  // ---- banana callbacks ----
  addBanana(b: Banana, id: string) {
    if (this.bananas.has(id)) return;
    const model = buildBanana(this.camera.getScene());
    this.applySyncedTransform(model.root, b, 0.25);
    model.root.rotation.x = 0.25;
    model.root.rotation.z = 0.1;
    model.root.metadata = { entityId: id, kind: "banana" };
    for (const mesh of model.meshes) {
      mesh.metadata = { entityId: id, kind: "banana" };
      this.receiveContactShadow(mesh);
    }
    this.addContactShadow("banana", id, model.root, "pickup", 0.75, 0.95, 0.22, model.meshes);
    const ban = { ...model, spin: Math.random() * Math.PI * 2, drop: undefined as DropAnim | undefined };
    this.bananas.set(id, ban);

    // If this is the landing of a banana still being thrown, keep it hidden until
    // the thrown visual settles here and hands off — otherwise both show at once.
    let claimed = false;
    for (const t of this.thrown) {
      if (t.collectibleId) continue;
      const dx = t.landingX - b.x;
      const dz = t.landingZ - b.z;
      if (dx * dx + dz * dz <= 2.5 * 2.5) {
        t.collectibleId = id;
        model.root.setEnabled(false);
        this.setContactShadowEnabled("banana", id, false);
        claimed = true;
        break;
      }
    }
    // A freshly dropped banana pops into the air; one handed off from a thrown
    // banana already arced through flight, so it just appears where it landed.
    if (!claimed && this.dropsEnabled) ban.drop = startDrop(0.25);
    this.upsertCircleFootprint("banana", id, b.x, b.z, BANANA_PICK_RADIUS * (b.scale || 1), PICK_PRIORITY.collectible, !claimed);
  }

  changeBanana(b: Banana, id: string) {
    const ban = this.bananas.get(id);
    if (!ban) return;
    this.applySyncedTransform(ban.root, b, ban.root.position.y);
    ban.root.rotation.x = 0.25;
    ban.root.rotation.z = 0.1;
    this.upsertCircleFootprint("banana", id, b.x, b.z, BANANA_PICK_RADIUS * (b.scale || 1), PICK_PRIORITY.collectible);
  }

  removeBanana(id: string) {
    const b = this.bananas.get(id);
    if (!b) return;
    this.bananas.delete(id);
    this.footprints.remove("banana", id);
    this.removeContactShadow("banana", id);
    this.startCollect(b);
  }

  // ---- generic dev-authored item callbacks ----
  addItem(item: Item, id: string) {
    if (this.items.has(id) || this.pendingItems.has(id)) return;
    this.removedItems.delete(id);
    this.pendingItems.add(id);
    void this.createItem(item, id);
  }

  private async createItem(item: Item, id: string) {
    let model: CollectibleModel;
    try {
      model = await this.buildGenericItemModel(item.itemId);
    } catch (err) {
      console.warn(`[items] failed to load ${item.itemId}, using fallback`, err);
      model = this.buildFallbackItemModel(item.itemId);
    } finally {
      this.pendingItems.delete(id);
    }
    if (this.removedItems.has(id) || this.items.has(id)) {
      model.dispose();
      return;
    }
    const restY = Math.max(0.12, model.root.position.y || 0.18);
    model.root.name = `item-${item.itemId}-${id}`;
    this.applySyncedTransform(model.root, item, restY);
    model.root.metadata = { entityId: id, kind: "item" };
    for (const mesh of model.meshes) {
      mesh.metadata = { entityId: id, kind: "item" };
      mesh.isPickable = false;
      this.receiveContactShadow(mesh);
    }
    this.addContactShadow("item", id, model.root, "pickup", 1.0, 1.15, 0.23, model.meshes);
    this.items.set(id, {
      ...model,
      itemId: item.itemId,
      restY,
      bob: Math.random() * Math.PI * 2,
      drop: this.dropsEnabled ? startDrop(restY) : undefined,
    });
    this.upsertCircleFootprint("item", id, item.x, item.z, LOG_PICK_RADIUS * (item.scale || 1), PICK_PRIORITY.collectible);
  }

  private async buildGenericItemModel(itemId: string): Promise<CollectibleModel> {
    const scene = this.camera.getScene();
    await loadItemDefs();
    const def = itemDef(itemId);
    if (!def?.model) return this.buildFallbackItemModel(itemId);
    const model = await importModel(scene, def.model);
    applyTransform(model, def.worldScale ?? 1.2, 0, 0, 0);
    return model;
  }

  private buildFallbackItemModel(itemId: string): CollectibleModel {
    const icon = itemIcon(itemId);
    if (icon && icon !== "❓") return this.buildIconItemModel(itemId, icon);

    const scene = this.camera.getScene();
    const root = new TransformNode(`item-${itemId}`, scene);
    const mat = new StandardMaterial(`itemMat-${itemId}-${Math.random().toString(36).slice(2)}`, scene);
    mat.diffuseColor = colorFromId(itemId);
    mat.specularColor = new Color3(0.08, 0.08, 0.08);
    const body = MeshBuilder.CreateCylinder(
      `itemToken-${itemId}`,
      { height: 0.22, diameterTop: 0.65, diameterBottom: 0.65, tessellation: 6 },
      scene,
    );
    body.parent = root;
    body.position.y = 0.18;
    body.rotation.y = Math.PI / 6;
    body.material = mat;
    return {
      root,
      meshes: [body],
      dispose: () => {
        body.dispose();
        mat.dispose();
        root.dispose();
      },
    };
  }

  private buildIconItemModel(itemId: string, icon: string): CollectibleModel {
    const scene = this.camera.getScene();
    const root = new TransformNode(`item-${itemId}`, scene);
    const baseMat = new StandardMaterial(`itemBaseMat-${itemId}-${Math.random().toString(36).slice(2)}`, scene);
    baseMat.diffuseColor = colorFromId(itemId);
    baseMat.specularColor = new Color3(0.08, 0.08, 0.08);

    const base = MeshBuilder.CreateCylinder(
      `itemBase-${itemId}`,
      { height: 0.12, diameterTop: 0.52, diameterBottom: 0.6, tessellation: 10 },
      scene,
    );
    base.parent = root;
    base.position.y = 0.14;
    base.material = baseMat;

    const iconMat = new StandardMaterial(`itemIconMat-${itemId}-${Math.random().toString(36).slice(2)}`, scene);
    iconMat.backFaceCulling = false;
    iconMat.specularColor = new Color3(0, 0, 0);
    iconMat.emissiveColor = new Color3(1, 1, 1);

    let dynamicTexture: DynamicTexture | null = null;
    let imageTexture: Texture | null = null;
    if (/^\/|^https?:|^data:/i.test(icon)) {
      imageTexture = new Texture(icon, scene, false, false);
      imageTexture.hasAlpha = true;
      iconMat.diffuseTexture = imageTexture;
      iconMat.useAlphaFromDiffuseTexture = true;
    } else {
      dynamicTexture = new DynamicTexture(`itemIconTex-${itemId}`, { width: 256, height: 256 }, scene, false);
      dynamicTexture.hasAlpha = true;
      const ctx = dynamicTexture.getContext() as unknown as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, 256, 256);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "172px system-ui, Apple Color Emoji, Segoe UI Emoji, sans-serif";
      ctx.fillText(icon, 128, 134);
      dynamicTexture.update(false);
      iconMat.diffuseTexture = dynamicTexture;
      iconMat.useAlphaFromDiffuseTexture = true;
    }

    const plane = MeshBuilder.CreatePlane(`itemIcon-${itemId}`, { size: 0.82 }, scene);
    plane.parent = root;
    plane.position.y = 0.58;
    plane.billboardMode = 7;
    plane.material = iconMat;

    return {
      root,
      meshes: [base, plane],
      dispose: () => {
        base.dispose();
        plane.dispose();
        baseMat.dispose();
        iconMat.dispose();
        dynamicTexture?.dispose();
        imageTexture?.dispose();
        root.dispose();
      },
    };
  }

  changeItem(item: Item, id: string) {
    const model = this.items.get(id);
    if (!model) return;
    model.itemId = item.itemId;
    this.applySyncedTransform(model.root, item, model.root.position.y);
    this.upsertCircleFootprint("item", id, item.x, item.z, LOG_PICK_RADIUS * (item.scale || 1), PICK_PRIORITY.collectible);
  }

  removeItem(id: string) {
    const model = this.items.get(id);
    if (!model) {
      this.removedItems.add(id);
      return;
    }
    this.items.delete(id);
    this.footprints.remove("item", id);
    this.removeContactShadow("item", id);
    this.startCollect(model);
  }

  /**
   * Begin the "magnet" pickup FX: the just-grabbed item flies into the nearest
   * player (the collector), accelerating while it shrinks and fades, then is
   * disposed. If no player is plausibly nearby, it's just removed.
   */
  private startCollect(model: CollectibleModel) {
    model.root.setEnabled(true); // may have been hidden mid-throw; show it for the magnet
    let target: Entity | null = null;
    let best = Infinity;
    const px = model.root.position.x;
    const pz = model.root.position.z;
    for (const id of this.playerIds) {
      const e = this.entities.get(id);
      if (!e) continue;
      const d = (e.root.position.x - px) ** 2 + (e.root.position.z - pz) ** 2;
      if (d < best) {
        best = d;
        target = e;
      }
    }
    if (!target || best > COLLECT_MAGNET_MAX_DIST * COLLECT_MAGNET_MAX_DIST) {
      model.dispose(); // no plausible collector → no animation
      return;
    }
    this.collecting.push({
      model,
      target,
      t: 0,
      dur: COLLECT_DUR,
      startPos: model.root.position.clone(),
      startScale: model.root.scaling.clone(),
    });
    this.audio?.pickup({ x: px, z: pz });
  }

  /**
   * Animate a thrown banana: it arcs from the thrower to the landing spot, then
   * bounces in place — bounce height (and dust) scaling with the throw speed —
   * trailing sparks the whole way. When it settles it hands off to the real
   * collectible the server dropped there (revealed from hiding), so there is only
   * ever one banana on screen.
   */
  showBananaThrow(ev: BananaThrowEvent) {
    const scene = this.camera.getScene();
    const item: "banana" | "stone" = ev.item === "stone" ? "stone" : "banana";
    const model = ev.item === "stone" ? buildStoneShot(scene) : buildBanana(scene);
    for (const mesh of model.meshes) this.receiveContactShadow(mesh);
    const throwShadowOpts = {
      name: `shadow_throw_${Date.now()}`,
      shape: "pickup",
      x: ev.fromX,
      z: ev.fromZ,
      height: 1.1,
      width: item === "stone" ? 0.8 : 0.75,
      depth: item === "stone" ? 0.9 : 1.05,
      opacity: item === "stone" ? 0.38 : 0.24,
    } as const;
    const thrownShadow =
      this.shadows.mode === "legacy3d"
        ? this.shadows.addProjected({ ...throwShadowOpts, root: model.root, casters: model.meshes })
        : this.shadows.add(throwShadowOpts);
    this.audio?.throwItem({ x: ev.fromX, z: ev.fromZ }, item); // whoosh from the thrower
    const HAND_Y = 1.1;
    const R = THROW_RESTITUTION;

    // The arc and speed come from the FULL intended throw (arcTo); a prop in the
    // way only clips the flight short. So a banana that hits a tree flies exactly
    // like one sailing to open ground — same speed, same arc — then suddenly stops.
    const arcToX = ev.arcToX ?? ev.toX;
    const arcToZ = ev.arcToZ ?? ev.toZ;
    const fullDist = Math.hypot(arcToX - ev.fromX, arcToZ - ev.fromZ) || 0.001;
    const hitDist = Math.hypot(ev.toX - ev.fromX, ev.toZ - ev.fromZ);
    const f = Math.max(0, Math.min(1, hitDist / fullDist)); // fraction of the arc before impact
    const dur = Math.max(0.04, ev.flightMs / 1000); // already speed-correct (time to the hit point)
    const speed = hitDist / Math.max(0.04, dur); // = the full-throw speed, regardless of a prop
    const fullPeak = Math.min(3, 0.8 + fullDist * 0.18); // arc height from the FULL distance
    // height of the clipped arc where it meets the prop (mid-air if f < 1)
    const hitY = THROW_GROUND_Y + (HAND_Y - THROW_GROUND_Y) * (1 - f) + fullPeak * Math.sin(f * Math.PI);

    // hop 0: the throw — fly the full arc, but only up to fraction f (where the prop is)
    const hops: Hop[] = [
      { fromX: ev.fromX, fromZ: ev.fromZ, toX: ev.toX, toZ: ev.toZ, peak: fullPeak, dur, launchY: HAND_Y, arcFrac: f },
    ];
    // two diminishing bounces in place at the impact spot — energy ∝ the banana's
    // speed at impact (so a fast throw that suddenly hits a prop bounces hard).
    let bouncePeak = Math.max(0.25, Math.min(2.2, speed * 0.045));
    let startY = hitY; // the first bounce falls from the impact height
    for (let b = 0; b < 2; b++) {
      hops.push({
        fromX: ev.toX,
        fromZ: ev.toZ,
        toX: ev.toX,
        toZ: ev.toZ,
        peak: bouncePeak,
        dur: 0.42 * Math.sqrt(Math.max(0.2, bouncePeak)),
        launchY: startY,
      });
      bouncePeak *= R;
      startY = THROW_GROUND_Y;
    }

    this.thrown.push({
      model,
      shadow: thrownShadow,
      hops,
      hopIndex: 0,
      t: 0,
      impact: Math.max(0.25, Math.min(1.8, speed * 0.045)),
      fade: 0,
      trail: makeBananaTrail(scene, model.root.position),
      landingX: ev.toX,
      landingZ: ev.toZ,
      item,
    });
  }

  /** A hit landed — pop a floating damage number (and shake trees). */
  onDamage(ev: DamageEvent) {
    const e = this.entities.get(ev.targetId);
    if (e) {
      this.hud.showDamage(e.root, e.id, ev.amount, ev.crit);
      // a spray of blood at the struck character (strength ∝ damage)
      const strength = Math.max(0.4, Math.min(2.2, ev.amount / 12));
      this.particleFx.push({
        ps: makeBloodBurst(this.camera.getScene(), e.root.position.x, 1.2, e.root.position.z, strength),
        ttl: 0.7,
      });
      this.audio?.bodyHit({ x: e.root.position.x, z: e.root.position.z });
      // the local player also gets centered hurt feedback + red flash + shake.
      // The death sting is fired separately on the
      // DEAD state transition (see update()).
      if (e.id === this.localId) {
        this.audio?.hurt();
        this.damageFx?.onHit(ev.amount / Math.max(1, e.maxHp)); // ∝ fraction of max HP lost
      }
      return;
    }
    const tree = this.trees.get(ev.targetId);
    if (tree) {
      this.hud.showDamage(tree.root, ev.targetId, ev.amount, ev.crit);
      tree.shake();
      this.audio?.bodyHit({ x: tree.root.position.x, z: tree.root.position.z });
      this.audio?.treeChop({ x: tree.root.position.x, z: tree.root.position.z });
      return;
    }
    const rock = this.rocks.get(ev.targetId);
    if (rock) {
      this.hud.showDamage(rock.root, ev.targetId, ev.amount, ev.crit);
      rock.shake();
      this.audio?.bodyHit({ x: rock.root.position.x, z: rock.root.position.z });
      this.audio?.mine({ x: rock.root.position.x, z: rock.root.position.z });
      return;
    }
    const house = this.houses.get(ev.targetId);
    if (house) {
      this.hud.showDamage(house.anchor, ev.targetId, ev.amount, ev.crit);
      if (ev.targetId === "house-0") this.onCryptaDamage(ev.amount, house.anchor);
      this.audio?.bodyHit({ x: house.anchor.position.x, z: house.anchor.position.z });
      this.audio?.mine({ x: house.anchor.position.x, z: house.anchor.position.z });
    }
  }

  private onCryptaDamage(amount: number, anchor: TransformNode) {
    this.cryptaDamageSinceFeedback += Math.max(0, amount);
    if (this.cryptaDamageSinceFeedback < CRYPTA_DAMAGE_FEEDBACK_STEP) return;
    const now = performance.now();
    if (now < this.cryptaFeedbackReadyAt) return;
    this.cryptaDamageSinceFeedback = 0;
    this.cryptaFeedbackReadyAt = now + CRYPTA_DAMAGE_FEEDBACK_COOLDOWN_MS;
    const visible = this.isWorldPointInGameView(new Vector3(anchor.position.x, 2, anchor.position.z));
    this.damageFx?.shakeOnly(0.72);
    if (!visible) this.damageFx?.whiteAlert();
  }

  private isWorldPointInGameView(point: Vector3): boolean {
    const scene = this.camera.getScene();
    const engine = scene.getEngine();
    const rw = engine.getRenderWidth();
    const rh = engine.getRenderHeight();
    if (rw <= 0 || rh <= 0) return false;
    const viewport = this.camera.viewport.toGlobal(rw, rh);
    const screen = Vector3.Project(point, Matrix.IdentityReadOnly, scene.getTransformMatrix(), viewport);
    return screen.z >= 0 && screen.z <= 1 && screen.x >= 0 && screen.x <= rw && screen.y >= 0 && screen.y <= rh;
  }

  onKill(ev: KillEvent) {
    this.hud.showKill(ev);
  }

  /** A heal landed (potion pickup) — pop a green "+N" number. */
  onHeal(ev: HealEvent) {
    const e = this.entities.get(ev.targetId);
    if (e) {
      this.hud.showHeal(e.root, e.id, ev.amount);
      this.audio?.heal({ x: e.root.position.x, z: e.root.position.z });
      return;
    }
    const house = this.houses.get(ev.targetId);
    if (house) {
      this.hud.showHeal(house.anchor, ev.targetId, ev.amount);
      this.audio?.chop({ x: house.anchor.position.x, z: house.anchor.position.z });
    }
  }

  /** A player gained XP — pop a gold "+N XP" number over them. */
  onXp(ev: XpEvent) {
    const e = this.entities.get(ev.playerId);
    if (e) this.hud.showXp(e.root, ev.amount);
  }

  /** A player said something — float a chat bubble over their head. */
  showChatBubble(playerId: string, text: string) {
    const e = this.entities.get(playerId);
    if (e) this.hud.showChatBubble(e.root, playerId, text);
  }

  /** Current HP of the local player, for the health orb. */
  localHp(): { hp: number; maxHp: number } | null {
    const e = this.localId ? this.entities.get(this.localId) : null;
    return e ? { hp: e.hp, maxHp: e.maxHp } : null;
  }

  debugStats(): GameDebugStats {
    return {
      entities: this.entities.size,
      players: this.playerIds.size,
      potions: this.potions.size,
      trees: this.trees.size,
      logs: this.logs.size,
      rocks: this.rocks.size,
      stones: this.stones.size,
      bananas: this.bananas.size,
      items: this.items.size,
      houses: this.houses.size,
      thrown: this.thrown.length,
      particleFx: this.particleFx.length,
      collecting: this.collecting.length,
      lightnings: this.lightnings.length,
    };
  }

  /** Dev tool: clips available on the local player's animation rig. */
  animationTestClips(): AnimationDebugClip[] {
    const local = this.localId ? this.entities.get(this.localId) : null;
    return local?.animationDebugClips() ?? [];
  }

  /** Dev tool: play a mapped clip only on the local player. */
  playAnimationTestClip(state: AnimState): boolean {
    const local = this.localId ? this.entities.get(this.localId) : null;
    return local?.playAnimationDebugClip(state) ?? false;
  }

  /** Dev tool: restore the local player to server-driven animation. */
  clearAnimationTestClip() {
    const local = this.localId ? this.entities.get(this.localId) : null;
    local?.clearAnimationDebugClip();
  }

  // ---- internals ----
  /** Declare meshes as shadow receivers; the active runtime decides what that means. */
  private receiveContactShadow(mesh: AbstractMesh) {
    this.shadows.registerMeshes([mesh], { cast: false, receive: true });
  }

  private shadowKey(kind: string, id: string): string {
    return `${kind}:${id}`;
  }

  private addContactShadow(
    kind: string,
    id: string,
    root: TransformNode,
    shape: ContactShadowShape,
    width: number,
    depth: number,
    opacity: number,
    casters?: AbstractMesh[],
    staticWorld = false,
  ): ShadowHandle {
    const key = this.shadowKey(kind, id);
    this.removeContactShadow(kind, id);
    const opts = {
      name: `shadow_${kind}_${id}`,
      shape,
      x: root.position.x,
      z: root.position.z,
      height: root.position.y,
      width,
      depth,
      opacity,
    };
    const handle =
      casters?.length && staticWorld
        ? this.shadows.addWorldObject({ ...opts, root, casters })
        : casters?.length && (shape === "structure" || this.shadows.mode === "legacy3d")
          ? this.shadows.addProjected({ ...opts, root, casters })
          : this.shadows.add(opts);
    this.contactShadows.set(key, handle);
    return handle;
  }

  private updateContactShadow(kind: string, id: string, root: TransformNode, opacity?: number) {
    const handle = this.contactShadows.get(this.shadowKey(kind, id));
    if (!handle) return;
    handle.setPosition(root.position.x, root.position.z, root.position.y);
    if (opacity !== undefined) handle.setOpacity(opacity);
  }

  private setContactShadowEnabled(kind: string, id: string, on: boolean) {
    this.contactShadows.get(this.shadowKey(kind, id))?.setEnabled(on);
  }

  private resizeContactShadow(kind: string, id: string, width: number, depth: number) {
    this.contactShadows.get(this.shadowKey(kind, id))?.setSize(width, depth);
  }

  private removeContactShadow(kind: string, id: string) {
    const key = this.shadowKey(kind, id);
    this.contactShadows.get(key)?.dispose();
    this.contactShadows.delete(key);
  }

  private characterShadowSize(meshes: AbstractMesh[]): number {
    const b = bounds(meshes);
    const width = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    return Number.isFinite(width) && width > 0 ? width : 1.8;
  }

  private register(entity: Entity, view: ServerView, isEnemy: boolean) {
    entity.teleport(view.x, view.z);
    entity.setServerState(view.x, view.z, view.rotY, view.hp, view.maxHp, view.state, view.sprinting);
    entity.setVisualScale(view.scale ?? 1);
    entity.level = view.level;
    entity.berserkerMs = view.berserkerMs ?? 0;
    entity.root.metadata = { entityId: entity.id, kind: isEnemy ? "enemy" : "player" };
    const shadowSize = this.characterShadowSize(entity.meshes);
    this.characterShadeRadii.set(entity.id, Math.max(0.35, shadowSize * 0.42));
    this.addContactShadow(
      isEnemy ? "enemy" : "player",
      entity.id,
      entity.root,
      "character",
      shadowSize,
      shadowSize,
      isEnemy ? 0.46 : 0.5,
      entity.meshes,
    );
    this.hud.addCharacter(entity, isEnemy);
    this.entities.set(entity.id, entity);

    if (entity.id === this.localId) this.camera.target.set(view.x, 1, view.z);
    this.refreshPickable(entity);
    this.upsertCharacterFootprint(entity.id, entity);
  }

  /** A character is a click target only while it's a LIVING, non-local entity.
   *  Your own player and any corpse are click-through (a click walks to the ground
   *  behind them) and show no targeting cursor. */
  private refreshPickable(entity: Entity) {
    const pickable = entity.id !== this.localId && entity.hp > 0;
    for (const mesh of entity.meshes) {
      if (mesh.isPickable !== pickable) mesh.isPickable = pickable;
    }
  }

  private apply(id: string, view: ServerView) {
    const e = this.entities.get(id);
    if (!e) return;
    const nextBerserkerMs = view.berserkerMs ?? 0;
    const localBerserkerStarted = id === this.localId && e.berserkerMs <= 0 && nextBerserkerMs > 0;
    if (id === this.localId) {
      // track the local player's death window for the respawn countdown
      if (view.state === AnimState.DEAD) {
        if (this.deadElapsed === null) this.deadElapsed = 0;
      } else {
        this.deadElapsed = null;
      }
    }
    e.setServerState(view.x, view.z, view.rotY, view.hp, view.maxHp, view.state, view.sprinting);
    e.setVisualScale(view.scale ?? 1);
    e.level = view.level;
    e.berserkerMs = nextBerserkerMs;
    if (localBerserkerStarted) this.audio?.berserker();
    this.refreshPickable(e); // dead → click-through, alive → targetable again
    this.upsertCharacterFootprint(id, e);
  }

  /** Seconds until the local player respawns, or null if alive. */
  respawnCountdown(): number | null {
    if (this.deadElapsed === null) return null;
    return Math.max(0, PLAYER_RESPAWN_MS / 1000 - this.deadElapsed);
  }

  private unregister(id: string) {
    const entity = this.entities.get(id);
    if (!entity) return;
    this.hud.remove(id);
    const kind = (entity.root.metadata as { kind?: string } | null)?.kind ?? "enemy";
    this.footprints.remove(kind, id);
    this.characterShadeRadii.delete(id);
    this.removeContactShadow(kind, id);
    entity.dispose();
    this.entities.delete(id);
    this.audio?.forget(id); // drop footstep/death bookkeeping for this entity
  }

  /** Strike a lightning bolt at a spot (used for player respawns). */
  showLightning(x: number, z: number) {
    this.lightnings.push(buildLightning(this.camera.getScene(), x, z));
  }

  update(dt: number) {
    if (this.deadElapsed !== null) this.deadElapsed += dt;

    const audio = this.audio;
    const localPos = this.localId ? this.entities.get(this.localId)?.root.position : undefined;
    for (const [id, entity] of this.entities) {
      entity.update(dt);
      const kind = (entity.root.metadata as { kind?: string } | null)?.kind ?? "enemy";
      const structureShade =
        entity.hp > 0
          ? this.shadows.sampleStaticShade(
              entity.root.position.x,
              entity.root.position.z,
              this.characterShadeRadii.get(id) ?? 0.55,
            )
          : 0;
      entity.setShadowShade(structureShade * entity.nameplateAlpha);
      this.updateContactShadow(kind, id, entity.root, (kind === "player" ? 0.5 : 0.46) * entity.nameplateAlpha);
      if (!audio) continue;
      const px = entity.root.position.x;
      const pz = entity.root.position.z;
      const pos = { x: px, z: pz };
      audio.entityState(entity.id, entity.animState, pos, { gorillaAttack: kind === "player" });
      // footsteps: the local player always; others only when near — so a distant
      // goblin pack doesn't clatter (and we don't build inaudible voices for them).
      const near =
        entity.isLocal ||
        (localPos !== undefined && (px - localPos.x) ** 2 + (pz - localPos.z) ** 2 < 24 * 24);
      audio.footstep(entity.id, pos, near && entity.isMoving, entity.isSprinting, dt);
    }

    for (const [id, tree] of this.trees) {
      if (tree.update(dt)) this.shadows.refreshStaticShadows();
      this.updateContactShadow("tree", id, tree.root);
    }
    for (const [id, rock] of this.rocks) {
      if (rock.update(dt)) this.shadows.refreshStaticShadows();
      this.updateContactShadow("rock", id, rock.root);
    }

    for (const [id, pot] of this.potions) {
      pot.root.rotation.y += dt * 1.6;
      if (pot.drop && !pot.drop.settled) {
        pot.root.position.y = updateDrop(pot.drop, dt); // pop + bounce on drop
      } else {
        pot.bob += dt;
        pot.root.position.y = 0.25 + Math.sin(pot.bob * 2.2) * 0.12;
      }
      this.updateContactShadow("potion", id, pot.root);
    }
    for (const [id, log] of this.logs) {
      log.root.rotation.y += dt * 0.8;
      if (log.drop && !log.drop.settled) {
        log.root.position.y = updateDrop(log.drop, dt);
      } else {
        log.bob += dt;
        log.root.position.y = 0.12 + Math.sin(log.bob * 2) * 0.06;
      }
      this.updateContactShadow("log", id, log.root);
    }
    for (const [id, st] of this.stones) {
      st.root.rotation.y += dt * 0.6;
      if (st.drop && !st.drop.settled) {
        st.root.position.y = updateDrop(st.drop, dt);
      } else {
        st.bob += dt;
        st.root.position.y = 0.12 + Math.sin(st.bob * 2) * 0.05;
      }
      this.updateContactShadow("stone", id, st.root);
    }
    for (const [id, ban] of this.bananas) {
      ban.spin += dt;
      if (ban.drop && !ban.drop.settled) {
        ban.root.position.y = updateDrop(ban.drop, dt);
      } else {
        ban.root.position.y = 0.25 + Math.sin(ban.spin * 2) * 0.05;
      }
      this.updateContactShadow("banana", id, ban.root);
    }
    for (const [id, item] of this.items) {
      item.root.rotation.y += dt * 0.65;
      if (item.drop && !item.drop.settled) {
        item.root.position.y = updateDrop(item.drop, dt);
      } else {
        item.bob += dt;
        item.root.position.y = item.restY + Math.sin(item.bob * 2) * 0.05;
      }
      this.updateContactShadow("item", id, item.root);
    }

    // thrown bananas: arc to the landing, then bounce in place (height ∝ speed),
    // puffing dust at each ground hit. A spark trail follows in flight. On settling
    // it hands off to the real collectible there (or fades if none arrived yet).
    const throwScene = this.camera.getScene();
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const b = this.thrown[i];
      if (b.hopIndex < b.hops.length) {
        const hop = b.hops[b.hopIndex];
        b.t += dt;
        const p = Math.min(1, b.t / hop.dur);
        const x = hop.fromX + (hop.toX - hop.fromX) * p;
        const z = hop.fromZ + (hop.toZ - hop.fromZ) * p;
        // The throw hop draws only the first `frac` of a full arc (clipped where a
        // prop blocks it); bounces use a full arc (frac = 1).
        const frac = hop.arcFrac ?? 1;
        const y =
          THROW_GROUND_Y +
          (hop.launchY - THROW_GROUND_Y) * (1 - p * frac) +
          hop.peak * Math.sin(p * frac * Math.PI);
        b.model.root.position.set(x, y, z);
        b.shadow.setPosition(x, z, y);
        b.model.root.rotation.x += dt * 16;
        b.model.root.rotation.y += dt * 7;
        if (p >= 1) {
          // ground contact: kick up a dust + spark puff (smaller each bounce)
          const strength = b.impact * THROW_RESTITUTION ** b.hopIndex;
          this.particleFx.push({
            ps: makeBananaBurst(throwScene, hop.toX, THROW_GROUND_Y, hop.toZ, strength),
            ttl: 0.5,
          });
          // impact sound on the real landing (the throw hop), not the bounces
          if (b.hopIndex === 0) this.audio?.land({ x: hop.toX, z: hop.toZ }, b.item, b.impact);
          b.hopIndex++;
          b.t = 0;
          if (b.hopIndex >= b.hops.length) {
            // settled: detach + stop the trail, let it dissipate, then dispose
            if (b.trail) {
              b.trail.emitter = b.model.root.position.clone();
              b.trail.stop();
              this.particleFx.push({ ps: b.trail, ttl: 0.5 });
              b.trail = undefined;
            }
            // seamlessly become the collectible resting here (reveal it, drop the
            // throw visual) so there's never a duplicate banana
            const col = b.collectibleId ? this.bananas.get(b.collectibleId) : undefined;
            if (col) {
              col.root.setEnabled(true);
              this.setContactShadowEnabled("banana", b.collectibleId!, true);
              this.updateContactShadow("banana", b.collectibleId!, col.root);
              this.upsertCircleFootprint("banana", b.collectibleId!, col.root.position.x, col.root.position.z, BANANA_PICK_RADIUS, PICK_PRIORITY.collectible);
              b.shadow.dispose();
              b.model.dispose();
              this.thrown.splice(i, 1);
            }
          }
        }
      } else {
        // no collectible to hand off to (not arrived yet) → fade out and dispose
        b.fade += dt;
        const k = Math.min(1, b.fade / 0.3);
        for (const m of b.model.meshes) m.visibility = 1 - k;
        b.shadow.setOpacity(0.24 * (1 - k));
        if (k >= 1) {
          b.shadow.dispose();
          b.model.dispose();
          this.thrown.splice(i, 1);
        }
      }
    }

    // age out finished banana particle systems (trails + impact puffs)
    for (let i = this.particleFx.length - 1; i >= 0; i--) {
      const f = this.particleFx[i];
      f.ttl -= dt;
      if (f.ttl <= 0) {
        f.ps.dispose();
        this.particleFx.splice(i, 1);
      }
    }

    // collected items: magnet into the collector, accelerating while shrinking + fading
    for (let i = this.collecting.length - 1; i >= 0; i--) {
      const c = this.collecting[i];
      c.t += dt;
      const p = Math.min(1, c.t / c.dur);
      if (p >= 1 || c.target.root.isDisposed()) {
        c.model.dispose();
        this.collecting.splice(i, 1);
        continue;
      }
      const ease = p * p; // ease-in: slow start, then snap into the player
      const aim = c.target.root.position;
      Vector3.LerpToRef(
        c.startPos,
        new Vector3(aim.x, COLLECT_AIM_Y, aim.z),
        ease,
        c.model.root.position,
      );
      const s = 1 - ease; // shrink toward nothing
      c.model.root.scaling.set(
        c.startScale.x * s,
        c.startScale.y * s,
        c.startScale.z * s,
      );
      const vis = 1 - p; // fade out
      for (const m of c.model.meshes) m.visibility = vis;
      c.model.root.rotation.y += dt * 14; // little spin for flair
    }

    for (let i = this.lightnings.length - 1; i >= 0; i--) {
      if (!this.lightnings[i].update(dt)) {
        this.lightnings[i].dispose();
        this.lightnings.splice(i, 1);
      }
    }

    const local = this.localId ? this.entities.get(this.localId) : null;
    const focus = this.focusOverride; // dev: explorer is holding the camera off the player
    if (focus || local) {
      const f = smooth(dt, 0.12);
      const t = this.camera.target;
      const tx = focus ? focus.x : local!.root.position.x;
      const tz = focus ? focus.z : local!.root.position.z;
      t.x += (tx - t.x) * f;
      t.z += (tz - t.z) * f;
      t.y = 1;
    }
    this.shadows.updateFocus(
      { x: this.camera.target.x, y: this.camera.target.y, z: this.camera.target.z },
      getCameraZoom(),
    );
    // local-player hurt feedback: persistent low-HP vignette + decaying flash/shake
    if (this.damageFx) {
      if (local) this.damageFx.setHp(local.hp, local.maxHp);
      this.damageFx.update(dt);
    }

    this.hud.update(dt);
  }
}

function colorFromId(id: string): Color3 {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return Color3.FromHSV(hue, 0.55, 0.95);
}
