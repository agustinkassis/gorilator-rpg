# Engineering conventions & refactor direction

How the codebase stays coherent while the project pivots from tower-defense
brawler to sandbox ([vision.md](vision.md)). Two declarations up front:

1. **Refactoring and renaming are in-bounds.** The pivot is allowed to touch
   names, file boundaries, and module seams — under the rules in §4.
2. **Interoperability is a design goal, not an afterthought.** Every wire
   format gets a spec another engine could implement (§5).

Related: [architecture.md](architecture.md) (what exists today) ·
[feature-lab.md](feature-lab.md) (the Definition of Done) ·
[federation.md](federation.md) (the protocol specs) ·
[plugins.md](plugins.md) (the extension tiers).

## 1. Terminology glossary

Canonical names going forward. Docs and UI copy adopt these first; code
identifiers follow opportunistically (§4).

| Term | Means | Notes |
| --- | --- | --- |
| **server** | a process an operator runs | one `gorilator` install, one Nostr identity (its pubkey) |
| **world** | the persistent map + content a server hosts | what players visit; one server hosts one world today |
| **realm cycle** | one world era between resets | what the code calls a "realm" — the wipe ends a cycle, persistence policy decides what survives |
| **event** | a module-run activity inside a world | e.g. *La Crypta Defense*; pluggable game loops via the event-module API (ROADMAP Phase 3) |
| **content manifest** | live-reloaded JSON in `packages/client/public/` | items, entities, props, spawners, waves… — validated data, never executed |
| **scenario** | a Feature Lab isolated test map | `scenarios/<feature>.json`, stages one feature ([feature-lab.md](feature-lab.md)) |
| **policy** | a world's death/progression/federation rules | the `realm.json` `policy`/`federation` blocks, published as a Nostr event ([federation.md](federation.md) §3) |

## 2. Code conventions

The rules that already hold, written down so they keep holding:

- **Pure systems in the tick.** Game logic is `(state, dt)` functions in
  `packages/server/src/systems/`, composed into the 20 Hz tick in
  `rooms/GameRoom.ts`. No system owns a socket, a timer, or hidden state that
  the tick doesn't pass it. Every system runs inside a perf span (visible in
  `/api/perf` and the F3 overlay) — new systems included, no exceptions.
- **Data-first content.** Anything expressible as data ships as a content
  manifest: JSON, schema-validated, live-reloaded, **never executed**. This is
  the safety boundary that lets untrusted community content (and AI-generated
  content — [ai-creation.md](ai-creation.md)) into a world.
- **Three tiers, lowest that works.** Content manifest → plugin → core, in
  that order ([plugins.md](plugins.md)). The fork rule keeps worlds
  upstream-mergeable: forks customize `plugins/`, `public/*.json`, and
  `realm.json` — never `packages/*/src` (`node scripts/check-fork.mjs`).
