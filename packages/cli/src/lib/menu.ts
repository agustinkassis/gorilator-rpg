import readline from "node:readline";
import { ask } from "./proc.js";

export interface MenuItem {
  label: string;
  hint?: string;
}

function render(title: string, items: MenuItem[], selected: number): void {
  process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
  process.stdout.write(`${title}\n\n`);
  items.forEach((item, i) => {
    const marker = i === selected ? ">" : " ";
    const hint = item.hint ? `  ${item.hint}` : "";
    process.stdout.write(`${marker} ${item.label}${hint}\n`);
  });
  process.stdout.write("\nUse Up/Down, Enter to select, q/Esc to go back.\n");
}

function selectNumbered(title: string, items: MenuItem[]): number {
  process.stdout.write(`${title}\n\n`);
  items.forEach((item, i) => {
    const hint = item.hint ? `  ${item.hint}` : "";
    process.stdout.write(`${i + 1}. ${item.label}${hint}\n`);
  });
  const raw = ask("\nChoose an option (blank to go back): ");
  if (!raw) return -1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= items.length ? n - 1 : -1;
}

export async function selectMenu(title: string, items: MenuItem[]): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return selectNumbered(title, items);
  }

  return new Promise((resolve) => {
    let selected = 0;
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
        selected = (selected + items.length - 1) % items.length;
        render(title, items, selected);
      } else if (key.name === "down" || key.name === "j") {
        selected = (selected + 1) % items.length;
        render(title, items, selected);
      } else if (key.name === "return") cleanup(selected);
      else if (key.name === "escape" || key.name === "q") cleanup(-1);
    };

    readline.emitKeypressEvents(input);
    input.on("keypress", onKey);
    input.setRawMode(true);
    input.resume();
    render(title, items, selected);
  });
}
