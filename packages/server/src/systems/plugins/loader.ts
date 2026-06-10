import { existsSync, readFileSync, watchFile } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_API_VERSION,
  type PluginManifest,
  type ServerPlugin,
  type ServerPluginContext,
} from "@rpg/shared";
import { discoverPlugins } from "./discovery";
import { serverPluginHost } from "./host";

let loaded = false;

/** Watch + parse a JSON file, applying on load and on every change — the same
 *  live-reload pipeline the builtin manifests use (watchFile, 1.5s). */
function watchJson(path: string, label: string, apply: (data: unknown) => void): void {
  const run = () => {
    try {
      if (!existsSync(path)) return;
      apply(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      console.warn(`[plugins] ${label}: failed to read ${path}`, err);
    }
  };
  run();
  watchFile(path, { interval: 1500 }, run);
}

function contextFor(dir: string, manifest: PluginManifest): ServerPluginContext {
  const tag = `[plugin:${manifest.name}]`;
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest,
    registerBrain: (id, fn) => {
      serverPluginHost.registerBrain(id, fn);
      console.log(`${tag} brain "${id}" registered`);
    },
    registerItem: (id, behavior) => {
      serverPluginHost.registerItem(id, behavior);
      console.log(`${tag} item behavior "${id}" registered`);
    },
    registerSystem: (name, fn, opts) => {
      serverPluginHost.registerSystem(`${manifest.name}:${name}`, fn, opts?.phase ?? "main");
      console.log(`${tag} system "${name}" registered (${opts?.phase ?? "main"})`);
    },
    on: (event, handler) => serverPluginHost.on(event, handler),
    registerContentLoader: (file, apply) => {
      const path = isAbsolute(file) ? file : join(dir, file);
      watchJson(path, manifest.name, apply);
    },
    log: (msg) => console.log(`${tag} ${msg}`),
  };
}

/**
 * Discover and load every enabled server plugin. Idempotent — GameRoom calls it
 * on create, but plugins register into the process-wide host exactly once (a
 * realm restart reuses the same registrations). A plugin that throws during
 * setup is skipped; it can never prevent the room from starting.
 */
export async function loadServerPlugins(): Promise<void> {
  if (loaded) return;
  loaded = true;
  for (const { dir, manifest } of discoverPlugins()) {
    try {
      if (manifest.server) {
        const entry = join(dir, manifest.server);
        if (!existsSync(entry)) {
          console.warn(
            `[plugins] ${manifest.name}: server entry ${manifest.server} not found — run \`pnpm build:plugins\``,
          );
        } else {
          const mod = (await import(pathToFileURL(entry).href)) as { default?: ServerPlugin };
          if (typeof mod.default?.setup !== "function") {
            console.warn(`[plugins] ${manifest.name}: server entry has no default export with setup() — skipped`);
          } else {
            await mod.default.setup(contextFor(dir, manifest));
            console.log(`[plugins] ${manifest.name}@${manifest.version} loaded`);
          }
        }
      } else if (manifest.content?.length) {
        console.log(`[plugins] ${manifest.name}@${manifest.version} loaded (data only)`);
      }
      // Data tier: content files a code entry didn't claim are offered to the
      // generic appliers (currently: additive custom waves).
      for (const rel of manifest.content ?? []) {
        const path = isAbsolute(rel) ? rel : join(dir, rel);
        if (path.endsWith("waves.json")) {
          const { addWaveSource } = await import("../waves");
          addWaveSource(path, manifest.name);
        }
      }
    } catch (err) {
      console.error(`[plugins] ${manifest.name} failed to load — skipped`, err);
    }
  }
}

/** Test hook: allow re-discovery in a fresh test context. */
export function resetPluginLoader(): void {
  loaded = false;
  serverPluginHost.reset();
}
