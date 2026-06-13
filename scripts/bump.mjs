// Bump a workspace package's version AND the umbrella "app" (root package.json)
// version by the same semver level, in one step. The app version is the release
// version. The CLI is one package in that umbrella: bumping it also advances the
// app, but non-CLI app releases do not require the CLI package version to match.
//
// Usage:
//   node scripts/bump.mjs <package> <major|minor|patch>
//     <package> ∈ cli | client | server | shared
//   node scripts/bump.mjs app <major|minor|patch>   # bump the app release
//
// Examples:
//   node scripts/bump.mjs cli minor     # cli 1.4.0→1.5.0  AND  app 1.4.0→1.5.0
//   node scripts/bump.mjs server patch  # server 0.2.1→0.2.2 AND app 0.4.0→0.4.1
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Bumpable packages (label → package.json path). The app is the root. */
const PACKAGES = {
  cli: "packages/cli/package.json",
  client: "packages/client/package.json",
  server: "packages/server/package.json",
  shared: "packages/shared/package.json",
};
const APP = "package.json";
const LEVELS = ["major", "minor", "patch"];

// Official SemVer 2.0.0 grammar (semver.org). Captures major/minor/patch +
// optional prerelease + build metadata, and forbids leading zeros.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parse(version) {
  const m = SEMVER_RE.exec(String(version).trim());
  if (!m) throw new Error(`not a valid SemVer version: "${version}"`);
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ?? null };
}

/** SemVer increment matching npm's `semver.inc` for the major/minor/patch release
 *  types — including finalizing a prerelease (e.g. 1.4.0-rc.1 + patch → 1.4.0).
 *  Build metadata is dropped (it has no precedence). */
function nextVersion(version, level) {
  const { major, minor, patch, prerelease } = parse(version);
  if (level === "major") {
    return prerelease && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
  }
  if (level === "minor") {
    return prerelease && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
  }
  return prerelease ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
}

/** Rewrite only the top-level "version" value so all other formatting is kept. */
function applyBump(rel, level) {
  const path = resolve(root, rel);
  const text = readFileSync(path, "utf8");
  const cur = JSON.parse(text).version;
  const next = nextVersion(cur, level);
  const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  if (updated === text) throw new Error(`no "version" field found in ${rel}`);
  writeFileSync(path, updated);
  return { cur, next };
}

const [target, level] = process.argv.slice(2);
if (!level || !LEVELS.includes(level) || (target !== "app" && !PACKAGES[target])) {
  console.error(
    `usage: node scripts/bump.mjs <${Object.keys(PACKAGES).join("|")}|app> <major|minor|patch>`,
  );
  process.exit(1);
}

try {
  if (target === "app") {
    const a = applyBump(APP, level);
    console.log(`app     ${a.cur} → ${a.next}`);
  } else {
    const pkg = applyBump(PACKAGES[target], level);
    const app = applyBump(APP, level);
    console.log(`${target.padEnd(7)} ${pkg.cur} → ${pkg.next}`);
    console.log(`${"app".padEnd(7)} ${app.cur} → ${app.next}  (umbrella ${level} bump)`);
  }
} catch (err) {
  console.error(`bump failed: ${err.message}`);
  process.exit(1);
}
