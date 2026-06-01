import { WORLD_SIZE, HOUSE_CENTER, HOUSE_RADIUS } from "@rpg/shared";
import type { GameState } from "@rpg/shared";
import type { NetworkClient } from "../net/NetworkClient";
import type { TerrainPatch } from "../scene/environment";

/**
 * Diablo-style automap overlay with two views:
 *   • SAMPLE (hold TAB): a quick, 3×-zoomed peek centred on you.
 *   • FULL  (the "Map" button, or Esc to close): the whole world at once.
 *
 * Both are translucent top-down maps: terrain & patchwork, trees and stones
 * (boulders) are drawn everywhere, while characters are only tracked within a
 * vision circle around you — the rest sits under a soft, transparent fog of war
 * (Age-of-Empires style). Characters read as coloured dots:
 *   • blue  = ally  (other players)        • red   = enemy   (goblins)
 *   • white = neutral (training dummies)    • cyan  = you (ringed)
 *
 * It reads straight off the synced room state each frame, so every character's
 * movement is tracked in real time. Everything draws onto its own 2D canvas
 * over the WebGL view — independent of the 3D scene.
 */

const MAP_PX = 1024; // internal (drawing-buffer) resolution; CSS scales it to fit
const BASE_SCALE = MAP_PX / (WORLD_SIZE * 2); // px per world unit when the whole map fits
const SAMPLE_ZOOM = 3; // the TAB quick-map is zoomed in this much vs the full map

// Vision: characters are tracked within this radius of the player. "15% of the
// map" doubled → 30% of the world half-extent. Tweak the fraction for sight range.
const REVEAL_FRACTION = 0.3;
const REVEAL_RADIUS = WORLD_SIZE * REVEAL_FRACTION; // world units

const FOG_ALPHA = 0.62; // darkness of the fog beyond the vision circle (transparent)
const FOG_RGB = "8,10,12"; // cool near-black the fog (and map base) are tinted with
const VOID_FILL = "rgba(6,8,7,0.5)"; // outside-the-world backdrop (visible when zoomed near an edge)
const GROUND_FILL = "rgba(26,38,24,0.82)"; // translucent map base, so the game shows through

const COLORS = {
  self: "#79e0ff",
  ally: "#3a9bff",
  enemy: "#ff463a",
  neutral: "#f3f3f7",
  tree: "#4fa854",
  stone: "#9a9aa6",
};

export class Minimap {
  private overlay!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private title!: HTMLElement;
  private button!: HTMLButtonElement;

  private tabHeld = false; // hold TAB → sample view
  private fullOpen = false; // "Map" button / Esc → full view

  // active view transform (world → canvas px), recomputed each render
  private viewCx = 0;
  private viewCz = 0;
  private viewScale = BASE_SCALE;

  constructor(
    private net: NetworkClient,
    private terrainPatches: TerrainPatch[],
  ) {
    this.buildDom();
    this.ctx = this.canvas.getContext("2d")!;
    this.bindKeys();
  }

  // ---- world → minimap pixel (via the active center + scale) ----
  private wx(x: number): number {
    return MAP_PX / 2 + (x - this.viewCx) * this.viewScale;
  }
  private wz(z: number): number {
    return MAP_PX / 2 + (z - this.viewCz) * this.viewScale;
  }

  /** Called every frame by the render loop; only paints while a view is open. */
  update() {
    if (!this.tabHeld && !this.fullOpen) return;
    const ctx = this.ctx;

    const state = this.net.room?.state;
    const selfId = this.net.room?.sessionId;
    const me = selfId ? state?.players.get(selfId) : undefined;
    const cx = me?.x ?? 0;
    const cz = me?.z ?? 0;

    // FULL = whole world, origin-centred. SAMPLE = 3× zoom, centred on the player.
    const full = this.fullOpen;
    this.viewScale = full ? BASE_SCALE : BASE_SCALE * SAMPLE_ZOOM;
    this.viewCx = full ? 0 : cx;
    this.viewCz = full ? 0 : cz;
    this.title.textContent = full ? "WORLD MAP" : "LOCAL MAP";

    // ---- ground, terrain/patchwork, trees, stones (whole world; fog dims the far ones) ----
    this.drawWorld(state);

    // ---- fog of war: clear around the player, soft ramp to dark beyond ----
    const px = this.wx(cx);
    const pz = this.wz(cz);
    const revealPx = REVEAL_RADIUS * this.viewScale;
    const fog = ctx.createRadialGradient(px, pz, revealPx * 0.82, px, pz, revealPx * 1.18);
    fog.addColorStop(0, `rgba(${FOG_RGB},0)`);
    fog.addColorStop(1, `rgba(${FOG_RGB},${FOG_ALPHA})`);
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, MAP_PX, MAP_PX);

