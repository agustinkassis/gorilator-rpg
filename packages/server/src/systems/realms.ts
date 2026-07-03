import "./webcrypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent } from "nostr-tools/pure";
import type { PlayerSaveRealm } from "@rpg/shared";
import { getServerIdentity } from "./nostrIdentity";
import { activeScenarioName } from "./scenario";

// Node (≤20) has no global WebSocket, which SimplePool needs — inject `ws`.
useWebSocketImplementation(WebSocket);

/** Public relays the server publishes its discovery/status event to. */
const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
];

// The server publishes a single parameterized-replaceable (NIP-33 addressable)
// event so external Nostr apps can DISCOVER this server + track the realm being
// played. Address = (kind, server pubkey, d-tag); republishing replaces it.
const SERVER_STATUS_KIND = 30078; // parameterized replaceable (app-specific data)
const SERVER_STATUS_DTAG = "gorilator-server"; // stable identifier for this app's server event
const APP_TAG = "gorilator"; // ["t","gorilator"] → apps can find every Gorilator server

const PUBLISH_INTERVAL_MS = 30 * 60 * 1000; // republish the status every 30 minutes
const CONTENT_VERSION = 1;

/** One connected Nostr player in a snapshot (for the leaderboard). */
export interface RealmPlayer {
  pubkey: string; // hex nostr public key
  name: string; // display name from the profile
  level: number; // current level this realm
  alive: boolean; // hp > 0 and not DEAD — i.e. has "survived" to the current wave
}

/** Live inputs the room hands the tracker each update. */
export interface RealmSnapshot {
  connected: number; // players currently in the room
  live: number; // players currently alive (hp > 0, not DEAD)
  wave: number; // the room's current wave number
  npubs: string[]; // hex pubkeys of currently-connected Nostr players
  players: RealmPlayer[]; // per-player stats for the leaderboard (Nostr players only)
}

/** A leaderboard entry: an npub's best run on this server. */
interface LeaderEntry {
  pubkey: string; // hex nostr public key
  name: string; // most recent display name seen for this npub
  level: number; // highest level ever reached
  wave: number; // highest wave ever survived (reached while alive)
  updatedAt: number; // epoch ms of the last improvement (tiebreaker: earlier wins)
}

/** A single game ("realm"): from first live defender to La Crypta falling (or the
 *  room emptying). `npubs` accumulates every Nostr identity that joined it. */
interface ActiveRealm {
  id: string;
  startedAt: number; // epoch ms
  wave: number; // peak wave reached this realm
  npubs: Set<string>; // union of Nostr pubkeys (hex) seen this realm
  peakPlayers: number; // max concurrent players
}

interface EndedRealm {
  id: string;
  startedAt: number;
  endedAt: number;
  wave: number;
  npubs: string[];
  peakPlayers: number;
  endReason: "home-fell" | "abandoned";
}

interface PersistStats {
  totalRealms: number; // realms ever started on this server
  maxRounds: number; // highest wave ever reached in a single realm
}

/**
 * Tracks the realm being played and the server's lifetime stats, exposes them over
 * HTTP (realtime) and publishes them to Nostr (every 30 min + on realm boundaries)
 * as an updatable, server-signed discovery event. See REALMS.md.
 */
class RealmTracker {
  private readonly name = process.env.SERVER_NAME?.trim() || "Gorilator Server";
  private readonly url = resolvePlayUrl();
  private readonly version = resolveServerVersion();
  private readonly statsFile =
    process.env.SERVER_STATS_FILE?.trim() || join(process.cwd(), ".server-realms.json");

  private stats: PersistStats = { totalRealms: 0, maxRounds: 0 };
  private leaders = new Map<string, LeaderEntry>(); // npub → best run (the leaderboard)
  private current: ActiveRealm | null = null;
  private last: EndedRealm | null = null; // the most recently ended realm (for the API)
  private seq = 0;
  private cycleSeed: { seed: number; source: string } | null = null; // the live cycle's RNG seed

  private pool: SimplePool | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  /** Load persisted stats, reconcile with the last published event, then start the
   *  30-minute publish loop. Idempotent. */
  init(): void {
    if (this.started) return;
    this.started = true;
    this.loadStats();
    void this.reconcileFromNostr(); // recover totals if the local file was lost (e.g. fresh deploy)
    this.publishTimer = setInterval(() => void this.publish(), PUBLISH_INTERVAL_MS);
    void this.publish(); // announce presence at startup
    console.log(
      `[realm] tracker up — "${this.name}" · ${this.stats.totalRealms} realms · best wave ${this.stats.maxRounds}`,
    );
  }

