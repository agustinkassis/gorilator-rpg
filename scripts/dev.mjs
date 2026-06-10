import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CLIENT_PORT = 5173;
const DEFAULT_SERVER_PORT = 2567;
const cliArgs = process.argv.slice(2);
// --skip-shared: don't spawn the shared tsc watcher (another process already
// watches it, e.g. a second `pnpm dev` in a sibling worktree sharing the tree).
const skipShared = cliArgs.includes("--skip-shared");
const isTty = Boolean(process.stdout.isTTY);
const colors = {
  reset: isTty ? "\x1b[0m" : "",
  gray: isTty ? "\x1b[90m" : "",
  blue: isTty ? "\x1b[34m" : "",
  green: isTty ? "\x1b[32m" : "",
  red: isTty ? "\x1b[31m" : "",
};

function pnpmCommand() {
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm/i.test(execPath)) {
    return { command: process.execPath, prefixArgs: [execPath] };
  }
  return { command: "pnpm", prefixArgs: [] };
}

const pnpm = pnpmCommand();

function runPnpm(args, options = {}) {
  return spawnSync(pnpm.command, [...pnpm.prefixArgs, ...args], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
}

function hasDevDependencies() {
  return [
    "node_modules/.modules.yaml",
    "packages/shared/node_modules/.bin/tsc",
    "packages/server/node_modules/.bin/tsx",
    "packages/client/node_modules/.bin/vite",
  ].every((path) => existsSync(join(root, path)));
}

function requestedPort(envName, fallback) {
  const port = Number(process.env[envName]);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function findFreePort(preferred) {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`Could not find a free port between ${preferred} and ${preferred + 99}`);
}

if (!hasDevDependencies()) {
  console.log("[dev] missing local dependencies; running pnpm install --frozen-lockfile");
  const install = runPnpm(["install", "--frozen-lockfile"]);
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const requestedClientPort = requestedPort("CLIENT_PORT", DEFAULT_CLIENT_PORT);
const requestedServerPort = requestedPort("GAME_SERVER_PORT", DEFAULT_SERVER_PORT);
const clientPort = await findFreePort(requestedClientPort);
const serverPort = await findFreePort(requestedServerPort);
const devEnv = {
  ...process.env,
  // Explicitly a dev server: the server opens the dev_* (Dev Mode editor)
  // messages to every client only when NODE_ENV says so (systems/devAuth.ts).
  NODE_ENV: process.env.NODE_ENV ?? "development",
  CLIENT_PORT: String(clientPort),
  GAME_SERVER_PORT: String(serverPort),
  VITE_SERVER_PORT: String(serverPort),
};

writeGorilatorState({
  root,
  pid: process.pid,
  serverPort,
  clientPort,
  requestedServerPort,
  requestedClientPort,
  startedAt: new Date().toISOString(),
});

// Cold start only: build shared once when its dist/ has never been produced.
// On every other start the previous run's dist/ (or the Turbo cache) is already
// resolvable, so the server (tsx) and client (Vite) boot instantly while the
// watcher refreshes dist/ in the background.
const sharedDist = join(root, "packages/shared/dist/index.js");
if (!existsSync(sharedDist)) {
  console.log("[dev] shared dist missing; building @rpg/shared once (cold start)");
  const build = runPnpm(["--filter", "@rpg/shared", "build"], { env: devEnv });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

console.log("[dev] starting shared watcher, game server, and Vite client (in parallel)");
if (clientPort !== requestedClientPort) {
  console.log(`[dev] client port ${requestedClientPort} is busy; using ${clientPort}`);
}
if (serverPort !== requestedServerPort) {
  console.log(`[dev] server port ${requestedServerPort} is busy; using ${serverPort}`);
}
console.log(`[dev] client:  http://localhost:${clientPort}/`);
console.log(`[dev] server:  http://localhost:${serverPort}/`);
console.log(`[dev] monitor: http://localhost:${serverPort}/colyseus/`);

const children = [];
let shuttingDown = false;

function prefixStream(stream, name, color, output, onLine) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      onLine?.(line);
      output.write(`${color}[${name}]${colors.reset} ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (pending) {
      onLine?.(pending);
      output.write(`${color}[${name}]${colors.reset} ${pending}\n`);
    }
  });
}

function start(name, color, args, options = {}) {
  const child = spawn(pnpm.command, [...pnpm.prefixArgs, ...args], {
    cwd: root,
    env: devEnv,
    stdio: ["inherit", "pipe", "pipe"],
  });
  children.push(child);
  prefixStream(child.stdout, name, color, process.stdout, options.onLine);
  prefixStream(child.stderr, name, colors.red, process.stderr, options.onLine);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code === 0 || signal === "SIGINT") return;
    shuttingDown = true;
    console.error(`[dev] ${name} exited unexpectedly${code == null ? "" : ` with code ${code}`}`);
    stopChildren();
    process.exit(code ?? 1);
  });
  return child;
}

function stopChildren() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGINT");
  }
}

process.on("SIGINT", () => {
  shuttingDown = true;
  stopChildren();
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  stopChildren();
});

// All three spawn immediately — no readiness gate. The server and client resolve
// @rpg/shared from the dist/ that already exists; the watcher only refreshes it.
// A shared type error is logged red but never blocks the running stack (same as
// a server or client compile error would behave).
if (!skipShared) {
  let sharedReady = false;
  start("shared", colors.gray, ["--filter", "@rpg/shared", "dev"], {
    onLine(line) {
      if (/Found 0 errors\. Watching for file changes\./.test(line)) {
        if (!sharedReady) {
          sharedReady = true;
          console.log(`${colors.green}[dev] shared watcher ready${colors.reset}`);
        }
      } else {
        const foundErrors = line.match(/Found (\d+) errors?\./);
        if (foundErrors && Number(foundErrors[1]) > 0) {
          console.error(
            `${colors.red}[dev] shared has ${foundErrors[1]} type error(s) — server/client keep running on the last good build${colors.reset}`,
          );
        }
      }
    },
  });
} else {
  console.log("[dev] --skip-shared: not spawning the shared watcher");
}
start("server", colors.blue, ["--filter", "@rpg/server", "dev"]);
start("client", colors.green, ["--filter", "@rpg/client", "dev"]);

function writeGorilatorState(state) {
  const file = process.env.GORILATOR_STATE_FILE;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    console.error(`[dev] could not write Gorilator state: ${err instanceof Error ? err.message : err}`);
  }
}
