import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nip19, SimplePool } from "nostr-tools";
import { addWaveSource } from "../waves";

/**
 * Nostr-distributed data plugins ("realm packs") — the no-code content tier over
 * the wire. A pack author publishes a kind-30333 addressable event whose content
 * is JSON: { "type": "waves", "data": [ ...waves.json shape... ] }. A server
 * operator opts in by listing trusted authors:
 *
 *   REALM_PACK_AUTHORS=npub1...,npub1...   (or hex pubkeys)
 *   REALM_PACK_RELAYS=wss://relay.damus.io,wss://nos.lol   (optional override)
 *
 * Events from those authors are cached to .gorilator-packs/ and fed through the
 * SAME live-reload pipeline as local content (currently: additive custom waves —
 * the same shapes the worked-example plugin ships on disk). Data packs are pure
 * JSON: they are validated and parsed, never executed.
 */

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const PACK_KIND = 30333;
const CACHE_DIR_CANDIDATES = [
  resolve(process.cwd(), ".gorilator-packs"),
  resolve(process.cwd(), "../../.gorilator-packs"),
];

let started = false;
const knownSources = new Set<string>();

function decodeAuthor(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "npub") return decoded.data as string;
  } catch {
    /* fall through */
  }
  console.warn(`[packs] unrecognized author "${value}" — ignored`);
  return null;
}

export function initNostrContent(): void {
  if (started) return;
  started = true;

  const authors = (process.env.REALM_PACK_AUTHORS ?? "")
    .split(",")
    .map(decodeAuthor)
    .filter((a): a is string => Boolean(a));
  if (!authors.length) return; // feature off — the default

  const relays = (process.env.REALM_PACK_RELAYS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const useRelays = relays.length ? relays : DEFAULT_RELAYS;
  const cacheDir = CACHE_DIR_CANDIDATES[0];
  mkdirSync(cacheDir, { recursive: true });

  console.log(`[packs] subscribing to kind ${PACK_KIND} from ${authors.length} author(s) on ${useRelays.length} relay(s)`);
  const pool = new SimplePool();
  // nostr-tools 2.23: subscribeMany takes ONE filter object (not an array).
  pool.subscribeMany(
    useRelays,
    { kinds: [PACK_KIND], authors },
    {
      onevent(event) {
        try {
          const pack = JSON.parse(event.content) as { type?: string; data?: unknown };
          const author8 = event.pubkey.slice(0, 8);
          if (pack.type === "waves" && Array.isArray(pack.data)) {
            const file = join(cacheDir, `${author8}-waves.json`);
            writeFileSync(file, JSON.stringify(pack.data, null, 2));
            const source = `nostr:${author8}`;
            if (!knownSources.has(source)) {
              knownSources.add(source);
              addWaveSource(file, source); // live-reload pipeline takes over
            }
            console.log(`[packs] waves pack from ${author8} applied (${pack.data.length} wave(s))`);
          } else {
            console.warn(`[packs] unsupported pack type "${String(pack.type)}" from ${author8} — ignored`);
          }
        } catch (err) {
          console.warn("[packs] bad pack event — ignored", err);
        }
      },
    },
  );
}
