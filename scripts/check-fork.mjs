#!/usr/bin/env node
/**
 * check-fork — verify the fork rule: customization lives in plugins/, content
 * manifests (packages/client/public/*.json), and realm.json — NEVER in
 * packages/*\/src. A fork that follows the rule can `git merge upstream/main`
 * forever without conflicts.
 *
 *   node scripts/check-fork.mjs                 # warn on core drift vs origin/main
 *   node scripts/check-fork.mjs --strict        # exit 1 on drift (CI for forks)
 *   UPSTREAM_REF=upstream/main node scripts/check-fork.mjs
 *
 * Uses the same merge-base approach as check-versions.mjs.
 */
import { execFileSync } from "node:child_process";

const upstream = process.env.UPSTREAM_REF || "origin/main";
const strict = process.argv.includes("--strict");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let base;
try {
  base = git(["merge-base", "HEAD", upstream]);
} catch {
  console.error(`[check-fork] cannot resolve merge-base with ${upstream} — fetch it first (git fetch ${upstream.split("/")[0]})`);
  process.exit(strict ? 1 : 0);
}

const changed = git(["diff", "--name-only", `${base}..HEAD`])
  .split("\n")
  .filter(Boolean);

const ALLOWED = [
  /^plugins\//,
  /^packages\/client\/public\//,
  /^realm\.json$/,
  /^docs\//,
  /^README/,
  /^\.env\.example$/,
];

const coreDrift = changed.filter(
  (f) => /^packages\/[^/]+\/src\//.test(f) && !ALLOWED.some((re) => re.test(f)),
);

if (!coreDrift.length) {
  console.log(`[check-fork] clean — no core (packages/*/src) changes vs ${upstream} (${changed.length} file(s) changed)`);
  process.exit(0);
}

console.log(`[check-fork] ${coreDrift.length} core file(s) changed vs ${upstream}:`);
for (const f of coreDrift) console.log(`  ${f}`);
console.log(
  "\n  Fork rule: customization belongs in plugins/, packages/client/public/*.json, or realm.json" +
    "\n  so upstream merges stay conflict-free. If this change is meant for upstream, open a PR instead." +
    "\n  Docs: docs/plugins.md",
);
process.exit(strict ? 1 : 0);
