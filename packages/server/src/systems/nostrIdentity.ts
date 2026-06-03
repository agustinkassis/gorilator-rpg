import "./webcrypto";
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
  /** 32-byte secp256k1 secret key (used to sign save events + login challenges). */
  sk: Uint8Array;
  /** hex public key — the `author` of every save event we publish. */
  pubkey: string;
  /** bech32 `npub…` form of the public key (for logs / the client to query). */
  npub: string;
}

let cached: ServerIdentity | null = null;

function decodeNsec(raw: string): Uint8Array | null {
  try {
    const dec = decode(raw.trim());
    return dec.type === "nsec" ? (dec.data as Uint8Array) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the server identity (memoised). Resolution order:
 *   1. `NOSTR_NSEC` from the environment (explicit, wins — e.g. in production).
 *   2. Generate a fresh ephemeral key for local/manual runs.
 *
 * Production installs should always set `NOSTR_NSEC`; otherwise each restart
 * mints a new identity, orphaning saved player progress and invalidating any
 * login challenge issued by the previous process.
 */
export function getServerIdentity(): ServerIdentity {
  if (cached) return cached;

  let sk: Uint8Array | null = null;
  let source = "";

  const envRaw = process.env.NOSTR_NSEC?.trim();
  if (envRaw) {
    sk = decodeNsec(envRaw);
    if (sk) source = "env NOSTR_NSEC";
    else console.warn("[nostr] NOSTR_NSEC is not a valid nsec — ignoring it.");
  }

  if (!sk) {
    sk = generateSecretKey();
    source = "generated ephemeral key";
    console.warn(
      "[nostr] no NOSTR_NSEC set — generated an ephemeral server key. Player " +
        "progress and in-flight login challenges will NOT survive a restart. " +
        "Set NOSTR_NSEC to fix permanently:\n" +
        `           NOSTR_NSEC=${nsecEncode(sk)}`,
    );
  }

  const pubkey = getPublicKey(sk);
  cached = { sk, pubkey, npub: npubEncode(pubkey) };
  console.log(`[nostr] server save identity: ${cached.npub} (${source})`);
  return cached;
}
