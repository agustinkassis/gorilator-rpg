import { AnimationGroup } from "@babylonjs/core";
import { AnimState } from "@rpg/shared";

const LOOPING = new Set<AnimState>([AnimState.IDLE, AnimState.WALK]);

export type AnimGroups = Partial<Record<AnimState, AnimationGroup>>;
/** Per-state playback speed multiplier (clips differ in length per model). */
export type AnimSpeeds = Partial<Record<AnimState, number>>;

/**
 * Small finite-state machine over a model's animation groups. Looping states
 * (idle/walk) loop; one-shot states (attack/hit) play once; death holds on its
 * last frame. Cross-fading is handled globally via the scene's
 * AnimationPropertiesOverride (see createScene).
 */
export class AnimationController {
  private current?: AnimState;

  constructor(
    private groups: AnimGroups,
    private speeds: AnimSpeeds = {},
  ) {
    for (const g of Object.values(groups)) g?.stop();
  }

  get hasAnims(): boolean {
    return Object.keys(this.groups).length > 0;
  }

  play(state: AnimState) {
    if (state === this.current) return;
    this.current = state;

    const next = this.groups[state] ?? this.groups[AnimState.IDLE];
    if (!next) return;

    for (const g of Object.values(this.groups)) {
      if (g && g !== next) g.stop();
    }

    const loop = LOOPING.has(state);
    next.start(loop, this.speeds[state] ?? 1.0, next.from, next.to, false);

    // Freeze death on its final pose instead of snapping back to bind.
    if (state === AnimState.DEAD) {
      next.onAnimationGroupEndObservable.addOnce(() => next.goToFrame(next.to));
    }
  }

  dispose() {
    for (const g of Object.values(this.groups)) g?.dispose();
  }
}
