#!/usr/bin/env node
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const requireFromClient = createRequire(resolve(root, "packages/client/package.json"));
const { Client } = requireFromClient("colyseus.js");
const { finalizeEvent, getPublicKey, nip19 } = requireFromClient("nostr-tools");

const args = parseArgs(process.argv.slice(2));
const endpoint = args.endpoint ?? "ws://localhost:2567";
const roomName = args.room ?? "game";
const name = args.name ?? "ClaudioBrain";
const durationMs = Number(args.duration ?? 180_000);
const tickMs = Number(args.tick ?? 180);
const logDir = resolve(root, args.logDir ?? "test-artifacts/survival-bot");
const fastTraining = Boolean(args.fastTraining);
const useDevTuning = Boolean(args.devTune || fastTraining);
const dryRun = Boolean(args.dryRun);
const resetRealm = Boolean(args.resetRealm);
const useNostr = Boolean(args.nostr);
const stopOnWipe = Boolean(args.stopOnWipe);
const waveTraining = Boolean(args.waveTraining);
const timeScale = Number(args.timeScale ?? 1);

mkdirSync(logDir, { recursive: true });

const cfg = {
  homeGuardRadius: 24,
  homeDangerRadius: 30,
  incomingRadius: 95,
  aggroRadius: 9,
  weakEnemyMaxHp: 240,
  tankEnemyMaxHp: 300,
  attackRange: 2.2,
  enemyAttackRange: 2.3,
  kiteDistance: 13,
  emergencyHpPct: 0.48,
  potionHpPct: 0.86,
  berserkEnemyCount: 2,
  pickupRadius: 2.0,
  gatherRadius: 22,
  throwMin: 4,
  throwMaxStone: 17,
  throwMaxBanana: 22,
  throwPower: 1,
  repairHomePct: 0.72,
  openingDefenseMs: 140_000,
  targetStoneReserve: 16,
  targetPotionReserve: 2,
  healingTower: { x: -11.7, z: -14.1 },
  towerOrbitRadius: 6,
};

const metrics = {
  startedAt: new Date().toISOString(),
  endpoint,
  roomName,
  name,
  ticks: 0,
  kills: 0,
  xpEvents: 0,
  damageDone: 0,
  damageTaken: 0,
  houseDamage: 0,
  heals: 0,
  wipes: 0,
  deaths: 0,
  pickups: 0,
  attacks: 0,
  throws: 0,
  potionsUsed: 0,
  berserksUsed: 0,
  repairs: 0,
  trainingDeletes: 0,
  highestWave: 0,
  lastAction: "",
  events: [],
};

const state = {
  room: null,
  sessionId: "",
  inventory: [],
  lastMoveAt: 0,
  lastAttackAt: 0,
  lastPickupAt: 0,
  lastUseAt: 0,
  lastThrowAt: 0,
  lastSprintState: null,
  lastTargetId: "",
  lastLogAt: 0,
  lastTrainingCleanAt: 0,
  startedAt: Date.now(),
  currentPlan: "boot",
  shouldStop: false,
};

main().catch((err) => {
  console.error("[bot] fatal", err);
  process.exit(1);
});

async function main() {
  if (dryRun) {
    console.log("[bot] dry-run config", JSON.stringify({ endpoint, roomName, name, durationMs, tickMs, fastTraining }, null, 2));
    return;
  }

  const client = new Client(endpoint);
  const joinOptions = useNostr ? await nostrJoinOptions() : { name };
  const room = await client.joinOrCreate(roomName, joinOptions);
  state.room = room;
  state.sessionId = room.sessionId;
  console.log(`[bot] joined ${roomName} as ${name} (${room.sessionId}) at ${endpoint}`);

  bindEvents(room);
  await waitForLocalPlayer(room, room.sessionId, 10_000);

  if (useDevTuning) applyTrainingTuning(room);
  if (resetRealm) {
    safeSend(room, "dev_action", { action: "reset_realm" });
    event("reset-realm", {});
    await sleep(750);
  }
  if (waveTraining) applyWaveTrainingSetup(room);
  if (Number.isFinite(timeScale) && timeScale !== 1) {
    safeSend(room, "dev_time", { scale: timeScale });
    event("time-scale", { scale: timeScale });
  }

  const timer = setInterval(() => step(), tickMs);
  const stopAt = Date.now() + durationMs;
  while (Date.now() < stopAt && room.connection?.isOpen !== false && !state.shouldStop) {
    await sleep(500);
  }
  clearInterval(timer);
  safeSend(room, "sprint", { on: false });
  if (Number.isFinite(timeScale) && timeScale !== 1) safeSend(room, "dev_time", { scale: 1 });
  room.leave();
  writeSummary();
}

