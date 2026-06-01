import {
  Scene,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Matrix,
  TransformNode,
} from "@babylonjs/core";
import {
  AdvancedDynamicTexture,
  Rectangle,
  TextBlock,
  Control,
} from "@babylonjs/gui";
import { Entity } from "../entities/Entity";

const BAR_WIDTH = 56;
const MARKER_DURATION = 0.6; // seconds
const DMG_DURATION = 1.1; // floating damage number lifetime
const DMG_RISE = 72; // CSS px the number floats upward over its lifetime
const DMG_HEAD_Y = 2.4; // world height above the anchor origin to spawn at
const DMG_FONT = 44;
const DMG_FONT_CRIT = 60;
const NAME_FONT = 36; // 3× the old 12px nameplate font
const XP_COLOR = "#ffcf4d"; // floating "+N XP" gold (distinct from the green heals)
const BAR_SHOW_SECONDS = 6; // HP bar stays this long after the last damage
const BAR_FADE = 0.6; // bar fade-out duration
const BUBBLE_HEAD_Y = 2.1; // world height above the anchor to float a chat bubble (lower → nearer the head)
const BUBBLE_MIN_SECONDS = 5; // shortest a chat bubble lingers (2× longer)
const BUBBLE_PER_CHAR = 0.1; // +seconds per character (longer lines linger longer)
const BUBBLE_MAX_SECONDS = 16; // cap so a wall of text doesn't hang forever
const BUBBLE_FADE = 0.4; // bubble fade-in / fade-out duration

/** A floating nameplate + HP bar. Reads its live values through closures so the
 *  same machinery serves both characters (Entity) and resources (trees/rocks). */
interface BarRefs {
  root: Rectangle;
  barBg: Rectangle;
  fill: Rectangle;
  fillWidth: number; // full bar width (px) the fill scales against
  getHp: () => number;
  getMaxHp: () => number;
  getAlpha: () => number; // nameplate opacity (fades a character corpse out)
  name?: TextBlock; // characters only
  getLabel?: () => string; // characters: "Name  Lv.X" (re-read when it changes)
  lastLabel: string;
  showTimer: number; // seconds left before the bar fades out (0 = hidden)
}

interface DamageNumber {
  el: HTMLDivElement;
  anchor: TransformNode;
  baseX: number;
  life: number;
}

/** A Helbreath-style speech bubble floating over a character while it "speaks". */
interface ChatBubble {
  el: HTMLDivElement;
  anchor: TransformNode;
  life: number;
  ttl: number; // total lifetime (seconds), scaled by the message length
}

const TEXT_OUTLINE =
  "-2px 0 #000,2px 0 #000,0 -2px #000,0 2px #000,-2px -2px #000,2px 2px #000,-2px 2px #000,2px -2px #000";

/** Floating name + HP bars over characters, floating damage numbers, click marker. */
export class HUD {
  private scene: Scene;
  private ui: AdvancedDynamicTexture;
  private bars = new Map<string, BarRefs>();

  private marker: Mesh;
  private markerLife = 0;

  private damages: DamageNumber[] = [];
  private dmgLayer: HTMLDivElement;

  private bubbles = new Map<string, ChatBubble>(); // one live bubble per speaker
  private bubbleLayer: HTMLDivElement;

  constructor(scene: Scene) {
    this.scene = scene;
    this.ui = AdvancedDynamicTexture.CreateFullscreenUI("ui", true, scene);

    // DOM overlay for crisp, flicker-free floating damage numbers (GUI TextBlocks
    // linked to moving meshes jitter/flash; HTML text is composited smoothly).
    this.dmgLayer = document.createElement("div");
    this.dmgLayer.style.cssText =
      "position:fixed; inset:0; pointer-events:none; overflow:hidden; z-index:25;";
    document.body.appendChild(this.dmgLayer);

    // Chat bubbles ride on their own layer (just under the damage numbers).
    this.bubbleLayer = document.createElement("div");
    this.bubbleLayer.style.cssText =
      "position:fixed; inset:0; pointer-events:none; overflow:hidden; z-index:24;";
    document.body.appendChild(this.bubbleLayer);
    injectBubbleStyles();

    this.marker = MeshBuilder.CreateTorus(
      "clickMarker",
      { diameter: 1.5, thickness: 0.14, tessellation: 28 },
      scene,
    );
    this.marker.isPickable = false;
    const mat = new StandardMaterial("markerMat", scene);
    mat.emissiveColor = new Color3(1, 0.85, 0.35);
    mat.disableLighting = true;
    this.marker.material = mat;
    this.marker.visibility = 0;
  }

