import type { CommunityEntityAsset } from "@rpg/shared";

/**
 * Minimal Blossom client (BUD-01/02) for hosting community-entity assets.
 *
 * Blossom stores blobs content-addressed by sha-256: you PUT the bytes with an
 * `Authorization: Nostr <base64 kind-24242 event>` header, and the server returns
 * a descriptor whose `url` ends in the hash. Because the address IS the hash, any
 * Blossom server can later serve (or mirror) the same blob — so we publish to one
 * and store the absolute URL + hash in the entity event.
 *
 * Signing uses the connected NIP-07 signer (`window.nostr`), which the `?mocknostr=`
 * dev signer also implements — so the whole publish loop works without an extension.
 */

/** Public Blossom servers we try in order (first success wins). */
export const BLOSSOM_SERVERS = ["https://blossom.primal.net", "https://blossom.band"];

const AUTH_TTL_SEC = 300;

/** Hex sha-256 of a byte buffer (Blossom's content address). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface BlobDescriptor {
  url?: string;
  sha256?: string;
  size?: number;
  type?: string;
}

/**
 * Upload one blob to Blossom and return its hosted asset reference. Throws if no
 * signer is connected or every server rejects the upload.
 */
export async function uploadBlob(
  bytes: ArrayBuffer,
  mime: string,
  servers: string[] = BLOSSOM_SERVERS,
): Promise<CommunityEntityAsset> {
  const signer = window.nostr;
  if (!signer) throw new Error("Connect Nostr to publish (no signer available).");
  const hash = await sha256Hex(bytes);
  const now = Math.floor(Date.now() / 1000);
  const authEvent = await signer.signEvent({
    kind: 24242, // Blossom authorization event (BUD-01)
    created_at: now,
    tags: [
      ["t", "upload"],
      ["x", hash],
      ["expiration", String(now + AUTH_TTL_SEC)],
    ],
    content: `Upload Gorilator entity asset (${mime})`,
  });
  const authHeader = "Nostr " + btoa(JSON.stringify(authEvent));

  let lastErr = "";
  for (const server of servers) {
    const base = server.replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/upload`, {
        method: "PUT",
        headers: { Authorization: authHeader, "Content-Type": mime },
        body: bytes,
      });
      if (!res.ok) {
        lastErr = `${base}: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 160);
        continue;
      }
      const d = (await res.json().catch(() => ({}))) as BlobDescriptor;
      const url = d.url || `${base}/${hash}`;
      return { url, sha256: d.sha256 || hash, size: d.size || bytes.byteLength, mime: d.type || mime };
    } catch (e) {
      lastErr = `${base}: ${(e as Error).message}`;
    }
  }
  throw new Error(`Blossom upload failed — ${lastErr || "all servers unreachable"}`);
}

/**
 * Download a blob by URL (used when importing a community entity locally). Verifies
 * the content hash when one is provided, so a tampered/mismatched blob is rejected.
 */
export async function downloadBlob(url: string, expectedSha256?: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  const bytes = await res.arrayBuffer();
  if (expectedSha256) {
    const got = await sha256Hex(bytes);
    if (got !== expectedSha256) throw new Error(`sha256 mismatch for ${url}`);
  }
  return bytes;
}
