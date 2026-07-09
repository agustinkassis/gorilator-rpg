# Persistence First Tasks

These are the Phase 2 persistence slices from `ROADMAP.md`, shaped as testable
task cards for the dev dashboard. The global dashboard reads
`.gorilator/test-plan.json` and shows these in its kanban board.

Feature Lab scenarios:

```bash
pnpm scenario persistence-default
pnpm scenario persistence-legacy-wipe
```

## P2-01 Realm Policy Module

Purpose: `realm.json` can define death and progression policy without forks
editing `packages/*/src`.

Evidence:
- `packages/server/src/systems/policy.ts` sanitizes partial/invalid policy input.
- `packages/server/src/systems/realm.ts` calls `setRealmPolicy()` from
  `applyRealmConfig()`.

Test:

```bash
corepack pnpm --filter @rpg/server test policy.test.ts
```

Dashboard check:
- Open `http://localhost:5173/`.
- Open the lower-left worktree panel.
- Confirm `P2-01 Realm policy module` appears under `Test tasks`.

## P2-02 Configurable Death Penalty

Purpose: normal combat deaths obey `death.mode`: `none`, `xp-penalty`, or
`hardcore`.

Evidence:
- `applyDeathXpPenalty()` uses `realmPolicy().death`.
- Player deaths from melee, throws, and goblin hits call `applyDeathXpPenalty()`.

Test:

```bash
corepack pnpm --filter @rpg/server test leveling.test.ts combat.test.ts
```

Manual dev check:
- Join the dev game at `http://localhost:5173/?mocknostr=gen`.
- Use Dev Mode to level up, then die to a hostile enemy.
- Change `realm.json` policy and restart the server to compare modes.

## P2-03 Wipe Decoupling

Purpose: when La Crypta falls, the world resets but the character persists by
default.

Evidence:
- `resetPlayerForNewRealm()` preserves progression when
  `persistAcrossWipes=true`.
- `GameRoom.startNewRealm()` keeps or resets inventory according to
  `keepInventoryOnWipe`.

Test:

```bash
pnpm --filter @rpg/server test realmLifecycle.test.ts
```

Feature Lab check:
- In the dashboard, click Test on `P2-03 Wipe decoupling`.
- It boots `scenarios/persistence-default.json`.
- Join the scenario, give yourself items and levels from Dev Mode, collapse La
  Crypta, and confirm stats/inventory follow policy.

## P2-04 Save On Realm End

Purpose: verified Nostr players are saved with reason `realm-end` before the
forced defeat death mutates HP/state.

Evidence:
- `GameRoom.endRealm()` calls `persistSave(sid, p, "realm-end")` before setting
  players to `DEAD`.
- `buildServerSave()` snapshots player stats and inventory into a server-signed
  Nostr save payload.

Test:

```bash
corepack pnpm --filter @rpg/server test nostrSave.test.ts
```

Manual dev check:
- Start with a stable `NOSTR_NSEC` if you want saves to survive server restarts.
- Join with `?mocknostr=gen`, level/give items, collapse La Crypta, and watch
  server logs for `saved ... (realm-end)`.

## P2-05 Policy-Aware Wipe Banner

Purpose: the client defeat copy tells players whether the realm reset preserves
their character or performs the legacy full wipe.

Evidence:
- Server broadcasts `wipe` with `{ wave, persist }`.
- Client wipe/intermission UI branches on `persist`.

Feature Lab test:

```bash
pnpm scenario persistence-legacy-wipe
```

Then:
- In the dashboard, click Test on `P2-05 Policy-aware wipe banner`.
- It boots `scenarios/persistence-legacy-wipe.json`.
- Join the scenario, collapse La Crypta, and confirm the banner warns about the
  legacy level-1 reset. Use `P2-03` for the persistent copy comparison.
