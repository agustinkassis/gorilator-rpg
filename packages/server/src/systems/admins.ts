// The server's admin list. Admins are Nostr identities (npubs) allowed to call
// the protected /api/admin/* endpoints (authenticated with NIP-98). The list is
// configured via the ADMIN_NPUBS env var — a comma/whitespace-separated list of
// npub1… (or raw 64-char hex) keys — managed by `gorilator setup`, or hand-set.
import { nip19 } from "nostr-tools";

/** Parse ADMIN_NPUBS into a set of lowercase hex pubkeys. Invalid entries are
 *  skipped (with a warning) so one typo can't lock everyone out. */
function parseAdmins(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const token of raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    const hex = toHexPubkey(token);
    if (hex) out.add(hex);
    else console.warn(`[admin] ignoring invalid ADMIN_NPUBS entry: ${token.slice(0, 16)}…`);
  }
  return out;
}

/** npub1… or 64-char hex → lowercase hex pubkey, or null if not a valid key. */
export function toHexPubkey(value: string): string | null {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  if (v.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(v);
      if (decoded.type === "npub" && typeof decoded.data === "string") return decoded.data;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// Resolved once at startup. ADMIN_NPUBS is set in the install .env, which the
// daemon reads on (re)start — so `gorilator setup` restarts the daemon to apply.
const admins = parseAdmins(process.env.ADMIN_NPUBS);

if (admins.size > 0) {
  console.log(`[admin] ${admins.size} admin npub(s) configured`);
} else {
  console.log("[admin] no admins configured (set ADMIN_NPUBS to enable /api/admin/*)");
}

/** True when the given hex pubkey is a configured admin. */
export function isAdmin(pubkey: string): boolean {
  return admins.has(pubkey.toLowerCase());
}

/** Number of configured admins. */
export function adminCount(): number {
  return admins.size;
}

/** The configured admins as npub strings (for display / admin listing). */
export function listAdminNpubs(): string[] {
  return [...admins].map((hex) => nip19.npubEncode(hex));
}
