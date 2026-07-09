import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  statSync,
  createReadStream,
} from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { pluginBundler } from "./config/pluginBundler";
import type { CommunityEntity } from "@rpg/shared";

const configDir = dirname(fileURLToPath(import.meta.url));

/** The app version shown in-game (the tiny footer tag), read from the workspace
 *  root package.json. Falls back to 0.0.0 if it can't be read. */
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(configDir, "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Versions of every workspace package, read at build time, for the footer
 *  version popup (click the bottom-right tag). Skips any that can't be read. */
function packageVersions(): Record<string, string> {
  const root = resolve(configDir, "..", "..");
  const files: Array<[string, string]> = [
    ["app", "package.json"],
    ["client", "packages/client/package.json"],
    ["server", "packages/server/package.json"],
    ["shared", "packages/shared/package.json"],
    ["cli", "packages/cli/package.json"],
  ];
  const out: Record<string, string> = {};
  for (const [label, rel] of files) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(root, rel), "utf8")) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version) out[label] = pkg.version;
    } catch {
      /* missing/unreadable — skip */
    }
  }
  return out;
}

function captureGit(args: string[], cwd?: string, trim = true): string | null {
  try {
    const raw = execFileSync("git", args, { cwd, encoding: "utf8" });
    const text = trim ? raw.trim() : raw.replace(/\r?\n$/, "");
    return text || null;
  } catch {
    return null;
  }
}

function execGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

interface WorktreeCommit {
  hash: string;
  subject: string;
  age: string;
  conflict?: boolean;
  conflictReason?: string;
}

interface WorktreeChange {
  status: string;
  path: string;
  label: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

interface WorktreeInfo {
  root: string;
  id: string;
  name: string;
  defaultLabel: string;
  label: string;
  fullLabel: string;
  branch: string;
  targetBranch: string;
  pendingBase: string;
  branches: string[];
  isMain: boolean;
  isLinked: boolean;
  hasTargetUpdates: boolean;
  pendingCommits: WorktreeCommit[];
  incomingCommits: WorktreeCommit[];
  commits: WorktreeCommit[];
  changes: WorktreeChange[];
}

interface WorktreeFilePayload {
  path: string;
  content: string;
  baseContent: string;
  kind: string;
  mime: string;
  editable: boolean;
  language: string;
}

const emptyWorktreeInfo = (): WorktreeInfo => ({
  root: "",
  id: "",
  name: "",
  defaultLabel: "",
  label: "",
  fullLabel: "",
  branch: "",
  targetBranch: "main",
  pendingBase: "",
  branches: [],
  isMain: false,
  isLinked: false,
  hasTargetUpdates: false,
  pendingCommits: [],
  incomingCommits: [],
  commits: [],
  changes: [],
});

const worktreeNamePathFor = (root: string) => resolve(root, ".gorilator/worktree-name");
const workflowSettingsPathFor = (root: string) => resolve(root, "codex-workflow.json");

function sanitizeWorktreeName(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readWorktreeName(root: string): string {
  try {
    return sanitizeWorktreeName(readFileSync(worktreeNamePathFor(root), "utf8"));
  } catch {
    return "";
  }
}

function writeWorktreeName(root: string, raw: unknown): string {
  const name = sanitizeWorktreeName(raw);
  const path = worktreeNamePathFor(root);
  if (!name) {
    if (existsSync(path)) unlinkSync(path);
    return "";
  }
  mkdirSync(resolve(root, ".gorilator"), { recursive: true });
  writeFileSync(path, `${name}\n`);
  return name;
}

function sanitizeBranchName(raw: unknown): string {
  const branch = String(raw ?? "")
    .replace(/[\r\n\t\s]+/g, "")
    .trim();
  if (
    !branch ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("\\") ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    return "main";
  }
  return branch;
}

function readTargetBranch(root: string): string {
  try {
    const raw = JSON.parse(readFileSync(workflowSettingsPathFor(root), "utf8")) as { targetBranch?: unknown };
    return sanitizeBranchName(raw.targetBranch);
  } catch {
    return "main";
  }
}

function writeTargetBranch(root: string, raw: unknown): string {
  const targetBranch = sanitizeBranchName(raw);
  let prev: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(workflowSettingsPathFor(root), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prev = parsed as Record<string, unknown>;
  } catch {
    prev = {};
  }
  writeFileSync(workflowSettingsPathFor(root), JSON.stringify({ ...prev, targetBranch }, null, 2) + "\n");
  return targetBranch;
}

function splitGitLines(raw: string | null): string[] {
  return raw
    ? raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function currentBranch(root: string): string {
  const branch = captureGit(["branch", "--show-current"], root);
  if (branch) return branch;
  const pointedBranches = splitGitLines(captureGit(["branch", "--points-at", "HEAD", "--format=%(refname:short)"], root))
    .filter((name) => !name.includes("HEAD"));
  return (
    pointedBranches.find((name) => name.startsWith("codex/")) ??
    pointedBranches.find((name) => name !== "main") ??
    pointedBranches[0] ??
    ""
  );
}

function branchOptions(root: string): string[] {
  const branches = new Set<string>(["main"]);
  for (const branch of splitGitLines(captureGit(["branch", "--format=%(refname:short)"], root))) {
    if (branch.startsWith("(") || branch.includes("HEAD")) continue;
    branches.add(branch);
  }
  for (const raw of splitGitLines(captureGit(["branch", "-r", "--format=%(refname:short)"], root))) {
    if (raw.startsWith("(") || raw.includes("HEAD")) continue;
    branches.add(raw.startsWith("origin/") ? raw.slice("origin/".length) : raw);
  }
  return [...branches].sort((a, b) => {
    if (a === "main") return -1;
    if (b === "main") return 1;
    return a.localeCompare(b);
  });
}

function gitCommitRef(root: string, ref: string): string | null {
  return captureGit(["rev-parse", "--verify", `${ref}^{commit}`], root);
}

function pendingBaseRef(root: string, targetBranch: string): string {
  if (gitCommitRef(root, targetBranch)) return targetBranch;
  const remoteRef = `origin/${targetBranch}`;
  if (gitCommitRef(root, remoteRef)) return remoteRef;
  return "";
}

function recentGitCommits(root: string): WorktreeCommit[] {
  const raw = captureGit(["log", "--max-count=8", "--pretty=format:%h%x1f%s%x1f%cr"], root);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      const [hash = "", subject = "", age = ""] = line.split("\x1f");
      return { hash, subject, age };
    })
    .filter((commit) => commit.hash && commit.subject);
}

function pendingGitCommitRefs(root: string, targetBranch: string): string[] {
  const base = pendingBaseRef(root, targetBranch);
  if (!base) return [];
  const raw = captureGit(["log", "--cherry-pick", "--right-only", "--pretty=format:%H", `${base}...HEAD`], root);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}

function incomingGitCommitRefs(root: string, targetBranch: string, current: string): string[] {
  if (current === targetBranch) return [];
  const base = pendingBaseRef(root, targetBranch);
  if (!base) return [];
  const raw = captureGit(["log", "--cherry-pick", "--left-only", "--reverse", "--pretty=format:%H", `${base}...HEAD`], root);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}

function pendingGitCommits(root: string, targetBranch: string, current: string): WorktreeCommit[] {
  if (current === targetBranch) return [];
  const base = pendingBaseRef(root, targetBranch);
  if (!base) return [];
  const raw = captureGit([
    "log",
    "--cherry-pick",
    "--right-only",
    "--max-count=20",
    "--pretty=format:%H%x1f%h%x1f%s%x1f%cr",
    `${base}...HEAD`,
  ], root);
  if (!raw) return [];
  const commits = raw
    .split("\n")
    .map((line) => {
      const [ref = "", hash = "", subject = "", age = ""] = line.split("\x1f");
      return { ref, hash, subject, age };
    })
    .filter((commit) => commit.ref && commit.hash && commit.subject);
  const conflictReasons = pendingTargetConflictReasons(
    root,
    targetBranch,
    commits.map((commit) => commit.ref),
  );
  return commits.map(({ ref, hash, subject, age }) => {
    const conflictReason = conflictReasons.get(ref) ?? "";
    return { hash, subject, age, conflict: Boolean(conflictReason), conflictReason };
  });
}

function mergeConflictReason(root: string, commit: string): string {
  try {
    execFileSync("git", ["merge-tree", "--write-tree", "HEAD", commit], { cwd: root, encoding: "utf8" });
    return "";
  } catch (err) {
    const out = `${String((err as { stdout?: unknown }).stdout ?? "")}\n${String((err as { stderr?: unknown }).stderr ?? "")}`;
    const paths = Array.from(
      new Set(
        out
          .split("\n")
          .map((line) => line.match(/^[0-9]{6} [0-9a-f]{40} [123]\t(.+)$/)?.[1])
          .filter((path): path is string => Boolean(path)),
      ),
    );
    if (!paths.length) return "Conflict";
    const shown = paths.slice(0, 3).join(", ");
    return paths.length > 3 ? `Conflicts: ${shown}, ...` : `Conflicts: ${shown}`;
  }
}

function incomingGitCommits(root: string, targetBranch: string, current: string): WorktreeCommit[] {
  const refs = incomingGitCommitRefs(root, targetBranch, current).slice(0, 20);
  const conflictReasons = currentMergeConflictReasons(root, refs);
  const commits: WorktreeCommit[] = [];
  for (const ref of refs) {
    const raw = captureGit(["show", "-s", "--pretty=format:%h%x1f%s%x1f%cr", ref], root);
    if (!raw) continue;
    const [hash = "", subject = "", age = ""] = raw.split("\x1f");
    if (!hash || !subject) continue;
    const conflictReason = conflictReasons.get(ref) ?? "";
    commits.push({ hash, subject, age, conflict: Boolean(conflictReason), conflictReason });
  }
  return commits;
}

function gitStatusLabel(status: string): string {
  if (status === "??") return "untracked";
  const staged = status[0] !== " " && status[0] !== "?";
  const unstaged = status[1] !== " ";
  if (staged && unstaged) return "staged + unstaged";
  if (staged) return "staged";
  if (unstaged) return "unstaged";
  return "changed";
}

function currentGitChanges(root: string): WorktreeChange[] {
  const raw = captureGit(["status", "--porcelain=v1"], root, false);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      const status = line.slice(0, 2);
      let path = line.slice(2).trimStart();
      const renameAt = path.indexOf(" -> ");
      if (renameAt >= 0) path = path.slice(renameAt + 4);
      const untracked = status === "??";
      const staged = status[0] !== " " && status[0] !== "?";
      const unstaged = untracked || status[1] !== " ";
      return {
        status,
        path,
        label: gitStatusLabel(status),
        staged,
        unstaged,
        untracked,
      };
    })
    .filter((change) => change.path);
}

