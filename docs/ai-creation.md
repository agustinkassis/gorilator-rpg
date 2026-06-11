# The AI Forge — prompt-to-content creation

Design doc for AI-powered, sats-paid content creation ([ROADMAP.md](../ROADMAP.md)
Phase 4). The Forge lets **anyone — total beginner to expert — create game
content from a prompt, inside the game**: entities, models, structures, items,
logic configs, crafting recipes, resources, map arrangements. Generation is
paid in sats; results land in the existing Library and community publishing
flow ([community-entities.md](community-entities.md)) with zero tooling
knowledge required.

Related: [vision.md](vision.md) (collaborative-creation pillar) ·
[strategy.md](strategy.md) (the revenue rail) ·
[engineering.md](engineering.md) (the data-first safety boundary this rides on) ·
[feature-lab.md](feature-lab.md) (test-driving generated content).

## 1. Vision

Type *"a moss-covered swamp troll that throws boulders"* on your phone, pay a
few hundred sats, and two minutes later a rigged, animated creature with tuned
stats is in your Library — publishable to the community (kind 30333 + Blossom)
exactly like any hand-made entity.

- **One prompt is the whole interaction.** The creator describes the entity;
  the Forge decides everything technical. If the entity is *alive*, it is
  automatically rigged and animated with the full clip set the engine needs —
  the creator is never asked about bones, retargeting, or animation files
  (§3.1). If it's static (prop, structure), the Forge derives the collision
  footprint instead.
- **Beginners need zero tooling.** No Blender, no JSON, no git — a prompt and
  a Lightning wallet.
- **Experts keep the full manual pipeline.** GLB import, JSON editing, the
  EntityCreator wizard — nothing is removed; the Forge is one more entry point
  into the same Library.
- **Anyone can contribute.** The contributor ladder ([strategy.md](strategy.md))
  gains a rung zero: creators who never open an editor.

## 2. What can be generated

Three categories, one output format: everything the Forge emits is **the same
data the manual pipeline produces** — content manifests and GLB assets — so AI
output is exactly as safe as hand-authored content (validated, never executed;
see [engineering.md](engineering.md) §2).

| Category | How | Examples |
| --- | --- | --- |
| **3D content** | provider APIs — **Meshy text-to-3D + auto-rig + auto-animate is the first provider** | characters/creatures (rigged + animated automatically, §3.1), props, structures |
| **Data content** | LLMs with schema-constrained output, emitting the same JSON manifests Dev Mode writes | entity stats + brain config, items, crafting recipes, drop tables, quests/dialogue, spawner layouts, map/zone arrangements |
| **Combos** | one prompt, multiple jobs | a creature + its drop table + a quest to hunt it |

## 3. Pipeline

The Forge is a panel in the in-game creator flow — an EntityCreator wizard
step, not a separate app:

```
prompt (Forge panel)
  → sats payment (before the job runs — §4)
  → async generation job with progress
  → in-game preview (3D model + stats)
  → tweak (existing stat sliders; optional Feature Lab scenario test-drive)
  → save to Local library (pending state)
  → optional community publish (kind 30333 + Blossom)
```

Everything after "generation job" **reuses what exists**
([community-entities.md](community-entities.md)): the EntityCreator wizard,
`libraryCache`, `communityPublish`, Blossom upload, kind-30333 events, and the
git-tracked pending/commit flow. The Forge adds a content *source*, not a
content *system*.

### 3.1 Living entities: auto-rig + auto-animate

When the prompt describes something alive, the generation job runs the full
character chain without asking the creator anything:

```
text-to-3D model
  → auto-rig (biped/quadruped skeleton)
  → auto-animate: one clip per engine animation slot
  → auto-map clips into the characters.json anims entry
```

