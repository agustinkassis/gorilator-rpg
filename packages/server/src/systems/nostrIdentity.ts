import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { decode, npubEncode, nsecEncode } from "nostr-tools/nip19";

/**
 * The server's own Nostr identity. Unlike the players (who prove ownership of
 * their key with a NIP-07 signature but never hand it over), the SERVER holds a
 * real secret key so it can *write* events — specifically, it signs and
 * publishes every player's progress save (kind 30078) to the relays. One server
 * key stores all saves; each player's save is keyed by the `d` tag (see
 * `saveDTag`), so the server is the single, authoritative writer.
 */
export interface ServerIdentity {
  /** 32-byte secp256k1 secret key (used to sign save events). */
  sk: Uint8Array;
  /** hex public key — the `author` of every save event we publish. */
  pubkey: string;
  /** bech32 `npub…` form of the public key (for logs / the client to query). */
  npub: string;
}

let cached: ServerIdentity | null = null;

/**
 * Resolve the server identity (memoised). Reads `NOSTR_NSEC` from the
 * environment; if it's missing or malformed, generates an EPHEMERAL key so the
 * server still runs — but warns loudly, because saves signed by a throwaway key
 * are unrecoverable after a restart. The printed `nsec…` can be pasted into the
 * environment to make progress persist. (`gorilator install` writes one for you.)
 */
export function getServerIdentity(): ServerIdentity {
  if (cached) return cached;

  let sk: Uint8Array | null = null;
  const raw = process.env.NOSTR_NSEC?.trim();
  if (raw) {
    try {
      const dec = decode(raw);
      if (dec.type === "nsec") sk = dec.data as Uint8Array;
      else console.warn(`[nostr] NOSTR_NSEC is a "${dec.type}", expected an nsec — ignoring it.`);
    } catch {
      console.warn("[nostr] NOSTR_NSEC is not a valid nsec — ignoring it.");
    }
  }

  if (!sk) {
    sk = generateSecretKey();
    console.warn(
      "[nostr] no NOSTR_NSEC set — generated an EPHEMERAL server key.\n" +
        "         Player progress will NOT survive a server restart until you persist it.\n" +
        `         Add this to your environment (.env) to keep it:\n` +
        `           NOSTR_NSEC=${nsecEncode(sk)}`,
    );
  }

  const pubkey = getPublicKey(sk);
  cached = { sk, pubkey, npub: npubEncode(pubkey) };
  console.log(`[nostr] server save identity: ${cached.npub}`);
  return cached;
}
