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
 * "Connect": ask the NIP-07 extension for the user's pubkey. Returns immediately
 * with just the identity (pubkey + npub) — the profile (avatar/name) is resolved
 * separately via fetchNostrProfile so the UI never blocks on the relays.
 */
export async function connectNostr(): Promise<NostrIdentity> {
  if (!window.nostr) {
    throw new Error("No Nostr extension found — install Alby or nos2x.");
  }
  const pubkey = await window.nostr.getPublicKey();
  return { pubkey, npub: npubEncode(pubkey) };
}

export interface NostrProfile {
  name?: string;
  picture?: string;
}

/**
 * Resolve a pubkey's kind-0 metadata (display name + avatar) from the relays. Uses a
 * live subscription that resolves on the first profile event — unlike a short-timeout
 * `pool.get`, a slow first relay connection won't drop the result. Best-effort: an
 * empty profile is returned if nothing arrives within the cap.
 */
export function fetchNostrProfile(pubkey: string, timeoutMs = 8000): Promise<NostrProfile> {
  return new Promise((resolve) => {
    const pool = new SimplePool();
    let settled = false;
    let sub: { close: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (profile: NostrProfile) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sub?.close();
      } catch {
        /* ignore */
      }
      pool.close(RELAYS);
      resolve(profile);
    };
    timer = setTimeout(() => finish({}), timeoutMs);
    sub = pool.subscribeMany(
      RELAYS,
      { kinds: [0], authors: [pubkey] },
      {
        onevent(ev) {
          try {
            const meta = JSON.parse(ev.content) as {
              name?: string;
              display_name?: string;
              displayName?: string;
              picture?: string;
            };
            finish({
              // NIP-24 display_name (or the camelCase variant some clients use) wins over the handle.
              name: meta.display_name || meta.displayName || meta.name || undefined,
              picture: typeof meta.picture === "string" ? meta.picture : undefined,
            });
          } catch {
            /* wait for a parseable event */
          }
        },
      },
    );
  });
}