function repoFilePath(root: string, rawPath: unknown): { abs: string; rel: string } {
  const requested = String(rawPath ?? "").replace(/\\/g, "/");
  const abs = resolve(root, requested);
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === ".." || resolve(root, rel) !== abs) {
    throw new Error("file must be inside the repository");
  }
  return { abs, rel };
}

const MIME_BY_EXT: Record<string, string> = {
  ".avif": "image/avif",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ts": "text/typescript; charset=utf-8",
  ".tsx": "text/typescript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

const EDITABLE_EXTS = new Set([".json", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".md", ".txt", ".yaml", ".yml"]);
const IMAGE_EXTS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const AUDIO_EXTS = new Set([".flac", ".m4a", ".mp3", ".ogg", ".wav"]);
const VIDEO_EXTS = new Set([".mov", ".mp4", ".webm"]);
const MODEL_EXTS = new Set([".gbl", ".glb", ".gltf"]);

function worktreeFileMeta(rel: string) {
  const ext = extname(rel).toLowerCase();
  const kind = IMAGE_EXTS.has(ext)
    ? "image"
    : AUDIO_EXTS.has(ext)
      ? "audio"
      : VIDEO_EXTS.has(ext)
        ? "video"
        : MODEL_EXTS.has(ext)
          ? "model"
          : ext === ".json"
            ? "json"
            : EDITABLE_EXTS.has(ext)
              ? "code"
              : "unsupported";
  return {
    kind,
    mime: MIME_BY_EXT[ext] ?? "application/octet-stream",
    editable: EDITABLE_EXTS.has(ext),
    language: ext.replace(/^\./, "") || "text",
  };
}

function readWorktreeFile(root: string, rawPath: unknown): WorktreeFilePayload {
  const file = repoFilePath(root, rawPath);
  const meta = worktreeFileMeta(file.rel);
  const content = meta.editable && existsSync(file.abs) ? readFileSync(file.abs, "utf8") : "";
  const baseContent = meta.editable ? captureGit(["show", `HEAD:${file.rel}`], root, false) ?? "" : "";
  return { path: file.rel, content, baseContent, ...meta };
}

function writeWorktreeFile(root: string, rawPath: unknown, rawContent: unknown): WorktreeFilePayload {
  const file = repoFilePath(root, rawPath);
  const meta = worktreeFileMeta(file.rel);
  if (!meta.editable) throw new Error("this file type is preview-only");
  const content = String(rawContent ?? "");
  if (meta.kind === "json") JSON.parse(content);
  writeFileSync(file.abs, content.endsWith("\n") ? content : `${content}\n`);
  return readWorktreeFile(root, file.rel);
}

function sendWorktreeRawFile(res: ServerResponse, root: string, rawPath: unknown) {
  const file = repoFilePath(root, rawPath);
  if (!existsSync(file.abs)) throw new Error("file does not exist");
  const meta = worktreeFileMeta(file.rel);
  res.statusCode = 200;
  res.setHeader("content-type", meta.mime);
  res.setHeader("cache-control", "no-store");
  createReadStream(file.abs).on("error", (err) => fail(res, 500, String(err))).pipe(res);
}

function ensureLocalTargetBranch(root: string, targetBranch: string) {
  if (gitCommitRef(root, targetBranch)) return;
  const remoteRef = `origin/${targetBranch}`;
  if (!gitCommitRef(root, remoteRef)) throw new Error(`Target branch ${targetBranch} was not found`);
  execGit(["branch", targetBranch, remoteRef], root);
}

function worktreePathForBranch(root: string, branch: string): string {
  const raw = captureGit(["worktree", "list", "--porcelain"], root, false);
  if (!raw) return "";
  let path = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      path = "";
      continue;
    }
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line === `branch refs/heads/${branch}` && path) return path;
  }
  return "";
}

interface TargetMergeWorktree {
  cwd: string;
  temporary: boolean;
  checkedOutTarget: boolean;
}

function targetMergeWorktree(root: string, targetBranch: string): TargetMergeWorktree {
  const existing = worktreePathForBranch(root, targetBranch);
  if (existing) {
    return { cwd: existing, temporary: false, checkedOutTarget: true };
  }
  const parent = resolve(root, ".gorilator");
  mkdirSync(parent, { recursive: true });
  const tmp = mkdtempSync(resolve(parent, "merge-"));
  execGit(["worktree", "add", "--quiet", tmp, targetBranch], root);
  return { cwd: tmp, temporary: true, checkedOutTarget: false };
}

