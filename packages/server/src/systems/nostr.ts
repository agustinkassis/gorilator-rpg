import { randomBytes } from "node:crypto";
import { verifyEvent } from "nostr-tools";

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

/** challenge -> expiry (ms epoch). One process, so an in-memory store is fine. */
const challenges = new Map<string, number>();

function prune(now: number) {
  for (const [c, exp] of challenges) if (exp < now) challenges.delete(c);
}

/**
 * Issue a one-time random challenge the client must embed in the event it signs.
 * Single-use + TTL means a captured signature can't be replayed to log in again.
 */
export function issueChallenge(now = Date.now()): string {
  prune(now);
  const challenge = randomBytes(32).toString("hex");
  challenges.set(challenge, now + CHALLENGE_TTL_MS);
  return challenge;
}

/** Consume a challenge (single use). True only if it was issued and unexpired. */
function consumeChallenge(challenge: string, now: number): boolean {
  const exp = challenges.get(challenge);
  if (exp === undefined) return false;
  challenges.delete(challenge); // one-time use → no replay
  return exp >= now;
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
