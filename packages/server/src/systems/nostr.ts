import "./webcrypto";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { verifyEvent } from "nostr-tools";
import { getServerIdentity } from "./nostrIdentity";
import {
  PlayerSave,
  InventorySlot,
  WORLD_SIZE,
  INV_SLOTS,
  MAX_STACK,
  PLAYER_MAX_HP,
  PLAYER_MAX_STAMINA,
  PLAYER_ATTACK,
  PLAYER_ARMOR,
  PLAYER_CRIT_CHANCE,
  MOVE_SPEED,
} from "@rpg/shared";

/** A signed Nostr event (NIP-01 shape). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** What the client puts in its Colyseus join options under `nostr`. */
export interface NostrJoinPayload {
  /** kind-22242 client-auth event signing our challenge — proves key ownership. */
  auth: NostrEvent;
  /** kind-0 metadata event — proves the name/avatar belong to that key. */
  profile?: NostrEvent;
}

export interface VerifiedNostr {
  pubkey: string;
  name: string;
  picture: string;
  nip05: string;
}

const AUTH_KIND = 22242; // NIP-42 client authentication
const APP_TAG = "gorilator"; // ties a signature to this game (not reusable elsewhere)
const CHALLENGE_TTL_MS = 5 * 60_000;
const FRESHNESS_S = 300; // the signed event's created_at must be within this of now

/**
 * Challenges are STATELESS: `${nonce}.${expiryMs}.${hmac}`, where the hmac is
 * keyed by the server's own secret key. Verification needs only that key, so a
 * challenge issued just before a restart still validates after it — fixing the
 * old in-memory Map that was wiped on every (tsx-watch / deploy) restart, which
 * silently rejected any login that was in flight ("invalid or replayed
 * challenge" → join rejected → a blank, map-less game).
 *
 * Replay within the TTL is blocked by a best-effort used-nonce set. It resets on
 * restart, but the short TTL plus the auth event's own created_at freshness
 * check keep the replay window tiny — fine for a game login.
 */
const usedNonces = new Map<string, number>(); // nonce -> expiry (ms epoch)

function challengeMac(payload: string): Buffer {
  return createHmac("sha256", Buffer.from(getServerIdentity().sk)).update(payload).digest();
}

/**
 * Issue a single-use, TTL-bounded challenge the client must embed in the event
 * it signs. Stateless + HMAC-signed, so it survives a server restart.
 */
export function issueChallenge(now = Date.now()): string {
  const payload = `${randomBytes(18).toString("hex")}.${now + CHALLENGE_TTL_MS}`;
  return `${payload}.${challengeMac(payload).toString("hex")}`;
}

/** Consume a challenge. True only if WE signed it (HMAC), it's unexpired, and it
 *  hasn't already been used in this process lifetime. */
function consumeChallenge(challenge: string, now: number): boolean {
  const parts = challenge.split(".");
  if (parts.length !== 3) return false;
  const [nonce, expStr, macHex] = parts;
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp < now) return false; // malformed / expired

  let mac: Buffer;
  try {
    mac = Buffer.from(macHex, "hex");
  } catch {
    return false;
  }
  const want = challengeMac(`${nonce}.${expStr}`);
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return false; // not ours

  for (const [n, e] of usedNonces) if (e < now) usedNonces.delete(n); // sweep
  if (usedNonces.has(nonce)) return false; // already used → no replay
  usedNonces.set(nonce, exp);
  return true;
}

function tagValue(ev: NostrEvent, name: string): string | undefined {
  return ev.tags?.find((t) => t[0] === name)?.[1];
}

/**
 * Verify a Nostr login server-side. Throws (with a human reason) on any failure;
 * on success returns the cryptographically-proven pubkey plus the validated
 * profile metadata.
 *
 * Trust chain:
 *   1. `auth`'s signature + id are valid (nostr-tools verifyEvent), so it was
 *      signed by `auth.pubkey`'s secret key.
 *   2. It's a fresh, this-app client-auth event embedding a challenge WE issued
 *      and have not seen before → the holder controls the key right now.
 *   3. (optional) `profile` is a kind-0 event signed by the SAME key, so its
 *      name/avatar are the user's own published metadata, not client-asserted.
 */
