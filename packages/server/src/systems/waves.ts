import { readFileSync, existsSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import type { BrainId } from "@rpg/shared";

/**
 * Dev-authored custom waves. Each wave NUMBER can be overridden with a specific
 * composition (a list of entries → kind/character + count + brain + level).
 * Authored in Dev Mode → written to public/waves.json (via the Vite endpoint),
 * watched live here. Wave numbers WITHOUT an override fall back to the default
 * auto-scaling goblin horde (see goblins.ts scheduleWave).
 */
export interface WaveEntry {
  kind: string; // "goblin" | "dummy" | a character defId (spawned as an npc)
  defId?: string; // model/character def id when kind is a custom character
  count: number;
  brain?: BrainId; // default "attacks_home"
  level?: number;
}
export interface WaveDef {
  number: number;
  entries: WaveEntry[];
}

const PUBLIC_DIRS = [
  resolve(process.cwd(), "packages/client/public"),
  resolve(process.cwd(), "../client/public"),
  resolve(process.cwd(), "client/public"),
];
function wavesFile(): string | null {
  const dir = PUBLIC_DIRS.find((d) => existsSync(d));
  return dir ? resolve(dir, "waves.json") : null;
}

// Wave compositions can come from multiple sources: the dev-authored
// public/waves.json (source "authored", highest priority) plus any plugin
// content packs (addWaveSource). Sources merge per wave NUMBER — "authored"
// wins, then plugin sources in registration order.
const SOURCE_AUTHORED = "authored";
const sources = new Map<string, Map<number, WaveEntry[]>>();
const sourceOrder: string[] = [SOURCE_AUTHORED];

function normalizeEntry(raw: Record<string, unknown>): WaveEntry | null {
  const kind = String(raw.kind || "goblin").trim();
  if (!kind) return null;
  const count = Math.max(1, Math.min(200, Math.round(Number(raw.count) || 1)));
  // Builtin brain ids plus any plugin-registered brain are valid; unknown ids
  // fall back to attacks_home (the host validates registration at load time).
  const brain = String(raw.brain || "attacks_home") as BrainId;
  const defId = raw.defId ? String(raw.defId) : undefined;
  const level = raw.level != null ? Math.max(1, Math.round(Number(raw.level) || 1)) : undefined;
  return { kind, defId, count, brain, level };
}

function parseWaves(path: string): Map<number, WaveEntry[]> {
  const next = new Map<number, WaveEntry[]>();
  if (!existsSync(path)) return next;
  const arr = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(arr)) {
    for (const w of arr) {
      const number = Math.round(Number(w?.number) || 0);
      if (number <= 0 || !Array.isArray(w?.entries)) continue;
      const entries = w.entries
        .map((e: Record<string, unknown>) => normalizeEntry(e))
        .filter((e: WaveEntry | null): e is WaveEntry => Boolean(e));
      if (entries.length) next.set(number, entries);
    }
  }
  return next;
}

function applyFrom(path: string, source: string): void {
  try {
    const next = parseWaves(path);
    sources.set(source, next);
    console.log(`[waves] ${next.size} custom wave(s) loaded (${source})`);
  } catch (e) {
    console.warn(`[waves] failed to read ${path} (${source})`, e);
  }
}

/** Load waves.json and keep watching it (created/edited live by the dev editor). */
export function loadWaves(): void {
  const path = wavesFile();
  if (!path) return;
  applyFrom(path, SOURCE_AUTHORED);
  watchFile(path, { interval: 1500 }, () => applyFrom(path, SOURCE_AUTHORED));
}

/** Register an additional live-reloading waves.json (plugin content packs). */
export function addWaveSource(path: string, source: string): void {
  if (!sourceOrder.includes(source)) sourceOrder.push(source);
  applyFrom(path, source);
  watchFile(path, { interval: 1500 }, () => applyFrom(path, source));
}

/** The custom composition for a wave number, or null to use the default horde.
 *  Dev-authored waves win over plugin waves for the same number. */
export function customWave(number: number): WaveEntry[] | null {
  for (const source of sourceOrder) {
    const entries = sources.get(source)?.get(number);
    if (entries) return entries;
  }
  return null;
}
