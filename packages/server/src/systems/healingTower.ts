import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { TOWER_PROP_NAME } from "@rpg/shared";

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
