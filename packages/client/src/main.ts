import { Engine } from "@babylonjs/core";
import { createScene } from "./scene/createScene";
import { applyOrthoSize } from "./scene/camera";
import { CharacterFactory } from "./entities/CharacterFactory";
import { preloadBanana } from "./entities/models/banana";
import { preloadBerserkerPotion } from "./entities/models/berserkerPotion";
import { loadHouse } from "./entities/models/house";
import { PropManager } from "./dev/PropManager";
import { CharacterManager } from "./dev/CharacterManager";
import { CharacterImporter } from "./dev/CharacterImporter";
import { AnimationTester } from "./dev/AnimationTester";
import { DevMode, frontOfPlayer } from "./dev/DevMode";
import { PropImporter } from "./ui/propImporter";
import { HUD } from "./ui/hud";
import { HealthGlobe } from "./ui/healthGlobe";
import { XpBar } from "./ui/xpBar";
import { StaminaBar } from "./ui/staminaBar";
import { CharacterSheet } from "./ui/characterSheet";
import { PlayerBadge } from "./ui/playerBadge";
import { InventoryUI } from "./ui/inventory";
import { HotkeyBar } from "./ui/hotkeyBar";
import { Minimap } from "./ui/minimap";
import { ChatLog } from "./ui/chat";
import { CharacterDebugWindow } from "./ui/characterDebug";
import { DebugStats } from "./ui/debugStats";
import { Game } from "./game/Game";
import { AudioManager } from "./audio/AudioManager";
import { AudioControls } from "./ui/audioControls";
import { HomeBar } from "./ui/homeBar";
import { GameMenu } from "./ui/gameMenu";
import { NetworkClient, type NetHandlers } from "./net/NetworkClient";
import { preloadMouseCursors, setupClickToMove } from "./input/ClickToMove";
import { setupSprint } from "./input/Sprint";
import { SplashScreen } from "./ui/splash";
import { TOWER_PROP_NAME } from "@rpg/shared";
import { PerfTracker } from "./perf/PerfTracker";
import { attachBabylonProbes } from "./perf/babylonProbes";
import { PerfOverlay } from "./perf/overlay";
import { buildResourceBreakdown, buildRenderProfile } from "./perf/breakdown";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const respawnOverlay = document.getElementById("respawnOverlay") as HTMLDivElement;
const respawnCountdownEl = document.getElementById("respawnCountdown") as HTMLDivElement;
const realmOverlay = document.getElementById("realmOverlay") as HTMLDivElement;
const realmCountdownEl = document.getElementById("realmCountdown") as HTMLDivElement;

// Tiny always-on version tag (bottom-right). __APP_VERSION__ is replaced at build
// time by Vite with the package.json version (see vite.config.ts).
const versionEl = document.getElementById("versionTag");
if (versionEl) versionEl.textContent = `v${__APP_VERSION__}`;

// DEV-only: `?mocknostr=gen|nsec1…|<hex>` installs a fake NIP-07 signer so the
// Nostr login flow can be tested without a browser extension. Installed up-front
// (before the splash) so window.nostr is ready when "Login with Nostr" is clicked.
if (import.meta.env.DEV) {
  const mockArg = new URLSearchParams(location.search).get("mocknostr");
  if (mockArg) void import("./net/nostrMock").then((m) => m.installMockSigner(mockArg));
}

const engine = new Engine(canvas, true, { stencil: true }, true);
const { scene, camera, ground, shadow } = createScene(engine);

const factory = new CharacterFactory(scene);
const hud = new HUD(scene);
const globe = new HealthGlobe();
const xpBar = new XpBar();
const staminaBar = new StaminaBar();
const characterSheet = new CharacterSheet();
const playerBadge = new PlayerBadge();
const homeBar = new HomeBar(); // siege objective HUD (home HP + wave); hidden on the splash via CSS
const game = new Game(camera, factory, hud, shadow);
const debugStats = new DebugStats(engine, scene);
// Sound system: spatial SFX + music. Unlocks itself on the first user gesture
// (the splash "ENTER" click), so it's safe to build up-front.
const audio = new AudioManager();
game.setAudio(audio);
const net = new NetworkClient();

