import { SimplePool } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import { getToken } from "nostr-tools/nip98";
import { SERVER_PORT, NOSTR_SAVE_KIND, saveDTag, type PlayerSave } from "@rpg/shared";

export type { PlayerSave };

/**
 * Build a NIP-98 `Authorization: Nostr …` header for an HTTP request, signed by
 * the connected signer (`window.nostr` — a NIP-07 extension, the dev mock, or the
 * bunker shim). Used to call the server's protected /api/admin/* endpoints.
 */
export async function nip98AuthHeader(url: string, method: string): Promise<string> {
  const signer = window.nostr;
  if (!signer) throw new Error("no Nostr signer");
  // getToken signs a kind-27235 event tagging the URL + method; the `true` flag
  // prefixes the returned token with the "Nostr " auth scheme.
  return getToken(url, method, (e) => signer.signEvent(e), true);
}

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

/** The signed bundle the server verifies on join. Progress is NOT sent here —
 *  the server signs/owns saves with its own key and recovers them on join. */
export interface NostrAuthPayload {
  auth: NostrEvent; // kind-22242 event signing the server challenge
  profile?: NostrEvent; // kind-0 metadata event (for the name/avatar)
}

export interface NostrProfile {
  name: string;
  picture: string;
  nip05: string;
  about: string;
}

/**
 * A verified Nostr identity: who the player is + their profile + a preview of
 * recovered progress. It deliberately carries NO `auth` — the kind-22242 auth is
 * signed FRESH at join time (`signNostrAuth`) so a persisted/restored identity
 * never reuses a stale (>300s) challenge.
 */
export interface NostrIdentity {
  pubkey: string;
  npub: string;
  meta: NostrProfile;
  profile?: NostrEvent; // the kind-0 event, forwarded in the server join payload
  recovered?: PlayerSave; // last server-signed save (read-only preview for the splash)
}

/** Minimal NIP-07 signer interface — extensions (Alby, nos2x), the dev mock, and
 *  the bunker shim (`installBunkerSigner`) all implement exactly this. */
export interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<NostrEvent>;
}

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

/** A few well-known public relays to look up the user's profile metadata. */
export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
];

/** True when a signer is connected right now (extension / mock / bunker shim). */
export function hasNostrExtension(): boolean {
  return typeof window !== "undefined" && !!window.nostr;
}

function httpBase(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv.replace(/^wss?:/, location.protocol === "https:" ? "https:" : "http:");

  const proto = location.protocol === "https:" ? "https" : "http";
  if (import.meta.env.VITE_SAME_ORIGIN === "1") return `${proto}://${location.host}`;

  const serverPort = (import.meta.env.VITE_SERVER_PORT as string | undefined) || String(SERVER_PORT);
  return `${proto}://${location.hostname}:${serverPort}`;
}

/** A coarse phase of the login, reported to `onPhase` so the UI can narrate it. */
export type NostrPhase =
  | "signer"
  | "pubkey"
  | "challenge"
  | "challenged"
  | "sign"
  | "signed"
  | "relays"
  | "profile"
  | "save"
  | "done";

/** Fetch a one-time challenge + the server's own pubkey (it signs/owns saves). */
async function fetchChallenge(): Promise<{ challenge: string; serverPubkey: string }> {
  const res = await fetch(`${httpBase()}/nostr/challenge`);
  if (!res.ok) throw new Error(String(res.status));
  const j = (await res.json()) as { challenge: string; serverPubkey?: string };
  return { challenge: j.challenge, serverPubkey: j.serverPubkey ?? "" };
}

/**
 * Establish a verified identity from the connected signer (`window.nostr`): read
 * the pubkey, then fetch the kind-0 profile + the server-signed save preview from
 * the relays. Does NOT sign an auth challenge — `signNostrAuth()` does that fresh
 * at join, so this same call powers both fresh login and a restored session.
 */