function bindEvents(room) {
  room.onMessage("inventory", (slots) => {
    state.inventory = Array.isArray(slots) ? slots : [];
  });
  room.onMessage("damage", (ev) => {
    const me = player();
    const home = house();
    if (ev?.targetId === state.sessionId) metrics.damageTaken += ev.amount ?? 0;
    if (home && ev?.targetId === home.id) metrics.houseDamage += ev.amount ?? 0;
    if (ev?.targetId && ev.targetId !== state.sessionId && (!home || ev.targetId !== home.id)) {
      metrics.damageDone += ev.amount ?? 0;
    }
    if (me && me.hp <= 0) metrics.deaths = Math.max(metrics.deaths, me.deaths ?? metrics.deaths);
  });
  room.onMessage("heal", (ev) => {
    if (ev?.targetId === state.sessionId) metrics.heals += ev.amount ?? 0;
  });
  room.onMessage("xp", (ev) => {
    metrics.xpEvents += 1;
    if (ev?.playerId === state.sessionId && ev.amount >= 60) metrics.kills += Math.floor(ev.amount / 60);
  });
  room.onMessage("banana_throw", () => {});
  room.onMessage("kill", (ev) => {
    if (ev?.killerId === state.sessionId) metrics.kills += 1;
    if (ev?.victimId === state.sessionId) metrics.deaths += 1;
  });
  room.onMessage("wipe", (ev) => {
    metrics.wipes += 1;
    event("wipe", ev);
    if (stopOnWipe) state.shouldStop = true;
  });
  room.onLeave((code) => {
    event("leave", { code });
  });
  room.onError((code, message) => {
    event("error", { code, message });
  });
}

function step() {
  const room = state.room;
  const me = player();
  if (!room || !me) return;

  metrics.ticks += 1;
  metrics.highestWave = Math.max(metrics.highestWave, room.state.waveNumber ?? 0);

  if (waveTraining) suppressNonWaveEnemies();

  if (me.hp <= 0 || me.state === "DEAD") {
    sprint(false);
    state.currentPlan = "dead-wait";
    maybeLog(me);
    return;
  }

  const home = house();
  const enemies = liveEnemies();
  const threat = analyzeThreat(me, home, enemies);

  useSurvivalItems(me, threat);

  if (shouldRetreatToTower(me, threat)) {
    move(cfg.healingTower.x, cfg.healingTower.z, "retreat-healing-tower");
    sprint(me.stamina > 15);
    return;
  }

  if (home && shouldRepairHome(home)) {
    attack(home.id, "repair-home");
    metrics.repairs += 1;
    return;
  }

  const weakTarget = bestEnemyTarget(me, home, enemies.filter((e) => e.maxHp <= cfg.weakEnemyMaxHp), threat);
  const pullTarget = bestPullTarget(me, home, enemies);
  if (weakTarget && shouldPrioritizeWeakKill(me, home, weakTarget, threat)) {
    fightOrKite(me, home, weakTarget, threat);
    return;
  }
  if (pullTarget) {
    pullOrKite(me, home, pullTarget, threat);
    return;
  }

  const target = bestEnemyTarget(me, home, enemies, threat);
  if (target) {
    fightOrKite(me, home, target, threat);
    return;
  }

  const pickup = bestPickup(me, threat);
  if (pickup && threat.incomingEnemies === 0) {
    moveOrPickup(me, pickup);
    return;
  }

  const gather = bestGatherTarget(me, home);
  if (gather) {
    moveOrPickup(me, gather);
    return;
  }

  if (home) {
    orbitHome(me, home);
  }
  maybeLog(me);
}

