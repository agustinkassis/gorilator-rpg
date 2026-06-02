// Shared "where is it listening / where can I reach it" reporting, used by
// install, start, and status so the user always sees the same port + URL block.
import { existsSync, readFileSync } from "node:fs";
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
    process.stdout.write(`  Client : http://localhost:${info.clientPort}  (game page)\n`);
    process.stdout.write(`  Server : http://localhost:${info.port}  (WebSocket + monitor + API)\n`);
  } else {
    process.stdout.write(`  Local  : http://localhost:${info.port}  (game client + WebSocket)\n`);
  }
  if (healthy !== undefined) {
    const tag = healthy ? log.green("(ok)") : log.yellow("(starting…)");
    process.stdout.write(`  Health : http://localhost:${info.port}/healthz  ${tag}\n`);
  }
  const creds = info.monitorUser
    ? `  (user ${info.monitorUser}${info.monitorPass ? ` · pass ${info.monitorPass}` : ""})`
    : "";
  process.stdout.write(`  Monitor: http://localhost:${info.port}/colyseus${creds}\n`);
}

/** Print the public Cloudflare URLs when a tunnel has been configured. New
 *  setups use one host for play + WSS + monitor; old split-host setups are
 *  still displayed as split for clarity. Returns whether anything was printed. */
export function printPublic(info: SummaryInfo): boolean {
  if (!info.clientHost && !info.serverHost) return false;
  process.stdout.write("\n");
  const creds = info.monitorUser ? `  (user ${info.monitorUser})` : "";
  if (info.clientHost && info.serverHost && info.clientHost !== info.serverHost) {
    process.stdout.write(`  Play   : ${log.green(`https://${info.clientHost}`)}\n`);
    process.stdout.write(`  Server : wss://${info.serverHost}\n`);
    process.stdout.write(`  Monitor: https://${info.serverHost}/colyseus${creds}\n`);
  } else {
    const host = info.serverHost || info.clientHost;
    process.stdout.write(`  Play   : ${log.green(`https://${host}`)}\n`);
    process.stdout.write(`  Server : wss://${host}\n`);
    process.stdout.write(`  Monitor: https://${host}/colyseus${creds}\n`);
  }
  return true;
}
