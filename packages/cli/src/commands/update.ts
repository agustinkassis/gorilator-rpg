// `gorilator update` — stop services, fast-forward to the latest release, rebuild,
// and restart, behind a tidy live progress UI: detected version changes up front,
// then an animated step checklist with elapsed/estimate and per-step status.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlan, ensurePnpm } from "../lib/build.js";
import { startTunnelService, stopTunnelService } from "../lib/cloudflare.js";
import { loadConfig } from "../lib/config.js";
import type { RuntimeContext } from "../lib/context.js";
import { generateNsec, isValidNsec, parseEnv, renderEnv } from "../lib/env.js";
import { waitForHealth } from "../lib/health.js";
import * as log from "../lib/log.js";
import type { Options } from "../lib/options.js";
import { envFile } from "../lib/paths.js";
import { updateProjectDev } from "../lib/projectDev.js";
import { captureStep, isRoot, run } from "../lib/proc.js";
import { Stepper, type StepPlan, withSpinner } from "../lib/progress.js";
import { startService, stopService } from "../lib/service.js";
import {
  PACKAGE_VERSION_FILES,
  printPackageVersions,
  printPorts,
  printPublic,
  readEnvInfo,
  readPackageVersions,
} from "../lib/summary.js";

interface VersionChange {
  label: string;
  from?: string;
  to?: string;
}

interface DetectedUpdate {
  changes: VersionChange[];
  localCommit: string | null;
  remoteCommit: string | null;
}

export async function update(ctx?: RuntimeContext, opts?: Options): Promise<void> {
  if (ctx?.kind === "project") {
    if (!opts) log.die("Internal error: project update requires resolved options.");
    await updateProjectDev(ctx, opts);
    return;
  }

  const cfg = loadConfig();
  if (!cfg) log.die("No install record found — run 'gorilator install' first.");
  ensurePnpm();

  // Ensure a stable server identity before restarting (silent unless regenerated).
  const ef = envFile(cfg.appDir);
  const env = existsSync(ef) ? parseEnv(readFileSync(ef, "utf8")) : {};
  if (!isValidNsec(env.NOSTR_NSEC)) {
    const reason = env.NOSTR_NSEC ? "invalid" : "missing";
    env.NOSTR_NSEC = generateNsec();
    writeFileSync(ef, renderEnv(env), { mode: 0o600 });
    if (isRoot() && cfg.user && cfg.user !== "root") run("chown", [cfg.user, ef]);
    log.warn(`Generated ${reason} NOSTR_NSEC in ${ef}`);
  }
  const tunnelConfigured = Boolean(env.SERVER_HOSTNAME || env.CLIENT_HOSTNAME);
  const buildOpts =
    env.VITE_SAME_ORIGIN === "1"
      ? {}
      : env.VITE_SERVER_URL
        ? { serverUrl: env.VITE_SERVER_URL }
        : { serverPort: cfg.port };

  process.stdout.write(
    `\n${log.bold("🦍 Gorilator update")}  ${log.dim(`${cfg.appDir} · ${cfg.ref}`)}\n\n`,
  );

  // 1. Fetch the latest ref and detect what changed (shown before we touch anything).
  let detected: DetectedUpdate;
  try {
    detected = await withSpinner(`Checking ${cfg.repo} (${cfg.ref})`, () => {
      const r = captureStep("git", ["-C", cfg.appDir, "fetch", "--depth", "1", "origin", cfg.ref]);
      if (!r.ok) throw new Error(r.output || "git fetch failed");
      return detectChanges(cfg.appDir);
    });
  } catch (e) {
    log.die(`Could not fetch updates: ${e instanceof Error ? e.message : e}`);
  }
  printDetected(detected);

  // 2. Apply: stop → checkout → build → start → health → tunnel, as a step checklist.
  const plan = buildPlan(cfg.appDir, buildOpts);
  const steps: StepPlan[] = [
    ...(tunnelConfigured ? [{ key: "stop-tunnel", label: "Stop Cloudflare tunnel", estimateMs: 3_000 }] : []),
    { key: "stop", label: "Stop daemon", estimateMs: 3_000 },
    { key: "apply", label: "Apply update (checkout)", estimateMs: 2_000 },
    ...plan.map((p) => ({ key: p.key, label: p.label, estimateMs: p.estimateMs })),
    { key: "start", label: "Start daemon", estimateMs: 4_000 },
    { key: "health", label: "Health check", estimateMs: 8_000 },
    ...(tunnelConfigured ? [{ key: "start-tunnel", label: "Start Cloudflare tunnel", estimateMs: 4_000 }] : []),
  ];

  const ui = new Stepper("Updating", steps);
  ui.start();
  let failOutput = "";
  let healthy = false;
  try {
    if (tunnelConfigured) {
      await ui.run("stop-tunnel", () => {
        if (!stopTunnelService()) ui.note("stop-tunnel", "already stopped");
      });
    }

    await ui.run("stop", () => {
      try {
        stopService();
      } catch {
        ui.note("stop", "was not running");
      }
    });

    await ui.run("apply", () => {
      // Branch-aware checkout (mirrors build.ts cloneOrUpdate): stay on the branch
      // for a branch ref, detach for a tag/commit — instead of always detaching.
      let onBranch = false;
      try {
        onBranch = readFileSync(join(cfg.appDir, ".git", "FETCH_HEAD"), "utf8").includes(
          `\tbranch '${cfg.ref}' of `,
        );
      } catch {
        /* default to detached checkout */
      }
      const args = onBranch
        ? ["-C", cfg.appDir, "checkout", "-B", cfg.ref, "FETCH_HEAD"]
        : ["-C", cfg.appDir, "-c", "advice.detachedHead=false", "checkout", "-f", "FETCH_HEAD"];
      const r = captureStep("git", args);
      if (!r.ok) {
        failOutput = r.output;
        throw new Error("git checkout failed");
      }
    });

    for (const cmd of plan) {
      await ui.run(cmd.key, () => {
        const r = captureStep(cmd.cmd, cmd.args, { cwd: cmd.cwd, env: cmd.env });
        if (!r.ok) {
          if (cmd.optional) {
            ui.note(cmd.key, "non-fatal — skipped");
            return;
          }
          failOutput = r.output;
          throw new Error(`${cmd.label} failed`);
        }
      });
    }

    await ui.run("start", () => {
      try {
        startService();
      } catch (e) {
        failOutput = e instanceof Error ? e.message : String(e);
        throw new Error("could not start the daemon");
      }
    });

    healthy = await ui.run("health", () => waitForHealth(cfg.port));
    if (!healthy) ui.note("health", "no /healthz yet — check 'gorilator logs'");

    if (tunnelConfigured && healthy) {
      await ui.run("start-tunnel", () => {
        if (!startTunnelService()) throw new Error("run 'gorilator tunnel restart'");
      });
    } else if (tunnelConfigured) {
      ui.skip("start-tunnel", "daemon not healthy yet");
    }
  } catch (e) {
    ui.finish();
    if (failOutput) {
      process.stderr.write(`\n${log.dim("— failing command output —")}\n${failOutput}\n`);
    }
    log.die(`Update failed: ${e instanceof Error ? e.message : e}`);
  }
  ui.finish();

  // 3. Success summary.
  process.stdout.write(
    `\n${healthy ? log.green("✓ Update complete.") : log.yellow("Update applied (server still warming up).")}\n`,
  );
  printPackageVersions(cfg.appDir, { heading: true });
  const info = readEnvInfo(cfg.appDir, cfg.port, cfg.clientPort);
  printPorts(info, healthy);
  printPublic(info, { heading: true });
}

