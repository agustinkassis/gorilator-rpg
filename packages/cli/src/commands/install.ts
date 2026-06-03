// `gorilator install` — clone the game, build it natively (no Docker), write
// .env, register the OS service, ensure the global command, start it, and offer
// to expose it publicly via a Cloudflare tunnel.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  cloneOrUpdate,
  ensureAppDir,
  ensureGit,
  ensureNode,
  ensurePnpm,
  installAndBuild,
  resolveServiceExec,
} from "../lib/build.js";
import { saveConfig } from "../lib/config.js";
import { generateNsec, genSecret, isValidNsec, parseEnv, renderEnv } from "../lib/env.js";
import {
  durableGorilatorOnPath,
  installWrapperGlobalCommand,
  isTemporaryNpxCommand,
} from "../lib/globalCommand.js";
import { waitForHealth } from "../lib/health.js";
import * as log from "../lib/log.js";
import type { Options } from "../lib/options.js";
import { envFile } from "../lib/paths.js";
import {
  activateNpmGlobalBin,
  activateSudoNpmGlobalBin,
  canPrompt,
  confirm,
  isRoot,
  run,
  targetUser,
  tryRun,
  which,
} from "../lib/proc.js";
import { installService, manager, startService } from "../lib/service.js";
import { printPorts, readEnvInfo } from "../lib/summary.js";
import { runSetup } from "./setup.js";

export async function install(opts: Options, version: string): Promise<void> {
  log.banner(version);
  ensureNode();
  ensureGit();
  ensurePnpm();

  const appDir = opts.appDir;
  const user = targetUser();
  ensureAppDir(appDir, user);
  cloneOrUpdate(opts.repo, opts.ref, appDir);
  ensureEnv(appDir, user, opts.port, opts.clientPort);
  // Default native build is one-port/same-origin. If --client-port is explicitly
  // set, build the optional local client page to dial the server port.
  installAndBuild(appDir, opts.clientPort ? { serverPort: opts.port } : {});

  if (opts.noService) {
    log.ok(`Build ready at ${appDir}. Service registration skipped (--skip-service).`);
    log.info(`Run it in the foreground with:  gorilator serve --dir ${appDir}`);
    return;
  }

  ensureGlobalCli(opts, appDir);
  const exec = resolveServiceExec(appDir);
  installService(appDir, user, exec);
  saveConfig({
    appDir,
    port: opts.port,
    clientPort: opts.clientPort || undefined,
    repo: opts.repo,
    ref: opts.ref,
    user,
    serviceManager: manager(),
  });

  log.info("Starting the daemon…");
  try {
    startService();
  } catch (e) {
    log.warn(`Could not start the service automatically: ${(e as Error).message}`);
  }
  const healthy = await waitForHealth(opts.port);
  printSummary(appDir, opts.port, opts.clientPort, healthy);

  await maybeRunSetup(opts);
}

/** Create .env on first install, and repair older installs that predate the
 *  stable Nostr key. */
function ensureEnv(appDir: string, user: string, port: number, clientPort: number): void {
  const ef = envFile(appDir);
  if (existsSync(ef)) {
    const env = parseEnv(readFileSync(ef, "utf8"));
    const patch: Record<string, string> = {};
    if (!isValidNsec(env.NOSTR_NSEC)) {
      const reason = env.NOSTR_NSEC ? "invalid" : "missing";
      patch.NOSTR_NSEC = generateNsec();
      log.ok(`Generated ${reason} NOSTR_NSEC in ${ef}`);
    }
    if (!clientPort && env.VITE_SAME_ORIGIN !== "1") {
      patch.VITE_SAME_ORIGIN = "1";
      patch.VITE_SERVER_URL = "";
      patch.CLIENT_PORT = "";
      log.ok(`Enabled same-origin client build in ${ef}`);
    }
    if (Object.keys(patch).length === 0) {
      log.ok(`Using existing ${ef}`);
      return;
    }
    writeFileSync(ef, renderEnv({ ...env, ...patch }), { mode: 0o600 });
    if (isRoot() && user !== "root") run("chown", [user, ef]);
    return;
  }
  const body = renderEnv({
    GAME_SERVER_PORT: String(port),
    CLIENT_PORT: clientPort ? String(clientPort) : "",
    VITE_SAME_ORIGIN: clientPort ? "" : "1",
    MONITOR_USER: "admin",
    MONITOR_PASS: genSecret(),
    NOSTR_NSEC: generateNsec(),
    SERVER_NAME: "Gorilator Server",
  });
  writeFileSync(ef, body, { mode: 0o600 });
  // If install ran as root, hand the secrets file to the daemon's user.
  if (isRoot() && user !== "root") run("chown", [user, ef]);
  log.ok(`Generated ${ef}`);
}

