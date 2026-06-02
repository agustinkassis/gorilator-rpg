import "./webcrypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
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

/** Where a generated key is persisted when NOSTR_NSEC isn't set in the env.
 *  Override with NOSTR_IDENTITY_FILE; defaults to `.nostr-identity` in the
 *  server's working directory. Gitignored — it's a secret. */
function identityFile(): string {
  return resolve(process.env.NOSTR_IDENTITY_FILE?.trim() || ".nostr-identity");
}

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
 *   2. A previously-generated key persisted at `identityFile()`.
 *   3. Generate a fresh key AND persist it, so it survives the next restart.
 *
 * Persisting (step 3) is the key fix: without it a generated key was EPHEMERAL,
 * so every restart minted a new identity — orphaning every player's save AND,
 * since login challenges are signed with this key, breaking logins on restart.
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

  const file = identityFile();
  if (!sk && existsSync(file)) {
    try {
      sk = decodeNsec(readFileSync(file, "utf8"));
      if (sk) source = `file ${file}`;
      else console.warn(`[nostr] ${file} doesn't contain a valid nsec — regenerating.`);
    } catch {
      /* unreadable — fall through to generate */
    }
  }

  if (!sk) {
    sk = generateSecretKey();
    try {
      writeFileSync(file, nsecEncode(sk), { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best-effort perms */
      }
      source = `generated → ${file}`;
      console.log(`[nostr] no NOSTR_NSEC set — generated a server key and saved it to ${file}.`);
    } catch (err) {
      source = "generated (EPHEMERAL — could not persist)";
      console.warn(
        "[nostr] no NOSTR_NSEC set and couldn't write the identity file " +
          `(${err instanceof Error ? err.message : err}). Player progress will NOT ` +
          "survive a restart. Set NOSTR_NSEC to fix permanently:\n" +
          `           NOSTR_NSEC=${nsecEncode(sk)}`,
      );
    }
  }

  const pubkey = getPublicKey(sk);
  cached = { sk, pubkey, npub: npubEncode(pubkey) };
  console.log(`[nostr] server save identity: ${cached.npub} (${source})`);
  return cached;
}
