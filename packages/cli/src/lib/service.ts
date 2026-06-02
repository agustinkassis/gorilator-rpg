// Platform-agnostic service facade. Delegates to the systemd (Linux) or launchd
// (macOS) backend. Shared types live here so the backends can `import type` them
// without a runtime cycle.
import * as log from "./log.js";
import { isLinux, isMac } from "./paths.js";
import * as launchd from "./service.launchd.js";
import * as systemd from "./service.systemd.js";

export interface ServiceExec {
  node: string;
  cliEntry: string;
}

export interface ServiceStatus {
  active: boolean;
  raw: string;
}

export interface ServiceBackend {
  install(appDir: string, user: string, exec: ServiceExec): void;
  start(): void;
  stop(): void;
  restart(): void;
  status(): ServiceStatus;
  logs(appDir: string): void;
  uninstall(): void;
}

export function manager(): string {
  if (isLinux) return "systemd";
  if (isMac) return "launchd";
  return "none";
}

function backend(): ServiceBackend {
  if (isLinux) return systemd;
  if (isMac) return launchd;
  return log.die(
    "Unsupported platform — only Linux (systemd) and macOS (launchd) are supported.",
  );
}

export const installService = (appDir: string, user: string, exec: ServiceExec): void =>
  backend().install(appDir, user, exec);
export const startService = (): void => backend().start();
export const stopService = (): void => backend().stop();
export const restartService = (): void => backend().restart();
export const statusService = (): ServiceStatus => backend().status();
export const logsService = (appDir: string): void => backend().logs(appDir);
export const uninstallService = (): void => backend().uninstall();
