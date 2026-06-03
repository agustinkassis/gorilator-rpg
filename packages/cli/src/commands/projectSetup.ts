import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { saveConfig } from "../lib/config.js";
import { loadProjectConfig, readProjectEnv, type RuntimeContext } from "../lib/context.js";
import { generateNsec, genSecret, isValidNsec, parseEnv, renderEnv } from "../lib/env.js";
import * as log from "../lib/log.js";
import { selectMenu } from "../lib/menu.js";
import type { Options } from "../lib/options.js";
import { ask, canPrompt, confirm } from "../lib/proc.js";
import { projectStatus, restartProjectDev } from "../lib/projectDev.js";

type EnvMap = Record<string, string>;

const DEFAULT_SERVER_NAME = "Gorilator Server";
const DEFAULT_CLIENT_PORT = 5173;

export async function runProjectSetup(opts: Options, ctx: RuntimeContext): Promise<void> {
  if (!canPrompt() || opts.yes) {
    saveProjectConfigFromEnv(opts, ctx);
    showCurrentSettings(opts, ctx);
    return;
  }

  for (;;) {
    const cfg = loadProjectConfig(ctx, opts);
    const env = readProjectEnv(ctx);
    const choice = await selectMenu(`Gorilator project setup\n${ctx.appDir}`, [
      {
        label: "Server and client ports",
        hint: `server ${env.GAME_SERVER_PORT || cfg.port}, client ${
          env.CLIENT_PORT || cfg.clientPort || DEFAULT_CLIENT_PORT
        }`,
      },
      { label: "Server NSEC", hint: maskSecret(env.NOSTR_NSEC) },
      {
        label: "Colyseus and environment",
        hint: env.SERVER_NAME || DEFAULT_SERVER_NAME,
      },
      { label: "Show current settings" },
      { label: "Exit" },
    ]);

    if (choice === 0) await portsMenu(opts, ctx);
    else if (choice === 1) await nsecMenu(opts, ctx);
    else if (choice === 2) await environmentMenu(opts, ctx);
    else if (choice === 3) {
      showCurrentSettings(opts, ctx);
      pause();
    } else return;
  }
}

async function portsMenu(opts: Options, ctx: RuntimeContext): Promise<void> {
  for (;;) {
    const cfg = loadProjectConfig(ctx, opts);
    const env = readProjectEnv(ctx);
    const serverPort = Number(env.GAME_SERVER_PORT) || cfg.port;
    const clientPort = Number(env.CLIENT_PORT) || cfg.clientPort || DEFAULT_CLIENT_PORT;
    const choice = await selectMenu("Project ports", [
      { label: "Update server port", hint: String(serverPort) },
      { label: "Update client port", hint: String(clientPort) },
      { label: "Back" },
    ]);

    if (choice === 0) await updatePort(opts, ctx, "GAME_SERVER_PORT", "Server port", serverPort);
    else if (choice === 1) await updatePort(opts, ctx, "CLIENT_PORT", "Client port", clientPort);
    else return;
  }
}

async function updatePort(
  opts: Options,
  ctx: RuntimeContext,
  key: "GAME_SERVER_PORT" | "CLIENT_PORT",
  label: string,
  current: number,
): Promise<void> {
  const next = promptPort(label, current);
  if (next === current) return;

  writeEnvPatch(ctx, { [key]: String(next) }, `Updated ${key}.`);
  const cfg = loadProjectConfig(ctx, opts);
  saveConfig(
    {
      ...cfg,
      port: key === "GAME_SERVER_PORT" ? next : cfg.port,
      clientPort: key === "CLIENT_PORT" ? next : cfg.clientPort,
    },
    ctx.configPath,
  );
  await restartIfRunning(opts, ctx);
  pause();
}

