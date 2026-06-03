// systemd backend (Linux). Installs a system unit that runs `gorilator serve`
// as the install user and restarts on failure. Privileged steps use sudo.
import { spawnSync } from "node:child_process";
import * as log from "./log.js";
import { SYSTEMD_UNIT, SYSTEMD_UNIT_PATH } from "./paths.js";
import {
  isRoot,
  printCommandOutput,
  runPrivileged,
  streamCommandOutput,
  tryPrivileged,
  tryRun,
  writeFileMaybeSudo,
} from "./proc.js";
import type { ServiceExec, ServiceLogOptions, ServiceStatus } from "./service.js";

function renderUnit(appDir: string, user: string, exec: ServiceExec): string {
  return `[Unit]
Description=Gorilator RPG (native Node game server)
Documentation=https://github.com/agustinkassis/gorilator-rpg
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${appDir}
ExecStart=${exec.node} ${exec.cliEntry} serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
}

export function install(appDir: string, user: string, exec: ServiceExec): void {
  log.info(`Writing ${SYSTEMD_UNIT_PATH}…`);
  writeFileMaybeSudo(SYSTEMD_UNIT_PATH, renderUnit(appDir, user, exec), 0o644);
  runPrivileged("systemctl", ["daemon-reload"]);
  runPrivileged("systemctl", ["enable", SYSTEMD_UNIT]);
  log.ok("systemd service installed and enabled (starts on boot).");
}

export function start(): void {
  runPrivileged("systemctl", ["start", SYSTEMD_UNIT]);
}

export function stop(): void {
  runPrivileged("systemctl", ["stop", SYSTEMD_UNIT]);
}

export function restart(): void {
  runPrivileged("systemctl", ["restart", SYSTEMD_UNIT]);
}

export function status(): ServiceStatus {
  const active = tryRun("systemctl", ["is-active", "--quiet", SYSTEMD_UNIT]);
  const r = spawnSync("systemctl", ["status", SYSTEMD_UNIT, "--no-pager", "-n", "10"], {
    encoding: "utf8",
  });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { active, raw };
}

export function logs(_appDir: string, opts: ServiceLogOptions): void {
  const args = ["-u", SYSTEMD_UNIT, "--no-pager", "-n", String(opts.lines)];
  if (opts.since) args.push("--since", opts.since);
  if (opts.follow) args.push("-f");
  const cmd = isRoot() ? "journalctl" : "sudo";
  const finalArgs = isRoot() ? args : ["journalctl", ...args];
  if (opts.follow) streamCommandOutput(cmd, finalArgs, { filter: opts.filter });
  else printCommandOutput(cmd, finalArgs, { filter: opts.filter });
}

export function uninstall(): void {
  tryPrivileged("systemctl", ["stop", SYSTEMD_UNIT]);
  tryPrivileged("systemctl", ["disable", SYSTEMD_UNIT]);
  tryPrivileged("rm", ["-f", SYSTEMD_UNIT_PATH]);
  tryPrivileged("systemctl", ["daemon-reload"]);
  log.ok("systemd service removed.");
}
