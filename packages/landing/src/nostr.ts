import { npubEncode } from "nostr-tools/nip19";
import { SimplePool } from "nostr-tools/pool";

/** Minimal NIP-07 signer surface exposed by browser extensions (Alby, nos2x…). */
interface Nip07 {
  getPublicKey(): Promise<string>;
}

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
];

export interface NostrIdentity {
  pubkey: string;
  npub: string;
  name?: string;
  picture?: string;
}

/** True when a NIP-07 extension is available to connect with. */
export function hasNostrExtension(): boolean {
  return typeof window !== "undefined" && !!window.nostr;
}

/** Short, human-friendly npub (npub1abcd…wxyz). */
export function shortNpub(npub: string): string {
  return npub.length > 16 ? `${npub.slice(0, 10)}…${npub.slice(-6)}` : npub;
}

/**
 * Lightweight "connect": ask the extension for the pubkey, then race the relays
 * for a kind-0 profile so we can greet the player by name. The profile lookup is
 * best-effort — a missing profile never blocks the connection.
 */
export async function connectNostr(): Promise<NostrIdentity> {
  if (!window.nostr) {
    throw new Error("No Nostr extension found — install Alby or nos2x.");
  }
  const pubkey = await window.nostr.getPublicKey();
  const npub = npubEncode(pubkey);
  const identity: NostrIdentity = { pubkey, npub };

  try {
    const pool = new SimplePool();
    const event = await Promise.race([
      pool.get(RELAYS, { kinds: [0], authors: [pubkey] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    pool.close(RELAYS);
    if (event?.content) {
      const meta = JSON.parse(event.content) as { name?: string; display_name?: string; picture?: string };
      identity.name = meta.display_name || meta.name;
      identity.picture = meta.picture;
    }
  } catch {
    // best-effort profile lookup; ignore failures
  }

  return identity;
}