async function nsecMenu(opts: Options, ctx: RuntimeContext): Promise<void> {
  for (;;) {
    const env = readProjectEnv(ctx);
    const choice = await selectMenu("Server NSEC", [
      { label: "Insert or update NOSTR_NSEC", hint: maskSecret(env.NOSTR_NSEC) },
      { label: "Generate a new NOSTR_NSEC", hint: "server will publish as a new Nostr identity" },
      { label: "Back" },
    ]);

    if (choice === 0) await updateNsec(opts, ctx);
    else if (choice === 1) await generateServerNsec(opts, ctx);
    else return;
  }
}

async function updateNsec(opts: Options, ctx: RuntimeContext): Promise<void> {
  const nsec = ask("Paste server nsec1...: ").trim();
  if (!isValidNsec(nsec)) {
    log.warn("That does not look like an nsec1 secret key. No change made.");
    pause();
    return;
  }
  writeEnvPatch(ctx, { NOSTR_NSEC: nsec }, "Updated server NOSTR_NSEC.");
  await restartIfRunning(opts, ctx);
  pause();
}

async function generateServerNsec(opts: Options, ctx: RuntimeContext): Promise<void> {
  if (!confirm("Generate a new server NSEC? Existing server-signed saves will use a new author.")) {
    return;
  }
  const nsec = generateNsec();
  writeEnvPatch(ctx, { NOSTR_NSEC: nsec }, `Generated server NOSTR_NSEC ${maskSecret(nsec)}.`);
  await restartIfRunning(opts, ctx);
  pause();
}

async function environmentMenu(opts: Options, ctx: RuntimeContext): Promise<void> {
  for (;;) {
    const env = readProjectEnv(ctx);
    const choice = await selectMenu("Colyseus and environment", [
      { label: "Update server display name", hint: env.SERVER_NAME || DEFAULT_SERVER_NAME },
      { label: "Update Colyseus monitor credentials", hint: env.MONITOR_USER || "disabled" },
      { label: "Update server stats file", hint: env.SERVER_STATS_FILE || "default .server-realms.json" },
      { label: "Set custom supported server env var" },
      { label: "Show current environment" },
      { label: "Back" },
    ]);

    if (choice === 0) await updateServerName(opts, ctx);
    else if (choice === 1) await updateMonitorCredentials(opts, ctx);
    else if (choice === 2) await updateOptionalEnv(opts, ctx, "SERVER_STATS_FILE", "Server stats file");
    else if (choice === 3) await updateCustomEnv(opts, ctx);
    else if (choice === 4) {
      showCurrentSettings(opts, ctx);
      pause();
    } else return;
  }
}

async function updateServerName(opts: Options, ctx: RuntimeContext): Promise<void> {
  const current = readProjectEnv(ctx).SERVER_NAME || DEFAULT_SERVER_NAME;
  const next = ask(`Server display name [${current}]: `).trim() || current;
  writeEnvPatch(ctx, { SERVER_NAME: next }, "Updated server display name.");
  await restartIfRunning(opts, ctx);
  pause();
}

async function updateMonitorCredentials(opts: Options, ctx: RuntimeContext): Promise<void> {
  const env = readProjectEnv(ctx);
  const currentUser = env.MONITOR_USER || "admin";
  const user = ask(`Monitor user [${currentUser}, "none" disables monitor auth]: `).trim();
  if (user.toLowerCase() === "none") {
    writeEnvPatch(ctx, { MONITOR_USER: "", MONITOR_PASS: "" }, "Disabled monitor auth.");
    await restartIfRunning(opts, ctx);
    pause();
    return;
  }

  const nextUser = user || currentUser;
  const pass = ask("Monitor password [blank generates a new one]: ").trim() || genSecret();
  writeEnvPatch(ctx, { MONITOR_USER: nextUser, MONITOR_PASS: pass }, "Updated monitor credentials.");
  await restartIfRunning(opts, ctx);
  log.ok(`Monitor user ${nextUser}; password ${pass}`);
  pause();
}

