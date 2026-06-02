import {
  Scene,
  SceneLoader,
  AssetContainer,
  TransformNode,
  AbstractMesh,
  AnimationGroup,
  PBRMaterial,
  Color3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { AnimState } from "@rpg/shared";
import { AnimGroups, AnimSpeeds } from "./AnimationController";
import { SpawnedCharacter, HIT_FLASH } from "./types";
import { buildDummy } from "./models/dummy";

const MODEL_URL = "/models/knight.glb";
/** A separate clip (baseball pitch) retargeted onto the character rig for THROW.
 *  Its skeleton is identical to knight.glb (same 24 bones), so it maps 1:1. */
const THROW_MODEL_URL = "/models/throw.glb";
/** The default attack swing — a separate Crimson Gorilla clip on the same 24-bone
 *  rig, retargeted onto the character to OVERRIDE the bundled knight.glb Attack. */
const ATTACK_MODEL_URL = "/models/attack.glb";
/** The goblin enemy — same 24-bone skeleton, its own clips (see GOBLIN_ANIM_MAP). */
const GOBLIN_MODEL_URL = "/models/goblin.glb";
/** Rotate the loaded model around Y if it doesn't face +Z. (e.g. Math.PI to flip.) */
const MODEL_FORWARD_OFFSET = 0;
const MODEL_SCALE = 1;

const DEG = Math.PI / 180;

export type CharacterKind = "player" | "enemy" | "goblin";

/** A model's clip→state map + per-state speed/yaw tuning + the source container. */
interface ModelConfig {
  container: AssetContainer;
  animMap: Record<string, AnimState>;
  speeds: AnimSpeeds;
  yawFix: Partial<Record<AnimState, number>>;
  scale: number;
  throwTemplate?: AnimationGroup | null;
  attackTemplate?: AnimationGroup | null;
}

/**
 * Clip-name → state map for the bundled knight.glb (Meshy "Crimson Gorilla").
 * The clips were renamed to match their real motion (Meshy's auto-export had
 * scrambled the names vs the animation baked into each). Spares: `Walking`/`Hit_2`.
 * A different model still resolves via the generic `matchState` keyword fallback.
 */
const ANIM_NAME_MAP: Record<string, AnimState> = {
  Idle: AnimState.IDLE,
  Running: AnimState.WALK, // use the run cycle while moving (Walking clip is now spare)
  Attack: AnimState.ATTACK,
  Hit: AnimState.HIT,
  Death: AnimState.DEAD,
};
/** Gorilla speed/yaw tuning. The standalone clips were authored facing off from
 *  the rig's forward, so each gets a yaw correction. */
const GORILLA_SPEEDS: AnimSpeeds = {
  [AnimState.THROW]: 6.53, // pitch plays 50% faster (4.35 → 6.53)
  [AnimState.ATTACK]: 4.5, // the swing clip is ~2.83s; ~4.5× makes it read in the combat window
};
const GORILLA_YAW_FIX = { [AnimState.ATTACK]: 45 * DEG, [AnimState.THROW]: 56 * DEG };

/**
 * Goblin clips (Meshy "Gloombraid Goblin"): no idle/attack clip, so Walking
 * stands in for idle and the Basic_Jump leap is the attack. The long clips are
 * sped up to read in the short combat windows.
 */
const GOBLIN_ANIM_MAP: Record<string, AnimState> = {
  Walking: AnimState.IDLE, // 1s walk loop → a gentle idle
  Running: AnimState.WALK, // run cycle → patrol/chase movement
  Basic_Jump: AnimState.ATTACK, // a leap → lunge attack
  Slap_Reaction: AnimState.HIT, // recoil → hit reaction
  Knock_Down: AnimState.DEAD, // knockdown → death
};
const GOBLIN_SPEEDS: AnimSpeeds = {
  [AnimState.IDLE]: 0, // the goblin has no idle clip; freeze the Walking pose (no march-in-place)
  [AnimState.ATTACK]: 5, // Basic_Jump is ~5.9s; show the leap in the attack window
  [AnimState.HIT]: 5, // Slap_Reaction is ~4.9s; show the recoil
  [AnimState.DEAD]: 1.5, // Knock_Down ~2.5s → ~1.7s
};
const GOBLIN_YAW_FIX = {}; // tune here if the goblin attacks/reacts off-facing

/** Map a model's animation-group name onto one of our AnimStates. */
function matchState(rawName: string): AnimState | undefined {
  const n = rawName.toLowerCase();
  if (n.includes("idle")) return AnimState.IDLE;
  if (n.includes("walk") || n.includes("run") || n.includes("jog")) return AnimState.WALK;
  if (n.includes("attack") || n.includes("slash") || n.includes("swing")) return AnimState.ATTACK;
  if (
    n.includes("hit") ||
    n.includes("damage") ||
    n.includes("recieve") ||
    n.includes("receive") ||
    n.includes("react")
  )
    return AnimState.HIT;
  if (n.includes("death") || n.includes("die") || n.includes("dead")) return AnimState.DEAD;
  return undefined;
}

export class CharacterFactory {
  private container: AssetContainer | null = null;
  /** Kept alive so its bone TransformNodes stay valid as the THROW clip's source. */
  private throwContainer: AssetContainer | null = null;
  /** The pitch AnimationGroup, retargeted per-instance onto each spawned rig. */
  private throwTemplate: AnimationGroup | null = null;
  /** Kept alive so its bone TransformNodes stay valid as the ATTACK clip's source. */
  private attackContainer: AssetContainer | null = null;
  /** The default-attack AnimationGroup, retargeted per-instance onto each rig. */
  private attackTemplate: AnimationGroup | null = null;
  /** The goblin enemy model (own clips), instanced per goblin. */
  private goblinContainer: AssetContainer | null = null;

  constructor(private scene: Scene) {}

  /**
   * Try to load the real model once. Falls back to built-in models if it's
   * missing. `playerOnly` skips the throw + goblin clips (the splash hero needs
   * neither) so a throwaway preview scene loads just the player gorilla.
   */
  async preload(opts: { playerOnly?: boolean } = {}): Promise<void> {
    // Probe first so a missing model doesn't spam the console with loader errors.
    // Note: dev servers serve index.html (200, text/html) for missing paths, so a
    // 200 alone isn't enough — require a non-HTML (i.e. real asset) response.
    let exists = false;
    try {
      const res = await fetch(MODEL_URL, { method: "HEAD" });
      const type = res.headers.get("content-type") ?? "";
      exists = res.ok && !type.includes("text/html");
    } catch {
      exists = false;
    }
    if (!exists) {
      console.info(
        `[assets] ${MODEL_URL} not present — falling back to the built-in dummy model ` +
          `(this glb is the gorilla now; see public/models/README.md).`,
      );
      this.container = null;
      return;
    }

    try {
      this.container = await SceneLoader.LoadAssetContainerAsync("", MODEL_URL, this.scene);
      this.container.animationGroups.forEach((g) => g.stop());
      // Meshy/Blender exports default to fully-metallic PBR, which renders dark
      // without an environment map. This scene lights with a hemispheric + a
      // directional light (no IBL), so force the character matte to let its
      // base-colour texture read correctly.
      for (const mat of this.container.materials) {
        if (mat instanceof PBRMaterial) {
          mat.metallic = 0;
          mat.roughness = 0.85;
          // The glTF ships an alpha channel that makes Babylon treat the material
          // as transparent — and transparent meshes are skipped by the shadow map,
          // so characters cast/receive no shadows. Force OPAQUE so they do.
          mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
          // Meshy ships twoSidedLighting+no-culling; combined with the glTF
          // `__root__` negative scale that flips the lighting normals when viewed
          // from the back hemisphere (the model looked "inverted"). Cull back
          // faces and disable two-sided lighting so it renders right from any angle.
          mat.backFaceCulling = true;
          mat.twoSidedLighting = false;
        }
      }
      console.log(
        `[assets] loaded ${MODEL_URL} with animations:`,
        this.container.animationGroups.map((g) => g.name),
      );
    } catch (err) {
      console.warn(`[assets] failed to load ${MODEL_URL}; using built-in models.`, err);
      this.container = null;
    }

    if (opts.playerOnly) return; // splash preview: just the player gorilla

    // The throw (pitch) + attack (swing) clips are separate files retargeted onto
    // the rig at spawn.
    if (this.container) await this.loadThrowAnimation();
    if (this.container) await this.loadAttackAnimation();
    await this.loadGoblin();
  }

  /** Probe + load a glb into a container, matte its PBR materials, stop its clips. */
  private async probeAndLoad(url: string): Promise<AssetContainer | null> {
    let exists = false;
    try {
      const res = await fetch(url, { method: "HEAD" });
      const type = res.headers.get("content-type") ?? "";
      exists = res.ok && !type.includes("text/html");
    } catch {
      exists = false;
    }
    if (!exists) {
      console.info(`[assets] ${url} not present.`);
      return null;
    }
    try {
      const c = await SceneLoader.LoadAssetContainerAsync("", url, this.scene);
      c.animationGroups.forEach((g) => g.stop());
      for (const mat of c.materials) {
        if (mat instanceof PBRMaterial) {
          mat.metallic = 0;
          mat.roughness = 0.85;
          // Force OPAQUE — a transparent material is skipped by the shadow map,
          // so the goblin (this path) wouldn't cast or receive shadows otherwise.
          mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
          mat.backFaceCulling = true;
          mat.twoSidedLighting = false;
        }
      }
      console.log(`[assets] loaded ${url}:`, c.animationGroups.map((g) => g.name));
      return c;
    } catch (err) {
      console.warn(`[assets] failed to load ${url}.`, err);
      return null;
    }
  }

  /** Load the goblin enemy model (own rig clips, retargeting not needed). */
  private async loadGoblin(): Promise<void> {
    this.goblinContainer = await this.probeAndLoad(GOBLIN_MODEL_URL);
  }

  /** Load the pitch clip once and keep its AnimationGroup as a retarget template. */
  private async loadThrowAnimation(): Promise<void> {
    let exists = false;
    try {
      const res = await fetch(THROW_MODEL_URL, { method: "HEAD" });
      const type = res.headers.get("content-type") ?? "";
      exists = res.ok && !type.includes("text/html");
    } catch {
      exists = false;
    }
    if (!exists) {
      console.info(`[assets] ${THROW_MODEL_URL} not present — no throw animation.`);
      return;
    }
    try {
      this.throwContainer = await SceneLoader.LoadAssetContainerAsync("", THROW_MODEL_URL, this.scene);
      const ag = this.throwContainer.animationGroups[0] ?? null;
      ag?.stop();
      this.throwTemplate = ag;
      console.log(`[assets] loaded throw clip: ${ag?.name ?? "(none)"}`);
    } catch (err) {
      console.warn(`[assets] failed to load ${THROW_MODEL_URL}; no throw animation.`, err);
      this.throwContainer = null;
      this.throwTemplate = null;
    }
  }

  /** Load the default-attack clip once and keep its AnimationGroup as a retarget
   *  template (overrides the bundled Attack clip on every gorilla-rig character). */
  private async loadAttackAnimation(): Promise<void> {
    let exists = false;
    try {
      const res = await fetch(ATTACK_MODEL_URL, { method: "HEAD" });
      const type = res.headers.get("content-type") ?? "";
      exists = res.ok && !type.includes("text/html");
    } catch {
      exists = false;
    }
    if (!exists) {
      console.info(`[assets] ${ATTACK_MODEL_URL} not present — using the bundled Attack clip.`);
      return;
    }
    try {
      this.attackContainer = await SceneLoader.LoadAssetContainerAsync("", ATTACK_MODEL_URL, this.scene);
      const ag = this.attackContainer.animationGroups[0] ?? null;
      ag?.stop();
      this.attackTemplate = ag;
      console.log(`[assets] loaded attack clip: ${ag?.name ?? "(none)"}`);
    } catch (err) {
      console.warn(`[assets] failed to load ${ATTACK_MODEL_URL}; using the bundled Attack clip.`, err);
      this.attackContainer = null;
      this.attackTemplate = null;
    }
  }

  /** `scale` overrides the per-kind default (the splash passes a larger value to
   *  show the hero off bigger than it appears in gameplay). */
  spawn(kind: CharacterKind, accent: Color3, scale?: number): SpawnedCharacter {
    if (kind === "goblin" && this.goblinContainer) {
      return this.spawnFromContainer({
        container: this.goblinContainer,
        animMap: GOBLIN_ANIM_MAP,
        speeds: GOBLIN_SPEEDS,
        yawFix: GOBLIN_YAW_FIX,
        scale: scale ?? MODEL_SCALE,
      });
    }
    // Players + training dummies share the gorilla rig (identical orientation,
    // animation and shadow handling).
    if (this.container) {
      return this.spawnFromContainer({
        container: this.container,
        animMap: ANIM_NAME_MAP,
        speeds: GORILLA_SPEEDS,
        yawFix: GORILLA_YAW_FIX,
        scale: scale ?? MODEL_SCALE,
        throwTemplate: this.throwTemplate,
        attackTemplate: this.attackTemplate,
      });
    }
    // No glb present: everything degrades to the built-in straw dummy. (The
    // primitive gorilla model was removed; the gorilla is the bundled glb now.)
    return buildDummy(this.scene);
  }

  /** Clone a clip authored on the same rig onto THIS instance's bones (matched by
   *  name), so a separate-file animation plays on the spawned character. The clone
   *  is disposed with the rest via AnimationController.dispose(). */
  private retargetClip(
    template: AnimationGroup,
    holder: TransformNode,
    label: string,
  ): AnimationGroup {
    const boneByName = new Map<string, TransformNode>();
    for (const n of holder.getDescendants(false)) {
      if (n instanceof TransformNode) boneByName.set(n.name, n);
    }
    const clip = template.clone(`${label}_${holder.uniqueId}`, (old) => {
      const name = (old as { name?: string } | null)?.name;
      return (name && boneByName.get(name)) || old;
    });
    clip.stop();
    return clip;
  }

  /** Instantiate one character from a loaded container, wiring its clips → states. */
  private spawnFromContainer(cfg: ModelConfig): SpawnedCharacter {
    // doNotInstantiate:true → full mesh CLONES, not InstancedMesh. InstancedMesh
    // share their source mesh's `renderOverlay`, so a hit-flash on one would flash
    // EVERY character of the same kind. Clones give each character an independent
    // overlay so only the one actually struck flashes.
    const entries = cfg.container.instantiateModelsToScene((name) => name, false, {
      doNotInstantiate: true,
    });
    const holder = new TransformNode("char", this.scene);
    const modelRoot = entries.rootNodes[0] as TransformNode;
    modelRoot.parent = holder;
    modelRoot.rotation.y += MODEL_FORWARD_OFFSET;
    holder.scaling.setAll(cfg.scale);

    // Show the model's own PBR textures; the overlay is reserved for the
    // white "taking damage" flash (a resting tint muddies the material).
    const meshes = holder.getChildMeshes();
    for (const m of meshes) m.renderOverlay = false;

    const ags = entries.animationGroups as AnimationGroup[];
    for (const g of ags) g.stop();
    const groups: AnimGroups = {};
    // Pass 1: exact clip names from this model's map win.
    for (const g of ags) {
      const key = cfg.animMap[g.name];
      if (key && !groups[key]) groups[key] = g;
    }
    // Pass 2: generic keyword fallback fills any state not named exactly.
    for (const g of ags) {
      const key = matchState(g.name);
      if (key && !groups[key]) groups[key] = g;
    }

    // Retarget separate-file clips (same gorilla rig) onto THIS instance's bones:
    // the pitch → THROW, and the dedicated swing → ATTACK (overriding the clip
    // baked into knight.glb). Both clones are disposed via AnimationController.
    if (cfg.throwTemplate)
      groups[AnimState.THROW] = this.retargetClip(cfg.throwTemplate, holder, "throw");
    if (cfg.attackTemplate)
      groups[AnimState.ATTACK] = this.retargetClip(cfg.attackTemplate, holder, "attack");

    return {
      root: holder,
      meshes,
      groups,
      hasAnims: Object.keys(groups).length > 0,
      speeds: cfg.speeds,
      yawFix: cfg.yawFix,
      flashHit: (on, color = HIT_FLASH) => {
        for (const m of meshes) {
          m.renderOverlay = on;
          m.overlayColor = color;
          m.overlayAlpha = on ? 0.6 : 0;
        }
      },
      dispose: () => {
        for (const g of entries.animationGroups) g.dispose();
        holder.dispose();
      },
    };
  }
}
