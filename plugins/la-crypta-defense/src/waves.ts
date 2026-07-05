import {
  AnimState,
  type EventModuleContext,
  type EventWaveEntry,
  type GameState,
  GOBLIN_SPAWN_RANGE,
  type House,
  WAVE_SPAWN_ARC,
  WAVE_SPAWN_DISTANCE,
  playerLevelStats,
  waveDifficulty,
} from "@rpg/shared";

/**
 * The tower-defense wave scheduler — moved verbatim from
 * packages/server/src/systems/goblins.ts in the #73 extraction (only the
 * inputs changed: tuning/RNG/spawning flow through the EventModuleContext).
 * waves.characterization.test.ts pins pacing, sizes, levels and spread
 * across the move.
 */

interface ScheduledUnit {
  delayMs: number;
  x: number;
  z: number;
  level: number;
  kind?: string; // custom-wave override (defaults to a plain goblin)
  defId?: string; // character def id when kind is a custom character
  brain?: string;
}

interface WaveClock {
  timer: number; // ms until the next wave
  number: number; // waves spawned so far
  pending: ScheduledUnit[]; // units queued for the current wave
  firstDelayMs: number; // the grace this clock was armed with (live-retunable at wave 0)
}

const clocks = new WeakMap<GameState, WaveClock>();

const clampRange = (v: number) => Math.max(-GOBLIN_SPAWN_RANGE, Math.min(GOBLIN_SPAWN_RANGE, v));

/** The home the goblins besiege: the first (oldest) standing house. */
function homeOf(state: GameState): House | null {
  let home: House | null = null;
  state.houses.forEach((h) => {
    if (!home && h.alive) home = h;
  });
  return home;
}

/** The event's own difficulty multiplier (realm.json events.config). */
function difficultyMult(ctx: EventModuleContext): number {
  const mult = Number(ctx.config.difficultyMult ?? 1);
  return Number.isFinite(mult) && mult > 0 ? mult : 1;
}

function clockFor(ctx: EventModuleContext): WaveClock {
  let clock = clocks.get(ctx.state);
  if (!clock) {
    const firstDelayMs = ctx.tuning("waveFirstDelayMs");
    clock = { timer: firstDelayMs, number: 0, pending: [], firstDelayMs };
    clocks.set(ctx.state, clock);
  }
  return clock;
}

/** Spawn one scheduled unit (via the host's world mutators), pointed at the home. */
function spawnUnit(ctx: EventModuleContext, unit: ScheduledUnit, waveNumber: number): void {
  const e = ctx.world.spawnEnemy({
    kind: unit.kind || "goblin",
    x: unit.x,
    z: unit.z,
    level: unit.level,
    brain: unit.brain,
    modelId: unit.defId,
    waveNumber,
  });
  const home = homeOf(ctx.state);
  e.targetX = home ? home.x : 0;
  e.targetZ = home ? home.z : 0;
}

/** Build a custom (dev-authored / content-pack) wave: each entry → `count` units
 *  of a kind, with an optional brain and level, fanned across the spawn arc. */
function scheduleCustomWave(
  ctx: EventModuleContext,
  waveNumber: number,
  entries: EventWaveEntry[],
): ScheduledUnit[] {
  const home = homeOf(ctx.state);
  const hx = home ? home.x : 0;
  const hz = home ? home.z : 0;
  const units: Array<{ kind: string; defId?: string; brain?: string; level?: number }> = [];
  for (const e of entries) for (let i = 0; i < e.count; i++) units.push(e);
  const total = units.length;
  if (total <= 0) return [];
  const roll = ctx.rng("spawns");
  const baseAng = roll() * Math.PI * 2;
  const { levelLo: lo, levelHi: hi } = waveDifficulty(
    ctx.state,
    waveNumber,
    ctx.tuning,
    difficultyMult(ctx),
  );
  const spread = ctx.tuning("waveSpawnSpreadMs");
  const delays =
    total === 1
      ? [0]
      : [0, spread, ...Array.from({ length: total - 2 }, () => roll() * spread)].sort((a, b) => a - b);
  const out: ScheduledUnit[] = [];
  for (let i = 0; i < total; i++) {
    const u = units[i];
    const ang = baseAng + (roll() - 0.5) * WAVE_SPAWN_ARC * 1.25;
    const r = WAVE_SPAWN_DISTANCE * (0.78 + roll() * 0.44);
    out.push({
      delayMs: delays[i],
      x: clampRange(hx + Math.cos(ang) * r),
      z: clampRange(hz + Math.sin(ang) * r),
      level: u.level ?? lo + Math.floor(roll() * (hi - lo + 1)),
      kind: u.kind,
      defId: u.defId,
      brain: u.brain,
    });
  }
  return out;
}

/** Build one wave: a horde a long march out from the home, fanned across an arc,
 *  scheduled over the spread window instead of dumped all at once. */
function scheduleWave(ctx: EventModuleContext, waveNumber: number): ScheduledUnit[] {
  const custom = ctx.customWave(waveNumber);
  if (custom) return scheduleCustomWave(ctx, waveNumber, custom); // authored/content override
  const home = homeOf(ctx.state);
  const hx = home ? home.x : 0;
  const hz = home ? home.z : 0;
  // Size + level range come from the shared difficulty module (#64): live-player
  // driven, scaled by the difficulty* knobs + this event's multiplier.
  const { size, levelLo: lo, levelHi: hi } = waveDifficulty(
    ctx.state,
    waveNumber,
    ctx.tuning,
    difficultyMult(ctx),
  );
  if (size <= 0) return [];
  const roll = ctx.rng("spawns");
  const baseAng = roll() * Math.PI * 2; // the horde approaches from ~one side
  const spread = ctx.tuning("waveSpawnSpreadMs");
  const delays =
    size === 1
      ? [0]
      : [0, spread, ...Array.from({ length: size - 2 }, () => roll() * spread)].sort((a, b) => a - b);
  const wave: ScheduledUnit[] = [];
  for (let i = 0; i < size; i++) {
    const ang = baseAng + (roll() - 0.5) * WAVE_SPAWN_ARC * 1.25;
    const r = WAVE_SPAWN_DISTANCE * (0.78 + roll() * 0.44);
    const level = lo + Math.floor(roll() * (hi - lo + 1));
    wave.push({
      delayMs: delays[i],
      x: clampRange(hx + Math.cos(ang) * r),
      z: clampRange(hz + Math.sin(ang) * r),
      level,
    });
  }
  return wave;
}

