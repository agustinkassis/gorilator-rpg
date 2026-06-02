// Pretty logging — colorized on a TTY, plain otherwise. Ports the bash CLI's
// info/ok/warn/err helpers. Diagnostics go to stderr; ok/info to stdout.
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const blue = paint("34");

export function banner(version: string): void {
  process.stdout.write(`${bold("🦍 Gorilator")} — native install & daemon (v${version})\n`);
}

export function info(msg: string): void {
  process.stdout.write(`${blue("==>")} ${msg}\n`);
}

export function ok(msg: string): void {
  process.stdout.write(`${green("✓")} ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${yellow("!")} ${msg}\n`);
}

export function err(msg: string): void {
  process.stderr.write(`${red("✗")} ${msg}\n`);
}

export function die(msg: string): never {
  err(msg);
  process.exit(1);
}
