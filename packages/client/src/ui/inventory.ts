import { InventorySlot, ItemType, INV_SLOTS, INV_COLS } from "@rpg/shared";
import { loadItemDefs, renderItemIcon } from "../items/itemRegistry";

/**
 * Diablo-style grid inventory (DOM). Toggle with the on-screen button or the E
 * key. Click an item to lift it onto the cursor, then click another slot to
 * move/stack/swap it (sent to the server, which is authoritative for contents).
 */
export class InventoryUI {
  private panel: HTMLElement;
  private grid: HTMLElement;
  private cursor: HTMLElement;
  private btn: HTMLElement;
  private slotEls: HTMLElement[] = [];
  private slots: InventorySlot[] = Array.from({ length: INV_SLOTS }, () => ({
    type: "",
    count: 0,
  }));
  private held: number | null = null;
  private open = false;
  private totals: Partial<Record<ItemType, number>> = {}; // per-type totals, to detect pickups
  private primed = false; // first inventory is the baseline (no pop); later ones animate gains

  constructor(
    private onMove: (from: number, to: number) => void,
    private onUse: (slot: number) => void,
  ) {
    this.panel = document.getElementById("invPanel") as HTMLElement;
    this.grid = document.getElementById("invGrid") as HTMLElement;
    this.cursor = document.getElementById("invCursor") as HTMLElement;
    this.btn = document.getElementById("invBtn") as HTMLElement;
    // Compact HUD launcher: bag icon plus hotkey.
    this.btn.innerHTML = `<span class="hudIcon" aria-hidden="true">🎒</span><span class="hudKey">(I)</span>`;
    this.btn.title = "Inventory (I)";
    this.grid.style.gridTemplateColumns = `repeat(${INV_COLS}, 48px)`;

    for (let i = 0; i < INV_SLOTS; i++) {
      const cell = document.createElement("div");
      cell.className = "invSlot";
      cell.addEventListener("click", () => this.clickSlot(i));
      cell.addEventListener("dblclick", () => this.onUse(i)); // e.g. drink a potion
      // drag an item out to a Q/W/E/R hotkey slot to bind it there
      cell.draggable = true;
      cell.addEventListener("dragstart", (e) => {
        const type = this.slots[i]?.type;
        if (type) e.dataTransfer?.setData("text/itemtype", type);
        else e.preventDefault();
      });
      cell.addEventListener("dragover", (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("text/charslot")) {
          e.preventDefault();
          cell.style.borderColor = "#f0d27a";
        }
      });
      cell.addEventListener("dragleave", () => {
        cell.style.borderColor = "";
      });
      cell.addEventListener("drop", (e) => {
        const slotId = e.dataTransfer?.getData("text/charslot");
        if (!slotId) return;
        e.preventDefault();
        cell.style.borderColor = "";
        window.dispatchEvent(new CustomEvent("characterSheet:unequip", { detail: { slotId } }));
      });
      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault(); // right-click also consumes (no browser menu)
        this.onUse(i);
      });
      this.grid.appendChild(cell);
      this.slotEls.push(cell);
    }

    this.btn.addEventListener("click", () => this.toggle());
    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "i" || e.key === "I") this.toggle(); // E is now a Q/W/E/R hotkey
      else if (e.key === "Escape" && this.open) this.toggle();
    });
    window.addEventListener("mousemove", (e) => {
      if (this.held !== null) {
        this.cursor.style.left = `${e.clientX}px`;
        this.cursor.style.top = `${e.clientY}px`;
      }
    });
    window.addEventListener("inventory:consumeHeld", () => {
      if (this.held === null) return;
      this.drop();
      this.render();
    });
    window.addEventListener("items:changed", () => this.render());
    void loadItemDefs().then(() => this.render());

    this.render();
  }

  toggle() {
    if (document.body.classList.contains("preGame")) return;
    this.setOpen(!this.open);
  }

  private setOpen(open: boolean) {
    if (this.open === open) return;
    this.open = open;
    this.panel.style.display = this.open ? "flex" : "none";
    if (!this.open) {
      this.drop();
      this.render(); // put any held (un-dropped) item back in its slot
    }
  }

  setInventory(slots: InventorySlot[]) {
    // Detect pickups (a type's total went up) → fly that item into the bag. The very
    // first inventory is the baseline (starting bananas etc.) so it doesn't all pop.
    const next: Partial<Record<ItemType, number>> = {};
    for (const s of slots) if (s.type) next[s.type] = (next[s.type] ?? 0) + s.count;
    if (this.primed) {
      for (const t of Object.keys(next) as ItemType[]) {
        if ((next[t] ?? 0) > (this.totals[t] ?? 0)) this.flyToBag(t);
      }
    }
    this.totals = next;
    this.primed = true;

    this.slots = slots;
    this.drop(); // a server update invalidates any in-progress drag
    this.render();
  }

  /** Pickup feedback (local player only): the item flies from the player to the bag
   *  icon, zooming in mid-flight, then shrinks into the bag. */
  private flyToBag(type: ItemType) {
    const bag = this.btn.getBoundingClientRect();
    const bx = bag.left + bag.width / 2;
    const by = bag.top + bag.height / 2;
    const sx = window.innerWidth / 2; // the camera-followed player sits at screen centre
    const sy = window.innerHeight / 2;
    const mx = (sx + bx) / 2;
    const my = (sy + by) / 2 - 70; // arc upward on the way to the bag

    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;left:0;top:0;z-index:80;pointer-events:none;font-size:30px;" +
      "filter:drop-shadow(0 2px 4px rgba(0,0,0,0.6));will-change:transform,opacity;";
    renderItemIcon(el, type, 30);
    document.body.appendChild(el);
    const at = (x: number, y: number, s: number) => `translate(${x - 15}px,${y - 15}px) scale(${s})`;
    el.animate(
      [
        { transform: at(sx, sy, 0.6), opacity: 0 },
        { transform: at(sx, sy, 2), opacity: 1, offset: 0.22 }, // zoom in at the player
        { transform: at(mx, my, 1.4), opacity: 1, offset: 0.6 },
        { transform: at(bx, by, 0.35), opacity: 0.35 },
      ],
      { duration: 760, easing: "cubic-bezier(0.5,0,0.2,1)" },
    ).onfinish = () => el.remove();
    this.btn.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.3)" }, { transform: "scale(1)" }],
      { duration: 340, easing: "ease-out" },
    );
  }

  /** Total quantity of an item type currently held (e.g. bananas left to throw). */
  count(type: ItemType): number {
    let n = 0;
    for (const s of this.slots) if (s.type === type) n += s.count;
    return n;
  }

  private clickSlot(i: number) {
    if (this.held === null) {
      if (this.slots[i]?.type) {
        this.held = i;
        renderItemIcon(this.cursor, this.slots[i].type, 28);
        this.cursor.style.display = "block";
        this.emitHeld();
        this.render();
      }
    } else {
      if (i !== this.held) this.onMove(this.held, i);
      this.drop();
      this.render();
    }
  }

  private drop() {
    this.held = null;
    this.cursor.style.display = "none";
    this.emitHeld();
  }

  private emitHeld() {
    const type = this.held === null ? "" : (this.slots[this.held]?.type ?? "");
    if (type) document.body.dataset.invHeldType = type;
    else delete document.body.dataset.invHeldType;
    window.dispatchEvent(new CustomEvent("inventory:heldChanged", { detail: { type } }));
  }

  private render() {
    for (let i = 0; i < INV_SLOTS; i++) {
      const slot = this.slots[i] ?? { type: "", count: 0 };
      const el = this.slotEls[i];
      const lifted = i === this.held;
      el.classList.toggle("held", lifted);

      if (slot.type && !lifted) {
        el.classList.add("filled");
        renderItemIcon(el, slot.type, 28);
        if (slot.count > 1) {
          const count = document.createElement("span");
          count.className = "invCount";
          count.textContent = String(slot.count);
          el.appendChild(count);
        }
      } else {
        el.classList.remove("filled");
        el.textContent = "";
      }
    }
  }
}
