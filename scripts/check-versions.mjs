// CI guard: when any workspace package's version changes (vs the branch's fork
// point), the umbrella "app" (root package.json) version must change by AT LEAST
// the same semver level. Run with `pnpm bump <package> <level>` to keep them in
// sync. Used by .github/workflows/version-guard.yml; also runnable locally:
//   node scripts/check-versions.mjs            # compares against origin/main
//   BASE_REF=origin/dev node scripts/check-versions.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = {
  cli: "packages/cli/package.json",
  client: "packages/client/package.json",
  server: "packages/server/package.json",
  shared: "packages/shared/package.json",
  landing: "packages/landing/package.json",
};
const APP = "package.json";
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

const baseRef = process.env.BASE_REF || process.argv[2] || "origin/main";

/** The fork point with the base branch, so we only judge THIS branch's changes. */
function forkPoint() {
  try {
    return execFileSync("git", ["merge-base", "HEAD", baseRef], { encoding: "utf8" }).trim();
  } catch {
    return baseRef; // fall back to the ref directly
  }
}
const base = forkPoint();

function currentVersion(rel) {
  try {
    return JSON.parse(readFileSync(resolve(root, rel), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function baseVersion(rel) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${base}:${rel}`], { encoding: "utf8" })).version ?? null;
  } catch {
    return null; // not present at the fork point → newly added
  }
}

// Official SemVer 2.0.0 grammar (semver.org).
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parse(version) {
  const m = version == null ? null : SEMVER_RE.exec(String(version).trim());
  if (!m) throw new Error(`not a valid SemVer version: "${version}"`);
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ?? null };
}

/** The SemVer release level by which `oldV` → `newV` changed (vs the fork point).
 *  A prerelease-only change counts as "patch" so it still requires an app bump. */
function levelOf(oldV, newV) {
  if (oldV === newV) return "none";
  if (!oldV) return "minor"; // newly added package → treat as a feature
  const a = parse(oldV);
  const b = parse(newV);
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  if (a.patch !== b.patch) return "patch";
  return a.prerelease !== b.prerelease ? "patch" : "none";
}

const changed = [];
let required = "none";
for (const [name, rel] of Object.entries(PACKAGES)) {
  const level = levelOf(baseVersion(rel), currentVersion(rel));
  if (level !== "none") {
    changed.push({ name, from: baseVersion(rel), to: currentVersion(rel), level });
    if (RANK[level] > RANK[required]) required = level;
  }
}

const appLevel = levelOf(baseVersion(APP), currentVersion(APP));

console.log(`Comparing against ${baseRef} (fork point ${base.slice(0, 12)})`);
if (changed.length === 0) {
  console.log("No package version changes — nothing to enforce.");
  process.exit(0);
}
for (const c of changed) console.log(`  ${c.name}: ${c.from} → ${c.to} (${c.level})`);
console.log(`  app: ${baseVersion(APP)} → ${currentVersion(APP)} (${appLevel})`);
console.log(`  required app bump: ≥ ${required}`);

if (RANK[appLevel] < RANK[required]) {
  console.error(
    `\n✗ The app (root) version must bump by at least "${required}" to match the package change(s).\n` +
      `  Run:  pnpm bump <package> ${required}   (bumps the package AND the app together)\n` +
      `  Or:   pnpm bump app ${required}         (umbrella catch-up only)`,
  );
  process.exit(1);
}

const appVersion = currentVersion(APP);
const cliVersion = currentVersion(PACKAGES.cli);
if (cliVersion !== appVersion) {
  console.error(
    `\n✗ The npm CLI package version must match the app release version.\n` +
      `  app: ${appVersion}\n` +
      `  cli: ${cliVersion}\n` +
      `  Release tags and npm publishes should use the same SemVer version.`,
  );
  process.exit(1);
}

console.log("\n✓ App version is in sync with the package bumps.");
