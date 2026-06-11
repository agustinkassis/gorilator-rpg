// Terminal progress UI for `gorilator update`: a framed, animated multi-step
// checklist with a flowing gradient title, a gradient progress bar with a moving
// head, a shimmer sweep across the active task, a color-cycling spinner, and an
// overall footer meter. Inspired by the look-and-feel of modern AI CLIs.
//
// Degrades gracefully:
//   • truecolor TTY  → the full animated, gradient experience
//   • basic TTY      → same layout, flat colors (no per-char gradients)
//   • non-TTY (CI)   → plain sequential ✓/✗ lines (no cursor tricks)
import * as log from "./log.js";

const TTY = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const TRUECOLOR =
  TTY && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");

// Braille spinner — smooth and dense.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Gorilla/banana theme: gold → lime, with a sky accent for the moving head.
type RGB = [number, number, number];
const GOLD: RGB = [255, 199, 0];
const LIME: RGB = [78, 220, 110];
const SKY: RGB = [120, 200, 255];
const SLATE: RGB = [120, 130, 140];
const HOT: RGB = [255, 255, 255];

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);
const mix = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
const paintRGB = ([r, g, b]: RGB, s: string): string =>
  TRUECOLOR ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s;

/** Color each character along a gold→lime gradient, with a flowing sine offset
 *  so the colors visibly drift across the text frame to frame. */
function gradientText(text: string, offset = 0): string {
  if (!TRUECOLOR) return log.bold(text);
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  return chars
    .map((ch, i) => {
      if (ch === " ") return ch;
      const t = (Math.sin((i / n) * Math.PI * 1.4 - offset) + 1) / 2;
      return paintRGB(mix(GOLD, LIME, t), ch);
    })
    .join("");
}

/** A bright band that sweeps left→right across the label, fading with distance —
 *  the "active task is alive" shimmer. */
function shimmer(text: string, frame: number): string {
  if (!TRUECOLOR) return text;
  const chars = [...text];
  const period = chars.length + 10;
  const head = frame % period;
  return chars
    .map((ch, i) => {
      if (ch === " ") return ch;
      const d = Math.abs(i - head);
      const bright = Math.max(0, 1 - d / 4);
      return paintRGB(mix([205, 214, 224], HOT, bright), ch);
    })
    .join("");
}

/** Determinate gradient bar with a pulsing head at the fill boundary. */
function gbar(frac: number, frame: number, width = 16): string {
  const f = clamp(frac, 0, 0.999);
  const filled = Math.round(f * width);
  let out = "";
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      out += paintRGB(mix(GOLD, LIME, i / Math.max(1, width - 1)), "█");
    } else if (i === filled) {
      const pulse = (Math.sin(frame / 2) + 1) / 2;
      out += paintRGB(mix(SLATE, SKY, pulse), "▓");
    } else {
      out += log.dim("░");
    }
  }
  return `${log.dim("[")}${out}${log.dim("]")}`;
}

/** Indeterminate bar: a glow that bounces back and forth (no known estimate). */
function wave(frame: number, width = 16): string {
  const span = width * 2 - 2;
  const p = frame % span;
  const head = p < width ? p : span - p;
  let out = "";
  for (let i = 0; i < width; i++) {
    const d = Math.abs(i - head);
    const b = Math.max(0, 1 - d / 3);
    out += b > 0 ? paintRGB(mix(SLATE, LIME, b), "█") : log.dim("░");
  }
  return `${log.dim("[")}${out}${log.dim("]")}`;
}

/** Color-cycling spinner glyph. */
function spinGlyph(frame: number): string {
  const ch = FRAMES[frame % FRAMES.length];
  if (!TRUECOLOR) return log.blue(ch);
  return paintRGB(mix(GOLD, LIME, (Math.sin(frame / 3) + 1) / 2), ch);
}

type StepState = "pending" | "running" | "done" | "failed" | "skipped";

interface Step {
  key: string;
  label: string;
  estimateMs?: number;
  state: StepState;
  start?: number;
  end?: number;
  note?: string;
}

export interface StepPlan {
  key: string;
  label: string;
  estimateMs?: number;
}

/** Format a duration compactly: 420ms · 3.2s · 1m05s. */
export function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** A live, animated, framed multi-step progress checklist. */
export class Stepper {
  private readonly steps: Step[];
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private rendered = 0; // lines drawn last frame (TTY only)
  private readonly startedAt = Date.now();

  constructor(
    private readonly title: string,
    plan: StepPlan[],
  ) {
    this.steps = plan.map((p) => ({ ...p, state: "pending" }));
  }

  start(): void {
    if (TTY) {
      process.stdout.write("\x1b[?25l"); // hide cursor
      this.render();
      this.timer = setInterval(() => {
        this.frame++;
        this.render();
      }, 80);
      this.timer.unref?.();
    } else {
      process.stdout.write(`${log.bold(this.title)}\n`);
    }
  }

