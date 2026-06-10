// gorilator plugin — manage the checkout's plugin system from the CLI.
//
//   gorilator plugin list             discovered plugins + enabled state
//   gorilator plugin enable <name>    remove <name> from realm.json plugins.disabled
//   gorilator plugin disable <name>   add <name> to realm.json plugins.disabled
//   gorilator plugin add <path|npub>  vendor a local plugin dir into plugins/, or
//                                     trust a Nostr realm-pack author (.env REALM_PACK_AUTHORS)
//
// Mirrors the server's discovery rules (packages/server/src/systems/plugins/
// discovery.ts): plugins/<dir>/plugin.json plus node_modules/gorilator-plugin-*,
// names starting with "_" are templates, and realm.json's plugins.disabled list
// turns plugins off by name without deleting them. The CLI ships standalone, so
// the manifest shape is re-declared here instead of importing @rpg/shared.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { RuntimeContext } from "../lib/context.js";
import * as log from "../lib/log.js";
import { isValidNpub, npubToHex } from "../lib/npub.js";

/** The subset of @rpg/shared's PluginManifest the CLI cares about. */
interface PluginManifest {
  name: string;
  version?: string;
  apiVersion: string;
  capabilities?: string[];
  enabled?: boolean;
}

interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  source: "plugins" | "npm";
}

export interface PluginFlags {
  /** `add <path>` only: symlink the directory into plugins/ instead of copying. */
  link?: boolean;
}

export function pluginCmd(ctx: RuntimeContext, args: string[], flags: PluginFlags): void {
  const root = ctx.appDir;
  if (!existsSync(root)) {
    log.die(`No Gorilator checkout at ${root}. Run inside a repo or 'gorilator install' first.`);
  }
  const [sub, arg] = args;
  switch (sub) {
    case undefined:
    case "list":
      listPlugins(root);
      return;
    case "enable":
      enablePlugin(root, requireArg(sub, arg, "<name>"));
      return;
    case "disable":
      disablePlugin(root, requireArg(sub, arg, "<name>"));
      return;
    case "add":
      addPlugin(root, requireArg(sub, arg, "<path|npub>"), flags);
      return;
    default:
      log.die(`Unknown plugin subcommand: ${sub}. Try list | enable | disable | add.`);
  }
}

function requireArg(sub: string, arg: string | undefined, placeholder: string): string {
  if (!arg) log.die(`Usage: gorilator plugin ${sub} ${placeholder}`);
  return arg;
}

// ---- discovery (read-only mirror of the server's rules) ----

function readManifest(dir: string): PluginManifest | null {
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as PluginManifest;
    if (!raw?.name || !raw?.apiVersion) {
      log.warn(`${file}: manifest needs "name" and "apiVersion" — skipped`);
      return null;
    }
    return raw;
  } catch {
    log.warn(`${file}: invalid JSON — skipped`);
    return null;
  }
}

function discoverPlugins(root: string): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];
  const seen = new Set<string>();

  const consider = (dir: string, source: "plugins" | "npm") => {
    const manifest = readManifest(dir);
    if (!manifest || seen.has(manifest.name)) return;
    if (manifest.name.startsWith("_")) return; // _template and friends
    seen.add(manifest.name);
    found.push({ manifest, dir, source });
  };

  const pluginRoot = join(root, "plugins");
  if (existsSync(pluginRoot)) {
    for (const entry of readdirSync(pluginRoot, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) consider(join(pluginRoot, entry.name), "plugins");
    }
  }

  const nm = join(root, "node_modules");
  if (existsSync(nm)) {
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith("gorilator-plugin-")) consider(join(nm, entry), "npm");
    }
  }

  return found;
}

// ---- realm.json (repo-root per-realm config; plugins.disabled lives there) ----

type RealmConfig = { plugins?: { disabled?: unknown } } & Record<string, unknown>;

function realmPath(root: string): string {
  return join(root, "realm.json");
}