  /** Build a nameplate/HP-bar from closures and register it under `id`. */
  private createBar(opts: {
    id: string;
    link: TransformNode;
    linkOffsetY: number;
    width: number;
    height: number;
    barWidth: number;
    fillColor: string;
    getHp: () => number;
    getMaxHp: () => number;
    getAlpha: () => number;
    nameColor?: string;
    getLabel?: () => string;
  }) {
    const root = new Rectangle(`bar-${opts.id}`);
    root.widthInPixels = opts.width;
    root.heightInPixels = opts.height;
    root.thickness = 0;
    // Don't clip children to the box: a wide name (long handle + "Lv.X") or the
    // outline of a tall glyph would otherwise be cropped at the box edge. The
    // name is centered over the head, so letting it overflow looks right.
    root.clipChildren = false;
    this.ui.addControl(root);
    root.linkWithMesh(opts.link);
    root.linkOffsetYInPixels = opts.linkOffsetY;

    let name: TextBlock | undefined;
    if (opts.getLabel) {
      name = new TextBlock(`name-${opts.id}`, opts.getLabel());
      name.color = opts.nameColor ?? "#ffffff";
      name.fontSize = NAME_FONT;
      name.fontStyle = "bold";
      // The glyph line box (~0.9× font) plus the 6px outline needs noticeably more
      // than the old NAME_FONT+8: that box was a few px too short, so the outline
      // and descenders (g/y/p/j) got sliced top & bottom. Give real headroom and
      // never clip the text to the box.
      name.heightInPixels = NAME_FONT + 18;
      name.clipContent = false;
      name.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP; // sits at the very top
      name.outlineColor = "black";
      name.outlineWidth = 6;
      root.addControl(name);
    }

    const barBg = new Rectangle(`barbg-${opts.id}`);
    barBg.widthInPixels = opts.barWidth;
    barBg.heightInPixels = 8;
    barBg.cornerRadius = 2;
    barBg.thickness = 1;
    barBg.color = "#00000088";
    barBg.background = "#1c1f27";
    barBg.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
    barBg.alpha = 0; // hidden until it takes damage
    root.addControl(barBg);

    const fill = new Rectangle(`fill-${opts.id}`);
    fill.heightInPixels = 8;
    fill.widthInPixels = opts.barWidth;
    fill.thickness = 0;
    fill.background = opts.fillColor;
    fill.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    barBg.addControl(fill);

    this.bars.set(opts.id, {
      root,
      barBg,
      fill,
      fillWidth: opts.barWidth,
      getHp: opts.getHp,
      getMaxHp: opts.getMaxHp,
      getAlpha: opts.getAlpha,
      name,
      getLabel: opts.getLabel,
      lastLabel: name ? (name.text ?? "") : "",
      showTimer: 0,
    });
  }

  /** Full character nameplate: a big name + level on top, an HP bar below it. */
  addCharacter(entity: Entity, isEnemy: boolean) {
    this.createBar({
      id: entity.id,
      link: entity.root,
      // taller box + raised offset lift the top-aligned name well above the head
      // while the bottom-aligned HP bar stays put just over the character.
      linkOffsetY: -112,
      width: 240,
      height: 94,
      barWidth: BAR_WIDTH,
      fillColor: entity.isLocal ? "#54d98c" : isEnemy ? "#e0563f" : "#5aa9e6",
      getHp: () => entity.hp,
      getMaxHp: () => entity.maxHp,
      getAlpha: () => entity.nameplateAlpha,
      nameColor: entity.isLocal ? "#ffe08a" : isEnemy ? "#ffb4a8" : "#dfe5f0",
      getLabel: () => `${entity.name}  Lv.${entity.level}`,
    });
  }

  /** HP-bar-only nameplate for a destructible resource (tree, rock). `anchor` sits
   *  at the top of the object; the bar shows only after the resource takes a hit. */
  addResource(
    id: string,
    anchor: TransformNode,
    getHp: () => number,
    getMaxHp: () => number,
    fillColor: string,
  ) {
    this.createBar({
      id,
      link: anchor,
      linkOffsetY: -12,
      width: 70,
      height: 14,
      barWidth: 50,
      fillColor,
      getHp,
      getMaxHp,
      getAlpha: () => 1,
    });
  }

