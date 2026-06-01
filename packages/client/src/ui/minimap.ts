import { WORLD_SIZE, HOUSE_CENTER, HOUSE_RADIUS } from "@rpg/shared";
import type { GameState } from "@rpg/shared";
import { npubEncode } from "nostr-tools/nip19";
import type { NetworkClient } from "../net/NetworkClient";

/** Escape user-provided text before putting it in innerHTML (names come from
 *  players / nostr profiles, so they must never be trusted as markup). */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/**
 * Maps drawn on 2D canvases over the WebGL view, rotated to match the isometric
 * camera so directions line up with the 3D world (read straight off the synced
 * room state each frame, so movement is tracked in real time):
 *
 *   • RADAR  — a small always-on minimap in the top-left, centred on you.
 *   • SAMPLE — hold TAB for a bigger, 3×-zoomed peek centred on you.
 *   • FULL   — the "Map" button (or Esc to close) shows the whole world.
 *
 * Trees and stones (boulders) are drawn everywhere; the central house (the
 * objective) is always shown, oversized, on top of the fog; other characters are
 * only tracked within a vision circle around you — the rest sits under a soft,
 * transparent fog of war. Characters read as coloured dots:
 *   • blue = ally (players)  • red = enemy (goblins)  • white = neutral (dummies)
 *   • cyan = you (ringed)
 */

const OVERLAY_PX = 1024; // big-map drawing buffer; CSS scales it to fit
const BASE_SCALE = OVERLAY_PX / (WORLD_SIZE * 2); // px/world-unit when the whole map fits
const SAMPLE_ZOOM = 3; // the TAB peek is zoomed in this much vs the full map

// The world is viewed through a locked isometric camera (alpha = -45°), so the maps
// are rotated to match it: a world offset is projected onto the camera's on-screen
// right/up axes (their ground projections, read straight from the camera) so map
// directions line up with what you see in 3D.
//   screen-right → world (+x, +z)   ·   screen-up → world (-x, +z)
const ISO_RX = Math.SQRT1_2;
const ISO_RZ = Math.SQRT1_2;
const ISO_UX = -Math.SQRT1_2;
const ISO_UZ = Math.SQRT1_2;
// A square world becomes a diamond once rotated 45°; shrink the full-map view by √2
// so the whole diamond fits inside the panel instead of overflowing its corners.
const FULL_FIT = Math.SQRT1_2;

const CORNER_PX = 320; // corner-radar drawing buffer (downscaled by CSS for crispness)
const CORNER_WORLD_HALF = 55; // the radar shows ± this many world units around you
const CORNER_SCALE = CORNER_PX / (CORNER_WORLD_HALF * 2);

// Vision: characters are tracked within this radius of the player (30% of the
// world half-extent). Tweak the fraction to widen/narrow sight.
const REVEAL_FRACTION = 0.3;
const REVEAL_RADIUS = WORLD_SIZE * REVEAL_FRACTION; // world units

