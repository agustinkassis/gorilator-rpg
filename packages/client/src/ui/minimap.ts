import { HOUSE_COLLISION_RADIUS, TOWER_PROP_NAME, WORLD_SIZE } from "@rpg/shared";
import type { GameState } from "@rpg/shared";
import { npubEncode } from "nostr-tools/nip19";
import type { NetworkClient } from "../net/NetworkClient";
import type { PropManager } from "../dev/PropManager";

/** Escape user-provided text before putting it in innerHTML (names come from
 *  players / nostr profiles, so they must never be trusted as markup). */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Pick a map icon for an imported prop from its name/model + concreteness:
 *  tree-like → tree, stone/timber-like → rock, any other concrete prop → a generic
 *  marker, and non-concrete clutter → null (not shown). */
function propIcon(def: { name: string; model: string; collisionRadius?: number }): "tree" | "rock" | "object" | null {
  if (def.name === TOWER_PROP_NAME) return null;
  const s = (def.name + " " + def.model).toLowerCase();
  if (/tree|pine|bush|palm|oak|shrub|fern/.test(s)) return "tree";
  if (/stone|rock|timber|boulder|cliff|ore|crystal/.test(s)) return "rock";
  if ((def.collisionRadius ?? 0) > 0) return "object"; // any other concrete element
  return null;
}

