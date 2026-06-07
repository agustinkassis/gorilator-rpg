// Temporary Cloudflare quick tunnels for SHARING A LOCAL DEV SERVER (project
// mode). Unlike the system install (one same-origin port behind one tunnel), the
// dev server runs the client on the Vite port and the game server on another, so
// sharing needs TWO quick tunnels: one for the Vite client page and one for the
// game server. The client is told to dial the server tunnel via VITE_SERVER_URL,
// and Vite is configured to accept the trycloudflare host (see vite.config.ts).
//
// These are foreground-spawned, detached background processes (not boot
// services) — they live alongside the dev session and are tracked by a state
// file so a later `Stop sharing` can kill them.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureCloudflared, extractQuickTunnelUrl } from "./cloudflare.js";
import type { RuntimeContext } from "./context.js";
import { which } from "./proc.js";

export interface DevTunnelState {
  serverPid: number;
  clientPid: number;
  /** Public URL of the game-server tunnel (baked into the client as VITE_SERVER_URL). */
  serverUrl: string;
  /** Public URL of the client (Vite) tunnel — the one you share. */
  clientUrl: string;
  startedAt: string;
}

function stateDir(ctx: RuntimeContext): string {
  return ctx.statePath ? dirname(ctx.statePath) : join(ctx.appDir, ".gorilator");
}
const stateFile = (ctx: RuntimeContext): string => join(stateDir(ctx), "dev-tunnel.json");
const serverLog = (ctx: RuntimeContext): string => join(stateDir(ctx), "dev-tunnel-server.log");
const clientLog = (ctx: RuntimeContext): string => join(stateDir(ctx), "dev-tunnel-client.log");

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawn a detached `cloudflared tunnel --url` for a local port, logging to a
 *  file we later poll for the trycloudflare URL. Returns its pid. */
function spawnTunnel(port: number, logPath: string): number {
  const cf = which("cloudflared") ?? "cloudflared";
  try {
    rmSync(logPath, { force: true });
  } catch {
    /* ignore */
  }
  const fd = openSync(logPath, "a");
  const child = spawn(cf, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  if (!child.pid) throw new Error("could not start cloudflared");
  return child.pid;
}

async function awaitUrl(logPath: string, timeoutMs = 20_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let text = "";
    try {
      text = readFileSync(logPath, "utf8");
    } catch {
      /* not written yet */
    }
    const url = extractQuickTunnelUrl(text);
    if (url) return url;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function readDevTunnelState(ctx: RuntimeContext): DevTunnelState | null {
  const f = stateFile(ctx);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, "utf8")) as Partial<DevTunnelState>;
    if (typeof raw.serverPid !== "number" || typeof raw.clientPid !== "number") return null;
    return raw as DevTunnelState;
  } catch {
    return null;
  }
}

/** Whether at least one tracked tunnel process is still alive. */
export function devTunnelRunning(ctx: RuntimeContext): boolean {
  const s = readDevTunnelState(ctx);
  return !!s && (isPidRunning(s.serverPid) || isPidRunning(s.clientPid));
}

/** Start both quick tunnels (server first, so its URL can be baked into the
 *  client), persist the state file, and return the captured URLs. */
export async function startDevTunnels(
  ctx: RuntimeContext,
  serverPort: number,
  clientPort: number,
): Promise<DevTunnelState> {
  ensureCloudflared();
  mkdirSync(stateDir(ctx), { recursive: true });

  const serverPid = spawnTunnel(serverPort, serverLog(ctx));
  const serverUrl = (await awaitUrl(serverLog(ctx))) ?? "";
  const clientPid = spawnTunnel(clientPort, clientLog(ctx));
  const clientUrl = (await awaitUrl(clientLog(ctx))) ?? "";

  const state: DevTunnelState = {
    serverPid,
    clientPid,
    serverUrl,
    clientUrl,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(stateFile(ctx), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  return state;
}

/** Kill both tracked tunnels and remove the state file. Returns whether any
 *  state existed. */
export function stopDevTunnels(ctx: RuntimeContext): boolean {
  const state = readDevTunnelState(ctx);
  if (!state) return false;
  for (const pid of [state.serverPid, state.clientPid]) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(stateFile(ctx), { force: true });
  } catch {
    /* ignore */
  }
  return true;
}
