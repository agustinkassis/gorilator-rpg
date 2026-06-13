// Daemon auto-update check. Periodically asks the GitHub Releases API whether a
// newer release exists, and caches the verdict so the game splash (via
// /api/update) and the `gorilator` CLI can surface an alert.
//
// "Newer" is decided by SemVer: the latest release's tag version vs the local
// **app (umbrella) version** (the root package.json — see docs/versioning.md),
// NOT the CLI or server package version. Releases must therefore be tagged with
// the app version (e.g. `v0.4.0`). If a tag carries no parseable version we fall
// back to comparing the release date against the local git HEAD commit date.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DEFAULT_REPO = "agustinkassis/gorilator-rpg";
const DEFAULT_INTERVAL_HOURS = 1;
const FIRST_CHECK_DELAY_MS = 10_000; // let startup settle before the first call
const FETCH_TIMEOUT_MS = 6_000;

export interface UpdateSnapshot {
  /** Whether periodic checking is on (interval > 0). */
  enabled: boolean;
  /** Configured interval in hours (0 when disabled). */
  intervalHours: number;
  /** The `owner/repo` being checked. */
  repo: string;
  /** True when the latest release is ahead of the local code (app or any package). */
  updateAvailable: boolean;
  /** The running code's **app (umbrella)** version + short commit, plus the local
   *  per-package versions (app/cli/client/server/shared). */
  current: {
    version: string;
    sha: string | null;
    committedAt: string | null;
    packages: Record<string, string>;
  };
  /** The latest published GitHub release, when one was read (`version` is the
   *  SemVer parsed from its tag, or null if the tag has none). `packages` are the
   *  per-package versions read from that release tag (empty if unavailable). */
  latest: {
    tag: string;
    name: string;
    url: string;
    publishedAt: string;
    version: string | null;
    packages: Record<string, string>;
  } | null;
  /** Epoch ms of the last completed check (0 if never). */
  checkedAt: number;
  /** Last error message, if the most recent check failed. */
  error?: string;
}

