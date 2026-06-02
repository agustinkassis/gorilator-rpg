// Prerequisite checks + the native (no-Docker) build pipeline. Mirrors the
// recipe in Dockerfile.server: pnpm install → build @rpg/shared → build the
// client (same-origin for public one-host deploys, or against a local server
// port for the optional direct client port). The
// server then runs from TS via tsx (see commands/serve.ts) — `node dist/index.js`
// is intentionally NOT used because tsc emits extensionless ESM imports Node's
// loader rejects.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as log from "./log.js";
import { cliEntryPath, isLinux } from "./paths.js";
import { capture, isRoot, runAsTargetUser, runPrivileged, tryRun, which } from "./proc.js";

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
  if (which("pnpm")) {
    log.ok("pnpm present");
    return;
  }
  log.info("Installing pnpm@10.14.0 (via npm -g)…");
  if (tryRun("npm", ["install", "-g", "pnpm@10.14.0"])) {
    log.ok("pnpm installed");
    return;
  }
  // A root-owned global prefix needs sudo.
  if (!isRoot() && tryRun("sudo", ["npm", "install", "-g", "pnpm@10.14.0"])) {
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
    runAsTargetUser("git", ["-C", appDir, "checkout", "-f", "FETCH_HEAD"]);
  } else {
    log.info(`Cloning ${repo} (${ref}) → ${appDir}…`);
    runAsTargetUser("git", ["clone", "--depth", "1", "--branch", ref, repo, appDir]);
  }
}

/** pnpm install. node_modules is kept whole (no prune — pnpm 10's prune is
 *  interactive and hangs non-TTY; robustness over size). A failed
 *  msgpackr-extract native build is non-fatal (pure-JS fallback). */
export function pnpmInstall(appDir: string): void {
  log.info("Installing dependencies (pnpm install)…");
  runAsTargetUser("pnpm", ["install"], { cwd: appDir });
}

export function buildShared(appDir: string): void {
  log.info("Building @rpg/shared…");
  runAsTargetUser("pnpm", ["--filter", "@rpg/shared", "build"], { cwd: appDir });
}

/** Build the client. With a `serverUrl` it bakes VITE_SERVER_URL for legacy
 *  split-subdomain deploys. With a `serverPort`, the local direct client port
 *  dials ws://<host>:<serverPort>. With neither, it builds same-origin so the
 *  public one-host deploy dials whichever host served the page. */
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
  log.info(`Building the client ${how}…`);
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
