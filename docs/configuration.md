# Configuration & tuning

Three layers: **compile-time constants** (`@rpg/shared`), **environment variables**
(deploy/identity), and **runtime JSON files** (live-reloaded content).

## 1. Tuning constants — `packages/shared/src/constants.ts`

The single source of truth for game balance, shared by client and server. Grouped by
the section comments in the file:

| Section | Key constants |
| --- | --- |
| **Core** | `TICK_RATE` (20 Hz), `SERVER_PORT` (2567), `ROOM_NAME` |
| **Movement** | `MOVE_SPEED`, `WORLD_SIZE` (half-extent), `NAV_CELL` (A* grid), `ARRIVE_THRESHOLD` |
| **Combat** | `ATTACK_RANGE`, `ATTACK_COOLDOWN_MS`, `ATTACK_WINDUP_MS`, `HIT_STATE_MS`, `THROW_STATE_MS`, `PLAYER_RESPAWN_MS`, `DUMMY_RESPAWN_MS`, `DAMAGE_DIVISOR` |
| **Health** | `PLAYER_MAX_HP`, `DUMMY_MAX_HP` |
| **Stamina** | sprint multiplier, drain/regen rates, "winded" re-engage threshold |
| **Leveling** | `XP_BASE`, `XP_GROWTH`, `*_PER_LEVEL` generic character scaling, `PLAYER_*_PER_LEVEL` player level-up gains, `CRIT_CHANCE_MAX`, XP rewards (`GOBLIN_XP_REWARD`, `PLAYER_KILL_XP`, `TREE/ROCK/DUMMY_XP_REWARD`), `xpForLevel()`, `statsForLevel()` |
| **Damage formula** | `ATTACK_VARIANCE`, `ARMOR_K`, `CRIT_MULTIPLIER` |
| **Default stats** | `PLAYER_ATTACK/ARMOR/CRIT_CHANCE`, `DUMMY_*` |
| **Goblins** | `GOBLIN_MAX_HP`, `GOBLIN_ATTACK`, `GOBLIN_ARMOR`, `GOBLIN_CHASE_SPEED`, `GOBLIN_AGGRO_RADIUS`, `GOBLIN_DEAGGRO_RADIUS`, `GOBLIN_ATTACK_RANGE`, `GOBLIN_ATTACK_COOLDOWN_MS`, `GOBLIN_ATTACK_WINDUP_MS`, `GOBLIN_RESPAWN_MS` |
| **Waves** (tower defense) | `WAVE_INTERVAL_BASE_MS` (2.5 min), `WAVE_INTERVAL_STEP_MS` (+0.5 min/wave), `WAVE_INTERVAL_MAX_MS` (cap), `WAVE_FIRST_DELAY_MS`, `WAVE_MARCH_SECONDS` → `WAVE_SPAWN_DISTANCE`, `WAVE_SPAWN_ARC`, `WAVE_SIZE_BASE/_PER_PLAYER/_PER_WAVE/_MAX`, `GOBLIN_LIVE_CAP`, `GOBLIN_HOUSE_DAMAGE` |
| **Potions** | `POTION_COUNT`, `POTION_HEAL`, `PICKUP_RADIUS`, respawn delay |
| **Trees** | `TREE_COUNT`, `TREE_HP`, `TREE_ARMOR`, `TREE_REGROW_MS`, `TREE_BANANA_DROP_CHANCE`, `LOGS_PER_TREE`, `AUTO_GRAB_RADIUS` |
| **Rocks** | `ROCK_COUNT`, `ROCK_HP`, `ROCK_ARMOR`, grouped stone drop amount in `resources.json` |
| **House** | `HOUSE_HP`, `HOUSE_COLLISION_RADIUS` |
| **Bananas** | `STARTING_BANANAS`, `BANANA_MAX`, `BANANA_MIN/MAX_THROW`, `BANANA_DAMAGE`, flight timing |
| **Stones** | `STONE_MIN/MAX_THROW`, `STONE_DAMAGE`, `STONE_MIN_DAMAGE` |
| **Charged throw** | hold-to-full time, decay/floor of the power bar |
| **Inventory** | `INV_COLS`, `INV_ROWS`, `INV_SLOTS`, `MAX_STACK` |
| **Chat** | `CHAT_MAX_LEN` |
| **Nostr** | `NOSTR_SAVE_KIND` (30078), `NOSTR_SAVE_D`, `saveDTag()`, `NOSTR_TAKEOVER_CODE` (4001) |

> Editing `constants.ts` requires a `@rpg/shared` rebuild and a client hard-reload
> if the change touches synced state (see [getting-started.md](getting-started.md)).

## 2. Environment variables (`.env.example`)

| Var | Purpose |
| --- | --- |
| `GAME_SERVER_PORT` | server WebSocket/HTTP port (default 2567) |
| `VITE_SAME_ORIGIN` | Build the client to dial the same host that served the page (default Cloudflare setup) |
| `VITE_SERVER_URL` | Legacy `wss://…` URL baked into the client bundle for split-host deploys |
| `NOSTR_NSEC` | the server's Nostr secret key — signs player saves **and** the server discovery event. **Keep it stable** across restarts, or saved progress + a stable server identity are lost. Ephemeral if unset (printed at boot). |
| `MONITOR_USER` / `MONITOR_PASS` | HTTP Basic auth for the `/colyseus` monitor (open if unset) |
| `SERVER_HOSTNAME` | public game hostname (informational + `PLAY_URL` fallback) |
| `CLIENT_DIST` | single-service deploys: path to the built client to serve from the server |
| `SERVER_NAME` | display name in the realm event + `/api/*` |
| `PLAY_URL` | public URL players join at (defaults to `https://$SERVER_HOSTNAME`) |
| `SERVER_STATS_FILE` | where realm lifetime totals persist (default `./.server-realms.json`) |

## 3. Runtime content files (live-reloaded JSON)

These let you edit the world without recompiling — most are written by **Dev Mode** /
the in-game importers and re-read on change. They live in `packages/client/public/`.

| File | Drives |
| --- | --- |
| `props.json` | imported props (Model Importer / Dev Mode). Server reads it for **collision** (`loadPropObstacles`, props with `collisionRadius > 0`); the client renders them (`PropManager`). |
| `spawners.json` | Dev-Mode-placed object **spawners** (`loadSpawners` + `spawnerSystem`). |
| `npcs.json` | placed custom **characters** (imported Meshy zips), rendered by `CharacterManager`. |
| `characters.json` | the custom-character **library** (definitions/templates for the importer). |
| `resources.json` | resource **drop tables** (`loadResourceDrops`). |
| `audio/manifest.json` | optional **audio sample overrides** — maps sound keys → files; anything unlisted is synthesized procedurally. See `public/audio/README.md`. |

The server watches the files it reads and applies changes without a restart.
