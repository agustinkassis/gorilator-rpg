import { InventorySlot, ItemType, INV_SLOTS, MAX_STACK } from "@rpg/shared";

/** A fresh empty inventory grid. */
export function makeInventory(): InventorySlot[] {
  return Array.from({ length: INV_SLOTS }, () => ({ type: "", count: 0 }));
}

/** Add `amount` of an item, stacking into existing stacks then empty slots. */
export function addItem(inv: InventorySlot[], type: ItemType, amount = 1): void {
  let remaining = amount;
  for (const slot of inv) {
    if (remaining <= 0) break;
    if (slot.type === type && slot.count < MAX_STACK) {
      const add = Math.min(remaining, MAX_STACK - slot.count);
      slot.count += add;
      remaining -= add;
    }
  }
  for (const slot of inv) {
    if (remaining <= 0) break;
    if (slot.type === "") {
      const add = Math.min(remaining, MAX_STACK);
      slot.type = type;
      slot.count = add;
      remaining -= add;
    }
  }
}

/** Total count of an item across the whole inventory. */
export function countItem(inv: InventorySlot[], type: ItemType): number {
  let n = 0;
  for (const slot of inv) if (slot.type === type) n += slot.count;
  return n;
}

/** Remove up to `amount` of an item; returns how many were actually removed. */
export function removeItem(inv: InventorySlot[], type: ItemType, amount = 1): number {
  let removed = 0;
  for (const slot of inv) {
    if (removed >= amount) break;
    if (slot.type === type && slot.count > 0) {
      const take = Math.min(amount - removed, slot.count);
      slot.count -= take;
      removed += take;
      if (slot.count <= 0) {
        slot.type = "";
        slot.count = 0;
      }
    }
  }
  return removed;
}

/** Move/swap/merge the stack in slot `from` onto slot `to` (grid rearrange). */
export function moveItem(inv: InventorySlot[], from: number, to: number): void {
  if (
    from < 0 ||
    to < 0 ||
    from >= inv.length ||
    to >= inv.length ||
    from === to
  )
    return;

  const a = inv[from];
  const b = inv[to];
  if (a.type === "") return;

  if (b.type === "") {
    inv[to] = { type: a.type, count: a.count };
    inv[from] = { type: "", count: 0 };
  } else if (b.type === a.type) {
    const total = a.count + b.count;
    b.count = Math.min(MAX_STACK, total);
    const leftover = total - b.count;
    inv[from] = leftover > 0 ? { type: a.type, count: leftover } : { type: "", count: 0 };
  } else {
    inv[from] = b;
    inv[to] = a;
  }
}
