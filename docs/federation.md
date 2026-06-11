# Federation protocol — portable players across Gorilator servers

> **Status: DRAFT v0 — request for comments.**
> Sections are marked **EXISTING** (shipped, verifiable on relays today) or
> **PROPOSED** (planned for [ROADMAP.md](../ROADMAP.md) Phase 5). Comments
> welcome as issues on the repo or replies to the project npub.

Gorilator federation is deliberately minimal: **public Nostr relays are the
transport, server signatures are the trust**. There is no server-to-server
HTTP, no central registry, and no shared database. A server that has never
heard of another server can still import its players' saves — if its published
policy says to trust that server's signature.

Design principles:

1. **The player's npub is the primary key.** Servers attest to a player's
   progress; they never own the identity.
2. **Saves are server-signed.** A save is only as trustworthy as the server
   that signed it — importing servers decide whom to trust and how much.
3. **Policies are public.** A server's import rules are a published Nostr
   event, not a hidden config — players and dashboards can read them before
   joining.
4. **Replaceable events everywhere.** Every per-player and per-server document
   is a NIP-33 addressable event: one latest version per address, no log
   compaction needed.

Related: [nostr.md](nostr.md) (all events overview) ·
[nostr-auth.md](nostr-auth.md) (login/auth) · [`../REALMS.md`](../REALMS.md)
(discovery deep-dive + HTTP API).

---

## 1. Player save event — EXISTING

The unit of portability. The server signs each verified player's progress with
its own key (`NOSTR_NSEC`) and publishes it as a replaceable event.

| | |
| --- | --- |
| `kind` | `30078` (app-specific replaceable data) |
| `pubkey` (author) | the **server's** pubkey |
| `d` tag | `gorilator-save-v1:<player-pubkey>` |
| `p` tag | the player's pubkey (queryable) |
| written | on level-up, death, and logout (and, with the Phase 2 policy, on realm end) |
| `content` | a `PlayerSave` JSON |

### `PlayerSave` content (v1)

The canonical type is `PlayerSave` in `packages/shared/src/types.ts`:

```ts
interface PlayerSave {
  v: number;                  // save schema version (currently 1)
  playerPubkey?: string;      // hex pubkey; present on newly published saves
  realm?: { id: string; startedAt: number; wave: number };
  reason?: string;            // "level-up" | "death" | "logout" | …

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
  critChance: number;         // 0..1
  moveSpeed: number;
  throwPower: number;
  hue: number;

  inventory: InventorySlot[]; // exactly 50 slots, row-major; "" = empty
  ts?: number;                // save time, epoch ms
}
```

A loading server **sanitizes** every save (`sanitizeSaveContent`): exactly 50
inventory slots, stack counts clamped, numeric fields validated. Sanitization
is the first line of defense for migration too — imports go through the same
path plus the policy clamps in §4.

**Versioning:** `v` bumps when fields are added. `PlayerSave` v2 (planned with
Phase 3) adds `equipment[]`, `mana`, `hunger`, and `quests[]` — importers must
accept lower versions and fill defaults.

A second per-realm address (`d: gorilator-player-realm-v1:<realm-id>:<pk>`)
carries the same snapshot for external realm tracking — see
[nostr.md](nostr.md) §2.

## 2. Server discovery event — EXISTING

Every server announces itself and its current realm. This is how servers find
each other for federation, and how dashboards list the network — fully
documented with copy-paste consumer code in [`../REALMS.md`](../REALMS.md).

| | |
| --- | --- |
| `kind` | `30078` |
| `pubkey` (author) | the server's pubkey (its identity) |
| `d` tag | `gorilator-server` |
| `t` tag | `gorilator` — find every server: `{kinds:[30078], "#t":["gorilator"]}` |
| other tags | `name`, `version`, `r` (play URL), `realms`, `max_rounds`, `status` |
| refreshed | on realm start/end and every 30 minutes |
| `content` | server name/version/URL/pubkey, lifetime stats, current + last realm |

A server's **identity for federation purposes is this pubkey** — the same key
that signs its players' saves. "Trust server X" means "accept saves authored
by X's pubkey".

## 3. Server policy event — PROPOSED

A server publishes its rules as a sibling replaceable event, so players (and
the landing dashboard) know what a world is like *before* joining, and other
servers know what it will accept.

| | |
| --- | --- |
| `kind` | `30078` |
| `pubkey` (author) | the server's pubkey |
| `d` tag | `gorilator-server-policy` |
| `t` tag | `gorilator` |
| published | alongside the discovery event (`systems/realms.ts`), refreshed on change |
| source of truth | the server's `realm.json` `federation` block |

### `content` schema (draft)

```jsonc
{
  "v": 1,
  "deathPolicy": { "mode": "xp-penalty", "xpPenalty": 0.3 },   // none | xp-penalty | hardcore
  "progression": { "persistAcrossWipes": true, "keepInventoryOnWipe": true },
  "migration": {
    "accepts": "allowlist",            // "none" | "allowlist" | "any-gorilator"
    "trustedServers": ["<hex pubkey>", "…"],
    "maxImportLevel": 20,              // imported level is clamped
    "maxImportGearTier": 2,            // refuse overpowered crafted gear (Phase 3+)
    "items": {
      "mode": "allowlist",             // "none" | "allowlist" | "all"
      "allowed": ["banana", "log", "potion"],
      "stripUnknown": true             // drop item ids this server doesn't define
    }
  },
  "events": { "enabled": ["la-crypta-defense"], "autoStart": true },
  "economy": { "sats": false },
  "updatedAt": 1730000000000
}
```

Gear caps matter once equipment exists ([game-design.md](game-design.md)): a
hardcore server must be able to refuse a visitor's endgame crafted gear while
still honoring their identity and level.

