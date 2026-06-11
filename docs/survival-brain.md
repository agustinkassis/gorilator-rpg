# Survival Brain Notes

This is the first headless automation pass for learning how to defend La Crypta.
It connects directly to the Colyseus room, reads authoritative state, and sends
the same player intents as the browser client.

Script:

```bash
pnpm bot:survive --name ClaudioBrain --duration 180000
```

Fast training mode compresses waves so iteration is faster:

```bash
pnpm bot:survive --name ClaudioBrain --duration 70000 --fastTraining
```

Wave training mode isolates the tower-defense wave problem by suppressing
non-wave spawner enemies and giving the bot a small prep kit:

```bash
pnpm bot:survive \
  --name ClaudioBrain \
  --duration 60000 \
  --tick 60 \
  --fastTraining \
  --waveTraining \
  --resetRealm \
  --timeScale 3
```

## Current Brain

The bot watches:

- player HP, stamina, XP, level, and berserker timer
- La Crypta HP
- wave number and wave activity
- live enemies
- potions, berserker potions, stones, bananas, logs
- inventory updates
- damage, heal, XP, kill, and wipe events

Current priorities:

1. Drink a health potion under the HP threshold.
2. Drink berserker when the home is under pressure and enough enemies are nearby.
3. Kill weak wave enemies before they touch La Crypta.
4. Tag high-HP tanks once and kite them from the healing tower instead of trading.
5. Throw stones or bananas at far targets to pull aggro or finish weak enemies.
6. Retreat to the healing tower before HP gets critical.
7. Repair La Crypta with logs only when the center is not collapsing.
8. Pick up useful drops.
9. Gather stones/logs only when there is no immediate pressure.
10. Patrol close to La Crypta while waiting.

## Strategy Learned So Far

The key is not just killing. The bot must keep enemies from hitting La Crypta.

Useful behavior:

- Prioritize enemies closest to La Crypta over enemies closest to the player.
- Hit enemies to pull aggro, then kite inside the defensive radius.
- Do not kite too far away: if the player leaves the defensive area, enemies return
  to attacking La Crypta.
- Use potions early enough, not only at critical HP.
- Berserker should be used during enemy concentration, not saved too long.
- Stones are valuable for ranged pulls and burst damage, but mining rocks during
  pressure is too slow.
- Gathering should happen only during calm windows.
- Logs matter because attacking the damaged house with logs repairs it, but the
  current bot rarely gets logs before pressure starts.
- Repairing is not a substitute for peeling enemies. Runs that spent too many
  actions repairing still wiped on wave 6-7. Winning runs killed fast, stayed
  alive, and did not need to repair.
- The authored map currently has dev spawners that create 2000 HP enemies. A solo
  survival bot cannot fairly treat those like normal wave goblins. In real mode
  it must tag/pull them; in wave training they are suppressed so the wave brain can
  be measured separately.

## Iteration Log

### Run 1: Fast Training

Command:

```bash
node scripts/survival-bot.mjs --name ClaudioBrain-1 --duration 70000 --fastTraining
```

Result:

- Wipe at wave 1.
- Highest wave: 2 after new realm restart.
- Damage done: 311.
- XP: 60.
- House damage: 323.

Finding:

The first brain kited too much and failed to hold pressure off La Crypta.

### Run 2: Fast Training

Command:

```bash
node scripts/survival-bot.mjs --name ClaudioBrain-2 --duration 70000 --fastTraining
```

Changes:

- Reduced kiting frequency.
- Increased home danger radius.
- Stopped gathering while enemies pressured the home.

Result:

- Wipe at wave 2.
- Damage done: 1704.
- XP events: 20.
- Final level: 4.
- House damage: 305.

Finding:

Much better damage and progression, but La Crypta still died. The bot fought more,
but still needs stronger home defense and better repair/gather timing.

### Run 3: Normal Timing

Command:

```bash
node scripts/survival-bot.mjs --name ClaudioBrain-default --duration 100000
```

Result:

- Killed enough enemies for 780 XP equivalent by XP events.
- Estimated goblin kills: 13.
- Final level: 3.
- Final XP: 217.
- Potions held: 3.
- A wipe occurred in the initial realm before the script stabilized, then the bot
  recovered in the next realm.
