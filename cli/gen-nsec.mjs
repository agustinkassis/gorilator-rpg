#!/usr/bin/env node
// Print a fresh Nostr secret key as a bech32 `nsec1…` string — ZERO dependencies
// (only node:crypto), so `gorilator install` can mint the server's NOSTR_NSEC on
// a fresh box without first installing the project. An nsec is simply bech32 of
// 32 random bytes with the human-readable prefix "nsec" (NIP-19 / BIP-173).
import { randomBytes } from "node:crypto";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function checksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

/** Re-group `from`-bit values into `to`-bit values (8→5 for bech32 payloads). */
function convertBits(bytes, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of bytes) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

function bech32Encode(hrp, data) {
  const combined = data.concat(checksum(hrp, data));
  let out = hrp + "1";
  for (const d of combined) out += CHARSET.charAt(d);
  return out;
}

const words = convertBits([...randomBytes(32)], 8, 5, true);
process.stdout.write(bech32Encode("nsec", words) + "\n");