function useSurvivalItems(me, threat) {
  const hpPct = me.hp / Math.max(1, me.maxHp);
  const potionSlot = findSlot("potion");
  const berserkSlot = findSlot("berserker_potion");
  const now = Date.now();

  if (potionSlot >= 0 && hpPct <= cfg.potionHpPct && now - state.lastUseAt > 900) {
    safeSend(state.room, "use_item", { slot: potionSlot });
    state.lastUseAt = now;
    metrics.potionsUsed += 1;
    action("use-potion");
  }

  if (
    berserkSlot >= 0 &&
    me.berserkerMs <= 0 &&
    threat.weakHomeEnemies >= cfg.berserkEnemyCount &&
    now - state.lastUseAt > 900
  ) {
    safeSend(state.room, "use_item", { slot: berserkSlot });
    state.lastUseAt = now;
    metrics.berserksUsed += 1;
    action("use-berserk");
  }
}

function suppressNonWaveEnemies() {
  const now = Date.now();
  if (now - state.lastTrainingCleanAt < 300) return;
  state.lastTrainingCleanAt = now;
  for (const e of liveEnemies()) {
    if (e.waveNumber > 0) continue;
    safeSend(state.room, "dev_delete", { kind: "enemy", id: e.id });
    metrics.trainingDeletes += 1;
  }
}

function fightOrKite(me, home, target, threat) {
  const d = dist(me, target);
  const hpPct = me.hp / Math.max(1, me.maxHp);
  const nearMe = threat.playerEnemies;
  const isTank = target.maxHp > cfg.tankEnemyMaxHp;
  const shouldKite =
    hpPct <= cfg.emergencyHpPct ||
    nearMe >= 3 ||
    (nearMe >= 1 && hpPct < 0.76 && me.stamina > 20) ||
    (isTank && target.aiTargetId === state.sessionId);

  if (tryThrow(me, target)) return;

  if (isTank) {
    pullOrKite(me, home, target, threat);
    return;
  }

  if (target.maxHp > cfg.tankEnemyMaxHp && target.aiTargetId !== state.sessionId && d <= cfg.attackRange + 0.7) {
    attack(target.id, "tag-tank-pull");
    return;
  }

  if (shouldKite && home) {
    const kite = kitePoint(me, home, target);
    move(kite.x, kite.z, "kite-pull");
    sprint(true);
    return;
  }

  if (d <= cfg.attackRange + 0.7 || (target.aiTargetId === state.sessionId && !shouldKite)) {
    attack(target.id, "attack-goblin");
    sprint(false);
    return;
  }

  if (d > 18 && home) {
    const intercept = interceptPoint(home, target);
    move(intercept.x, intercept.z, "intercept-spawn");
    sprint(me.stamina > 25);
    return;
  }

  attack(target.id, "close-and-attack");
  sprint(me.stamina > 25);
}

function tryThrow(me, target) {
  const now = Date.now();
  if (now - state.lastThrowAt < 900) return false;

  const d = dist(me, target);
  const stoneSlot = findSlot("stone");
  const bananaSlot = findSlot("banana");
  const preferStone =
    target.maxHp <= cfg.weakEnemyMaxHp ||
    target.aiTargetId !== state.sessionId ||
    dist(target, house() ?? cfg.healingTower) < cfg.homeDangerRadius;
  if (preferStone && stoneSlot >= 0 && d >= cfg.throwMin && d <= cfg.throwMaxStone) {
    safeSend(state.room, "throw", { x: target.x, z: target.z, power: cfg.throwPower, item: "stone" });
    state.lastThrowAt = now;
    metrics.throws += 1;
    action("throw-stone");
    return true;
  }
  if (bananaSlot >= 0 && d >= cfg.throwMin && d <= cfg.throwMaxBanana) {
    safeSend(state.room, "throw", { x: target.x, z: target.z, power: cfg.throwPower, item: "banana" });
    state.lastThrowAt = now;
    metrics.throws += 1;
    action("throw-banana");
    return true;
  }
  return false;
}

function shouldRetreatToTower(me, threat) {
  const hpPct = me.hp / Math.max(1, me.maxHp);
  if (hpPct > 0.68) return false;
  if (threat.playerEnemies === 0 && hpPct > 0.38) return false;
  return dist(me, cfg.healingTower) > 2.5;
}