export function verifyNostrLogin(
  payload: NostrJoinPayload,
  now = Date.now(),
): VerifiedNostr {
  const auth = payload?.auth;
  if (!auth || typeof auth !== "object") throw new Error("missing auth event");

  if (!verifyEvent(auth as never)) throw new Error("bad auth signature");
  if (auth.kind !== AUTH_KIND) throw new Error("wrong auth kind");
  if (tagValue(auth, "app") !== APP_TAG) throw new Error("wrong app tag");
  if (Math.abs(now / 1000 - auth.created_at) > FRESHNESS_S) {
    throw new Error("stale auth event");
  }
  const challenge = tagValue(auth, "challenge");
  if (!challenge || !consumeChallenge(challenge, now)) {
    throw new Error("invalid or replayed challenge");
  }

  const pubkey = auth.pubkey;
  let name = "";
  let picture = "";
  let nip05 = "";

  const profile = payload.profile;
  if (profile) {
    if (!verifyEvent(profile as never)) throw new Error("bad profile signature");
    if (profile.kind !== 0) throw new Error("profile not kind 0");
    if (profile.pubkey !== pubkey) throw new Error("profile pubkey mismatch");
    try {
      const meta = JSON.parse(profile.content) as Record<string, unknown>;
      const rawName = meta.display_name || meta.name;
      if (typeof rawName === "string") name = rawName.trim().slice(0, 24);
      if (typeof meta.picture === "string") picture = meta.picture.slice(0, 400);
      if (typeof meta.nip05 === "string") nip05 = meta.nip05.slice(0, 128);
    } catch {
      /* malformed profile JSON — ignore it, keep the verified pubkey */
    }
  }

  return { pubkey, name, picture, nip05 };
}

const clampW = (v: number) => Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, v));
const finite = (v: unknown, def: number) => (Number.isFinite(Number(v)) ? Number(v) : def);

/**
 * Parse + sanitize a save's JSON into a sane PlayerSave. Coerces every field to
 * a finite number, clamps to legal ranges, and normalizes the inventory — so a
 * truncated/garbage save can't NaN-poison the simulation. The save is signed by
 * the SERVER's own key (it's authoritative), so this is purely NaN/range hygiene.
 */
export function sanitizeSaveContent(content: string): PlayerSave | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const maxHp = Math.max(1, finite(raw.maxHp, PLAYER_MAX_HP));
  const maxStamina = Math.max(1, finite(raw.maxStamina, PLAYER_MAX_STAMINA));
  return {
    v: Math.floor(finite(raw.v, 1)),
    level: Math.max(1, Math.floor(finite(raw.level, 1))),
    xp: Math.max(0, finite(raw.xp, 0)),
    maxHp,
    hp: Math.max(0, Math.min(maxHp, finite(raw.hp, maxHp))),
    maxStamina,
    stamina: Math.max(0, Math.min(maxStamina, finite(raw.stamina, maxStamina))),
    x: clampW(finite(raw.x, 0)),
    z: clampW(finite(raw.z, 0)),
    rotY: finite(raw.rotY, 0),
    attack: Math.max(0, finite(raw.attack, PLAYER_ATTACK)),
    armor: Math.max(0, finite(raw.armor, PLAYER_ARMOR)),
    critChance: Math.max(0, Math.min(1, finite(raw.critChance, PLAYER_CRIT_CHANCE))),
    moveSpeed: Math.max(0, finite(raw.moveSpeed, MOVE_SPEED)),
    throwPower: Math.max(0, finite(raw.throwPower, 1)),
    hue: finite(raw.hue, 0),
    inventory: sanitizeInventory(raw.inventory),
  };
}

/** Normalize an inventory to exactly INV_SLOTS valid slots. */
function sanitizeInventory(raw: unknown): InventorySlot[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: InventorySlot[] = [];
  for (let i = 0; i < INV_SLOTS; i++) {
    const s = arr[i] as { type?: unknown; count?: unknown } | undefined;
    const type = typeof s?.type === "string" && /^[a-z0-9_-]{1,48}$/.test(s.type) ? s.type : "";
    const count = Math.max(0, Math.min(MAX_STACK, Math.floor(finite(s?.count, 0))));
    out.push({ type: count > 0 ? (type as InventorySlot["type"]) : "", count: type && count > 0 ? count : 0 });
  }
  return out;
}
