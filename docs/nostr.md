# Nostr integration & events

Nostr is used for three things: **optional login** (prove who you are), **server-owned
progress saves** (your character persists across sessions/servers), and **server +
realm discovery** (external apps can list servers and the games being played). All of
it is **optional** — anonymous name-only play works fully.

The server has its own Nostr identity (`NOSTR_NSEC` → pubkey). It **signs** saves and
the discovery event with that key, so it must stay stable across restarts.

---

## 1. Login (prove key ownership) — NIP-42 + kind-0

A challenge-response so the server trusts your pubkey (and, optionally, your
name/avatar) without ever seeing your secret key (the browser signs via NIP-07).

```
client                                    server
  │  GET /nostr/challenge                   │
  │ ───────────────────────────────────────▶  issue one-time challenge (32-byte hex, TTL)
  │  ◀─── { challenge, serverPubkey } ──────│
  │                                         │
  │  sign with NIP-07:                      │
  │   • auth:  kind 22242 event embedding   │
  │            the challenge in a tag       │
  │   • profile (optional): the user's      │
  │            kind-0 metadata event        │
  │                                         │
  │  joinOrCreate("game", { name, nostr: {  │
  │     auth, profile } })                  │
  │ ───────────────────────────────────────▶  verifyNostrLogin():
  │                                         │   • auth.kind === 22242, valid signature
  │                                         │   • challenge was issued by us & unreplayed
  │                                         │   • (optional) profile is kind-0 signed by the SAME key
  │  ◀──────── joined (or rejected) ────────│   → { pubkey, name, picture, nip05 } → Player.*
```

- **`auth`** — a **kind 22242** (NIP-42 client-auth) event embedding the server's
  `challenge` in a tag. Proves control of the pubkey. Challenges are single-use with
  a short TTL (no replay).
- **`profile`** — an optional **kind 0** (metadata) event signed by the same key, so
  the server can vouch the `name` / `picture` / `nip05` belong to that pubkey. These
  land on the synced `Player` (`pubkey`, `nostrVerified`, `picture`, `nip05`).
- **Single session per identity:** a second login for the same npub **kicks the
  first** with WebSocket close code `NOSTR_TAKEOVER_CODE` (**4001**); the new session
  inherits the old place + stats + inventory.

HTTP: `GET /nostr/challenge` → `{ challenge, serverPubkey }`. `serverPubkey` also lets
the client read its own server-signed save off the relays to preview it on the splash.

---

## 2. Progress saves + realm player updates — kind 30078, server-signed

Player progress is **server-authoritative and server-owned**: the server signs each
Nostr player's save with its own key, so one author holds every player's save.

The server publishes two replaceable event addresses from the same player snapshot:

1. **Latest player save** — one latest event per player, used for login recovery.
2. **Realm-scoped player update** — one latest event per player per realm, used by
   external apps to track that player's state during a specific realm.

### Latest player save

| | |
| --- | --- |
| `kind` | `30078` (`NOSTR_SAVE_KIND`) — parameterized-replaceable |
| `pubkey` (author) | the **server's** pubkey |
| `d` tag | `gorilator-save-v1:<player-pubkey>` (`saveDTag(playerPubkey)`) |
| `p` tag | the player's pubkey (queryable) |
| `content` | a `PlayerSave` JSON (schema below) |

### Realm-scoped player update

| | |
| --- | --- |
| `kind` | `30078` (`NOSTR_SAVE_KIND`) — parameterized-replaceable |
| `pubkey` (author) | the **server's** pubkey |
| `d` tag | `gorilator-player-realm-v1:<realm-id>:<player-pubkey>` (`playerRealmDTag(playerPubkey, realmId)`) |
| `p` tag | the player's pubkey (queryable) |
| `realm` tag | the current realm id |
| `reason` tag | `level-up`, `death`, or `logout` |
| `content` | the same `PlayerSave` JSON, plus `playerPubkey`, `realm: { id, startedAt, wave }`, `reason`, and `ts` |

### `PlayerSave` content format

