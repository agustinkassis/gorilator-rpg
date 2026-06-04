#!/usr/bin/env node
// gorilator — native install & daemon control for the Gorilator RPG (no Docker).
//
//   gorilator install                      bootstrap a box (clone, build, run as a service)
//   gorilator setup                        wire it to a public Cloudflare hostname
//   gorilator start | stop | restart       drive the OS service
//   gorilator status | info | logs         inspect it
//   gorilator update                       stop services, git pull, rebuild, start services
//   gorilator remote                       compare local versions with remote ones
//   gorilator tunnel <login|status|restart>  manage the Cloudflare tunnel
//   gorilator uninstall                    stop and remove Gorilator from this machine
//   gorilator serve                        internal: the supervised foreground process
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { install } from "./commands/install.js";
import { remoteCmd } from "./commands/remote.js";
import { serve } from "./commands/serve.js";
import { logsCmd, restartCmd, startCmd, statusCmd, stopCmd } from "./commands/service.js";
import { runSetup, tunnelCmd } from "./commands/setup.js";
import { uninstall } from "./commands/uninstall.js";
import { update } from "./commands/update.js";
import { resolveRuntimeContext, type RuntimeContext } from "./lib/context.js";
import * as log from "./lib/log.js";
import { selectMenu } from "./lib/menu.js";
import { resolveOptions, type RawFlags } from "./lib/options.js";
import { ask, canPrompt } from "./lib/proc.js";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = readCliPackageVersion();

function readCliPackageVersion(): string {
  for (const dir of ancestorDirs(here)) {
    for (const packagePath of [join(dir, "package.json"), join(dir, "packages", "cli", "package.json")]) {
      const version = readVersionFromCliPackage(packagePath);
      if (version) return version;
    }
  }
  return "0.0.0";
}

function readVersionFromCliPackage(packagePath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== "gorilator") return null;
    return typeof pkg.version === "string" && pkg.version.trim().length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

function* ancestorDirs(start: string): Generator<string> {
  for (let dir = start; ; dir = dirname(dir)) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir) return;
  }
}

function usage(): void {
  process.stdout.write(`${log.bold("gorilator")} ${VERSION} — native install & daemon for the Gorilator RPG (no Docker)

Usage: gorilator <command> [options]
       gorilator help <command>

  install            Clone the game, build it, run it as a service, put 'gorilator' on PATH
  setup              Open the setup menu: server ports, NSEC, Cloudflare, env settings
  start              Start the daemon (prints the port it listens on)
  stop               Stop the daemon
  restart            Restart the daemon
  status, info       Service state + health check + local & public URLs
  logs               Show server logs; add --follow to stream realtime
  update             Stop services, git pull, rebuild, start services
  remote             Check remote updates and compare package versions
  tunnel <cmd>       Manage the Cloudflare tunnel — login | status | restart
  uninstall          Stop and remove Gorilator services, config, global command, and installed files
  serve              Run the server in the foreground (used by the service)
  version            Print the version
  help <command>     Show detailed help for one command

Run without a command in an interactive terminal to open the menu. Inside a
Gorilator repo or fork, start/stop/restart/status/logs/setup/update target that
checkout's local dev server/client. Outside a repo, they use the system install.

Options (install):
  --repo <url>       Game repository      (env GORILATOR_REPO)
  --ref <ref>        Branch or tag        (env GORILATOR_REF, default main)
  --dir <path>       Install directory    (env GORILATOR_DIR)
  --port <n>         Server port (WebSocket + monitor + API)  (env GAME_SERVER_PORT, default 2567)
  --client-port <n>  Optional extra client web port           (env CLIENT_PORT)
  --yes              Assume yes to prompts (env GORILATOR_YES=1)
  --skip-service     Clone + build only; don't register the OS service
  --skip-tunnel      Don't offer the Cloudflare setup after install
  --local-cli <pkg>  Install the global command from a local path/tarball (testing)

Options (logs):
  --lines <n>        Number of recent lines to show (default 100)
  --follow           Stream logs in realtime after printing recent lines
  --filter <text>    Show only lines containing text (case-insensitive)
  --since <time>     Linux/systemd only: journalctl --since value, e.g. "1 hour ago"

Options (uninstall):
  --keep-files       Stop services/config, but keep the installed app directory
  --keep-command     Keep the global npm 'gorilator' command
  --keep-tunnel      Keep the local cloudflared service/config

Options (remote):
  --no-npm           Skip the published npm package version check
`);
}

