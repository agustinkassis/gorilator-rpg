import { TransformNode, Scalar, AbstractMesh, Color3, ParticleSystem } from "@babylonjs/core";
import { AnimState, SPRINT_SPEED_MULT, BERSERKER_SCALE } from "@rpg/shared";
import { AnimationController } from "./AnimationController";
import { SpawnedCharacter, HIT_FLASH, DAMAGE_FLASH, BERSERK_FLASH } from "./types";
import { makeBerserkerAura } from "../fx/berserkerFx";
import { getCameraZoom } from "../scene/camera";
import { lerpAngle, smooth } from "../util/math";

export interface AnimationDebugClip {
  state: AnimState;
  label: string;
}

interface RespawnSeq {
  phase: "out" | "in";
  t: number;
  realStart: number; // wall-clock start, so a stalled (throttled) fade still completes
  nx: number;
  nz: number;
  nrot: number;
  nstate: AnimState;
}

const RESPAWN_OUT_MAX_MS = 2500; // force-finish the fade-out by this much real time

const FADE_OUT = 0.5;
const FADE_IN = 0.45;

// Enemy corpse fade (corpseFx): hold on the death pose, then dissolve away; the
// server respawns the body later (it pops back in at its home).
const CORPSE_HOLD = 1.8; // let the death animation finish before fading
const CORPSE_FADE = 0.9; // seconds to fade the corpse to nothing

// A brief white pulse on a character when you pick it as your attack target.
const SELECT_FLASH_MS = 0.6; // total duration of the select flash
const SELECT_BLINK_MS = 0.1; // overlay toggles every this long → "flash, flash, flash"
const DMG_BLINK_MS = 0.08; // local player's dark-red damage flash toggles this fast
const GHOST_FLOAT = 0.845; // units a paused "ghost" player floats off the floor (0.65 + 30%)
const GHOST_VISIBILITY = 0.7; // translucency of a ghosting player
const GHOST_BOB_AMPL = 0.08; // how far the ghost drifts up/down around its float height
const GHOST_BOB_HZ = 0.6; // gentle bob cycles per second
const GHOST_FLY_TILT = 0.6; // radians the ghost pitches forward when flying (~34°)
const GHOST_FLY_MIN_SPEED = 0.3; // units/sec of motion before the flight tilt kicks in

/**
 * Client-side view of one networked character (player or dummy). Interpolates
 * toward the authoritative server state and drives the animation FSM. Players
 * (respawnFx=true) play a death fade-out → teleport → lightning → fade-in when
 * the server brings them back.
 */
export class Entity {
  readonly id: string;
  readonly isLocal: boolean;
  readonly root: TransformNode;

  hp = 1;
  maxHp = 1;
  name = "";
  level = 1;

  /** Play the fade-out + lightning respawn sequence (players only). */
  respawnFx = false;
  /** Fade the corpse out after death, then pop back in on respawn (enemies). */
  corpseFx = false;
  private corpseT = 0; // seconds since this enemy died
  private bodyAlpha = 1; // current mesh opacity; the floating nameplate fades to match
  /** Fired at the moment of respawn (teleport), with the new position. */
  onRespawn?: (x: number, z: number) => void;

  private spawned: SpawnedCharacter;
  private anim: AnimationController;

  private targetX = 0;
  private targetZ = 0;
  private targetRotY = 0;
  private state: AnimState = AnimState.IDLE;
  private sprinting = false; // server flag → run the WALK cycle SPRINT_SPEED_MULT× faster
  private stateTime = 0;
  private respawn: RespawnSeq | null = null;
  /** Yaw multiplier (see SpawnedCharacter.yawSign); -1 for mirrored glTF roots. */
  private readonly yawSign: number;
  /** Interpolated facing, kept separate from the per-clip yaw correction below. */
  private facingY = 0;
  private yawFix = 0; // current (blended) clip-orientation correction
  private yawFixTarget = 0; // correction the current clip wants
  private ghostTilt = 0; // blended forward pitch while ghost-flying
  // Real-motion tracking, so a body that isn't actually translating (stuck on
  // geometry, blocked, or arrived) stands in IDLE rather than walking in place.
  private lastX = 0;
  private lastZ = 0;
  private moveSpeed = 0; // smoothed units/sec of real root movement
  private movingShown = false; // hysteresis latch for the WALK↔IDLE choice
  private shownState: AnimState = AnimState.IDLE; // the clip actually playing
  private selectFlashT = 0; // seconds left in the attack-target white flash
  private overlayOn = false; // current overlay on/off (HIT flash, damage flash, or select flash)
  private overlayColor: Color3 = HIT_FLASH; // current overlay tint
  private ghost = false; // Dev Mode: translucent + floating (paused free-roam)
  private animationTestOverride = false; // Dev tool: hold a manually-triggered clip until cleared

