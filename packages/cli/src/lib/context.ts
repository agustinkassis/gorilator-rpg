import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, type InstallConfig } from "./config.js";
import { parseEnv } from "./env.js";
import type { Options } from "./options.js";
import { configPath as systemConfigPath, envFile } from "./paths.js";
import { targetUser } from "./proc.js";

const CANONICAL_REMOTE = "github.com/agustinkassis/gorilator-rpg";
const DEFAULT_PROJECT_CLIENT_PORT = 5173;

export interface RuntimeContext {
  kind: "project" | "system";
  appDir: string;
  configPath: string;
  envPath: string;
  statePath?: string;
  logPath?: string;
}

export interface ProjectDevState {
  root: string;
  pid: number;
  serverPort: number;
  clientPort: number;
  requestedServerPort: number;
  requestedClientPort: number;
  startedAt: string;
}

export function normalizeRepoUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const withoutPrefix = raw
    .replace(/^git\+/, "")
    .replace(/^ssh:\/\/git@/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^git@/i, "");
  const normalized = withoutPrefix
    .replace(/^([^/:]+):/, "$1/")
    .replace(/\.git(?:\/)?$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
  return normalized || null;
}

export function isCanonicalGorilatorRemote(value: string): boolean {
  return normalizeRepoUrl(value) === CANONICAL_REMOTE;
}

export function resolveRuntimeContext(opts: Options, cwd = process.cwd()): RuntimeContext {
  const projectRoot = findGorilatorProjectRoot(cwd);
  if (projectRoot) {
    const localDir = join(projectRoot, ".gorilator");
    return {
      kind: "project",
      appDir: projectRoot,
      configPath: join(localDir, "config.json"),
      envPath: envFile(projectRoot),
      statePath: join(localDir, "dev.json"),
      logPath: join(localDir, "dev.log"),
    };
  }

  const cfg = loadConfig();
  const appDir = cfg?.appDir ?? opts.appDir;
  return {
    kind: "system",
    appDir,
    configPath: systemConfigPath(),
    envPath: envFile(appDir),
  };
}

export interface TargetSummary {
  kind: "project" | "system";
  appDir: string;
  /** Current git branch (or short SHA) of the targeted checkout, if any. */
  ref: string | null;
  /** `owner/repo` slug of the checkout's first remote, if any. */
  remote: string | null;
  /** Whether the targeted install exists (always true for project mode; for
   *  system mode, whether an install record is on disk). */
  installed: boolean;
}

/** Summarize what a command is about to act on — the local git checkout
 *  (project mode) or the system-wide install (global mode) — for the banner the
 *  CLI prints before context-aware commands. */
export function describeTarget(ctx: RuntimeContext): TargetSummary {
  const remoteUrl = firstRemoteUrl(ctx.appDir);
  const normalized = remoteUrl ? normalizeRepoUrl(remoteUrl) : null;
  // normalized is "host/owner/repo" → drop the host for a tidy "owner/repo".
  const remote = normalized ? normalized.split("/").slice(1).join("/") || normalized : null;
  return {
    kind: ctx.kind,
    appDir: ctx.appDir,
    ref: currentGitRef(ctx.appDir),
    remote,
    installed: ctx.kind === "project" ? true : loadConfig() !== null,
  };
}

export function loadProjectConfig(ctx: RuntimeContext, opts: Options): InstallConfig {
  if (ctx.kind !== "project") {
    const cfg = loadConfig(ctx.configPath);
    if (cfg) return cfg;
  }

  const disk = loadConfig(ctx.configPath);
  const env = readProjectEnv(ctx);
  const port = Number(env.GAME_SERVER_PORT) || disk?.port || opts.port;
  const clientPort =
    Number(env.CLIENT_PORT) || disk?.clientPort || opts.clientPort || DEFAULT_PROJECT_CLIENT_PORT;

  return {
    appDir: ctx.appDir,
    port,
    clientPort,
    repo: disk?.repo ?? firstRemoteUrl(ctx.appDir) ?? "local",
    ref: disk?.ref ?? currentGitRef(ctx.appDir) ?? "local",
    user: disk?.user ?? targetUser(),
    serviceManager: "project",
    clientHost: disk?.clientHost,
    serverHost: disk?.serverHost,
  };
}

export function readProjectEnv(ctx: RuntimeContext): Record<string, string> {
  if (!existsSync(ctx.envPath)) return {};
  try {
    return parseEnv(readFileSync(ctx.envPath, "utf8"));
  } catch {
    return {};
  }
}

export function findGorilatorProjectRoot(cwd: string): string | null {
  const start = resolve(cwd);
  const gitRoot = captureGit(start, ["rev-parse", "--show-toplevel"]);
  if (gitRoot) {
    const root = resolve(gitRoot);
    if (hasCanonicalRemote(root) || hasGorilatorMarkers(root)) return root;
  }

  for (let dir = start; ; dir = dirname(dir)) {
    if (hasCanonicalRemote(dir) || hasGorilatorMarkers(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
  }
}

function hasCanonicalRemote(root: string): boolean {
  const remotes = captureGit(root, ["remote", "-v"]);
  if (!remotes) return false;
  return remotes
    .split(/\r?\n/)
    .flatMap((line) => line.split(/\s+/).slice(1, 2))
    .some((url) => isCanonicalGorilatorRemote(url));
}

function hasGorilatorMarkers(root: string): boolean {
  if (!existsSync(join(root, "pnpm-workspace.yaml"))) return false;
  if (!packageScriptIncludes(root, "dev", "scripts/dev.mjs")) return false;
  if (!packageNamed(join(root, "packages", "cli", "package.json"), "gorilator")) return false;
  if (!packageNamed(join(root, "packages", "client", "package.json"), "@rpg/client")) return false;
  if (!packageNamed(join(root, "packages", "server", "package.json"), "@rpg/server")) return false;
  return true;
}

function packageNamed(path: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
    return pkg.name === name;
  } catch {
    return false;
  }
}

function packageScriptIncludes(root: string, script: string, needle: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return typeof pkg.scripts?.[script] === "string" && pkg.scripts[script].includes(needle);
  } catch {
    return false;
  }
}

function firstRemoteUrl(root: string): string | null {
  const remotes = captureGit(root, ["remote", "-v"]);
  if (!remotes) return null;
  for (const line of remotes.split(/\r?\n/)) {
    const url = line.split(/\s+/)[1];
    if (url) return url;
  }
  return null;
}

function currentGitRef(root: string): string | null {
  return (
    captureGit(root, ["branch", "--show-current"]) ??
    captureGit(root, ["rev-parse", "--short", "HEAD"])
  );
}

function captureGit(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out || null;
}