// Performance tracking: Babylon probes feed the tracker each frame (FPS, draw
// calls, meshes, triangles always; CPU+GPU frame time + heap while the overlay or
// a benchmark is active). Toggle the on-screen HUD with F3 or `?perf`; drive it
// from the console via window.__perf (see docs/performance.md).
const perf = new PerfTracker();
const perfProbes = attachBabylonProbes(engine, scene, perf);
const perfOverlay = new PerfOverlay(perf, perfProbes, net.httpBase());
// "What's heavy" drill-down + FPS-dip culprit capture: render load + elements come
// from the live scene, entities from the game's per-category counts; reasons are the
// perf spans (incl. the scene.render sub-phases). The render profile pairs those
// with the probe's engine sub-phase timings for a deep, saveable snapshot.
perf.setBreakdownProvider(() => buildResourceBreakdown(scene, game.debugStats(), perf.latest()));
perf.setRenderProfileProvider(() => buildRenderProfile(scene, perfProbes.renderPhases(), perf.latest(), perf.meta));
(window as Window & { __perf?: unknown }).__perf = perf;
if (new URLSearchParams(location.search).has("perf")) perfOverlay.toggle();

const inventory = new InventoryUI(
  (from, to) => net.sendInventoryMove(from, to),
  (slot) => net.sendUseItem(slot),
);
const hotkeyBar = new HotkeyBar((slot) => net.sendUseItem(slot));
const minimap = new Minimap(net); // top-left radar + hold TAB / Map button for the big map
const chat = new ChatLog((text) => net.sendChat(text)); // Enter to chat (right-side log)
// Esc menu: resume, hotkeys, sound/graphics settings, login-with-Nostr, kill-yourself, exit.
new GameMenu({
  net,
  audio,
  engine,
  shadow,
  isNostrVerified: () => !!(game.localId && net.room?.state.players.get(game.localId)?.nostrVerified),
});

// Imported-prop registry (loads props.json into the world). In dev builds it also
// backs Dev Mode, the in-game world editor (toggle with the button or ` backtick).
const propManager = new PropManager(scene, shadow);
// Placed custom characters (imported Meshy zips) — loads npcs.json + renders them.
const characterManager = new CharacterManager(scene, shadow);
minimap.setProps(propManager); // so the map can icon imported trees/rocks/concrete props
const devMode = import.meta.env.DEV ? new DevMode(scene, ground, net, propManager) : null;
devMode?.setCharacterManager(characterManager); // placed characters are selectable/draggable in Dev Mode
devMode?.setGame(game); // library explorer can select + camera-focus world entities

setupClickToMove({
  scene,
  ground,
  net,
  pickTargetAt: game.pickTargetAt,
  onMoveTo: (point) => {
    hud.showClickMarker(point);
  },
  onSelectTarget: (id) => game.flashSelectTarget(id), // flash the picked target white
  // a banana/stone is thrown by holding its assigned hotkey (Q/W/E/R)
  throwItemForKey: (key) => hotkeyBar.throwItemForKey(key),
  dev: devMode
    ? {
        isActive: devMode.isActive,
        pointerDown: devMode.pointerDown,
        pointerMove: devMode.pointerMove,
        pointerUp: devMode.pointerUp,
      }
    : undefined,
});

// Hold SPACE to sprint (server drains stamina + applies the speed boost).
setupSprint(net);

// The intro / character-select splash. It renders its own hero scene on this
// same engine while the player picks a name; the main render loop below draws it
// instead of the game world until `splash.active` flips during the launch.
const splash = new SplashScreen(engine);

// homeMaxHp is kept so the home bar can still read "fallen" after the house is
// removed from state on collapse.
let homeMaxHp = 0;

interface AssetTask {
  label: string;
  weight: number;
  promise: Promise<void>;
}

