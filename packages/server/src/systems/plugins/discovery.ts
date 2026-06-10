import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLUGIN_API_VERSION, type PluginManifest } from "@rpg/shared";

/** A discovered, validated plugin: its manifest + the dir paths resolve against. */
export interface DiscoveredPlugin {
  dir: string;
  manifest: PluginManifest;
}

/** Candidate plugin roots — same multi-cwd resolution as the content loaders
 *  (props.ts): the server runs from the repo root (scripts) or packages/server
 *  (pnpm --filter). npm-installed plugins are found by the gorilator-plugin-*
 *  naming convention in node_modules. */
const PLUGIN_DIR_CANDIDATES = [
  resolve(process.cwd(), "plugins"),
  resolve(process.cwd(), "../../plugins"),
];
const NODE_MODULES_CANDIDATES = [
  resolve(process.cwd(), "node_modules"),
  resolve(process.cwd(), "../../node_modules"),
];

/** realm.json (repo root) — the per-realm/fork config. `plugins.disabled` turns a
 *  discovered plugin off without deleting it. */
function disabledList(): Set<string> {
  for (const candidate of [resolve(process.cwd(), "realm.json"), resolve(process.cwd(), "../../realm.json")]) {
    try {
      if (!existsSync(candidate)) continue;
      const realm = JSON.parse(readFileSync(candidate, "utf8"));
      const disabled = realm?.plugins?.disabled;
      if (Array.isArray(disabled)) return new Set(disabled.map(String));
    } catch (err) {
      console.warn("[plugins] failed to read realm.json", err);
    }
  }
  return new Set();
}

/** Major-version compatibility: the manifest's apiVersion range must target the
 *  current PLUGIN_API_VERSION major (e.g. "^1.0.0", "1.x", ">=1.2" all pass for
 *  major 1). Deliberately minimal — no semver dependency. */
export function apiVersionCompatible(range: string): boolean {
  const hostMajor = Number(PLUGIN_API_VERSION.split(".")[0]);
  const match = String(range ?? "").match(/(\d+)/);
  if (!match) return false;
  return Number(match[1]) === hostMajor;
}

function readManifest(dir: string): PluginManifest | null {
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw?.name || !raw?.apiVersion) {
      console.warn(`[plugins] ${file}: manifest needs "name" and "apiVersion" — skipped`);
      return null;
    }
    return raw as PluginManifest;
  } catch (err) {
    console.warn(`[plugins] failed to parse ${file} — skipped`, err);
    return null;
  }
}

/** Find every enabled, version-compatible plugin (plugins/ dir + npm packages). */
export function discoverPlugins(): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];
  const seen = new Set<string>();
  const disabled = disabledList();

  const consider = (dir: string) => {
    const manifest = readManifest(dir);
    if (!manifest || seen.has(manifest.name)) return;
    if (manifest.name.startsWith("_")) return; // _template and friends
    seen.add(manifest.name);
    if (manifest.enabled === false || disabled.has(manifest.name)) {
      console.log(`[plugins] ${manifest.name} disabled — skipped`);
      return;
    }
    if (!apiVersionCompatible(manifest.apiVersion)) {
      console.warn(
        `[plugins] ${manifest.name} targets api ${manifest.apiVersion}, host is ${PLUGIN_API_VERSION} — skipped`,
      );
      return;
    }
    found.push({ dir, manifest });
  };

  const pluginRoot = PLUGIN_DIR_CANDIDATES.find((p) => existsSync(p));
  if (pluginRoot) {
    for (const entry of readdirSync(pluginRoot, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) consider(join(pluginRoot, entry.name));
    }
  }

  for (const nm of NODE_MODULES_CANDIDATES) {
    if (!existsSync(nm)) continue;
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith("gorilator-plugin-")) consider(join(nm, entry));
    }
    break; // first existing node_modules wins (pnpm symlinks resolve through it)
  }

  return found;
}
