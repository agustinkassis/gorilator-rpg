import { TransformNode, AbstractMesh, Color3 } from "@babylonjs/core";
import { AnimState } from "@rpg/shared";
import { AnimGroups } from "./AnimationController";

/** Bright flash colour for the "taking damage" reaction (works on any base colour). */
export const HIT_FLASH = new Color3(1, 1, 1);

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
  flashHit: (on: boolean) => void;
  dispose: () => void;
}
