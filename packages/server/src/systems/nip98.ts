// NIP-98 (HTTP Auth) verification for the protected /api/admin/* endpoints.
//
// The client sends `Authorization: Nostr <base64-event>` where the event is a
// kind-27235 Nostr event signed by the user's key, with `u` (the request URL)
// and `method` tags. We verify the signature + structure, that the URL/method
// match THIS request, and that it's fresh — then hand back the proven pubkey.
import type { Request, Response, NextFunction } from "express";
import { nip98 } from "nostr-tools";
import { isAdmin } from "./admins";

export interface AdminRequest extends Request {
  /** Set by verifyNip98/requireAdmin once authentication succeeds. */
  adminPubkey?: string;
}

/** Reconstruct the absolute URL the client signed, honoring proxy headers so it
 *  matches what the browser fetched (same-origin behind a Cloudflare tunnel). */
function requestUrl(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0]?.trim() || req.get("host");
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Verify a NIP-98 Authorization header on `req`. Resolves the signed-in pubkey
 * (hex) on success; throws an Error with a human reason otherwise. Does NOT
 * check admin membership — callers decide what the pubkey is allowed to do.
 */
export async function verifyNip98(req: Request): Promise<string> {
  const header = req.headers.authorization;
  if (!header || !/^Nostr\s+/i.test(header)) throw new Error("missing NIP-98 Authorization header");

  // unpackEventFromToken verifies the signature + base64/JSON structure.
  const event = await nip98.unpackEventFromToken(header).catch(() => {
    throw new Error("malformed NIP-98 token");
  });
  if (!nip98.validateEventKind(event)) throw new Error("wrong event kind (need 27235)");
  if (!nip98.validateEventTimestamp(event)) throw new Error("stale NIP-98 token");
  if (!nip98.validateEventMethodTag(event, req.method)) throw new Error("method tag mismatch");
  if (!nip98.validateEventUrlTag(event, requestUrl(req))) throw new Error("url tag mismatch");
  return event.pubkey;
}

/**
 * Express middleware: require a valid NIP-98 token from a configured admin.
 * On success sets `req.adminPubkey` and calls next(); otherwise responds 401/403.
 */
export async function requireAdmin(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  let pubkey: string;
  try {
    pubkey = await verifyNip98(req);
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : "unauthorized" });
    return;
  }
  if (!isAdmin(pubkey)) {
    res.status(403).json({ error: "not an admin", pubkey });
    return;
  }
  req.adminPubkey = pubkey;
  next();
}
