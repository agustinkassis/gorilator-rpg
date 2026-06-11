// Process & privilege helpers — synchronous, dependency-free wrappers around
// child_process plus sudo elevation and TTY prompts (ports the bash CLI's
// as_root / runAsTargetUser / _read / confirm).
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import {
  closeSync,
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export const isRoot = (): boolean =>
  typeof process.getuid === "function" && process.getuid() === 0;

/** The unix user the daemon should run as: the sudo invoker if we're root,
 *  otherwise the current user. */
export function targetUser(): string {
  if (isRoot() && process.env.SUDO_USER) return process.env.SUDO_USER;
  return userInfo().username;
}

/** Locate an executable on PATH. Returns its absolute path or null. */
export function which(cmd: string): string | null {
  return resolveExecutable(cmd);
}

export function resolveExecutable(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platformName = platform(),
): string | null {
  for (const dir of pathDirs(env, platformName)) {
    if (!dir) continue;
    for (const candidate of executableCandidates(cmd, platformName, env)) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** Run a command inheriting stdio; throw on non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOpts = {}): void {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: "inherit",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`Command failed (exit ${r.status ?? "?"}): ${cmd} ${args.join(" ")}`);
  }
}

/** Like run() but returns success instead of throwing. */
export function tryRun(cmd: string, args: string[], opts: RunOpts = {}): boolean {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: "inherit",
  });
  return !r.error && r.status === 0;
}

/** Run a command and capture trimmed stdout; null on failure. */
export function capture(cmd: string, args: string[], opts: RunOpts = {}): string | null {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}

/** Run a command AS the target user, capturing combined stdout+stderr instead of
 *  inheriting the terminal — for progress UIs that show their own spinner and
 *  only surface the subprocess output on failure. */
export function captureStep(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): { ok: boolean; output: string } {
  const user = targetUser();
  let realCmd = cmd;
  let realArgs = args;
  let env = opts.env ? { ...process.env, ...opts.env } : process.env;
  if (isRoot() && user !== "root") {
    const pairs = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v ?? ""}`);
    realCmd = "sudo";
    realArgs = ["-u", user, "--", "env", ...pairs, cmd, ...args];
    env = process.env; // env is forwarded via the `env` prefix above
  }
  const r = spawnSync(realCmd, realArgs, {
    cwd: opts.cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd();
  if (r.error) return { ok: false, output: `${output}\n${r.error.message}`.trim() };
  return { ok: r.status === 0, output };
}

export function printCommandOutput(
  cmd: string,
  args: string[],
  opts: RunOpts & { filter?: string } = {},
): void {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
  const filter = opts.filter?.toLowerCase();
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    if (!line) continue;
    if (!filter || line.toLowerCase().includes(filter)) process.stdout.write(`${line}\n`);
  }
  if (r.stderr) process.stderr.write(r.stderr);
}

export function streamCommandOutput(
  cmd: string,
  args: string[],
  opts: RunOpts & { filter?: string } = {},
): void {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ["inherit", "pipe", "inherit"],
  });
  const filter = opts.filter?.toLowerCase();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!filter || line.toLowerCase().includes(filter)) process.stdout.write(`${line}\n`);
  });
  child.on("close", () => rl.close());
}

/** Run a privileged command — directly when root, else via sudo. */
export function runPrivileged(cmd: string, args: string[], opts: RunOpts = {}): void {
  if (isRoot()) {
    run(cmd, args, opts);
    return;
  }
  run("sudo", [cmd, ...args], opts);
}

/** Like runPrivileged() but returns success instead of throwing (for cleanup
 *  steps that may be no-ops, e.g. stopping an already-stopped service). */
export function tryPrivileged(cmd: string, args: string[], opts: RunOpts = {}): boolean {
  if (isRoot()) return tryRun(cmd, args, opts);
  return tryRun("sudo", [cmd, ...args], opts);
}

/** Run a command AS the target user. When we're root and the target differs,
 *  drop privileges with `sudo -u`; env vars are forwarded via `env`. */
export function runAsTargetUser(cmd: string, args: string[], opts: RunOpts = {}): void {
  const user = targetUser();
  if (isRoot() && user !== "root") {
    const pairs = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v ?? ""}`);
    run("sudo", ["-u", user, "--", "env", ...pairs, cmd, ...args], { cwd: opts.cwd });
    return;
  }
  run(cmd, args, opts);
}

/** Write a file, falling back to `sudo tee` when the path isn't writable
 *  (e.g. /etc/systemd/system, /etc/gorilator). */
export function writeFileMaybeSudo(filePath: string, content: string, mode = 0o644): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, { mode });
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EACCES" && code !== "EPERM") throw e;
  }
  // Non-root + unwritable destination → elevate.
  runPrivileged("mkdir", ["-p", dirname(filePath)]);
  const r = spawnSync("sudo", ["tee", filePath], {
    input: content,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (r.status !== 0) throw new Error(`Failed to write ${filePath} (sudo tee).`);
  runPrivileged("chmod", ["0" + mode.toString(8), filePath]);
}

/** Synchronous single-line prompt. Reads from /dev/tty when available so it
 *  works even under `npx … | bash`-style piping; falls back to stdin. */
export function ask(promptText: string): string {
  process.stdout.write(promptText);
  let fd = 0;
  let opened = false;
  try {
    if (existsSync("/dev/tty")) {
      fd = openSync("/dev/tty", "rs");
      opened = true;
    }
  } catch {
    fd = 0;
  }
  let input = "";
  const buf = Buffer.alloc(1);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString("utf8");
      if (ch === "\n") break;
      if (ch === "\r") continue;
      input += ch;
    }
  } catch {
    /* EOF / no tty */
  } finally {
    if (opened) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return input.trim();
}

