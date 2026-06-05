// Minimal, dependency-free Nostr key helpers for CLI admin management (the CLI
// ships standalone, no nostr-tools): bech32 validate/decode/encode for npub keys
// and NIP-05 resolution (name@domain → npub). Used to add/validate admins stored
// in ADMIN_NPUBS; the server decodes them for real with nostr-tools.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** Decode a bech32 string into { hrp, data(5-bit words) }, or null if invalid. */
function bech32Decode(str: string): { hrp: string; data: number[] } | null {
  if (str.length < 8 || str.length > 1000) return null;
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null;
  const s = str.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) return null;
  const hrp = s.slice(0, pos);
  const data: number[] = [];
  for (let i = pos + 1; i < s.length; i++) {
    const d = CHARSET.indexOf(s[i]);
    if (d === -1) return null;
    data.push(d);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null;
  return { hrp, data: data.slice(0, data.length - 6) }; // drop the 6-word checksum
}

/** Convert 5-bit groups back to bytes (bech32 → raw). Null on invalid padding. */
function fromWords(words: number[]): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  return out;
}

/** True if `value` is a syntactically valid npub (bech32, hrp "npub", 32 bytes). */
export function isValidNpub(value: string): boolean {
  return npubToHex(value) !== null;
}

/** npub1… → 64-char hex pubkey, or null when it isn't a valid npub. */
export function npubToHex(value: string): string | null {
  const v = value.trim();
  if (!/^npub1[0-9a-z]+$/i.test(v)) return null;
  const decoded = bech32Decode(v);
  if (!decoded || decoded.hrp !== "npub") return null;
  const bytes = fromWords(decoded.data);
  if (!bytes || bytes.length !== 32) return null;
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bytes → 5-bit bech32 words (8→5 regroup with zero-padding). */
function toWords(bytes: number[]): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

/** Encode a bech32 string from an hrp + 5-bit data words. */
function bech32Encode(hrp: string, data: number[]): string {
  const checksum: number[] = [];
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}

/** 64-char hex pubkey → npub1…, or null if not a valid 32-byte hex key. */
export function hexToNpub(hex: string): string | null {
  const h = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  return bech32Encode("npub", toWords(bytes));
}

/**
 * Resolve a NIP-05 identifier (`name@domain`, or bare `domain` → `_@domain`) to
 * an npub by fetching `https://domain/.well-known/nostr.json?name=name`. Returns
 * the npub, or null if it can't be resolved.
 */
export async function nip05ToNpub(identifier: string): Promise<string | null> {
  const id = identifier.trim().toLowerCase();
  const at = id.indexOf("@");
  const name = at === -1 ? "_" : id.slice(0, at);
  const domain = at === -1 ? id : id.slice(at + 1);
  if (!domain || !/^[a-z0-9.-]+$/.test(domain) || !/^[a-z0-9._-]+$/.test(name)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      { headers: { Accept: "application/json" }, signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { names?: Record<string, string> };
    const hex = data?.names?.[name];
    return typeof hex === "string" ? hexToNpub(hex) : null;
  } catch {
    return null;
  }
}
