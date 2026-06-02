import { readFileSync, existsSync, watchFile } from "fs";
import { resolve } from "path";
import { TREE_HP, ROCK_HP } from "@rpg/shared";

/**
 * Per-resource-kind drop config, authored in Dev Mode → public/resources.json,
 * watched here live. `trigger` "kill" drops `amount` of `item` when the resource is
 * felled; "hit" sheds `item` progressively over the resource's `hp` (one item every
 * hp/amount damage) up to `amount` total. `hp` is the resource's total health — it
 * drives both how long it survives and the progressive drop rate. resources.ts reads
 * this to spawn drops and to (re)apply `hp` to every resource of the kind.
 */
export interface DropCfg {
  item: string; // "log" | "stone" | "banana" | "potion" (+ future custom)
  amount: number;
  trigger: "hit" | "kill";
  hp: number; // total health; progressive drop rate = hp / amount damage per item
}

const PUBLIC_DIRS = [
  resolve(process.cwd(), "packages/client/public"),
  resolve(process.cwd(), "../client/public"),
  resolve(process.cwd(), "client/public"),
];
function file(): string | null {
  const d = PUBLIC_DIRS.find((p) => existsSync(p));
  return d ? resolve(d, "resources.json") : null;
}

const DEFAULTS: Record<string, DropCfg> = {
  tree: { item: "log", amount: 1, trigger: "kill", hp: TREE_HP },
  rock: { item: "stone", amount: 28, trigger: "hit", hp: ROCK_HP },
};
const FALLBACK: DropCfg = { item: "stone", amount: 1, trigger: "kill", hp: 60 };

let cfg: Record<string, Partial<DropCfg>> = {};
let onChange: (() => void) | null = null;

function applyFrom(path: string): void {
  try {
    cfg = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) || {} : {};
  } catch (e) {
    console.warn("[resourceDrops] failed to read resources.json", e);
  }
}

/** Load resources.json and keep watching it (edited live by the Dev Mode editor).
 *  `cb` fires once now and on every change so the caller can re-apply hp/config to
 *  every existing resource of each kind. */
export function loadResourceDrops(cb?: () => void): void {
  onChange = cb ?? null;
  const path = file();
  if (!path) {
    onChange?.(); // still apply built-in defaults to the world
    return;
  }
  applyFrom(path);
  onChange?.();
  watchFile(path, { interval: 1500 }, () => {
    applyFrom(path);
    onChange?.();
  });
}

/** The drop config for a resource kind — the authored value merged over the built-in
 *  default, so an older file missing `hp`/`trigger` still resolves to sane values. */
export function dropConfig(kind: string): DropCfg {
  const base = DEFAULTS[kind] ?? FALLBACK;
  const stored = cfg[kind];
  return stored ? { ...base, ...stored } : base;
}