/** Read local vs incoming (FETCH_HEAD) package versions and the commits. */
function detectChanges(appDir: string): DetectedUpdate {
  const local = new Map(readPackageVersions(appDir).map((v) => [v.label, v.version]));
  const remote = new Map<string, string>();
  for (const { label, path } of PACKAGE_VERSION_FILES) {
    const raw = git(appDir, ["show", `FETCH_HEAD:${path}`]);
    if (!raw) continue;
    try {
      const pkg = JSON.parse(raw) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.trim()) remote.set(label, pkg.version);
    } catch {
      /* ignore unparseable */
    }
  }
  const changes: VersionChange[] = [];
  for (const { label } of PACKAGE_VERSION_FILES) {
    const from = local.get(label);
    const to = remote.get(label);
    if (to && from !== to) changes.push({ label, from, to });
  }
  return {
    changes,
    localCommit: git(appDir, ["rev-parse", "HEAD"]),
    remoteCommit: git(appDir, ["rev-parse", "FETCH_HEAD"]),
  };
}

function printDetected(d: DetectedUpdate): void {
  const sameCommit = d.localCommit && d.remoteCommit && d.localCommit === d.remoteCommit;
  if (d.changes.length === 0) {
    process.stdout.write(
      `  ${sameCommit ? log.green("Already up to date") : log.dim("No version changes")} ` +
        `${log.dim(`(${short(d.localCommit)} → ${short(d.remoteCommit)})`)}\n\n`,
    );
    return;
  }
  process.stdout.write(
    `  ${log.bold("Detected updates")} ${log.dim(`(${short(d.localCommit)} → ${short(d.remoteCommit)})`)}\n`,
  );
  const width = Math.max(...d.changes.map((c) => c.label.length));
  for (const c of d.changes) {
    process.stdout.write(
      `    ${c.label.padEnd(width)}  ${log.dim(`v${c.from ?? "?"}`)} ${log.blue("→")} ${log.green(`v${c.to ?? "?"}`)}\n`,
    );
  }
  process.stdout.write("\n");
}

function short(commit: string | null): string {
  return commit ? commit.slice(0, 7) : "unknown";
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}
