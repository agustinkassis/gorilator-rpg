import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathDirs, resolveExecutable } from "../dist/lib/proc.js";

test("resolves Windows git.exe from Path and PATHEXT", () => {
  const root = mkdtemp();
  const gitDir = join(root, "Git", "cmd");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "git.EXE"), "");

  try {
    const env = {
      Path: `C:\\Windows\\System32;${gitDir}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    assert.equal(resolveExecutable("git", env, "win32"), join(gitDir, "git.EXE"));
    assert.deepEqual(pathDirs(env, "win32"), ["C:\\Windows\\System32", gitDir]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves POSIX executables with colon-delimited PATH", () => {
  const root = mkdtemp();
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "git"), "");

  try {
    assert.equal(resolveExecutable("git", { PATH: binDir }, "linux"), join(binDir, "git"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mkdtemp() {
  const root = join(tmpdir(), `gorilator-proc-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
