// Prebuilt-release support: resolve the latest release tag and download the
// prebuilt dist artifact a release ships, so `install`/`update` can skip the
// (slow) client/shared/cli build. Best-effort — every function fails soft so the
// caller falls back to building from source.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as log from "./log.js";
import { isRoot, type RunOpts, targetUser } from "./proc.js";

/** Run a command as the target user (correct file ownership when root installs to
 *  /opt), fully quiet, returning success — so a missing asset (curl 404) falls
 *  back to building without leaking errors to the terminal. */
function tryStep(cmd: string, args: string[], opts: RunOpts = {}): boolean {
  const user = targetUser();
  let realCmd = cmd;
  let realArgs = args;
  let env = opts.env ? { ...process.env, ...opts.env } : process.env;
  if (isRoot() && user !== "root") {
    const pairs = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v ?? ""}`);
    realCmd = "sudo";
    realArgs = ["-u", user, "--", "env", ...pairs, cmd, ...args];
    env = process.env;
  }
  const r = spawnSync(realCmd, realArgs, { cwd: opts.cwd, env, stdio: ["ignore", "ignore", "ignore"] });
  return !r.error && r.status === 0;
}

/** Extract the `owner/repo` slug from a git URL (https or scp form) or a bare
 *  `owner/repo`. Returns null if it isn't a GitHub repo. */
export function repoSlug(repo: string): string | null {
  const cleaned = repo.trim().replace(/\.git$/, "");
  const gh = cleaned.match(/github\.com[/:]([^/]+\/[^/]+)$/);
  if (gh) return gh[1];
  const bare = cleaned.match(/^([\w.-]+\/[\w.-]+)$/);
  return bare ? bare[1] : null;
}

/** The latest published release tag for a repo, or null (no releases / offline). */
export async function latestReleaseTag(slug: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": "gorilator",
      Accept: "application/vnd.github+json",
    };
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string };
    return body.tag_name?.trim() || null;
  } catch {
    return null;
  }
}

/** The name of the prebuilt dist asset for a tag. */
export function distAssetName(tag: string): string {
  return `gorilator-dist-${tag}.tar.gz`;
}

/**
 * Download + extract the prebuilt dist tarball for `tag` into `appDir` (landing
 * packages/{shared,client,cli}/dist). Verifies the SHA-256 against the release's
 * SHA256SUMS when present. Returns true only when the client build is in place.
 * Any miss (no asset, bad checksum, no curl/tar) returns false → build instead.
 */
export function downloadReleaseDist(slug: string, tag: string, appDir: string): boolean {
  const asset = distAssetName(tag);
  const base = `https://github.com/${slug}/releases/download/${tag}`;
  const tarball = join(appDir, asset);

  if (!tryStep("curl", ["-fsSL", "-o", tarball, `${base}/${asset}`])) {
    return false; // no prebuilt asset for this tag (e.g. a branch ref / fork)
  }

  if (!verifyChecksum(slug, tag, asset, tarball, appDir)) {
    cleanup(tarball);
    return false;
  }

  const extracted = tryStep("tar", ["-xzf", tarball, "-C", appDir]);
  cleanup(tarball);
  if (!extracted) {
    log.warn("Could not extract the prebuilt build — building from source instead.");
    return false;
  }

  // Sanity: the served client must be present.
  return existsSync(join(appDir, "packages", "client", "dist", "index.html"));
}

/** Best-effort SHA-256 check against the release's SHA256SUMS. Missing sums file
 *  → accept (older releases); present-but-mismatch → reject. */
function verifyChecksum(slug: string, tag: string, asset: string, tarball: string, appDir: string): boolean {
  const sumsPath = join(appDir, "SHA256SUMS");
  const got = tryStep("curl", [
    "-fsSL",
    "-o",
    sumsPath,
    `https://github.com/${slug}/releases/download/${tag}/SHA256SUMS`,
  ]);
  if (!got) return true; // no checksum file published → skip verification
  try {
    const sums = readFileSync(sumsPath, "utf8");
    cleanup(sumsPath);
    const want = sums
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .find(([, name]) => name === asset || name === `*${asset}`)?.[0]
      ?.toLowerCase();
    if (!want) return true; // asset not listed → don't block
    const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (actual !== want) {
      log.warn("Prebuilt build checksum mismatch — building from source instead.");
      return false;
    }
    return true;
  } catch {
    cleanup(sumsPath);
    return true;
  }
}

function cleanup(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}
