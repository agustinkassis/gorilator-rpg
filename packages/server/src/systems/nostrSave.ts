import "./webcrypto";
import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent } from "nostr-tools/pure";
import {
  NOSTR_SAVE_KIND,
  playerRealmDTag,
  saveDTag,
  type PlayerSave,
  type PlayerSaveRealm,
  type Player,
  type InventorySlot,
} from "@rpg/shared";
import { getServerIdentity } from "./nostrIdentity";
import { sanitizeSaveContent, type NostrEvent } from "./nostr";

// Node (≤20) has no global WebSocket, which SimplePool needs — inject `ws`.
useWebSocketImplementation(WebSocket);

/** Public relays the server reads/writes player saves to (mirrors the client). */
const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
];

// One long-lived pool for the server's lifetime — connections are reused across
// publishes/fetches (saves are infrequent: level-up / death / logout).
let pool: SimplePool | null = null;
function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

export interface SaveContext {
  realm?: PlayerSaveRealm | null;
  reason?: string;
}

/** Snapshot a synced player + its inventory into a save payload. */
export function buildServerSave(
  p: Player,
  inventory: InventorySlot[],
  context: SaveContext = {},
): PlayerSave {
  return {
    v: 2,
    playerPubkey: p.pubkey || undefined,
    realm: context.realm ?? undefined,
    reason: context.reason,
    level: p.level,
    xp: p.xp,
    hp: p.hp,
    maxHp: p.maxHp,
    stamina: p.stamina,
    maxStamina: p.maxStamina,
    hunger: p.hunger,
    maxHunger: p.maxHunger,
    x: p.x,
    z: p.z,
    rotY: p.rotY,
    attack: p.attack,
    armor: p.armor,
    critChance: p.critChance,
    moveSpeed: p.moveSpeed,
    throwPower: p.throwPower,
    hue: p.hue,
    inventory: inventory.map((s) => ({ type: s.type, count: s.count })),
    ts: Date.now(),
  };
}

/**
 * Sign (with the server key) and publish a player's save as kind-30078
 * replaceable events:
 *
 * - `saveDTag(playerPubkey)` keeps the latest state for login recovery.
 * - `playerRealmDTag(playerPubkey, realm.id)` keeps the latest state for that
 *   player in that realm, so outside apps can track/freeze realm history.
 *
 * Best-effort across the relays, with a hard timeout so a hung relay never
 * stalls the caller.
 */
export async function publishServerSave(playerPubkey: string, save: PlayerSave): Promise<void> {
  const { sk } = getServerIdentity();
  const created_at = Math.floor(Date.now() / 1000);
  const content = JSON.stringify(save);
  const baseTags = [
    ["p", playerPubkey], // who this save belongs to (queryable)
    ...(save.realm ? [["realm", save.realm.id]] : []),
    ...(save.reason ? [["reason", save.reason]] : []),
  ];
  const events = [
    finalizeEvent(
      {
        kind: NOSTR_SAVE_KIND,
        created_at,
        tags: [["d", saveDTag(playerPubkey)], ...baseTags],
        content,
      },
      sk,
    ),
  ];
  if (save.realm?.id) {
    events.push(
      finalizeEvent(
        {
          kind: NOSTR_SAVE_KIND,
          created_at,
          tags: [["d", playerRealmDTag(playerPubkey, save.realm.id)], ...baseTags],
          content,
        },
        sk,
      ),
    );
  }
  await raceTimeout(Promise.allSettled(events.flatMap((event) => getPool().publish(RELAYS, event))), 4000);
}

/**
 * Fetch a player's latest server-signed save from the relays and sanitize it
 * into a PlayerSave (or null if none / unreachable / malformed). Authoritative:
 * the event is signed by the server's own key, so it's trusted — sanitize is
 * only NaN/range hygiene.
 */
export async function fetchServerSave(
  playerPubkey: string,
  timeoutMs = 2500,
): Promise<PlayerSave | null> {
  const { pubkey } = getServerIdentity();
  try {
    const ev = (await raceTimeout(
      getPool().get(RELAYS, {
        kinds: [NOSTR_SAVE_KIND],
        authors: [pubkey],
        "#d": [saveDTag(playerPubkey)],
      }),
      timeoutMs,
    )) as NostrEvent | null;
    return ev ? sanitizeSaveContent(ev.content) : null;
  } catch {
    return null;
  }
}

/**
 * Per-player serial writer: never runs two publishes for the same player at
 * once; saves requested while one is in flight queue behind it. Keeps level-up +
 * death + logout publishes ordered for the same replaceable event addresses.
 */
export class ServerSaver {
  private saving = new Set<string>();
  private queued = new Map<string, { save: PlayerSave; reason: string }[]>();

  save(playerPubkey: string, save: PlayerSave, reason: string): void {
    if (!playerPubkey) return;
    if (this.saving.has(playerPubkey)) {
      const q = this.queued.get(playerPubkey) ?? [];
      q.push({ save, reason });
      this.queued.set(playerPubkey, q);
      return;
    }
    void this.flush(playerPubkey, save, reason);
  }

  private async flush(playerPubkey: string, save: PlayerSave, reason: string): Promise<void> {
    this.saving.add(playerPubkey);
    try {
      await publishServerSave(playerPubkey, save);
      console.log(`[nostr] saved ${playerPubkey.slice(0, 8)}… (${reason}) · lv ${save.level}`);
    } catch (err) {
      console.warn("[nostr] save failed", err);
    } finally {
      this.saving.delete(playerPubkey);
      const q = this.queued.get(playerPubkey);
      const next = q?.shift();
      if (next) {
        if (q && q.length > 0) this.queued.set(playerPubkey, q);
        else this.queued.delete(playerPubkey);
        void this.flush(playerPubkey, next.save, next.reason);
      }
    }
  }
}
