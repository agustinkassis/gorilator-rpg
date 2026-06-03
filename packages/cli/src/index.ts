#!/usr/bin/env node
// gorilator — native install & daemon control for the Gorilator RPG (no Docker).
//
//   gorilator install                      bootstrap a box (clone, build, run as a service)
//   gorilator setup                        wire it to a public Cloudflare hostname
//   gorilator start | stop | restart       drive the OS service
//   gorilator status | info | logs         inspect it
//   gorilator update                       stop services, git pull, rebuild, start services
//   gorilator tunnel <login|status|restart>  manage the Cloudflare tunnel
//   gorilator uninstall                    stop and remove Gorilator from this machine
//   gorilator serve                        internal: the supervised foreground process
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { install } from "./commands/install.js";
import { serve } from "./commands/serve.js";
import { logsCmd, restartCmd, startCmd, statusCmd, stopCmd } from "./commands/service.js";
import { runSetup, tunnelCmd } from "./commands/setup.js";
import { uninstall } from "./commands/uninstall.js";
import { update } from "./commands/update.js";
import * as log from "./lib/log.js";
import { resolveOptions, type RawFlags } from "./lib/options.js";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string })
      .version;
  } catch {
    return "0.0.0";
  }
})();

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
  tunnel <cmd>       Manage the Cloudflare tunnel — login | status | restart
  uninstall          Stop and remove Gorilator services, config, global command, and installed files
  serve              Run the server in the foreground (used by the service)
  version            Print the version
  help <command>     Show detailed help for one command

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

  switch (cmd) {
    case "install":
      await install(opts, VERSION);
      break;
    case "setup":
      await runSetup(opts);
      break;
    case "serve":
      serve(opts);
      break;
    case "start":
      startCmd();
      break;
    case "stop":
      stopCmd();
      break;
    case "restart":
      restartCmd();
      break;
    case "status":
    case "info":
      await statusCmd();
      break;
    case "logs":
      logsCmd(values);
      break;
    case "update":
      await update();
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

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
