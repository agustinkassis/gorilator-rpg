// Tiny terminal progress UI: an animated multi-step checklist (spinner, elapsed
// vs estimate, status icons) plus a one-off spinner. Used by `gorilator update`
// to show a tidy, live-updating progress view. Degrades to plain sequential
// lines when stdout isn't a TTY (CI, piped logs).
import * as log from "./log.js";

const TTY = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

function bar(frac: number, width = 12): string {
  const f = Math.max(0, Math.min(0.99, frac));
  const filled = Math.round(f * width);
  return log.dim("[") + log.blue("█".repeat(filled)) + log.dim("░".repeat(width - filled) + "]");
}

/** A live, animated multi-step progress checklist. */
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
        process.stdout.write(`${log.green("✓")} ${step.label} ${log.dim(`(${fmtDur(step.end - step.start)})`)}\n`);
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
    const done = this.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
    const lines = [
      `${log.bold(this.title)}  ${log.dim(`${done}/${this.steps.length} · ${fmtDur(Date.now() - this.startedAt)}`)}`,
      ...this.steps.map((s) => `  ${this.line(s)}`),
    ];
    if (this.rendered > 0) process.stdout.write(`\x1b[${this.rendered}A`); // cursor up
    process.stdout.write(lines.map((l) => `\x1b[2K${l}`).join("\n") + "\n");
    this.rendered = lines.length;
  }

  private line(s: Step): string {
    const elapsed = s.start ? (s.end ?? Date.now()) - s.start : 0;
    switch (s.state) {
      case "pending":
        return `${log.dim("○")} ${log.dim(s.label)}`;
      case "running": {
        const spin = log.blue(FRAMES[this.frame % FRAMES.length]);
        const meter = s.estimateMs ? ` ${bar(elapsed / s.estimateMs)}` : "";
        const time = s.estimateMs
          ? ` ${log.dim(`${fmtDur(elapsed)} / ~${fmtDur(s.estimateMs)}`)}`
          : ` ${log.dim(fmtDur(elapsed))}`;
        return `${spin} ${s.label}${meter}${time}`;
      }
      case "done":
        return `${log.green("✓")} ${s.label}  ${log.dim(fmtDur(elapsed))}`;
      case "failed":
        return `${log.red("✗")} ${s.label}${s.note ? `  ${log.red(s.note)}` : ""}`;
      case "skipped":
        return `${log.dim("⊘")} ${log.dim(s.label)}${s.note ? `  ${log.dim(s.note)}` : ""}`;
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
  const draw = () => process.stdout.write(`\r\x1b[2K${log.blue(FRAMES[frame++ % FRAMES.length])} ${label} ${log.dim(fmtDur(Date.now() - started))}`);
  draw();
  const timer = setInterval(draw, 80);
  timer.unref?.();
  try {
    const result = await fn();
    clearInterval(timer);
    process.stdout.write(`\r\x1b[2K${log.green("✓")} ${label}  ${log.dim(fmtDur(Date.now() - started))}\n\x1b[?25h`);
    return result;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write(`\r\x1b[2K${log.red("✗")} ${label}\n\x1b[?25h`);
    throw e;
  }
}
