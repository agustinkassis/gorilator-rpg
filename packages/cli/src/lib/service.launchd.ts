// launchd backend (macOS). Installs a per-user LaunchAgent (no sudo) that runs
// `gorilator serve`, restarts on exit (KeepAlive), and logs to a file the
// `logs` command tails. Uses the classic load/unload/start/stop verbs, which
// remain functional across macOS releases.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as log from "./log.js";
import { LAUNCHD_LABEL, launchdPlistPath, logFile } from "./paths.js";
import { capture, tryRun, writeFileMaybeSudo } from "./proc.js";
import type { ServiceExec, ServiceStatus } from "./service.js";

function renderPlist(appDir: string, exec: ServiceExec): string {
  const out = logFile(appDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exec.node}</string>
    <string>${exec.cliEntry}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${appDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart only on failure (mirrors systemd Restart=on-failure). With a plain
       <true/> here, 'gorilator stop' would be undone by an immediate relaunch:
       'serve' exits 0 on SIGTERM, so SuccessfulExit=false keeps a clean stop stopped. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${out}</string>
  <key>StandardErrorPath</key>
  <string>${out}</string>
</dict>
</plist>
`;
}

export function install(appDir: string, _user: string, exec: ServiceExec): void {
  const plist = launchdPlistPath();
  mkdirSync(dirname(plist), { recursive: true });
  log.info(`Writing ${plist}…`);
  writeFileMaybeSudo(plist, renderPlist(appDir, exec), 0o644);
  // Reload so the new definition takes effect; load -w enables + RunAtLoad starts it.
  tryRun("launchctl", ["unload", "-w", plist]);
  tryRun("launchctl", ["load", "-w", plist]);
  log.ok("launchd agent installed and enabled (starts at login).");
}

function ensureLoaded(): void {
  if (!capture("launchctl", ["list", LAUNCHD_LABEL])) {
    tryRun("launchctl", ["load", "-w", launchdPlistPath()]);
  }
}

export function start(): void {
  ensureLoaded();
  tryRun("launchctl", ["start", LAUNCHD_LABEL]);
}

export function stop(): void {
  tryRun("launchctl", ["stop", LAUNCHD_LABEL]);
}

export function restart(): void {
  stop();
  start();
}

export function status(): ServiceStatus {
  const raw = capture("launchctl", ["list", LAUNCHD_LABEL]);
  const active = !!raw && /"PID"\s*=\s*\d+/.test(raw);
  return { active, raw: raw ?? `${LAUNCHD_LABEL}: not loaded` };
}

export function logs(appDir: string): void {
  spawnSync("tail", ["-n", "100", "-f", logFile(appDir)], { stdio: "inherit" });
}

export function uninstall(): void {
  tryRun("launchctl", ["unload", "-w", launchdPlistPath()]);
  tryRun("rm", ["-f", launchdPlistPath()]);
  log.ok("launchd agent removed.");
}
