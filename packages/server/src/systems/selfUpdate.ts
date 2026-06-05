// Admin-triggered self-update. When an admin hits POST /api/admin/update, the
// server launches `gorilator update` as a DETACHED process so it survives the
// daemon being stopped mid-update (the updater stops the service, fast-forwards
// the git ref, rebuilds, and starts the service again).
//
// This only works when the server was launched by the CLI's `gorilator serve`
// (a real install) — that command sets GORILATOR_MANAGED=1 and GORILATOR_BIN to
// the CLI entrypoint. In dev / Docker / Railway those are unset and we refuse.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

export interface UpdateStartResult {
  ok: boolean;
  /** Why it could not start, when ok is false. */
  reason?: string;
}

let started = false; // one-shot guard: an update is already running this lifetime

/** Whether this process can self-update (launched by `gorilator serve`). */
export function canSelfUpdate(): boolean {
  return process.env.GORILATOR_MANAGED === "1" && Boolean(process.env.GORILATOR_BIN);
}

/**
 * Launch `gorilator update` detached. Returns immediately — the daemon will be
 * stopped and restarted by the updater. Idempotent: a second call while one is
 * in flight is a no-op success.
 */
export function startSelfUpdate(): UpdateStartResult {
  if (!canSelfUpdate()) {
    return { ok: false, reason: "not a CLI-managed install (run `gorilator update` manually)" };
  }
  if (started) return { ok: true };

  const bin = process.env.GORILATOR_BIN as string;
  // Log the detached updater somewhere inspectable rather than to our own
  // (about-to-die) stdio. Falls back to ignoring output if the path is unwritable.
  let out: number | "ignore" = "ignore";
  const logPath = process.env.GORILATOR_UPDATE_LOG;
  if (logPath) {
    try {
      out = openSync(logPath, "a");
    } catch {
      out = "ignore";
    }
  }

  try {
    const child = spawn(process.execPath, [bin, "update"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.unref();
    started = true;
    console.log(`[admin] self-update launched (pid ${child.pid ?? "?"})`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "failed to spawn updater" };
  }
}