function bestPullTarget(me, home, enemies) {
  if (!home) return null;
  const tanks = enemies.filter((e) =>
    e.maxHp > cfg.tankEnemyMaxHp &&
    (e.aiTargetId === home.id || e.aiTargetId === state.sessionId || dist(e, home) < cfg.homeDangerRadius || dist(e, me) < cfg.aggroRadius + 4)
  );
  if (!tanks.length) return null;
  return tanks
    .map((e) => {
      const dh = dist(e, home);
      const dm = dist(e, me);
      const hittingHome = e.aiTargetId === home.id ? -90 : 0;
      const chasingMe = e.aiTargetId === state.sessionId ? dm < 8 ? -15 : 18 : 0;
      const homePressure = dh < cfg.homeDangerRadius ? -60 : dh < cfg.incomingRadius ? -20 : 0;
      const canTag = dm < cfg.aggroRadius + 3 ? -25 : 0;
      return { e, score: dh * 0.8 + dm * 0.2 + hittingHome + chasingMe + homePressure + canTag };
    })
    .sort((a, b) => a.score - b.score)[0]?.e ?? null;
}

function shouldPrioritizeWeakKill(me, home, target, threat) {
  if (!target) return false;
  if (!home) return true;
  if (target.waveNumber > 0) return true;
  if (dist(target, home) < cfg.incomingRadius) return true;
  if (target.aiTargetId === home.id || target.aiTargetId === state.sessionId) return true;
  return threat.weakHomeEnemies > 0 && dist(me, target) < 18;
}

function pullOrKite(me, home, target, threat) {
  const d = dist(me, target);
  const hpPct = me.hp / Math.max(1, me.maxHp);
  const nearTower = dist(me, cfg.healingTower) <= cfg.towerOrbitRadius + 2;

  if (target.aiTargetId !== state.sessionId) {
    if (tryThrow(me, target)) return;
    if (d <= cfg.attackRange + 0.8 && hpPct > cfg.emergencyHpPct) {
      attack(target.id, "tag-pull-tank");
      return;
    }
    const p = approachAggroPoint(me, target, home);
    move(p.x, p.z, "approach-pull-tank");
    sprint(me.stamina > 25);
    return;
  }

  if (hpPct < 0.9 || threat.playerEnemies > 0 || !nearTower) {
    const p = towerOrbitPoint(me, target);
    move(p.x, p.z, "tower-kite-tank");
    sprint(me.stamina > 18);
    return;
  }

  const weak = bestEnemyTarget(me, home, liveEnemies().filter((e) => e.maxHp <= cfg.weakEnemyMaxHp), threat);
  if (weak) {
    fightOrKite(me, home, weak, threat);
    return;
  }
  const p = towerOrbitPoint(me, target);
  move(p.x, p.z, "hold-tank-aggro");
  sprint(false);
}

function approachAggroPoint(me, target, home) {
  const anchor = dist(target, cfg.healingTower) < dist(target, home) ? cfg.healingTower : home;
  const dx = target.x - anchor.x;
  const dz = target.z - anchor.z;
  const len = Math.hypot(dx, dz) || 1;
  return {
    x: clamp(target.x - (dx / len) * Math.min(cfg.aggroRadius - 1, Math.max(3, dist(target, anchor) - 4))),
    z: clamp(target.z - (dz / len) * Math.min(cfg.aggroRadius - 1, Math.max(3, dist(target, anchor) - 4))),
  };
}

function towerOrbitPoint(me, target) {
  const angle = Math.atan2(me.z - cfg.healingTower.z, me.x - cfg.healingTower.x) + 0.85;
  let x = cfg.healingTower.x + Math.cos(angle) * cfg.towerOrbitRadius;
  let z = cfg.healingTower.z + Math.sin(angle) * cfg.towerOrbitRadius;
  if (target && dist({ x, z }, target) < cfg.enemyAttackRange + 3) {
    const dx = x - target.x;
    const dz = z - target.z;
    const len = Math.hypot(dx, dz) || 1;
    x += (dx / len) * 5;
    z += (dz / len) * 5;
  }
  return { x: clamp(x), z: clamp(z) };
}

