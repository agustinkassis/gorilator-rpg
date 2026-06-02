// Single source of truth for tuning values, shared by client + server.

export const ROOM_NAME = "game";

export const TICK_RATE = 20; // server simulation ticks per second
export const SERVER_PORT = 2567;

/** WebSocket close code: the server kicks an old session when the SAME nostr
 *  npub logs in again (the newest login wins). The client shows a tailored
 *  message for this code instead of the generic "disconnected". */
export const NOSTR_TAKEOVER_CODE = 4001;

/** A player's progress is saved to relays as a NIP-78 (kind 30078) app-data
 *  *parameterized replaceable* event. The SERVER signs it with its own key
 *  (`NOSTR_NSEC`), so one author holds every player's save — the `d` tag carries
 *  the player's pubkey (see `saveDTag`) to keep one latest save per player.
 *  Recovered on login; re-published on level-up / death / logout. */
export const NOSTR_SAVE_KIND = 30078;
export const NOSTR_SAVE_D = "gorilator-save-v1";

/** The `d` (identifier) tag for a player's save event: the base id plus the
 *  player's hex pubkey, so the server's single key stores one replaceable save
 *  per player. Client + server must agree, hence it lives in shared. */
export const saveDTag = (pubkey: string): string => `${NOSTR_SAVE_D}:${pubkey}`;

// Movement
export const MOVE_SPEED = 4.5; // world units / second
export const ARRIVE_THRESHOLD = 0.15; // stop when this close to target
export const WORLD_SIZE = 150; // half-extent of the (square) ground plane (≈6× the area of the previous 60)
export const NAV_CELL = 1.5; // pathfinding grid cell size (coarser to stay fast on the bigger map)

// Combat
export const ATTACK_RANGE = 2.2; // how close you must be to land a hit
export const ATTACK_COOLDOWN_MS = 530; // min time between swings (≈ +60% attack speed vs 850)
export const ATTACK_WINDUP_MS = 300; // ATTACK state duration before damage lands
export const HIT_STATE_MS = 350; // how long the HIT reaction plays
export const THROW_STATE_MS = 460; // how long the banana-throw roots the player before they can move again (halved → released 2× sooner)
export const THROW_RELEASE_FRACTION = 0.4; // the banana leaves the hand at this point through the pitch
export const PLAYER_RESPAWN_MS = 8000; // dead -> respawn delay for players (then fade + lightning)
export const DUMMY_RESPAWN_MS = 4000; // dead -> respawn delay for training dummies
export const DAMAGE_DIVISOR = 7; // all computed damage is divided by this

// Health
export const PLAYER_MAX_HP = 100;
export const DUMMY_MAX_HP = 60;

// Stamina (Valheim-style sprint): a bar that refills over time and is spent to
// run faster. Hold SPACE while moving to sprint — +SPRINT_SPEED_MULT speed while
// it drains; empty it and you're "winded" (can't sprint until it recovers past
// the re-engage line). Server-authoritative — the server drains/regens and
// applies the speed boost; the client just reports SPACE held + draws the bar.
export const PLAYER_MAX_STAMINA = 100;
export const SPRINT_SPEED_MULT = 1.55; // +55% move speed while sprinting (run animation matches)
export const STAMINA_DRAIN_PER_SEC = 25; // spent per second while sprinting (≈4s from full)
export const STAMINA_REGEN_PER_SEC = 18; // regained per second once regen resumes (≈5.5s to refill)
export const STAMINA_REGEN_DELAY_MS = 800; // pause before stamina starts coming back after a sprint
export const STAMINA_SPRINT_REENGAGE = 20; // once emptied, must recover to this before sprinting again

// Leveling: characters gain XP from kills and level up on an escalating curve.
export const XP_BASE = 100; // XP to go from level 1 → 2
export const XP_GROWTH = 1.5; // each level needs XP_BASE * level^this
export const HP_PER_LEVEL = 17.25; // maxHp gained per level (+15%, was 15)
export const ATTACK_PER_LEVEL = 3.45; // attack gained per level (+15%, was 3)
export const ARMOR_PER_LEVEL = 2; // armor gained per level
export const CRIT_PER_LEVEL = 0.02; // +2% critical chance per level...
export const CRIT_CHANCE_MAX = 0.6; // ...capped here so it never trivialises combat
export const SPEED_PER_LEVEL = 0.207; // run speed (units/sec) gained per level (+15%, was 0.18)
export const THROW_POWER_PER_LEVEL = 0.07; // +7% banana reach & damage per level
export const DUMMY_XP_REWARD = 12; // XP for killing a training dummy
export const GOBLIN_XP_REWARD = 60; // XP for killing a goblin (+70%, was 35)
export const PLAYER_KILL_XP = 60; // XP for killing another player
export const TREE_XP_REWARD = 8; // XP for chopping down a tree
export const ROCK_XP_REWARD = 14; // XP for mining a boulder
export const DUMMY_LEVEL = 1;
export const GOBLIN_LEVEL = 2;
export const XP_DEATH_PENALTY = 0.3; // on death you lose this fraction of TOTAL XP (de-leveling if it crosses a level boundary)