  /** Per-update from the room (caller may throttle): start/end realms + accumulate. */
  update(s: RealmSnapshot): void {
    if (!this.current && s.live >= 1) this.startRealm(s);
    if (!this.current) return;

    for (const n of s.npubs) this.current.npubs.add(n);
    for (const p of s.players) this.recordLeader(p, s.wave);
    if (s.wave > this.current.wave) this.current.wave = s.wave;
    if (s.connected > this.current.peakPlayers) this.current.peakPlayers = s.connected;
    if (this.current.wave > this.stats.maxRounds) {
      this.stats.maxRounds = this.current.wave;
      this.scheduleSave();
    }

    // A realm ends when the last player leaves the room (abandoned), or when La
    // Crypta falls — but the wipe rebuilds the home in the same tick, so that end is
    // signalled explicitly via homeFell() rather than observed here.
    if (s.connected === 0) this.endRealm("abandoned");
  }

  /** La Crypta fell (the wipe) → end the current realm. Called from the room. */
  homeFell(): void {
    this.endRealm("home-fell");
  }

  /** Note a Nostr identity joining the live realm (snappier than the next snapshot). */
  noteNpub(pubkey: string): void {
    if (pubkey && this.current) this.current.npubs.add(pubkey);
  }

  /** Record the live realm cycle's RNG seed (engineering.md §3 — logged + queryable
   *  via /api/status so any run can be reproduced with GORILATOR_SEED). */
  noteSeed(seed: number, source: string): void {
    this.cycleSeed = { seed, source };
  }

  /** Fold one player's current run into their all-time-best leaderboard entry.
   *  "Wave survived" only counts while alive — a dead player hasn't survived the
   *  wave they died on. Tracks the highest level + highest wave seen per npub. */
  private recordLeader(p: RealmPlayer, wave: number): void {
    if (!p.pubkey) return;
    const prev = this.leaders.get(p.pubkey);
    const level = Math.max(prev?.level ?? 0, p.level);
    const bestWave = Math.max(prev?.wave ?? 0, p.alive ? wave : 0);
    const name = p.name || prev?.name || "";
    if (prev && level === prev.level && bestWave === prev.wave && name === prev.name) return;
    this.leaders.set(p.pubkey, { pubkey: p.pubkey, name, level, wave: bestWave, updatedAt: Date.now() });
    this.scheduleSave();
  }

  /** The leaderboard: best npubs ranked by level, then wave survived (earlier
   *  achiever breaks ties). Capped at `limit`. */
  private topPlayers(limit = 10): LeaderEntry[] {
    return [...this.leaders.values()]
      .sort((a, b) => b.level - a.level || b.wave - a.wave || a.updatedAt - b.updatedAt)
      .slice(0, limit);
  }

  private startRealm(s: RealmSnapshot): void {
    this.seq += 1;
    this.stats.totalRealms += 1;
    this.current = {
      id: `${Date.now().toString(36)}-${this.seq}`,
      startedAt: Date.now(),
      wave: s.wave,
      npubs: new Set(s.npubs),
      peakPlayers: s.connected,
    };
    this.scheduleSave();
    void this.publish();
    console.log(`[realm] started ${this.current.id} (total realms: ${this.stats.totalRealms})`);
  }

  private endRealm(reason: EndedRealm["endReason"]): void {
    if (!this.current) return;
    const r = this.current;
    this.last = {
      id: r.id,
      startedAt: r.startedAt,
      endedAt: Date.now(),
      wave: r.wave,
      npubs: [...r.npubs],
      peakPlayers: r.peakPlayers,
      endReason: reason,
    };
    this.current = null;
    this.scheduleSave();
    void this.publish();
    console.log(`[realm] ended ${r.id} — ${reason} at wave ${r.wave}`);
  }

  // ---- API snapshots (realtime) ----

  /** Full status payload (also the body of the Nostr event content). */
  status(): Record<string, unknown> {
    const { pubkey } = getServerIdentity();
    return {
      v: CONTENT_VERSION,
      name: this.name,
      version: this.version,
      url: this.url,
      pubkey,
      totalRealms: this.stats.totalRealms,
      maxRounds: this.stats.maxRounds,
      topPlayers: this.topPlayers(),
      currentRealm: this.current
        ? {
            id: this.current.id,
            startedAt: this.current.startedAt,
            wave: this.current.wave,
            players: this.current.peakPlayers,
            npubs: [...this.current.npubs],
          }
        : null,
      cycleSeed: this.cycleSeed,
      activeScenario: activeScenarioName(),
      lastRealm: this.last,
      updatedAt: Date.now(),
    };
  }