- Final La Crypta state after restart: 285/300 HP.

Finding:

On normal timing, the combat brain can farm and survive. The main failure is the
opening defense window: it needs to immediately classify all existing attackers,
pull them off La Crypta, and avoid spending early time gathering.

### Run 4: Real Map Smoke After Pull Logic

Command:

```bash
node scripts/survival-bot.mjs --name ClaudioBrain-smoke-v5 --duration 130000 --fastTraining --resetRealm --stopOnWipe
```

Result:

- Wipe at wave 1.
- Player died at ~29s.
- Live enemies reached 30+.
- House damage: 300.
- Kills: 1.

Finding:

The real authored map is currently dominated by non-wave spawners, including
multiple 2000 HP enemies and frequent model-template spawns. This is useful as a
stress test, but it hides whether the wave-defense brain itself is improving.

### Run 5: Wave Training Smoke

Command:

```bash
node scripts/survival-bot.mjs --name ClaudioBrain-wave-smoke --duration 150000 --fastTraining --waveTraining --resetRealm --stopOnWipe
```

Result:

- Highest wave: 6.
- Kills: 32.
- Player deaths: 0.
- Wipes: 0.
- La Crypta: 298/300.
- Final level: 5.

Finding:

Once non-wave spawners are isolated, the core wave brain works. It can clear
waves, level up, use the healing tower, and protect La Crypta.

### Run 6: Accelerated 20-Iteration Training Batch

Command:

```bash
mkdir -p test-artifacts/survival-bot/batch-20-waveTraining-v6
for i in $(seq -w 1 20); do
  node scripts/survival-bot.mjs \
    --name ClaudioBrain-v6-$i \
    --duration 60000 \
    --tick 60 \
    --fastTraining \
    --waveTraining \
    --resetRealm \
    --timeScale 3 \
    --logDir test-artifacts/survival-bot/batch-20-waveTraining-v6
done
```

Aggregate result:

- Iterations: 20.
- Minimum wave reached: 6.
- Maximum wave reached: 7.
- Average wave reached: 6.85.
- Average kills: 31.15.
- Best kills: 40.
- Runs with La Crypta still alive at the end: 14/20.
- Wipes: 6/20.
- Runs where the player died at least once: 7/20.
- Average final La Crypta HP, counting wipes as 0: 172.8/300.

Best run:

- Iteration: 12.
- Wave: 7.
- Kills: 40.
- Wipes: 0.
- Deaths: 0.
- La Crypta: 239/300.
- Damage done: 4749.
- Throws: 35.
- Potions used: 3.
- Berserks used: 5.
- Level: 5.
- XP: 697.
- Log: `test-artifacts/survival-bot/batch-20-waveTraining-v6/survival-1781128713245.json`.

Learned behavior:

- The winning profile is aggressive early clear, not late repair.
- Runs with 35-40 kills usually ended with La Crypta alive and the player alive.
- Wipe runs often showed high repair counts. That means repair was happening after
  the fight was already lost.
- Stone throws are effective: best runs used roughly 30-40 throws.
- Potions should be used, but if potion usage spikes into double digits the bot is
  usually already losing tempo.
- The next improvement is a stricter wave 6+ rule: stay closer to the house, stop
  chasing far enemies, and repair only after nearby weak enemies are cleared.

## Next Improvements

- Add a late-wave discipline mode for wave 6+:
  - shrink patrol radius
  - stop chasing enemies far from the house
  - prioritize central peel over XP
  - repair only when no weak enemies are within the danger radius
- Improve real-map mode against authored 2000 HP spawners:
  - never commit to killing tanks
  - tag once, pull to healing tower, and keep them away from La Crypta
  - optionally expose a server-side training toggle for spawner pressure instead
    of deleting non-wave enemies from the bot
- Add rock mining only after wave clear and only near home. The 560 HP boulders are
  too slow to mine under pressure.
- Add structured per-run scoring:
  - waves survived
  - goblins killed
  - La Crypta minimum HP
  - player deaths
  - potion efficiency
  - time enemies spent targeting house vs player
- Add replay logs with second-by-second decisions for learning.