function removeTemporaryWorktree(root: string, cwd: string) {
  try {
    execGit(["worktree", "remove", "--force", cwd], root);
  } catch {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function gitErrorMessage(err: unknown): string {
  const out = `${String((err as { stdout?: unknown }).stdout ?? "")}\n${String((err as { stderr?: unknown }).stderr ?? "")}`.trim();
  return out || (err instanceof Error ? err.message : String(err));
}

function conflictSummaryFromMessage(message: string): string {
  const paths = Array.from(
    new Set(
      message
        .split("\n")
        .map((line) => line.match(/CONFLICT \([^)]+\): .* in (.+)$/)?.[1] ?? line.match(/^[0-9]{6} [0-9a-f]{40} [123]\t(.+)$/)?.[1])
        .filter((path): path is string => Boolean(path)),
    ),
  );
  if (paths.length) {
    const shown = paths.slice(0, 3).join(", ");
    return paths.length > 3 ? `Conflicts: ${shown}, ...` : `Conflicts: ${shown}`;
  }
  return message.split("\n").find(Boolean)?.trim() || "Conflict";
}

function latestStashSha(cwd: string): string {
  return captureGit(["rev-parse", "-q", "--verify", "stash@{0}"], cwd) ?? "";
}

function targetTrackedSnapshot(cwd: string): string {
  return captureGit(["stash", "create", "gorilator preflight target merge"], cwd) ?? "";
}

function targetUntrackedPaths(cwd: string): string[] {
  const raw = captureGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd, false);
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function unmergedPaths(cwd: string): string[] {
  const raw = captureGit(["diff", "--name-only", "--diff-filter=U"], cwd, false);
  return raw ? raw.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function unresolvedConflictReason(paths: string[], label = "Target worktree"): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${label} has unresolved conflicts: ${shown}, ...` : `${label} has unresolved conflicts: ${shown}`;
}

function currentMergeBlockReason(root: string): string {
  const currentUnmergedPaths = unmergedPaths(root);
  if (currentUnmergedPaths.length) return unresolvedConflictReason(currentUnmergedPaths, "Current worktree");
  const status = captureGit(["status", "--porcelain=v1"], root, false)?.trim() ?? "";
  return status ? "Current worktree has uncommitted changes; commit or stash them before merging in." : "";
}

function abortMerge(cwd: string) {
  try {
    execGit(["merge", "--abort"], cwd);
  } catch {
    // The merge may have failed before Git entered a merge state.
  }
}

function mergeSource(cwd: string, source: string) {
  try {
    execGit(["merge", "--no-edit", source], cwd);
  } catch (err) {
    abortMerge(cwd);
    throw err;
  }
}

function currentMergeConflictReasons(root: string, sources: string[]): Map<string, string> {
  const reasons = new Map<string, string>();
  if (!sources.length) return reasons;
  const blockReason = currentMergeBlockReason(root);
  if (blockReason) {
    for (const source of sources) reasons.set(source, blockReason);
    return reasons;
  }
  const baseHead = gitCommitRef(root, "HEAD");
  if (!baseHead) {
    for (const source of sources) reasons.set(source, "Current HEAD was not found");
    return reasons;
  }
  const parent = resolve(root, ".gorilator");
  mkdirSync(parent, { recursive: true });
  const tmp = mkdtempSync(resolve(parent, "merge-in-preflight-"));
  try {
    execGit(["worktree", "add", "--quiet", "--detach", tmp, baseHead], root);
    for (const source of sources) {
      try {
        execGit(["reset", "--hard", baseHead], tmp);
        execGit(["clean", "-fd"], tmp);
        mergeSource(tmp, source);
      } catch (err) {
        reasons.set(source, conflictSummaryFromMessage(gitErrorMessage(err)));
      }
    }
  } catch (err) {
    const reason = conflictSummaryFromMessage(gitErrorMessage(err));
    for (const source of sources) reasons.set(source, reason);
  } finally {
    removeTemporaryWorktree(root, tmp);
  }
  return reasons;
}

function pendingTargetConflictReasons(root: string, targetBranch: string, sources: string[]): Map<string, string> {
  const reasons = new Map<string, string>();
  if (!sources.length) return reasons;
  const base = pendingBaseRef(root, targetBranch);
  if (!base) {
    for (const source of sources) reasons.set(source, `Target branch ${targetBranch} was not found`);
    return reasons;
  }
  const existingTarget = worktreePathForBranch(root, targetBranch);
  const targetUnmergedPaths = existingTarget ? unmergedPaths(existingTarget) : [];
  if (targetUnmergedPaths.length) {
    const reason = unresolvedConflictReason(targetUnmergedPaths);
    for (const source of sources) reasons.set(source, reason);
    return reasons;
  }
  const trackedSnapshot = existingTarget ? targetTrackedSnapshot(existingTarget) : "";
  const untrackedPaths = existingTarget ? targetUntrackedPaths(existingTarget) : [];
  const parent = resolve(root, ".gorilator");
  mkdirSync(parent, { recursive: true });
  const tmp = mkdtempSync(resolve(parent, "merge-preflight-"));
  try {
    execGit(["worktree", "add", "--quiet", "--detach", tmp, base], root);
    for (const source of sources) {
      try {
        execGit(["reset", "--hard", base], tmp);
        execGit(["clean", "-fd"], tmp);
        cherryPickCommit(tmp, source);
        for (const path of untrackedPaths) {
          if (existsSync(resolve(tmp, path))) {
            reasons.set(source, `Untracked target file would be overwritten: ${path}`);
            break;
          }
        }
        if (!reasons.has(source) && trackedSnapshot) execGit(["stash", "apply", "--index", trackedSnapshot], tmp);
      } catch (err) {
        reasons.set(source, conflictSummaryFromMessage(gitErrorMessage(err)));
      }
    }
  } catch (err) {
    const reason = conflictSummaryFromMessage(gitErrorMessage(err));
    for (const source of sources) reasons.set(source, reason);
  } finally {
    removeTemporaryWorktree(root, tmp);
  }
  return reasons;
}

function stashTargetChanges(cwd: string): string {
  const targetUnmergedPaths = unmergedPaths(cwd);
  if (targetUnmergedPaths.length) throw new Error(unresolvedConflictReason(targetUnmergedPaths));
  const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8" }).trim();
  if (!status) return "";
  const before = latestStashSha(cwd);
  execGit(["stash", "push", "--include-untracked", "-m", "gorilator autostash before target merge"], cwd);
  const after = latestStashSha(cwd);
  return after && after !== before ? after : "";
}

function dropAutostash(cwd: string, stashSha: string) {
  if (!stashSha || latestStashSha(cwd) !== stashSha) return;
  execGit(["stash", "drop", "stash@{0}"], cwd);
}

function restoreAutostash(cwd: string, stashSha: string) {
  if (!stashSha) return;
  execGit(["stash", "apply", "--index", stashSha], cwd);
  dropAutostash(cwd, stashSha);
}

function abortCherryPick(cwd: string) {
  try {
    execGit(["cherry-pick", "--abort"], cwd);
  } catch {
    // The pick may not have started.
  }
}

function cherryPickCommit(cwd: string, source: string) {
  try {
    execGit(["cherry-pick", source], cwd);
  } catch (err) {
    abortCherryPick(cwd);
    throw err;
  }
}

function preflightTargetAutostash(root: string, targetBranch: string, source: string, stashSha: string) {
  const parent = resolve(root, ".gorilator");
  mkdirSync(parent, { recursive: true });
  const tmp = mkdtempSync(resolve(parent, "merge-check-"));
  try {
    execGit(["worktree", "add", "--quiet", "--detach", tmp, targetBranch], root);
    cherryPickCommit(tmp, source);
    if (stashSha) execGit(["stash", "apply", "--index", stashSha], tmp);
  } catch (err) {
    throw new Error(
      `Local changes in the checked-out ${targetBranch} worktree would conflict with ${source.slice(0, 7)}. ${gitErrorMessage(err)}`,
    );
  } finally {
    removeTemporaryWorktree(root, tmp);
  }
}

function cherryPickIntoCheckedOutTarget(root: string, targetBranch: string, cwd: string, source: string) {
  const stashSha = stashTargetChanges(cwd);
  let picked = false;
  try {
    if (stashSha) preflightTargetAutostash(root, targetBranch, source, stashSha);
    cherryPickCommit(cwd, source);
    picked = true;
    restoreAutostash(cwd, stashSha);
  } catch (err) {
    if (!picked) {
      try {
        restoreAutostash(cwd, stashSha);
      } catch (restoreErr) {
        throw new Error(`Could not restore local changes after merge failed. ${gitErrorMessage(restoreErr)}`);
      }
    } else if (stashSha) {
      throw new Error(
        `Merged ${source.slice(0, 7)} into ${targetBranch}, but local changes could not be reapplied. They are still saved in the latest Git stash for ${cwd}. ${gitErrorMessage(err)}`,
      );
    }
    throw err;
  }
}

function pendingCommitRef(root: string, targetBranch: string, rawCommit: unknown): string {
  const commit = String(rawCommit ?? "").trim();
  if (!commit) throw new Error("Missing commit to merge");
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("Invalid commit");
  const resolved = gitCommitRef(root, commit);
  if (!resolved) throw new Error(`Commit ${commit} was not found`);
  if (!pendingBaseRef(root, targetBranch)) throw new Error(`Target branch ${targetBranch} was not found`);
  if (!pendingGitCommitRefs(root, targetBranch).includes(resolved)) {
    throw new Error(`Commit ${commit} is not pending for ${targetBranch}`);
  }
  return resolved;
}

function targetIncomingCommitRef(root: string, targetBranch: string, current: string, rawCommit: unknown): string {
  const commit = String(rawCommit ?? "").trim();
  if (!commit) throw new Error("Missing target commit to merge");
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("Invalid target commit");
  const resolved = gitCommitRef(root, commit);
  if (!resolved) throw new Error(`Target commit ${commit} was not found`);
  if (!incomingGitCommitRefs(root, targetBranch, current).includes(resolved)) {
    throw new Error(`Target commit ${commit} is not pending for ${current}`);
  }
  const conflictReason = currentMergeConflictReasons(root, [resolved]).get(resolved) ?? "";
  if (conflictReason) throw new Error(`Cannot merge target history through ${commit}: ${conflictReason}`);
  return resolved;
}

function mergeCommitIntoTargetBranch(root: string, rawCommit: unknown): WorktreeInfo {
  const targetBranch = readTargetBranch(root);
  const current = currentBranch(root);
  if (current === targetBranch) return worktreeInfo();
  const source = pendingCommitRef(root, targetBranch, rawCommit);
  const conflictReason = pendingTargetConflictReasons(root, targetBranch, [source]).get(source) ?? "";
  if (conflictReason) throw new Error(`Cannot merge ${String(rawCommit).trim()} into ${targetBranch}: ${conflictReason}`);
  ensureLocalTargetBranch(root, targetBranch);
  const target = targetMergeWorktree(root, targetBranch);
  try {
    if (target.checkedOutTarget) cherryPickIntoCheckedOutTarget(root, targetBranch, target.cwd, source);
    else cherryPickCommit(target.cwd, source);
  } finally {
    if (target.temporary) removeTemporaryWorktree(root, target.cwd);
  }
  return worktreeInfo();
}

function mergeTargetIntoCurrentBranch(root: string, rawCommit?: unknown): WorktreeInfo {
  const targetBranch = readTargetBranch(root);
  const current = currentBranch(root);
  if (!current) throw new Error("Could not resolve current branch");
  if (current === targetBranch) return worktreeInfo();
  if (!gitCommitRef(root, current)) throw new Error(`Current branch ${current} was not found`);
  ensureLocalTargetBranch(root, targetBranch);
  const hasCommit = rawCommit !== undefined && rawCommit !== null && String(rawCommit).trim() !== "";
  const source = hasCommit ? targetIncomingCommitRef(root, targetBranch, current, rawCommit) : targetBranch;
  const sourceLabel = hasCommit ? String(rawCommit).trim() : targetBranch;
  const conflictReason = currentMergeConflictReasons(root, [source]).get(source) ?? "";
  if (conflictReason) throw new Error(`Cannot merge ${sourceLabel} into ${current}: ${conflictReason}`);

  const attachedBranch = captureGit(["branch", "--show-current"], root);
  const before = captureGit(["rev-parse", "HEAD"], root);
  if (!before) throw new Error("Could not resolve current HEAD");

  if (!attachedBranch) {
    const branchHead = gitCommitRef(root, current);
    if (branchHead !== before) throw new Error(`Detached HEAD does not match ${current}; checkout the branch before merging`);
    const activePath = worktreePathForBranch(root, current);
    if (activePath && resolve(activePath) !== resolve(root)) {
      throw new Error(`Current branch ${current} is checked out at ${activePath}`);
    }
  }

  mergeSource(root, source);

  if (!attachedBranch) {
    const after = captureGit(["rev-parse", "HEAD"], root);
    if (!after) throw new Error("Could not resolve merged HEAD");
    if (after !== before) execFileSync("git", ["update-ref", `refs/heads/${current}`, after, before], { cwd: root, encoding: "utf8" });
  }

  return worktreeInfo();
}

function formatWorktreeInfo(
  root: string,
  name = readWorktreeName(root),
  options: { branch?: string; isLinked?: boolean } = {},
): WorktreeInfo {
  const branch = options.branch ?? currentBranch(root);
  const detachedHash = branch ? "" : captureGit(["rev-parse", "--short", "HEAD"], root) ?? "";
  const branchLabel = branch || (detachedHash ? `detached ${detachedHash}` : "");
  const targetBranch = readTargetBranch(root);
  const pendingBase = pendingBaseRef(root, targetBranch);
  const isMain = branch === "main";
  const isLinked = Boolean(options.isLinked);
  const codexMatch = root.match(/[\\/]\.codex[\\/]worktrees[\\/]([^\\/]+)/);
  const id = codexMatch?.[1] ?? (branchLabel || basename(root));
  const defaultLabel = branchLabel || (isLinked ? `worktree ${id}` : basename(root));
  const displayName = isLinked ? name : "";
  const label = isMain ? "main" : displayName ? `${displayName} · ${defaultLabel}` : defaultLabel;
  const fullLabel = isMain
    ? `main -> ${targetBranch} · ${root}`
    : displayName
      ? `${displayName} · ${defaultLabel} -> ${targetBranch} · ${root}`
      : `${defaultLabel} -> ${targetBranch} · ${root}`;
  return {
    root,
    id,
    name,
    defaultLabel,
    label,
    fullLabel,
    branch,
    targetBranch,
    pendingBase,
    branches: branchOptions(root),
    isMain,
    isLinked,
    hasTargetUpdates: incomingGitCommitRefs(root, targetBranch, branch).length > 0,
    pendingCommits: pendingGitCommits(root, targetBranch, branch),
    incomingCommits: incomingGitCommits(root, targetBranch, branch),
    commits: recentGitCommits(root),
    changes: currentGitChanges(root),
  };
}

/** The repo/worktree currently serving this client during local dev. */
function worktreeInfo(): WorktreeInfo {
  const root = captureGit(["rev-parse", "--show-toplevel"]);
  const gitDir = captureGit(["rev-parse", "--git-dir"]);
  const commonDir = captureGit(["rev-parse", "--git-common-dir"]);
  if (!root || !gitDir || !commonDir) {
    return emptyWorktreeInfo();
  }
  const isLinked = resolve(root, gitDir) !== resolve(root, commonDir);
  const branch = currentBranch(root);
  return formatWorktreeInfo(root, readWorktreeName(root), { branch, isLinked });
}

interface PropEntry {
  id: string;
  name: string;
  model: string;
  x: number;
  z: number;
  scale: number;
  rotationY: number;
  collisionRadius?: number;
}

const propsPathFor = (root: string) => resolve(root, "public/props.json");
const modelsDirFor = (root: string) => resolve(root, "public/models");

function readProps(root: string): PropEntry[] {
  const p = propsPathFor(root);
  if (!existsSync(p)) return [];
  try {
    const arr = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeProps(root: string, props: PropEntry[]) {
  writeFileSync(propsPathFor(root), JSON.stringify(props, null, 2));
}

/** A url/name-safe slug for a prop's filename + id stem. */
const slug = (s: string) =>
  String(s || "prop")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "prop";

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

const sendJson = (res: ServerResponse, obj: unknown) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
};
const fail = (res: ServerResponse, code: number, msg: string) => {
  res.statusCode = code;
  res.end(msg);
};

// In-memory LRU-ish cache for the /__asset-cache image proxy (process lifetime). The browser's
// HTTP cache (immutable headers below) is the real persistence across reloads; this just avoids
// re-hitting the upstream host when the browser cache is cold but the dev server is still up.
const ASSET_CACHE_MAX_BYTES = 16 * 1024 * 1024; // don't memory-cache pathologically large blobs
const ASSET_CACHE_MAX_ENTRIES = 256;
const assetCache = new Map<string, { buf: Buffer; ct: string }>();

const DEV_TUNING_CONSTANTS: Record<string, { name: string; min: number; max: number; integer?: boolean }> = {
  waveFirstDelayMs: { name: "WAVE_FIRST_DELAY_MS", min: 0, max: 600_000, integer: true },
  waveIntervalBaseMs: { name: "WAVE_INTERVAL_BASE_MS", min: 0, max: 900_000, integer: true },
  waveIntervalStepMs: { name: "WAVE_INTERVAL_STEP_MS", min: 0, max: 300_000, integer: true },
  waveIntervalMaxMs: { name: "WAVE_INTERVAL_MAX_MS", min: 0, max: 1_800_000, integer: true },
  waveSpawnSpreadMs: { name: "WAVE_SPAWN_SPREAD_MS", min: 0, max: 300_000, integer: true },
  waveSizeBase: { name: "WAVE_SIZE_BASE", min: 0, max: 200, integer: true },
  waveSizePerPlayer: { name: "WAVE_SIZE_PER_PLAYER", min: 0, max: 50, integer: true },
  waveSizePerWave: { name: "WAVE_SIZE_PER_WAVE", min: 0, max: 50, integer: true },
  waveSizeMax: { name: "WAVE_SIZE_MAX", min: 1, max: 500, integer: true },
  goblinLiveCap: { name: "GOBLIN_LIVE_CAP", min: 0, max: 500, integer: true },
  playerAttackCooldownMs: { name: "ATTACK_COOLDOWN_MS", min: 0, max: 10_000, integer: true },
  playerAttackWindupMs: { name: "ATTACK_WINDUP_MS", min: 0, max: 5_000, integer: true },
  enemyAttackCooldownMs: { name: "GOBLIN_ATTACK_COOLDOWN_MS", min: 0, max: 20_000, integer: true },
  enemyAttackWindupMs: { name: "GOBLIN_ATTACK_WINDUP_MS", min: 0, max: 10_000, integer: true },
  enemyAttackRange: { name: "GOBLIN_ATTACK_RANGE", min: 0.2, max: 20 },
  enemyAggroRadius: { name: "GOBLIN_AGGRO_RADIUS", min: 0, max: 80 },
  enemyDeaggroRadius: { name: "GOBLIN_DEAGGRO_RADIUS", min: 0, max: 120 },
  goblinHouseDamage: { name: "GOBLIN_HOUSE_DAMAGE", min: 0, max: 1_000 },
  damageDivisor: { name: "DAMAGE_DIVISOR", min: 0.1, max: 100 },
  playerRespawnMs: { name: "PLAYER_RESPAWN_MS", min: 0, max: 120_000, integer: true },
  playerMaxHp: { name: "PLAYER_MAX_HP", min: 1, max: 100_000, integer: true },
  playerAttack: { name: "PLAYER_ATTACK", min: 0, max: 100_000 },
  playerArmor: { name: "PLAYER_ARMOR", min: 0, max: 100_000 },
  playerCritChance: { name: "PLAYER_CRIT_CHANCE", min: 0, max: 1 },
  playerMoveSpeed: { name: "MOVE_SPEED", min: 0.1, max: 100 },
  sprintSpeedMult: { name: "SPRINT_SPEED_MULT", min: 1, max: 10 },
  hungerDrainPerMin: { name: "HUNGER_DRAIN_PER_MIN", min: 0, max: 600 },
  starvationDamagePerSec: { name: "STARVATION_DAMAGE_PER_SEC", min: 0, max: 1_000 },
  foodHungerMult: { name: "FOOD_HUNGER_MULT", min: 0, max: 50 },
  foodHpMult: { name: "FOOD_HP_MULT", min: 0, max: 50 },
  foodStaminaMult: { name: "FOOD_STAMINA_MULT", min: 0, max: 50 },
  enemyMaxHp: { name: "GOBLIN_MAX_HP", min: 1, max: 100_000, integer: true },
  enemyAttack: { name: "GOBLIN_ATTACK", min: 0, max: 100_000 },
  enemyMoveSpeed: { name: "GOBLIN_CHASE_SPEED", min: 0, max: 100 },
  berserkerAttackMult: { name: "BERSERKER_ATTACK_MULT", min: 1, max: 50 },
  berserkerDurationMs: { name: "BERSERKER_DURATION_MS", min: 0, max: 600_000, integer: true },
  dropRateMult: { name: "DROP_RATE_MULT", min: 0, max: 10 },
};

function formatConstantValue(value: number, integer?: boolean): string {
  if (integer) return String(Math.round(value));
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function writeGameplayDefault(root: string, rawKey: unknown, rawValue: unknown): { key: string; constant: string; value: number } {
  const key = String(rawKey || "");
  const rule = DEV_TUNING_CONSTANTS[key];
  if (!rule) throw new Error(`unknown tuning key: ${key}`);
  const n = Number(rawValue);
  if (!Number.isFinite(n)) throw new Error("value must be a finite number");
  const clamped = Math.max(rule.min, Math.min(rule.max, n));
  const value = rule.integer ? Math.round(clamped) : clamped;
  const constantsPath = resolve(root, "../shared/src/constants.ts");
  const src = readFileSync(constantsPath, "utf8");
  const literal = formatConstantValue(value, rule.integer);
  const pattern = new RegExp(`(export\\s+const\\s+${rule.name}\\s*=\\s*)[-+]?\\d[\\d_]*(?:\\.\\d+)?`, "m");
  if (!pattern.test(src)) throw new Error(`constant not found: ${rule.name}`);
  writeFileSync(constantsPath, src.replace(pattern, (_match, prefix: string) => `${prefix}${literal}`));
  return { key, constant: rule.name, value };
}

/** Build a manifest entry from a meta object + a (already-written) model url. */
function entryFromMeta(meta: Record<string, unknown>, model: string, id: string): PropEntry {
  const entry: PropEntry = {
    id,
    name: String(meta.name ?? id),
    model,
    x: Number(meta.x) || 0,
    z: Number(meta.z) || 0,
    scale: Number(meta.scale) || 1,
    rotationY: Number(meta.rotationY) || 0,
  };
  const cr = Number(meta.collisionRadius);
  if (cr > 0) entry.collisionRadius = cr; // concrete → blocks movement
  return entry;
}

// ---- Custom characters (imported Meshy zips) ----
// A CharacterDef is the reusable template (base mesh + per-action animation glbs +
// orientation/scale + placeholder stats); npcs.json holds placements of a def.
type CharAction = "IDLE" | "WALK" | "ATTACK" | "THROW" | "HIT" | "DEAD";
interface CharAnim {
  file: string; // url under /models
  speed?: number;
  yawFix?: number; // radians, per-clip facing correction
}
// Local bookkeeping for defs that have been published to / imported from the
// community (Nostr kind 30333). Mirrors @rpg/shared CommunityProvenance.
interface CommunityProvenance {
  pubkey: string;
  d: string;
  ts: number;
  imported?: boolean;
}
interface CharacterDef {
  id: string;
  name: string;
  category?: string;
  description?: string;
  baseModel: string; // url under /models
  anims: Partial<Record<CharAction, CharAnim>>;
  yaw: number; // base orientation (radians)
  scale: number;
  stats?: CharacterStatsConfig;
  community?: CommunityProvenance;
}
interface Placement {
  id: string;
  defId: string;
  x: number;
  z: number;
  rotationY: number;
  scale?: number;
  brain?: BrainId;
  stats?: CharacterStatsConfig;
}

const charsPathFor = (root: string) => resolve(root, "public/characters.json");
const npcsPathFor = (root: string) => resolve(root, "public/npcs.json");
const spawnersPathFor = (root: string) => resolve(root, "public/spawners.json");
const wavesPathFor = (root: string) => resolve(root, "public/waves.json");
const resourcesPathFor = (root: string) => resolve(root, "public/resources.json");
const structuresPathFor = (root: string) => resolve(root, "public/structures.json");
const entityFeaturesPathFor = (root: string) => resolve(root, "public/entity-features.json");
const itemsPathFor = (root: string) => resolve(root, "public/items.json");
const itemAssetsDirFor = (root: string) => resolve(root, "public/items");
const structuresLibPathFor = (root: string) => resolve(root, "public/structures-lib.json");

// Per-structure-kind loot table: a list of {item, amount, probability} rolled
// independently when the structure is destroyed. Read live by the server.
interface LootEntry {
  item: string;
  amount: number;
  probability: number; // 0..1
}

interface StructureMask {
  type: "polygon";
  points: { x: number; z: number }[];
}

interface StructureCfg {
  loot?: LootEntry[];
  mask?: StructureMask;
}

function sanitizeStructureMask(raw: unknown): StructureMask | undefined {
  const obj = raw as { type?: unknown; points?: unknown } | null;
  if (!obj || obj.type !== "polygon" || !Array.isArray(obj.points)) return undefined;
  const points = obj.points
    .slice(0, 64)
    .map((p) => {
      const point = p as { x?: unknown; z?: unknown };
      const x = Number(point.x);
      const z = Number(point.z);
      return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
    })
    .filter((p): p is { x: number; z: number } => !!p);
  return points.length >= 3 ? { type: "polygon", points } : undefined;
}

interface ItemDef {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  model?: string;
  stack?: number;
  worldScale?: number;
  community?: CommunityProvenance;
}

// A creator-authored structure: a single .glb prop with placement physics +
// optional destructible HP. Stored in public/structures-lib.json (the "structure"
// half of the Library), distinct from props.json placements.
interface StructureDef {
  id: string;
  name: string;
  description?: string;
  model: string; // url under /models
  scale: number;
  collisionRadius?: number;
  hp?: number;
  stats?: CharacterStatsConfig;
  community?: CommunityProvenance;
}

// Per-resource-kind drop config: which item a tree/rock yields, how many, on hit
// (progressive) or kill (full), and the resource's total HP (drives the drop rate:
// hp/amount damage per item). Read live by the server.
interface DropCfg {
  item: string;
  amount: number;
  trigger: "hit" | "kill";
  hp: number;
}

// A spawner makes an object spawn goblins on a timer. `behavior` overrides the
// global goblin constants for the goblins this spawner produces (0/undef = default).
interface SpawnerBehavior {
  hp?: number;
  attack?: number;
  aggroRadius?: number;
  chaseSpeed?: number;
  attackCooldownMs?: number;
  houseDamage?: number;
  brain?: BrainId;
  modelId?: string;
  label?: string;
  stats?: CharacterStatsConfig;
}
interface Spawner {
  id: string; // unique spawn rule id
  ownerId: string; // selected structure/object id; the spawn point is derived from it
  type?: string; // goblin | dummy | npc | tree | ...
  modelId?: string;
  label?: string;
  intervalMs: number;
  cap: number; // max live goblins from this spawner
  behavior?: SpawnerBehavior;
}

type BrainId = "idle" | "passive_patrol" | "war_seeker" | "attacks_home";
interface CharacterStatsConfig {
  maxHp?: number;
  attack?: number;
  armor?: number;
  critChance?: number;
  moveSpeed?: number;
  throwPower?: number;
  level?: number;
  xp?: number;
}
interface FeatureDrop {
  item: string;
  quantity: number;
  probability: number;
  trigger: "kill" | "damage";
}

function normalizeSpawnerEntry(raw: Record<string, unknown>): Spawner | null {
  const id = String(raw.id || "");
  const ownerId = String(raw.ownerId || "");
  if (!id || !ownerId) return null;
  const behavior = raw.behavior && typeof raw.behavior === "object"
    ? raw.behavior as SpawnerBehavior
    : {};
  const modelId = raw.modelId ? String(raw.modelId) : behavior.modelId;
  const label = raw.label ? String(raw.label) : behavior.label;
  return {
    id,
    ownerId,
    type: String(raw.type || (modelId ? "npc" : "goblin")),
    ...(modelId ? { modelId } : {}),
    ...(label ? { label } : {}),
    intervalMs: Math.max(200, Number(raw.intervalMs) || 4000),
    cap: Math.max(0, Math.min(50, Number(raw.cap) || 3)),
    behavior,
  };
}

function readSpawners(root: string): Spawner[] {
  return readJsonArray<Record<string, unknown>>(spawnersPathFor(root))
    .map((s) => normalizeSpawnerEntry(s))
    .filter((s): s is Spawner => Boolean(s));
}

function deleteSpawnersForOwners(root: string, ownerIds: string[]): void {
  const owners = new Set(ownerIds.filter(Boolean));
  if (!owners.size) return;
  const list = readSpawners(root);
  writeJsonArray(spawnersPathFor(root), list.filter((s) => !owners.has(s.ownerId)));
}
interface EntityFeatureConfig {
  hp?: number;
  brain?: BrainId;
  stats?: CharacterStatsConfig;
  drops?: FeatureDrop[];
}
interface EntityFeatureManifest {
  defaults?: Record<string, EntityFeatureConfig>;
  instances?: Record<string, EntityFeatureConfig>;
}
const charDirFor = (root: string) => resolve(root, "public/models/characters");

// In-memory memo of parsed content files, keyed by path + invalidated by mtime —
// a server-side cache so the Library's defs endpoints don't re-read/parse from disk
// on every poll. A write bumps the file's mtime, so the next read re-parses.
const jsonMemo = new Map<string, { mtimeMs: number; data: unknown[] }>();
function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) {
    jsonMemo.delete(path);
    return [];
  }
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const hit = jsonMemo.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data as T[];
    const arr = JSON.parse(readFileSync(path, "utf8"));
    const data = Array.isArray(arr) ? arr : [];
    jsonMemo.set(path, { mtimeMs, data });
    return data as T[];
  } catch {
    return [];
  }
}
const writeJsonArray = (path: string, arr: unknown[]) => {
  writeFileSync(path, JSON.stringify(arr, null, 2));
  // Refresh the memo immediately so a read right after a write is consistent
  // (fs mtime resolution can be coarse on some platforms).
  try {
    jsonMemo.set(path, { mtimeMs: statSync(path).mtimeMs, data: Array.isArray(arr) ? arr : [] });
  } catch {
    jsonMemo.delete(path);
  }
};

/** Run git, returning stdout or null if git fails / this isn't a repo. */
function gitText(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

interface PendingResult {
  characters: string[];
  structures: string[];
  items: string[];
}

/**
 * Compute which Library entities are *pending* (not yet committed to git). An entity
 * is pending if its def is new/changed vs HEAD's content JSON, or if any asset file
 * it references is untracked/modified in the working tree. Defensive: returns empty
 * sets when this isn't a git repo so the Library simply shows nothing as pending.
 */
function computePending(root: string): PendingResult {
  const empty: PendingResult = { characters: [], structures: [], items: [] };
  const repoRoot = gitText(root, ["rev-parse", "--show-toplevel"])?.trim();
  if (!repoRoot) return empty;
  const publicRel = relative(repoRoot, resolve(root, "public")).split(sep).join("/");

  // Files under public/models + public/items that are untracked or modified.
  const status = gitText(repoRoot, ["status", "--porcelain", "--", `${publicRel}/models`, `${publicRel}/items`]) ?? "";
  const dirtyAssets = new Set<string>();
  for (const line of status.split("\n")) {
    const p = line.slice(3).trim(); // "XY <path>" → path (repo-root-relative)
    if (!p) continue;
    const url = p.startsWith(publicRel + "/") ? p.slice(publicRel.length) : null; // → "/models/…" | "/items/…"
    if (url) dirtyAssets.add(url);
  }

  const idsFor = <T extends { id: string }>(file: string, assetUrls: (d: T) => string[]): string[] => {
    const current = readJsonArray<T>(file);
    if (!current.length) return [];
    const headRaw = gitText(repoRoot, ["show", `HEAD:${publicRel}/${basename(file)}`]);
    let head: T[] = [];
    if (headRaw) {
      try {
        const parsed = JSON.parse(headRaw);
        if (Array.isArray(parsed)) head = parsed;
      } catch {
        /* committed file unparsable → treat everything as pending */
      }
    }
    const headById = new Map(head.map((d) => [d.id, JSON.stringify(d)]));
    return current
      .filter((d) => {
        const prev = headById.get(d.id);
        if (prev === undefined || prev !== JSON.stringify(d)) return true; // new or changed
        return assetUrls(d).some((u) => u && dirtyAssets.has(u)); // committed def, dirty asset
      })
      .map((d) => d.id);
  };

  return {
    characters: idsFor<CharacterDef>(charsPathFor(root), (d) => [
      d.baseModel,
      ...Object.values(d.anims ?? {}).map((a) => a?.file ?? ""),
    ]),
    structures: idsFor<StructureDef>(structuresLibPathFor(root), (d) => [d.model]),
    items: idsFor<ItemDef>(itemsPathFor(root), (d) => [d.icon ?? "", d.model ?? ""]),
  };
}

/** Classify an unzipped glb: the base mesh vs a single-animation file, deriving a
 *  clip label from the Meshy naming "..._Animation_<Clip>_withSkin.glb". */
function classifyGlb(file: string): { kind: "base" | "anim"; clip: string } {
  if (/character_output/i.test(file)) return { kind: "base", clip: "base" };
  const m = file.match(/_Animation_(.+?)_withSkin\.glb$/i);
  if (m) return { kind: "anim", clip: m[1] };
  return { kind: "anim", clip: file.replace(/\.glb$/i, "") };
}

/**
 * Dev-only endpoints for the in-game model importer / Dev Mode world editor. They
 * read & write public/props.json (which the client renders and the server reads
 * for collision) plus the public/models folder:
 *   POST /__props/add     raw .glb body + ?meta=<json>  → write model + append entry
 *   POST /__props/place   json {model, ...meta}         → append entry for an existing model
 *   POST /__props/update  json {id, ...fields}          → patch an entry in place
 *   POST /__props/delete  json {id, deleteFile?}        → drop an entry (+ maybe its file)
 *   GET  /__props/models                                → list every available .glb
 */
function modelImporter(): Plugin {
  return {
    name: "rpg-model-importer",
    configureServer(server: ViteDevServer) {
      const root = server.config.root; // packages/client

      // ---- add: upload a new .glb and place it ----
      server.middlewares.use("/__props/add", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        const url = new URL(req.url || "", "http://localhost");
        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(url.searchParams.get("meta") || "{}");
        } catch {
          return fail(res, 400, "bad meta");
        }
        void collectBody(req).then((buf) => {
          try {
            if (buf.length === 0) return fail(res, 400, "empty body");
            const base = slug(String(meta.name || "prop"));
            const dir = modelsDirFor(root);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const id = `${base}_${Date.now()}`;
            const file = `${id}.glb`;
            writeFileSync(resolve(dir, file), buf);

            const props = readProps(root);
            const entry = entryFromMeta(meta, `/models/${file}`, id);
            props.push(entry);
            writeProps(root, props);
            sendJson(res, { ok: true, id: entry.id, model: entry.model, name: entry.name });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ---- place: append an entry for a model that already exists on disk ----
      server.middlewares.use("/__props/place", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const meta = JSON.parse(buf.toString("utf8") || "{}");
            const model = String(meta.model || "");
            if (!/^\/models\/[\w.-]+\.glb$/i.test(model)) return fail(res, 400, "bad model");
            const id = `${slug(String(meta.name || model.split("/").pop()))}_${Date.now()}`;
            const props = readProps(root);
            const entry = entryFromMeta(meta, model, id);
            props.push(entry);
            writeProps(root, props);
            sendJson(res, { ok: true, id: entry.id, model: entry.model, name: entry.name });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ---- update: patch fields of an existing entry (by id, or model url) ----
      server.middlewares.use("/__props/update", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const patch = JSON.parse(buf.toString("utf8") || "{}");
            const key = String(patch.id ?? "");
            const props = readProps(root);
            const e = props.find((p) => p.id === key || p.model === key);
            if (!e) return fail(res, 404, "no such prop");
            const rec = e as unknown as Record<string, unknown>;
            for (const f of ["name", "x", "z", "scale", "rotationY"] as const) {
              if (patch[f] !== undefined) rec[f] = f === "name" ? String(patch[f]) : Number(patch[f]);
            }
            if (patch.collisionRadius !== undefined) {
              const cr = Number(patch.collisionRadius);
              if (cr > 0) e.collisionRadius = cr;
              else delete e.collisionRadius; // concrete toggled off
            }
            if (!e.id) e.id = key; // backfill id on legacy entries
            writeProps(root, props);
            sendJson(res, { ok: true, id: e.id });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ---- delete: drop an entry, optionally unlinking its now-unused model ----
      server.middlewares.use("/__props/delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const body = JSON.parse(buf.toString("utf8") || "{}");
            const key = String(body.id ?? "");
            const props = readProps(root);
            const e = props.find((p) => p.id === key || p.model === key);
            if (!e) return fail(res, 404, "no such prop");
            const kept = props.filter((p) => p !== e);
            writeProps(root, kept);
            // only delete the file if nothing else references it (and it's an uploaded model)
            if (body.deleteFile && e.model && !kept.some((p) => p.model === e.model)) {
              const file = resolve(modelsDirFor(root), e.model.replace(/^\/models\//, ""));
              if (existsSync(file)) {
                try {
                  unlinkSync(file);
                } catch {
                  /* leave the file if it can't be removed */
                }
              }
            }
            deleteSpawnersForOwners(root, [key, e.id, e.model]);
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ---- models: list every .glb available to place from the library ----
      server.middlewares.use("/__props/models", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        try {
          const dir = modelsDirFor(root);
          const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.glb$/i.test(f)) : [];
          const models = files.map((f) => ({
            name: f.replace(/\.glb$/i, ""),
            model: `/models/${f}`,
            size: statSync(resolve(dir, f)).size,
          }));
          sendJson(res, models);
        } catch (e) {
          fail(res, 500, String(e));
        }
      });

      // ======== Custom-character endpoints (imported Meshy zips) ========

      // import: upload a character .zip → unzip (flattened) into
      // public/models/characters/<id>/ and return the classified .glb list.
      server.middlewares.use("/__char/import", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        const url = new URL(req.url || "", "http://localhost");
        const name = slug(url.searchParams.get("name") || "character");
        void collectBody(req).then((buf) => {
          try {
            if (buf.length === 0) return fail(res, 400, "empty body");
            const baseDir = charDirFor(root);
            if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
            const id = `${name}_${Date.now()}`;
            const outDir = resolve(baseDir, id);
            mkdirSync(outDir, { recursive: true });
            const zipPath = resolve(baseDir, `${id}.zip`);
            writeFileSync(zipPath, buf);
            try {
              execFileSync("unzip", ["-o", "-j", zipPath, "-d", outDir], { stdio: "ignore" });
            } finally {
              try {
                unlinkSync(zipPath);
              } catch {
                /* leave the temp zip if it can't be removed */
              }
            }
            const glbs = readdirSync(outDir).filter((f) => /\.glb$/i.test(f));
            if (!glbs.length) return fail(res, 400, "no .glb files in zip");
            const files = glbs.map((f) => {
              const c = classifyGlb(f);
              return {
                name: f,
                path: `/models/characters/${id}/${f}`,
                kind: c.kind,
                clip: c.clip,
                size: statSync(resolve(outDir, f)).size,
              };
            });
            sendJson(res, { ok: true, id, dir: `/models/characters/${id}`, files });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // save: upsert a CharacterDef (the reusable template) into characters.json
      server.middlewares.use("/__char/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const def = JSON.parse(buf.toString("utf8") || "{}") as CharacterDef;
            if (!def.id || !def.baseModel) return fail(res, 400, "missing id/baseModel");
            const defs = readJsonArray<CharacterDef>(charsPathFor(root));
            const i = defs.findIndex((d) => d.id === def.id);
            if (i >= 0) defs[i] = def;
            else defs.push(def);
            writeJsonArray(charsPathFor(root), defs);
            sendJson(res, { ok: true, id: def.id });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // defs: list saved character templates (the library)
      server.middlewares.use("/__char/defs", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readJsonArray<CharacterDef>(charsPathFor(root)));
      });

      // place: append a placement (instance) of a def into npcs.json
      server.middlewares.use("/__char/place", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const defId = String(b.defId || "");
            if (!defId) return fail(res, 400, "missing defId");
            const id = `npc_${Date.now()}`;
            const placement: Placement = {
              id,
              defId,
              x: Number(b.x) || 0,
              z: Number(b.z) || 0,
              rotationY: Number(b.rotationY) || 0,
              scale: Math.max(0.05, Number(b.scale) || 1),
              ...(b.brain ? { brain: String(b.brain) as BrainId } : {}),
              ...(b.stats && typeof b.stats === "object" ? { stats: b.stats } : {}),
            };
            const npcs = readJsonArray<Placement>(npcsPathFor(root));
            npcs.push(placement);
            writeJsonArray(npcsPathFor(root), npcs);
            sendJson(res, { ok: true, id });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // placements: list placed character instances
      server.middlewares.use("/__char/placements", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readJsonArray<Placement>(npcsPathFor(root)));
      });

      // ======== Item-definition endpoints (dev-authored inventory items) ========
      server.middlewares.use("/__items/defs", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readJsonArray<ItemDef>(itemsPathFor(root)));
      });
      server.middlewares.use("/__items/upload", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        const url = new URL(req.url || "", "http://localhost");
        const kind = url.searchParams.get("kind") === "model" ? "model" : "icon";
        const base = slug(url.searchParams.get("name") || "item");
        const rawFile = url.searchParams.get("filename") || "";
        const rawExt = (rawFile.match(/\.[a-z0-9]+$/i)?.[0] || "").toLowerCase();
        const ext =
          kind === "model"
            ? ".glb"
            : [".png", ".jpg", ".jpeg", ".webp"].includes(rawExt)
              ? rawExt
              : ".png";
        void collectBody(req).then((buf) => {
          try {
            if (!buf.length) return fail(res, 400, "empty body");
            const dir = itemAssetsDirFor(root);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const file = `${base}_${kind}_${Date.now()}${ext}`;
            writeFileSync(resolve(dir, file), buf);
            sendJson(res, { ok: true, url: `/items/${file}` });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__items/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const raw = JSON.parse(buf.toString("utf8") || "{}") as ItemDef;
            const id = slug(raw.id || raw.name || "item").slice(0, 48);
            if (!id) return fail(res, 400, "missing id");
            const entry: ItemDef = {
              id,
              name: String(raw.name || id).slice(0, 48),
              stack: Math.max(1, Math.min(999, Math.round(Number(raw.stack) || 99))),
              worldScale: Math.max(0.05, Math.min(20, Number(raw.worldScale) || 1.2)),
            };
            if (raw.description) entry.description = String(raw.description).slice(0, 500);
            if (raw.icon) entry.icon = String(raw.icon);
            if (raw.model) entry.model = String(raw.model);
            if (raw.community && typeof raw.community === "object") entry.community = raw.community;
            const items = readJsonArray<ItemDef>(itemsPathFor(root));
            const i = items.findIndex((x) => x.id === id);
            if (i >= 0) items[i] = entry;
            else items.push(entry);
            writeJsonArray(itemsPathFor(root), items);
            sendJson(res, { ok: true, item: entry });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__items/delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const id = String(b.id || "");
            const items = readJsonArray<ItemDef>(itemsPathFor(root));
            writeJsonArray(itemsPathFor(root), items.filter((x) => x.id !== id));
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Structure-library defs (creator-authored .glb structures) ========
      // A "structure" library entry: a single model + placement physics, stored in
      // public/structures-lib.json. The model file lives under public/models.
      server.middlewares.use("/__structures/defs", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readJsonArray<StructureDef>(structuresLibPathFor(root)));
      });
      // Write a .glb under public/models WITHOUT placing it (creator step 2).
      server.middlewares.use("/__structures/upload", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        const url = new URL(req.url || "", "http://localhost");
        const base = slug(url.searchParams.get("name") || "structure");
        void collectBody(req).then((buf) => {
          try {
            if (!buf.length) return fail(res, 400, "empty body");
            const dir = modelsDirFor(root);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const file = `${base}_${Date.now()}.glb`;
            writeFileSync(resolve(dir, file), buf);
            sendJson(res, { ok: true, model: `/models/${file}` });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__structures/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const def = JSON.parse(buf.toString("utf8") || "{}") as StructureDef;
            if (!def.id || !def.model) return fail(res, 400, "missing id/model");
            const defs = readJsonArray<StructureDef>(structuresLibPathFor(root));
            const i = defs.findIndex((d) => d.id === def.id);
            if (i >= 0) defs[i] = def;
            else defs.push(def);
            writeJsonArray(structuresLibPathFor(root), defs);
            sendJson(res, { ok: true, id: def.id });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__structures/delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const id = String(b.id || "");
            const defs = readJsonArray<StructureDef>(structuresLibPathFor(root));
            const gone = defs.find((d) => d.id === id);
            writeJsonArray(structuresLibPathFor(root), defs.filter((d) => d.id !== id));
            if (b.deleteFiles && gone?.model?.startsWith("/models/")) {
              const f = resolve(root, "public", gone.model.replace(/^\//, ""));
              if (existsSync(f) && relative(modelsDirFor(root), f).startsWith("..") === false) unlinkSync(f);
            }
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Pending (git-tracked) state + char def delete ========
      // Which Library entities are not yet committed to git (→ "pending" badge).
      server.middlewares.use("/__content/pending", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        try {
          sendJson(res, computePending(root));
        } catch (e) {
          fail(res, 500, String(e));
        }
      });

      // asset-cache: proxy a remote (e.g. Blossom) image through our own origin so the browser
      // HTTP-caches it with immutable headers. Blossom sends no cache-control AND its CDN blocks
      // cross-origin fetch via CORS, so a raw <img src> re-fetches on every Library reopen (the
      // flash) and a client-side blob cache is impossible. Fetching server-side (no CORS) once and
      // serving with immutable headers makes every reopen a same-origin disk-cache hit. Dev-only;
      // mirrors the import-remote "download server-side to avoid browser CORS" approach.
      server.middlewares.use("/__asset-cache", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        void (async () => {
          try {
            const u = new URL(req.url || "", "http://localhost").searchParams.get("u") || "";
            if (!/^https?:\/\//i.test(u)) return fail(res, 400, "u must be an http(s) URL");
            const key = createHash("sha256").update(u).digest("hex");
            const serve = (buf: Buffer, ct: string) => {
              res.statusCode = 200;
              res.setHeader("content-type", ct);
              res.setHeader("cache-control", "public, max-age=31536000, immutable");
              res.setHeader("access-control-allow-origin", "*");
              res.end(buf);
            };
            const hit = assetCache.get(key);
            if (hit) return serve(hit.buf, hit.ct);
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 15_000);
            const r = await fetch(u, { redirect: "follow", signal: ac.signal }).finally(() => clearTimeout(timer));
            if (!r.ok) return fail(res, 502, `upstream ${r.status}`);
            const declared = Number(r.headers.get("content-length") || 0);
            if (declared > ASSET_CACHE_MAX_BYTES) return fail(res, 413, "upstream too large");
            const ct = r.headers.get("content-type") || "application/octet-stream";
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.byteLength <= ASSET_CACHE_MAX_BYTES) {
              assetCache.set(key, { buf, ct });
              while (assetCache.size > ASSET_CACHE_MAX_ENTRIES) {
                const oldest = assetCache.keys().next().value;
                if (oldest === undefined) break;
                assetCache.delete(oldest);
              }
            }
            serve(buf, ct);
          } catch (e) {
            fail(res, 502, String(e));
          }
        })();
      });
      // Remove a character def from the library (Library "Remove" on a pending card).
      server.middlewares.use("/__char/def-delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const id = String(b.id || "");
            if (!id) return fail(res, 400, "missing id");
            const defs = readJsonArray<CharacterDef>(charsPathFor(root));
            writeJsonArray(charsPathFor(root), defs.filter((d) => d.id !== id));
            // Delete the character's model dir if asked (public/models/characters/<id>).
            if (b.deleteFiles) {
              const dir = resolve(charDirFor(root), id);
              if (existsSync(dir) && relative(charDirFor(root), dir).startsWith("..") === false) {
                rmSync(dir, { recursive: true, force: true });
              }
            }
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // import-remote: copy a community entity (kind-30333) into the LOCAL library.
      // Downloads each Blossom asset server-side (avoids browser CORS), rewrites the
      // def with local paths, and stamps community provenance (imported = true) so the
      // Library shows it as a pending, owner-attributed import.
      server.middlewares.use("/__content/import-remote", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          void (async () => {
            try {
              const body = JSON.parse(buf.toString("utf8") || "{}") as {
                type?: string;
                author?: string;
                entity?: CommunityEntity;
              };
              const { type, entity } = body;
              if (!entity || !type) return fail(res, 400, "missing type/entity");
              const provenance: CommunityProvenance = {
                pubkey: String(body.author || ""),
                d: `gorilator-entity-v1:${entity.id}`, // matches @rpg/shared entityDTag(entity.id)
                ts: Date.now(),
                imported: true,
              };
              const download = async (url: string, abs: string) => {
                const r = await fetch(url);
                if (!r.ok) throw new Error(`download ${url} → ${r.status}`);
                writeFileSync(abs, Buffer.from(await r.arrayBuffer()));
              };

              if (type === "character" && entity.character) {
                const c = entity.character;
                const existing = new Set(readJsonArray<CharacterDef>(charsPathFor(root)).map((d) => d.id));
                const id = existing.has(entity.id) ? `${entity.id}_${Date.now()}` : entity.id;
                const dir = resolve(charDirFor(root), id);
                mkdirSync(dir, { recursive: true });
                await download(c.baseModel.url, resolve(dir, "base.glb"));
                const anims: CharacterDef["anims"] = {};
                for (const [action, a] of Object.entries(c.anims)) {
                  if (!a?.asset?.url) continue;
                  const file = `${action.toLowerCase()}.glb`;
                  await download(a.asset.url, resolve(dir, file));
                  (anims as Record<string, unknown>)[action] = {
                    file: `/models/characters/${id}/${file}`,
                    ...(a.speed ? { speed: a.speed } : {}),
                    ...(a.yawFix ? { yawFix: a.yawFix } : {}),
                  };
                }
                const def: CharacterDef = {
                  id,
                  name: entity.name,
                  category: "Characters",
                  description: entity.description || undefined,
                  baseModel: `/models/characters/${id}/base.glb`,
                  anims,
                  yaw: c.yaw || 0,
                  scale: c.scale || 1,
                  stats: entity.stats,
                  community: provenance,
                };
                const defs = readJsonArray<CharacterDef>(charsPathFor(root));
                defs.push(def);
                writeJsonArray(charsPathFor(root), defs);
                return sendJson(res, { ok: true, id, type });
              }

              if (type === "structure" && entity.structure) {
                const s = entity.structure;
                const dir = modelsDirFor(root);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                const file = `${slug(entity.name)}_${Date.now()}.glb`;
                await download(s.model.url, resolve(dir, file));
                const def: StructureDef = {
                  id: `struct_${Date.now()}`,
                  name: entity.name,
                  description: entity.description || undefined,
                  model: `/models/${file}`,
                  scale: s.scale || 1,
                  collisionRadius: s.collisionRadius,
                  hp: s.hp,
                  stats: entity.stats,
                  community: provenance,
                };
                const defs = readJsonArray<StructureDef>(structuresLibPathFor(root));
                defs.push(def);
                writeJsonArray(structuresLibPathFor(root), defs);
                return sendJson(res, { ok: true, id: def.id, type });
              }

              if (type === "item" && entity.item) {
                const it = entity.item;
                const dir = itemAssetsDirFor(root);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                const base = slug(entity.name) || "item";
                const stamp = Date.now();
                const extOf = (url: string) => (url.match(/\.[a-z0-9]+(?:$|\?)/i)?.[0] || ".png").replace(/\?$/, "");
                let icon: string | undefined;
                let model: string | undefined;
                if (it.icon?.url) {
                  const f = `${base}_icon_${stamp}${extOf(it.icon.url)}`;
                  await download(it.icon.url, resolve(dir, f));
                  icon = `/items/${f}`;
                }
                if (it.model?.url) {
                  const f = `${base}_model_${stamp}.glb`;
                  await download(it.model.url, resolve(dir, f));
                  model = `/items/${f}`;
                }
                const existing = new Set(readJsonArray<ItemDef>(itemsPathFor(root)).map((d) => d.id));
                const id = existing.has(slug(entity.name)) ? `${slug(entity.name)}_${stamp}` : slug(entity.name) || `item_${stamp}`;
                const def: ItemDef = {
                  id,
                  name: entity.name,
                  description: entity.description || undefined,
                  icon,
                  model,
                  stack: it.stack ?? 99,
                  worldScale: it.worldScale ?? 1.2,
                  community: provenance,
                };
                const items = readJsonArray<ItemDef>(itemsPathFor(root));
                items.push(def);
                writeJsonArray(itemsPathFor(root), items);
                return sendJson(res, { ok: true, id, type });
              }

              return fail(res, 400, "unsupported entity payload");
            } catch (e) {
              fail(res, 500, String(e));
            }
          })();
        });
      });

      // placement-update: patch x/z/rotationY of a placement
      server.middlewares.use("/__char/placement-update", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const patch = JSON.parse(buf.toString("utf8") || "{}");
            const npcs = readJsonArray<Placement>(npcsPathFor(root));
            const p = npcs.find((n) => n.id === String(patch.id ?? ""));
            if (!p) return fail(res, 404, "no such placement");
            for (const f of ["x", "z", "rotationY", "scale"] as const)
              if (patch[f] !== undefined) p[f] = Number(patch[f]);
            if (patch.brain !== undefined) p.brain = String(patch.brain) as BrainId;
            if (patch.stats && typeof patch.stats === "object") p.stats = patch.stats;
            writeJsonArray(npcsPathFor(root), npcs);
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // placement-delete: remove a placement
      server.middlewares.use("/__char/placement-delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const npcs = readJsonArray<Placement>(npcsPathFor(root));
            const kept = npcs.filter((n) => n.id !== String(b.id ?? ""));
            writeJsonArray(npcsPathFor(root), kept);
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Generic entity feature config (HP / drops / brain / stats) ========
      const readFeatures = (): EntityFeatureManifest => {
        const p = entityFeaturesPathFor(root);
        if (!existsSync(p)) return { defaults: {}, instances: {} };
        try {
          const o = JSON.parse(readFileSync(p, "utf8"));
          return o && typeof o === "object" ? o : { defaults: {}, instances: {} };
        } catch {
          return { defaults: {}, instances: {} };
        }
      };
      const writeFeatures = (m: EntityFeatureManifest) => {
        writeFileSync(entityFeaturesPathFor(root), JSON.stringify({
          defaults: m.defaults ?? {},
          instances: m.instances ?? {},
        }, null, 2));
      };
      const sanitizeFeature = (raw: Record<string, unknown>): EntityFeatureConfig => {
        const out: EntityFeatureConfig = {};
        if (raw.hp !== undefined) out.hp = Math.max(0, Math.round(Number(raw.hp) || 0));
        if (raw.brain !== undefined) {
          const b = String(raw.brain);
          if (["idle", "passive_patrol", "war_seeker", "attacks_home"].includes(b)) out.brain = b as BrainId;
        }
        if (raw.stats && typeof raw.stats === "object") {
          const src = raw.stats as Record<string, unknown>;
          const stats: CharacterStatsConfig = {};
          for (const k of ["maxHp", "attack", "armor", "critChance", "moveSpeed", "throwPower", "level", "xp"] as const) {
            if (src[k] !== undefined && Number.isFinite(Number(src[k]))) stats[k] = Math.max(0, Number(src[k]));
          }
          if (Object.keys(stats).length) out.stats = stats;
        }
        if (Array.isArray(raw.drops)) {
          out.drops = raw.drops.slice(0, 40).map((d: Record<string, unknown>) => ({
            item: String(d.item || "log"),
            quantity: Math.max(0, Math.round(Number(d.quantity) || 0)),
            probability: Math.max(0, Math.min(1, Number(d.probability) || 0)),
            trigger: d.trigger === "damage" ? "damage" : "kill",
          }));
        }
        return out;
      };
      server.middlewares.use("/__features/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readFeatures());
      });
      server.middlewares.use("/__features/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}") as Record<string, unknown>;
            const scope = b.scope === "instance" ? "instances" : "defaults";
            const key = String(b.key || "");
            if (!key) return fail(res, 400, "missing key");
            const manifest = readFeatures();
            const bucket = scope === "instances"
              ? { ...(manifest.instances ?? {}) }
              : { ...(manifest.defaults ?? {}) };
            const next = sanitizeFeature((b.config && typeof b.config === "object" ? b.config : b) as Record<string, unknown>);
            bucket[key] = next;
            if (scope === "instances") manifest.instances = bucket;
            else manifest.defaults = bucket;
            writeFeatures(manifest);
            sendJson(res, { ok: true, scope, key });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__features/delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}") as Record<string, unknown>;
            const scope = b.scope === "instance" ? "instances" : "defaults";
            const key = String(b.key || "");
            if (!key) return fail(res, 400, "missing key");
            const manifest = readFeatures();
            const bucket = scope === "instances"
              ? { ...(manifest.instances ?? {}) }
              : { ...(manifest.defaults ?? {}) };
            delete bucket[key];
            if (scope === "instances") manifest.instances = bucket;
            else manifest.defaults = bucket;
            writeFeatures(manifest);
            sendJson(res, { ok: true, scope, key });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Gameplay tuning defaults (shared constants edited from Dev Mode) ========
      server.middlewares.use("/__gameplay/default", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}") as Record<string, unknown>;
            sendJson(res, { ok: true, ...writeGameplayDefault(root, b.key, b.value) });
          } catch (e) {
            fail(res, 400, String(e));
          }
        });
      });

      // ======== Spawner endpoints (objects that spawn goblins) ========
      server.middlewares.use("/__spawners/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readSpawners(root));
      });
      server.middlewares.use("/__spawners/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const raw = JSON.parse(buf.toString("utf8") || "{}") as Record<string, unknown>;
            const entry = normalizeSpawnerEntry(raw);
            if (!entry) return fail(res, 400, "missing id or ownerId");
            const list = readSpawners(root);
            const i = list.findIndex((x) => x.id === entry.id);
            if (i >= 0) list[i] = entry;
            else list.push(entry);
            writeJsonArray(spawnersPathFor(root), list);
            sendJson(res, { ok: true, id: entry.id });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__spawners/delete", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const id = String(b.id ?? "");
            const ownerId = String(b.ownerId ?? "");
            if (!id && !ownerId) return fail(res, 400, "missing id or ownerId");
            const list = readSpawners(root);
            writeJsonArray(
              spawnersPathFor(root),
              list.filter((x) => x.id !== id && x.ownerId !== ownerId),
            );
            sendJson(res, { ok: true });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Custom wave compositions (dev-authored per-wave overrides) ========
      server.middlewares.use("/__waves/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readJsonArray<Record<string, unknown>>(wavesPathFor(root)));
      });
      server.middlewares.use("/__waves/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const arr = JSON.parse(buf.toString("utf8") || "[]");
            if (!Array.isArray(arr)) return fail(res, 400, "expected an array of waves");
            writeJsonArray(wavesPathFor(root), arr as unknown[]);
            sendJson(res, { ok: true, count: arr.length });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Resource drop config (per-kind tree/rock loot) ========
      const readDrops = (): Record<string, DropCfg> => {
        const p = resourcesPathFor(root);
        if (!existsSync(p)) return {};
        try {
          const o = JSON.parse(readFileSync(p, "utf8"));
          return o && typeof o === "object" ? o : {};
        } catch {
          return {};
        }
      };
      server.middlewares.use("/__resources/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readDrops());
      });
      server.middlewares.use("/__resources/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const kind = String(b.kind || "");
            if (!kind) return fail(res, 400, "missing kind");
            const drops = readDrops();
            drops[kind] = {
              item: String(b.item || "stone"),
              amount: Math.max(0, Number(b.amount) || 0),
              trigger: b.trigger === "kill" ? "kill" : "hit",
              hp: Math.max(1, Math.round(Number(b.hp) || (kind === "tree" ? 60 : 560))),
            };
            writeFileSync(resourcesPathFor(root), JSON.stringify(drops, null, 2));
            sendJson(res, { ok: true, kind });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });

      // ======== Structure loot tables (items dropped when a structure is destroyed) ========
      const readStructures = (): Record<string, StructureCfg> => {
        const p = structuresPathFor(root);
        if (!existsSync(p)) return {};
        try {
          const o = JSON.parse(readFileSync(p, "utf8"));
          return o && typeof o === "object" ? o : {};
        } catch {
          return {};
        }
      };
      server.middlewares.use("/__structures/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        sendJson(res, readStructures());
      });
      server.middlewares.use("/__structures/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const b = JSON.parse(buf.toString("utf8") || "{}");
            const kind = String(b.kind || "");
            if (!kind) return fail(res, 400, "missing kind");
            const loot: LootEntry[] = Array.isArray(b.loot)
              ? b.loot.slice(0, 20).map((e: Record<string, unknown>) => ({
                  item: String(e.item || "log"),
                  amount: Math.max(0, Math.round(Number(e.amount) || 0)),
                  probability: Math.max(0, Math.min(1, Number(e.probability) || 0)),
                }))
              : [];
            const all = readStructures();
            const next: StructureCfg = { ...(all[kind] ?? {}), loot };
            if ("mask" in b) {
              const mask = sanitizeStructureMask(b.mask);
              if (mask) next.mask = mask;
              else delete next.mask;
            }
            all[kind] = next;
            writeFileSync(structuresPathFor(root), JSON.stringify(all, null, 2));
            sendJson(res, { ok: true, kind, count: loot.length, mask: !!next.mask });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
    },
  };
}

/**
 * Dev-only endpoints for the in-game performance overlay (F3). They persist client
 * perf artefacts to the repo-root `perf-logs/` directory (gitignored), the same
 * place the server writes its JSONL — so one folder holds every artefact the
 * analyzer reads. See docs/performance.md.
 *   POST /__perf/save?name=<file>&kind=log|benchmark   raw body → perf-logs/<file>
 *   GET  /__perf/list                                  → list saved artefacts
 */
function perfLogs(): Plugin {
  // Vite's root is packages/client; the shared perf-logs dir lives at the repo root.
  const perfDirFor = (root: string) => resolve(root, "../../perf-logs");
  // Keep a client-supplied filename inside perf-logs: strip any path, allow only a
  // safe charset, and force a .jsonl/.json extension.
  const safeName = (raw: string, kind: string) => {
    const base = (raw.split(/[\\/]/).pop() || "").replace(/[^a-zA-Z0-9._-]/g, "_");
    const fallback = `${kind === "benchmark" ? "bench" : "perf-log"}-${Date.now()}`;
    const name = base || fallback;
    return /\.(jsonl|json)$/i.test(name) ? name : `${name}.${kind === "benchmark" ? "json" : "jsonl"}`;
  };
  return {
    name: "rpg-perf-logs",
    configureServer(server: ViteDevServer) {
      const dir = perfDirFor(server.config.root);
      server.middlewares.use("/__perf/save", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        const url = new URL(req.url || "", "http://localhost");
        const name = safeName(url.searchParams.get("name") || "", url.searchParams.get("kind") || "log");
        void collectBody(req).then((buf) => {
          try {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(resolve(dir, name), buf);
            sendJson(res, { ok: true, name, bytes: buf.length });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
      server.middlewares.use("/__perf/list", (req, res) => {
        if (req.method !== "GET") return fail(res, 405, "GET only");
        try {
          const files = existsSync(dir)
            ? readdirSync(dir)
                .filter((f) => /\.(jsonl|json)$/i.test(f))
                .map((f) => ({ name: f, size: statSync(resolve(dir, f)).size }))
            : [];
          sendJson(res, files);
        } catch (e) {
          fail(res, 500, String(e));
        }
      });
    },
  };
}

/**
 * Dev-only endpoint for naming the active linked worktree. The name lives in the
 * ignored repo-local `.gorilator/worktree-name` file.
 *   GET  /__worktree       → current label/name/path metadata
 *   POST /__worktree {name,targetBranch} → set name/target branch
 *   POST /__worktree/merge {commit} → cherry-pick one pending commit into targetBranch
 *   POST /__worktree/target-merge {commit?} → merge targetBranch or target history point into current branch
 */
function worktreeTagger(): Plugin {
  return {
    name: "rpg-worktree-tagger",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/__worktree/file", (req, res) => {
        const info = worktreeInfo();
        if (!info.root) return fail(res, 404, "not a git worktree");
        if (req.method === "GET") {
          try {
            const url = new URL(req.url ?? "/", "http://localhost");
            return sendJson(res, { ok: true, ...readWorktreeFile(info.root, url.searchParams.get("path")) });
          } catch (e) {
            return fail(res, 400, String(e));
          }
        }
        if (req.method !== "POST") return fail(res, 405, "GET or POST only");
        void collectBody(req).then((buf) => {
          try {
            const body = JSON.parse(buf.toString("utf8") || "{}") as { path?: unknown; content?: unknown };
            sendJson(res, { ok: true, ...writeWorktreeFile(info.root, body.path, body.content) });
          } catch (e) {
            fail(res, 400, String(e));
          }
        });
      });

      server.middlewares.use("/__worktree/raw", (req, res) => {
        const info = worktreeInfo();
        if (!info.root) return fail(res, 404, "not a git worktree");
        if (req.method !== "GET") return fail(res, 405, "GET only");
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          sendWorktreeRawFile(res, info.root, url.searchParams.get("path"));
        } catch (e) {
          fail(res, 400, String(e));
        }
      });

      server.middlewares.use("/__worktree/merge", (req, res) => {
        const info = worktreeInfo();
        if (!info.root) return fail(res, 404, "not a git worktree");
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const body = JSON.parse(buf.toString("utf8") || "{}") as { commit?: unknown };
            sendJson(res, { ok: true, ...mergeCommitIntoTargetBranch(info.root, body.commit) });
          } catch (e) {
            fail(res, 409, String(e));
          }
        });
      });

      server.middlewares.use("/__worktree/bring", (_req, res) => {
        fail(res, 410, "Per-commit cherry-pick is disabled. Use target merge to merge target history.");
      });

      server.middlewares.use("/__worktree/target-merge", (req, res) => {
        const info = worktreeInfo();
        if (!info.root) return fail(res, 404, "not a git worktree");
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void collectBody(req).then((buf) => {
          try {
            const body = JSON.parse(buf.toString("utf8") || "{}") as { commit?: unknown };
            sendJson(res, { ok: true, ...mergeTargetIntoCurrentBranch(info.root, body.commit) });
          } catch (e) {
            fail(res, 409, String(e));
          }
        });
      });

      server.middlewares.use("/__worktree", (req, res) => {
        const info = worktreeInfo();
        if (!info.root) return fail(res, 404, "not a linked worktree");
        if (req.method === "GET") return sendJson(res, { ok: true, ...info });
        if (req.method !== "POST") return fail(res, 405, "GET or POST only");
        void collectBody(req).then((buf) => {
          try {
            const body = JSON.parse(buf.toString("utf8") || "{}") as { name?: unknown; targetBranch?: unknown };
            const hasName = Object.hasOwn(body, "name");
            const hasTarget = Object.hasOwn(body, "targetBranch");
            const name = hasName ? writeWorktreeName(info.root, body.name) : readWorktreeName(info.root);
            if (hasTarget) writeTargetBranch(info.root, body.targetBranch);
            sendJson(res, { ok: true, ...formatWorktreeInfo(info.root, name) });
          } catch (e) {
            fail(res, 500, String(e));
          }
        });
      });
    },
  };
}

// @rpg/shared is consumed as its compiled output (packages/shared/dist), resolved
// via the workspace symlink + its package.json "exports". That keeps the Colyseus
// schema decorators compiled correctly by tsc, independent of esbuild's handling.
export default defineConfig(({ command }) => {
  const worktree = command === "serve" ? worktreeInfo() : emptyWorktreeInfo();
  return {
    // Explicit cache dir (predictable invalidation, survives worktree switches).
    cacheDir: ".vite-cache",
    // Pre-bundle the heavy Babylon entrypoints once instead of re-discovering
    // them on every cold dev start.
    optimizeDeps: {
      include: ["@babylonjs/core", "@babylonjs/gui", "@babylonjs/loaders"],
    },
    build: {
      // External source maps so deployed-realm stack traces and F3 slowdown
      // snapshots map back to source.
      sourcemap: true,
    },
    // Inject local build metadata for the always-visible footer tags.
    define: {
      __APP_VERSION__: JSON.stringify(appVersion()),
      __PKG_VERSIONS__: JSON.stringify(packageVersions()),
      __WORKTREE_LABEL__: JSON.stringify(worktree.label),
      __WORKTREE_FULL_LABEL__: JSON.stringify(worktree.fullLabel),
    },
    plugins: [modelImporter(), perfLogs(), worktreeTagger(), pluginBundler(resolve(configDir, "..", ".."))],
    server: {
      port: Number(process.env.CLIENT_PORT) || 5173,
      strictPort: true,
      // Allow the dev server to be reached through a Cloudflare tunnel
      // (`gorilator setup → Tunnel (Cloudflare)`), which sends a Host header Vite
      // would otherwise reject: quick tunnels are `*.trycloudflare.com`; a
      // permanent tunnel's own hostnames arrive via VITE_ALLOWED_HOSTS.
      allowedHosts: [
        ".trycloudflare.com",
        ...(process.env.VITE_ALLOWED_HOSTS ?? "")
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean),
      ],
    },
  };
});
