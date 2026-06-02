// `gorilator uninstall` — stop and remove the service. Keeps the game files.
import { loadConfig } from "../lib/config.js";
import * as log from "../lib/log.js";
import type { Options } from "../lib/options.js";
import { confirm } from "../lib/proc.js";
import { uninstallService } from "../lib/service.js";

export function uninstall(opts: Options): void {
  const cfg = loadConfig();
  if (!confirm("Stop gorilator and remove its service? (your files are kept)", opts.yes)) {
    log.info("Aborted.");
    return;
  }
  uninstallService();
  if (cfg)
    log.ok(`Service removed. Files kept at ${cfg.appDir} — delete them manually if desired.`);
  else log.ok("Service removed.");
}
