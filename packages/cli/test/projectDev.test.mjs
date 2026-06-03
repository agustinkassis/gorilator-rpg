import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectStatus, writeProjectState } from "../dist/lib/projectDev.js";

test("classifies a running dev state by pid", async () => {
  const { ctx, root } = makeContext();
  try {
    writeProjectState(ctx, stateFor(root, process.pid));
    const status = await projectStatus(ctx);
    assert.equal(status.active, true);
    assert.equal(status.stale, false);
    assert.equal(status.state?.pid, process.pid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifies stale dev state and removes it", async () => {
  const { ctx, root } = makeContext();
  try {
    writeProjectState(ctx, stateFor(root, 999999999));
    const status = await projectStatus(ctx);
    assert.equal(status.active, false);
    assert.equal(status.stale, true);
    assert.equal(status.state, null);
    assert.equal(existsSync(ctx.statePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function stateFor(root, pid) {
  return {
    root,
    pid,
    serverPort: 2567,
    clientPort: 5173,
    requestedServerPort: 2567,
    requestedClientPort: 5173,
    startedAt: new Date().toISOString(),
  };
}

function makeContext() {
  const root = join(tmpdir(), `gorilator-dev-test-${process.pid}-${Date.now()}-${Math.random()}`);
  const local = join(root, ".gorilator");
  mkdirSync(local, { recursive: true });
  return {
    root,
    ctx: {
      kind: "project",
      appDir: root,
      configPath: join(local, "config.json"),
      envPath: join(root, ".env"),
      statePath: join(local, "dev.json"),
      logPath: join(local, "dev.log"),
    },
  };
}
