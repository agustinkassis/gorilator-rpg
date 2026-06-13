import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const { planUpdateActions } = await import(join(testDir, "..", "dist", "lib", "build.js"));

test("no changes ⇒ nothing to do", () => {
  const a = planUpdateActions([]);
  assert.equal(a.any, false);
  assert.equal(a.restartServer, false);
  assert.equal(a.install, false);
});

test("app bumps are ignored (no daemon impact)", () => {
  const a = planUpdateActions(["app"]);
  assert.equal(a.any, false);
  assert.equal(a.restartServer, false);
});

test("client-only change ⇒ rebuild client, NO server restart", () => {
  const a = planUpdateActions(["app", "client"]);
  assert.equal(a.buildClient, true);
  assert.equal(a.restartServer, false);
  assert.equal(a.buildShared, false);
  assert.equal(a.buildCli, false);
  assert.equal(a.any, true);
});

test("server-only change ⇒ restart server, no client/cli rebuild", () => {
  const a = planUpdateActions(["app", "server"]);
  assert.equal(a.restartServer, true);
  assert.equal(a.buildClient, false);
  assert.equal(a.buildCli, false);
  assert.equal(a.install, true);
});

test("cli-only change ⇒ rebuild cli, no server restart", () => {
  const a = planUpdateActions(["cli"]);
  assert.equal(a.buildCli, true);
  assert.equal(a.restartServer, false);
});

test("shared change fans out to client, cli, AND a server restart", () => {
  const a = planUpdateActions(["shared"]);
  assert.equal(a.buildShared, true);
  assert.equal(a.buildClient, true);
  assert.equal(a.buildCli, true);
  assert.equal(a.restartServer, true);
});
