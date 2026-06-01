import { InventorySlot, ItemType, INV_SLOTS, INV_COLS } from "@rpg/shared";

/** Emoji icons per item type. */
const ICONS: Record<string, string> = {
  log: "🪵",
  potion: "🧪",
  stone: "🪨",
  banana: "🍌",
};

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

  constructor(
    private onMove: (from: number, to: number) => void,
    private onUse: (slot: number) => void,
  ) {
    this.panel = document.getElementById("invPanel") as HTMLElement;
    this.grid = document.getElementById("invGrid") as HTMLElement;
    this.cursor = document.getElementById("invCursor") as HTMLElement;
    this.btn = document.getElementById("invBtn") as HTMLElement;
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

    this.render();
  }

  toggle() {
    this.open = !this.open;
    this.panel.style.display = this.open ? "flex" : "none";
    if (!this.open) {
      this.drop();
      this.render(); // put any held (un-dropped) item back in its slot
    }
  }

  setInventory(slots: InventorySlot[]) {
    this.slots = slots;
    this.drop(); // a server update invalidates any in-progress drag
    this.render();
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
        this.cursor.textContent = ICONS[this.slots[i].type] ?? "❓";
        this.cursor.style.display = "block";
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
  }

  private render() {
    for (let i = 0; i < INV_SLOTS; i++) {
      const slot = this.slots[i] ?? { type: "", count: 0 };
      const el = this.slotEls[i];
      const lifted = i === this.held;
      el.classList.toggle("held", lifted);

      if (slot.type && !lifted) {
        el.classList.add("filled");
        el.textContent = ICONS[slot.type] ?? "❓";
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
