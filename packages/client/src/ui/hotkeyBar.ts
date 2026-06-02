import { InventorySlot, ItemType } from "@rpg/shared";

const ICONS: Record<string, string> = { log: "🪵", potion: "🧪", stone: "🪨", banana: "🍌", berserker_potion: "⚡" };
const KEYS = ["Q", "W", "E", "R"];
const THROWABLE: ReadonlySet<string> = new Set(["banana", "stone"]); // hold the key to charge + throw

/**
 * LoL-style ability/item bar (Q W E R) sitting just above the XP bar. Drag an item
 * from the inventory onto a slot to bind that item type to the key. Pressing the
 * key uses it: a banana slot is *thrown* (the charge-and-release is owned by the
 * click-to-move input, gated via `itemForKey`/`hasStock`); other items are consumed.
 */
export class HotkeyBar {
  private slotEls: HTMLElement[] = [];
  private icons: HTMLElement[] = [];
  private counts: HTMLElement[] = [];
  private binds: (ItemType | "")[] = ["banana", "", "", ""]; // Q defaults to the banana
  private inv: InventorySlot[] = [];
  private autoFilled = new Set<string>(); // item types already auto-assigned a quick slot
  private dragSrc: number | null = null; // quick slot currently being dragged
  private dropHandled = false; // a drag that landed on a quick slot (so dragend won't clear it)

  constructor(private useSlot: (index: number) => void) {
    const bar = document.createElement("div");
    bar.id = "hotkeyBar";
    bar.style.cssText =
      "position:fixed; left:50%; bottom:42px; transform:translateX(-50%); z-index:41;" +
      "display:flex; gap:8px; user-select:none;";
    for (let i = 0; i < 4; i++) {
      const slot = document.createElement("div");
      slot.style.cssText =
        "position:relative; width:50px; height:50px; border:2px solid #b58b3a; border-radius:8px;" +
        "background:radial-gradient(circle at 50% 32%, #2a2f3a, #12151c); box-shadow:0 2px 8px #0008, inset 0 0 8px #0007;" +
        "display:flex; align-items:center; justify-content:center; cursor:pointer; transition:border-color 0.1s;";
      const key = document.createElement("div");
      key.textContent = KEYS[i];
      key.style.cssText =
        "position:absolute; top:1px; left:4px; font:bold 11px system-ui,sans-serif; color:#f0d27a; text-shadow:0 1px 2px #000;";
      const icon = document.createElement("div");
      icon.style.cssText = "font-size:26px; line-height:1; pointer-events:none;";
      const count = document.createElement("div");
      count.style.cssText =
        "position:absolute; bottom:1px; right:4px; font:bold 11px system-ui,sans-serif; color:#fff; text-shadow:0 1px 2px #000;";
      slot.append(key, icon, count);

      // drop target: assign the dragged inventory item type to this key
      slot.addEventListener("dragover", (e) => {
        e.preventDefault();
        slot.style.borderColor = "#ffe08a";
      });
      slot.addEventListener("dragleave", () => (slot.style.borderColor = "#b58b3a"));
      slot.addEventListener("drop", (e) => {
        e.preventDefault();
        slot.style.borderColor = "#b58b3a";
        const type = e.dataTransfer?.getData("text/itemtype") as ItemType | "";
        if (!type) return;
        const src = e.dataTransfer?.getData("text/quicksrc");
        // From another quick slot → swap the two bindings (this slot's current
        // occupant moves back to the source). From the inventory → just bind here.
        if (src !== "" && src != null && Number(src) !== i) this.binds[Number(src)] = this.binds[i];
        this.binds[i] = type;
        this.dropHandled = true;
        this.render();
      });
      // clearing: right-click empties the slot
      slot.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.binds[i] = "";
        this.render();
      });
      slot.addEventListener("click", () => this.activate(i));

      // drag a bound slot to rearrange it (drop on another slot) or remove it (drop
      // anywhere outside the quick bar)
      slot.draggable = true;
      slot.addEventListener("dragstart", (e) => {
        if (!this.binds[i]) {
          e.preventDefault();
          return;
        }
        e.dataTransfer?.setData("text/itemtype", this.binds[i]);
        e.dataTransfer?.setData("text/quicksrc", String(i));
        this.dragSrc = i;
        this.dropHandled = false;
        // Empty the slot the instant it's lifted so a drop outside the bar leaves it
        // gone immediately (no native snap-back animation). Deferred one tick so the
        // drag-image snapshot still shows the icon; a drop back onto a slot re-binds it.
        setTimeout(() => {
          if (this.dragSrc === i && this.binds[i]) {
            this.binds[i] = "";
            this.render();
          }
        }, 0);
      });
      slot.addEventListener("dragend", () => {
        if (this.dragSrc === i && !this.dropHandled) {
          this.binds[i] = ""; // dropped outside the bar → unbind
          this.render();
        }
        this.dragSrc = null;
      });

      bar.appendChild(slot);
      this.slotEls.push(slot);
      this.icons.push(icon);
      this.counts.push(count);
    }
    document.body.appendChild(bar);

    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.repeat) return;
      const i = KEYS.indexOf((e.key || "").toUpperCase());
      if (i < 0) return;
      // throwables (banana/stone) are hold+release (owned by ClickToMove); others use here
      if (this.binds[i] && !THROWABLE.has(this.binds[i])) this.activate(i);
    });

    this.render();
  }

  setInventory(slots: InventorySlot[]) {
    this.inv = slots;
    this.autoFill();
    this.render();
  }

  /** The first items acquired auto-fill the quick bar's empty slots (each item type
   *  once); once the bar is full, further loot just stacks in the inventory. A type
   *  the player later drags off the bar won't re-fill (it's remembered here). */
  private autoFill() {
    for (const s of this.inv) {
      const t = s.type;
      if (!t || s.count <= 0 || this.autoFilled.has(t)) continue;
      this.autoFilled.add(t); // consider each type only once
      if (this.binds.includes(t)) continue; // already bound (e.g. Q's default banana)
      const empty = this.binds.indexOf("");
      if (empty >= 0) this.binds[empty] = t;
    }
  }

  /** The item type bound to a keyboard key (Q/W/E/R), or "". */
  itemForKey(key: string): ItemType | "" {
    const i = KEYS.indexOf((key || "").toUpperCase());
    return i >= 0 ? this.binds[i] : "";
  }

  hasStock(type: string): boolean {
    return this.count(type) > 0;
  }

  /** The throwable item (banana/stone, in stock) bound to a key, or "" — the
   *  click-to-move input holds+throws it. */
  throwItemForKey(key: string): "banana" | "stone" | "" {
    const t = this.itemForKey(key);
    return (t === "banana" || t === "stone") && this.hasStock(t) ? t : "";
  }

  private count(type: string): number {
    let n = 0;
    for (const s of this.inv) if (s.type === type) n += s.count;
    return n;
  }

  private activate(i: number) {
    const type = this.binds[i];
    if (!type || THROWABLE.has(type)) return; // throwables are thrown, not "used"
    const idx = this.inv.findIndex((s) => s.type === type && s.count > 0);
    if (idx >= 0) this.useSlot(idx);
  }

  private render() {
    for (let i = 0; i < 4; i++) {
      const type = this.binds[i];
      this.icons[i].textContent = type ? (ICONS[type] ?? "❓") : "";
      const n = type ? this.count(type) : 0;
      this.counts[i].textContent = type ? String(n) : "";
      this.slotEls[i].style.opacity = type && n === 0 ? "0.45" : "1";
    }
  }
}
