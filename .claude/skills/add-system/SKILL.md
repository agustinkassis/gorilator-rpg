---
name: add-system
description: Add a new server simulation system (combat-like, movement-like, spawning, regen, etc.) to the 20Hz tick. Use when a request needs new server-side behavior beyond what content manifests can express.
---

# Add a server system

First decide the tier: if this is a reusable/optional behavior, write it as a **plugin system** (`/add-plugin`, `registerSystem`) instead of a core system — same shape, no core edits.

For a core system:

1. Create `packages/server/src/systems/<name>.ts` exporting a **pure function over state**: `export function <name>System(state: GameState, dt: number): void`. Use `movement.ts` or `stamina.ts` as the template. No I/O, no timers — the tick drives everything.
2. Register it in the tick: `packages/server/src/rooms/GameRoom.ts` → `setSimulationInterval` body, wrapped in a span so it shows in F3 + `/api/perf`:
   `perfTracker.span("<name>", () => <name>System(this.state, dt));`
   Insert in dependency order (e.g. after `movement` if it reads positions).
3. New synced fields? Add `@type` decorators in `packages/shared/src/schema/*`, then `pnpm build:shared` and a client **hard reload**.
4. Tunables go in `packages/shared/src/constants.ts`; live-tweakable knobs additionally in `systems/devTuning.ts`.
5. Add a characterization test `packages/server/src/systems/<name>.test.ts` (hand-built `GameState`, fixed `dt` — see `combat.test.ts`). Run `pnpm test`.
6. Verify cost: `pnpm bench` — the new span appears as `tag:<name>`; keep idle cost ≈0ms.
