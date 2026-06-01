import { Engine } from "@babylonjs/core";
import { createScene } from "./scene/createScene";
import { applyOrthoSize } from "./scene/camera";
import { CharacterFactory } from "./entities/CharacterFactory";
import { preloadBanana } from "./entities/models/banana";
import { loadHouse } from "./entities/models/house";
import { loadProps } from "./scene/props";
import { PropImporter } from "./ui/propImporter";
import { HUD } from "./ui/hud";
import { HealthGlobe } from "./ui/healthGlobe";
import { XpBar } from "./ui/xpBar";
import { CharacterSheet } from "./ui/characterSheet";
import { PlayerBadge } from "./ui/playerBadge";
import { InventoryUI } from "./ui/inventory";
import { HotkeyBar } from "./ui/hotkeyBar";
import { Minimap } from "./ui/minimap";
import { ChatLog } from "./ui/chat";
import { CharacterDebugWindow } from "./ui/characterDebug";
import { Game } from "./game/Game";
import { NetworkClient } from "./net/NetworkClient";
import { setupClickToMove } from "./input/ClickToMove";
import { SplashScreen } from "./ui/splash";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const respawnOverlay = document.getElementById("respawnOverlay") as HTMLDivElement;
const respawnCountdownEl = document.getElementById("respawnCountdown") as HTMLDivElement;

const engine = new Engine(canvas, true, { stencil: true }, true);
const { scene, camera, ground, shadow } = createScene(engine);

const factory = new CharacterFactory(scene);
const hud = new HUD(scene);
const globe = new HealthGlobe();
const xpBar = new XpBar();
const characterSheet = new CharacterSheet();
const playerBadge = new PlayerBadge();
const game = new Game(camera, factory, hud, shadow);
const net = new NetworkClient();
const inventory = new InventoryUI(
  (from, to) => net.sendInventoryMove(from, to),
  (slot) => net.sendUseItem(slot),
);
const hotkeyBar = new HotkeyBar((slot) => net.sendUseItem(slot));
const minimap = new Minimap(net); // top-left radar + hold TAB / Map button for the big map
const chat = new ChatLog((text) => net.sendChat(text)); // Enter to chat (right-side log)

setupClickToMove({
  scene,
  ground,
  net,
  resolvePick: game.resolvePick,
  resolveNearby: game.resolveNearby,
  onMoveTo: (point) => {
    hud.showClickMarker(point);
    game.clearSpotlight();
  },
  onAction: (id, kind) => game.showActionSpotlight(id, kind),
  // a banana/stone is thrown by holding its assigned hotkey (Q/W/E/R)
  throwItemForKey: (key) => hotkeyBar.throwItemForKey(key),
});

// The intro / character-select splash. It renders its own hero scene on this
// same engine while the player picks a name; the main render loop below draws it
// instead of the game world until `splash.active` flips during the launch.
const splash = new SplashScreen(engine);

async function start() {
  // Kick the (potentially slow) asset loads off immediately, in the background,
  // so they finish while the player is reading the splash and typing a name.
  const preload = Promise.all([factory.preload(), preloadBanana(scene)]);

  // Wait for the player to commit: a name, and optionally a verified Nostr id.
  const creds = await splash.awaitCredentials();

  // Make sure the character models are ready before we reveal the world, then
  // stream in the heavy/optional props in the background. A preload failure
  // isn't fatal — the factory falls back to the built-in models — so don't let
  // it strand the player on the splash.
  await preload.catch((err) => console.warn("[assets] preload failed", err));
  void loadHouse(scene, shadow);
  void loadProps(scene, shadow); // place any models added via the importer

  // Connect (passing the chosen name) in the background while the launch plays.
  const connected = net.connect(
    {
      onConnected: (id) => {
        game.setLocalId(id);
        statusEl.textContent = "connected";
      },
      onPlayerAdd: (p, id) => game.addPlayer(p, id),
      onPlayerChange: (p, id) => game.changePlayer(p, id),
      onPlayerRemove: (id) => game.removePlayer(id),
      onEnemyAdd: (e, id) => game.addEnemy(e, id),
      onEnemyChange: (e, id) => game.changeEnemy(e, id),
      onEnemyRemove: (id) => game.removeEnemy(id),
      onPotionAdd: (p, id) => game.addPotion(p, id),
      onPotionRemove: (id) => game.removePotion(id),
      onTreeAdd: (t, id) => game.addTree(t, id),
      onTreeChange: (t, id) => game.changeTree(t, id),
      onTreeRemove: (id) => game.removeTree(id),
      onLogAdd: (l, id) => game.addLog(l, id),
      onLogRemove: (id) => game.removeLog(id),
      onRockAdd: (r, id) => game.addRock(r, id),
      onRockChange: (r, id) => game.changeRock(r, id),
      onRockRemove: (id) => game.removeRock(id),
      onStoneAdd: (s, id) => game.addStone(s, id),
      onStoneRemove: (id) => game.removeStone(id),
      onBananaAdd: (b, id) => game.addBanana(b, id),
      onBananaRemove: (id) => game.removeBanana(id),
      onBananaThrow: (ev) => game.showBananaThrow(ev),
      onDamage: (ev) => game.onDamage(ev),
      onHeal: (ev) => game.onHeal(ev),
      onXp: (ev) => game.onXp(ev),
      onChat: (ev) => {
        game.showChatBubble(ev.playerId, ev.text); // bubble over the speaker
        chat.add(ev.name, ev.text, ev.playerId === game.localId); // log on the right
      },
      onInventory: (slots) => {
        inventory.setInventory(slots);
        hotkeyBar.setInventory(slots);
      },
      onError: (message) => {
        statusEl.textContent = message;
        console.warn("[net]", message);
      },
    },
    creds,
  );
  // Don't let a failed connect reject before the animation finishes — surface it
  // on the status line and reveal the world anyway. A Nostr verification failure
  // carries its own reason; anything else reads as the server being down.
  connected.catch((err) => {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    statusEl.textContent = /nostr/i.test(msg)
      ? msg
      : "offline — is the server running? (pnpm dev)";
  });

  // Cinematic hand-off: the gorilla slams, the camera punches in and a white
  // flash masks the cut from the splash scene to the live game world.
  await splash.playLaunch();
  splash.dispose();
}

