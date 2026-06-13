// Prerequisite checks + the native (no-Docker) build pipeline. Mirrors the
// recipe in Dockerfile.server: pnpm install → build @rpg/shared → build the
// client (same-origin for public one-host deploys, or against a local server
// port for the optional direct client port). The
// server then runs from TS via tsx (see commands/serve.ts) — `node dist/index.js`
// is intentionally NOT used because tsc emits extensionless ESM imports Node's
// loader rejects.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { downloadReleaseDist } from "./dist.js";
import { parseEnv } from "./env.js";
import * as log from "./log.js";
import { cliEntryPath, envFile, isLinux } from "./paths.js";
import {
  activateNpmGlobalBin,
  capture,
  isRoot,
  runAsTargetUser,
  runPrivileged,
  tryRun,
  which,
} from "./proc.js";

/** The daemon runs the server with `node --import tsx`, which needs Node ≥20.6
 *  (module.register / the --import flag). */
export function ensureNode(): void {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  if (maj < 20 || (maj === 20 && min < 6)) {
    log.die(`Node ≥ 20.6 is required to run the daemon (found ${process.versions.node}).`);
  }
  log.ok(`Node ${process.versions.node}`);
}

export function ensureGit(): void {
  if (which("git")) {
    log.ok("git present");
    return;
  }
  if (isLinux && which("apt-get")) {
    log.info("Installing git…");
    runPrivileged("apt-get", ["update", "-y"]);
    runPrivileged("apt-get", ["install", "-y", "ca-certificates", "git"]);
    return;
  }
  log.die("git is required but not installed. Install git and re-run.");
}

/** Ensure pnpm is available (the workspace pins pnpm@10.14.0). Installs via
 *  `npm i -g` — NOT corepack, whose stale signing keys fail on fresh boxes. */
export function ensurePnpm(): void {
  activateNpmGlobalBin();
  if (which("pnpm")) {
    log.ok("pnpm present");
    return;
  }
  log.info("Installing pnpm@10.14.0 (via npm -g)…");
  if (tryRun("npm", ["install", "-g", "pnpm@10.14.0"])) {
    activateNpmGlobalBin();
    log.ok("pnpm installed");
    return;
  }
  // A root-owned global prefix needs sudo.
  if (!isRoot() && tryRun("sudo", ["npm", "install", "-g", "pnpm@10.14.0"])) {
    activateNpmGlobalBin();
    log.ok("pnpm installed");
    return;
  }
  log.die("Could not install pnpm. Install it manually (npm i -g pnpm) and re-run.");
}

/** Create the install dir, elevating to create system paths (e.g. /opt) and
 *  chowning them to the target user so all later steps run unprivileged. */
