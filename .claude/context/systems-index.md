# Server systems index (`packages/server/src/systems/`)

One line each. Tick order lives in `rooms/GameRoom.ts` → `setSimulationInterval`
(stamina → movement → combat → goblinAi → separation → waves → sacredCircleHeal →
spawners → tree/potion respawn → bananas → houseRegen → item pickup/auto-grab →
checkHomeFall → save triggers → realmTracker). Each runs inside
`perfTracker.span("<name>", …)` → visible in F3 + `/api/perf` tags.

| System | Responsibility |
| --- | --- |
| `movement` | waypoint walking, sprint speed, depenetration; `ghostMovementSystem` = dev-pause free-roam |
| `pathfinding` | grid A* + string-pulling + `depenetrate` + dynamic obstacle set |
| `combat` | player attack flow (queue → windup → connectHit), damage formula, knockback, respawn |
| `goblins` | wave spawner + goblin AI brains (builtin brain dispatch); `waves.ts` = authored wave compositions |
| `bananas` | throwables: spawn, charged flight, landing damage |
| `houses` | La Crypta spawn + regen (`healingTower` = sacred-circle position) |
| `resources` | trees/rocks spawn, regrow, pickup, auto-grab; `resourceDrops` = drop-table config |
| `pickups` | health potions |
| `inventory` | per-player grid inventory (off-state, owner-only message) |
| `items` | items.json registry (server side) |
| `leveling` | XP, level growth, death penalty |
| `stamina` | sprint drain/regen |
| `separation` | anti-stacking fan-out |
| `spawners` | dev-placed object spawners (spawners.json) |
| `structures` / `structureDrops` | destructible props + their loot |
| `entityFeatures` | entity-features.json merge chain (kind → modelId → instance) |
| `enemyConfig` | enemy stat/brain resolution (`brainOf`) |
| `npcs` | authored NPC placements (npcs.json + characters.json) |
| `devEdit` / `devTuning` | Dev-Mode entity edits + live tuning knobs |
| `nostr` / `nostrIdentity` / `nostrSave` / `nip98` | login verify, server key, server-signed saves, HTTP auth |
| `admins` | admin npub allowlist |
| `realms` | realm lifecycle, lifetime stats, Nostr discovery event, `/api/status|realm` |
| `perf` | tick sampling, `/api/perf`, `POST /api/bench`, PERF_LOG JSONL |
| `selfUpdate` / `updateCheck` | CLI-managed self-update + release polling |
| `plugins/*` | plugin discovery, host registries (brains/items/systems/events), content loaders, Nostr packs |
