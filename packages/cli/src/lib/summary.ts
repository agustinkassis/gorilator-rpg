// Shared "where is it listening / where can I reach it" reporting, used by
// install, start, and status so the user always sees the same port + URL block.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "./env.js";
import * as log from "./log.js";
import { envFile } from "./paths.js";

export interface SummaryInfo {
  port: number;
  clientPort?: number; // dedicated client web port (separate from the server port)
  monitorUser?: string;
  monitorPass?: string;
  clientHost?: string; // legacy public play.* (from old split-host setups)
  serverHost?: string; // public game host (or legacy api.*)
}

export interface PackageVersion {
  label: string;
  version: string;
}

const FIELD_LABEL_WIDTH = 11;

export const PACKAGE_VERSION_FILES: Array<{ label: string; path: string }> = [
  { label: "app", path: "package.json" },
  { label: "cli", path: "packages/cli/package.json" },
  { label: "client", path: "packages/client/package.json" },
  { label: "server", path: "packages/server/package.json" },
  { label: "shared", path: "packages/shared/package.json" },
  { label: "landing", path: "packages/landing/package.json" },
];

function readPackageVersion(appDir: string, path: string): string | null {
  const packagePath = join(appDir, path);
  if (!existsSync(packagePath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

export function printSection(title: string): void {
  process.stdout.write(`${log.bold(title)}\n`);
}

export function printField(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(FIELD_LABEL_WIDTH)}: ${value}\n`);
}

export function readPackageVersions(appDir: string): PackageVersion[] {
  return PACKAGE_VERSION_FILES.flatMap(({ label, path }) => {
    const version = readPackageVersion(appDir, path);
    return version ? [{ label, version }] : [];
  });
}

export interface PrintPackageVersionsOptions {
  heading?: string | boolean;
}

export function printPackageVersions(
  appDir: string,
  opts: PrintPackageVersionsOptions = {},
): void {
  const versions = readPackageVersions(appDir);
  if (versions.length === 0) return;
  if (opts.heading) {
    printSection(typeof opts.heading === "string" ? opts.heading : "Package Versions");
    for (const { label, version } of versions) {
      printField(label, `v${version}`);
    }
    return;
  }
  const summary = versions.map(({ label, version }) => `${label} v${version}`).join(" / ");
  printField("Packages", summary);
}

/** Read the listen port + monitor creds + public hostnames out of the install's
 *  .env, falling back to the saved config values when .env predates them (e.g. an
 *  install upgraded from a version whose .env had no CLIENT_PORT). */
export function readEnvInfo(
  appDir: string,
  fallbackPort: number,
  fallbackClientPort?: number,
): SummaryInfo {
  const ef = envFile(appDir);
  const e = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  const port = Number(e.GAME_SERVER_PORT) || fallbackPort;
  const clientPort = Number(e.CLIENT_PORT) || fallbackClientPort;
  return {
    port,
    clientPort,
    monitorUser: e.MONITOR_USER,
    monitorPass: e.MONITOR_PASS,
    clientHost: e.CLIENT_HOSTNAME,
    serverHost: e.SERVER_HOSTNAME,
  };
}

/** Print the local port the daemon listens on (client page + WebSocket + monitor
 *  share it). Pass `healthy` to also show the /healthz result. */
export function printPorts(info: SummaryInfo, healthy?: boolean): void {
  if (info.clientPort && info.clientPort !== info.port) {
    printField("Client", `http://localhost:${info.clientPort}  (game page)`);
    printField("Server", `http://localhost:${info.port}  (WebSocket + monitor + API)`);
  } else {
    printField("Local", `http://localhost:${info.port}  (game client + WebSocket)`);
  }
  if (healthy !== undefined) {
    const tag = healthy ? log.green("(ok)") : log.yellow("(starting…)");
    printField("Health", `http://localhost:${info.port}/healthz  ${tag}`);
  }
  const creds = info.monitorUser
    ? `  (user ${info.monitorUser}${info.monitorPass ? ` · pass ${info.monitorPass}` : ""})`
    : "";
  printField("Monitor", `http://localhost:${info.port}/colyseus${creds}`);
}

/** Print the public Cloudflare URLs when a tunnel has been configured. New
 *  setups use one host for play + WSS + monitor; old split-host setups are
 *  still displayed as split for clarity. Returns whether anything was printed. */
export interface PrintPublicOptions {
  heading?: string | boolean;
  leadingBlank?: boolean;
}

export function printPublic(info: SummaryInfo, opts: PrintPublicOptions = {}): boolean {
  if (!info.clientHost && !info.serverHost) return false;
  if (opts.leadingBlank !== false) process.stdout.write("\n");
  if (opts.heading) {
    printSection(typeof opts.heading === "string" ? opts.heading : "Public URLs");
  }
  const creds = info.monitorUser ? `  (user ${info.monitorUser})` : "";
  if (info.clientHost && info.serverHost && info.clientHost !== info.serverHost) {
    printField("Play", log.green(`https://${info.clientHost}`));
    printField("Server", `wss://${info.serverHost}`);
    printField("Monitor", `https://${info.serverHost}/colyseus${creds}`);
  } else {
    const host = info.serverHost || info.clientHost;
    printField("Play", log.green(`https://${host}`));
    printField("Server", `wss://${host}`);
    printField("Monitor", `https://${host}/colyseus${creds}`);
  }
  return true;
}