- **The clip set is fixed by the engine**, not the creator: `IDLE`, `WALK`,
  `HIT` (today's `characters.json` slots), plus `ATTACK` and `DEAD` as the
  schema grows — every `AnimState` the simulation can put the entity in gets a
  clip, so a Forge creature animates correctly everywhere a hand-imported one
  does.
- **This automates the proven manual flow.** The Library's character importer
  already consumes exactly this shape — a Meshy rigged model GLB plus
  per-state animation GLBs (`anims: {IDLE: {file, speed}, …}`). The Forge
  produces the same files and writes the same entry; nothing downstream
  changes.
- **Alive-vs-static is the Forge's call**, inferred from the prompt and the
  provider's classification, with a one-tap override in the preview step
  ("this should move" / "this is scenery") for the rare miss.
- Static results skip rigging and get an auto-derived collision footprint
  (`collisionRadius`) from the model bounds instead.

## 4. Sats rails

- **Pay before generating.** Per-generation pricing covers the provider API
  cost plus a configurable margin. Payment is Lightning — NWC or a plain LN
  invoice presented as a zap-style flow — and the job starts when it settles.
- **Operators choose the model:**
  1. **Bring-your-own API keys** — the operator pays the providers directly;
     generation is free (or operator-priced) for their community.
  2. **Pass-through pricing** — players pay per generation, the operator's
     margin knob is the business model.
  3. **Hosted Forge** — point at a managed Forge service and hold no keys at
     all; a managed-realms-style revenue rail ([strategy.md](strategy.md)).
- **Not pay-to-win.** Sats buy *creation*, not power: Forge output goes
  through the same balance validation, curation allowlists, and server content
  policies as any community entity. A generated troll obeys the same stat
  budget as a hand-made one.

## 5. Architecture sketch

A **Forge service** — a server-side module first, extractable to a standalone
service for the hosted model — owns the whole provider side:

- holds provider API keys (**keys never reach the client**);
- exposes a job API: create / status / result;
- webhooks or polls providers for completion;
- stores results to Blossom (publishable assets) or local files (private use).

The client Forge panel only ever talks to the Forge service. Providers plug in
behind a `ForgeProvider` interface:

| Provider type | First implementation | Produces |
| --- | --- | --- |
| text-to-3D + rig + animate | Meshy | creature GLB + per-slot animation GLBs (§3.1); prop/structure GLB |
| image generation | TBD | item icons, preview thumbnails |
| LLM (schema-constrained) | TBD | manifest JSON: stats, items, recipes, quests |

LLM output is **schema-constrained** — the generator is handed the manifest
JSON schema and its output is validated against it before a human ever sees
it; invalid output retries or fails the job, never lands in a manifest.

## 6. Quality & safety

- **Validation:** JSON schema validation on every generated manifest, plus
  **stat-budget linting** — per-tier budgets with auto-balance suggestions, so
  the preview step says "this troll is 30% over tier-2 budget, suggested fix"
  instead of letting it through.
- **Asset budgets:** poly-count and texture-size caps on generated models,
  enforced at the Forge service before results are returned.
- **Moderation hooks:** operators can enable a review queue — generated
  content holds in pending until approved. The existing curation controls
  (`realm.json` `content: {authors, blockedIds}`, ROADMAP Phase 4) apply to
  Forge output like any community content.
- **Licensing:** generated-asset terms vary per provider — the Forge surfaces
  each provider's license at generation time, and community publishing applies
  the default publish license for community entities.
- **Spam control:** the sats price *is* the rate limiter — generation costs
  real money — backed by the same curation allowlists that govern community
  entities.

## 7. Roadmap placement

These are the Phase 4 workstreams in [ROADMAP.md](../ROADMAP.md):

| Workstream | Size |
| --- | --- |
| Forge provider interface + Meshy creature pipeline (model → auto-rig → auto-animate → library, §3.1) | L |
| LLM data-content generator with schema-constrained output | M |
| Sats payment rail via NWC | M |
| Hosted Forge experiment + operator BYO keys | M |
| Forge-in-scenario test-drive integration | S |

**MVP first slice:** one text prompt → rigged, fully animated creature (Meshy,
§3.1) → Local library, paid by a manually issued invoice. The MVP bar is the
no-knowledge test: someone who has never heard the word "rigging" gets a
creature that idles, walks, and reacts to hits. Everything else — LLM content,
NWC automation, the hosted service — layers on once that loop works end to end.
