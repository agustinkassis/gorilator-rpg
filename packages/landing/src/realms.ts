import { useEffect, useMemo, useRef, useState } from "react";
import { SimplePool } from "nostr-tools/pool";

// Public relays the Gorilator servers publish to (see docs/nostr.md, REALMS.md).
export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
];

const DISCOVERY_KIND = 30078;
const DISCOVERY_D = "gorilator-server";
const PROFILE_KIND = 0;

/** Just the event fields we read — keeps us decoupled from nostr-tools' Event type. */
interface RawEvent {
  content: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
}

export interface RealmInfo {
  id: string;
  startedAt: number;
  endedAt?: number;
  wave: number;
  players?: number;
  peakPlayers?: number;
  npubs: string[];
  endReason?: string;
}

/** A discovered Gorilator server + the realm it's currently (or last) running. */
export interface ServerStatus {
  name: string;
  url: string;
  pubkey: string;
  totalRealms: number;
  maxRounds: number;
  currentRealm: RealmInfo | null;
  lastRealm: RealmInfo | null;
  updatedAt: number;
}

/** A ServerStatus enriched from a live /api/status poll (fetchedAt = poll time). */
export type FreshStatus = ServerStatus & { fetchedAt: number };

export interface Profile {
  name?: string;
  picture?: string;
  nip05?: string;
}

export type LiveStatus = "connecting" | "live";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseRealm(r: unknown): RealmInfo | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  return {
    id: String(o.id ?? ""),
    startedAt: num(o.startedAt),
    endedAt: o.endedAt != null ? num(o.endedAt) : undefined,
    wave: num(o.wave),
    players: o.players != null ? num(o.players) : undefined,
    peakPlayers: o.peakPlayers != null ? num(o.peakPlayers) : undefined,
    npubs: strList(o.npubs),
    endReason: o.endReason != null ? String(o.endReason) : undefined,
  };
}

/** Build a ServerStatus from the JSON shared by the discovery event content and the
 *  server's /api/status endpoint. `pubkey` is the authoritative server identity. */
function statusFromContent(
  c: Record<string, unknown>,
  pubkey: string,
  updatedAtFallback: number,
): ServerStatus {
  return {
    pubkey,
    name: String(c.name ?? "Gorilator Server"),
    url: typeof c.url === "string" ? c.url : "",
    totalRealms: num(c.totalRealms),
    maxRounds: num(c.maxRounds),
    currentRealm: parseRealm(c.currentRealm),
    lastRealm: parseRealm(c.lastRealm),
    updatedAt: num(c.updatedAt) || updatedAtFallback,
  };
}

function parseServer(ev: RawEvent): ServerStatus | null {
  // Only the addressable discovery event (d=gorilator-server); ignore other 30078s.
  const isDiscovery = ev.tags.some((t) => t[0] === "d" && t[1] === DISCOVERY_D);
  if (!isDiscovery) return null;
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  // The author key is the server's real identity — trust it over content.pubkey.
  return statusFromContent(c, ev.pubkey, ev.created_at * 1000);
}

/**
 * Live-subscribe to every Gorilator server over the relays. Discovery events are
 * parameterized-replaceable, so we keep the freshest per server pubkey and update
 * in place as new events arrive. `status` flips to "live" on end-of-stored-events.
 */
export function useGorilatorServers(): { servers: ServerStatus[]; status: LiveStatus } {
  const [byPubkey, setByPubkey] = useState<Record<string, ServerStatus>>({});
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    const pool = new SimplePool();
    const sub = pool.subscribeMany(RELAYS, { kinds: [DISCOVERY_KIND], "#t": ["gorilator"] }, {
      onevent(ev) {
        const parsed = parseServer(ev);
        if (!parsed) return;
        setByPubkey((prev) => {
          const existing = prev[parsed.pubkey];
          if (existing && existing.updatedAt >= parsed.updatedAt) return prev;
          return { ...prev, [parsed.pubkey]: parsed };
        });
      },
      oneose() {
        setStatus("live");
      },
    });
    return () => {
      sub.close();
      pool.close(RELAYS);
    };
  }, []);

  const servers = useMemo(() => Object.values(byPubkey), [byPubkey]);
  return { servers, status };
}

/** Health of a server we can reach over HTTP (those advertising a play URL). */
export interface ServerHealth {
  data?: FreshStatus; // freshest /api/status payload, once we've fetched it
  offline: boolean; // a status check failed → treat the server as down
}

const STALE_AFTER_MS = 3 * 60_000; // no discovery update for this long → start checking
const RECHECK_EVERY_MS = 5 * 60_000; // ...then re-request /api/status on this interval
const HEALTH_TICK_MS = 15_000; // supervisor granularity (decides what's due)
const FETCH_TIMEOUT_MS = 6_000;

