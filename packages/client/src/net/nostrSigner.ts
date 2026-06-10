import type { Nip46Client } from "./nip46";
import type { NostrIdentity } from "./nostr";

/**
 * Holds the active Nostr session at runtime: the verified identity (for the
 * profile card) and, for bunker logins, the live `Nip46Client` (so logout can
 * close it). Set wherever a session is created (fresh login / restore); read by
 * the player menu + logout.
 */
let activeIdentity: NostrIdentity | null = null;
let activeBunkerClient: Nip46Client | null = null;

export function setActiveSession(identity: NostrIdentity | null, client: Nip46Client | null): void {
  activeIdentity = identity;
  activeBunkerClient = client;
}

export function getActiveIdentity(): NostrIdentity | null {
  return activeIdentity;
}

export function getActiveBunkerClient(): Nip46Client | null {
  return activeBunkerClient;
}

export function clearActiveSession(): void {
  try {
    activeBunkerClient?.close();
  } catch {
    /* ignore */
  }
  activeBunkerClient = null;
  activeIdentity = null;
}
