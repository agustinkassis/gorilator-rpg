import { TransformNode, Scalar, AbstractMesh, Color3 } from "@babylonjs/core";
import { AnimState, SPRINT_SPEED_MULT } from "@rpg/shared";
import { AnimationController } from "./AnimationController";
import { SpawnedCharacter, HIT_FLASH, DAMAGE_FLASH } from "./types";
import { lerpAngle, smooth } from "../util/math";

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
const GHOST_FLOAT = 0.5; // units a paused "ghost" player floats off the floor (~1ft+)
const GHOST_VISIBILITY = 0.7; // translucency of a ghosting player

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

  constructor(id: string, spawned: SpawnedCharacter, isLocal: boolean) {
    this.id = id;
    this.isLocal = isLocal;
    this.spawned = spawned;
    this.yawSign = spawned.yawSign ?? 1;
    this.root = spawned.root;
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

  /** Dev Mode ghost: go translucent + float off the ground (the local player while
   *  the game is paused). Idempotent; restoring drops it back to opaque on the floor. */
  setGhost(on: boolean) {
    if (on === this.ghost) return;
    this.ghost = on;
    this.setVisibility(on ? GHOST_VISIBILITY : 1);
    this.root.position.y = on ? GHOST_FLOAT : 0;
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
  private refreshAnim() {
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
    if (want !== this.shownState) {
      this.shownState = want;
      this.anim.play(want);
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
      this.refreshAnim(); // suppresses a non-moving WALK into IDLE
      // per-model orientation fix for clips authored off the model's forward
      this.yawFixTarget = this.spawned.yawFix?.[state] ?? 0;
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

    // Measure real motion (smoothed units/sec) and re-pick the clip, so a body
    // that has stopped translating drops out of WALK into IDLE.
    const dx = this.root.position.x - this.lastX;
    const dz = this.root.position.z - this.lastZ;
    this.lastX = this.root.position.x;
    this.lastZ = this.root.position.z;
    const inst = dt > 1e-4 ? Math.hypot(dx, dz) / dt : this.moveSpeed;
    this.moveSpeed = Scalar.Lerp(this.moveSpeed, inst, smooth(dt, 0.08));
    this.refreshAnim();

    // Sprinting speeds up the run cycle so the legs match the boosted movement
    // (only while the locomotion clip is actually showing).
    this.anim.setSpeedScale(
      this.sprinting && this.shownState === AnimState.WALK ? SPRINT_SPEED_MULT : 1,
    );

    // Mesh overlay flash. While taking a HIT: EVERY character (the local player,
    // other players, and enemies alike) flashes intermittent DARK RED ("ow").
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
    this.anim.dispose();
    this.spawned.dispose();
  }
}