export async function establishNostrIdentity(
  onPhase: (phase: NostrPhase, detail?: string) => void = () => {},
): Promise<NostrIdentity> {
  if (!window.nostr) throw new Error("No Nostr signer connected.");
  onPhase("signer");
  const pubkey = await window.nostr.getPublicKey();
  onPhase("pubkey", npubEncode(pubkey));

  // The server owns the save events, so we need ITS pubkey to read them. A
  // throwaway challenge fetch carries it (unused challenges are stateless + free).
  onPhase("relays");
  let serverPubkey = "";
  try {
    serverPubkey = (await fetchChallenge()).serverPubkey;
  } catch {
    /* server unreachable for the preview — proceed with just the pubkey */
  }

  const { meta, profile, recovered } = await fetchProfileAndSave(pubkey, serverPubkey);
  onPhase("profile", meta.name);
  if (recovered) onPhase("save", `level ${recovered.level} · ${recovered.xp} xp`);
  onPhase("done");

  return { pubkey, npub: npubEncode(pubkey), meta, profile, recovered };
}

/**
 * Sign a FRESH kind-22242 client-auth event for the current join (the challenge
 * is single-use and the server requires it < 300s old). Called right before
 * `net.connect` — for both extension and bunker signers, via `window.nostr`.
 */
export async function signNostrAuth(
  onPhase: (phase: NostrPhase, detail?: string) => void = () => {},
): Promise<NostrEvent> {
  if (!window.nostr) throw new Error("No Nostr signer connected.");
  onPhase("challenge");
  const { challenge } = await fetchChallenge();
  onPhase("sign");
  const auth = await window.nostr.signEvent({
    kind: 22242, // NIP-42 client authentication
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["challenge", challenge],
      ["app", "gorilator"],
      ["relay", location.origin],
    ],
    content: "Authenticate to Gorilator",
  });
  onPhase("signed");
  return auth;
}

/**
 * Best-effort fetch of a pubkey's kind-0 profile metadata + the latest
 * server-signed save (under `serverPubkey`, keyed by `saveDTag(pubkey)`), used to
 * preview "recovered level N" on the splash. Never throws.
 */
export async function fetchProfileAndSave(
  pubkey: string,
  serverPubkey: string,
): Promise<{ meta: NostrProfile; profile?: NostrEvent; recovered?: PlayerSave }> {
  let profile: NostrEvent | undefined;
  let recovered: PlayerSave | undefined;
  let meta: NostrProfile = { name: "", picture: "", nip05: "", about: "" };
  try {
    const pool = new SimplePool();
    const [profEv, saveEv] = await Promise.all([
      raceTimeout(pool.get(RELAYS, { kinds: [0], authors: [pubkey] }), 4000),
      serverPubkey
        ? raceTimeout(
            pool.get(RELAYS, {
              kinds: [NOSTR_SAVE_KIND],
              authors: [serverPubkey],
              "#d": [saveDTag(pubkey)],
            }),
            4500,
          )
        : Promise.resolve(null),
    ]);
    pool.close(RELAYS);
    if (profEv) {
      profile = profEv as NostrEvent;
      meta = parseProfile(profEv as NostrEvent);
    }
    if (saveEv) recovered = parseSave(saveEv as NostrEvent) ?? undefined;
  } catch {
    /* relays unreachable — proceed with just the verified pubkey */
  }
  return { meta, profile, recovered };
}

// ---- parsing ----------------------------------------------------------------

/** Parse a save event's JSON content into a PlayerSave (or null if malformed). */
function parseSave(ev: NostrEvent): PlayerSave | null {
  try {
    return JSON.parse(ev.content) as PlayerSave;
  } catch {
    return null;
  }
}

/** Parse a kind-0 metadata event into a NostrProfile (name/picture/nip05/about). */
export function parseProfile(ev: NostrEvent): NostrProfile {
  try {
    const m = JSON.parse(ev.content) as Record<string, unknown>;
    return {
      name: String(m.display_name || m.name || ""),
      picture: String(m.picture || ""),
      nip05: String(m.nip05 || ""),
      about: String(m.about || ""),
    };
  } catch {
    return { name: "", picture: "", nip05: "", about: "" };
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}
