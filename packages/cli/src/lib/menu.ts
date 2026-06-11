import readline from "node:readline";
import * as log from "./log.js";
import { ask } from "./proc.js";

export interface MenuItem {
  label: string;
  hint?: string;
  /** Shown dimmed and non-selectable (e.g. an action unavailable right now). */
  disabled?: boolean;
}

function render(title: string, items: MenuItem[], selected: number): void {
  process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
  process.stdout.write(`${title}\n\n`);
  items.forEach((item, i) => {
    const marker = i === selected ? ">" : " ";
    const hint = item.hint ? `  ${item.hint}` : "";
    const line = `${marker} ${item.label}${hint}`;
    process.stdout.write(`${item.disabled ? log.dim(`${line}  (disabled)`) : line}\n`);
  });
  process.stdout.write("\nUse Up/Down, Enter to select, q/Esc to go back.\n");
}

/** First selectable index (skips leading disabled items). */
function firstEnabled(items: MenuItem[]): number {
  const i = items.findIndex((it) => !it.disabled);
  return i < 0 ? 0 : i;
}

/** Step from `from` in `dir` (±1), skipping disabled items; wraps around. */
function step(items: MenuItem[], from: number, dir: number): number {
  const n = items.length;
  let i = from;
  for (let s = 0; s < n; s++) {
    i = (i + dir + n) % n;
    if (!items[i].disabled) return i;
  }
  return from;
}

function selectNumbered(title: string, items: MenuItem[]): number {
  process.stdout.write(`${title}\n\n`);
  items.forEach((item, i) => {
    const hint = item.hint ? `  ${item.hint}` : "";
    const suffix = item.disabled ? "  (disabled)" : "";
    process.stdout.write(`${i + 1}. ${item.label}${hint}${suffix}\n`);
  });
  const raw = ask("\nChoose an option (blank to go back): ");
  if (!raw) return -1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > items.length) return -1;
  if (items[n - 1].disabled) {
    process.stdout.write("That option is currently unavailable.\n");
    return -1;
  }
  return n - 1;
}

export async function selectMenu(title: string, items: MenuItem[]): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return selectNumbered(title, items);
  }

  return new Promise((resolve) => {
    let selected = firstEnabled(items);
    const input = process.stdin;
    const wasRaw = input.isRaw;

    const cleanup = (result: number) => {
      input.off("keypress", onKey);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
      process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
      resolve(result);
    };

    const onKey = (_str: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") cleanup(-1);
      else if (key.name === "up" || key.name === "k") {
        selected = step(items, selected, -1);
        render(title, items, selected);
      } else if (key.name === "down" || key.name === "j") {
        selected = step(items, selected, 1);
        render(title, items, selected);
      } else if (key.name === "return") {
        if (!items[selected]?.disabled) cleanup(selected);
      } else if (key.name === "escape" || key.name === "q") cleanup(-1);
    };

    readline.emitKeypressEvents(input);
    input.on("keypress", onKey);
    input.setRawMode(true);
    input.resume();
    render(title, items, selected);
  });
}