/**
 * Maps drawn on 2D canvases over the WebGL view, rotated to match the isometric
 * camera so directions line up with the 3D world (read straight off the synced
 * room state each frame, so movement is tracked in real time):
 *
 *   • RADAR  — a small always-on minimap in the top-left, centred on you.
 *   • SAMPLE — hold TAB for a bigger, 3×-zoomed peek centred on you.
 *   • FULL   — press M (Esc to close) shows the whole world.
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
  private corner!: HTMLElement; // the top-left radar wrapper
  private cornerCtx: CanvasRenderingContext2D;
  private playerList!: HTMLElement; // connected-players panel on the big map
  private lastPlayerSig = ""; // rebuild the list only when the roster changes
  private avatars = new Map<string, HTMLImageElement>(); // nostr avatar url → image (lazy-loaded)
  private tooltip!: HTMLElement; // hover tooltip on the big map
  private overlayView = { cx: 0, cz: 0, scale: BASE_SCALE }; // last big-map transform (for hit-testing)

  private tabHeld = false; // hold TAB → sample view
  private fullOpen = false; // M / Esc → full view
  private props?: PropManager; // imported world props (trees/rocks/concrete elements)

  constructor(private net: NetworkClient) {
    const { overlayCanvas, cornerCanvas } = this.buildDom();
    this.overlayCtx = overlayCanvas.getContext("2d")!;
    this.cornerCtx = cornerCanvas.getContext("2d")!;
    this.bindKeys();
  }

  /** Wire in the imported-prop registry so the map can icon them. */
  setProps(props: PropManager) {
    this.props = props;
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
      this.overlayView = { cx: full ? 0 : px, cz: full ? 0 : pz, scale }; // for hover hit-testing
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

    // ---- trees, stones & imported props as simple icons (fog dims far ones) ----
    if (state) {
      state.rocks.forEach((r) => {
        if (!r.alive) return;
        const [x, y] = proj(r.x, r.z);
        if (!onScreen(x, y)) return;
        this.rockIcon(ctx, x, y, Math.max(2.5, r.radius * scale));
      });
      const treeS = 4.2 * Math.sqrt(scale / BASE_SCALE); // grow a little with zoom so they read
      state.trees.forEach((t) => {
        if (!t.alive) return;
        const [x, y] = proj(t.x, t.z);
        if (!onScreen(x, y)) return;
        this.treeIcon(ctx, x, y, treeS);
      });
    }
    // imported props (Dev Mode): trees, rocks/timber, and other concrete elements
    for (const p of this.props?.all() ?? []) {
      const kind = propIcon(p.def);
      if (!kind) continue;
      const [x, y] = proj(p.def.x, p.def.z);
      if (!onScreen(x, y)) continue;
      const s = Math.min(9, Math.max(2.6, p.def.scale * 0.5 * scale));
      if (kind === "tree") this.treeIcon(ctx, x, y, s);
      else if (kind === "rock") this.rockIcon(ctx, x, y, s);
      else this.propMarker(ctx, x, y, s);
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

    // ---- La Crypta objective and the healing tower — always visible above fog ----
    state?.houses.forEach((h) => {
      const [hx, hy] = proj(h.x, h.z);
      this.drawHouse(ctx, hx, hy, scale, h.alive);
    });
    for (const tower of this.props?.all() ?? []) {
      if (tower.def.name !== TOWER_PROP_NAME) continue;
      const [tx, ty] = proj(tower.def.x, tower.def.z);
      this.drawTowerCross(ctx, tx, ty, scale, true);
    }

    // ---- characters: only those within vision (self always shown), crisp on top ----
    const r2 = REVEAL_RADIUS * REVEAL_RADIUS;
    const inSight = (x: number, z: number) => (x - meX) ** 2 + (z - meZ) ** 2 <= r2;
    if (state) {
      // other players — their nostr avatar if they have one, else a blue dot
      state.players.forEach((p, id) => {
        if (p.hp <= 0 || id === selfId || !inSight(p.x, p.z)) return;
        const [x, y] = proj(p.x, p.z);
        this.playerMarker(ctx, x, y, false, p.nostrVerified && p.picture ? p.picture : "");
      });
      state.enemies.forEach((e) => {
        if (e.hp <= 0 || !inSight(e.x, e.z)) return;
        const color = e.kind === "goblin" ? COLORS.enemy : COLORS.neutral;
        const [x, y] = proj(e.x, e.z);
        this.dot(ctx, x, y, 4.4, color, "rgba(0,0,0,0.5)");
      });
    }

    // you — always shown, on top: your nostr avatar (if logged in) or a ringed dot
    this.playerMarker(ctx, fx, fy, true, me?.nostrVerified && me.picture ? me.picture : "");
  }

  /** Load (and cache) a nostr avatar by url. Returns the image only once it's ready
   *  to draw, so callers fall back to a dot until then. No crossOrigin: avatars live
   *  on arbitrary hosts and we only ever draw them (never read the canvas back). */
  private avatar(url: string): HTMLImageElement | null {
    let img = this.avatars.get(url);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.src = url;
      this.avatars.set(url, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  /** Draw a player's map marker: a circular nostr avatar (with a faction ring) if
   *  they're logged in with one, otherwise the usual coloured dot. */
  private playerMarker(ctx: CanvasRenderingContext2D, px: number, py: number, isSelf: boolean, pictureUrl: string) {
    const ring = isSelf ? COLORS.self : COLORS.ally;
    const img = pictureUrl ? this.avatar(pictureUrl) : null;
    if (img) {
      const r = isSelf ? 8 : 6.2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, px - r, py - r, r * 2, r * 2);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.6, r * 0.28);
      ctx.strokeStyle = ring;
      ctx.stroke();
      if (isSelf) {
        ctx.beginPath();
        ctx.arc(px, py, r + 1.8, 0, Math.PI * 2);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }
    } else {
      this.dot(ctx, px, py, isSelf ? 5.8 : 4.4, ring, "rgba(0,0,0,0.55)");
      if (isSelf) {
        ctx.beginPath();
        ctx.arc(px, py, 8.8, 0, Math.PI * 2);
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }
    }
  }

  /** La Crypta, the home objective. Drawn ON TOP of the fog so it's always visible. */
  private drawHouse(
    ctx: CanvasRenderingContext2D,
    hx: number,
    hy: number,
    scale: number,
    alive: boolean,
  ) {
    const footPx = HOUSE_COLLISION_RADIUS * scale;
    const h = Math.min(58, Math.max(18, footPx * 1.8));

    const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, h * 2.3);
    glow.addColorStop(0, alive ? "rgba(255,206,104,0.5)" : "rgba(255,80,80,0.42)");
    glow.addColorStop(1, "rgba(255,206,104,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(hx, hy, h * 2.3, 0, Math.PI * 2);
    ctx.fill();

    const bodyW = h * 1.5;
    const bodyH = h * 1.05;
    const roofH = h * 0.9;
    const over = h * 0.22;
    const topY = hy - (roofH + bodyH) / 2;
    const bodyTop = topY + roofH;
    const left = hx - bodyW / 2;
    const right = hx + bodyW / 2;
    const bodyBot = bodyTop + bodyH;

    ctx.lineJoin = "round";
    ctx.strokeStyle = "#2a1b0d";
    ctx.lineWidth = Math.max(1.5, h * 0.13);

    ctx.fillStyle = alive ? "#f2d489" : "#b99a77";
    ctx.beginPath();
    ctx.rect(left, bodyTop, bodyW, bodyH);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = alive ? "#d98a25" : "#7b5740";
    ctx.beginPath();
    ctx.moveTo(hx, topY);
    ctx.lineTo(right + over, bodyTop);
    ctx.lineTo(left - over, bodyTop);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const doorW = bodyW * 0.3;
    const doorH = bodyH * 0.58;
    ctx.fillStyle = "#5a3b18";
    ctx.beginPath();
    ctx.rect(hx - doorW / 2, bodyBot - doorH, doorW, doorH);
    ctx.fill();
    ctx.stroke();
  }

  /** The repair tower marker. */
  private drawTowerCross(
    ctx: CanvasRenderingContext2D,
    hx: number,
    hy: number,
    scale: number,
    alive: boolean,
  ) {
    const footPx = HOUSE_COLLISION_RADIUS * scale;
    const h = Math.min(48, Math.max(14, footPx * 1.65));

    const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, h * 2.5);
    glow.addColorStop(0, alive ? "rgba(116,255,148,0.58)" : "rgba(255,80,80,0.42)");
    glow.addColorStop(1, "rgba(116,255,148,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(hx, hy, h * 2.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.5, h * 0.12);
    ctx.strokeStyle = "rgba(8,38,20,0.9)";
    ctx.fillStyle = alive ? "#eaffef" : "#ffd9d9";
    const arm = h * 0.32;
    const long = h * 0.92;
    ctx.beginPath();
    ctx.rect(hx - arm / 2, hy - long, arm, long * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(hx - long, hy - arm / 2, long * 2, arm);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(hx, hy, h * 1.34, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, h * 0.08);
    ctx.strokeStyle = "rgba(234,255,239,0.82)";
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

  /** Simple pine icon (brown trunk + green triangle), half-size `s`. */
  private treeIcon(ctx: CanvasRenderingContext2D, px: number, py: number, s: number) {
    ctx.fillStyle = "#5a3b1e";
    ctx.fillRect(px - s * 0.14, py + s * 0.35, s * 0.28, s * 0.55); // trunk
    ctx.beginPath();
    ctx.moveTo(px, py - s);
    ctx.lineTo(px + s * 0.85, py + s * 0.45);
    ctx.lineTo(px - s * 0.85, py + s * 0.45);
    ctx.closePath();
    ctx.fillStyle = COLORS.tree;
    ctx.fill();
    ctx.lineWidth = Math.max(0.7, s * 0.14);
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.stroke();
  }

  /** Simple angular boulder icon, half-size `s`. */
  private rockIcon(ctx: CanvasRenderingContext2D, px: number, py: number, s: number) {
    ctx.beginPath();
    ctx.moveTo(px - s, py + s * 0.45);
    ctx.lineTo(px - s * 0.55, py - s * 0.5);
    ctx.lineTo(px + s * 0.2, py - s * 0.72);
    ctx.lineTo(px + s, py - s * 0.05);
    ctx.lineTo(px + s * 0.55, py + s * 0.6);
    ctx.closePath();
    ctx.fillStyle = COLORS.stone;
    ctx.fill();
    ctx.lineWidth = Math.max(0.7, s * 0.14);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.stroke();
  }

  /** Generic "concrete element" icon — a small amber block, half-size `s`. */
  private propMarker(ctx: CanvasRenderingContext2D, px: number, py: number, s: number) {
    const c = s * 0.78;
    ctx.fillStyle = "#cdb27a";
    ctx.fillRect(px - c, py - c, c * 2, c * 2);
    ctx.lineWidth = Math.max(0.7, s * 0.14);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.strokeRect(px - c, py - c, c * 2, c * 2);
  }

  /** Rebuild the connected-players panel (name · level · nostr badge). Nostr-verified
   *  players link out to njump.me for their npub. Only rebuilt when the roster changes. */
  private renderPlayerList(state: GameState | undefined, selfId: string | undefined) {
    const rows: { id: string; name: string; level: number; deaths: number; verified: boolean; pubkey: string }[] = [];
    state?.players.forEach((p, id) => {
      rows.push({
        id,
        name: p.name || "Anon",
        level: p.level,
        deaths: p.deaths ?? 0,
        verified: !!p.nostrVerified && !!p.pubkey,
        pubkey: p.pubkey,
      });
    });
    rows.sort((a, b) => {
      if (a.id === selfId) return -1; // you, first
      if (b.id === selfId) return 1;
      return b.level - a.level || a.name.localeCompare(b.name); // then by level, then name
    });

    const sig = rows.map((r) => `${r.id}:${r.name}:${r.level}:${r.deaths}:${r.verified ? 1 : 0}`).join("|");
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
        return `<div class="mmRow">${badge}<span class="mmPName">${name}${you}</span><span class="mmLvl">Lv.${r.level}</span><span class="mmDeaths" title="times of death">☠ ${r.deaths}</span></div>`;
      })
      .join("");
    this.playerList.innerHTML = head + body;
    this.lastPlayerSig = sig; // set last, so an error can't strand the list empty
  }

  /** Find the map element under a big-map canvas pixel (mx,my) and build its tooltip,
   *  or null. Mirrors what renderMap draws (vision-gated characters, all world props). */
  private hitTest(mx: number, my: number): { title: string; lines: string[] } | null {
    const { cx, cz, scale } = this.overlayView;
    const S = OVERLAY_PX;
    const px = (x: number, z: number) => S / 2 + ((x - cx) * ISO_RX + (z - cz) * ISO_RZ) * scale;
    const py = (x: number, z: number) => S / 2 - ((x - cx) * ISO_UX + (z - cz) * ISO_UZ) * scale;

    const state = this.net.room?.state;
    const selfId = this.net.room?.sessionId;
    const me = selfId ? state?.players.get(selfId) : undefined;
    const meX = me?.x ?? 0;
    const meZ = me?.z ?? 0;
    const r2 = REVEAL_RADIUS * REVEAL_RADIUS;
    const inSight = (x: number, z: number) => (x - meX) ** 2 + (z - meZ) ** 2 <= r2;

    let bestD = Infinity;
    let best: { title: string; lines: string[] } | null = null;
    const consider = (x: number, z: number, hit: number, build: () => { title: string; lines: string[] }) => {
      const d = Math.hypot(px(x, z) - mx, py(x, z) - my);
      if (d <= hit && d < bestD) {
        bestD = d;
        best = build();
      }
    };

    if (state) {
      state.players.forEach((p, id) => {
        if (p.hp <= 0 || (id !== selfId && !inSight(p.x, p.z))) return;
        consider(p.x, p.z, 13, () => {
          const lines = [`Player · Lv.${p.level}`, `HP ${Math.round(p.hp)} / ${p.maxHp}`];
          if (p.nostrVerified && p.pubkey) {
            lines.push("⚡ Nostr verified");
            try {
              const n = npubEncode(p.pubkey);
              lines.push(n.slice(0, 12) + "…" + n.slice(-6));
            } catch {
              /* bad key — skip the npub line */
            }
          } else {
            lines.push("Anonymous");
          }
          return { title: (p.name || "Anon") + (id === selfId ? " (you)" : ""), lines };
        });
      });
      state.enemies.forEach((e) => {
        if (e.hp <= 0 || !inSight(e.x, e.z)) return;
        const goblin = e.kind === "goblin";
        consider(e.x, e.z, 12, () => ({
          title: goblin ? "Goblin" : "Training Dummy",
          lines: [`${goblin ? "Enemy" : "Neutral"} · Lv.${e.level}`, `HP ${Math.round(e.hp)} / ${e.maxHp}`],
        }));
      });
    }
    state?.houses.forEach((h) => {
      consider(h.x, h.z, 22, () => ({
        title: "La Crypta",
        lines: ["Home objective", `HP ${Math.round(h.hp)} / ${Math.round(h.maxHp)}`],
      }));
    });
    for (const tower of this.props?.all() ?? []) {
      if (tower.def.name !== TOWER_PROP_NAME) continue;
      consider(tower.def.x, tower.def.z, 18, () => ({
        title: "Healing Tower",
        lines: ["Repairs players over time"],
      }));
    }
    // imported props
    for (const pr of this.props?.all() ?? []) {
      const kind = propIcon(pr.def);
      if (!kind) continue;
      consider(pr.def.x, pr.def.z, 12, () => ({
        title: pr.def.name || "Prop",
        lines: [kind === "tree" ? "Tree" : kind === "rock" ? "Rock" : "Concrete prop"],
      }));
    }
    // trees & stones
    if (state) {
      state.trees.forEach((t) => {
        if (!t.alive) return;
        consider(t.x, t.z, 8, () => ({ title: "Tree", lines: [`HP ${Math.round(t.hp)} / ${t.maxHp}`] }));
      });
      state.rocks.forEach((rk) => {
        if (!rk.alive) return;
        consider(rk.x, rk.z, 9, () => ({ title: "Boulder", lines: [`HP ${Math.round(rk.hp)} / ${rk.maxHp}`] }));
      });
    }
    return best;
  }

  private showTooltip(clientX: number, clientY: number, info: { title: string; lines: string[] }) {
    this.tooltip.innerHTML =
      `<div class="mmTtTitle">${esc(info.title)}</div>` +
      info.lines.map((l) => `<div class="mmTtSub">${esc(l)}</div>`).join("");
    this.tooltip.style.display = "block";
    const pad = 16;
    const tw = this.tooltip.offsetWidth;
    const th = this.tooltip.offsetHeight;
    let tx = clientX + pad;
    let ty = clientY + pad;
    if (tx + tw > window.innerWidth - 4) tx = clientX - pad - tw;
    if (ty + th > window.innerHeight - 4) ty = clientY - pad - th;
    this.tooltip.style.left = Math.max(4, tx) + "px";
    this.tooltip.style.top = Math.max(4, ty) + "px";
  }

  private hideTooltip() {
    if (this.tooltip) this.tooltip.style.display = "none";
  }

  // ---- open / close ----
  private refresh() {
    const full = this.fullOpen;
    const open = this.tabHeld || full;
    this.overlay.style.display = open ? "flex" : "none";
    this.corner.style.display = open ? "none" : "block"; // hide the radar while the big map is up
    // M / clicking the radar → a full-screen map with a dark backdrop; the TAB peek
    // stays a smaller, see-through centred panel.
    this.overlay.style.background = full ? "rgba(0,0,0,0.62)" : "transparent";
    const side = full ? "min(100vw, 100vh)" : "86vmin";
    this.panel.style.width = side;
    this.panel.style.height = side;
    this.panel.style.borderRadius = full ? "0" : "14px";
    // hover tooltips only on the full map (the TAB peek stays click-through)
    this.overlayCtx.canvas.style.pointerEvents = full ? "auto" : "none";
    if (!full) this.hideTooltip();
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

  /** Build the corner radar and the centred overlay (frame + canvas + title +
   *  legend), then mount them. */
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
      `box-shadow:0 0 7px rgba(255,206,104,0.9)"></span>La Crypta</span>`;
    const towerSwatch =
      `<span style="display:inline-flex;align-items:center;gap:5px">` +
      `<span style="position:relative;width:12px;height:12px;display:inline-block;` +
      `filter:drop-shadow(0 0 5px rgba(116,255,148,0.9))">` +
      `<span style="position:absolute;left:4px;top:0;width:4px;height:12px;background:#eaffef"></span>` +
      `<span style="position:absolute;left:0;top:4px;width:12px;height:4px;background:#eaffef"></span>` +
      `</span>Tower</span>`;
    legend.innerHTML =
      swatch(COLORS.ally, "Ally") +
      swatch(COLORS.enemy, "Enemy") +
      swatch(COLORS.neutral, "Neutral") +
      swatch(COLORS.self, "You") +
      houseSwatch +
      towerSwatch;

    // connected-players panel (name · level · nostr), top-left of the map
    const playerList = document.createElement("div");
    playerList.id = "mmPlayers";

    panel.append(overlayCanvas, title, legend, playerList);
    overlay.append(panel);

    // ---- hover tooltip (big map only) ----
    const tooltip = document.createElement("div");
    tooltip.id = "mmTooltip";
    overlayCanvas.addEventListener("mousemove", (e) => {
      if (!this.fullOpen) return; // hover only on the full map
      const rect = overlayCanvas.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * OVERLAY_PX;
      const my = ((e.clientY - rect.top) / rect.height) * OVERLAY_PX;
      const info = this.hitTest(mx, my);
      if (info) this.showTooltip(e.clientX, e.clientY, info);
      else this.hideTooltip();
    });
    overlayCanvas.addEventListener("mouseleave", () => this.hideTooltip());

    // Hover/active styling and hide map UI during the splash.
    const style = document.createElement("style");
    style.textContent =
      "#rpgMiniMap:hover{border-color:#8a6a3c}" +
      "body.preGame #rpgMiniMap{display:none!important}" +
      "#mmPlayers{position:absolute;top:12px;right:14px;z-index:2;pointer-events:auto;" +
      "min-width:150px;max-width:46%;max-height:calc(100% - 70px);overflow-y:auto;" +
      "background:rgba(10,8,12,0.6);border:1px solid #6b4f2e;border-radius:8px;padding:8px 10px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.5)}" +
      "#mmPHead{font:700 11px system-ui,sans-serif;letter-spacing:1px;color:#ffd479;" +
      "text-transform:uppercase;margin-bottom:6px}" +
      ".mmRow{display:flex;align-items:center;gap:7px;padding:3px 0;" +
      "font:600 13px system-ui,sans-serif;color:#e8e3d6;white-space:nowrap}" +
      ".mmRow .mmPName{overflow:hidden;text-overflow:ellipsis;max-width:170px}" +
      ".mmLvl{margin-left:auto;color:#c9a36a;font-size:12px}" +
      ".mmDeaths{margin-left:8px;color:#e0726a;font-size:12px}" +
      ".mmNostr.on{color:#c08bff}.mmNostr.off{color:#5f5f68;font-size:11px}" +
      ".mmLink{color:#c08bff;text-decoration:none}" +
      ".mmLink:hover{text-decoration:underline;color:#d7b3ff}" +
      ".mmYou{color:#79e0ff;margin-left:5px;font-size:11px}" +
      "#mmTooltip{position:fixed;z-index:70;display:none;pointer-events:none;" +
      "background:rgba(12,10,14,0.96);border:1px solid #6b4f2e;border-radius:7px;" +
      "padding:6px 9px;font:12px system-ui,sans-serif;color:#e8e3d6;max-width:240px;" +
      "box-shadow:0 6px 18px rgba(0,0,0,0.65)}" +
      "#mmTooltip .mmTtTitle{font-weight:700;color:#ffd479;margin-bottom:2px}" +
      "#mmTooltip .mmTtSub{color:#c3bbab;font-size:11px;line-height:1.45}";

    document.head.append(style);
    document.body.append(corner, overlay, tooltip);

    this.overlay = overlay;
    this.panel = panel;
    this.title = title;
    this.corner = corner;
    this.playerList = playerList;
    this.tooltip = tooltip;
    return { overlayCanvas, cornerCanvas };
  }
}