class UpdateChecker {
  private intervalHours = resolveIntervalHours();
  private readonly repo = (process.env.UPDATE_REPO?.trim() || DEFAULT_REPO).replace(/^https?:\/\/github\.com\//, "");
  private timer?: NodeJS.Timeout;
  /** Remote per-package versions keyed by the release tag they were read from, so
   *  we only re-fetch them when a new release appears. */
  private packagesCache: { tag: string; packages: Record<string, string> } | null = null;
  private snap: UpdateSnapshot = {
    enabled: this.intervalHours > 0,
    intervalHours: this.intervalHours,
    repo: this.repo,
    updateAvailable: false,
    current: { version: resolveAppVersion(), sha: null, committedAt: null, packages: localPackages() },
    latest: null,
    checkedAt: 0,
  };

  /** Start the periodic check loop (no-op when disabled). Safe to call once. */
  init(): void {
    if (this.intervalHours <= 0) {
      console.log("[update] auto-update check disabled (UPDATE_CHECK_HOURS=0)");
      return;
    }
    console.log(
      `[update] checking ${this.repo} for new releases every ${this.intervalHours}h`,
    );
    const first = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    first.unref?.();
    const periodMs = this.intervalHours * 60 * 60 * 1000;
    this.timer = setInterval(() => void this.check(), periodMs);
    this.timer.unref?.();
  }

  /** The cached verdict (a plain, JSON-serializable object). */
  snapshot(): UpdateSnapshot {
    return this.snap;
  }

  /** Run one check now, updating the cached snapshot. Never throws. */
  async check(): Promise<void> {
    try {
      const sha = git("rev-parse", "--short", "HEAD");
      const committedAt = git("show", "-s", "--format=%cI", "HEAD");
      const appVersion = resolveAppVersion();
      const local = localPackages();
      const release = await fetchLatestRelease(this.repo);

      // Read the release's per-package versions, cached by tag (re-fetched only
      // when a new release appears).
      let remotePackages: Record<string, string> = {};
      if (release) {
        if (this.packagesCache?.tag === release.tag) {
          remotePackages = this.packagesCache.packages;
        } else {
          remotePackages = await fetchReleasePackages(this.repo, release.tag);
          if (Object.keys(remotePackages).length) {
            this.packagesCache = { tag: release.tag, packages: remotePackages };
          }
        }
      }
      const latest = release ? { ...release, packages: remotePackages } : null;

      let updateAvailable = false;
      if (latest) {
        // Newer if ANY package (or the app umbrella) is ahead in the release.
        const perPackage = Object.entries(latest.packages).some(
          ([label, remote]) => compareSemver(remote, local[label] ?? appVersion) > 0,
        );
        if (perPackage) {
          updateAvailable = true;
        } else if (latest.version) {
          updateAvailable = compareSemver(latest.version, appVersion) > 0;
        } else if (committedAt) {
          // Tag has no parseable version → fall back to release-vs-HEAD date.
          updateAvailable = Date.parse(latest.publishedAt) > Date.parse(committedAt);
        }
      }

      this.snap = {
        enabled: true,
        intervalHours: this.intervalHours,
        repo: this.repo,
        updateAvailable,
        current: { version: appVersion, sha, committedAt, packages: local },
        latest,
        checkedAt: Date.now(),
      };
      if (updateAvailable && latest) {
        console.log(`[update] new release available: ${latest.tag} (app ${appVersion} → ${latest.version ?? latest.tag})`);
      }
    } catch (err) {
      this.snap = {
        ...this.snap,
        checkedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
      console.warn(`[update] check failed: ${this.snap.error}`);
    }
  }
}

/** Parse UPDATE_CHECK_HOURS — a non-negative number; 0 (or invalid) disables. */
function resolveIntervalHours(): number {
  const raw = process.env.UPDATE_CHECK_HOURS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The app (umbrella) version — the **root** package.json version. Resolved via
 *  the git repo root (robust across src/dist layouts), with URL fallbacks. */
function resolveAppVersion(): string {
  const root = git("rev-parse", "--show-toplevel");
  const candidates: Array<string | URL> = [];
  if (root) candidates.push(`${root}/package.json`);
  // From packages/server/src/systems/: the repo root is four levels up.
  candidates.push(new URL("../../../../package.json", import.meta.url));
  candidates.push(new URL("../../../package.json", import.meta.url));
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      if (typeof pkg?.version === "string" && pkg.version.trim()) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return "0.0.0";
}

/** The workspace package.json files (label → path from the repo root). Mirrors
 *  the CLI's PACKAGE_VERSION_FILES — keep them in sync. */
const PACKAGE_PATHS: Array<[label: string, path: string]> = [
  ["app", "package.json"],
  ["cli", "packages/cli/package.json"],
  ["client", "packages/client/package.json"],
  ["server", "packages/server/package.json"],
  ["shared", "packages/shared/package.json"],
];

/** The local per-package versions (app/cli/client/server/shared). */
function localPackages(): Record<string, string> {
  const root = git("rev-parse", "--show-toplevel");
  const out: Record<string, string> = {};
  for (const [label, path] of PACKAGE_PATHS) {
    const candidates: Array<string | URL> = [];
    if (root) candidates.push(`${root}/${path}`);
    candidates.push(new URL(`../../../../${path}`, import.meta.url));
    for (const p of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: unknown };
        if (typeof pkg?.version === "string" && pkg.version.trim()) {
          out[label] = pkg.version;
          break;
        }
      } catch {
        /* try next candidate */
      }
    }
  }
  return out;
}

/** The per-package versions at a release tag, read from raw.githubusercontent.com.
 *  Best-effort and parallel — missing files are simply omitted. */
async function fetchReleasePackages(repo: string, tag: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    PACKAGE_PATHS.map(async ([label, path]) => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${repo}/${tag}/${path}`, {
          headers: { "User-Agent": "gorilator-update-check" },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const pkg = (await res.json()) as { version?: unknown };
        if (typeof pkg.version === "string" && pkg.version.trim()) out[label] = pkg.version;
      } catch {
        /* skip this package */
      } finally {
        clearTimeout(t);
      }
    }),
  );
  return out;
}

/** Extract the SemVer `MAJOR.MINOR.PATCH` from a release tag (e.g. `v0.4.0`,
 *  `0.4.0`), or null if the tag carries no version. */
function versionFromTag(tag: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(tag);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Compare two MAJOR.MINOR.PATCH strings: -1 / 0 / 1. Unparseable → 0. */
function compareSemver(a: string, b: string): number {
  const pa = versionFromTag(a);
  const pb = versionFromTag(b);
  if (!pa || !pb) return 0;
  const x = pa.split(".").map(Number);
  const y = pb.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** Run a git command from the server cwd; returns trimmed stdout or null. */
function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

interface LatestRelease {
  tag: string;
  name: string;
  url: string;
  publishedAt: string;
  /** SemVer parsed from the tag, or null. */
  version: string | null;
}

/** GET the latest (non-draft, non-prerelease) release for a repo, or null. */
async function fetchLatestRelease(repo: string): Promise<LatestRelease | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "User-Agent": "gorilator-update-check",
      Accept: "application/vnd.github+json",
    };
    // Optional token lifts the 60 req/h unauthenticated rate limit.
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: controller.signal,
    });
    if (res.status === 404) return null; // no releases yet
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const body = (await res.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
    };
    if (!body.tag_name || !body.published_at) return null;
    return {
      tag: body.tag_name,
      name: body.name || body.tag_name,
      url: body.html_url || `https://github.com/${repo}/releases/latest`,
      publishedAt: body.published_at,
      version: versionFromTag(body.tag_name),
    };
  } finally {
    clearTimeout(t);
  }
}

/** Server-wide singleton. */
export const updateChecker = new UpdateChecker();
