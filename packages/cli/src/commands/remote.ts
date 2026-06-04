// `gorilator remote` — read-only update check against the configured git ref
// and, by default, the published npm CLI package.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.js";
import { loadProjectConfig, type RuntimeContext } from "../lib/context.js";
import * as log from "../lib/log.js";
import type { Options } from "../lib/options.js";
import {
  PACKAGE_VERSION_FILES,
  printField,
  printSection,
  readPackageVersions,
  type PackageVersion,
} from "../lib/summary.js";

export interface RemoteFlags {
  npm?: boolean;
}

interface VersionComparison {
  label: string;
  local?: string;
  remote?: string;
  status: "current" | "behind" | "ahead" | "changed" | "missing" | "unknown";
}

interface RemoteTarget {
  mode: "local project" | "system install";
  appDir: string;
  repo: string;
  ref: string;
}

export async function remoteCmd(
  ctx: RuntimeContext | undefined,
  opts: Options,
  flags: RemoteFlags = {},
): Promise<void> {
  const target = resolveRemoteTarget(ctx, opts);
  printSection("Gorilator Remote");
  printField("Mode", target.mode);
  printField("Repository", target.repo);
  printField("Ref", target.ref);
  printField("Files", target.appDir);

  const localCommit = gitCapture(target.appDir, ["rev-parse", "HEAD"]);
  const fetched = fetchRemote(target);
  process.stdout.write("\n");
  printSection("Git Comparison");
  printField("Local", formatCommit(localCommit));
  printField("Remote", formatCommit(fetched.commit));
  printField("Status", describeGitStatus(target.appDir, localCommit, fetched.commit));
  if (fetched.error) printField("Note", fetched.error);

  const localVersions = readPackageVersions(target.appDir);
  const remoteVersions = fetched.commit ? readRemotePackageVersions(target.appDir) : [];
  process.stdout.write("\n");
  printVersionComparisons(compareVersions(localVersions, remoteVersions));

  if (flags.npm !== false) {
    process.stdout.write("\n");
    printNpmComparison(localVersions);
  }
}

function resolveRemoteTarget(ctx: RuntimeContext | undefined, opts: Options): RemoteTarget {
  if (ctx?.kind === "project") {
    const cfg = loadProjectConfig(ctx, opts);
    return {
      mode: "local project",
      appDir: ctx.appDir,
      repo: cfg.repo === "local" ? opts.repo : cfg.repo,
      ref: remoteRefForProject(cfg.ref, opts.ref),
    };
  }

  const cfg = loadConfig();
  if (cfg) {
    return {
      mode: "system install",
      appDir: cfg.appDir,
      repo: cfg.repo,
      ref: cfg.ref,
    };
  }

  return {
    mode: "system install",
    appDir: opts.appDir,
    repo: opts.repo,
    ref: opts.ref,
  };
}

function remoteRefForProject(ref: string, fallback: string): string {
  if (ref === "local") return fallback;
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return fallback;
  return ref;
}

function fetchRemote(target: RemoteTarget): { commit: string | null; error?: string } {
  if (!existsSync(join(target.appDir, ".git"))) {
    return { commit: null, error: "No git checkout found; only local package versions are available." };
  }

  const fetch = spawnSync("git", ["fetch", "--quiet", "--depth", "1", target.repo, target.ref], {
    cwd: target.appDir,
    encoding: "utf8",
  });
  if (fetch.error || fetch.status !== 0) {
    const detail = (fetch.stderr ?? "").trim();
    return {
      commit: null,
      error: detail || `Could not fetch ${target.repo} ${target.ref}.`,
    };
  }

  return { commit: gitCapture(target.appDir, ["rev-parse", "FETCH_HEAD"]) };
}

function readRemotePackageVersions(appDir: string): PackageVersion[] {
  return PACKAGE_VERSION_FILES.flatMap(({ label, path }) => {
    const raw = gitCapture(appDir, ["show", `FETCH_HEAD:${path}`]);
    if (!raw) return [];
    try {
      const pkg = JSON.parse(raw) as { version?: unknown };
      return typeof pkg.version === "string" && pkg.version.trim()
        ? [{ label, version: pkg.version }]
        : [];
    } catch {
      return [];
    }
  });
}

function compareVersions(local: PackageVersion[], remote: PackageVersion[]): VersionComparison[] {
  const labels = uniqueLabels([...local, ...remote]);
  return labels.map((label) => {
    const localVersion = local.find((version) => version.label === label)?.version;
    const remoteVersion = remote.find((version) => version.label === label)?.version;
    return {
      label,
      local: localVersion,
      remote: remoteVersion,
      status: compareVersionStatus(localVersion, remoteVersion),
    };
  });
}

function uniqueLabels(versions: PackageVersion[]): string[] {
  const labels = new Set(versions.map((version) => version.label));
  return PACKAGE_VERSION_FILES.map(({ label }) => label).filter((label) => labels.has(label));
}

function compareVersionStatus(
  local: string | undefined,
  remote: string | undefined,
): VersionComparison["status"] {
  if (!local || !remote) return "missing";
  const cmp = compareSemver(local, remote);
  if (cmp === null) return local === remote ? "current" : "changed";
  if (cmp === 0) return "current";
  if (cmp < 0) return "behind";
  if (cmp > 0) return "ahead";
  return "changed";
}

function printVersionComparisons(comparisons: VersionComparison[]): void {
  printSection("Package Comparison");
  if (comparisons.length === 0) {
    printField("Status", statusText("unknown"));
    return;
  }
  for (const comparison of comparisons) {
    const local = comparison.local ? `local v${comparison.local}` : "local ?";
    const remote = comparison.remote ? `remote v${comparison.remote}` : "remote ?";
    printField(comparison.label, `${local} / ${remote}  ${statusText(comparison.status)}`);
  }
}

function printNpmComparison(localVersions: PackageVersion[]): void {
  printSection("Published CLI");
  const local = localVersions.find((version) => version.label === "cli")?.version;
  const remote = npmLatest("gorilator");
  printField("Local", local ? `v${local}` : "unknown");
  printField("npm", remote ? `v${remote}` : "unknown");
  printField("Status", statusText(compareVersionStatus(local, remote ?? undefined)));
}

function describeGitStatus(appDir: string, local: string | null, remote: string | null): string {
  if (!local || !remote) return statusText("unknown");
  if (local === remote) return statusText("current");
  if (gitStatus(appDir, ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]) === 0) {
    return statusText("behind");
  }
  if (gitStatus(appDir, ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"]) === 0) {
    return statusText("ahead");
  }
  return statusText("changed");
}

function statusText(status: VersionComparison["status"]): string {
  switch (status) {
    case "current":
      return log.green("current");
    case "behind":
      return log.yellow("behind");
    case "ahead":
      return log.blue("ahead");
    case "changed":
      return log.yellow("different");
    case "missing":
      return log.yellow("missing");
    case "unknown":
      return log.yellow("unknown");
  }
}

function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function npmLatest(name: string): string | null {
  const result = spawnSync("npm", ["view", name, "version", "--silent"], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (result.error || result.status !== 0) return null;
  const out = (result.stdout ?? "").trim();
  return out || null;
}

function gitCapture(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const out = (result.stdout ?? "").trim();
  return out || null;
}

function gitStatus(cwd: string, args: string[]): number | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) return null;
  return result.status;
}

function formatCommit(commit: string | null): string {
  return commit ? commit.slice(0, 12) : "unknown";
}