/** XP required to advance FROM `level` to the next one (escalating). */
export function xpForLevel(level: number): number {
  return Math.round(XP_BASE * Math.pow(Math.max(1, level), XP_GROWTH));
}

/** A character's level-1 base combat stats, scaled up per level by statsForLevel. */
export interface BaseStats {
  maxHp: number;
  attack: number;
  armor: number;
  critChance: number;
}

/**
 * Scale a level-1 base stat block up to `level` using the SAME per-level growth
 * players gain on level-up — so every character's power follows from its level.
 */
export function statsForLevel(base: BaseStats, level: number): BaseStats {
  const n = Math.max(1, level) - 1;
  return {
    maxHp: base.maxHp + n * HP_PER_LEVEL,
    attack: base.attack + n * ATTACK_PER_LEVEL,
    armor: base.armor + n * ARMOR_PER_LEVEL,
    critChance: Math.min(CRIT_CHANCE_MAX, base.critChance + n * CRIT_PER_LEVEL),
  };
}

// Per-hit damage formula (server-authoritative):
//   raw       = attacker.attack * random(1 ± ATTACK_VARIANCE)
//   mitigated = raw * (1 - target.armor / (target.armor + ARMOR_K))
//   on crit (chance = attacker.critChance): damage *= CRIT_MULTIPLIER
export const ATTACK_VARIANCE = 0.25; // ±15% random roll per hit
export const ARMOR_K = 50; // armor mitigation constant (diminishing returns)
export const CRIT_MULTIPLIER = 2.4; // critical-hit damage multiplier (+20%, was 2)
export const CRIT_KNOCKBACK_DISTANCE = 0.3; // a crit blows the target back this far (was 8, −35%, −25%, −30%)

// Default combat stats per entity type.
export const PLAYER_ATTACK = 58; // 2× base, then +20% melee damage (48 → 58)
export const PLAYER_ARMOR = 18;
export const PLAYER_CRIT_CHANCE = 0.2; // 20%
export const DUMMY_ATTACK = 6;
export const DUMMY_ARMOR = 8;
export const DUMMY_CRIT_CHANCE = 0.05;

// Goblins: roaming AI enemies that patrol, chase when you get close, attack in
// melee, and give up the chase once you put enough distance between you.
export const GOBLIN_COUNT = 8; // starting goblin seed (centre guardian + a pack or two); the spawner ramps the rest up to the live cap
export const GOBLIN_PACK_SIZE = 3; // goblins spawn in clustered packs of this many
export const GOBLIN_PACK_SPREAD = 5; // pack-mates spawn within this radius of the pack centre
export const GOBLIN_MAX_HP = 45;
export const GOBLIN_ATTACK = 70; // −10% (was 78) → ~7 dmg/hit after player armor & DAMAGE_DIVISOR
export const GOBLIN_ARMOR = 8;
export const GOBLIN_CRIT_CHANCE = 0; // (goblin hits on players don't crit)
export const GOBLIN_PATROL_SPEED = 2.0; // units/s while wandering
export const GOBLIN_CHASE_SPEED = 3.6; // units/s chasing (well under the player's 4.5, so you can pull away)
export const GOBLIN_AGGRO_RADIUS = 9; // start chasing when a player is this close
export const GOBLIN_DEAGGRO_RADIUS = 16; // give up once the player gets this far away
export const GOBLIN_LEASH = 20; // ...or once chased this far from its home — then it returns
export const GOBLIN_ATTACK_RANGE = 2.3; // melee reach
export const GOBLIN_ATTACK_COOLDOWN_MS = 1540; // min time between swings (−10% attack speed, was 1400)
export const GOBLIN_ATTACK_WINDUP_MS = 500; // ATTACK state before the hit lands
export const GOBLIN_RESPAWN_MS = 4000; // dead → corpse lingers this long, then the goblin is removed (a felled tower-defense wave is consumed, not respawned)
export const GOBLIN_WANDER_RADIUS = 14; // patrol within this of home
export const GOBLIN_SPAWN_RANGE = 110; // goblins scatter within this half-extent