async function updateOptionalEnv(
  opts: Options,
  ctx: RuntimeContext,
  key: string,
  label: string,
): Promise<void> {
  const current = readProjectEnv(ctx)[key] || "";
  const next = ask(`${label} [${current || "default"}; "none" clears]: `).trim();
  if (!next) return;
  writeEnvPatch(ctx, { [key]: next.toLowerCase() === "none" ? "" : next }, `Updated ${key}.`);
  await restartIfRunning(opts, ctx);
  pause();
}

async function updateCustomEnv(opts: Options, ctx: RuntimeContext): Promise<void> {
  const allowed = ["MONITOR_USER", "MONITOR_PASS", "SERVER_NAME", "SERVER_STATS_FILE"];
  process.stdout.write(`Supported keys:\n${allowed.map((k) => `  ${k}`).join("\n")}\n`);
  const key = ask("Env key: ").trim();
  if (!allowed.includes(key)) {
    log.warn("Unsupported env key. No change made.");
    pause();
    return;
  }
  const value = ask(`Value for ${key} ("none" clears): `).trim();
  writeEnvPatch(ctx, { [key]: value.toLowerCase() === "none" ? "" : value }, `Updated ${key}.`);
  await restartIfRunning(opts, ctx);
  pause();
}

function saveProjectConfigFromEnv(opts: Options, ctx: RuntimeContext): void {
  const cfg = loadProjectConfig(ctx, opts);
  saveConfig(cfg, ctx.configPath);
  log.ok(`Saved project settings to ${ctx.configPath}`);
}

function writeEnvPatch(ctx: RuntimeContext, patch: Record<string, string>, message: string): void {
  const cur = existsSync(ctx.envPath) ? parseEnv(readFileSync(ctx.envPath, "utf8")) : {};
  writeFileSync(ctx.envPath, renderEnv({ ...cur, ...patch }), { mode: 0o600 });
  log.ok(message);
}

async function restartIfRunning(opts: Options, ctx: RuntimeContext): Promise<void> {
  if (!(await projectStatus(ctx)).active) return;
  log.info("Restarting local dev process...");
  await restartProjectDev(ctx, opts);
}

function showCurrentSettings(opts: Options, ctx: RuntimeContext): void {
  const cfg = loadProjectConfig(ctx, opts);
  const env = readProjectEnv(ctx);
  process.stdout.write(`${log.bold("Project")}\n`);
  process.stdout.write(`  Files: ${ctx.appDir}\n`);
  process.stdout.write(`  Config: ${ctx.configPath}\n\n`);
  process.stdout.write(`${log.bold("Server")}\n`);
  process.stdout.write(`  GAME_SERVER_PORT: ${env.GAME_SERVER_PORT || cfg.port}\n`);
  process.stdout.write(`  CLIENT_PORT:      ${env.CLIENT_PORT || cfg.clientPort || DEFAULT_CLIENT_PORT}\n`);
  process.stdout.write(`  SERVER_NAME:      ${env.SERVER_NAME || DEFAULT_SERVER_NAME}\n`);
  process.stdout.write(`  SERVER_STATS_FILE: ${env.SERVER_STATS_FILE || ".server-realms.json"}\n\n`);
  process.stdout.write(`${log.bold("Nostr")}\n`);
  process.stdout.write(`  NOSTR_NSEC: ${maskSecret(env.NOSTR_NSEC)}\n\n`);
  process.stdout.write(`${log.bold("Colyseus Monitor")}\n`);
  process.stdout.write(`  MONITOR_USER: ${env.MONITOR_USER || "(disabled)"}\n`);
  process.stdout.write(`  MONITOR_PASS: ${maskSecret(env.MONITOR_PASS)}\n`);
}

function promptPort(label: string, current: number): number {
  for (;;) {
    const raw = ask(`${label} [${current}]: `).trim();
    if (!raw) return current;
    const port = Number(raw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    log.warn("Enter a port from 1 to 65535.");
  }
}

function maskSecret(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 16) return "set";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function pause(): void {
  if (canPrompt()) ask("\nPress Enter to continue...");
}