async function fetchStatus(url: string): Promise<FreshStatus | null> {
  let endpoint: string;
  try {
    endpoint = new URL("/api/status", url).toString();
  } catch {
    return null; // malformed URL
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, { signal: ctrl.signal });
    if (!res.ok) return null;
    const c = (await res.json()) as Record<string, unknown>;
    const pubkey = typeof c.pubkey === "string" ? c.pubkey : url;
    return { ...statusFromContent(c, pubkey, Date.now()), fetchedAt: Date.now() };
  } catch {
    return null; // offline / CORS / bad JSON
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health-check the servers that advertise a play URL. A server is trusted while its
 * Nostr discovery event keeps updating; once it has gone quiet for 3 minutes we poll
 * `<url>/api/status` (always-current, vs the ~30-min event cadence) every 5 minutes.
 * A failed check marks the server offline and stops its checks; a newer discovery
 * event revives it. CORS is open (see REALMS.md). Returns a map keyed by play URL.
 */
export function useServerHealth(servers: ServerStatus[]): Record<string, ServerHealth> {
  const [health, setHealth] = useState<Record<string, ServerHealth>>({});
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const healthRef = useRef(health);
  healthRef.current = health;
  // Per-URL bookkeeping (no re-render): when we last saw an update, when we last checked.
  const bk = useRef<Record<string, { lastUpdate: number; lastCheck: number }>>({});

  const urlKey = useMemo(
    () => Array.from(new Set(servers.map((s) => s.url).filter(Boolean))).sort().join("\n"),
    [servers],
  );

  useEffect(() => {
    let cancelled = false;

    const check = async (url: string) => {
      const data = await fetchStatus(url);
      if (cancelled) return;
      if (data) {
        const entry = bk.current[url];
        if (entry) entry.lastUpdate = Date.now();
        setHealth((prev) => ({ ...prev, [url]: { data, offline: false } }));
      } else {
        // offline → mark it; the supervisor then stops checking it (interval removed)
        setHealth((prev) => ({ ...prev, [url]: { data: prev[url]?.data, offline: true } }));
      }
    };

    const tick = () => {
      const now = Date.now();
      for (const s of serversRef.current) {
        const url = s.url;
        if (!url) continue;
        let entry = bk.current[url];
        if (!entry) entry = bk.current[url] = { lastUpdate: s.updatedAt, lastCheck: 0 };
        // A newer discovery event counts as an update — and revives an offline server.
        if (s.updatedAt > entry.lastUpdate) {
          entry.lastUpdate = s.updatedAt;
          if (healthRef.current[url]?.offline) {
            setHealth((prev) => ({ ...prev, [url]: { ...prev[url], offline: false } }));
          }
        }
        if (healthRef.current[url]?.offline) continue; // stopped checking offline servers
        const stale = now - entry.lastUpdate > STALE_AFTER_MS;
        const due = now - entry.lastCheck >= RECHECK_EVERY_MS;
        if (stale && due) {
          entry.lastCheck = now;
          void check(url);
        }
      }
    };

    tick();
    const id = setInterval(tick, HEALTH_TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [urlKey]);

  return health;
}

/**
 * Resolve kind-0 metadata (name/avatar) for a set of player pubkeys. Re-subscribes
 * when the set grows; keeps the newest metadata per author (by created_at).
 */
export function useProfiles(pubkeys: string[]): Record<string, Profile> {
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const tsRef = useRef<Record<string, number>>({});
  const key = useMemo(() => Array.from(new Set(pubkeys)).sort().join(","), [pubkeys]);

  useEffect(() => {
    const authors = key ? key.split(",") : [];
    if (authors.length === 0) return;
    const pool = new SimplePool();
    const sub = pool.subscribeMany(RELAYS, { kinds: [PROFILE_KIND], authors }, {
      onevent(ev) {
        if ((tsRef.current[ev.pubkey] ?? 0) >= ev.created_at) return;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(ev.content) as Record<string, unknown>;
        } catch {
          return;
        }
        tsRef.current[ev.pubkey] = ev.created_at;
        const name = (m.display_name as string) || (m.name as string) || undefined;
        setProfiles((prev) => ({
          ...prev,
          [ev.pubkey]: {
            name: name || undefined,
            picture: typeof m.picture === "string" ? m.picture : undefined,
            nip05: typeof m.nip05 === "string" ? m.nip05 : undefined,
          },
        }));
      },
    });
    return () => {
      sub.close();
      pool.close(RELAYS);
    };
  }, [key]);

  return profiles;
}