  // ---- Berserker buff visuals ----
  /** ms remaining on the berserker buff (0 = inactive); set by Game.ts each server tick. */
  berserkerMs = 0;
  private berserkerActive = false;
  private berserkerParticles: ParticleSystem | null = null;
  private visualScale = 1;
  private naturalScaleX = 1;
  private naturalScaleY = 1;
  private naturalScaleZ = 1;

  constructor(id: string, spawned: SpawnedCharacter, isLocal: boolean) {
    this.id = id;
    this.isLocal = isLocal;
    this.spawned = spawned;
    this.yawSign = spawned.yawSign ?? 1;
    this.root = spawned.root;
    this.naturalScaleX = this.root.scaling.x;
    this.naturalScaleY = this.root.scaling.y;
    this.naturalScaleZ = this.root.scaling.z;
    this.root.metadata = { entityId: id };
    this.anim = new AnimationController(spawned.groups, spawned.speeds);
    this.anim.play(AnimState.IDLE);
  }

  get meshes(): AbstractMesh[] {
    return this.spawned.meshes;
  }

  /** The current authoritative animation state (for the audio death sting, etc.). */
  get animState(): AnimState {
    return this.state;
  }
  /** Dev tool: the mapped skeletal clips on this character, in gameplay-state order. */
  animationDebugClips(): AnimationDebugClip[] {
    const order = [
      AnimState.IDLE,
      AnimState.WALK,
      AnimState.ATTACK,
      AnimState.THROW,
      AnimState.HIT,
      AnimState.DEAD,
    ];
    return order.flatMap((state) => {
      const group = this.spawned.groups[state];
      return group ? [{ state, label: `${stateLabel(state)} - ${group.name}` }] : [];
    });
  }
  /** Dev tool: temporarily override the FSM so a chosen local clip can be tested. */
  playAnimationDebugClip(state: AnimState): boolean {
    if (!this.spawned.groups[state]) return false;
    this.animationTestOverride = true;
    this.shownState = state;
    this.yawFixTarget = this.spawned.yawFix?.[state] ?? 0;
    this.anim.setSpeedScale(1);
    this.anim.play(state, true);
    return true;
  }
  /** Dev tool: hand animation control back to the server-driven FSM. */
  clearAnimationDebugClip() {
    if (!this.animationTestOverride) return;
    this.animationTestOverride = false;
    this.yawFixTarget = this.spawned.yawFix?.[this.state] ?? 0;
    this.refreshAnim(true);
  }
  /** True while the WALK locomotion clip is actually showing (real movement, post-hysteresis). */
  get isMoving(): boolean {
    return this.shownState === AnimState.WALK;
  }
  /** True while the server says this character is sprinting. */
  get isSprinting(): boolean {
    return this.sprinting;
  }

  /** Briefly flash this character white — used when it's picked as an attack target. */
  flashSelect() {
    this.selectFlashT = SELECT_FLASH_MS;
  }

  /** Dev Mode transform scale. Gameplay effects like Berserker layer on top. */
  setVisualScale(scale: number) {
    const next = Number.isFinite(scale) ? Math.max(0.05, Math.min(40, scale)) : 1;
    if (Math.abs(next - this.visualScale) < 0.001) return;
    this.visualScale = next;
    this.applyVisualScale();
  }

