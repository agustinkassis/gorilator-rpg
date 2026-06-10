import { SimplePool } from "nostr-tools/pool";
import type { Filter } from "nostr-tools";
import { GORILATOR_ENTITY_KIND, GORILATOR_ENTITY_T, type CommunityEntity, type CommunityEntityType } from "@rpg/shared";

/**
 * Read-only discovery of community entities (kind-30333) and their authors' kind-0
 * profiles, for the Library's "Community" view. One-shot queries with a timeout —
 * dedup addressable events by (author, d) keeping the newest.
 */

const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band", "wss://relay.primal.net"];

interface RawEvent {
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface CommunityCard {
  id: string;
  author: string;
  createdAt: number;
  entity: CommunityEntity;
}

export interface OwnerProfile {
  name?: string;
  picture?: string;
}

/** Collect events for a filter until EOSE settles or the timeout elapses. */
function collect(pool: SimplePool, filter: Filter, timeoutMs: number): Promise<RawEvent[]> {
  return new Promise((resolve) => {
    const events: RawEvent[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sub.close();
      } catch {
        /* already closed */
      }
      resolve(events);
    };
    const timer = setTimeout(finish, timeoutMs);
    const sub = pool.subscribeMany(RELAYS, filter, {
      onevent(ev: RawEvent) {
        events.push(ev);
      },
      oneose() {
        // Most relays have delivered stored events; give late ones a brief grace.
        clearTimeout(timer);
        setTimeout(finish, 600);
      },
    });
  });
}

/** The optional server-side community cache (a warm relay subscription) — when set,
 *  it's hit first for an instant, cold-load-friendly result; relays are the fallback. */
const CACHE_URL = (import.meta.env.VITE_COMMUNITY_CACHE_URL as string | undefined)?.replace(/\/+$/, "");

/** Try the cache server (`@rpg/cache`) for the entity list; null on miss/unreachable. */
async function fetchFromCacheServer(type?: CommunityEntityType): Promise<CommunityCard[] | null> {
  if (!CACHE_URL) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${CACHE_URL}/community-entities`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) return null;
    const cards = (await res.json()) as CommunityCard[];
    if (!Array.isArray(cards) || !cards.length) return null;
    return type ? cards.filter((c) => c.entity?.type === type) : cards;
  } catch {
    return null; // unreachable / CORS / bad JSON → fall back to relays
  }
}

/** Fetch community entities, optionally filtered to one type, newest first. Prefers
 *  the server cache (fast cold loads), falling back to a direct relay query. */
export async function fetchCommunityEntities(
  type?: CommunityEntityType,
  timeoutMs = 5000,
): Promise<CommunityCard[]> {
  const fromCache = await fetchFromCacheServer(type);
  if (fromCache) return fromCache;
  const pool = new SimplePool();
  // Relays only index single-letter tag filters (NIP-01), so we query by `#t` and
  // filter on `entity.type` client-side rather than a (non-indexable) #entity-type.
  const filter: Filter = { kinds: [GORILATOR_ENTITY_KIND], "#t": [GORILATOR_ENTITY_T] };
  try {
    const events = await collect(pool, filter, timeoutMs);
    const byAddr = new Map<string, { ev: RawEvent; entity: CommunityEntity }>();
    for (const ev of events) {
      const d = ev.tags.find((t) => t[0] === "d")?.[1] || "";
      const key = `${ev.pubkey}:${d}`;
      const prev = byAddr.get(key);
      if (prev && prev.ev.created_at >= ev.created_at) continue;
      let entity: CommunityEntity;
      try {
        entity = JSON.parse(ev.content) as CommunityEntity;
      } catch {
        continue;
      }
      if (!entity || typeof entity !== "object" || !entity.type) continue;
      if (type && entity.type !== type) continue;
      byAddr.set(key, { ev, entity });
    }
    return [...byAddr.values()]
      .map(({ ev, entity }) => ({
        id: entity.id || ev.tags.find((t) => t[0] === "d")?.[1] || "",
        author: ev.pubkey,
        createdAt: ev.created_at,
        entity,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    pool.close(RELAYS);
  }
}

/** Resolve kind-0 name/avatar for a set of authors (for owner badges). */
export async function fetchProfiles(pubkeys: string[], timeoutMs = 4000): Promise<Record<string, OwnerProfile>> {
  const authors = [...new Set(pubkeys)].filter(Boolean);
  if (!authors.length) return {};
  const pool = new SimplePool();
  const ts: Record<string, number> = {};
  const out: Record<string, OwnerProfile> = {};
  try {
    await collect(pool, { kinds: [0], authors }, timeoutMs).then((events) => {
      for (const ev of events) {
        if ((ts[ev.pubkey] ?? 0) >= ev.created_at) continue;
        try {
          const m = JSON.parse(ev.content) as Record<string, unknown>;
          ts[ev.pubkey] = ev.created_at;
          out[ev.pubkey] = {
            name: (m.display_name as string) || (m.name as string) || undefined,
            picture: typeof m.picture === "string" ? m.picture : undefined,
          };
        } catch {
          /* skip malformed metadata */
        }
      }
    });
    return out;
  } finally {
    pool.close(RELAYS);
  }
}

/** Import a community entity into the LOCAL library (server downloads its assets). */
export async function importCommunityEntity(card: CommunityCard): Promise<{ id: string; type: string }> {
  const res = await fetch("/__content/import-remote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: card.entity.type, author: card.author, entity: card.entity }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { id: string; type: string };
}
