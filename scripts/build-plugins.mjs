#!/usr/bin/env node
/**
 * build-plugins — compile every plugins/<name>/ entry with esbuild.
 *
 *   pnpm build:plugins           # build all plugins
 *   pnpm build:plugins --watch   # rebuild on change (plugin dev loop)
 *
 * - src/server.ts → dist/server.js  (node ESM; @rpg/shared stays EXTERNAL — the
 *   server resolves it through the workspace, so plugin and host share one
 *   schema identity)
 * - src/client.ts → dist/client.js  (browser ESM, fully bundled — the file is
 *   dynamic-imported by the page, so bare specifiers can't resolve there.
 *   Client entries should import only TYPES from @rpg/shared.)
 *
 * Runs against the manifest's declared entries when present, else the src/
 * conventions above. Skips dirs without plugin.json and the _template.
 */
import { build, context } from "esbuild";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsDir = join(root, "plugins");
const watch = process.argv.includes("--watch");

if (!existsSync(pluginsDir)) {
  console.log("[build-plugins] no plugins/ directory — nothing to do");
  process.exit(0);
}

const jobs = [];
for (const name of readdirSync(pluginsDir)) {
  if (name.startsWith("_") || name.startsWith(".")) continue;
  const dir = join(pluginsDir, name);
  const manifestFile = join(dir, "plugin.json");
  if (!existsSync(manifestFile)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (err) {
    console.warn(`[build-plugins] ${name}: bad plugin.json — skipped (${err.message})`);
    continue;
  }

  const serverEntry = join(dir, "src/server.ts");
  if (existsSync(serverEntry)) {
    jobs.push({
      label: `${name}/server`,
      options: {
        entryPoints: [serverEntry],
        outfile: join(dir, "dist/server.js"),
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        sourcemap: true,
        external: ["@rpg/shared"],
      },
    });
  }
  const clientEntry = join(dir, "src/client.ts");
  if (existsSync(clientEntry)) {
    jobs.push({
      label: `${name}/client`,
      options: {
        entryPoints: [clientEntry],
        outfile: join(dir, "dist/client.js"),
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2021",
        sourcemap: true,
      },
    });
  }
  if (!existsSync(serverEntry) && !existsSync(clientEntry)) {
    console.log(`[build-plugins] ${manifest.name ?? name}: data-only (no src entries)`);
  }
}

if (!jobs.length) {
  console.log("[build-plugins] no code entries found");
  process.exit(0);
}

if (watch) {
  for (const job of jobs) {
    const ctx = await context(job.options);
    await ctx.watch();
    console.log(`[build-plugins] watching ${job.label}`);
  }
} else {
  for (const job of jobs) {
    await build(job.options);
    console.log(`[build-plugins] built ${job.label}`);
  }
}
