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
  private currentGroup?: AnimationGroup;
  private currentBaseSpeed = 1; // the playing clip's per-state tuning speed
  private speedScale = 1; // live multiplier on top of it (e.g. 1.35 while sprinting)

  constructor(
    private groups: AnimGroups,
    private speeds: AnimSpeeds = {},
  ) {
    for (const g of Object.values(groups)) g?.stop();
  }

  get hasAnims(): boolean {
    return Object.keys(this.groups).length > 0;
  }

  play(state: AnimState, force = false) {
    if (!force && state === this.current) return;
    this.current = state;

    const next = this.groups[state] ?? this.groups[AnimState.IDLE];
    if (!next) {
      this.currentGroup = undefined;
      return;
    }

    for (const g of Object.values(this.groups)) {
      if (g && g !== next) g.stop();
    }

    const loop = LOOPING.has(state);
    this.currentGroup = next;
    this.currentBaseSpeed = this.speeds[state] ?? 1.0;
    next.start(loop, this.currentBaseSpeed * this.speedScale, next.from, next.to, false);

    // Freeze death on its final pose instead of snapping back to bind.
    if (state === AnimState.DEAD) {
      next.onAnimationGroupEndObservable.addOnce(() => next.goToFrame(next.to));
    }
  }

  /** Live playback-speed multiplier on top of the current clip's tuned speed —
   *  used to run the locomotion cycle faster (×SPRINT_SPEED_MULT) while sprinting
   *  so the legs keep pace with the boosted movement instead of sliding. */
  setSpeedScale(scale: number) {
    if (scale === this.speedScale) return;
    this.speedScale = scale;
    if (this.currentGroup) this.currentGroup.speedRatio = this.currentBaseSpeed * scale;
  }

  dispose() {
    for (const g of Object.values(this.groups)) g?.dispose();
  }
}
