// Shared "where is it listening / where can I reach it" reporting, used by
// install, start, and status so the user always sees the same port + URL block.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "./env.js";
import * as log from "./log.js";
import { envFile } from "./paths.js";

export interface SummaryInfo {
  port: number;
  monitorUser?: string;
  monitorPass?: string;
  clientHost?: string; // public play.* (from .env CLIENT_HOSTNAME)
  serverHost?: string; // public api.*  (from .env SERVER_HOSTNAME)
}

/** Read the listen port + monitor creds + public hostnames out of the install's
 *  .env (falling back to the saved port when .env has no GAME_SERVER_PORT). */
export function readEnvInfo(appDir: string, fallbackPort: number): SummaryInfo {
  const ef = envFile(appDir);
  const e = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  const port = Number(e.GAME_SERVER_PORT) || fallbackPort;
  return {
    port,
    monitorUser: e.MONITOR_USER,
    monitorPass: e.MONITOR_PASS,
    clientHost: e.CLIENT_HOSTNAME,
    serverHost: e.SERVER_HOSTNAME,
  };
}

/** Print the local port the daemon listens on (client page + WebSocket + monitor
 *  share it). Pass `healthy` to also show the /healthz result. */
export function printPorts(info: SummaryInfo, healthy?: boolean): void {
  process.stdout.write(`  Local  : http://localhost:${info.port}  (game client + WebSocket)\n`);
  if (healthy !== undefined) {
    const tag = healthy ? log.green("(ok)") : log.yellow("(starting…)");
    process.stdout.write(`  Health : http://localhost:${info.port}/healthz  ${tag}\n`);
  }
  const creds = info.monitorUser
    ? `  (user ${info.monitorUser}${info.monitorPass ? ` · pass ${info.monitorPass}` : ""})`
    : "";
  process.stdout.write(`  Monitor: http://localhost:${info.port}/colyseus${creds}\n`);
}

/** Print the public Cloudflare URLs when a tunnel has been configured (`setup`
 *  writes CLIENT_HOSTNAME/SERVER_HOSTNAME into .env). Returns whether anything
 *  was printed. */
export function printPublic(info: SummaryInfo): boolean {
  if (!info.clientHost && !info.serverHost) return false;
  process.stdout.write("\n");
  if (info.clientHost) process.stdout.write(`  Play   : ${log.green(`https://${info.clientHost}`)}\n`);
  if (info.serverHost) {
    process.stdout.write(`  Server : wss://${info.serverHost}\n`);
    const creds = info.monitorUser ? `  (user ${info.monitorUser})` : "";
    process.stdout.write(`  Monitor: https://${info.serverHost}/colyseus${creds}\n`);
  }
  return true;
}
