import type { NostrProfile } from "./nostr";

/**
 * Persisted Nostr session so a login survives a browser refresh. On startup the
 * app restores the logged-in splash state and re-verifies the signer is still
 * live (see main.ts `restoreSession`).
 *
 * For a bunker session we store the app's NIP-46 **client** secret key (the
 * delegated transport key — NOT the user's nsec, which never leaves the remote
 * signer). Losing it only means re-pairing; it can't recover the user's key.
 */
export type SavedSession =
  | { v: 1; method: "nip07"; pubkey: string; npub: string; meta: NostrProfile }
  | {
      v: 1;
      method: "bunker";
      pubkey: string;
      npub: string;
      meta: NostrProfile;
      bunker: { clientSecretKey: string; remotePubkey: string; relays: string[]; secret?: string };
    };

const KEY = "gorilator-nostr-session";

/** Read the saved session, or null if absent / corrupt / unknown version. */
export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedSession;
    if (!s || s.v !== 1 || (s.method !== "nip07" && s.method !== "bunker") || !s.pubkey) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(session: SavedSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* storage full / disabled — non-fatal, the session just won't persist */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** True when a session blob is present (distinct from a signer being live now). */
export function hasSavedSession(): boolean {
  return loadSession() !== null;
}