// Tower-defense spawning: goblins spawn on a timer that quickens with more live
// players, and each new goblin's level is rolled between the party's average and
// its top player's level — so the threat scales with party size and progression.
export const GOBLIN_SPAWN_BASE_MS = 5000; // spawn interval with one live player...
export const GOBLIN_SPAWN_MIN_MS = 700; // ...floored here however many join (interval = base / livePlayers)
export const GOBLIN_CAP_BASE = 12; // baseline cap on live goblins...
export const GOBLIN_CAP_PER_PLAYER = 8; // ...plus this many more allowed per live player
export const GOBLIN_SPAWN_NEAR_MIN = 22; // fresh goblins appear at least this far from the player they hunt...
export const GOBLIN_SPAWN_NEAR_MAX = 34; // ...and at most this far (just beyond their give-up range)

// Tower-defense waves: a horde spawns a long march from the home (≈ WAVE_MARCH_SECONDS
// of walking out) and converges on the house, fighting any player that engages them on
// the way. The REST between waves grows each wave (more time to rebuild as it escalates):
// after wave N the gap is BASE + STEP·(N-1), capped at MAX.
export const WAVE_INTERVAL_BASE_MS = 108000; // rest after wave 1 (1.8 min)
export const WAVE_INTERVAL_STEP_MS = 12000; // each successive rest grows by this (0.2 min)
export const WAVE_INTERVAL_MAX_MS = 240000; // cap the growth here (4 min); raise/remove for unbounded
export const WAVE_FIRST_DELAY_MS = 24000; // the very first wave lands at 24s
export const WAVE_SPAWN_SPREAD_MS = 40000; // a wave drips in over this window (first → last)
export const WAVE_MARCH_SECONDS = 30; // a wave spawns this many seconds' walk from home...
export const WAVE_SPAWN_DISTANCE = GOBLIN_CHASE_SPEED * WAVE_MARCH_SECONDS; // ...i.e. this far out (≈108u)
export const WAVE_SPAWN_ARC = Math.PI * 0.7; // the horde fans out across this arc (approaches from ~one side)
export const WAVE_SIZE_BASE = 4; // goblins in the first wave...
export const WAVE_SIZE_PER_PLAYER = 2; // ...plus this many per live defender...
export const WAVE_SIZE_PER_WAVE = 1; // ...plus this many more each successive wave (escalation)
export const WAVE_SIZE_MAX = 30; // hard cap on a single wave
export const GOBLIN_LIVE_CAP = 70; // hold the next wave while this many goblins are already alive (perf + fairness)
export const GOBLIN_HOUSE_DAMAGE = 5; // flat HP a goblin's hit chips off the house
export const HOUSE_REPAIR_MIN_HP = 5; // HP restored by one log, lower roll
export const HOUSE_REPAIR_MAX_HP = 15; // HP restored by one log, upper roll

// Health potions scattered in the world (collected into the inventory).
export const POTION_COUNT = 6; // how many exist at once
export const POTION_HEAL = 90; // HP restored when a potion is consumed from the inventory
export const PICKUP_RADIUS = 1.3; // how close you must walk to grab one
export const POTION_RESPAWN_MS = 7000; // delay before a collected potion is replaced
export const GOBLIN_POTION_DROP_CHANCE = 0.6; // a slain goblin drops a health potion this often
export const GOBLIN_BERSERKER_POTION_DROP_CHANCE = 0.16; // rare berserker flask drop from slain goblins
export const AMBIENT_ITEM_SPAWN_CLEAR_RADIUS = 24; // random pickups stay out of the central player spawn ring

// Trees are choppable resources scattered across the map.
export const TREE_COUNT = 360;
export const TREE_RADIUS = 0.8; // trunk/body footprint a thrown banana collides with
export const TREE_HP = 60;
export const TREE_ARMOR = 6;
export const TREE_CRIT_CHANCE = 0; // can't crit a tree
export const TREE_REGROW_MS = 25000; // a stump regrows into a tree after this
export const TREE_BANANA_DROP_CHANCE = 0.2; // each chop has this chance to drop a banana
export const LOGS_PER_TREE = 1; // logs dropped when a tree is cut
export const LOG_PICKUP_RADIUS = 1.5; // how close to walk to grab a log
export const AUTO_GRAB_RADIUS = 2.2; // walk within this of any item → auto-collected
export const TREE_SPAWN_RANGE = 135; // potions/trees scatter within this half-extent

// Boulders are mineable rocks (drop stone). Tougher than trees.
export const ROCK_COUNT = 135; // how many boulders are scattered across the map
export const ROCK_HP = 560; // 8× tougher (was 70)
export const ROCK_ARMOR = 12;
export const STONE_DROP_DAMAGE = 12; // a mined rock sheds one stone for every this much damage dealt to it
export const ROCK_COLLISION_SCALE = 0.5; // a rock's collision/approach footprint is this fraction of its visual radius (so players can walk right up to it + reach its dropped stones)