const COMMAND_HELP: Record<string, string> = {
  install: `${log.bold("gorilator install")} — install and start Gorilator

Usage:
  gorilator install [options]
  gorilator help install

Installs prerequisites, clones/updates the game checkout, generates .env, builds the client/server/shared packages, installs the OS service, installs the global npm 'gorilator' command, starts the daemon, and optionally offers Cloudflare setup.

Options:
  --repo <url>       Game repository      (env GORILATOR_REPO)
  --ref <ref>        Branch or tag        (env GORILATOR_REF, default main)
  --dir <path>       Install directory    (env GORILATOR_DIR)
  --port <n>         Server port          (env GAME_SERVER_PORT, default 2567)
  --client-port <n>  Optional extra client web port (env CLIENT_PORT)
  --yes              Assume yes to prompts (env GORILATOR_YES=1)
  --skip-service     Clone + build only; do not register the OS service
  --skip-tunnel      Do not offer Cloudflare setup after install
  --local-cli <pkg>  Install global command from a local path/tarball

Examples:
  gorilator install
  gorilator install --port 3000 --skip-tunnel
  GORILATOR_REPO=https://github.com/you/fork.git gorilator install
`,
  setup: `${log.bold("gorilator setup")} — configure an installed server

Usage:
  gorilator setup [options]
  gorilator help setup

Opens the interactive setup menu for server ports, logs, NSEC, Cloudflare, monitor credentials, and supported environment values. In non-interactive Cloudflare automation, set GORILATOR_DOMAIN and optionally GORILATOR_HOST.

Options:
  --dir <path>       Install directory override (env GORILATOR_DIR)
  --port <n>         Server port override
  --yes              Non-interactive mode when env values are supplied

Examples:
  gorilator setup
  GORILATOR_DOMAIN=example.com gorilator setup --yes
`,
  start: `${log.bold("gorilator start")} — start the Gorilator daemon

Usage:
  gorilator start
  gorilator help start

Starts the configured systemd service on Linux or launchd agent on macOS, then prints local/public URLs when available.
`,
  stop: `${log.bold("gorilator stop")} — stop the Gorilator daemon

Usage:
  gorilator stop
  gorilator help stop

Stops the configured systemd service on Linux or launchd agent on macOS.
`,
  restart: `${log.bold("gorilator restart")} — restart the Gorilator daemon

Usage:
  gorilator restart
  gorilator help restart

Restarts the configured systemd service on Linux or launchd agent on macOS.
`,
  status: `${log.bold("gorilator status")} — inspect service state

Usage:
  gorilator status
  gorilator info
  gorilator help status

Shows service state, health check, local/public URLs, package versions, install path, and recent service-manager status output.
`,
  info: `${log.bold("gorilator info")} — alias for status

Usage:
  gorilator info
  gorilator status

Shows the same output as 'gorilator status'.
`,
  logs: `${log.bold("gorilator logs")} — inspect server logs

Usage:
  gorilator logs [options]
  gorilator help logs

Shows recent server logs by default. Add --follow to keep streaming realtime logs. Linux uses journalctl for the systemd unit; macOS tails the launchd log file.

Options:
  --lines <n>        Number of recent lines to show (default 100, max 10000)
  --follow, -f       Stream logs in realtime after recent lines
  --filter <text>    Show only lines containing text (case-insensitive)
  --since <time>     Linux/systemd only; passed to journalctl --since

Examples:
  gorilator logs
  gorilator logs --lines 250
  gorilator logs --follow
  gorilator logs --filter error --since "1 hour ago"
`,
  update: `${log.bold("gorilator update")} — update the installed checkout

Usage:
  gorilator update
  gorilator help update

Stops services, updates the installed git checkout, reinstalls dependencies, rebuilds packages, and starts services again.
`,
  remote: `${log.bold("gorilator remote")} — compare local and remote versions

Usage:
  gorilator remote [options]
  gorilator help remote

Fetches the configured git ref without changing the worktree, compares local package versions with the remote package.json versions, and compares the local CLI package with the latest published npm package.

Options:
  --no-npm           Skip the published npm package version check

Examples:
  gorilator remote
  gorilator remote --no-npm
`,
  tunnel: `${log.bold("gorilator tunnel")} — manage the Cloudflare tunnel

Usage:
  gorilator tunnel [status|login|restart]
  gorilator help tunnel

Subcommands:
  status             Show local cloudflared tunnel status
  login              Authorize cloudflared with Cloudflare
  restart            Restart the local cloudflared tunnel service

Examples:
  gorilator tunnel
  gorilator tunnel login
  gorilator tunnel restart
`,
  uninstall: `${log.bold("gorilator uninstall")} — remove Gorilator from this machine

Usage:
  gorilator uninstall [options]
  gorilator help uninstall

Stops/removes Gorilator services, local config, the global command, and installed files unless keep options are supplied.

Options:
  --keep-files       Keep the installed app directory
  --keep-command     Keep the global npm 'gorilator' command
  --keep-tunnel      Keep local cloudflared service/config

Examples:
  gorilator uninstall
  gorilator uninstall --keep-files
`,
  serve: `${log.bold("gorilator serve")} — run the supervised foreground process

Usage:
  gorilator serve [options]
  gorilator help serve

Internal command used by the OS service. It starts the game server process in the foreground using the saved install config unless explicit flags override it.

Options:
  --dir <path>       Install directory override
  --port <n>         Server port override
  --client-port <n>  Optional extra client web port
`,
  version: `${log.bold("gorilator version")} — print the CLI version

Usage:
  gorilator version
  gorilator --version
  gorilator help version
`,
  help: `${log.bold("gorilator help")} — show help

Usage:
  gorilator help
  gorilator help <command>
  gorilator <command> --help

Examples:
  gorilator help logs
  gorilator help install
`,
};

