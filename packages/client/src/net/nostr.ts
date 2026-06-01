import { SimplePool } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import { SERVER_PORT } from "@rpg/shared";

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

/** The signed bundle the server verifies on join. */
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
  return `${proto}://${location.hostname}:${SERVER_PORT}`;
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

  // 1. one-time challenge from the server (single-use → no replay)
  onPhase("challenge");
  let challenge: string;
  try {
    const res = await fetch(`${httpBase()}/nostr/challenge`);
    if (!res.ok) throw new Error(String(res.status));
    challenge = ((await res.json()) as { challenge: string }).challenge;
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

  // 3. best-effort kind-0 profile fetch (login still works without it)
  onPhase("relays");
  let profile: NostrEvent | undefined;
  let meta: NostrProfile = { name: "", picture: "", nip05: "", about: "" };
  try {
    const pool = new SimplePool();
    const ev = (await Promise.race([
      pool.get(RELAYS, { kinds: [0], authors: [pubkey] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ])) as NostrEvent | null;
    pool.close(RELAYS);
    if (ev) {
      profile = ev;
      try {
        const m = JSON.parse(ev.content) as Record<string, unknown>;
        meta = {
          name: String(m.display_name || m.name || ""),
          picture: String(m.picture || ""),
          nip05: String(m.nip05 || ""),
          about: String(m.about || ""),
        };
      } catch {
        /* malformed profile JSON — keep the verified pubkey */
      }
    }
  } catch {
    /* relays unreachable — proceed with just the verified pubkey */
  }
  onPhase("profile", meta.name);
  onPhase("done");

  return { pubkey, npub: npubEncode(pubkey), auth, profile, meta };
}