start().catch((err) => {
  console.error(err);
  statusEl.textContent = "offline — is the server running? (pnpm dev)";
});

// Dev-only hook: poke at the running game from the browser console (window.__rpg).
if (import.meta.env.DEV) {
  (window as Window & { __rpg?: unknown }).__rpg = { engine, scene, net, game, playerBadge };

  // Standalone model inspector (button bottom-right, or press C).
  new CharacterDebugWindow();

  // Model importer: upload a .glb, place/resize/rotate/name it, concrete or not,
  // and persist it to the codebase (button bottom-right, or press M).
  new PropImporter(scene, shadow, () => {
    const me = game.localId ? net.room?.state.players.get(game.localId) : undefined;
    return me ? { x: me.x, z: me.z } : null;
  });

  // Dev-only clip viewer: press a number key to play that animation clip on the
  // local character (with its name on screen) so we can identify which clip is
  // which. Move (click the ground) to resume the normal game animations.
  const label = document.createElement("div");
  label.style.cssText =
    "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;" +
    "background:#000a;color:#fff;padding:6px 14px;border-radius:6px;" +
    "font:14px/1.4 monospace;pointer-events:none;display:none;white-space:pre";
  document.body.appendChild(label);

  window.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const clips = [...new Set(scene.animationGroups.map((g) => g.name))].sort();
    if (e.key === "0") {
      label.style.display = "none";
      return;
    }
    if (e.key < "1" || e.key > "9") return;
    const name = clips[parseInt(e.key, 10) - 1];
    if (!name) return;
    scene.animationGroups.forEach((g) => g.stop());
    scene.animationGroups
      .filter((g) => g.name === name)
      .forEach((g) => g.start(true, 1.0, g.from, g.to, false));
    label.textContent =
      `▶ clip ${e.key}/${clips.length}: ${name}\n` +
      clips.map((c, i) => `${i + 1}: ${c}`).join("   ");
    label.style.display = "block";
  });
}

engine.runRenderLoop(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);

  // While the intro is up, draw the hero scene instead of the game world. The
  // launch flips `active` (under the white flash) to hand off to the game.
  if (splash.active) {
    splash.update(dt);
    splash.scene.render();
    return;
  }

  game.update(dt);
  minimap.update(); // redraws only while TAB is held

  const hp = game.localHp();
  if (hp) globe.set(hp.hp, hp.maxHp);

  // XP bar + character sheet + identity badge read straight off the synced local player
  const me = game.localId ? net.room?.state.players.get(game.localId) : undefined;
  if (me) {
    xpBar.set(me.level, me.xp);
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

  const respawnIn = game.respawnCountdown();
  if (respawnIn === null) {
    if (respawnOverlay.style.display !== "none") respawnOverlay.style.display = "none";
  } else {
    respawnOverlay.style.display = "flex";
    respawnCountdownEl.textContent = `Respawning in ${Math.ceil(respawnIn)}`;
  }

  scene.render();
});

window.addEventListener("resize", () => {
  engine.resize();
  applyOrthoSize(camera);
});