const FOG_ALPHA = 0.62; // darkness of the fog beyond the vision circle (transparent)
const FOG_RGB = "8,10,12";
const VOID_FILL = "rgba(6,8,7,0.5)"; // outside-the-world backdrop
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
  private panel!: HTMLElement;
  private overlayCtx: CanvasRenderingContext2D;
  private title!: HTMLElement;
  private button!: HTMLButtonElement;
  private corner!: HTMLElement; // the top-left radar wrapper
  private cornerCtx: CanvasRenderingContext2D;
  private playerList!: HTMLElement; // connected-players panel on the big map
  private lastPlayerSig = ""; // rebuild the list only when the roster changes

  private tabHeld = false; // hold TAB → sample view
  private fullOpen = false; // "Map" button / Esc → full view

  constructor(private net: NetworkClient) {
    const { overlayCanvas, cornerCanvas } = this.buildDom();
    this.overlayCtx = overlayCanvas.getContext("2d")!;
    this.cornerCtx = cornerCanvas.getContext("2d")!;
    this.bindKeys();
  }

  /** Called every frame by the render loop (only runs in-game). Draws the corner
   *  radar always, and the big overlay only while TAB is held / the full map is open. */
  update() {
    const me = this.localPlayer();
    const px = me?.x ?? 0;
    const pz = me?.z ?? 0;

    if (this.tabHeld || this.fullOpen) {
      const full = this.fullOpen;
      this.title.textContent = full ? "WORLD MAP" : "LOCAL MAP";
      const scale = full ? BASE_SCALE * FULL_FIT : BASE_SCALE * SAMPLE_ZOOM;
      this.renderMap(this.overlayCtx, OVERLAY_PX, full ? 0 : px, full ? 0 : pz, scale);
      this.renderPlayerList(this.net.room?.state, this.net.room?.sessionId);
    } else {
      // corner radar is always centred on the player
      this.renderMap(this.cornerCtx, CORNER_PX, px, pz, CORNER_SCALE);
    }
  }

  private localPlayer() {
    const id = this.net.room?.sessionId;
    return id ? this.net.room?.state.players.get(id) : undefined;
  }

  /**
   * Draw a complete map onto `ctx` of side `size`, under the world→pixel transform
   * defined by view-centre (cx,cz) and `scale`. Used for every view (radar, sample,
   * full) so they stay perfectly consistent.
   */
  private renderMap(ctx: CanvasRenderingContext2D, size: number, cx: number, cz: number, scale: number) {
    const state: GameState | undefined = this.net.room?.state;
    const selfId = this.net.room?.sessionId;
    const me = selfId ? state?.players.get(selfId) : undefined;
    const meX = me?.x ?? 0;
    const meZ = me?.z ?? 0;

    // Project a world (x,z) onto the canvas, rotated to match the isometric camera.
    const proj = (x: number, z: number): [number, number] => {
      const dx = x - cx;
      const dz = z - cz;
      return [
        size / 2 + (dx * ISO_RX + dz * ISO_RZ) * scale,
        size / 2 - (dx * ISO_UX + dz * ISO_UZ) * scale, // canvas y is down
      ];
    };
    const onScreen = (x: number, y: number, m = 8) => x >= -m && x <= size + m && y >= -m && y <= size + m;

    // ---- ground (the square world reads as a diamond once iso-rotated) ----
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = VOID_FILL; // outside the world (the panel corners on the full map)
    ctx.fillRect(0, 0, size, size);
    const corners: [number, number][] = [
      proj(-WORLD_SIZE, -WORLD_SIZE),
      proj(WORLD_SIZE, -WORLD_SIZE),
      proj(WORLD_SIZE, WORLD_SIZE),
      proj(-WORLD_SIZE, WORLD_SIZE),
    ];
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.fillStyle = GROUND_FILL;
    ctx.fill();

    // ---- trees & stones (whole world; fog dims the far ones) ----
    if (state) {
      state.rocks.forEach((r) => {
        if (!r.alive) return;
        const [x, y] = proj(r.x, r.z);
        if (!onScreen(x, y)) return;
        this.dot(ctx, x, y, Math.max(2, r.radius * scale * 0.95), COLORS.stone, "rgba(0,0,0,0.45)");
      });
      const treeR = 2.4 * Math.sqrt(scale / BASE_SCALE); // grow a little with zoom so they read
      state.trees.forEach((t) => {
        if (!t.alive) return;
        const [x, y] = proj(t.x, t.z);
        if (!onScreen(x, y)) return;
        this.dot(ctx, x, y, treeR, COLORS.tree, "rgba(0,0,0,0.4)");
      });
    }

    // ---- fog of war: clear around the player, soft ramp to dark beyond ----
    const [fx, fy] = proj(meX, meZ);
    const revealPx = REVEAL_RADIUS * scale;
    const fog = ctx.createRadialGradient(fx, fy, revealPx * 0.82, fx, fy, revealPx * 1.18);
    fog.addColorStop(0, `rgba(${FOG_RGB},0)`);
    fog.addColorStop(1, `rgba(${FOG_RGB},${FOG_ALPHA})`);
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, size, size);

    // vision boundary, faintly
    ctx.beginPath();
    ctx.arc(fx, fy, revealPx, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(180,210,255,0.22)";
    ctx.stroke();

    // ---- the central house/objective — always visible, above the fog ----
    const [hx, hy] = proj(HOUSE_CENTER.x, HOUSE_CENTER.z);
    this.drawHouse(ctx, hx, hy, scale);

    // ---- characters: only those within vision (self always shown), crisp on top ----
    const r2 = REVEAL_RADIUS * REVEAL_RADIUS;
    const inSight = (x: number, z: number) => (x - meX) ** 2 + (z - meZ) ** 2 <= r2;
    if (state) {
      state.players.forEach((p, id) => {
        if (p.hp <= 0 || id === selfId || !inSight(p.x, p.z)) return;
        const [x, y] = proj(p.x, p.z);
        this.dot(ctx, x, y, 4.4, COLORS.ally, "rgba(0,0,0,0.5)");
      });
      state.enemies.forEach((e) => {
        if (e.hp <= 0 || !inSight(e.x, e.z)) return;
        const color = e.kind === "goblin" ? COLORS.enemy : COLORS.neutral;
        const [x, y] = proj(e.x, e.z);
        this.dot(ctx, x, y, 4.4, color, "rgba(0,0,0,0.5)");
      });
    }

    // you — a larger cyan dot ringed in white so you're easy to find
    this.dot(ctx, fx, fy, 5.8, COLORS.self, "rgba(0,0,0,0.55)");
    ctx.beginPath();
    ctx.arc(fx, fy, 8.8, 0, Math.PI * 2);
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }

  /** The central house (La Crypta — the objective). Drawn ON TOP of the fog so it's
   *  always visible, and oversized vs its footprint so it's the key landmark. */
  private drawHouse(ctx: CanvasRenderingContext2D, hx: number, hy: number, scale: number) {
    const footPx = HOUSE_RADIUS * scale; // real footprint radius, in px
    const h = Math.min(58, Math.max(18, footPx * 1.8)); // icon half-size — always bigger than life

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
    ctx.lineWidth = Math.max(1.5, h * 0.13);

    ctx.fillStyle = "#f2d489"; // body
    ctx.beginPath();
    ctx.rect(left, bodyTop, bodyW, bodyH);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#d98a25"; // roof
    ctx.beginPath();
    ctx.moveTo(hx, topY);
    ctx.lineTo(right + over, bodyTop);
    ctx.lineTo(left - over, bodyTop);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const doorW = bodyW * 0.3; // door
    const doorH = bodyH * 0.58;
    ctx.fillStyle = "#5a3b18";
    ctx.beginPath();
    ctx.rect(hx - doorW / 2, bodyBot - doorH, doorW, doorH);
    ctx.fill();
    ctx.stroke();
  }

  private dot(ctx: CanvasRenderingContext2D, px: number, py: number, r: number, fill: string, stroke?: string) {
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

  /** Rebuild the connected-players panel (name · level · nostr badge). Nostr-verified
   *  players link out to njump.me for their npub. Only rebuilt when the roster changes. */
  private renderPlayerList(state: GameState | undefined, selfId: string | undefined) {
    const rows: { id: string; name: string; level: number; verified: boolean; pubkey: string }[] = [];
    state?.players.forEach((p, id) => {
      rows.push({
        id,
        name: p.name || "Anon",
        level: p.level,
        verified: !!p.nostrVerified && !!p.pubkey,
        pubkey: p.pubkey,
      });
    });
    rows.sort((a, b) => {
      if (a.id === selfId) return -1; // you, first
      if (b.id === selfId) return 1;
      return b.level - a.level || a.name.localeCompare(b.name); // then by level, then name
    });

    const sig = rows.map((r) => `${r.id}:${r.name}:${r.level}:${r.verified ? 1 : 0}`).join("|");
    if (sig === this.lastPlayerSig) return; // nothing changed → keep the DOM (stable links)

    const head = `<div id="mmPHead">Players · ${rows.length}</div>`;
    const body = rows
      .map((r) => {
        let npub = "";
        if (r.verified) {
          try {
            npub = npubEncode(r.pubkey);
          } catch {
            npub = "";
          }
        }
        const badge = npub
          ? `<span class="mmNostr on" title="Nostr-verified — open on njump">⚡</span>`
          : `<span class="mmNostr off" title="Anonymous (no nostr)">○</span>`;
        const name = npub
          ? `<a class="mmLink" href="https://njump.me/${npub}" target="_blank" rel="noopener noreferrer">${esc(r.name)}</a>`
          : `<span>${esc(r.name)}</span>`;
        const you = r.id === selfId ? `<span class="mmYou">(you)</span>` : "";
        return `<div class="mmRow">${badge}<span class="mmPName">${name}${you}</span><span class="mmLvl">Lv.${r.level}</span></div>`;
      })
      .join("");
    this.playerList.innerHTML = head + body;
    this.lastPlayerSig = sig; // set last, so an error can't strand the list empty
  }

  // ---- open / close ----
  private refresh() {
    const full = this.fullOpen;
    const open = this.tabHeld || full;
    this.overlay.style.display = open ? "flex" : "none";
    this.corner.style.display = open ? "none" : "block"; // hide the radar while the big map is up
    // M / Map button → a full-screen map with a dark backdrop; the TAB peek stays a
    // smaller, see-through centred panel.
    this.overlay.style.background = full ? "rgba(0,0,0,0.62)" : "transparent";
    const side = full ? "min(100vw, 100vh)" : "86vmin";
    this.panel.style.width = side;
    this.panel.style.height = side;
    this.panel.style.borderRadius = full ? "0" : "14px";
    this.button.classList.toggle("active", full);
  }

  private bindKeys() {
    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // let forms type (e.g. chat)
      if (document.body.classList.contains("preGame")) return; // not during the splash
      if (e.key === "Tab") {
        e.preventDefault(); // stop the browser stealing focus / cycling controls
        this.tabHeld = true;
        this.refresh();
      } else if (e.key === "m" || e.key === "M") {
        this.fullOpen = !this.fullOpen; // M toggles the full-screen world map
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

  /** Build the corner radar, the centred overlay (frame + canvas + title + legend)
   *  and the toggle button, then mount them. */
  private buildDom(): { overlayCanvas: HTMLCanvasElement; cornerCanvas: HTMLCanvasElement } {
    // ---- top-left corner radar (always on) ----
    const corner = document.createElement("div");
    corner.id = "rpgMiniMap";
    corner.title = "Hold TAB to peek · press M (or click) for the full-screen map";
    corner.style.cssText =
      "position:fixed;left:14px;top:14px;z-index:45;width:184px;height:184px;" +
      "border:2px solid #6b4f2e;border-radius:10px;overflow:hidden;cursor:pointer;" +
      "background:rgba(6,5,8,0.3);box-shadow:0 6px 20px rgba(0,0,0,0.55),inset 0 0 18px rgba(0,0,0,0.5);";
    const cornerCanvas = document.createElement("canvas");
    cornerCanvas.width = CORNER_PX;
    cornerCanvas.height = CORNER_PX;
    cornerCanvas.style.cssText = "width:100%;height:100%;display:block;";
    corner.append(cornerCanvas);
    corner.addEventListener("click", () => {
      this.fullOpen = !this.fullOpen;
      this.refresh();
    });

    // ---- big map overlay ----
    const overlay = document.createElement("div");
    overlay.id = "minimapOverlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:60;display:none;align-items:center;" +
      "justify-content:center;pointer-events:none;";

    const panel = document.createElement("div");
    panel.style.cssText =
      "position:relative;box-sizing:border-box;width:86vmin;height:86vmin;border-radius:14px;" +
      "border:3px solid #6b4f2e;background:rgba(6,5,8,0.28);" +
      "box-shadow:0 12px 40px rgba(0,0,0,0.6),inset 0 0 30px rgba(0,0,0,0.5);";

    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.width = OVERLAY_PX;
    overlayCanvas.height = OVERLAY_PX;
    overlayCanvas.style.cssText =
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

    // connected-players panel (name · level · nostr), top-left of the map
    const playerList = document.createElement("div");
    playerList.id = "mmPlayers";

    panel.append(overlayCanvas, title, legend, playerList);
    overlay.append(panel);

    // ---- full-map toggle button (matches the inventory button) ----
    const button = document.createElement("button");
    button.id = "rpgMapBtn";
    button.type = "button";
    button.textContent = "🗺 Map (M)";
    button.title = "Open the full-screen map — press M (hold TAB for a quick local map)";
    button.style.cssText =
      "position:fixed;left:24px;bottom:162px;z-index:61;padding:10px 14px;" +
      "font:600 14px system-ui,sans-serif;color:#f0e6d2;cursor:pointer;" +
      "background:linear-gradient(#3a2c1e,#241a12);border:2px solid #6b4f2e;" +
      "border-radius:8px;box-shadow:0 3px 10px rgba(0,0,0,0.5);";
    button.addEventListener("click", () => {
      this.fullOpen = !this.fullOpen;
      this.refresh();
    });

    // Hover/active styling, hide map UI during the splash, and push the help hint
    // below the corner radar so they don't overlap.
    const style = document.createElement("style");
    style.textContent =
      "#rpgMapBtn:hover{background:linear-gradient(#4a3826,#2e2117)}" +
      "#rpgMapBtn.active{border-color:#ffd479;color:#ffd479}" +
      "#rpgMiniMap:hover{border-color:#8a6a3c}" +
      "body.preGame #rpgMapBtn,body.preGame #rpgMiniMap{display:none!important}" +
      "body #hint{top:210px}" +
      "#mmPlayers{position:absolute;top:12px;left:14px;z-index:2;pointer-events:auto;" +
      "min-width:150px;max-width:46%;max-height:calc(100% - 70px);overflow-y:auto;" +
      "background:rgba(10,8,12,0.6);border:1px solid #6b4f2e;border-radius:8px;padding:8px 10px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.5)}" +
      "#mmPHead{font:700 11px system-ui,sans-serif;letter-spacing:1px;color:#ffd479;" +
      "text-transform:uppercase;margin-bottom:6px}" +
      ".mmRow{display:flex;align-items:center;gap:7px;padding:3px 0;" +
      "font:600 13px system-ui,sans-serif;color:#e8e3d6;white-space:nowrap}" +
      ".mmRow .mmPName{overflow:hidden;text-overflow:ellipsis;max-width:170px}" +
      ".mmLvl{margin-left:auto;color:#c9a36a;font-size:12px}" +
      ".mmNostr.on{color:#c08bff}.mmNostr.off{color:#5f5f68;font-size:11px}" +
      ".mmLink{color:#c08bff;text-decoration:none}" +
      ".mmLink:hover{text-decoration:underline;color:#d7b3ff}" +
      ".mmYou{color:#79e0ff;margin-left:5px;font-size:11px}";

    document.head.append(style);
    document.body.append(corner, overlay, button);

    this.overlay = overlay;
    this.panel = panel;
    this.title = title;
    this.button = button;
    this.corner = corner;
    this.playerList = playerList;
    return { overlayCanvas, cornerCanvas };
  }
}
