#!/usr/bin/env node
// gorilator — native install & daemon control for the Gorilator RPG (no Docker).
//
//   gorilator install                      bootstrap a box (clone, build, run as a service)
//   gorilator setup                        wire it to public Cloudflare subdomains
//   gorilator start | stop | restart       drive the OS service
//   gorilator status | info | logs         inspect it
//   gorilator update                       git pull, rebuild, restart
//   gorilator tunnel <login|status|restart>  manage the Cloudflare tunnel
//   gorilator uninstall                    remove the service (keeps files)
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

  install            Clone the game, build it, run it as a service, put 'gorilator' on PATH
  setup              Configure a Cloudflare tunnel + public subdomains, rebuild the client
  start              Start the daemon (prints the port it listens on)
  stop               Stop the daemon
  restart            Restart the daemon
  status, info       Service state + health check + local & public URLs
  logs               Stream the server logs (Ctrl-C to detach)
  update             git pull, rebuild, restart
  tunnel <cmd>       Manage the Cloudflare tunnel — login | status | restart
  uninstall          Stop and remove the service (your files are kept)
  serve              Run the server in the foreground (used by the service)
  version            Print the version

Options (install):
  --repo <url>       Game repository      (env GORILATOR_REPO)
  --ref <ref>        Branch or tag        (env GORILATOR_REF, default main)
  --dir <path>       Install directory    (env GORILATOR_DIR)
  --port <n>         Listen port          (env GAME_SERVER_PORT, default 2567)
  --yes              Assume yes to prompts (env GORILATOR_YES=1)
  --skip-service     Clone + build only; don't register the OS service
  --skip-tunnel      Don't offer the Cloudflare setup after install
  --local-cli <pkg>  Install the global command from a local path/tarball (testing)
`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      ref: { type: "string" },
      dir: { type: "string" },
      port: { type: "string" },
      yes: { type: "boolean" },
      "skip-service": { type: "boolean" },
      "skip-tunnel": { type: "boolean" },
      "local-cli": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    process.stdout.write(`gorilator ${VERSION}\n`);
    return;
  }

  const cmd = positionals[0];
  if (values.help || cmd === undefined || cmd === "help") {
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
      logsCmd();
      break;
    case "update":
      update();
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
