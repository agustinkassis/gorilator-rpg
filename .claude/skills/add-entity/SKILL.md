---
name: add-entity
description: Add or tune a game entity — prop, NPC, item, spawner, wave, drop table, or HP/brain/stats — via the JSON content manifests. No recompile needed. Use for content/balance requests.
---

# Add or tune an entity (data tier — no code)

Pick the manifest from the AGENTS.md "Where things live" table. All of them live in `packages/client/public/` and **live-reload on the server** (watchFile, ~1.5s) — no restart:

| Want | File | Notes |
| --- | --- | --- |
| Stats/HP/brain/drops per kind or instance | `entity-features.json` | `defaults` (by kind or modelId) merged with `instances` (by id); instance wins |
| New NPC placement | `npcs.json` + template in `characters.json` | placements reference a `defId` |
| Prop with collision | `props.json` | `collisionRadius > 0` makes it a nav obstacle; scale = rendered footprint |
| Object spawner | `spawners.json` | `intervalMs`, `cap`, optional `brain` + `stats` |
| Wave composition | `waves.json` | per-wave unit lists |
| Item def (icon/model/stack) | `items.json` | client renders via `items/itemRegistry.ts` |
| Tree/rock drop tables | `resources.json` | progressive vs kill drops |

Rules:
- Brains are the builtin enum (`idle`, `passive_patrol`, `war_seeker`, `attacks_home`) **plus any plugin-registered brain id** (see `docs/plugins.md`). A new behavior = a code plugin (`/add-plugin`), not a manifest edit.
- Validate JSON after editing (`node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`); a malformed manifest is skipped with a `[props]`-style warning, not a crash.
- Schema for entity features: `packages/shared/src/entityFeatures.ts` (`EntityFeatureManifest`).
- Big content packs that should be distributable → make a data plugin instead (`plugins/<name>/` with `content/`, see `docs/plugins.md`).
- These files are also edited in-game via Dev Mode (the editor writes through the `/__*/` Vite endpoints) — prefer hand-editing only for batch/scripted changes.