  private applyVisualScale() {
    const mult = this.visualScale * (this.berserkerActive ? BERSERKER_SCALE : 1);
    this.root.scaling.set(
      this.naturalScaleX * mult,
      this.naturalScaleY * mult,
      this.naturalScaleZ * mult,
    );
  }

  /** Dev Mode ghost: go translucent + float off the ground (the local player while
   *  the game is paused). Idempotent; restoring drops it back to opaque on the floor. */
  setGhost(on: boolean) {
    if (on === this.ghost) return;
    this.ghost = on;
    this.setVisibility(on ? GHOST_VISIBILITY : 1);
    this.root.position.y = on ? GHOST_FLOAT * getCameraZoom() : 0; // higher the more zoomed out
    if (!on) {
      this.ghostTilt = 0;
      this.root.rotation.x = 0; // drop the flight pitch back upright
    }
  }

  /** Snap to a position with no interpolation (used on spawn). */
  teleport(x: number, z: number) {
    this.targetX = x;
    this.targetZ = z;
    this.root.position.x = x;
    this.root.position.z = z;
    // no spurious velocity from the jump
    this.lastX = x;
    this.lastZ = z;
    this.moveSpeed = 0;
    this.movingShown = false;
  }

  /**
   * Decide which clip actually plays. Locomotion (WALK) is suppressed to IDLE
   * when the body isn't really moving, so a stuck/blocked/arrived character
   * never walks in place. One-shots (ATTACK/HIT/THROW/DEAD) always play as-is.
   */
  private refreshAnim(force = false) {
    let want = this.state;
    if (this.state === AnimState.WALK) {
      const moving = this.movingShown
        ? this.moveSpeed > 0.1 // keep walking until nearly stopped...
        : this.moveSpeed > 0.4; // ...but require real motion to start (hysteresis)
      this.movingShown = moving;
      if (!moving) want = AnimState.IDLE;
    } else {
      this.movingShown = false;
    }
    if (force || want !== this.shownState) {
      this.shownState = want;
      this.anim.play(want, force);
    }
  }

  /** Apply the latest authoritative state from the server. */
  setServerState(
    x: number,
    z: number,
    rotY: number,
    hp: number,
    maxHp: number,
    state: AnimState,
    sprinting = false,
  ) {
    this.hp = hp;
    this.maxHp = maxHp;
    this.sprinting = sprinting;
    const yaw = rotY * this.yawSign; // flip for mirrored (negative-scale) glTF roots

    // Respawn (players): keep the corpse at the death spot and start fading out;
    // the teleport + lightning + fade-in happen at the end of the fade.
    if (
      this.respawnFx &&
      this.state === AnimState.DEAD &&
      state !== AnimState.DEAD &&
      !this.respawn
    ) {
      this.respawn = {
        phase: "out",
        t: 0,
        realStart: performance.now(),
        nx: x,
        nz: z,
        nrot: yaw,
        nstate: state,
      };
      return;
    }
    if (this.respawn && this.respawn.phase === "out") return; // frozen while fading out

    // Enemy corpse respawn: the body faded out where it died; on respawn snap
    // straight to its new (home) spot and show it again — no slide across the map.
    if (this.corpseFx && this.state === AnimState.DEAD && state !== AnimState.DEAD) {
      this.teleport(x, z);
      this.facingY = yaw;
      this.setVisibility(1);
      this.corpseT = 0;
    }

    this.targetX = x;
    this.targetZ = z;
    this.targetRotY = yaw;

    if (state !== this.state) {
      this.state = state;
      this.stateTime = 0;
      if (!this.animationTestOverride) this.refreshAnim(); // suppresses a non-moving WALK into IDLE
      // per-model orientation fix for clips authored off the model's forward
      if (!this.animationTestOverride) this.yawFixTarget = this.spawned.yawFix?.[state] ?? 0;
      if (this.corpseFx && state === AnimState.DEAD) this.corpseT = 0; // start the corpse clock
      // the white HIT flash + the select flash are driven centrally in update()
    }
  }