// The Viking house on the map origin is a destructible structure: throw bananas
// or stones at it to chip its HP; at 0 it collapses. Footprint ≈ 11u across (see
// the client house model), so a ~5u collision radius covers its walls.
export const HOUSE_HP = 300;
export const HOUSE_COLLISION_RADIUS = 5;
export const TOWER_PROP_NAME = "Meshy_AI_Timberstone_Tow";
export const SACRED_CIRCLE_RADIUS = 8;
export const SACRED_CIRCLE_HEAL_PER_SEC_MIN = 3;
export const SACRED_CIRCLE_HEAL_PER_SEC_MAX = 5;

// When La Crypta falls the realm ends: the world freezes and a countdown runs
// before the next realm spins up with every player respawned from scratch.
export const REALM_RESTART_MS = 10_000; // intermission length (10s)

// Bananas: collectible ammo. Hold a banana's hotkey (Q/W/E/R) to charge a power
// bar, release to throw toward the mouse; the charge sets distance, damage and
// speed. (SPACE is the sprint key — see the Stamina section above.)
export const STARTING_BANANAS = 0; // players now collect bananas in-world instead of spawning with free ammo
export const BANANA_MAX = 60; // max bananas lying on the map at once (6× the original 10)
export const BANANA_RESPAWN_MS = 4000; // delay before a new ambient banana spawns
export const BANANA_SPAWN_RANGE = 135; // scatter half-extent for ambient bananas
export const BANANA_PICKUP_RADIUS = 1.4; // how close to walk to grab one
export const BANANA_MIN_THROW = 4; // a light (low-charge) toss distance
export const BANANA_MAX_THROW = 22; // a full-charge throw distance
export const BANANA_SPREAD = 0.1; // landing deviates up to (distance * this) — small, so throws are accurate
export const BANANA_AIM_RADIUS = 2.5; // aim-assist: throw line must pass this close to a character to lock on
export const BANANA_DAMAGE = 20; // full-charge hit (scales steeply ∝ charge²)
export const BANANA_MIN_DAMAGE = 1; // light-toss hit (charge scales MIN→DAMAGE on a p² curve)
export const BANANA_HIT_RADIUS = 3.0; // how near the landing a character must be to get hit (covers movement)
export const BANANA_FLIGHT_BASE_MS = 220; // thrown-banana flight time = base + dist * per-unit
export const BANANA_FLIGHT_PER_UNIT_MS = 32;

// Stones are throwable too (mined from rocks): heavier than a banana, so a shorter
// reach but a much harder hit — a thrown rock. Unlike a banana it shatters on
// impact (it doesn't drop back as a collectible).
export const STONE_MIN_THROW = 4;
export const STONE_MAX_THROW = 17; // heavier → shorter reach
export const STONE_DAMAGE = 38; // a rock hits far harder than a banana
export const STONE_MIN_DAMAGE = 4;

// Charged-throw tuning (client SPACE-hold power bar).
export const THROW_CHARGE_RISE_MS = 850; // hold time to reach full power
export const THROW_CHARGE_FALL_MS = 9500; // after the peak, power ebbs back down slowly (5× slower)...
export const THROW_CHARGE_FLOOR = 0.2; // ...to this floor if you over-hold

// Chat: max characters per line (server clamps; longer lines are truncated).
export const CHAT_MAX_LEN = 140;

// Inventory (Diablo-style grid).
export const INV_COLS = 10;
export const INV_ROWS = 5;
export const INV_SLOTS = INV_COLS * INV_ROWS;
export const MAX_STACK = 99;

// Berserker Potion: a 1-minute power surge granted once per player per realm.
export const BERSERKER_DURATION_MS = 60_000;   // 60-second buff
export const BERSERKER_SPEED_MULT = 1.5;        // +50% move speed
export const BERSERKER_ATTACK_MULT = 3.0;       // +200% attack (3×)
export const BERSERKER_CRIT_CHANCE_ADD = 0.30;  // +30% crit chance (additive)
export const BERSERKER_CRIT_DAMAGE_MULT = 1.30; // ×1.3 crit damage multiplier
export const BERSERKER_ARMOR_MULT = 2.0;        // +100% armor (2×)
export const BERSERKER_HP_MULT = 2.0;           // 2× max HP (current HP scales proportionally)
export const BERSERKER_SCALE = 1.3;             // client-side: model grows 30% larger