function buildAssetPreload(): { done: Promise<void>; setJoining(): void } {
  let completed = 0;
  let settled = 0;
  let mode: "background" | "joining" | "ready" = "background";
  const tasks: AssetTask[] = [
    {
      label: "gorilla rigs",
      weight: 5,
      promise: factory.preload(),
    },
    {
      label: "throwables",
      weight: 1,
      promise: preloadBanana(scene),
    },
    {
      label: "berserker flask",
      weight: 1,
      promise: preloadBerserkerPotion(scene),
    },
    {
      label: "audio banks",
      weight: 1,
      promise: audio.ready,
    },
    {
      label: "mouse cursors",
      weight: 1,
      promise: preloadMouseCursors(),
    },
    {
      label: "La Crypta house",
      weight: 4,
      promise: loadHouse(scene, shadow).then((house) => {
        game.setHouseModel(house);
      }),
    },
    {
      label: "world props",
      weight: 2,
      promise: propManager.loadAll().then(() => {
        const tower = propManager.all().find((p) => p.def.name === TOWER_PROP_NAME);
        if (tower) game.setHealingTowerPosition(tower.def.x, tower.def.z);
      }),
    },
    {
      label: "placed characters",
      weight: 2,
      promise: characterManager.loadAll({ placements: false }),
    },
  ];
  const total = tasks.reduce((sum, task) => sum + task.weight, 0);
  const setProgress = (status: string, nextMode: "background" | "joining" | "ready" = mode) => {
    const pct = Math.min(100, Math.round((completed / total) * 100));
    splash.setAssetProgress(pct, status, nextMode);
  };

  setProgress("warming up assets");

  const done = Promise.all(
    tasks.map((task) =>
      task.promise
        .catch((err) => {
          console.warn(`[assets] ${task.label} preload failed`, err);
        })
        .finally(() => {
          completed += task.weight;
          settled += 1;
          const done = settled === tasks.length;
          setProgress(done ? "assets ready" : `loaded ${task.label}`, done ? "ready" : "background");
        }),
    ),
  ).then(() => undefined);

  return {
    done,
    setJoining() {
      mode = "joining";
      setProgress("finishing world load");
    },
  };
}

async function start() {
  // Kick the asset loads off immediately, in the background, so the splash time
  // is useful. The launch waits for this, so gameplay starts with all known
  // world assets already available instead of popping in after the cut.
  const preload = buildAssetPreload();

  const handlers: NetHandlers = {
    onConnected: (id) => {
      game.setLocalId(id);
      statusEl.textContent = "connected";
    },
    onPlayerAdd: (p, id) => {
      game.addPlayer(p, id);
    },
    onPlayerChange: (p, id) => game.changePlayer(p, id),
    onPlayerRemove: (id) => game.removePlayer(id),
    onEnemyAdd: (e, id) => game.addEnemy(e, id),
    onEnemyChange: (e, id) => game.changeEnemy(e, id),
    onEnemyRemove: (id) => game.removeEnemy(id),
    onPotionAdd: (p, id) => game.addPotion(p, id),
    onPotionChange: (p, id) => game.changePotion(p, id),
    onPotionRemove: (id) => game.removePotion(id),
    onTreeAdd: (t, id) => game.addTree(t, id),
    onTreeChange: (t, id) => game.changeTree(t, id),
    onTreeRemove: (id) => game.removeTree(id),
    onLogAdd: (l, id) => game.addLog(l, id),
    onLogChange: (l, id) => game.changeLog(l, id),
    onLogRemove: (id) => game.removeLog(id),
    onRockAdd: (r, id) => game.addRock(r, id),
    onRockChange: (r, id) => game.changeRock(r, id),
    onRockRemove: (id) => game.removeRock(id),
    onStoneAdd: (s, id) => game.addStone(s, id),
    onStoneChange: (s, id) => game.changeStone(s, id),
    onStoneRemove: (id) => game.removeStone(id),
    onBananaAdd: (b, id) => game.addBanana(b, id),
    onBananaChange: (b, id) => game.changeBanana(b, id),
    onBananaRemove: (id) => game.removeBanana(id),
    onItemAdd: (item, id) => game.addItem(item, id),
    onItemChange: (item, id) => game.changeItem(item, id),
    onItemRemove: (id) => game.removeItem(id),
    onHouseAdd: (h, id) => game.addHouse(h, id),
    onHouseChange: (h, id) => game.changeHouse(h, id),
    onHouseRemove: (id) => game.removeHouse(id),
    onBananaThrow: (ev) => game.showBananaThrow(ev),
    onDamage: (ev) => game.onDamage(ev),
    onKill: (ev) => game.onKill(ev),
    onHeal: (ev) => game.onHeal(ev),
    onXp: (ev) => game.onXp(ev),
    onChat: (ev) => {
      game.showChatBubble(ev.playerId, ev.text); // bubble over the speaker
      // Nostr senders carry an avatar + verified flag on their synced Player —
      // pass them so the log shows their picture and gives the line more room.
      const sender = net.room?.state.players.get(ev.playerId);
      chat.add(ev.name, ev.text, ev.playerId === game.localId, {
        picture: sender?.picture ?? "",
        nostrVerified: sender?.nostrVerified ?? false,
      }); // log on the right
    },
    onInventory: (slots) => {
      inventory.setInventory(slots);
      hotkeyBar.setInventory(slots);
    },
    onWipe: (ev) => homeBar.flashDefeat(ev.wave), // La Crypta fell → defeat flash (stats/items reset via state)
    onError: (message) => {
      statusEl.textContent = message;
      console.warn("[net]", message);
    },
  };

  while (true) {
    // Wait for the player to commit: a name, and optionally a verified Nostr id.
    // Progress persistence is fully server-side now: the server signs/owns each
    // Nostr player's save (kind 30078) and recovers it on join — the client only
    // proves the pubkey. A duplicate login is kicked by the server (the takeover
    // close code, handled in NetworkClient.onLeave).
    const creds = await splash.awaitCredentials();

    // Make sure every known asset task has settled before we reveal the world. A
    // preload failure isn't fatal — the model builders fall back gracefully — so
    // this waits for completion without stranding the player on a missing GLB.
    preload.setJoining();
    await preload.done;
    splash.setAssetProgress(100, "joining realm", "joining");

    try {
      await net.connect(handlers, {
        name: creds.name,
        // Only the signed auth + profile go to the server; it owns the save.
        nostr: creds.nostr
          ? { auth: creds.nostr.auth, profile: creds.nostr.profile }
          : undefined,
      });
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      const visibleMsg = /nostr/i.test(msg)
        ? msg
        : `offline — ${msg}`;
      statusEl.textContent = visibleMsg;
      splash.showJoinError(visibleMsg);
      continue;
    }

    splash.setAssetProgress(100, "realm ready", "ready");

    // Cinematic hand-off: the splash hero snaps into its attack animation, the camera
    // punches in, and a white flash masks the cut into the live game world.
    await splash.playLaunch();
    splash.dispose();

    // The world is live: show the music/mute widget and start the ambient bed.
    new AudioControls(audio);
    audio.startMusic();
    return;
  }
}

