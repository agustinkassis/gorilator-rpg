# Scenarios — Feature Lab isolated test maps

A scenario is a JSON manifest that stages **one feature** on an isolated,
single-player-by-default test map: world entities, player loadout/stats,
system toggles, tuning overrides, timeScale acceleration, and scripted bots.
Full design: [docs/feature-lab.md](../docs/feature-lab.md).

## Run one

```bash
pnpm scenario <name>      # boots the dev stack with scenarios/<name>.json layered in
# then open the printed link — it auto-joins single-player:
#   http://localhost:<client-port>/?scenario=<name>&autojoin=<bot-name>
```

- The server reads `GORILATOR_SCENARIO` (set by the runner); on open dev
  servers the `?scenario=` URL param also selects it for a fresh room.
- The Dev Mode gameplay panel pins the manifest's `tuning` keys in a
  **Scenario tweaks** section — tune on sliders, then **Bake values** writes
  them to `realm.json`.
- `GET /api/status` reports `activeScenario` + the RNG `cycleSeed`; pin `seed`
  in the manifest (or `GORILATOR_SEED`) for fully reproducible runs.

## Manifest shape

```jsonc
{
  "name": "my-feature",
  "description": "What this stages, in one line.",
  "seed": 1234,                                   // optional: pin the cycle RNG
  "world": {
    "resources": [{ "type": "tree", "x": 5, "z": 5 }],          // v1: tree | rock | bush
    "groundItems": [{ "item": "banana", "x": 2, "z": 0, "count": 5 }],
    "npcs": [{ "defId": "gorila", "x": -4, "z": 3, "brain": "passive_patrol" }],
    "enemies": [{ "kind": "goblin", "x": 8, "z": 0, "level": 1 }]
  },
  "player": {
    "loadout": [{ "item": "potion", "count": 3 }], // replaces the starter inventory
    "stats": { "level": 5, "maxHp": 200 },         // whitelisted Player fields
    "position": { "x": 0, "z": 0 }
  },
  "systems": { "events": false },                  // realm event module (default: off)
  "tuning": { "enemyMaxHp": 20 },                  // any DevTuningKey → pinned tweaks
  "tweaks": ["enemyAttack"],                       // optional extra pinned knobs
  "timeScale": 2,                                  // 0..16 accelerated simulation
  "bots": [{ "behavior": "aggro", "count": 1 }]    // scripted players (self-tests)
}
```

## Shipped scenarios

| Manifest | Stages |
| --- | --- |
| `baseline.json` | An empty sandbox (events off) — the e2e/bot smoke stage. |
| `hunger.json` | Hunger drain + food use with a cranberry bush resource near spawn. |
| `death-penalty-l10.json` | A level-10 player and close goblin pack for visual XP-loss/de-level testing. |
| `wave-siege.json` | The La Crypta Defense event with the difficulty knobs pinned (#64). |
| `bot-arena.json` | The bot driver's own self-test: an aggro bot clears staged goblins, a loot bot collects the drops. |

Every roadmap feature ships with its own manifest here — that's item 2 of the
Definition of Done (code · scenario · bot self-test · tweak knobs · docs).