  update(dt: number) {
    this.stateTime += dt;

    if (this.respawn) {
      this.updateRespawn(dt);
      if (this.respawn?.phase === "out") return; // hold the corpse frozen while it fades
    }

    // enemy corpse fade-out: hold on the death pose a moment, then dissolve away
    // (it stays hidden until the server respawns it, which snaps it back at home).
    if (this.corpseFx && this.state === AnimState.DEAD) {
      this.corpseT += dt;
      const k = Math.min(1, Math.max(0, (this.corpseT - CORPSE_HOLD) / CORPSE_FADE));
      this.setVisibility(1 - k);
    }

    const f = smooth(dt, 0.06);
    this.root.position.x = Scalar.Lerp(this.root.position.x, this.targetX, f);
    this.root.position.z = Scalar.Lerp(this.root.position.z, this.targetZ, f);

    // Ghost free-roam: gently bob up and down around the float height so the
    // paused local player visibly hovers rather than sitting at a fixed offset.
    if (this.ghost) {
      this.root.position.y =
        GHOST_FLOAT * getCameraZoom() + Math.sin(this.stateTime * GHOST_BOB_HZ * Math.PI * 2) * GHOST_BOB_AMPL;
    }

    // Measure real motion (smoothed units/sec) and re-pick the clip, so a body
    // that has stopped translating drops out of WALK into IDLE.
    const dx = this.root.position.x - this.lastX;
    const dz = this.root.position.z - this.lastZ;
    this.lastX = this.root.position.x;
    this.lastZ = this.root.position.z;
    const inst = dt > 1e-4 ? Math.hypot(dx, dz) / dt : this.moveSpeed;
    this.moveSpeed = Scalar.Lerp(this.moveSpeed, inst, smooth(dt, 0.08));
    if (!this.animationTestOverride) this.refreshAnim();

    // Sprinting speeds up the run cycle so the legs match the boosted movement
    // (only while the locomotion clip is actually showing).
    if (!this.animationTestOverride) {
      this.anim.setSpeedScale(
        this.sprinting && this.shownState === AnimState.WALK ? SPRINT_SPEED_MULT : 1,
      );
    }

    // Berserker buff: scale the model up 30%, run a green particle aura, and
    // shimmer the overlay green while the buff is active. The buff state is driven
    // by Game.ts writing entity.berserkerMs each server-state update.
    const wasBerserk = this.berserkerActive;
    this.berserkerActive = this.berserkerMs > 0;
    if (this.berserkerActive && !wasBerserk) {
      // buff just started — grow model and spawn the green aura
      this.applyVisualScale();
      const scene = this.root.getScene();
      if (scene) {
        this.berserkerParticles = makeBerserkerAura(scene, this.root.position);
      }
    } else if (!this.berserkerActive && wasBerserk) {
      // buff expired — restore original scale and stop the aura
      this.applyVisualScale();
      if (this.berserkerParticles) {
        this.berserkerParticles.stop();
        this.berserkerParticles.dispose();
        this.berserkerParticles = null;
      }
    }

    // Mesh overlay flash. While taking a HIT: EVERY character (the local player,
    // other players, and enemies alike) flashes intermittent DARK RED ("ow").
    // Berserker: vivid green shimmer (lower priority than HIT damage flash).
    // Otherwise a brief WHITE blink when freshly picked as an attack target.
    if (this.selectFlashT > 0) this.selectFlashT -= dt;
    const selElapsed = SELECT_FLASH_MS - this.selectFlashT;
    const selectBlink =
      this.selectFlashT > 0 && Math.floor(selElapsed / SELECT_BLINK_MS) % 2 === 0;
    let wantOn = false;
    let wantColor = HIT_FLASH;
    if (this.state === AnimState.HIT) {
      wantColor = DAMAGE_FLASH;
      wantOn = Math.floor(this.stateTime / DMG_BLINK_MS) % 2 === 0; // intermittent dark red
    } else if (this.berserkerActive) {
      wantColor = BERSERK_FLASH;
      wantOn = Math.sin(this.stateTime * 8) > 0; // ~4 Hz sine shimmer → green glow
    } else if (selectBlink) {
      wantOn = true;
    }
    if (wantOn !== this.overlayOn || wantColor !== this.overlayColor) {
      this.spawned.flashHit(wantOn, wantColor);
      this.overlayOn = wantOn;
      this.overlayColor = wantColor;
    }

    // facing interpolates toward the server's rotY; the clip yaw correction blends
    // in at ~the animation cross-fade rate so attack/throw don't snap-turn.
    this.facingY = lerpAngle(this.facingY, this.targetRotY, smooth(dt, 0.05));
    this.yawFix = Scalar.Lerp(this.yawFix, this.yawFixTarget, smooth(dt, 0.12));

    // Ghost flight: while drifting, face the direction of travel and pitch the
    // body forward like Superman flying. The moment the ghost stops (or leaves
    // ghost mode) it levels back out promptly and settles exactly upright.
    const flying = this.ghost && this.moveSpeed > GHOST_FLY_MIN_SPEED;
    let tiltTarget = 0;
    if (flying) {
      const heading = Math.atan2(dx, dz) * this.yawSign; // root forward is +Z
      this.facingY = lerpAngle(this.facingY, heading, smooth(dt, 0.08));
      tiltTarget = GHOST_FLY_TILT;
    }
    // Ease into the lean, but snap back upright faster when stopping.
    this.ghostTilt = Scalar.Lerp(this.ghostTilt, tiltTarget, smooth(dt, flying ? 0.12 : 0.05));
    if (!flying && this.ghostTilt < 0.01) this.ghostTilt = 0; // fully level when at rest
    this.root.rotation.x = this.ghostTilt;
    this.root.rotation.y = this.facingY + this.yawFix;

    if (!this.spawned.hasAnims) this.spawned.pose?.(this.state, this.stateTime);
  }

