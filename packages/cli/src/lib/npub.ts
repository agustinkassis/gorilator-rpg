// Minimal, dependency-free bech32 validation for Nostr npub keys. The CLI ships
// standalone (no nostr-tools), but admin management only needs to confirm an
// npub is well-formed (valid bech32, `npub` prefix, 32-byte payload) before
// storing it in ADMIN_NPUBS. The server decodes it for real with nostr-tools.
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
