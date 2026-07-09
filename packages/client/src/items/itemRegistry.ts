export interface ItemDef {
  id: string;
  name: string;
  icon?: string;
  model?: string;
  stack?: number;
  worldScale?: number;
  food?: {
    hunger?: number;
    hp?: number;
    stamina?: number;
  };
}

const BUILTINS: ItemDef[] = [
  { id: "log", name: "Log", icon: "🪵" },
  { id: "potion", name: "Potion", icon: "🧪" },
  { id: "stone", name: "Stone", icon: "🪨" },
  { id: "banana", name: "Banana", icon: "🍌" },
  { id: "berserker_potion", name: "Berserker Potion", icon: "⚡" },
];

let defs = new Map<string, ItemDef>(BUILTINS.map((d) => [d.id, d]));
let loading: Promise<void> | null = null;

export const safeItemId = (raw: string) =>
  String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

export function itemDef(id: string): ItemDef | undefined {
  return defs.get(id);
}

export function allItemDefs(): ItemDef[] {
  return [...defs.values()];
}

export function itemName(id: string): string {
  return defs.get(id)?.name || id.replace(/_/g, " ");
}

export function itemIcon(id: string): string {
  return defs.get(id)?.icon || "❓";
}

export function renderItemIcon(host: HTMLElement, id: string, size = 28) {
  host.textContent = "";
  const icon = itemIcon(id);
  if (/^\/|^https?:|^data:/i.test(icon)) {
    const img = document.createElement("img");
    img.src = icon;
    img.alt = itemName(id);
    img.style.cssText = `width:${size}px; height:${size}px; object-fit:contain; display:block;`;
    host.appendChild(img);
  } else {
    host.textContent = icon;
  }
}

/** Merge plugin-provided item defs into the registry (ClientPluginContext.
 *  registerItemModel). Survives loadItemDefs reloads via the extras overlay. */
const extraDefs = new Map<string, ItemDef>();
export function registerExtraItemDefs(items: ItemDef[]): void {
  for (const def of items) {
    const id = safeItemId(def.id);
    if (!id) continue;
    extraDefs.set(id, { ...def, id });
    defs.set(id, { ...def, id });
  }
  window.dispatchEvent(new Event("items:changed"));
}

export async function loadItemDefs(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const next = new Map<string, ItemDef>(BUILTINS.map((d) => [d.id, d]));
    try {
      const res = await fetch("/items.json", { cache: "no-store" });
      const arr = res.ok ? await res.json() : [];
      if (Array.isArray(arr)) {
        for (const raw of arr) {
          const id = safeItemId(String(raw?.id || ""));
          if (!id) continue;
          next.set(id, {
            id,
            name: String(raw?.name || id),
            icon: typeof raw?.icon === "string" ? raw.icon : undefined,
            model: typeof raw?.model === "string" ? raw.model : undefined,
            stack: Math.max(1, Math.round(Number(raw?.stack) || 99)),
            worldScale: Math.max(0.05, Number(raw?.worldScale) || 1.2),
            food:
              raw?.food && typeof raw.food === "object"
                ? {
                    hunger: finiteNonNegative(raw.food.hunger),
                    hp: finiteNonNegative(raw.food.hp),
                    stamina: finiteNonNegative(raw.food.stamina),
                  }
                : undefined,
          });
        }
      }
    } catch {
      /* keep built-ins */
    }
    for (const [id, def] of extraDefs) next.set(id, def); // plugin defs survive reloads
    defs = next;
    window.dispatchEvent(new Event("items:changed"));
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function finiteNonNegative(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