const ASSUME_YES = process.env.GORILATOR_YES === "1";

export function confirm(question: string, assumeYes = ASSUME_YES): boolean {
  if (assumeYes) return true;
  return /^y/i.test(ask(`${question} [y/N] `));
}

export function promptDefault(question: string, def: string): string {
  if (ASSUME_YES) return def;
  const a = ask(`${question} [${def}] `);
  return a || def;
}

/** True when we can actually prompt the user (a TTY is reachable and we're not
 *  in assume-yes mode). Lets callers offer interactive steps only when sensible. */
export function canPrompt(): boolean {
  if (ASSUME_YES) return false;
  return process.stdin.isTTY === true || existsSync("/dev/tty");
}

/** Resolve npm's global executable directory. npm's `prefix` is more stable
 *  than `bin -g`; `root -g` covers older/custom layouts. */
export function npmGlobalBinDir(): string | null {
  const prefix = capture("npm", ["config", "get", "prefix", "--global"]);
  if (prefix && prefix !== "undefined" && prefix !== "null") {
    return platform() === "win32" ? prefix : join(prefix, "bin");
  }
  const root = capture("npm", ["root", "-g"]);
  if (root) return dirname(dirname(root));
  return null;
}

/** Prepend a directory to PATH for commands spawned later in this installer. */
export function prependPathDir(dir: string): void {
  if (!dir || !existsSync(dir)) return;
  const key = pathEnvKey(process.env, platform());
  const parts = pathDirs(process.env, platform()).filter((part) => part && !samePathDir(part, dir, platform()));
  process.env[key] = [dir, ...parts].join(delimiter);
}

function pathHasDir(dir: string): boolean {
  return pathDirs(process.env, platform()).some((part) => samePathDir(part, dir, platform()));
}

function targetHome(): string {
  if (isRoot() && process.env.SUDO_USER && process.env.SUDO_USER !== "root") {
    const user = process.env.SUDO_USER;
    const passwd = capture("getent", ["passwd", user]);
    const parsed = passwd?.split(":")[5];
    if (parsed) return parsed;
    return platform() === "darwin" ? `/Users/${user}` : `/home/${user}`;
  }
  return homedir();
}

function shellRcFiles(): string[] {
  const home = targetHome();
  return [join(home, ".bashrc"), join(home, ".zshrc")];
}

function restoreTargetOwner(filePath: string): void {
  if (!isRoot() || !process.env.SUDO_UID || !process.env.SUDO_GID) return;
  tryRun("chown", [`${process.env.SUDO_UID}:${process.env.SUDO_GID}`, filePath]);
}

/** Persist PATH for future interactive shells, following OpenClaw's strategy:
 *  write once, near the top, and avoid duplicating an existing line. */
export function persistPathPrepend(dir: string): boolean {
  if (!dir) return false;
  const line = `export PATH="${dir}:$PATH"`;
  let wrote = false;
  for (const rc of shellRcFiles()) {
    if (!existsSync(rc)) continue;
    const current = readFileSync(rc, "utf8");
    if (!current.split(/\r?\n/).includes(line)) {
      const tmp = `${rc}.gorilator-tmp`;
      writeFileSync(tmp, `${line}\n${current.replace(new RegExp(`^${escapeRegExp(line)}\\r?\\n?`, "m"), "")}`);
      restoreTargetOwner(tmp);
      renameSync(tmp, rc);
      restoreTargetOwner(rc);
    }
    wrote = true;
  }
  if (!wrote) {
    const rc = join(targetHome(), ".bashrc");
    writeFileSync(rc, `${line}\n`, { flag: "a" });
    restoreTargetOwner(rc);
    wrote = true;
  }
  return wrote;
}

export function activateNpmGlobalBin(): string | null {
  const bin = npmGlobalBinDir();
  if (!bin) return null;
  const needsPersist = !pathHasDir(bin);
  prependPathDir(bin);
  if (needsPersist) persistPathPrepend(bin);
  return bin;
}

export function activateSudoNpmGlobalBin(): string | null {
  if (isRoot()) return null;
  const prefix = capture("sudo", ["npm", "config", "get", "prefix", "--global"]);
  if (!prefix || prefix === "undefined" || prefix === "null") return null;
  const bin = join(prefix, "bin");
  const needsPersist = !pathHasDir(bin);
  prependPathDir(bin);
  if (needsPersist) persistPathPrepend(bin);
  return bin;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pathDirs(env: NodeJS.ProcessEnv = process.env, platformName = platform()): string[] {
  return pathEnvValue(env, platformName).split(platformName === "win32" ? ";" : delimiter).filter(Boolean);
}

function pathEnvKey(env: NodeJS.ProcessEnv, platformName: string): string {
  if (platformName === "win32" && env.Path !== undefined) return "Path";
  return "PATH";
}

function pathEnvValue(env: NodeJS.ProcessEnv, platformName: string): string {
  if (platformName === "win32") return env.Path ?? env.PATH ?? "";
  return env.PATH ?? "";
}

function executableCandidates(cmd: string, platformName: string, env: NodeJS.ProcessEnv): string[] {
  if (platformName !== "win32" || extname(cmd)) return [cmd];
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return [cmd, ...exts.map((ext) => `${cmd}${ext.startsWith(".") ? ext : `.${ext}`}`)];
}

function samePathDir(a: string, b: string, platformName: string): boolean {
  return platformName === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