start().catch((err) => {
  console.error(err);
  statusEl.textContent = "offline — is the server running? (pnpm dev)";
});

// Dev-only hook: poke at the running game from the browser console (window.__rpg).
if (import.meta.env.DEV) {
  // Character importer: drop a Meshy character .zip, map clips→actions, fix
  // orientation/scale, preview, then save + add to the world (button bottom-right).
  const characterImporter = new CharacterImporter({
    getPlayerPos: () => {
      const me = game.localId ? net.room?.state.players.get(game.localId) : undefined;
      return me ? frontOfPlayer({ x: me.x, z: me.z, rotY: me.rotY }) : null; // beside the player, not on them
    },
    onPlaced: (_def, placement) => {
      window.setTimeout(() => devMode?.focusEntity("enemy", placement.id), 500);
      window.setTimeout(() => devMode?.focusEntity("enemy", placement.id), 1700);
    },
  });

  (window as Window & { __rpg?: unknown }).__rpg = { engine, scene, net, game, audio, playerBadge, propManager, characterManager, characterImporter, devMode, debugStats };

  // Standalone model inspector (button bottom-right, or press C).
  new CharacterDebugWindow();

  // Model importer: upload a .glb, place/resize/rotate/name it, concrete or not,
  // and persist it to the codebase (button bottom-right, or press M).
  const propImporter = new PropImporter(scene, shadow, () => {
    const me = game.localId ? net.room?.state.players.get(game.localId) : undefined;
    return me ? { x: me.x, z: me.z } : null;
  });
  const animationTester = new AnimationTester({
    getClips: () => game.animationTestClips(),
    playClip: (state) => game.playAnimationTestClip(state),
    clearClip: () => game.clearAnimationTestClip(),
  });
  devMode?.onVisibilityChange((on) => {
    document.body.classList.toggle("devMode", on);
    characterImporter.setVisible(on);
    propImporter.setVisible(on);
    animationTester.setVisible(on);
  });
}