    // the vision boundary, faintly
    ctx.beginPath();
    ctx.arc(px, pz, revealPx, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(180,210,255,0.22)";
    ctx.stroke();

    // the central objective — always visible (drawn above the fog)
    this.drawHouse();

    // ---- characters: only those within vision (self always shown), crisp on top ----
    const r2 = REVEAL_RADIUS * REVEAL_RADIUS;
    const inSight = (x: number, z: number) => (x - cx) ** 2 + (z - cz) ** 2 <= r2;

    if (state) {
      state.players.forEach((p, id) => {
        if (p.hp <= 0 || id === selfId) return;
        if (!inSight(p.x, p.z)) return;
        this.dot(this.wx(p.x), this.wz(p.z), 4.6, COLORS.ally, "rgba(0,0,0,0.5)");
      });
      state.enemies.forEach((e) => {
        if (e.hp <= 0 || !inSight(e.x, e.z)) return;
        const color = e.kind === "goblin" ? COLORS.enemy : COLORS.neutral;
        this.dot(this.wx(e.x), this.wz(e.z), 4.6, color, "rgba(0,0,0,0.5)");
      });
    }

    // you — a larger cyan dot ringed in white so you're easy to find
    this.dot(px, pz, 6.2, COLORS.self, "rgba(0,0,0,0.55)");
    ctx.beginPath();
    ctx.arc(px, pz, 9.5, 0, Math.PI * 2);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }

