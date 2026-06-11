# Content manifests (`packages/client/public/*.json`)

All server-watched (watchFile ~1.5s live reload) and editable in-game via Dev Mode
(which writes through the `/__*/` Vite endpoints — see dev-endpoints.md).

| File | Consumed by (server) | Shape / notes |
| --- | --- | --- |
| `entity-features.json` | `systems/entityFeatures.ts` | `EntityFeatureManifest` (shared/src/entityFeatures.ts): `defaults` by kind/modelId + `instances` by id; `hp`, `brain`, `stats`, `drops[]` |
| `characters.json` | `systems/npcs.ts` | character templates (model, clips, scale) — referenced by `defId` |
| `npcs.json` | `systems/npcs.ts` | placements `{id, defId, x, z, rotationY, scale, brain?, stats?}` |
| `props.json` | `systems/props.ts` | placed props; `collisionRadius > 0` ⇒ nav obstacle (visualRadius = spawn keep-out) |
| `spawners.json` | `systems/spawners.ts` | `{id, ownerId, type, modelId?, intervalMs, cap, brain?, stats?}` |
| `waves.json` | `systems/waves.ts` | authored wave compositions; brain defaults to `attacks_home` |
| `items.json` | `systems/items.ts` + client `items/itemRegistry.ts` | item defs: icon, model, stack size |
| `resources.json` | `systems/resourceDrops.ts` | per-kind tree/rock drop tables (progressive vs kill) |
| `structures.json` | `systems/structureDrops.ts` | per-structure destroy loot |
| `audio/manifest.json` | client only | SFX/music catalog |

Plugin packs ship the same shapes under `plugins/<name>/content/` (routed through
the same loaders). Distribution via Nostr kind-30333 events: docs/community-entities
spec + `systems/plugins/nostrContent.ts`.