function bestEnemyTarget(me, home, enemies, threat) {
  if (enemies.length === 0) return null;
  const weakEnemies = enemies.filter((e) => e.maxHp <= cfg.weakEnemyMaxHp);
  const pool = weakEnemies.length ? weakEnemies : enemies;
  return pool
    .map((e) => {
      const dm = dist(me, e);
      const dh = home ? dist(home, e) : 999;
      const chasingMe = e.aiTargetId === state.sessionId ? -20 : 0;
      const attackingHome = home && e.aiTargetId === home.id ? -35 : 0;
      const homePressure = dh < cfg.homeDangerRadius ? -35 : dh < cfg.incomingRadius ? -16 : 0;
      const opening = Date.now() - state.startedAt < cfg.openingDefenseMs ? -12 : 0;
      const weak = e.hp / Math.max(1, e.maxHp);
      const waveBonus = e.waveNumber > 0 ? -30 : 0;
      const tankPenalty = e.maxHp > cfg.tankEnemyMaxHp ? 180 : 0;
      const tankHomeException = e.maxHp > cfg.tankEnemyMaxHp && home && e.aiTargetId === home.id ? -35 : 0;
      return {
        e,
        score:
          dh * 0.9 +
          dm * 0.18 +
          weak * 8 +
          chasingMe +
          attackingHome +
          homePressure +
          opening +
          waveBonus +
          tankPenalty +
          tankHomeException,
      };
    })
    .sort((a, b) => a.score - b.score)[0]?.e ?? null;
}

function bestPickup(me, threat) {
  const urgentPotion = me.hp / Math.max(1, me.maxHp) < 0.65;
  const candidates = [
    ...values(state.room.state.potions).map((x) => ({ ...x, _kind: x.kind || "potion", _type: x.kind || "potion" })),
    ...values(state.room.state.stones).map((x) => ({ ...x, _kind: "stone", _type: "stone" })),
    ...values(state.room.state.bananas).map((x) => ({ ...x, _kind: "banana", _type: "banana" })),
    ...values(state.room.state.logs).map((x) => ({ ...x, _kind: "log", _type: "log" })),
    ...values(state.room.state.items).map((x) => ({ ...x, _kind: "item", _type: x.type || "item" })),
  ];
  const filtered = candidates.filter((p) => {
    const d = dist(me, p);
    if (urgentPotion && p._type === "potion") return d < 45;
    if (countInventory("stone") < cfg.targetStoneReserve && p._type === "stone") return d < 38;
    return d < cfg.gatherRadius;
  });
  if (filtered.length === 0) return null;
  return filtered
    .map((p) => {
      const priority =
        urgentPotion && p._type === "potion" ? -80 :
        p._type === "berserker_potion" ? -55 :
        p._type === "potion" ? -35 :
        p._type === "stone" ? -30 :
        p._type === "banana" ? -12 :
        p._type === "log" ? -8 : 0;
      return { p, score: dist(me, p) + priority + threat.homeEnemies * 2 };
    })
    .sort((a, b) => a.score - b.score)[0]?.p ?? null;
}

function bestGatherTarget(me, home) {
  const enemies = liveEnemies();
  if (state.room.state.waveActive || enemies.length > 0) return null;
  const stones = countInventory("stone");
  const rock = nearest(me, values(state.room.state.rocks).filter((r) => r.alive !== false && r.hp > 0), stones < cfg.targetStoneReserve ? 55 : 18);
  if (rock && stones < cfg.targetStoneReserve) return { ...rock, _kind: "rock", id: rock.id };
  const tree = nearest(me, values(state.room.state.trees).filter((t) => t.alive !== false && t.hp > 0), 14);
  if (tree && countInventory("log") < 3) return { ...tree, _kind: "tree", id: tree.id };
  if (home) {
    const nearRock = nearest(home, values(state.room.state.rocks).filter((r) => r.alive !== false && r.hp > 0), 32);
    if (nearRock && countInventory("stone") < 4) return { ...nearRock, _kind: "rock", id: nearRock.id };
  }
  return null;
}

function moveOrPickup(me, obj) {
  const d = dist(me, obj);
  if (obj._kind === "rock" || obj._kind === "tree") {
    attack(obj.id, `gather-${obj._kind}`);
    return;
  }
  if (d <= cfg.pickupRadius) {
    safeSend(state.room, "pickup", { id: obj.id });
    state.lastPickupAt = Date.now();
    metrics.pickups += 1;
    action(`pickup-${obj._type || obj._kind}`);
    return;
  }
  safeSend(state.room, "pickup", { id: obj.id });
  state.lastPickupAt = Date.now();
  sprint(me.stamina > 30);
  action(`go-pickup-${obj._type || obj._kind}`);
}

function orbitHome(me, home) {
  const angle = Math.atan2(me.z - home.z, me.x - home.x) + 0.7;
  const radius = 10 + ((metrics.ticks / 20) % 8);
  move(home.x + Math.cos(angle) * radius, home.z + Math.sin(angle) * radius, "patrol-home");
  sprint(false);
}