function printCommandHelp(command: string | undefined): boolean {
  if (!command) {
    usage();
    return true;
  }
  const key = command === "info" ? "status" : command;
  const body = COMMAND_HELP[key];
  if (!body) return false;
  process.stdout.write(`${body.trimEnd()}\n`);
  return true;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      ref: { type: "string" },
      dir: { type: "string" },
      port: { type: "string" },
      "client-port": { type: "string" },
      yes: { type: "boolean" },
      "skip-service": { type: "boolean" },
      "skip-tunnel": { type: "boolean" },
      "local-cli": { type: "string" },
      "keep-files": { type: "boolean" },
      "keep-command": { type: "boolean" },
      "keep-tunnel": { type: "boolean" },
      lines: { type: "string" },
      follow: { type: "boolean", short: "f" },
      "no-follow": { type: "boolean" },
      filter: { type: "string" },
      since: { type: "string" },
      "no-npm": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    process.stdout.write(`gorilator ${VERSION}\n`);
    return;
  }

  const cmd = positionals[0];
  if (cmd === "help") {
    if (!printCommandHelp(positionals[1])) {
      log.err(`Unknown command: ${positionals[1]}`);
      usage();
      process.exitCode = 1;
    }
    return;
  }
  if (values.help && cmd !== undefined) {
    if (!printCommandHelp(cmd)) {
      log.err(`Unknown command: ${cmd}`);
      usage();
      process.exitCode = 1;
    }
    return;
  }
  if (values.help || cmd === undefined) {
    usage();
    return;
  }

  const opts = resolveOptions(values as RawFlags);
  const ctx = resolveRuntimeContext(opts);

  if (cmd === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await runMainMenu(ctx, opts);
      return;
    }
    usage();
    return;
  }

  switch (cmd) {
    case "install":
      await install(opts, VERSION);
      break;
    case "setup":
      await runSetup(opts, ctx);
      break;
    case "serve":
      serve(opts);
      break;
    case "start":
      await startCmd(ctx, opts);
      break;
    case "stop":
      await stopCmd(ctx);
      break;
    case "restart":
      await restartCmd(ctx, opts);
      break;
    case "status":
    case "info":
      await statusCmd(ctx, opts);
      break;
    case "logs":
      logsCmd(ctx, values);
      break;
    case "update":
      await update(ctx, opts);
      break;
    case "remote":
      await remoteCmd(ctx, opts, { npm: !values["no-npm"] });
      break;
    case "tunnel":
      tunnelCmd(positionals[1]);
      break;
    case "uninstall":
      uninstall(opts);
      break;
    case "version":
      process.stdout.write(`gorilator ${VERSION}\n`);
      break;
    default:
      log.err(`Unknown command: ${cmd}`);
      usage();
      process.exitCode = 1;
  }
}