export function ensureAppDir(appDir: string, user: string): void {
  if (existsSync(appDir)) return;
  try {
    mkdirSync(appDir, { recursive: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EACCES" && code !== "EPERM") throw e;
    runPrivileged("mkdir", ["-p", appDir]);
    runPrivileged("chown", ["-R", user, appDir]);
  }
}

/** Clone the game, or fast-forward an existing checkout, to the given ref
 *  (branch or tag). Runs git as the target user so the tree stays user-owned. */
export function cloneOrUpdate(repo: string, ref: string, appDir: string): void {
  if (existsSync(join(appDir, ".git"))) {
    log.info(`Updating ${appDir} → ${ref}…`);
    runAsTargetUser("git", ["-C", appDir, "fetch", "--depth", "1", "origin", ref]);
    checkoutFetchedRef(appDir, ref);
  } else {
    log.info(`Cloning ${repo} (${ref}) → ${appDir}…`);
    runAsTargetUser("git", ["clone", "--depth", "1", "--branch", ref, repo, appDir]);
  }
}

function checkoutFetchedRef(appDir: string, ref: string): void {
  if (fetchedRefIsBranch(appDir, ref)) {
    runAsTargetUser("git", ["-C", appDir, "checkout", "-B", ref, "FETCH_HEAD"]);
  } else {
    runAsTargetUser("git", ["-C", appDir, "-c", "advice.detachedHead=false", "checkout", "-f", "FETCH_HEAD"]);
  }
}

function fetchedRefIsBranch(appDir: string, ref: string): boolean {
  try {
    return readFileSync(join(appDir, ".git", "FETCH_HEAD"), "utf8").includes(`\tbranch '${ref}' of `);
  } catch {
    return false;
  }
}

/** pnpm install. node_modules is kept whole (no prune — pnpm 10's prune is
 *  interactive and hangs non-TTY; robustness over size). A failed
 *  msgpackr-extract native build is non-fatal (pure-JS fallback).
 *
 *  `filter` scopes the install to a subset of the workspace (e.g.
 *  `@rpg/server...` = the server + its deps, including @rpg/shared and tsx).
 *  Used on the prebuilt fast path to skip the client's heavy build-only deps
 *  (Babylon, Vite) the running daemon never imports. */
export function pnpmInstall(appDir: string, opts: { filter?: string } = {}): void {
  const args = ["install"];
  if (opts.filter) args.push("--filter", opts.filter);
  log.info(opts.filter ? `Installing dependencies (${opts.filter})…` : "Installing dependencies (pnpm install)…");
  runAsTargetUser("pnpm", args, { cwd: appDir });
}

/** The server subtree filter: @rpg/server plus everything it depends on
 *  (@rpg/shared, tsx/esbuild). The daemon runs the server from source via tsx
 *  and serves a prebuilt static client, so this is all it needs at runtime. */
const SERVER_FILTER = "@rpg/server...";

export function buildShared(appDir: string): void {
  log.info("Building @rpg/shared…");
  runAsTargetUser("pnpm", ["--filter", "@rpg/shared", "build"], { cwd: appDir });
}

/** `{VITE_DEV_TOOLS:"1"}` when this install runs in dev mode (GORILATOR_DEV=1 in
 *  its .env) — so the client build compiles in the in-game Dev Mode editor (which
 *  is otherwise tree-shaken out of a production build). Empty otherwise. Mirrors
 *  serve.ts's GORILATOR_DEV gate; the editor is admin-gated at runtime. */
export function devToolsEnv(appDir: string): Record<string, string> {
  try {
    const env = parseEnv(readFileSync(envFile(appDir), "utf8"));
    return env.GORILATOR_DEV === "1" ? { VITE_DEV_TOOLS: "1" } : {};
  } catch {
    return {};
  }
}

/** Build the client. With a `serverUrl` it bakes VITE_SERVER_URL for legacy
 *  split-subdomain deploys. With a `serverPort`, the local direct client port
 *  dials ws://<host>:<serverPort>. With neither, it builds same-origin so the
 *  public one-host deploy dials whichever host served the page. A dev-mode install
 *  additionally bakes VITE_DEV_TOOLS so the in-game editor is present. */
export function buildClient(
  appDir: string,
  opts: { serverUrl?: string; serverPort?: number } = {},
): void {
  let env: Record<string, string>;
  let how: string;
  if (opts.serverUrl) {
    // Legacy explicit build: dial this exact wss URL.
    env = { VITE_SERVER_URL: opts.serverUrl };
    how = `→ ${opts.serverUrl}`;
  } else if (opts.serverPort) {
    // Direct native client port: dial ws://<the page's own host>:<serverPort>.
    env = { VITE_SERVER_PORT: String(opts.serverPort) };
    how = `→ ws://<host>:${opts.serverPort}`;
  } else {
    env = { VITE_SAME_ORIGIN: "1" };
    how = "(same-origin)";
  }
  env = { ...env, ...devToolsEnv(appDir) };
  log.info(`Building the client ${how}${env.VITE_DEV_TOOLS ? " + dev editor" : ""}…`);
  runAsTargetUser("pnpm", ["--filter", "@rpg/client", "build"], { cwd: appDir, env });
}

/** Build the in-repo CLI so the daemon can run a self-contained entry that
 *  always matches the checkout (no reliance on a global npm install). Best
 *  effort — `resolveServiceExec` falls back to the global CLI if this is
 *  absent (e.g. an older checkout without packages/cli). */
export function buildCli(appDir: string): void {
  if (!existsSync(join(appDir, "packages", "cli", "package.json"))) return;
  try {
    log.info("Building the gorilator CLI…");
    runAsTargetUser("pnpm", ["--filter", "gorilator", "build"], { cwd: appDir });
    log.ok("CLI build complete.");
  } catch (e) {
    log.warn(
      `Could not build the in-repo CLI (${(e as Error).message}). The daemon will use the global gorilator.`,
    );
  }
}

/** Full native build: deps + shared + client + cli. `serverUrl` controls how the
 *  client is built (see buildClient). */
export function installAndBuild(
  appDir: string,
  opts: { serverUrl?: string; serverPort?: number } = {},
): void {
  pnpmInstall(appDir);
  buildShared(appDir);
  buildClient(appDir, opts);
  buildCli(appDir);
  log.ok("Build complete.");
}

/** Either fetch a prebuilt release dist (skipping the build) or build from
 *  source, installing only what each path needs. `prebuilt` is set only for
 *  same-origin release-tag installs; on any download miss it transparently
 *  falls back to a full install + source build. Used by `install` (the update
 *  command drives the change-aware `buildPlan` instead, for its progress UI).
 *
 *  Fast path: download the prebuilt dist first (curl/tar only — no node_modules
 *  needed), then a server-scoped `pnpm install` (@rpg/server...) — skipping the
 *  client's build-only deps (Babylon, Vite) the daemon never imports.
 *  Fallback: full `pnpm install` + build shared/client/cli from source. */
export function buildOrFetch(
  appDir: string,
  opts: { serverUrl?: string; serverPort?: number } = {},
  prebuilt?: { slug: string; tag: string } | null,
): void {
  if (prebuilt && downloadReleaseDist(prebuilt.slug, prebuilt.tag, appDir)) {
    pnpmInstall(appDir, { filter: SERVER_FILTER });
    log.ok(`Fetched prebuilt build for ${prebuilt.tag} — skipped the local build.`);
    return;
  }
  if (prebuilt) log.info("No prebuilt build for this release — building from source.");
  pnpmInstall(appDir);
  buildShared(appDir);
  buildClient(appDir, opts);
  buildCli(appDir);
  log.ok("Build complete.");
}

/** Which work an update needs, derived from the per-package version changes.
 *  shared is foundational: the server imports its built output, the client
 *  bundles it, and the CLI imports it — so a shared bump fans out to all three. */
export interface UpdateActions {
  buildShared: boolean;
  buildClient: boolean;
  buildCli: boolean;
  /** Restart the daemon — only when the server runtime changed (server/shared). */
  restartServer: boolean;
  /** (Re)install dependencies before building/restarting. */
  install: boolean;
  /** Any actionable change at all (false ⇒ nothing to do). */
  any: boolean;
}

/** Map the set of changed package labels (app/cli/client/server/shared)
 *  to the work an update must do. `app` is the umbrella version and does not
 *  affect the running game daemon, so it is ignored here. */
export function planUpdateActions(changedLabels: Iterable<string>): UpdateActions {
  const changed = new Set(changedLabels);
  const shared = changed.has("shared");
  const buildShared = shared;
  const buildClient = changed.has("client") || shared;
  const buildCli = changed.has("cli") || shared;
  const restartServer = changed.has("server") || shared;
  const any = buildShared || buildClient || buildCli || restartServer;
  return { buildShared, buildClient, buildCli, restartServer, install: any, any };
}

const ALL_ACTIONS: UpdateActions = {
  buildShared: true,
  buildClient: true,
  buildCli: true,
  restartServer: true,
  install: true,
  any: true,
};

export interface BuildCmd {
  key: string;
  label: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  estimateMs: number;
  /** Non-fatal if it fails (e.g. the in-repo CLI build). */
  optional?: boolean;
  /** A JS step (e.g. download the prebuilt dist) instead of a shell command;
   *  returns success. When present, cmd/args are ignored. */
  run?: () => boolean;
}

/** The ordered build commands as data, so a progress UI (see commands/update.ts)
 *  can run them quietly with its own spinner. Only the packages flagged in
 *  `opts.actions` are included (default: all). With `opts.prebuilt`, a single
 *  atomic "download prebuilt dist" step replaces the shared/client/cli builds
 *  and the install is scoped to the server subtree. Mirrors
 *  pnpmInstall/buildShared/buildClient/buildCli above — keep them in sync. */
export function buildPlan(
  appDir: string,
  opts: {
    serverUrl?: string;
    serverPort?: number;
    prebuilt?: { slug: string; tag: string } | null;
    actions?: UpdateActions;
  } = {},
): BuildCmd[] {
  const a = opts.actions ?? ALL_ACTIONS;
  const hasCli = existsSync(join(appDir, "packages", "cli", "package.json"));
  const steps: BuildCmd[] = [];

  // Prebuilt fast path: one download lands shared+client+cli dist atomically.
  if (opts.prebuilt) {
    const { slug, tag } = opts.prebuilt;
    if (a.buildShared || a.buildClient || a.buildCli) {
      steps.push({
        key: "fetch",
        label: `Download prebuilt build (${tag})`,
        cmd: "",
        args: [],
        cwd: appDir,
        estimateMs: 8_000,
        run: () => downloadReleaseDist(slug, tag, appDir),
      });
    }
    // Only the server subtree's deps matter at runtime, and only when it changed.
    if (a.install && a.restartServer) {
      steps.push({
        key: "install",
        label: "Install dependencies (server)",
        cmd: "pnpm",
        args: ["install", "--filter", SERVER_FILTER],
        cwd: appDir,
        estimateMs: 20_000,
      });
    }
    return steps;
  }

  // Source build path — only the packages that changed.
  const clientEnv: Record<string, string> = {
    ...(opts.serverUrl
      ? { VITE_SERVER_URL: opts.serverUrl }
      : opts.serverPort
        ? { VITE_SERVER_PORT: String(opts.serverPort) }
        : { VITE_SAME_ORIGIN: "1" }),
    ...devToolsEnv(appDir), // bake the in-game editor when this install is in dev mode
  };
  if (a.install) {
    steps.push({ key: "install", label: "Install dependencies", cmd: "pnpm", args: ["install"], cwd: appDir, estimateMs: 30_000 });
  }
  if (a.buildShared) {
    steps.push({ key: "shared", label: "Build @rpg/shared", cmd: "pnpm", args: ["--filter", "@rpg/shared", "build"], cwd: appDir, estimateMs: 8_000 });
  }
  if (a.buildClient) {
    steps.push({ key: "client", label: "Build client", cmd: "pnpm", args: ["--filter", "@rpg/client", "build"], env: clientEnv, cwd: appDir, estimateMs: 45_000 });
  }
  if (a.buildCli && hasCli) {
    steps.push({ key: "cli", label: "Build gorilator CLI", cmd: "pnpm", args: ["--filter", "gorilator", "build"], cwd: appDir, estimateMs: 6_000, optional: true });
  }
  return steps;
}

/** Absolute path to the node binary + the CLI entry used to build service
 *  ExecStart lines that don't depend on the service's PATH. Prefer the
 *  self-contained in-repo build; fall back to the globally-installed package,
 *  then to this very process's entry. */
export function resolveServiceExec(appDir: string): { node: string; cliEntry: string } {
  const node = process.execPath;
  const local = cliEntryPath(appDir);
  if (existsSync(local)) return { node, cliEntry: local };
  const npmRoot = capture("npm", ["root", "-g"]);
  const cliEntry = npmRoot
    ? join(npmRoot, "gorilator", "dist", "index.js")
    : process.argv[1] ?? "";
  return { node, cliEntry };
}