  remove(id: string) {
    const refs = this.bars.get(id);
    if (refs) {
      refs.root.dispose();
      this.bars.delete(id);
    }
    const bubble = this.bubbles.get(id);
    if (bubble) {
      bubble.el.remove();
      this.bubbles.delete(id);
    }
  }

  showClickMarker(point: Vector3) {
    this.marker.position.set(point.x, 0.06, point.z);
    this.marker.scaling.setAll(1);
    this.marker.visibility = 1;
    this.markerLife = MARKER_DURATION;
  }

  /** Reveal a character's HP bar (it fades out after BAR_SHOW_SECONDS without damage). */
  private flashBar(id: string) {
    const bar = this.bars.get(id);
    if (bar) bar.showTimer = BAR_SHOW_SECONDS;
  }

  /** Pop a floating damage number above something that just got hit. */
  showDamage(anchor: TransformNode, id: string, amount: number, crit = false) {
    this.flashBar(id);
    this.pushNumber(
      anchor,
      crit ? `-${amount}!` : `-${amount}`,
      crit ? "#ffd23f" : "#ff5246",
      crit ? DMG_FONT_CRIT : DMG_FONT,
    );
  }

  /** Pop a floating green "+N" heal number (e.g. from a potion). */
  showHeal(anchor: TransformNode, id: string, amount: number) {
    this.flashBar(id);
    this.pushNumber(anchor, `+${amount}`, "#49e06b", DMG_FONT);
  }

  /** Pop a floating gold "+N XP" number over a character that just gained XP. */
  showXp(anchor: TransformNode, amount: number) {
    this.pushNumber(anchor, `+${amount} XP`, XP_COLOR, DMG_FONT);
  }

  private pushNumber(anchor: TransformNode, str: string, color: string, fontSize: number) {
    const el = document.createElement("div");
    el.textContent = str;
    el.style.cssText =
      `position:absolute; left:-999px; top:-999px; transform:translate(-50%,-50%);` +
      `font:900 ${fontSize}px system-ui,-apple-system,sans-serif; white-space:nowrap;` +
      `color:${color}; text-shadow:${TEXT_OUTLINE}; will-change:transform,opacity;`;
    this.dmgLayer.appendChild(el);
    this.damages.push({ el, anchor, baseX: (Math.random() - 0.5) * 40, life: 0 });
  }

  /** Build a world→screen (CSS px) projector for the current frame, or null if
   *  nothing is renderable yet. Shared by the damage numbers and chat bubbles. */
  private makeProjector(): ((world: Vector3) => { x: number; y: number }) | null {
    const cam = this.scene.activeCamera;
    const eng = this.scene.getEngine();
    const canvas = eng.getRenderingCanvas();
    if (!cam || !canvas) return null;
    const rw = eng.getRenderWidth();
    const rh = eng.getRenderHeight();
    const rect = canvas.getBoundingClientRect();
    const fx = rect.width / rw;
    const fy = rect.height / rh;
    const tm = this.scene.getTransformMatrix();
    const vp = cam.viewport.toGlobal(rw, rh);
    return (world: Vector3) => {
      const p = Vector3.Project(world, Matrix.Identity(), tm, vp);
      return { x: rect.left + p.x * fx, y: rect.top + p.y * fy };
    };
  }

  private updateDamages(dt: number) {
    if (this.damages.length === 0) return;
    const project = this.makeProjector();
    if (!project) return;
    const alive: DamageNumber[] = [];
    for (const d of this.damages) {
      d.life += dt;
      const k = d.life / DMG_DURATION;
      if (k >= 1 || d.anchor.isDisposed()) {
        d.el.remove();
        continue;
      }
      const p = d.anchor.getAbsolutePosition();
      const s = project(new Vector3(p.x, p.y + DMG_HEAD_Y, p.z));
      d.el.style.left = `${s.x + d.baseX}px`;
      d.el.style.top = `${s.y - k * DMG_RISE}px`;
      d.el.style.opacity = `${k < 0.65 ? 1 : 1 - (k - 0.65) / 0.35}`;
      alive.push(d);
    }
    this.damages = alive;
  }