  /** Run a planned step: mark it running (spinner) → done/failed; returns fn's
   *  result, or rethrows (leaving the step marked failed). */
  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const step = this.find(key);
    step.state = "running";
    step.start = Date.now();
    if (!TTY) process.stdout.write(`${log.blue("→")} ${step.label}…\n`);
    this.render();
    try {
      const result = await fn();
      step.state = "done";
      step.end = Date.now();
      if (!TTY) {
        process.stdout.write(
          `${log.green("✓")} ${step.label} ${log.dim(`(${fmtDur(step.end - step.start)})`)}\n`,
        );
      }
      this.render();
      return result;
    } catch (e) {
      step.state = "failed";
      step.end = Date.now();
      step.note = e instanceof Error ? e.message : String(e);
      if (!TTY) process.stderr.write(`${log.red("✗")} ${step.label} — ${step.note}\n`);
      this.render();
      throw e;
    }
  }

  /** Mark a step as failed (✗) with a note, WITHOUT throwing — so a caller can
   *  flag a service that didn't come up and still continue to the next one. */
  fail(key: string, note?: string): void {
    const step = this.find(key);
    step.state = "failed";
    step.end = step.end ?? Date.now();
    if (note) step.note = note;
    if (!TTY) process.stderr.write(`${log.red("✗")} ${step.label}${note ? ` — ${note}` : ""}\n`);
    this.render();
  }

  /** Mark a step as skipped (e.g. no Cloudflare tunnel configured). */
  skip(key: string, note?: string): void {
    const step = this.find(key);
    step.state = "skipped";
    step.note = note;
    if (!TTY) process.stdout.write(`${log.dim("⊘")} ${step.label}${note ? ` — ${note}` : ""}\n`);
    this.render();
  }

  /** Attach a short note to a step (shown after its label). */
  note(key: string, note: string): void {
    this.find(key).note = note;
    this.render();
  }

  /** Stop animating and draw the final frame. */
  finish(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.render();
    if (TTY) process.stdout.write("\x1b[?25h"); // restore cursor
  }

  private find(key: string): Step {
    const s = this.steps.find((x) => x.key === key);
    if (!s) throw new Error(`unknown step: ${key}`);
    return s;
  }

  private render(): void {
    if (!TTY) return; // non-TTY prints inline in run()/skip()
    const total = this.steps.length;
    const done = this.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
    const failed = this.steps.some((s) => s.state === "failed");
    const elapsed = fmtDur(Date.now() - this.startedAt);

    const rail = log.dim("│");
    const head = `${log.dim("╭─")} ${gradientText(`🦍 ${this.title}`, this.frame * 0.18)}  ${log.dim(`${done}/${total} · ${elapsed}`)}`;
    const body = this.steps.map((s) => `${rail}  ${this.line(s)}`);
    const meter = failed
      ? `${log.dim("╰─")} ${log.red("█".repeat(Math.round((done / total) * 16)))}${log.dim("░".repeat(16 - Math.round((done / total) * 16)))}  ${log.red("failed")}`
      : `${log.dim("╰─")} ${gbar(done / total, this.frame, 16)}  ${log.dim(`${Math.round((done / total) * 100)}%`)}`;
    const lines = [head, ...body, meter];

    if (this.rendered > 0) process.stdout.write(`\x1b[${this.rendered}A`); // cursor up
    process.stdout.write(`${lines.map((l) => `\x1b[2K${l}`).join("\n")}\n`);
    this.rendered = lines.length;
  }

  private line(s: Step): string {
    const elapsed = s.start ? (s.end ?? Date.now()) - s.start : 0;
    const noteOf = (color: (x: string) => string) => (s.note ? `  ${color(s.note)}` : "");
    switch (s.state) {
      case "pending":
        return `${log.dim("○")} ${log.dim(s.label)}`;
      case "running": {
        const spin = spinGlyph(this.frame);
        const label = shimmer(s.label, this.frame);
        if (s.estimateMs) {
          const meter = gbar(elapsed / s.estimateMs, this.frame, 12);
          const time = log.dim(`${fmtDur(elapsed)} / ~${fmtDur(s.estimateMs)}`);
          return `${spin} ${label}  ${meter} ${time}${noteOf(log.dim)}`;
        }
        return `${spin} ${label}  ${wave(this.frame, 12)} ${log.dim(fmtDur(elapsed))}${noteOf(log.dim)}`;
      }
      case "done":
        return `${log.green("✓")} ${s.label}  ${log.dim(fmtDur(elapsed))}${noteOf(log.dim)}`;
      case "failed":
        return `${log.red("✗")} ${log.bold(s.label)}${noteOf(log.red)}`;
      case "skipped":
        return `${log.dim("⊘")} ${log.dim(s.label)}${noteOf(log.dim)}`;
    }
  }
}

/** Run a single async task behind a one-line spinner; ✓/✗ on completion. */
export async function withSpinner<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  if (!TTY) {
    process.stdout.write(`${log.blue("→")} ${label}…\n`);
    const result = await fn();
    process.stdout.write(`${log.green("✓")} ${label}\n`);
    return result;
  }
  let frame = 0;
  const started = Date.now();
  process.stdout.write("\x1b[?25l");
  const draw = () => {
    process.stdout.write(
      `\r\x1b[2K${spinGlyph(frame)} ${shimmer(label, frame)} ${log.dim(fmtDur(Date.now() - started))}`,
    );
    frame++;
  };
  draw();
  const timer = setInterval(draw, 80);
  timer.unref?.();
  try {
    const result = await fn();
    clearInterval(timer);
    process.stdout.write(
      `\r\x1b[2K${log.green("✓")} ${label}  ${log.dim(fmtDur(Date.now() - started))}\n\x1b[?25h`,
    );
    return result;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write(`\r\x1b[2K${log.red("✗")} ${label}\n\x1b[?25h`);
    throw e;
  }
}