  /** Paint the world layer under the current transform: void, ground, patches,
   *  trees, stones, the origin "+" and the world boundary. */
  private drawWorld(state: GameState | undefined) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, MAP_PX, MAP_PX);

    // everything outside the world (only seen when the sample view sits near an edge)
    ctx.fillStyle = VOID_FILL;
    ctx.fillRect(0, 0, MAP_PX, MAP_PX);

    // the playable ground rectangle
    const x0 = this.wx(-WORLD_SIZE);
    const y0 = this.wz(-WORLD_SIZE);
    const w = WORLD_SIZE * 2 * this.viewScale;
    ctx.fillStyle = GROUND_FILL;
    ctx.fillRect(x0, y0, w, w);

    // terrain & patchwork decals
    ctx.globalAlpha = 0.55;
    for (const p of this.terrainPatches) {
      ctx.beginPath();
      ctx.arc(this.wx(p.x), this.wz(p.z), Math.max(1.2, p.r * this.viewScale), 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (state) {
      // stones (boulders) — scale naturally with their footprint
      state.rocks.forEach((r) => {
        if (!r.alive) return;
        this.dot(this.wx(r.x), this.wz(r.z), Math.max(2.5, r.radius * this.viewScale * 0.95), COLORS.stone, "rgba(0,0,0,0.45)");
      });
      // trees — fixed-ish dots that grow a little with zoom so they stay readable
      const treeR = 2.6 * Math.sqrt(this.viewScale / BASE_SCALE);
      state.trees.forEach((t) => {
        if (!t.alive) return;
        this.dot(this.wx(t.x), this.wz(t.z), treeR, COLORS.tree, "rgba(0,0,0,0.4)");
      });
    }

    // (the central house/objective is drawn later, on top of the fog)

    // world boundary
    ctx.strokeStyle = "rgba(120,95,50,0.55)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, w, w);
  }

  /** The central house (La Crypta — the objective you defend). Drawn ON TOP of the
   *  fog so it's always visible, and deliberately oversized vs its real footprint
   *  so it reads as the single most important landmark on the map. */
  private drawHouse() {
    const ctx = this.ctx;
    const hx = this.wx(HOUSE_CENTER.x);
    const hy = this.wz(HOUSE_CENTER.z);
    const footPx = HOUSE_RADIUS * this.viewScale; // its real footprint radius, in px
    const h = Math.min(58, Math.max(24, footPx * 1.8)); // icon half-size — always bigger than life

    // attention glow
    const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, h * 2.3);
    glow.addColorStop(0, "rgba(255,206,104,0.5)");
    glow.addColorStop(1, "rgba(255,206,104,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(hx, hy, h * 2.3, 0, Math.PI * 2);
    ctx.fill();

    const bodyW = h * 1.5;
    const bodyH = h * 1.05;
    const roofH = h * 0.9;
    const over = h * 0.22; // roof eave overhang
    const topY = hy - (roofH + bodyH) / 2;
    const bodyTop = topY + roofH;
    const left = hx - bodyW / 2;
    const right = hx + bodyW / 2;
    const bodyBot = bodyTop + bodyH;

    ctx.lineJoin = "round";
    ctx.strokeStyle = "#2a1b0d";
    ctx.lineWidth = Math.max(2, h * 0.13);

    // body
    ctx.fillStyle = "#f2d489";
    ctx.beginPath();
    ctx.rect(left, bodyTop, bodyW, bodyH);
    ctx.fill();
    ctx.stroke();

    // roof
    ctx.fillStyle = "#d98a25";
    ctx.beginPath();
    ctx.moveTo(hx, topY);
    ctx.lineTo(right + over, bodyTop);
    ctx.lineTo(left - over, bodyTop);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // door
    const doorW = bodyW * 0.3;
    const doorH = bodyH * 0.58;
    ctx.fillStyle = "#5a3b18";
    ctx.beginPath();
    ctx.rect(hx - doorW / 2, bodyBot - doorH, doorW, doorH);
    ctx.fill();
    ctx.stroke();
  }

  private dot(px: number, py: number, r: number, fill: string, stroke?: string) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = Math.max(1, r * 0.32);
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  // ---- show / hide ----
  /** Reflect the current flags onto the overlay + button immediately. */
  private refresh() {
    this.overlay.style.display = this.tabHeld || this.fullOpen ? "flex" : "none";
    this.button.classList.toggle("active", this.fullOpen);
  }

  private bindKeys() {
    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Tab") {
        if (typing) return; // let forms use Tab normally
        if (document.body.classList.contains("preGame")) return; // not during the splash
        e.preventDefault(); // stop the browser stealing focus / cycling controls
        this.tabHeld = true;
        this.refresh();
      } else if (e.key === "Escape" && this.fullOpen) {
        this.fullOpen = false;
        this.refresh();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Tab") {
        this.tabHeld = false;
        this.refresh();
      }
    });
    // never get a stuck sample view if focus is lost while TAB is held (e.g. alt-tab)
    window.addEventListener("blur", () => {
      this.tabHeld = false;
      this.refresh();
    });
  }

  /** Build the centred overlay (frame + canvas + title + legend) and the toggle
   *  button, then mount them. */
  private buildDom() {
    const overlay = document.createElement("div");
    overlay.id = "minimapOverlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:60;display:none;align-items:center;" +
      "justify-content:center;pointer-events:none;";

    const panel = document.createElement("div");
    panel.style.cssText =
      "position:relative;width:86vmin;height:86vmin;border-radius:14px;" +
      "border:3px solid #6b4f2e;background:rgba(6,5,8,0.28);" +
      "box-shadow:0 12px 40px rgba(0,0,0,0.6),inset 0 0 30px rgba(0,0,0,0.5);";

    const canvas = document.createElement("canvas");
    canvas.width = MAP_PX;
    canvas.height = MAP_PX;
    canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;border-radius:11px;display:block;";

    const title = document.createElement("div");
    title.textContent = "WORLD MAP";
    title.style.cssText =
      "position:absolute;top:10px;left:0;right:0;text-align:center;pointer-events:none;" +
      "font:700 16px Georgia,serif;letter-spacing:3px;color:#ffd479;" +
      "text-shadow:0 2px 5px rgba(0,0,0,0.9);";

    const legend = document.createElement("div");
    legend.style.cssText =
      "position:absolute;bottom:10px;left:0;right:0;display:flex;gap:18px;" +
      "justify-content:center;pointer-events:none;font:600 12px system-ui,sans-serif;" +
      "color:#e8e3d6;text-shadow:0 1px 3px rgba(0,0,0,0.95);";
    const swatch = (color: string, label: string) =>
      `<span style="display:inline-flex;align-items:center;gap:5px">` +
      `<span style="width:10px;height:10px;border-radius:50%;background:${color};` +
      `box-shadow:0 0 0 1px rgba(0,0,0,0.6)"></span>${label}</span>`;
    const houseSwatch =
      `<span style="display:inline-flex;align-items:center;gap:5px">` +
      `<span style="width:12px;height:9px;background:#f2d489;border:1px solid #2a1b0d;` +
      `box-shadow:0 0 7px rgba(255,206,104,0.9)"></span>House</span>`;
    legend.innerHTML =
      swatch(COLORS.ally, "Ally") +
      swatch(COLORS.enemy, "Enemy") +
      swatch(COLORS.neutral, "Neutral") +
      swatch(COLORS.self, "You") +
      houseSwatch;

    panel.append(canvas, title, legend);
    overlay.append(panel);

    // ---- the on-screen toggle for the FULL map (matches the inventory button) ----
    const button = document.createElement("button");
    button.id = "rpgMapBtn";
    button.type = "button";
    button.textContent = "🗺 Map";
    button.title = "Toggle the full world map (hold TAB for a quick local map)";
    button.style.cssText =
      "position:fixed;left:24px;bottom:162px;z-index:61;padding:10px 14px;" +
      "font:600 14px system-ui,sans-serif;color:#f0e6d2;cursor:pointer;" +
      "background:linear-gradient(#3a2c1e,#241a12);border:2px solid #6b4f2e;" +
      "border-radius:8px;box-shadow:0 3px 10px rgba(0,0,0,0.5);";
    button.addEventListener("click", () => {
      this.fullOpen = !this.fullOpen;
      this.refresh();
    });

    // Hover/active styling + hide the button during the intro splash.
    const style = document.createElement("style");
    style.textContent =
      "#rpgMapBtn:hover{background:linear-gradient(#4a3826,#2e2117)}" +
      "#rpgMapBtn.active{border-color:#ffd479;color:#ffd479}" +
      "body.preGame #rpgMapBtn{display:none!important}";

    document.head.append(style);
    document.body.append(overlay, button);

    this.overlay = overlay;
    this.canvas = canvas;
    this.title = title;
    this.button = button;
  }
}