function kitePoint(me, home, target) {
  const hx = me.x - home.x;
  const hz = me.z - home.z;
  const hlen = Math.hypot(hx, hz) || 1;
  const tx = -hz / hlen;
  const tz = hx / hlen;
  let x = me.x + tx * cfg.kiteDistance;
  let z = me.z + tz * cfg.kiteDistance;
  const dh = Math.hypot(x - home.x, z - home.z);
  if (dh > cfg.homeGuardRadius) {
    const ux = (x - home.x) / dh;
    const uz = (z - home.z) / dh;
    x = home.x + ux * cfg.homeGuardRadius;
    z = home.z + uz * cfg.homeGuardRadius;
  }
  return { x: clamp(x), z: clamp(z) };
}

function interceptPoint(home, target) {
  const dx = target.x - home.x;
  const dz = target.z - home.z;
  const len = Math.hypot(dx, dz) || 1;
  const radius = Math.min(34, Math.max(16, len - 10));
  return {
    x: clamp(home.x + (dx / len) * radius),
    z: clamp(home.z + (dz / len) * radius),
  };
}

function shouldRepairHome(home) {
  if (!home || home.maxHp <= 0) return false;
  const hpPct = home.hp / home.maxHp;
  if (hpPct > cfg.repairHomePct) return false;
  const enemies = liveEnemies();
  const closeWeak = enemies.some((e) => e.maxHp <= cfg.weakEnemyMaxHp && dist(e, home) < 12);
  if (closeWeak && hpPct > 0.42) return false;
  return countInventory("log") > 0;
}

function analyzeThreat(me, home, enemies) {
  let homeEnemies = 0;
  let weakHomeEnemies = 0;
  let playerEnemies = 0;
  let houseAttackers = 0;
  let incomingEnemies = 0;
  for (const e of enemies) {
    if (home && dist(e, home) <= cfg.homeDangerRadius) homeEnemies += 1;
    if (home && e.maxHp <= cfg.weakEnemyMaxHp && dist(e, home) <= cfg.homeDangerRadius) weakHomeEnemies += 1;
    if (home && dist(e, home) <= cfg.incomingRadius) incomingEnemies += 1;
    if (dist(e, me) <= cfg.enemyAttackRange + 2.2 || e.aiTargetId === state.sessionId) playerEnemies += 1;
    if (home && e.aiTargetId === home.id) houseAttackers += 1;
  }
  return { homeEnemies, weakHomeEnemies, playerEnemies, houseAttackers, incomingEnemies };
}

function attack(targetId, label) {
  const now = Date.now();
  if (state.lastTargetId === targetId && now - state.lastAttackAt < 450) return;
  safeSend(state.room, "attack", { targetId });
  state.lastTargetId = targetId;
  state.lastAttackAt = now;
  metrics.attacks += 1;
  action(label);
}

function move(x, z, label) {
  const now = Date.now();
  if (now - state.lastMoveAt < 350) return;
  safeSend(state.room, "move", { x: clamp(x), z: clamp(z) });
  state.lastMoveAt = now;
  action(label);
}

function sprint(on) {
  if (state.lastSprintState === on) return;
  safeSend(state.room, "sprint", { on });
  state.lastSprintState = on;
}

function safeSend(room, type, payload) {
  try {
    room?.send(type, payload);
  } catch (err) {
    event("send-error", { type, message: err?.message ?? String(err) });
  }
}

function applyTrainingTuning(room) {
  const tune = fastTraining
    ? {
        waveFirstDelayMs: 12_000,
        waveIntervalBaseMs: 16_000,
        waveIntervalStepMs: 4_000,
        waveSpawnSpreadMs: 2_500,
        waveSizeBase: 2,
        waveSizePerWave: 1,
        goblinLiveCap: 24,
      }
    : {};
  for (const [key, value] of Object.entries(tune)) {
    safeSend(room, "dev_tune", { key, value });
  }
  if (Object.keys(tune).length) event("training-tune", tune);
}

function applyWaveTrainingSetup(room) {
  const kit = [
    ["stone", 24],
    ["potion", 4],
    ["berserker_potion", 2],
    ["log", 8],
  ];
  for (const [type, amount] of kit) {
    safeSend(room, "dev_give_item", { type, amount });
  }
  event("wave-training", {
    suppresses: "non-wave enemies only",
    starterKit: Object.fromEntries(kit),
  });
}