- **Colyseus schema discipline.** Synced `@type` fields are expensive: each
  schema change forces a shared rebuild + a client hard reload, so **batch
  them** into planned schema releases (see the Phase 3 "one batched schema
  change" workstream). For non-positional, per-player state — inventory today,
  quests next — prefer per-session Maps on the server plus owner-only
  `client.send(...)` over new synced fields. Schema is for what every client
  must render every frame.
- **PlayerSave versioning.** Saves carry a `v` field; loaders sanitize
  (`sanitizeSaveContent`) and fill defaults for missing fields. Migrations are
  **additive only** — a v2 reader must load a v1 save forever. Old saves must
  always load; relays remember even when we'd rather they didn't.
- **Characterization tests before refactors.** Before moving or renaming
  behavior, pin it: `combat.test.ts` and `realmLifecycle.test.ts` are the
  pattern — plain Vitest over the pure systems, asserting current outcomes, so
  the refactor diff proves behavior didn't change.
- **The Feature Lab Definition of Done.** Every feature ships code + scenario
  manifest + bot self-test + tweak knobs + docs ([feature-lab.md](feature-lab.md)).
  No exceptions for "small" features — small features are where regressions hide.

## 3. Deterministic simulation (implemented)

Gameplay rolls go through the **seeded PRNG service** in
`packages/server/src/systems/rng.ts` — never `Math.random()` (a source-grep
guard in `rng.test.ts` enforces this; `rng.ts` itself is the only sanctioned
caller, to mint fresh seeds).

- **One seed per realm cycle**, resolved by priority: scenario manifest
  `seed` → `GORILATOR_SEED` env → random. Logged at cycle start
  (`[rng] realm cycle seed = …`) and exposed at `/api/status` (`cycleSeed`).
- **Injected, not ambient**: the service is keyed by the `GameState` object
  (WeakMap — same pattern as the wave clock), so pure `(state, dt)` system
  signatures stay unchanged: `rng(state, "drops")()`.
- **Independent streams per concern** — `combat`, `drops`, `spawns`, `ai`,
  `world`, `bots`, `misc` — so adding a roll in one system never shifts
  another system's sequence.
- **Tests** pin rolls with `installFixedRng(state, 0.5)` instead of spying on
  `Math.random` (see combat.test.ts / waves.characterization.test.ts).

Payoff: **reproducible bot self-tests, replays, and bench runs** — the same
scenario + seed produces the same outcome, every time, which is what makes the
Feature Lab's bot assertions trustworthy ([feature-lab.md](feature-lab.md)).

### timeScale audit (#67)

Every gameplay timer runs on the **scaled** tick delta the GameRoom tick hands
it (`dt = deltaMs · state.timeScale / 1000`, cap `TIME_SCALE_MAX = 16`), so
accelerated simulation works end-to-end. `timeScale.test.ts` pins equivalence
(N ticks at 1× ≡ N/2 ticks at 2×; 0× freezes).

| Clock | Scaled? | Why |
| --- | --- | --- |
| All `(state, dt)` systems (movement, combat, waves, spawners, regrow, hunger-to-be…) | ✅ | receive scaled `dt` |
| House regen, pending throws, berserker buff timer | ✅ | receive `scaledMs` |
| Sacred-circle heal | ✅ | `healPerSec · dt` |
| Game-over intermission (`state.restartTimerMs`) | ❌ by design | the "next realm in N" countdown is wall-clock for players |
| Dev Mode ghost movement while paused | ❌ by design | the editor roams in real time while the world is frozen |
| Perf tracker, content `watchFile` reloads, Nostr challenge expiry, realm-tracker timestamps | ❌ by design | infrastructure, not gameplay |

Above 16× a 20Hz tick's dt exceeds ~800ms and fast movers can tunnel through
collision — sub-stepping the tick is the documented follow-up before raising
`TIME_SCALE_MAX`.

## 4. Rename / refactor map (de-tower-defensing the core)

The codebase still speaks tower-defense: goblins, waves, the house. Renaming
is **explicitly in-bounds** — the target names below are where the code is
heading as the event-module extraction proceeds (ROADMAP Phase 3).

| Current | Target | When |
| --- | --- | --- |
| `systems/goblins.ts` (AI + wave spawner in one file) | split: generic enemy AI → `systems/enemyAi.ts` (core); wave scheduler → the `la-crypta-defense` event plugin | Phase 3 extraction |
| hardcoded House / "La Crypta" objective (`houses.ts`, `checkHomeFall`) | a generic **objective structure** owned by the event module — core knows "a structure with hp", the event decides it matters | Phase 3 extraction |
| `waves.json` as core content | event-module content (`plugins/la-crypta-defense/content/`) | Phase 3 extraction |
| `GameRoom.ts` (~1,200 lines) | keep slimming: lifecycle already extracted to `systems/realmLifecycle.ts`; save triggers and dev-mode message handlers are next | opportunistic |
| "realm" naming | "**realm cycle**" in docs and UI copy first; code identifiers (`realms.ts`, `realm.json`, event d-tags) opportunistically — wire-format names only ever change with a versioned spec (§5) | docs/UI now, code as touched |

Rules for every rename:

1. **Dedicated PRs** — a rename PR changes names and file locations, nothing
   else. Never mix behavior changes into a rename diff.
2. **Characterization tests first** (§2) — pin the behavior, rename, show
   green on the same assertions.
3. **Wire formats are exempt from casual renames.** Anything on a relay or in
   a save (`d` tags, `PlayerSave` fields, event kinds) changes only via a
   versioned spec revision in [federation.md](federation.md).

## 5. Interoperability principles

Gorilator's moat is the open network, not the code ([strategy.md](strategy.md))
— so other engines and clients implementing our formats is success, not a
threat. The rules:

- **Protocol over implementation.** Every wire format — saves, discovery,
  policy, content events, transfer receipts — gets a versioned, NIP-style spec
  in [federation.md](federation.md) that another engine could implement
  without reading our source. The spec is the contract; the TypeScript is one
  implementation.
- **Standard asset formats.** Models are GLB; binary assets are
  content-addressed Blossom blobs (BUD-01) referenced by absolute URL +
  sha-256 — any Blossom host can serve or mirror them
  ([community-entities.md](community-entities.md)).
- **Namespaced item ids** for cross-server imports, so `gorilator:banana` and
  a fork's `myworld:banana` never collide — and the federation item sanitizer
  can translate or strip with confidence.
- **Version every payload.** Every JSON content document on the wire carries a
  `v` field; readers accept lower versions and fill defaults, forever.
- **Collaborate rather than invent.** Where a NIP or BUD exists, use it:
  NIP-58 badges for achievements, NWC (NIP-47) for payments, kind-0 profiles
  for creator identity, Blossom BUDs for assets. New kinds only where
  semantics genuinely demand them.
- **Allocate before shipping.** Every new kind or `d`-tag lands in the
  [federation.md](federation.md) §8 allocation table *before* it ships — the
  table is the registry, and an undocumented event on a public relay is a spec
  violation.
