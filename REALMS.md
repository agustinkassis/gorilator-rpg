# Realms — server discovery & live stats over Nostr + HTTP

Every Gorilator server announces itself and the game it's currently running so
external apps (server browsers, dashboards, bots) can discover servers and track
play **without talking to the game protocol** — over public **Nostr relays** and a
small **HTTP API**.

## Concepts

- **Server** — one running Gorilator backend, identified by its **Nostr public
  key** (`NOSTR_NSEC` → pubkey). It has a name and a play URL.
- **Realm** — one game. A new game is a new realm. A realm **starts** when a player
  is in the room and alive (and no realm is active), and **ends** when **La Crypta
  (the home) falls** (which also wipes every player back to level 1) **or the room
  empties**. The server numbers them and counts them for life.
- **Round / wave** — within a realm, the goblin horde attacks in escalating waves.
  `maxRounds` is the highest wave ever reached on this server (its record).

Lifetime totals (`totalRealms`, `maxRounds`) persist in a local file
(`SERVER_STATS_FILE`, default `./.server-realms.json`) and are **mirrored into the
Nostr event**, so they survive a lost file (the server reconciles from the last
published event on boot — keep `NOSTR_NSEC` stable for this to work).

---

## 1. Nostr discovery event

The server publishes one **parameterized-replaceable** (NIP‑33 / addressable) event
and **updates it in place** — on every realm start/end and **every 30 minutes**.

| field    | value                                                  |
| -------- | ------------------------------------------------------ |
| `kind`   | `30078` (app-specific replaceable data)                |
| `pubkey` | the server's pubkey (its identity / reference)         |
| `d` tag  | `gorilator-server`                                     |
| address  | `30078:<server-pubkey>:gorilator-server`               |

### Tags (filterable without parsing content)

```
["d", "gorilator-server"]
["t", "gorilator"]          # discover EVERY Gorilator server: filter {kinds:[30078], "#t":["gorilator"]}
["name", "<server name>"]
["version", "<server version>"]
["r", "<play url>"]
["realms", "<totalRealms>"]
["max_rounds", "<maxRounds>"]
["status", "playing" | "idle"]
```

### Content (JSON)

```jsonc
{
  "v": 1,
  "name": "Gorilator NYC",
  "version": "0.1.3",                    // server package version
  "url": "https://game.example.com",     // where to play
  "pubkey": "<hex server pubkey>",
  "totalRealms": 142,                    // realms ever started here
  "maxRounds": 23,                       // best wave ever reached
  "currentRealm": {                      // null when idle
    "id": "lt7x2k-9",
    "startedAt": 1730000000000,          // epoch ms
    "wave": 6,                           // current wave
    "players": 3,                        // peak players this realm
    "npubs": ["<hex>", "<hex>"]          // Nostr identities that joined (hex; npub-encode to display)
  },
  "lastRealm": {                         // the previous realm, when known
    "id": "lt6p0a-8", "startedAt": 0, "endedAt": 0,
    "wave": 11, "npubs": ["<hex>"], "peakPlayers": 4,
    "endReason": "home-fell" | "abandoned"
  },
  "updatedAt": 1730000000000
}
```

### Discover & track from any Nostr client

```js
import { SimplePool } from "nostr-tools/pool";
const pool = new SimplePool();
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band", "wss://relay.primal.net"];

// All Gorilator servers + live subscribe for updates (events replace in place):
pool.subscribeMany(RELAYS, [{ kinds: [30078], "#t": ["gorilator"] }], {
  onevent(ev) {
    const s = JSON.parse(ev.content);
    console.log(s.name, "·", s.totalRealms, "realms · best wave", s.maxRounds,
      "·", s.currentRealm ? `playing wave ${s.currentRealm.wave} (${s.currentRealm.players}p)` : "idle",
      "·", s.url);
  },
});

// One specific server:
//   pool.get(RELAYS, { kinds:[30078], authors:[serverPubkey], "#d":["gorilator-server"] })
```

> The Nostr event refreshes every 30 min (and on realm boundaries). For **second-by-second**
> data (e.g. who just joined), use the HTTP API below.

---

## 2. HTTP API (realtime)

Served by the game server on its HTTP port (same origin as `/colyseus`). CORS is open.

### `GET /api/status`

Server identity, lifetime stats, and the live realm — the same payload as the Nostr
event content (always current):

```jsonc
{
  "v": 1, "name": "...", "version": "0.1.3", "url": "...", "pubkey": "...",
  "totalRealms": 142, "maxRounds": 23,
  "currentRealm": { "id": "...", "startedAt": 0, "wave": 6, "players": 3, "npubs": ["..."] },
  "lastRealm": { ... },
  "updatedAt": 1730000000000
}
```

### `GET /api/realm`

The current realm to **join** (or `null`), with the players already in it:

```jsonc
{
  "joinUrl": "https://game.example.com",
  "current": { "id": "...", "startedAt": 0, "wave": 6, "players": 3, "npubs": ["<hex>"] },
  "last": { "id": "...", "wave": 11, "endReason": "home-fell", "npubs": ["<hex>"], ... }
}
```

`npubs` are **hex** pubkeys — NIP‑19 `npubEncode` them for display.

---

## 3. Configuration

| env                 | default                          | meaning                                          |
| ------------------- | -------------------------------- | ------------------------------------------------ |
| `NOSTR_NSEC`        | ephemeral (per boot)             | the server's identity key — **set this** so the discovery event is stable/updatable |
| `SERVER_NAME`       | `Gorilator Server`               | display name in the event + API                  |
| `PLAY_URL`          | `https://$CLIENT_HOSTNAME`       | public URL players join at                       |
| `SERVER_STATS_FILE` | `./.server-realms.json`          | where `totalRealms` / `maxRounds` persist        |

Relays published to: `relay.damus.io`, `nos.lol`, `relay.nostr.band`, `relay.primal.net`.

## Realm lifecycle (summary)

```
room empty ──player joins & alive──▶ REALM STARTED (totalRealms++)
   ▲                                      │  accumulates: wave (→maxRounds), joined npubs, peak players
   │                                      ▼
   └──────── REALM ENDED ◀── La Crypta falls (home-fell, wipes everyone)  OR  room empties (abandoned)
```

A wipe ends the realm and a fresh one begins as the players respawn — so each
"survive as long as you can" run is one realm.
