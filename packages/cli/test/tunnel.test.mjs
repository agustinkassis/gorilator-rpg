import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { installId, loadConfig, saveConfig } from "../dist/lib/config.js";
import { quickTunnelLabel, quickTunnelLog, quickTunnelUnit } from "../dist/lib/paths.js";

test("installId is stable for the same appDir", () => {
  const a = installId({ appDir: "/opt/gorilator" });
  const b = installId({ appDir: "/opt/gorilator" });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test("installId differs across appDirs", () => {
  const a = installId({ appDir: "/opt/gorilator" });
  const b = installId({ appDir: "/home/alice/.gorilator/app" });
  assert.notEqual(a, b);
});

test("per-install quick-tunnel identifiers embed the id", () => {
  const id = installId({ appDir: "/tmp/install-A" });
  assert.equal(quickTunnelUnit(id), `gorilator-tunnel-${id}.service`);
  assert.equal(quickTunnelLabel(id), `com.gorilator.tunnel.${id}`);
  assert.ok(quickTunnelLog(id).endsWith(`quick-tunnel-${id}.log`));
});

test("two installs get distinct quick-tunnel services (no collision)", () => {
  const idA = installId({ appDir: "/tmp/install-A" });
  const idB = installId({ appDir: "/tmp/install-B" });
  assert.notEqual(idA, idB);
  assert.notEqual(quickTunnelUnit(idA), quickTunnelUnit(idB));
  assert.notEqual(quickTunnelLabel(idA), quickTunnelLabel(idB));
  assert.notEqual(quickTunnelLog(idA), quickTunnelLog(idB));
});

test("a TunnelRecord round-trips through saveConfig/loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "gorilator-cfg-"));
  const path = join(dir, "config.json");
  try {
    const cfg = {
      appDir: "/opt/gorilator",
      port: 2567,
      repo: "https://github.com/agustinkassis/gorilator-rpg.git",
      ref: "latest",
      user: "gorilator",
      serviceManager: "launchd",
      tunnel: {
        mode: "temporary",
        service: "com.gorilator.tunnel.abcd1234",
        logPath: "/tmp/quick-tunnel-abcd1234.log",
        url: "https://brave-gorilla-1234.trycloudflare.com",
      },
    };
    saveConfig(cfg, path);
    const loaded = loadConfig(path);
    assert.deepEqual(loaded.tunnel, cfg.tunnel);
    assert.equal(loaded.tunnel.mode, "temporary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a permanent TunnelRecord round-trips with hosts + sharedService", () => {
  const dir = mkdtempSync(join(tmpdir(), "gorilator-cfg-"));
  const path = join(dir, "config.json");
  try {
    const cfg = {
      appDir: "/opt/gorilator",
      port: 2567,
      repo: "https://github.com/agustinkassis/gorilator-rpg.git",
      ref: "latest",
      user: "gorilator",
      serviceManager: "systemd",
      tunnel: {
        mode: "permanent",
        name: "gorilator-rpg",
        hosts: ["game.example.com"],
        sharedService: true,
        url: "https://game.example.com",
      },
    };
    saveConfig(cfg, path);
    const loaded = loadConfig(path);
    assert.deepEqual(loaded.tunnel.hosts, ["game.example.com"]);
    assert.equal(loaded.tunnel.sharedService, true);
    assert.equal(loaded.tunnel.name, "gorilator-rpg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
