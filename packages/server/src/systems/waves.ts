import { readFileSync, existsSync, watchFile } from "fs";
import { resolve } from "path";
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

const BRAINS: BrainId[] = ["idle", "passive_patrol", "war_seeker", "attacks_home"];
let waves = new Map<number, WaveEntry[]>();

function normalizeEntry(raw: Record<string, unknown>): WaveEntry | null {
  const kind = String(raw.kind || "goblin").trim();
  if (!kind) return null;
  const count = Math.max(1, Math.min(200, Math.round(Number(raw.count) || 1)));
  const brainRaw = String(raw.brain || "attacks_home") as BrainId;
  const brain = BRAINS.includes(brainRaw) ? brainRaw : "attacks_home";
  const defId = raw.defId ? String(raw.defId) : undefined;
  const level = raw.level != null ? Math.max(1, Math.round(Number(raw.level) || 1)) : undefined;
  return { kind, defId, count, brain, level };
}

function applyFrom(path: string): void {
  try {
    if (!existsSync(path)) {
      waves = new Map();
      return;
    }
    const arr = JSON.parse(readFileSync(path, "utf8"));
    const next = new Map<number, WaveEntry[]>();
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
    waves = next;
    console.log(`[waves] ${waves.size} custom wave(s) loaded`);
  } catch (e) {
    console.warn("[waves] failed to read waves.json", e);
  }
}

/** Load waves.json and keep watching it (created/edited live by the dev editor). */
export function loadWaves(): void {
  const path = wavesFile();
  if (!path) return;
  applyFrom(path);
  watchFile(path, { interval: 1500 }, () => applyFrom(path));
}

/** The custom composition for a wave number, or null to use the default horde. */
export function customWave(number: number): WaveEntry[] | null {
  return waves.get(number) ?? null;
}
