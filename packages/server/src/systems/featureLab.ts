import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AnimState,
  Enemy,
  type DevTuningKey,
  type FeatureLabEnemySpawnConfig,
  type FeatureLabPointConfig,
  type FeatureLabScenarioConfig,
  type GameState,
  type Player,
} from "@rpg/shared";
import { configureEnemy } from "./enemyConfig";
import { setDevTuning } from "./devTuning";
import { applyLevelStats } from "./leveling";
import { placeAtFreeSpot } from "./movement";
import { nearestFreeWorld } from "./pathfinding";
import { setRealmPolicy } from "./policy";

export type FeatureLabScenario = FeatureLabScenarioConfig & { name: string };

let currentScenario: FeatureLabScenario | null = null;
const clearedWorlds = new WeakSet<GameState>();

export function featureLabScenarioName(): string {
  const raw = process.env.GORILATOR_SCENARIO?.trim() ?? "";
  if (!raw) return "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(raw)) {
    console.warn(`[scenario] invalid GORILATOR_SCENARIO "${raw}" — ignored`);
    return "";
  }
  return raw;
}

function scenarioFile(name: string): string | null {
  const candidates = [
    resolve(process.cwd(), "scenarios", `${name}.json`),
    resolve(process.cwd(), "../../scenarios", `${name}.json`),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

export function featureLabScenario(): FeatureLabScenario | null {
  return currentScenario;
}

export function applyFeatureLabScenario(state: GameState): FeatureLabScenario | null {
  currentScenario = null;
  const name = featureLabScenarioName();
  if (!name) return null;

  const file = scenarioFile(name);
  if (!file) {
    console.warn(`[scenario] "${name}" not found in scenarios/`);
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as FeatureLabScenarioConfig;
    const scenario = {
      ...parsed,
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : name,
    };

    if (scenario.policy) {
      const applied = setRealmPolicy(scenario.policy);
      console.log(
        `[scenario] policy: death=${applied.death.mode} (xpPenalty=${applied.death.xpPenalty}) ` +
          `persistAcrossWipes=${applied.progression.persistAcrossWipes} ` +
          `keepInventoryOnWipe=${applied.progression.keepInventoryOnWipe}`,
      );
    }

    if (scenario.tuning && typeof scenario.tuning === "object") {
      for (const [key, value] of Object.entries(scenario.tuning)) {
        const applied = setDevTuning(key as DevTuningKey, Number(value));
        if (applied === null) console.warn(`[scenario] unknown tuning key "${key}" — ignored`);
        else console.log(`[scenario] tuning ${key} = ${applied}`);
      }
    }

    if (scenario.timeScale !== undefined) {
      const n = Number(scenario.timeScale);
      if (Number.isFinite(n)) state.timeScale = Math.max(0, Math.min(8, n));
      else console.warn(`[scenario] invalid timeScale — ignored`);
    }

    if (scenario.systems?.waves === false) {
      state.wavesEnabled = false;
      console.log(`[scenario] waves disabled`);
    }

    currentScenario = scenario;
    console.log(`[scenario] "${scenario.name}" loaded (${file})`);
    return scenario;
  } catch (err) {
    console.warn(`[scenario] failed to read "${name}"`, err);
    return null;
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function applyPoint(p: Player, point: FeatureLabPointConfig) {
  placeAtFreeSpot(p, point.x, point.z);
  if (finiteNumber(point.rotY)) p.rotY = point.rotY;
}

function spawnPointFor(player: Player, spawn: FeatureLabEnemySpawnConfig, index: number, count: number) {
  const spread = Math.max(0, Number(spawn.spread ?? 0) || 0);
  const base = spawn.position
    ? { x: spawn.position.x, z: spawn.position.z }
    : spawn.offsetFromPlayer
      ? { x: player.x + spawn.offsetFromPlayer.x, z: player.z + spawn.offsetFromPlayer.z }
      : { x: player.x + 4, z: player.z + 4 };
  if (count <= 1 || spread <= 0) return nearestFreeWorld(base.x, base.z);
  const angle = (Math.PI * 2 * index) / count;
  return nearestFreeWorld(base.x + Math.cos(angle) * spread, base.z + Math.sin(angle) * spread);
}

function spawnScenarioEnemies(state: GameState, player: Player, enemies: FeatureLabEnemySpawnConfig[]) {
  enemies.forEach((spawn, groupIndex) => {
    const count = Math.max(1, Math.round(Number(spawn.count ?? 1) || 1));
    const kind = spawn.kind || "goblin";
    const idPrefix = spawn.idPrefix || `${currentScenario?.name ?? "scenario"}-${kind}`;
    for (let i = 0; i < count; i++) {
      const spot = spawnPointFor(player, spawn, i, count);
      const e = new Enemy();
      configureEnemy(e, {
        kind,
        id: `${idPrefix}-${groupIndex}-${i}`,
        x: spot.x,
        z: spot.z,
        brain: spawn.brain ?? (kind === "goblin" ? "war_seeker" : undefined),
        stats: {
          ...(spawn.stats ?? {}),
          ...(finiteNumber(spawn.level) ? { level: spawn.level } : {}),
        },
      });
      if (spawn.aggro !== false) {
        e.aggro = true;
        e.aiTargetId = player.id;
        e.targetX = player.x;
        e.targetZ = player.z;
        e.state = AnimState.WALK;
      }
      state.enemies.set(e.id, e);
    }
  });
}

export function applyFeatureLabPlayerScenario(state: GameState, player: Player): void {
  const scenario = currentScenario;
  if (!scenario) return;

  const playerConfig = scenario.player;
  if (playerConfig) {
    if (playerConfig.position) applyPoint(player, playerConfig.position);
    if (finiteNumber(playerConfig.level) || finiteNumber(playerConfig.xp)) {
      player.level = Math.max(1, Math.round(Number(playerConfig.level ?? player.level) || player.level));
      player.xp = Math.max(0, Math.floor(Number(playerConfig.xp ?? player.xp) || 0));
      applyLevelStats(player);
      player.hp = player.maxHp;
    }
    if (finiteNumber(playerConfig.maxHp)) {
      player.maxHp = Math.max(1, playerConfig.maxHp);
      player.hp = Math.min(player.hp, player.maxHp);
    }
    if (finiteNumber(playerConfig.hp)) {
      player.hp = Math.max(1, Math.min(player.maxHp, playerConfig.hp));
    }
    player.state = AnimState.IDLE;
    player.attackTargetId = "";
    player.pendingHitId = "";
    player.pickupTargetId = "";
    console.log(`[scenario] player seeded: level=${player.level} xp=${player.xp} hp=${Math.round(player.hp)}/${Math.round(player.maxHp)}`);
  }

  if (scenario.world?.clearEnemies && !clearedWorlds.has(state)) {
    state.enemies.clear();
    clearedWorlds.add(state);
  }
  if (scenario.world?.enemies?.length) {
    spawnScenarioEnemies(state, player, scenario.world.enemies);
    console.log(`[scenario] spawned ${scenario.world.enemies.length} enemy group(s) near ${player.name || player.id}`);
  }
}