function player() {
  return state.room?.state?.players?.get(state.sessionId) ?? null;
}

function house() {
  return values(state.room?.state?.houses)[0] ?? null;
}

function liveEnemies() {
  return values(state.room?.state?.enemies).filter((e) => e.kind === "goblin" && e.hp > 0 && e.state !== "DEAD");
}

function values(map) {
  if (!map) return [];
  const out = [];
  map.forEach((value, id) => {
    if (value && !value.id) value.id = id;
    out.push(value);
  });
  return out;
}

function nearest(origin, list, maxDist = Infinity) {
  let best = null;
  let bd = maxDist;
  for (const item of list) {
    const d = dist(origin, item);
    if (d < bd) {
      best = item;
      bd = d;
    }
  }
  return best;
}

function dist(a, b) {
  return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0));
}

function clamp(v) {
  return Math.max(-150, Math.min(150, v));
}

function findSlot(type) {
  return state.inventory.findIndex((slot) => slot?.type === type && slot.count > 0);
}

function countInventory(type) {
  return state.inventory.reduce((n, slot) => n + (slot?.type === type ? slot.count || 0 : 0), 0);
}

function action(label) {
  state.currentPlan = label;
  metrics.lastAction = label;
}

function event(type, data = {}) {
  const item = { t: Math.round((Date.now() - state.startedAt) / 1000), type, data };
  metrics.events.push(item);
  if (metrics.events.length > 80) metrics.events.shift();
  console.log("[bot:event]", JSON.stringify(item));
}

function maybeLog(me) {
  const now = Date.now();
  if (now - state.lastLogAt < 3000) return;
  state.lastLogAt = now;
  const h = house();
  console.log(
    `[bot] t=${Math.round((now - state.startedAt) / 1000)}s wave=${state.room.state.waveNumber}` +
      ` hp=${Math.round(me.hp)}/${Math.round(me.maxHp)} xp=${Math.round(me.xp)} ` +
      `home=${h ? `${Math.round(h.hp)}/${Math.round(h.maxHp)}` : "down"} ` +
      `enemies=${liveEnemies().length} inv=${inventorySummary()} action=${state.currentPlan}`,
  );
}

function inventorySummary() {
  const counts = {};
  for (const slot of state.inventory) {
    if (slot?.type && slot.count > 0) counts[slot.type] = (counts[slot.type] ?? 0) + slot.count;
  }
  return Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(",") || "-";
}

function writeSummary() {
  const me = player();
  const h = house();
  const summary = {
    ...metrics,
    finishedAt: new Date().toISOString(),
    runtimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    finalPlayer: me
      ? { hp: me.hp, maxHp: me.maxHp, level: me.level, xp: me.xp, deaths: me.deaths, x: me.x, z: me.z }
      : null,
    finalHome: h ? { hp: h.hp, maxHp: h.maxHp, alive: h.alive, x: h.x, z: h.z } : null,
    finalInventory: state.inventory,
  };
  const file = resolve(logDir, `survival-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log("[bot] summary", file);
  console.log(JSON.stringify(summary, null, 2));
}

async function nostrJoinOptions() {
  const raw = process.env.NOSTR_EVENT_ROUTER_NSEC || process.env.NOSTR_NSEC || "";
  if (!raw) throw new Error("--nostr requires NOSTR_EVENT_ROUTER_NSEC or NOSTR_NSEC in env");
  const sk = raw.startsWith("nsec")
    ? nip19.decode(raw).data
    : /^[0-9a-f]{64}$/i.test(raw)
      ? Uint8Array.from(raw.match(/../g).map((h) => parseInt(h, 16)))
      : null;
  if (!sk) throw new Error("unsupported Nostr secret format");
  const pubkey = getPublicKey(sk);
  const base = endpoint.replace(/^ws/, "http");
  const res = await fetch(`${base}/nostr/challenge`);
  if (!res.ok) throw new Error(`challenge failed: ${res.status}`);
  const { challenge } = await res.json();
  const auth = finalizeEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["challenge", challenge],
      ["app", "gorilator"],
      ["relay", base],
    ],
    content: "Authenticate to Gorilator",
  }, sk);
  return {
    name,
    nostr: { auth },
    profile: undefined,
    pubkey,
  };
}

async function waitForLocalPlayer(room, sessionId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (room.state?.players?.get(sessionId)) return;
    await sleep(100);
  }
  throw new Error("local player did not appear in state");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}
