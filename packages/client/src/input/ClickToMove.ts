import {
  Scene,
  Mesh,
  AbstractMesh,
  PointerEventTypes,
  PickingInfo,
  Vector3,
  Nullable,
} from "@babylonjs/core";
import {
  THROW_CHARGE_RISE_MS,
  THROW_CHARGE_FALL_MS,
  THROW_CHARGE_FLOOR,
} from "@rpg/shared";
import { NetworkClient } from "../net/NetworkClient";
import { PickResult } from "../game/Game";

export interface ClickToMoveDeps {
  scene: Scene;
  ground: Mesh;
  net: NetworkClient;
  /** Resolve a picked mesh to its world object (id + kind), or null. */
  resolvePick: (mesh: Nullable<AbstractMesh>) => PickResult | null;
  /** Click-assist: nearest clickable target to a ground point, or null. */
  resolveNearby: (point: Vector3) => PickResult | null;
  /** Called when the player clicks bare ground (to show a marker). */
  onMoveTo: (point: Vector3) => void;
  /** Called when the player clicks an enemy/player to attack — flashes the target. */
  onSelectTarget?: (id: string) => void;
  /** The throwable item (banana/stone, in stock) bound to a hotkey (Q/W/E/R), or
   *  "" — gates the charge-and-throw (the throw comes from a hotkey, not SPACE). */
  throwItemForKey: (key: string) => "banana" | "stone" | "";
  /** Optional Dev Mode interceptor. While it's active it consumes world clicks +
   *  hover so selecting/relocating objects replaces the normal move/attack. Each
   *  hook returns true when it handled (consumed) the event. */
  dev?: {
    isActive: () => boolean;
    pointerDown: (pick: Nullable<PickingInfo>) => boolean;
    pointerMove: (pick: Nullable<PickingInfo>) => boolean;
    pointerUp: () => void;
  };
}

/** The bottom-center power meter shown while charging a banana throw. */
function makeChargeBar() {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:50;" +
    "width:280px;height:22px;border:2px solid #0009;border-radius:12px;" +
    "background:#0007;box-shadow:0 2px 8px #0007,inset 0 0 6px #0009;" +
    "display:none;overflow:hidden;";
  const fill = document.createElement("div");
  fill.style.cssText = "height:100%;width:0%;background:#6f6;";
  const label = document.createElement("div");
  label.style.cssText =
    "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
    "font:bold 12px/1 system-ui,sans-serif;color:#fff;text-shadow:0 1px 2px #000;" +
    "letter-spacing:1px;pointer-events:none;";
  label.textContent = "🍌 THROW POWER";
  wrap.append(fill, label);
  document.body.appendChild(wrap);

  // green (weak) → yellow → red (full power)
  const colorFor = (p: number) => `hsl(${Math.round(120 * (1 - p))},85%,50%)`;
  return {
    show() {
      fill.style.width = "0%";
      wrap.style.display = "block";
    },
    hide() {
      wrap.style.display = "none";
    },
    set(p: number) {
      fill.style.width = `${Math.round(p * 100)}%`;
      fill.style.background = colorFor(p);
    },
  };
}

/** Power (0..1) as a function of how long SPACE has been held: rise to full,
 *  then ebb back toward a floor if you over-hold (so timing matters). */
function chargePower(ms: number): number {
  if (ms <= THROW_CHARGE_RISE_MS) return ms / THROW_CHARGE_RISE_MS;
  const past = ms - THROW_CHARGE_RISE_MS;
  if (past <= THROW_CHARGE_FALL_MS)
    return 1 - (1 - THROW_CHARGE_FLOOR) * (past / THROW_CHARGE_FALL_MS);
  return THROW_CHARGE_FLOOR;
}

// Emoji rendered into an SVG = a themed mouse cursor (with an "auto" fallback).
const cur = (emoji: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36'><text x='3' y='29' font-size='28'>${emoji}</text></svg>`,
  )}") 18 18, auto`;

const CURSORS = {
  attack: cur("⚔️"),
  cut: cur("🪓"),
  mine: cur("⛏️"),
  repair: cur("🔨"),
  grab: cur("🤚"),
  default: "default",
};

function cursorForKind(kind: string): string {
  if (kind === "log" || kind === "potion" || kind === "stone" || kind === "banana")
    return CURSORS.grab;
  if (kind === "tree") return CURSORS.cut;
  if (kind === "rock") return CURSORS.mine;
  if (kind === "house") return CURSORS.repair;
  if (kind === "enemy" || kind === "player") return CURSORS.attack;
  return CURSORS.default;
}

function isHouseMesh(mesh: AbstractMesh): boolean {
  let node: Nullable<AbstractMesh> = mesh;
  while (node) {
    const md = node.metadata as { kind?: string } | null;
    if (md?.kind === "house") return true;
    node = node.parent as Nullable<AbstractMesh>;
  }
  return false;
}

/**
 * Diablo-style input: hovering an object swaps the cursor to the action it
 * affords (attack / cut / grab). Left-click a log to collect it, an
 * enemy/player/tree to attack/chop it, or the ground to walk there.
 */