The landing dashboard renders policy badges per server (e.g. *persistent ·
imports: allowlist · sats: off*).

## 4. Migration handshake — PROPOSED (relay-mediated v1)

No server-to-server connection. The importing server does everything itself by
reading relays at join time:

```
player ──join──▶ Server B
 1. B verifies the player's NIP-42 login (kind 22242)        — existing
 2. B queries relays for ITS OWN save of this pubkey
    (kind 30078, authors:[B], d: gorilator-save-v1:<pk>)
    → found: restore as today, done                          — existing
 3. no own save → B reads its policy: migration.accepts
    → "none": fresh character, done
 4. B checks session locks (§5): a fresh heartbeat from
    another trusted server → refuse or wait
 5. B queries relays for saves of this pubkey authored by
    migration.trustedServers (or any discovered Gorilator
    server when accepts = "any-gorilator")
 6. B picks the newest valid event (signature + author check),
    then sanitizes + clamps per policy: sanitizeSaveContent,
    level ≤ maxImportLevel, gear tier ≤ maxImportGearTier,
    item rules (allowlist / stripUnknown)
 7. B spawns the player from the imported save and IMMEDIATELY
    publishes its own save for the pubkey (reason: "migrated-in")
    — from now on, step 2 hits and migration never re-runs
 8. B publishes a transfer receipt (§6) referencing the source
```

Properties:

- **Idempotent** — after step 7 the player is a native of server B; re-joins
  take the normal restore path.
- **Non-destructive** — the source server's save is never modified. A player
  can migrate the same character to many servers; each holds its own fork from
  the moment of import.
- **Trust is one-way** — B importing from A does not require A to trust B.

## 5. Session locking — PROPOSED

Prevents the same npub from playing the same character on two trusted servers
at once (in-room duplicate logins are already handled locally by
`takeOverSameNpub` — that stays local enforcement).

| | |
| --- | --- |
| `kind` | `21333` (**ephemeral** — relays do not store it) |
| `pubkey` (author) | the server currently hosting the session |
| `p` tag | the player's pubkey |
| cadence | heartbeat every ~30 s while the npub is in the room |

On join, a server subscribes briefly for heartbeats tagged with the joining
pubkey from servers it trusts; a **fresh** heartbeat (< ~90 s) from a
different server means the character is live elsewhere → refuse the join (or
offer spectate). Stale or missing heartbeats are ignored — a crashed server
must never lock a player out for more than a heartbeat window.

## 6. Transfer receipts — PROPOSED

An auditable record of every import, published by the **importing** server.

| | |
| --- | --- |
| `kind` | `30334` |
| `pubkey` (author) | the importing server |
| `d` tag | `gorilator-transfer-v1:<player-pubkey>` (latest transfer per player per importer) |
| `p` tag | the player's pubkey |
| `content` | `{ v: 1, from: "<source server pubkey>", sourceEvent: "<event id>", importedLevel, clamps: { level?, gearTier?, itemsDropped? }, ts }` |

Receipts let players see exactly what survived a migration, let source servers
observe outflow, and give dashboards a federation-activity feed.

## 7. Trust modes

What a server's policy amounts to in practice — the named presets:

| Mode | What imports | Typical use |
| --- | --- | --- |
| **identity-only** | nothing — npub, name, avatar only; fresh character | hardcore/seasonal worlds, tournaments |
| **level-import** | level/XP (clamped), no items | progression-friendly but economy-sealed worlds |
| **inventory-allowlist** | level + items on the allowlist, rest stripped | **the flagship default** — portable progress without imported-economy shocks |
| **full-trusted** | the whole sanitized save | sister servers run by the same operator/community |
| **isolated** | `accepts: "none"` — and the server may also skip publishing saves | private events, test realms |

## 8. Kind / d-tag allocation

| Kind | d tag / discriminator | Author | Status | Purpose |
| --- | --- | --- | --- | --- |
| 22242 | — | player | **existing** | NIP-42 login challenge |
| 0 | — | player | **existing** | profile metadata (optional) |
| 30078 | `gorilator-save-v1:<pk>` | server | **existing** | latest player save |
| 30078 | `gorilator-player-realm-v1:<realm>:<pk>` | server | **existing** | per-realm player update |
| 30078 | `gorilator-server` | server | **existing** | discovery/status |
| 30078 | `gorilator-server-policy` | server | **proposed** | published policy (§3) |
| 30333 | `gorilator-entity-v1:<id>` | player | **existing** | community entity ([community-entities.md](community-entities.md)) |
| 30334 | `gorilator-transfer-v1:<pk>` | server | **proposed** | transfer receipt (§6) |
| 21333 | — (ephemeral) | server | **proposed** | session heartbeat (§5) |
| 30335 | `gorilator-clan-v1:<id>` | clan founder | **proposed** | clan roster (Phase 6) |
| 24242 | — | player | **existing** | Blossom upload auth (BUD-01) |

## Open questions (v0)

- **Relay set agreement** — v0 assumes the default relay set overlaps between
  servers. Should the policy event advertise the server's write relays?
- **Save conflicts** — a player active on two non-trusting servers forks their
  character permanently. Acceptable (it mirrors single-player saves), or do we
  want an optional player-signed "primary home server" pointer?
- **`any-gorilator` sybil surface** — accepting saves from any discovered
  server means anyone can mint a server key and sign a level-99 save. The
  clamps (§3) bound the damage; is that enough, or does `any-gorilator` need a
  proof-of-uptime/age heuristic from the discovery history?
- **Receipt verbosity** — should receipts enumerate dropped items, or only
  counts (privacy vs. auditability)?

Feedback on any of these is the point of DRAFT v0.