  private updateRespawn(dt: number) {
    const rs = this.respawn!;
    rs.t += dt;
    if (rs.phase === "out") {
      const k = Math.min(1, rs.t / FADE_OUT);
      this.setVisibility(1 - k);
      if (k >= 1 || performance.now() - rs.realStart > RESPAWN_OUT_MAX_MS) {
        // come back to life: teleport, strike, then fade in upright
        this.teleport(rs.nx, rs.nz);
        this.targetRotY = rs.nrot;
        this.facingY = rs.nrot;
        this.yawFixTarget = this.spawned.yawFix?.[rs.nstate] ?? 0;
        this.yawFix = this.yawFixTarget; // snap the correction on respawn
        this.root.rotation.y = this.facingY + this.yawFix;
        this.state = rs.nstate;
        this.stateTime = 0;
        this.anim.play(rs.nstate);
        this.shownState = rs.nstate; // keep refreshAnim() in sync after the teleport
        this.spawned.flashHit(false);
        this.overlayOn = false; // keep the centralized overlay state in sync
        this.selectFlashT = 0;
        this.onRespawn?.(rs.nx, rs.nz);
        this.setVisibility(0);
        rs.phase = "in";
        rs.t = 0;
      }
    } else {
      const k = Math.min(1, rs.t / FADE_IN);
      this.setVisibility(k);
      if (k >= 1) {
        this.setVisibility(1);
        this.respawn = null;
      }
    }
  }

  private setVisibility(v: number) {
    this.bodyAlpha = v;
    for (const m of this.spawned.meshes) m.visibility = v;
  }

  /** Current body opacity (0..1) — the HUD fades the nameplate/HP bar to match,
   *  so a dissolving corpse takes its floating bar with it. */
  get nameplateAlpha(): number {
    return this.bodyAlpha;
  }

  dispose() {
    if (this.berserkerParticles) {
      this.berserkerParticles.stop();
      this.berserkerParticles.dispose();
      this.berserkerParticles = null;
    }
    this.anim.dispose();
    this.spawned.dispose();
  }
}

function stateLabel(state: AnimState): string {
  return state[0] + state.slice(1).toLowerCase();
}
