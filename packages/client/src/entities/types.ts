import { type TransformNode, type AbstractMesh, Color3 } from "@babylonjs/core";
import type { AnimState } from "@rpg/shared";
import type { AnimGroups } from "./AnimationController";

/** Bright flash colour for the "taking damage" reaction (works on any base colour). */
export const HIT_FLASH = new Color3(1, 1, 1);
/** Dark-red flash for the LOCAL player taking damage (an intermittent "ow" pulse). */
export const DAMAGE_FLASH = new Color3(0.6, 0, 0);
/** Green shimmer overlay for the berserker power buff. */
export const BERSERK_FLASH = new Color3(0.05, 1.0, 0.2);

/**
 * A spawned character view. Skeletal models drive `groups` via AnimationController;
 * primitive models (gorilla, dummy) leave `groups` empty and supply a `pose`
 * function that the Entity calls each frame to animate their joints procedurally.
 */
export interface SpawnedCharacter {
  root: TransformNode;
  meshes: AbstractMesh[];
  groups: AnimGroups;
  hasAnims: boolean;
  /**
   * Multiplier applied to the server yaw before facing the model (default 1).
   * glTF imports get a `__root__` with a negative-Z scale (the right→left-handed
   * conversion); rotating an ancestor of that mirror reflects the yaw across the
   * N–S axis, so such models pass -1 to flip it back.
   */
  yawSign?: number;
  /** Per-state animation playback speed (clips differ in length per model). */
  speeds?: Partial<Record<AnimState, number>>;
  /** Per-state yaw correction (radians) for clips authored off the model's forward. */
  yawFix?: Partial<Record<AnimState, number>>;
  pose?: (state: AnimState, t: number) => void;
  flashHit: (on: boolean, color?: Color3) => void;
  dispose: () => void;
}