  /** Pop (or replace) a Helbreath-style speech bubble over a character. The bubble
   *  sizes itself to the text, and a longer line lingers proportionally longer. */
  showChatBubble(anchor: TransformNode, id: string, text: string) {
    this.bubbles.get(id)?.el.remove(); // a new line replaces this speaker's old bubble
    const el = document.createElement("div");
    el.className = "chatBubble";
    el.textContent = text;
    this.bubbleLayer.appendChild(el);
    const ttl = Math.min(
      BUBBLE_MAX_SECONDS,
      BUBBLE_MIN_SECONDS + text.length * BUBBLE_PER_CHAR,
    );
    this.bubbles.set(id, { el, anchor, life: 0, ttl });
  }

  private updateBubbles(dt: number) {
    if (this.bubbles.size === 0) return;
    const project = this.makeProjector();
    if (!project) return;
    for (const [id, b] of this.bubbles) {
      b.life += dt;
      if (b.life >= b.ttl || b.anchor.isDisposed()) {
        b.el.remove();
        this.bubbles.delete(id);
        continue;
      }
      const p = b.anchor.getAbsolutePosition();
      const s = project(new Vector3(p.x, p.y + BUBBLE_HEAD_Y, p.z));
      b.el.style.left = `${s.x}px`;
      b.el.style.top = `${s.y}px`;
      // ease in on appear, hold, then fade out over the final BUBBLE_FADE seconds
      const fadeIn = Math.min(1, b.life / BUBBLE_FADE);
      const fadeOut = Math.min(1, (b.ttl - b.life) / BUBBLE_FADE);
      b.el.style.opacity = `${Math.min(fadeIn, fadeOut)}`;
    }
  }

  update(dt: number) {
    for (const bar of this.bars.values()) {
      const { root, fill, barBg } = bar;
      const max = bar.getMaxHp();
      const ratio = max > 0 ? Math.max(0, bar.getHp() / max) : 0;
      fill.widthInPixels = bar.fillWidth * ratio;
      fill.isVisible = ratio > 0;
      // The whole nameplate (name + HP bar) fades with the body, so a dissolving
      // corpse takes its floating bar with it instead of leaving it hovering.
      root.alpha = bar.getAlpha();
      // Keep the name/level label current (it changes on level-up).
      if (bar.name && bar.getLabel) {
        const label = bar.getLabel();
        if (label !== bar.lastLabel) {
          bar.name.text = label;
          bar.lastLabel = label;
        }
      }
      // HP bar only shows for a while after taking damage, then fades — and never
      // lingers as an empty bar once the thing is dead/depleted.
      if (bar.showTimer > 0 && ratio > 0) {
        bar.showTimer -= dt;
        barBg.alpha =
          bar.showTimer >= BAR_FADE ? 1 : Math.max(0, bar.showTimer / BAR_FADE);
      } else if (barBg.alpha !== 0) {
        barBg.alpha = 0;
      }
    }

    if (this.markerLife > 0) {
      this.markerLife -= dt;
      const a = Math.max(0, this.markerLife / MARKER_DURATION);
      this.marker.visibility = a;
      this.marker.scaling.setAll(1 + (1 - a) * 0.7);
    }

    this.updateDamages(dt);
    this.updateBubbles(dt);
  }
}

/** Inject the chat-bubble CSS once (rounded dark bubble + a little downward tail
 *  pointing at the speaker's head). */
function injectBubbleStyles() {
  if (document.getElementById("chatBubbleStyles")) return;
  const style = document.createElement("style");
  style.id = "chatBubbleStyles";
  style.textContent = `
    .chatBubble {
      position: absolute;
      transform: translate(-50%, -100%);
      width: max-content;
      max-width: min(42vw, 260px);
      padding: 6px 11px;
      font: 600 14px/1.34 system-ui, -apple-system, sans-serif;
      color: #f7f1e3;
      text-align: center;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: rgba(18, 15, 12, 0.92);
      border: 1.5px solid #6b4f2e;
      border-radius: 12px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
      will-change: left, top, opacity;
    }
    .chatBubble::after {
      content: "";
      position: absolute;
      left: 50%;
      bottom: -7px;
      transform: translateX(-50%);
      border-left: 7px solid transparent;
      border-right: 7px solid transparent;
      border-top: 8px solid rgba(18, 15, 12, 0.92);
      filter: drop-shadow(0 2px 0 #6b4f2e);
    }
  `;
  document.head.appendChild(style);
}