  /** Current realm to join (or null), plus the join URL + players already in it. */
  realm(): Record<string, unknown> {
    return {
      joinUrl: this.url,
      current: this.current
        ? {
            id: this.current.id,
            startedAt: this.current.startedAt,
            wave: this.current.wave,
            players: this.current.peakPlayers,
            npubs: [...this.current.npubs],
          }
        : null,
      last: this.last,
    };
  }

  /** Realm metadata embedded into per-player Nostr saves/events. */
  playerSaveRealm(): PlayerSaveRealm | null {
    return this.current
      ? {
          id: this.current.id,
          startedAt: this.current.startedAt,
          wave: this.current.wave,
        }
      : null;
  }

  // ---- persistence ----

  private loadStats(): void {
    try {
      if (existsSync(this.statsFile)) {
        const raw = JSON.parse(readFileSync(this.statsFile, "utf8"));
        if (Number.isFinite(raw?.totalRealms)) this.stats.totalRealms = raw.totalRealms;
        if (Number.isFinite(raw?.maxRounds)) this.stats.maxRounds = raw.maxRounds;
        if (Array.isArray(raw?.leaders)) {
          for (const e of raw.leaders) {
            if (typeof e?.pubkey !== "string" || !e.pubkey) continue;
            this.leaders.set(e.pubkey, {
              pubkey: e.pubkey,
              name: typeof e.name === "string" ? e.name : "",
              level: Number.isFinite(e.level) ? e.level : 0,
              wave: Number.isFinite(e.wave) ? e.wave : 0,
              updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : 0,
            });
          }
        }
      }
    } catch (err) {
      console.warn("[realm] could not read stats file", err);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        // Persist only the top runs — the leaderboard, not every npub ever seen.
        const payload = { ...this.stats, leaders: this.topPlayers(100) };
        writeFileSync(this.statsFile, JSON.stringify(payload));
      } catch (err) {
        console.warn("[realm] could not write stats file", err);
      }
    }, 1000);
  }

  // ---- nostr ----

  private getPool(): SimplePool {
    if (!this.pool) this.pool = new SimplePool();
    return this.pool;
  }

  /** Sign + publish the server-status event (replaceable). Best-effort + timed out. */
  private async publish(): Promise<void> {
    try {
      const { sk } = getServerIdentity();
      const status = this.status();
      const event = finalizeEvent(
        {
          kind: SERVER_STATUS_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["d", SERVER_STATUS_DTAG],
            ["t", APP_TAG],
            ["name", this.name],
            ["version", this.version],
            ["r", this.url],
            ["realms", String(this.stats.totalRealms)],
            ["max_rounds", String(this.stats.maxRounds)],
            ["status", this.current ? "playing" : "idle"],
          ],
          content: JSON.stringify(status),
        },
        sk,
      );
      await raceTimeout(Promise.allSettled(this.getPool().publish(RELAYS, event)), 4000);
    } catch (err) {
      console.warn("[realm] publish failed", err);
    }
  }

  /** On startup, pull the last published event so totals survive a lost stats file. */
  private async reconcileFromNostr(): Promise<void> {
    try {
      const { pubkey } = getServerIdentity();
      const ev = (await raceTimeout(
        this.getPool().get(RELAYS, {
          kinds: [SERVER_STATUS_KIND],
          authors: [pubkey],
          "#d": [SERVER_STATUS_DTAG],
        }),
        3000,
      )) as { content: string } | null;
      if (!ev) return;
      const prev = JSON.parse(ev.content);
      if (Number.isFinite(prev?.totalRealms))
        this.stats.totalRealms = Math.max(this.stats.totalRealms, prev.totalRealms);
      if (Number.isFinite(prev?.maxRounds))
        this.stats.maxRounds = Math.max(this.stats.maxRounds, prev.maxRounds);
      this.scheduleSave();
    } catch {
      /* relays unreachable — keep the local/file totals */
    }
  }
}

/** The play URL: PLAY_URL wins; legacy CLIENT_HOSTNAME fallback is kept for old installs. */
function resolvePlayUrl(): string {
  const explicit = process.env.PLAY_URL?.trim();
  if (explicit) return explicit;
  const host = process.env.CLIENT_HOSTNAME?.trim();
  return host ? `https://${host}` : "";
}

/** Read the server package version from package.json in both tsx src/ and dist/. */
function resolveServerVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** Server-wide singleton (the game runs a single room). */
export const realmTracker = new RealmTracker();
