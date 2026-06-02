import { SimplePool } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import { SERVER_PORT, NOSTR_SAVE_KIND, saveDTag, PlayerSave } from "@rpg/shared";

export type { PlayerSave };

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

export interface NostrCredentials extends NostrAuthPayload {
  pubkey: string;
  npub: string;
  meta: NostrProfile;
  recovered?: PlayerSave; // last server-signed save (read-only preview for the splash)
}

/** Minimal NIP-07 signer interface exposed by extensions (Alby, nos2x, …). */
interface Nip07 {
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
const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
];

/** True when a NIP-07 browser extension is available to sign with. */
export function hasNostrExtension(): boolean {
  return typeof window !== "undefined" && !!window.nostr;
}

function httpBase(): string {
  const proto = location.protocol === "https:" ? "https" : "http";
  const serverPort = (import.meta.env.VITE_SERVER_PORT as string | undefined) || String(SERVER_PORT);
  return `${proto}://${location.hostname}:${serverPort}`;
}

/**
 * Full NIP-07 login: prove control of the pubkey by signing a one-time
 * server challenge, then fetch the user's kind-0 profile from relays. The
 * returned `auth`/`profile` are re-verified server-side on join.
 */
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

export async function nostrLogin(
  onPhase: (phase: NostrPhase, detail?: string) => void = () => {},
): Promise<NostrCredentials> {
  if (!window.nostr) {
    throw new Error("No Nostr extension found — install Alby or nos2x.");
  }
  onPhase("signer");
  const pubkey = await window.nostr.getPublicKey();
  onPhase("pubkey", npubEncode(pubkey));

  // 1. one-time challenge from the server (single-use → no replay). The server
  //    also returns its own pubkey: it signs/owns the save events, so we query
  //    the relays under THAT key (not the user's) to preview recovered progress.
  onPhase("challenge");
  let challenge: string;
  let serverPubkey = "";
  try {
    const res = await fetch(`${httpBase()}/nostr/challenge`);
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { challenge: string; serverPubkey?: string };
    challenge = j.challenge;
    serverPubkey = j.serverPubkey ?? "";
  } catch {
    throw new Error("Couldn't reach the game server for a challenge.");
  }
  onPhase("challenged", challenge);

  // 2. sign a fresh client-auth event embedding the challenge (proves ownership)
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

  // 3. fetch the kind-0 profile (the user's key) AND the kind-30078 save (the
  //    SERVER's key, keyed by saveDTag(pubkey)) in parallel (best-effort). The
  //    save is read-only here — just to preview "recovered level N" on the splash;
  //    the server does the authoritative recovery on join.
  onPhase("relays");
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
      profile = profEv;
      meta = parseProfile(profEv);
    }
    if (saveEv) recovered = parseSave(saveEv) ?? undefined;
  } catch {
    /* relays unreachable — proceed with just the verified pubkey */
  }
  onPhase("profile", meta.name);
  if (recovered) onPhase("save", `level ${recovered.level} · ${recovered.xp} xp`);
  onPhase("done");

  return { pubkey, npub: npubEncode(pubkey), auth, profile, meta, recovered };
}

// ---- save preview (read-only) ----------------------------------------------

/** Parse a save event's JSON content into a PlayerSave (or null if malformed).
 *  Used only to preview recovered progress on the splash — the server signs and
 *  applies the authoritative save. */
function parseSave(ev: NostrEvent): PlayerSave | null {
  try {
    return JSON.parse(ev.content) as PlayerSave;
  } catch {
    return null;
  }
}

function parseProfile(ev: NostrEvent): NostrProfile {
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