function liveWaveGoblins(state: GameState, waveNumber: number): number {
  let live = 0;
  state.enemies.forEach((e) => {
    if (e.kind === "goblin" && e.waveNumber === waveNumber && e.state !== AnimState.DEAD) live++;
  });
  return live;
}

function syncWaveState(ctx: EventModuleContext, clock: WaveClock) {
  const state = ctx.state;
  state.waveNumber = clock.number;
  state.waveTimerMs = Math.max(0, clock.timer);
  const active =
    clock.number > 0 && (clock.pending.length > 0 || liveWaveGoblins(state, clock.number) > 0);
  // Lifecycle events on the activity edge — the one chokepoint every wave path
  // (waveTick, forceNextWave) flows through. Same payloads as pre-extraction.
  if (active && !state.waveActive) ctx.emit("wave:start", { wave: clock.number });
  else if (!active && state.waveActive) ctx.emit("wave:end", { wave: clock.number });
  state.waveActive = active;
}

/** The rest after wave N — grows so there's more time to rebuild as the siege
 *  escalates, capped at waveIntervalMaxMs. */
function intervalAfterWave(ctx: EventModuleContext, n: number): number {
  return Math.min(
    ctx.tuning("waveIntervalMaxMs"),
    ctx.tuning("waveIntervalBaseMs") + ctx.tuning("waveIntervalStepMs") * Math.max(0, n - 1),
  );
}

/**
 * The wave spawner tick. The first wave comes after a short grace; each
 * successive rest grows (intervalAfterWave). The clock FREEZES while nobody is
 * alive to defend — a wipe or a solo death never shortcuts the long timer —
 * and a wave is skipped while the live-goblin count is already at the cap.
 */
export function waveTick(ctx: EventModuleContext, dt: number) {
  const state = ctx.state;
  const clock = clockFor(ctx);

  // Retuning the first-wave grace while still at wave 0 re-arms the clock
  // (replaces the old GameRoom dev_tune special case — applies next tick).
  const firstDelay = ctx.tuning("waveFirstDelayMs");
  if (clock.number === 0 && clock.pending.length === 0 && clock.firstDelayMs !== firstDelay) {
    clock.firstDelayMs = firstDelay;
    clock.timer = firstDelay;
  }

  const { alive } = playerLevelStats(state);
  if (alive === 0 || !state.wavesEnabled) {
    // nobody defending, or an admin stopped the waves — hold the countdown in
    // place (don't reset it to a grace); queued spawns stay queued too.
    syncWaveState(ctx, clock);
    return;
  }

  const dtMs = dt * 1000;
  if (clock.pending.length > 0) {
    clock.pending.forEach((g) => {
      g.delayMs -= dtMs;
    });
    const ready = clock.pending.filter((g) => g.delayMs <= 0);
    clock.pending = clock.pending.filter((g) => g.delayMs > 0);
    ready.forEach((g) => spawnUnit(ctx, g, clock.number));
  }

  clock.timer -= dtMs;
  if (clock.timer <= 0) {
    let living = 0;
    state.enemies.forEach((e) => {
      if (e.kind === "goblin" && e.state !== AnimState.DEAD) living++;
    });
    if (living < ctx.tuning("goblinLiveCap") && clock.pending.length === 0) {
      clock.number += 1;
      clock.pending = scheduleWave(ctx, clock.number);
    }
    clock.timer = intervalAfterWave(ctx, clock.number); // growing rest before the next wave
  }
  syncWaveState(ctx, clock);
}

/** Restart the wave clock for a fresh round (event start / realm restart). */
export function resetClock(ctx: EventModuleContext) {
  const firstDelay = ctx.tuning("waveFirstDelayMs");
  const clock = clockFor(ctx);
  clock.timer = firstDelay;
  clock.number = 0;
  clock.pending = [];
  clock.firstDelayMs = firstDelay;
  ctx.state.waveNumber = 0;
  ctx.state.waveTimerMs = firstDelay;
  ctx.state.waveActive = false;
}

export function forceNextWave(ctx: EventModuleContext) {
  const clock = clockFor(ctx);
  clock.number += 1;
  clock.pending = scheduleWave(ctx, clock.number);
  const ready = clock.pending.filter((g) => g.delayMs <= 0);
  clock.pending = clock.pending.filter((g) => g.delayMs > 0);
  ready.forEach((g) => spawnUnit(ctx, g, clock.number));
  clock.timer = intervalAfterWave(ctx, clock.number);
  syncWaveState(ctx, clock);
}

/** Dev-only: rewind the wave counter by one (drops any queued spawns and resets
 *  the rest timer for the new, lower wave number). No-op at wave 0. */
export function previousWave(ctx: EventModuleContext) {
  const clock = clocks.get(ctx.state);
  if (!clock || clock.number <= 0) return;
  clock.number -= 1;
  clock.pending = [];
  clock.timer = intervalAfterWave(ctx, clock.number);
  syncWaveState(ctx, clock);
}