engine.runRenderLoop(() => {
  const frameStartedAt = debugStats.beginFrame();
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);

  // While the intro is up, draw the hero scene instead of the game world. The
  // launch flips `active` (under the white flash) to hand off to the game.
  if (splash.active) {
    debugStats.setScene(splash.scene);
    splash.update(dt);
    const renderStartedAt = performance.now();
    splash.scene.render();
    debugStats.endFrame(frameStartedAt, renderStartedAt);
    return;
  }
  debugStats.setScene(scene);

  // Dev Mode time control: mirror the server's simulation speed so the world
  // looks paused/slowed/sped on the client too (frozen positions + animations).
  const timeScale = net.room?.state.timeScale ?? 1;
  const paused = timeScale === 0;
  scene.animationsEnabled = !paused; // freeze skeletal animations when paused
  game.setGhost(paused); // local player goes translucent + floats while paused
  perf.span("game.update", () => game.update(dt * timeScale)); // the world stays frozen at pause…
  if (paused) game.updateGhost(dt); // …but the ghost free-roams + camera follows at real dt
  perf.span("minimap", () => minimap.update()); // redraws only while TAB is held

  const hp = game.localHp();
  if (hp) globe.set(hp.hp, hp.maxHp);

  // XP bar + character sheet + identity badge read straight off the synced local player
  const me = game.localId ? net.room?.state.players.get(game.localId) : undefined;
  if (me) {
    xpBar.set(me.level, me.xp);
    staminaBar.set(me.stamina, me.maxStamina);
    playerBadge.set({
      name: me.name,
      level: me.level,
      picture: me.picture,
      nostrVerified: me.nostrVerified,
    });
    characterSheet.set({
      name: me.name,
      level: me.level,
      xp: me.xp,
      hp: me.hp,
      maxHp: me.maxHp,
      attack: me.attack,
      armor: me.armor,
      critChance: me.critChance,
      moveSpeed: me.moveSpeed,
      throwPower: me.throwPower,
    });
  }

  // Keep the audio listener on the player so spatial SFX pan + attenuate correctly.
  audio.updateListener(camera, me ? { x: me.x, z: me.z } : null);

  // Siege objective HUD: every player always sees the home (first house) HP + wave
  // state. Once the house is destroyed it's removed from state, so fall back to a
  // "fallen" reading using the last-known max HP.
  const st = net.room?.state;
  if (homeBar && st) {
    let home: { hp: number; maxHp: number; alive: boolean } | undefined;
    st.houses.forEach((h) => {
      if (!home) home = h;
    });
    if (home) {
      homeMaxHp = home.maxHp;
      homeBar.setHouse(home.hp, home.maxHp, home.alive);
    } else if (homeMaxHp > 0) {
      homeBar.setHouse(0, homeMaxHp, false);
    }
    homeBar.setWave(st.waveNumber, st.waveTimerMs);
  }

  // Realm-over intermission (La Crypta fell): the whole-screen "next realm in N"
  // countdown takes priority over the per-player respawn overlay.
  const restartMs = net.room?.state.restartTimerMs ?? 0;
  if (restartMs > 0) {
    realmOverlay.style.display = "flex";
    realmCountdownEl.textContent = String(Math.ceil(restartMs / 1000));
    if (respawnOverlay.style.display !== "none") respawnOverlay.style.display = "none";
  } else {
    if (realmOverlay.style.display !== "none") realmOverlay.style.display = "none";
    const respawnIn = game.respawnCountdown();
    if (respawnIn === null) {
      if (respawnOverlay.style.display !== "none") respawnOverlay.style.display = "none";
    } else {
      respawnOverlay.style.display = "flex";
      respawnCountdownEl.textContent = `Respawning in ${Math.ceil(respawnIn)}`;
    }
  }

  debugStats.setGameStats(game.debugStats());
  const renderStartedAt = performance.now();
  perf.span("scene.render", () => scene.render());
  debugStats.endFrame(frameStartedAt, renderStartedAt);
});

window.addEventListener("resize", () => {
  engine.resize();
  applyOrthoSize(camera);
});
