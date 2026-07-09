import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type GameState,
  type HealEvent,
  AnimState,
  SACRED_CIRCLE_HEAL_PER_SEC_MAX,
  SACRED_CIRCLE_HEAL_PER_SEC_MIN,
  SACRED_CIRCLE_RADIUS,
  TOWER_PROP_NAME,
} from "@rpg/shared";
import { rng } from "./rng";

const PROPS_CANDIDATES = [
  resolve(process.cwd(), "packages/client/public/props.json"),
  resolve(process.cwd(), "../client/public/props.json"),
  resolve(process.cwd(), "client/public/props.json"),
];

interface PropDef {
  name?: string;
  x?: number;
  z?: number;
}

/**
 * Sacred Circle: living, hurt players inside the tower's radius trickle-heal at a
 * random per-second rate. Fractional healing accumulates in `carry` and pops as
 * whole-HP heal events. `dt` is the timeScale-scaled tick delta (seconds) — a
 * paused world (dt 0) heals nothing.
 */
export function sacredCircleHealSystem(
  state: GameState,
  dt: number,
  tower: { x: number; z: number } | null,
  carry: Map<string, number>,
  emitHeal: (ev: HealEvent) => void,
): void {
  if (dt <= 0 || !tower) return;
  const radiusSq = SACRED_CIRCLE_RADIUS * SACRED_CIRCLE_RADIUS;
  state.players.forEach((p, sid) => {
    if (p.hp <= 0 || p.state === AnimState.DEAD || p.hp >= p.maxHp) return;
    const dx = p.x - tower.x;
    const dz = p.z - tower.z;
    if (dx * dx + dz * dz > radiusSq) return;

    const healPerSec =
      SACRED_CIRCLE_HEAL_PER_SEC_MIN +
      rng(state, "misc")() * (SACRED_CIRCLE_HEAL_PER_SEC_MAX - SACRED_CIRCLE_HEAL_PER_SEC_MIN);
    const healed = Math.min(p.maxHp - p.hp, healPerSec * dt);
    if (healed <= 0) return;
    p.hp += healed;

    const carried = (carry.get(sid) ?? 0) + healed;
    if (carried >= 1 || p.hp >= p.maxHp) {
      const amount = Math.max(1, Math.floor(carried));
      emitHeal({ targetId: sid, amount });
      carry.set(sid, carried - amount);
    } else {
      carry.set(sid, carried);
    }
  });
}

export function healingTowerPosition(): { x: number; z: number } | null {
  const path = PROPS_CANDIDATES.find((p) => existsSync(p));
  if (!path) return null;
  try {
    const props = JSON.parse(readFileSync(path, "utf8")) as PropDef[];
    const tower = props.find((p) => p.name === TOWER_PROP_NAME);
    if (typeof tower?.x !== "number" || !Number.isFinite(tower.x)) return null;
    if (typeof tower.z !== "number" || !Number.isFinite(tower.z)) return null;
    return { x: tower.x, z: tower.z };
  } catch {
    return null;
  }
}