export function setupClickToMove(deps: ClickToMoveDeps) {
  const { scene, ground, net, resolvePick, resolveNearby, onMoveTo } = deps;
  const canvas = scene.getEngine().getRenderingCanvas();
  // Stop Babylon from resetting the cursor each pointer move (it would otherwise
  // immediately revert our themed cursor back to the default — the "flash" bug).
  scene.doNotHandleCursors = true;
  scene.skipPointerMovePicking = true;
  // No browser context menu when right-clicking in the world.
  canvas?.addEventListener("contextmenu", (e) => e.preventDefault());

  // Charged banana throw: hold the banana's HOTKEY (Q/W/E/R) to fill a power bar
  // (rises to full, then ebbs if over-held), release to hurl toward the ground spot
  // under the mouse. The charge level sets distance / damage / speed on the server.
  const chargeBar = makeChargeBar();
  let charging = false;
  let chargeKey = "";
  let chargeItem: "banana" | "stone" = "banana";
  let chargeMs = 0;
  let power = 0;
  const inField = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA";
  };

  window.addEventListener("keydown", (e) => {
    if (inField(e) || charging || e.repeat) return;
    if (deps.dev?.isActive()) return; // no throwing while editing the world
    const k = (e.key || "").toUpperCase();
    const item = deps.throwItemForKey(k);
    if (!item) return; // not a hotkey holding a throwable (banana/stone) with stock
    charging = true;
    chargeKey = k;
    chargeItem = item;
    chargeMs = 0;
    power = 0;
    chargeBar.show();
  });

  window.addEventListener("keyup", (e) => {
    if (!charging || (e.key || "").toUpperCase() !== chargeKey) return;
    charging = false;
    chargeBar.hide();
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === ground);
    if (pick?.hit && pick.pickedPoint)
      net.sendThrow(pick.pickedPoint.x, pick.pickedPoint.z, power, chargeItem);
  });

  scene.onBeforeRenderObservable.add(() => {
    if (!charging) return;
    chargeMs += scene.getEngine().getDeltaTime();
    power = chargePower(chargeMs);
    chargeBar.set(power);
  });

  let lastCursor = "";

  const setCursor = (c: string) => {
    if (c !== lastCursor && canvas) {
      canvas.style.cursor = c;
      lastCursor = c;
    }
  };

  // ---- hold-to-move: after a left-click on the ground, keep the button held and
  //      drag — the character continuously walks to wherever the cursor points
  //      (Diablo-style), re-issuing a move as the cursor's ground spot changes.
  let dragging = false;
  let lastMoveAt = 0;
  let lastMoveX = 0;
  let lastMoveZ = 0;
  const MOVE_THROTTLE_MS = 90; // don't spam the server/pathfinder every mouse event

  const walkToCursor = () => {
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === ground);
    if (!pick?.hit || !pick.pickedPoint) return;
    const p = pick.pickedPoint;
    const now = performance.now();
    // only send when the target has meaningfully moved and enough time has passed
    if (now - lastMoveAt < MOVE_THROTTLE_MS) return;
    if (Math.hypot(p.x - lastMoveX, p.z - lastMoveZ) < 0.5) return;
    net.sendMove(p.x, p.z);
    lastMoveAt = now;
    lastMoveX = p.x;
    lastMoveZ = p.z;
  };

  // Releasing anywhere (even off-canvas) ends the drag.
  window.addEventListener("pointerup", (e) => {
    if (e.button === 0) dragging = false;
  });

  scene.onPointerObservable.add((pi) => {
    // ---- hover / drag: theme the cursor, and while the button is held, follow ----
    if (pi.type === PointerEventTypes.POINTERMOVE) {
      const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => !isHouseMesh(m));
      if (deps.dev?.isActive() && deps.dev.pointerMove(pick)) return; // Dev Mode owns hover
      let hit = pick?.hit ? resolvePick(pick.pickedMesh) : null;
      // click-assist: over bare ground, snap the cursor to a nearby target
      if (!hit && pick?.pickedMesh === ground && pick.pickedPoint) hit = resolveNearby(pick.pickedPoint);
      setCursor(hit ? cursorForKind(hit.kind) : CURSORS.default);
      // holding the left button → keep walking toward the cursor's ground spot
      if (dragging && (pi.event.buttons & 1) !== 0) walkToCursor();
      return;
    }

    // ---- left button released → stop following the cursor ----
    if (pi.type === PointerEventTypes.POINTERUP) {
      if (deps.dev?.isActive()) deps.dev.pointerUp();
      if (pi.event.button === 0) dragging = false;
      return;
    }

    // ---- left-click: act / move ----
    if (pi.type !== PointerEventTypes.POINTERDOWN) return;
    if (pi.event.button !== 0) return;

    const pick = pi.pickInfo ?? scene.pick(scene.pointerX, scene.pointerY);
    if (deps.dev?.isActive() && deps.dev.pointerDown(pick)) return; // Dev Mode owns the click
    if (!pick || !pick.hit) return;

    let hit = resolvePick(pick.pickedMesh);
    // click-assist: a click on bare ground near a target still hits the target
    if (!hit && pick.pickedMesh === ground && pick.pickedPoint) hit = resolveNearby(pick.pickedPoint);
    if (hit) {
      if (
        hit.kind === "log" ||
        hit.kind === "potion" ||
        hit.kind === "stone" ||
        hit.kind === "banana"
      )
        net.sendPickup(hit.id);
      else {
        net.sendAttack(hit.id); // player, enemy, tree (chop), or rock (mine)
        // flash the target white when it's a character you're attacking
        if (hit.kind === "enemy" || hit.kind === "player") deps.onSelectTarget?.(hit.id);
      }
      return; // clicking an object doesn't begin a drag-move
    }

    if (pick.pickedMesh === ground && pick.pickedPoint) {
      net.sendMove(pick.pickedPoint.x, pick.pickedPoint.z);
      onMoveTo(pick.pickedPoint);
      // begin the hold-to-move drag: subsequent mouse-moves keep walking
      dragging = true;
      lastMoveAt = performance.now();
      lastMoveX = pick.pickedPoint.x;
      lastMoveZ = pick.pickedPoint.z;
    }
  });
}
