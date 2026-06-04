import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, Github, Play, Radio } from "lucide-react";
import { npubEncode } from "nostr-tools/nip19";
import {
  ACTIVITY_WINDOWS,
  dedupeByUrl,
  useGorilatorServers,
  useProfiles,
  useServerFlags,
  useServerHealth,
  useServerPings,
  type Ping,
  type Profile,
  type ServerStatus,
} from "./realms";
import { shortNpub } from "./nostr";
import "./styles.css";
import "./stats.css";

const repoUrl = "https://github.com/agustinkassis/gorilator-rpg";

/** Ticking clock so "updated 3m ago" / realm durations stay fresh. */
function useNow(intervalMs: number): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Deterministic hue from a hex pubkey, so each npub gets a stable color. */
function hueFromPubkey(pk: string): number {
  return (parseInt(pk.slice(0, 8), 16) || 0) % 360;
}

/** Per-npub avatar: the kind-0 picture when present, else a stable gradient with a
 *  gorilla glyph. Links out to the player's Nostr profile. */
function Avatar({
  pubkey,
  profile,
  size = 44,
  live,
}: {
  pubkey: string;
  profile?: Profile;
  size?: number;
  live?: boolean;
}) {
  const npub = useMemo(() => npubEncode(pubkey), [pubkey]);
  const [broken, setBroken] = useState(false);
  const showImg = !!profile?.picture && !broken;
  const hue = hueFromPubkey(pubkey);
  return (
    <a
      className={`avatar ${live ? "live" : ""}`}
      href={`https://njump.me/${npub}`}
      target="_blank"
      rel="noreferrer"
      title={profile?.name || shortNpub(npub)}
      style={{ width: size, height: size }}
    >
      {showImg ? (
        <img src={profile!.picture} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span
          className="avatarFallback"
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 68% 46%), hsl(${(hue + 42) % 360} 64% 30%))`,
            fontSize: size * 0.5,
          }}
        >
          🦍
        </span>
      )}
    </a>
  );
}

function StatCard({ value, label, sub }: { value: number | string; label: string; sub?: string }) {
  return (
    <div className="statCard">
      <span className="statValue">{value}</span>
      <span className="statLabel">{label}</span>
      {sub && <span className="statSub">{sub}</span>}
    </div>
  );
}

/** Latency cell: round-trip ms to /healthz, colour-coded; em-dash when unknown. */
function PingCell({ ping, offline }: { ping?: Ping | null; offline: boolean }) {
  if (offline) return <span className="muted small">—</span>;
  if (ping === undefined) return <span className="muted small">…</span>;
  if (ping === null) return <span className="pingBad" title="No response">timeout</span>;
  const cls = ping.ms < 80 ? "pingGood" : ping.ms < 200 ? "pingOk" : "pingBad";
  return (
    <span className={cls} title="Round-trip to /healthz">
      {ping.ms} ms
    </span>
  );
}

function ServerRow({
  server,
  profiles,
  now,
  ping,
  flag,
}: {
  server: ServerStatus & { fetchedAt?: number; offline?: boolean };
  profiles: Record<string, Profile>;
  now: number;
  ping?: Ping | null;
  flag?: string;
}) {
  const offline = !!server.offline;
  const r = offline ? null : server.currentRealm;
  const npubs = r?.npubs ?? [];
  const shown = npubs.slice(0, 4);
  const extra = npubs.length - shown.length;
  return (
    <tr className={offline ? "offline" : r ? "playing" : ""}>
      <td className="colServer">
        {flag && (
          <span className="srvFlag" aria-hidden>
            {flag}
          </span>
        )}
        <span className="srvName">{server.name}</span>
        {offline ? (
          <span className="offlineTag">● offline</span>
        ) : server.fetchedAt ? (
          <span className="freshTag" title="Live from /api/status">
            ● live
          </span>
        ) : (
          <span className="muted small">updated {ago(server.updatedAt, now)}</span>
        )}
      </td>
      <td>
        <span className={`statusBadge ${offline ? "offline" : r ? "playing" : "idle"}`}>
          {offline ? "Offline" : r ? "Playing" : "Idle"}
        </span>
      </td>
      <td className="num">{server.totalRealms}</td>
      <td className="num">{server.maxRounds}</td>
      <td className="num">{r ? r.wave : "—"}</td>
      <td className="num colPing">
        {server.url ? <PingCell ping={ping} offline={offline} /> : <span className="muted small">—</span>}
      </td>
      <td className="colPlayers">
        {r ? (
          <div className="playersCell">
            <span className="pcount">{r.players ?? npubs.length}</span>
            {shown.length > 0 && (
              <div className="avatarStack">
                {shown.map((pk) => (
                  <Avatar key={pk} pubkey={pk} profile={profiles[pk]} live size={28} />
                ))}
                {extra > 0 && <span className="avatarMore">+{extra}</span>}
              </div>
            )}
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="colPlay">
        {!offline && server.url ? (
          <a className="joinBtn" href={server.url} target="_blank" rel="noreferrer">
            <Play size={15} fill="currentColor" />
            <span>Play</span>
          </a>
        ) : (
          <span className="muted small">—</span>
        )}
      </td>
    </tr>
  );
}

/** Most recent sign of life from a server: a live /api/status poll or its newest event. */
function lastActivity(s: { updatedAt: number; fetchedAt?: number }): number {
  return Math.max(s.updatedAt, s.fetchedAt ?? 0);
}

function Stats() {
  const { servers, status } = useGorilatorServers();
  const now = useNow(1000);

  // "Active in the last…" filter — default to 48h. Index into ACTIVITY_WINDOWS.
  const [windowIdx, setWindowIdx] = useState(3);
  const windowMs = ACTIVITY_WINDOWS[windowIdx].ms;

  // Health-check servers that advertise a play URL: enrich with their live /api/status
  // and flag the ones a check found offline. HTTP wins when reachable; we keep the
  // relay-proven pubkey as the identity.
  const health = useServerHealth(servers);
  const merged = useMemo<(ServerStatus & { fetchedAt?: number; offline?: boolean })[]>(
    () =>
      dedupeByUrl(
        servers.map((s) => {
          const h = s.url ? health[s.url] : undefined;
          const base = h?.data ? { ...h.data, pubkey: s.pubkey } : s;
          return { ...base, offline: h?.offline ?? false };
        }),
      ),
    [servers, health],
  );

  // Keep only servers whose last activity falls inside the selected window.
  const active = useMemo(
    () => merged.filter((s) => now - lastActivity(s) <= windowMs),
    [merged, now, windowMs],
  );

  const playing = useMemo(() => active.filter((s) => s.currentRealm && !s.offline), [active]);

  const totals = useMemo(() => {
    const totalRealms = active.reduce((n, s) => n + s.totalRealms, 0);
    const bestWave = active.reduce((n, s) => Math.max(n, s.maxRounds), 0);
    const livePlayers = playing.reduce(
      (n, s) => n + (s.currentRealm?.players ?? s.currentRealm?.npubs.length ?? 0),
      0,
    );
    return { totalRealms, bestWave, livePlayers };
  }, [active, playing]);

  const livePubkeys = useMemo(() => {
    const set = new Set<string>();
    playing.forEach((s) => s.currentRealm?.npubs.forEach((p) => set.add(p)));
    return set;
  }, [playing]);

  const allPubkeys = useMemo(() => {
    const set = new Set<string>();
    active.forEach((s) => {
      s.currentRealm?.npubs.forEach((p) => set.add(p));
      s.lastRealm?.npubs.forEach((p) => set.add(p));
    });
    return [...set];
  }, [active]);

  const profiles = useProfiles(allPubkeys);

  // Live latency + country flag for every server that advertises a play URL.
  const serverUrls = useMemo(() => active.map((s) => s.url).filter(Boolean), [active]);
  const pings = useServerPings(serverUrls);
  const flags = useServerFlags(serverUrls);

  const sortedServers = useMemo(
    () =>
      [...active].sort((a, b) => {
        // Offline servers sink to the bottom; joinable (Play button) on top; then
        // most recently updated first.
        const ao = a.offline ? 1 : 0;
        const bo = b.offline ? 1 : 0;
        if (ao !== bo) return ao - bo;
        const au = a.url && !a.offline ? 1 : 0;
        const bu = b.url && !b.offline ? 1 : 0;
        if (au !== bu) return bu - au;
        return b.updatedAt - a.updatedAt;
      }),
    [active],
  );

  // Players currently in a live realm — that's who we surface in the wall.
  const onlinePlayers = useMemo(() => [...livePubkeys], [livePubkeys]);

  return (
    <main className="stats">
      <header className="statsNav">
        <a className="brand" href="/">
          GORILATOR
        </a>
        <div className="statsNavRight">
          <span className={`livePill ${status}`}>
            <Radio size={14} />
            {status === "live" ? "Live" : "Connecting…"}
          </span>
          <a className="ghostBtn" href="/">
            <ArrowLeft size={16} />
            <span>Home</span>
          </a>
        </div>
      </header>

      <section className="statsHero">
        <p className="eyebrow">
          <span className="eyebrowDot" />
          Straight off the Nostr relays
        </p>
        <h1>Live Stats</h1>
        <p className="statsLede">
          Servers, realms and the gorillas defending them — subscribed in realtime.
        </p>
      </section>

      <section className="activityFilter" aria-label="Filter by last activity">
        <span className="filterLabel">Active in the last</span>
        <div className="filterSeg" role="tablist">
          {ACTIVITY_WINDOWS.map((w, i) => (
            <button
              key={w.label}
              role="tab"
              aria-selected={i === windowIdx}
              className={`segBtn ${i === windowIdx ? "active" : ""}`}
              onClick={() => setWindowIdx(i)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </section>

      <section className="statGrid">
        <StatCard value={active.length} label="Servers" sub={`${playing.length} playing`} />
        <StatCard value={playing.length} label="Live realms" />
        <StatCard value={totals.livePlayers} label="Players in play" />
        <StatCard value={totals.totalRealms} label="Realms played" sub="all time" />
        <StatCard value={totals.bestWave} label="Best wave" sub="record" />
        <StatCard value={allPubkeys.length} label="Players seen" />
      </section>

      <section className="statsSection">
        <h2>Online players</h2>
        <p className="muted sectionSub">
          Defenders currently in a live realm with Nostr — others defend anonymously.
        </p>
        {onlinePlayers.length === 0 ? (
          <p className="muted">
            {status === "live" ? "No identified players online right now." : "Listening for players…"}
          </p>
        ) : (
          <div className="avatarWall">
            {onlinePlayers.map((pk) => (
              <div className="playerChip live" key={pk}>
                <Avatar pubkey={pk} profile={profiles[pk]} live />
                <span className="playerName">{profiles[pk]?.name || shortNpub(npubEncode(pk))}</span>
                <span className="liveTag">in play</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="statsSection">
        <h2>Servers</h2>
        {active.length === 0 ? (
          <p className="muted">
            {status !== "live"
              ? "Searching relays…"
              : merged.length === 0
                ? "No Gorilator servers are broadcasting right now."
                : `No servers active in the last ${ACTIVITY_WINDOWS[windowIdx].label}.`}
          </p>
        ) : (
          <div className="serverTableWrap">
            <table className="serverTable">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Status</th>
                  <th className="num">Realms</th>
                  <th className="num">Best wave</th>
                  <th className="num">Wave</th>
                  <th className="num">Ping</th>
                  <th>Players</th>
                  <th aria-label="Join" />
                </tr>
              </thead>
              <tbody>
                {sortedServers.map((s) => (
                  <ServerRow
                    key={s.pubkey}
                    server={s}
                    profiles={profiles}
                    now={now}
                    ping={s.url ? pings[s.url] : undefined}
                    flag={s.url ? flags[s.url] : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="footer">
        <a className="brand small" href="/">
          GORILATOR
        </a>
        <div className="footerLinks">
          <a href={repoUrl} target="_blank" rel="noreferrer">
            <Github size={16} /> Source
          </a>
          <a href="/">
            <Play size={14} fill="currentColor" /> Home
          </a>
        </div>
        <p className="footerNote">Live data over Nostr · kind 30078 discovery + kind 0 profiles</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Stats />);