async function runMainMenu(ctx: RuntimeContext, opts: ReturnType<typeof resolveOptions>): Promise<void> {
  if (ctx.kind === "project") {
    await runProjectMenu(ctx, opts);
    return;
  }
  await runSystemMenu(ctx, opts);
}

async function runProjectMenu(ctx: RuntimeContext, opts: ReturnType<typeof resolveOptions>): Promise<void> {
  for (;;) {
    const choice = await selectMenu(`Gorilator project\n${ctx.appDir}`, [
      { label: "Status" },
      { label: "Start" },
      { label: "Stop" },
      { label: "Restart" },
      { label: "Logs" },
      { label: "Settings" },
      { label: "Update" },
      { label: "Remote" },
      { label: "Help" },
      { label: "Exit" },
    ]);

    if (choice === 0) {
      await statusCmd(ctx, opts);
      pause();
    } else if (choice === 1) {
      await startCmd(ctx, opts);
      pause();
    } else if (choice === 2) {
      await stopCmd(ctx);
      pause();
    } else if (choice === 3) {
      await restartCmd(ctx, opts);
      pause();
    } else if (choice === 4) {
      logsCmd(ctx);
    } else if (choice === 5) {
      await runSetup(opts, ctx);
    } else if (choice === 6) {
      await update(ctx, opts);
      pause();
    } else if (choice === 7) {
      await remoteCmd(ctx, opts);
      pause();
    } else if (choice === 8) {
      usage();
      pause();
    } else return;
  }
}

async function runSystemMenu(ctx: RuntimeContext, opts: ReturnType<typeof resolveOptions>): Promise<void> {
  for (;;) {
    const choice = await selectMenu("Gorilator system install", [
      { label: "Status" },
      { label: "Start" },
      { label: "Stop" },
      { label: "Restart" },
      { label: "Logs" },
      { label: "Setup" },
      { label: "Install" },
      { label: "Update" },
      { label: "Remote" },
      { label: "Tunnel" },
      { label: "Uninstall" },
      { label: "Help" },
      { label: "Exit" },
    ]);

    if (choice === 0) {
      await statusCmd(ctx, opts);
      pause();
    } else if (choice === 1) {
      await startCmd(ctx, opts);
      pause();
    } else if (choice === 2) {
      await stopCmd(ctx);
      pause();
    } else if (choice === 3) {
      await restartCmd(ctx, opts);
      pause();
    } else if (choice === 4) {
      logsCmd(ctx);
    } else if (choice === 5) {
      await runSetup(opts, ctx);
    } else if (choice === 6) {
      await install(opts, VERSION);
      pause();
    } else if (choice === 7) {
      await update(ctx, opts);
      pause();
    } else if (choice === 8) {
      await remoteCmd(ctx, opts);
      pause();
    } else if (choice === 9) {
      await runTunnelMenu();
    } else if (choice === 10) {
      uninstall(opts);
      pause();
    } else if (choice === 11) {
      usage();
      pause();
    } else return;
  }
}

async function runTunnelMenu(): Promise<void> {
  for (;;) {
    const choice = await selectMenu("Gorilator tunnel", [
      { label: "Status" },
      { label: "Login" },
      { label: "Restart" },
      { label: "Back" },
    ]);
    if (choice === 0) {
      tunnelCmd("status");
      pause();
    } else if (choice === 1) {
      tunnelCmd("login");
      pause();
    } else if (choice === 2) {
      tunnelCmd("restart");
      pause();
    } else return;
  }
}

function pause(): void {
  if (canPrompt()) ask("\nPress Enter to continue...");
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