The event `content` is a JSON object. Numeric gameplay fields are numbers; timestamps
are Unix epoch milliseconds.

```ts
type SaveReason = "level-up" | "death" | "logout";
type ItemType = "log" | "potion" | "stone" | "banana" | "berserker_potion";

interface PlayerSave {
  v: 1;
  playerPubkey?: string;       // hex pubkey; present on newly published saves
  realm?: {
    id: string;                // current realm id
    startedAt: number;         // epoch ms
    wave: number;              // peak/current wave when saved
  };
  reason?: SaveReason;

  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  x: number;
  z: number;
  rotY: number;
  attack: number;
  armor: number;
  critChance: number;          // 0..1
  moveSpeed: number;
  throwPower: number;
  hue: number;

  inventory: InventorySlot[];  // exactly 50 slots: 10 columns x 5 rows
  ts: number;                  // save time, epoch ms
}

interface InventorySlot {
  type: ItemType | "";         // "" means empty slot
  count: number;               // integer 0..99
}
```

`inventory` is ordered by slot index in row-major order:

- slot `0` is row 0, column 0; slot `9` is row 0, column 9; slot `10` starts row 1.
- Empty slots are always `{ "type": "", "count": 0 }`.
- Non-empty slots must have a valid `ItemType` and `count >= 1`.
- The server sanitizes loaded saves to exactly 50 slots and clamps stack counts to
  `MAX_STACK` (`99`).

Example:

```json
{
  "inventory": [
    { "type": "log", "count": 12 },
    { "type": "potion", "count": 2 },
    { "type": "berserker_potion", "count": 1 },
    { "type": "", "count": 0 }
  ]
}
```

The real save always contains 50 inventory entries; the example is shortened for
readability.

- **Written** on level-up, death, and logout (serialized per player; best-effort
  across relays with a timeout).
- **Read** on join: the server fetches the latest save for your pubkey and recovers
  your character — so your gorilla persists across sessions and even across servers
  that share the relays.
- **Track outside the game:** discover the server's live realm from the
  `gorilator-server` event or `/api/status`, then subscribe to player updates with
  filters like `{ kinds: [30078], authors: [serverPubkey], "#realm": [realmId] }`
  or for one player `{ "#p": [playerPubkey], "#realm": [realmId] }`.

Relays: `relay.damus.io`, `nos.lol`, `relay.nostr.band`, `relay.primal.net`.

---

## 3. Server + realm discovery — kind 30078, updatable

Each server publishes one **updatable** event (and exposes an HTTP API) so external
apps can discover servers and track the realm being played, with **no game-protocol
access**.

| | |
| --- | --- |
| `kind` | `30078` |
| `d` tag | `gorilator-server` |
| `t` tag | `gorilator` (filter `{kinds:[30078], "#t":["gorilator"]}` to find every server) |
| author | the server's pubkey (its reference/identity) |
| refreshed | on every realm start/end **and every 30 minutes** |
| content | server name, server `version` (read from `packages/server/package.json`), play URL, `totalRealms`, `maxRounds`, the live realm (id, wave, players, joined npubs), and the last realm |

A **realm** = one game (first live defender → La Crypta falls / room empties). See
[gameplay.md](gameplay.md) for the lifecycle.

**HTTP API** (same origin as `/colyseus`, CORS-open):

- `GET /api/status` — server identity + version + lifetime stats + the live realm
- `GET /api/realm` — the current realm to join + players already in it

> **Full spec + copy-paste discovery code for external apps:** [`../REALMS.md`](../REALMS.md).

---

## Summary of kinds

| Kind | Author | Purpose |
| --- | --- | --- |
| `22242` | the player | NIP-42 client-auth (login challenge) |
| `0` | the player | metadata (name/avatar/nip05), optional |
| `30078` · d=`gorilator-save-v1:<pk>` | the server | per-player progress save |
| `30078` · d=`gorilator-player-realm-v1:<realm-id>:<pk>` | the server | per-player update for one realm |
| `30078` · d=`gorilator-server` | the server | server + realm discovery/status |
