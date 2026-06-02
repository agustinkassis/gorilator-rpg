/**
 * The Dev Mode properties panel. Given a title + a list of field descriptors it
 * renders a small form; editable fields fire `onChange` live as you drag/type.
 * It's deliberately dumb — DevMode decides which fields a given selection exposes
 * and what each change does (move a prop, send a server edit, etc.).
 */

export type Field =
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
    };

export interface Action {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export class Inspector {
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private actionsEl: HTMLElement;
  private emptyEl: HTMLElement;

  constructor() {
    const panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed; right:16px; top:118px; width:280px; z-index:46; display:none;" +
      "background:#10131af2; border:2px solid #4a9a52; border-radius:10px; color:#e8e8e8;" +
      "font:13px/1.5 system-ui,sans-serif; box-shadow:0 8px 30px #000a; overflow:hidden;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 12px; background:#1c2230; border-bottom:1px solid #4a9a52;">
        <b id="inspTitle" style="color:#9fe0a0;">Properties</b>
      </div>
      <div id="inspBody" style="padding:10px 14px; display:flex; flex-direction:column; gap:8px;"></div>
      <div id="inspActions" style="padding:0 14px 12px; display:flex; gap:6px;"></div>
      <div id="inspEmpty" style="padding:14px; color:#8aa; font-size:12px;">Click an object to edit it.</div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.titleEl = panel.querySelector("#inspTitle") as HTMLElement;
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
    this.bodyEl.style.display = empty ? "none" : "flex";
    this.actionsEl.style.display = empty || !actions.length ? "none" : "flex";
    this.titleEl.textContent = empty ? "Properties" : title;
    if (empty) return;
    for (const f of fields) this.bodyEl.appendChild(this.fieldRow(f));
    for (const a of actions) this.actionsEl.appendChild(this.actionBtn(a));
  }

  show() {
    this.panel.style.display = "block";
  }
  hide() {
    this.panel.style.display = "none";
  }

  private fieldRow(f: Field): HTMLElement {
    const row = document.createElement("label");
    row.style.cssText =
      "display:flex; justify-content:space-between; align-items:center; gap:8px;";
    const name = document.createElement("span");
    name.textContent = f.label;
    name.style.cssText = "color:#9fb0c0; white-space:nowrap;";
    row.appendChild(name);

    if (f.kind === "readonly") {
      const v = document.createElement("span");
      v.textContent = f.value;
      v.style.cssText = "color:#e8e8e8; text-align:right;";
      row.appendChild(v);
      return row;
    }
    if (f.kind === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = f.value;
      input.onchange = () => f.onChange(input.checked);
      row.appendChild(input);
      return row;
    }
    if (f.kind === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.value = f.value;
      input.style.cssText = "width:150px;";
      input.oninput = () => f.onChange(input.value);
      row.appendChild(input);
      return row;
    }
    if (f.kind === "select") {
      const sel = document.createElement("select");
      sel.style.cssText = "width:150px;";
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
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(f.min);
      input.max = String(f.max);
      input.step = String(f.step);
      input.value = String(f.value);
      input.style.cssText = "flex:1; min-width:90px;";
      const out = document.createElement("span");
      out.textContent = trim(f.value);
      out.style.cssText = "width:42px; text-align:right; color:#e8e8e8;";
      input.oninput = () => {
        const v = +input.value;
        out.textContent = trim(v);
        f.onChange(v);
      };
      row.appendChild(input);
      row.appendChild(out);
      return row;
    }
    // number
    const input = document.createElement("input");
    input.type = "number";
    if (f.min !== undefined) input.min = String(f.min);
    if (f.max !== undefined) input.max = String(f.max);
    input.step = String(f.step ?? 1);
    input.value = String(f.value);
    input.style.cssText = "width:90px; text-align:right;";
    input.oninput = () => f.onChange(+input.value);
    row.appendChild(input);
    return row;
  }

  private actionBtn(a: Action): HTMLElement {
    const btn = document.createElement("button");
    btn.textContent = a.label;
    btn.style.cssText =
      `cursor:pointer; flex:1; color:#fff; border:none; border-radius:5px; padding:7px; font-weight:600;` +
      (a.danger ? "background:#5a3030;" : "background:#3a7a40;");
    btn.onclick = a.onClick;
    return btn;
  }
}

const trim = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
