/**
 * The Dev Mode properties panel. Given a title + field descriptors it renders a
 * compact grouped form; editable fields fire `onChange` live as you drag/type.
 * DevMode decides which fields a selection exposes and what each change does.
 */

type FieldMeta = { section?: string };

export type Field = FieldMeta &
  (
    | { kind: "readonly"; label: string; value: string }
    | { kind: "text"; label: string; value: string; onChange: (v: string) => void }
    | {
        kind: "number";
        label: string;
        value: number;
        min?: number;
        max?: number;
        step?: number;
        onChange: (v: number) => void;
      }
    | {
        kind: "range";
        label: string;
        value: number;
        min: number;
        max: number;
        step: number;
        onChange: (v: number) => void;
      }
    | { kind: "checkbox"; label: string; value: boolean; onChange: (v: boolean) => void }
    | {
        kind: "select";
        label: string;
        value: string;
        options: { value: string; label: string }[];
        onChange: (v: string) => void;
      }
  );

export interface Action {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export class Inspector {
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private pillEl: HTMLElement;
  private scrollEl: HTMLElement;
  private bodyEl: HTMLElement;
  private actionsEl: HTMLElement;
  private emptyEl: HTMLElement;

  constructor() {
    const panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed; right:16px; top:54px; width:min(340px, calc(100vw - 32px)); max-height:calc(100vh - 70px); z-index:46; display:none; flex-direction:column;" +
      "background:linear-gradient(180deg,#121924f5,#0b1018f5); border:1px solid #4b8060; border-radius:8px; color:#e8edf3;" +
      "font:12px/1.45 system-ui,sans-serif; box-shadow:0 18px 55px #000c; overflow:hidden; backdrop-filter:blur(8px);";
    panel.innerHTML = `
      <div style="flex:0 0 auto; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; padding:11px 12px; background:#192231; border-bottom:1px solid #31405a;">
        <div style="min-width:0;">
          <div id="inspSubtitle" style="font:700 10px system-ui,sans-serif; color:#89a3bb; text-transform:uppercase; letter-spacing:.08em;">Selection</div>
          <b id="inspTitle" style="display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#eaf7ee; font-size:14px;">Properties</b>
        </div>
        <div id="inspPill" style="display:none; max-width:118px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#bdf1c4; background:#1f3f2b; border:1px solid #4a9a52; border-radius:999px; padding:3px 8px; font-weight:700;"></div>
      </div>
      <div id="inspScroll" style="flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain;">
        <div id="inspBody" style="padding:10px; display:grid; gap:10px;"></div>
        <div id="inspActions" style="position:sticky; bottom:0; padding:10px; display:flex; gap:7px; flex-wrap:wrap; background:linear-gradient(180deg,#0b101800,#0b1018 30%); border-top:1px solid #253348;"></div>
        <div id="inspEmpty" style="margin:10px; padding:18px 14px; color:#9fb0c0; font-size:12px; border:1px dashed #35445e; border-radius:7px; background:#0b111a;">
          <div style="font-weight:800; color:#eaf7ee; margin-bottom:4px;">No selection</div>
          <div>Click an object in the world to edit its properties.</div>
        </div>
      </div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.titleEl = panel.querySelector("#inspTitle") as HTMLElement;
    this.subtitleEl = panel.querySelector("#inspSubtitle") as HTMLElement;
    this.pillEl = panel.querySelector("#inspPill") as HTMLElement;
    this.scrollEl = panel.querySelector("#inspScroll") as HTMLElement;
    this.bodyEl = panel.querySelector("#inspBody") as HTMLElement;
    this.actionsEl = panel.querySelector("#inspActions") as HTMLElement;
    this.emptyEl = panel.querySelector("#inspEmpty") as HTMLElement;
  }

  /** Render a selection. Pass null to show the "nothing selected" hint. */
  setSelection(title: string | null, fields: Field[] = [], actions: Action[] = []) {
    this.bodyEl.innerHTML = "";
    this.actionsEl.innerHTML = "";
    const empty = title === null;
    this.emptyEl.style.display = empty ? "block" : "none";
    this.bodyEl.style.display = empty ? "none" : "grid";
    this.actionsEl.style.display = empty || !actions.length ? "none" : "flex";
    this.scrollEl.scrollTop = 0;

    if (empty) {
      this.subtitleEl.textContent = "Selection";
      this.titleEl.textContent = "Properties";
      this.pillEl.style.display = "none";
      return;
    }

    const parsed = parseTitle(title);
    this.subtitleEl.textContent = parsed.kind ? "Editing" : "Selection";
    this.titleEl.textContent = parsed.name;
    this.pillEl.textContent = parsed.kind;
    this.pillEl.style.display = parsed.kind ? "block" : "none";

    for (const section of groupFields(fields)) this.bodyEl.appendChild(this.sectionEl(section));
    for (const a of actions) this.actionsEl.appendChild(this.actionBtn(a));
  }

  show() {
    this.panel.style.display = "flex";
  }
  hide() {
    this.panel.style.display = "none";
  }

  private sectionEl(section: FieldSection): HTMLElement {
    const wrap = document.createElement("section");
    wrap.style.cssText =
      "border:1px solid #26354a; border-radius:7px; background:#121a27; overflow:hidden;";

    const head = document.createElement("div");
    head.style.cssText =
      "display:flex; align-items:center; gap:7px; padding:7px 9px; background:#172233; border-bottom:1px solid #26354a;";
    const marker = document.createElement("span");
    marker.style.cssText =
      `width:8px; height:8px; flex:none; border-radius:50%; background:${sectionColor(section.title)}; box-shadow:0 0 10px ${sectionColor(section.title)}66;`;
    const title = document.createElement("div");
    title.textContent = section.title;
    title.style.cssText = "font:800 11px system-ui,sans-serif; color:#dce8f4; text-transform:uppercase; letter-spacing:.06em;";
    const count = document.createElement("div");
    count.textContent = String(section.fields.length);
    count.style.cssText = "margin-left:auto; color:#86a0b9; font:700 10px system-ui,sans-serif;";
    head.append(marker, title, count);

    const body = document.createElement("div");
    body.style.cssText = "display:grid; gap:1px; padding:6px;";
    for (const f of section.fields) body.appendChild(this.fieldRow(f));
    wrap.append(head, body);
    return wrap;
  }

  private fieldRow(f: Field): HTMLElement {
    const row = document.createElement("label");
    row.style.cssText =
      "display:grid; grid-template-columns:minmax(88px,.85fr) minmax(0,1fr); align-items:center; gap:8px; min-height:32px; padding:4px 5px; border-radius:6px;";
    row.onmouseenter = () => (row.style.background = "#192334");
    row.onmouseleave = () => (row.style.background = "transparent");

    const name = document.createElement("span");
    name.textContent = labelText(f.label);
    name.title = f.label;
    name.style.cssText = "color:#9fb0c0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
    row.appendChild(name);

    if (f.kind === "readonly") {
      const v = document.createElement("span");
      v.textContent = f.value;
      v.title = f.value;
      v.style.cssText =
        "min-width:0; color:#e8edf3; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:700;";
      row.appendChild(v);
      return row;
    }
    if (f.kind === "checkbox") {
      row.appendChild(this.toggleInput(f.value, f.onChange));
      return row;
    }
    if (f.kind === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.value = f.value;
      input.style.cssText = controlCss();
      input.oninput = () => f.onChange(input.value);
      row.appendChild(input);
      return row;
    }
    if (f.kind === "select") {
      const sel = document.createElement("select");
      sel.style.cssText = controlCss() + "appearance:auto;";
      for (const o of f.options) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        if (o.value === f.value) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => f.onChange(sel.value);
      row.appendChild(sel);
      return row;
    }
    if (f.kind === "range") {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:grid; grid-template-columns:minmax(80px,1fr) 44px; align-items:center; gap:7px;";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(f.min);
      input.max = String(f.max);
      input.step = String(f.step);
      input.value = String(f.value);
      input.style.cssText = "width:100%; accent-color:#83d18b;";
      const out = document.createElement("span");
      out.textContent = trim(f.value);
      out.style.cssText = valuePillCss();
      input.oninput = () => {
        const v = +input.value;
        out.textContent = trim(v);
        f.onChange(v);
      };
      wrap.append(input, out);
      row.appendChild(wrap);
      return row;
    }
    // number
    const input = document.createElement("input");
    input.type = "number";
    if (f.min !== undefined) input.min = String(f.min);
    if (f.max !== undefined) input.max = String(f.max);
    input.step = String(f.step ?? 1);
    input.value = String(f.value);
    input.style.cssText = controlCss() + "text-align:right;";
    input.oninput = () => f.onChange(+input.value);
    row.appendChild(input);
    return row;
  }

  private toggleInput(value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const wrap = document.createElement("span");
    wrap.style.cssText = "justify-self:end; position:relative; width:42px; height:24px; display:inline-block;";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;
    input.style.cssText = "position:absolute; inset:0; opacity:0; cursor:pointer; margin:0;";
    const track = document.createElement("span");
    track.style.cssText =
      "position:absolute; inset:0; border-radius:999px; border:1px solid #35445e; background:#0b111a; transition:background .12s,border-color .12s;";
    const knob = document.createElement("span");
    knob.style.cssText =
      "position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#90a0b5; transition:transform .12s,background .12s; box-shadow:0 1px 4px #0009;";
    const reflect = () => {
      track.style.background = input.checked ? "#244e34" : "#0b111a";
      track.style.borderColor = input.checked ? "#57b66a" : "#35445e";
      knob.style.background = input.checked ? "#9fe0a0" : "#90a0b5";
      knob.style.transform = input.checked ? "translateX(18px)" : "translateX(0)";
    };
    input.onchange = () => {
      reflect();
      onChange(input.checked);
    };
    reflect();
    wrap.append(track, knob, input);
    return wrap;
  }

  private actionBtn(a: Action): HTMLElement {
    const btn = document.createElement("button");
    btn.textContent = a.label;
    btn.style.cssText =
      "cursor:pointer; flex:1 1 120px; color:#fff; border:1px solid; border-radius:6px; padding:8px 9px; font:800 12px system-ui,sans-serif;" +
      (a.danger
        ? "background:#4d2530; border-color:#8c4050;"
        : "background:#244e34; border-color:#57a968;");
    btn.onmouseenter = () => (btn.style.filter = "brightness(1.12)");
    btn.onmouseleave = () => (btn.style.filter = "none");
    btn.onclick = a.onClick;
    return btn;
  }
}

interface FieldSection {
  title: string;
  fields: Field[];
}

function groupFields(fields: Field[]): FieldSection[] {
  const sections: FieldSection[] = [];
  const byTitle = new Map<string, FieldSection>();
  for (const f of fields) {
    const title = f.section ?? sectionFor(f.label);
    let section = byTitle.get(title);
    if (!section) {
      section = { title, fields: [] };
      byTitle.set(title, section);
      sections.push(section);
    }
    section.fields.push(f);
  }
  return sections;
}

function sectionFor(label: string): string {
  const l = label.toLowerCase();
  if (["name", "kind"].includes(l)) return "Identity";
  if (l === "x" || l === "z" || l.includes("rot") || l === "scale") return "Transform";
  if (l.includes("radius") || l === "concrete") return "Physics";
  if (l.includes("hp") || l === "alive" || l === "note") return "Vitals";
  if (l === "brain") return "Behavior";
  if (l.includes("attack") || l.includes("armor") || l.includes("crit") || l.includes("move") || l.includes("throw") || l === "level") return "Stats";
  if (l.includes("drop") || l.includes("quantity") || l.includes("amount") || l.includes("chance") || l.includes("trigger") || l.includes("dmg / item")) return "Drops";
  if (l.includes("spawn") || l.includes("interval") || l.includes("max alive") || l.includes("atk cd") || l.includes("remove spawn")) return "Spawners";
  if (l.includes("mask") || l.includes("vertex")) return "Structure";
  return "Details";
}

function sectionColor(title: string): string {
  switch (title) {
    case "Identity":
      return "#f0c86a";
    case "Transform":
      return "#7ab7ff";
    case "Physics":
      return "#a7b6c7";
    case "Vitals":
      return "#ff8f80";
    case "Stats":
      return "#d6a2ff";
    case "Behavior":
      return "#ffbd73";
    case "Drops":
      return "#83d18b";
    case "Spawners":
      return "#7ed6d1";
    case "Structure":
      return "#d4a46f";
    default:
      return "#8fa8c0";
  }
}

function parseTitle(title: string): { kind: string; name: string } {
  const [kind, rest] = title.split("·").map((s) => s.trim());
  if (!rest) return { kind: "", name: title };
  return { kind: kind || "", name: rest || title };
}

const labelText = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const trim = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

const controlCss = () =>
  "min-width:0; width:100%; height:30px; box-sizing:border-box; border:1px solid #35445e; border-radius:6px; background:#0b111a; color:#eef4fb; padding:0 8px; font:12px system-ui,sans-serif; outline:none;";

const valuePillCss = () =>
  "min-width:0; box-sizing:border-box; text-align:right; color:#e8edf3; background:#0b111a; border:1px solid #2c3a50; border-radius:6px; padding:4px 6px; font:800 11px system-ui,sans-serif;";