/** Make the `gorilator` command global (durable, independent of the npx cache)
 *  so it works from anywhere and the service can reference it. */
function ensureGlobalCli(opts: Options, appDir: string): void {
  const found = which("gorilator");
  if (found && isTemporaryNpxCommand(found)) {
    log.info(`Ignoring temporary npx gorilator shim at ${found}.`);
  } else {
    const durable = durableGorilatorOnPath();
    if (durable && !opts.localCli) {
      log.ok(`Global 'gorilator' command found (${durable}); refreshing it from npm.`);
    }
  }

  const target = opts.localCli ?? "gorilator";
  log.info(`Installing the global gorilator command (npm i -g ${target})…`);
  if (tryRun("npm", ["install", "-g", target])) {
    finishGlobalCliInstall();
    return;
  }
  if (!isRoot() && tryRun("sudo", ["npm", "install", "-g", target])) {
    finishGlobalCliInstall();
    return;
  }

  if (!opts.localCli && installWrapperGlobalCommand(appDir)) {
    return;
  }

  log.die(`Could not install the global command automatically. Run:  npm i -g ${target}`);
}

function finishGlobalCliInstall(): void {
  let bin = activateNpmGlobalBin();
  let installed = which("gorilator");
  if (!installed) {
    bin = activateSudoNpmGlobalBin() ?? bin;
    installed = which("gorilator");
  }
  if (installed) {
    log.ok(`Global 'gorilator' command installed${bin ? ` and PATH includes ${bin}` : ""}.`);
    return;
  }
  log.warn("Global 'gorilator' package installed, but the command is not visible on PATH yet.");
  if (bin) {
    log.info(`This installer persisted ${bin} for future shells.`);
    log.info(`For this terminal, run:  export PATH="${bin}:$PATH"`);
  }
}

function printSummary(appDir: string, port: number, clientPort: number, healthy: boolean): void {
  process.stdout.write("\n");
  log.ok("🦍 Gorilator is installed and running natively (no Docker).");
  const info = readEnvInfo(appDir, port, clientPort || undefined);
  printPorts(info, healthy);
  process.stdout.write(`  Files  : ${appDir}\n`);
  process.stdout.write(
    `\nManage it:  ${log.bold("gorilator")} status | logs | restart | stop | update | setup | uninstall\n`,
  );
  if (!healthy) {
    log.warn("The server didn't answer /healthz yet — check 'gorilator logs'.");
  }
}

/** After a successful install, offer the public Cloudflare setup — but only when
 *  we can actually prompt. Non-interactive / --yes / --skip-tunnel just hint. */
async function maybeRunSetup(opts: Options): Promise<void> {
  if (opts.noTunnel || opts.yes || !canPrompt()) {
    log.info("Expose it publicly anytime with:  gorilator setup");
    return;
  }
  process.stdout.write("\n");
  if (!confirm("Expose this publicly now via a Cloudflare tunnel (gorilator setup)?")) {
    log.info("Skipped. Run 'gorilator setup' anytime to wire up Cloudflare.");
    return;
  }
  await runSetup(opts);
}
