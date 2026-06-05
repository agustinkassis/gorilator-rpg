// Bump a workspace package's version AND the umbrella "app" (root package.json)
// version by the same semver level, in one step. Each package keeps its own
// independent version; the app version is the project-wide roll-up that advances
// whenever any package does — a `patch` package bump bumps the app patch, a
// `minor` bumps the app minor, a `major` bumps the app major.
//
// Usage:
//   node scripts/bump.mjs <package> <major|minor|patch>
//     <package> ∈ cli | client | server | shared | landing
//   node scripts/bump.mjs app <major|minor|patch>   # bump only the app (catch-up)
//
// Examples:
//   node scripts/bump.mjs cli minor     # cli 1.4.0→1.5.0  AND  app 0.3.0→0.4.0
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
  landing: "packages/landing/package.json",
};
const APP = "package.json";
const LEVELS = ["major", "minor", "patch"];

function nextVersion(version, level) {
  const [maj, min, pat] = version.split("-")[0].split(".").map(Number);
  if ([maj, min, pat].some((n) => !Number.isInteger(n))) {
    throw new Error(`unparseable version "${version}"`);
  }
  if (level === "major") return `${maj + 1}.0.0`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
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