function readRealm(root: string): RealmConfig {
  const file = realmPath(root);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return log.die(`${file} is not valid JSON — fix it before editing plugins.disabled.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return log.die(`${file} must contain a JSON object.`);
  }
  return parsed as RealmConfig;
}

function disabledList(realm: RealmConfig): string[] {
  const disabled = realm.plugins?.disabled;
  return Array.isArray(disabled) ? disabled.map(String) : [];
}

/** Persist a new plugins.disabled list, preserving every other realm.json key. */
function writeDisabled(root: string, realm: RealmConfig, disabled: string[]): void {
  realm.plugins = { ...(realm.plugins ?? {}), disabled };
  writeFileSync(realmPath(root), `${JSON.stringify(realm, null, 2)}\n`);
}

// ---- subcommands ----

function listPlugins(root: string): void {
  const realmDisabled = new Set(disabledList(readRealm(root)));
  const plugins = discoverPlugins(root);
  if (plugins.length === 0) {
    log.info("No plugins found.");
    process.stdout.write(
      log.dim(
        `  Drop one into ${join(root, "plugins")}/<name>/plugin.json, install a\n` +
          "  gorilator-plugin-* npm package, or start from plugins/_template — see docs/plugins.md.\n",
      ),
    );
    return;
  }

  const rows = plugins.map(({ manifest, source }) => {
    const reason = realmDisabled.has(manifest.name)
      ? "realm.json"
      : manifest.enabled === false
        ? "plugin.json"
        : null;
    return {
      name: manifest.name,
      version: manifest.version ? `v${manifest.version}` : "-",
      status: reason ? `disabled (${reason})` : "enabled",
      enabled: !reason,
      source: source === "npm" ? "npm" : "plugins/",
      caps: manifest.capabilities?.length ? manifest.capabilities.join(", ") : "-",
    };
  });

  // Pad before colorizing — escape codes would skew the column widths.
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const verW = Math.max(...rows.map((r) => r.version.length));
  const statusW = Math.max(...rows.map((r) => r.status.length));
  process.stdout.write(`Plugins (${rows.length})\n\n`);
  for (const r of rows) {
    const status = (r.enabled ? log.green : log.yellow)(r.status.padEnd(statusW));
    process.stdout.write(
      `  ${log.bold(r.name.padEnd(nameW))}  ${r.version.padEnd(verW)}  ${status}  ` +
        `${log.dim(r.source.padEnd(8))}  ${log.dim(r.caps)}\n`,
    );
  }
}

function enablePlugin(root: string, name: string): void {
  const realm = readRealm(root);
  const disabled = disabledList(realm);
  const plugin = discoverPlugins(root).find((p) => p.manifest.name === name);

  if (!disabled.includes(name)) {
    if (plugin?.manifest.enabled === false) {
      log.warn(
        `${name} is disabled by its own manifest ("enabled": false) — edit ${join(plugin.dir, "plugin.json")}.`,
      );
    } else {
      log.ok(`${name} is already enabled.`);
    }
    return;
  }

  writeDisabled(root, realm, disabled.filter((n) => n !== name));
  log.ok(`Enabled ${name} (removed from realm.json plugins.disabled).`);
  if (!plugin) log.warn(`${name} is not currently in plugins/ or node_modules — nothing will load.`);
  if (plugin?.manifest.enabled === false) {
    log.warn(`${name} still sets "enabled": false in its plugin.json — edit it to fully enable.`);
  }
  log.info("Restart the server to apply.");
}

function disablePlugin(root: string, name: string): void {
  const realm = readRealm(root);
  const disabled = disabledList(realm);
  if (disabled.includes(name)) {
    log.ok(`${name} is already disabled.`);
    return;
  }
  if (!discoverPlugins(root).some((p) => p.manifest.name === name)) {
    log.warn(`${name} is not currently in plugins/ or node_modules — disabling the name anyway.`);
  }
  writeDisabled(root, realm, [...disabled, name]);
  log.ok(`Disabled ${name} (added to realm.json plugins.disabled).`);
  log.info("Restart the server to apply.");
}

function addPlugin(root: string, target: string, flags: PluginFlags): void {
  if (isValidNpub(target)) {
    addPackAuthor(root, target);
    return;
  }
  addLocalPlugin(root, target, flags);
}

/** Vendor a local plugin directory into plugins/<manifest.name> (copy, or
 *  symlink with --link so an out-of-tree plugin keeps its own dev loop). */
function addLocalPlugin(root: string, path: string, flags: PluginFlags): void {
  const src = resolve(path);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    log.die(`${path} is neither a plugin directory nor a valid npub1… key.`);
  }
  const manifest = readManifest(src);
  if (!manifest) {
    log.die(`${src} has no valid plugin.json ("name" + "apiVersion") — see docs/plugins.md.`);
  }

  const pluginsDir = join(root, "plugins");
  const dest = join(pluginsDir, manifest.name);
  if (existsSync(dest)) log.die(`${dest} already exists — remove it first.`);
  mkdirSync(pluginsDir, { recursive: true });

  if (flags.link) {
    symlinkSync(src, dest, "dir");
    log.ok(`Linked ${manifest.name} → ${src}`);
  } else {
    cpSync(src, dest, {
      recursive: true,
      filter: (p) => !["node_modules", ".git"].includes(basename(p)),
    });
    log.ok(`Copied ${manifest.name} into ${dest}`);
  }
  log.info("Restart the server to load it (run pnpm build:plugins first if it only ships src/).");
}

/** Trust a Nostr realm-pack author: upsert the npub into REALM_PACK_AUTHORS in
 *  the repo-root .env (kind-30333 packs — pure JSON data plugins consumed by
 *  packages/server/src/systems/plugins/nostrContent.ts). The edit is surgical —
 *  one line touched — so hand-written .env comments survive. */
function addPackAuthor(root: string, npub: string): void {
  const hex = npubToHex(npub);
  if (!hex) log.die(`${npub} is not a valid npub.`);

  const envPath = join(root, ".env");
  const lines = (existsSync(envPath) ? readFileSync(envPath, "utf8") : "").split("\n");
  const idx = lines.findIndex((l) => /^\s*REALM_PACK_AUTHORS\s*=/.test(l));

  let rawValue = idx === -1 ? "" : lines[idx].slice(lines[idx].indexOf("=") + 1).trim();
  if (/^(['"]).*\1$/.test(rawValue)) rawValue = rawValue.slice(1, -1);
  const authors = rawValue.split(",").map((s) => s.trim()).filter(Boolean);

  // The server accepts npub or hex entries — dedupe on the decoded key.
  if (authors.some((a) => a.toLowerCase() === hex || npubToHex(a) === hex)) {
    log.ok(`${npub.slice(0, 14)}…${npub.slice(-6)} is already a trusted realm-pack author.`);
    return;
  }

  const value = [...authors, npub].join(",");
  if (idx >= 0) {
    lines[idx] = `REALM_PACK_AUTHORS=${value}`;
  } else {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(
      "# Nostr realm packs (kind-30333 data plugins): JSON content events published by",
      "# these trusted authors are loaded live — validated, never executed. Optional",
      "# relay override: REALM_PACK_RELAYS=wss://… — see docs/plugins.md.",
      `REALM_PACK_AUTHORS=${value}`,
      "",
    );
  }
  writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
  log.ok(`Added ${npub.slice(0, 14)}…${npub.slice(-6)} to REALM_PACK_AUTHORS in ${envPath}`);
  log.info("Restart the server to start syncing this author's packs.");
}
