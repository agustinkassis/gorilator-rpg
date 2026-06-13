import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { hexToNpub } from "../dist/lib/npub.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(testDir, "..");
const cliBin = join(cliRoot, "dist", "index.js");

function run(root, args) {
  return execFileSync(process.execPath, [cliBin, "plugin", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("plugin list shows plugins/, npm packages, and disabled state", () => {
  const root = makeTempProject();
  try {
    writePlugin(root, join("plugins", "example-arena"), {
      name: "example-arena",
      version: "0.1.0",
      apiVersion: "^1.0.0",
      capabilities: ["brain", "item"],
    });
    writePlugin(root, join("plugins", "_template"), {
      name: "_template",
      version: "0.0.0",
      apiVersion: "^1.0.0",
    });
    writePlugin(root, join("node_modules", "gorilator-plugin-extra"), {
      name: "extra-npm",
      version: "2.0.0",
      apiVersion: "^1.0.0",
      capabilities: ["content"],
    });
    writeFileSync(join(root, "realm.json"), '{"plugins":{"disabled":["example-arena"]}}\n');

    const output = run(root, ["list"]);
    assert.match(output, /Plugins \(2\)/);
    assert.match(output, /example-arena\s+v0\.1\.0\s+disabled \(realm\.json\)\s+plugins\/\s+brain, item/);
    assert.match(output, /extra-npm\s+v2\.0\.0\s+enabled\s+npm\s+content/);
    assert.doesNotMatch(output, /_template/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin list reports a manifest-disabled plugin", () => {
  const root = makeTempProject();
  try {
    writePlugin(root, join("plugins", "sleepy"), {
      name: "sleepy",
      version: "1.0.0",
      apiVersion: "^1.0.0",
      enabled: false,
    });
    const output = run(root, ["list"]);
    assert.match(output, /sleepy\s+v1\.0\.0\s+disabled \(plugin\.json\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin disable/enable edit realm.json plugins.disabled and keep other keys", () => {
  const root = makeTempProject();
  try {
    writePlugin(root, join("plugins", "example-arena"), {
      name: "example-arena",
      version: "0.1.0",
      apiVersion: "^1.0.0",
    });
    writeFileSync(join(root, "realm.json"), '{"name":"my-realm","tuning":{"waveSizeBase":8}}\n');

    run(root, ["disable", "example-arena"]);
    let realm = JSON.parse(readFileSync(join(root, "realm.json"), "utf8"));
    assert.deepEqual(realm.plugins.disabled, ["example-arena"]);
    assert.equal(realm.name, "my-realm");
    assert.deepEqual(realm.tuning, { waveSizeBase: 8 });

    run(root, ["enable", "example-arena"]);
    realm = JSON.parse(readFileSync(join(root, "realm.json"), "utf8"));
    assert.deepEqual(realm.plugins.disabled, []);
    assert.equal(realm.name, "my-realm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin disable creates realm.json when missing", () => {
  const root = makeTempProject();
  try {
    writePlugin(root, join("plugins", "example-arena"), {
      name: "example-arena",
      version: "0.1.0",
      apiVersion: "^1.0.0",
    });
    assert.equal(existsSync(join(root, "realm.json")), false);
    run(root, ["disable", "example-arena"]);
    const realm = JSON.parse(readFileSync(join(root, "realm.json"), "utf8"));
    assert.deepEqual(realm.plugins.disabled, ["example-arena"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin add copies a local plugin directory into plugins/<name>", () => {
  const root = makeTempProject();
  const src = join(root, "..", `gorilator-plugin-src-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(join(src, "dist"), { recursive: true });
    mkdirSync(join(src, "node_modules", "junk"), { recursive: true });
    writeFileSync(
      join(src, "plugin.json"),
      '{"name":"my-local","version":"0.2.0","apiVersion":"^1.0.0"}\n',
    );
    writeFileSync(join(src, "dist", "server.js"), "export default { setup() {} };\n");

    run(root, ["add", src]);
    const dest = join(root, "plugins", "my-local");
    assert.equal(JSON.parse(readFileSync(join(dest, "plugin.json"), "utf8")).name, "my-local");
    assert.equal(existsSync(join(dest, "dist", "server.js")), true);
    assert.equal(existsSync(join(dest, "node_modules")), false);

    // A second add must refuse to clobber the existing copy.
    assert.throws(
      () => run(root, ["add", src]),
      (err) => err.status === 1 && /already exists/.test(String(err.stderr ?? err.message)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("plugin add --link symlinks a local plugin directory", () => {
  const root = makeTempProject();
  const src = join(root, "..", `gorilator-plugin-link-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "plugin.json"),
      '{"name":"linked","version":"0.1.0","apiVersion":"^1.0.0"}\n',
    );

    run(root, ["add", src, "--link"]);
    const dest = join(root, "plugins", "linked");
    assert.equal(lstatSync(dest).isSymbolicLink(), true);
    assert.match(run(root, ["list"]), /linked\s+v0\.1\.0\s+enabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("plugin add <npub> appends REALM_PACK_AUTHORS to .env and dedupes", () => {
  const root = makeTempProject();
  const npubA = hexToNpub("ab".repeat(32));
  const npubB = hexToNpub("cd".repeat(32));
  try {
    writeFileSync(join(root, ".env"), "GAME_SERVER_PORT=2567\n# keep this comment\n");

    run(root, ["add", npubA]);
    let env = readFileSync(join(root, ".env"), "utf8");
    assert.match(env, new RegExp(`^REALM_PACK_AUTHORS=${npubA}$`, "m"));
    assert.match(env, /^GAME_SERVER_PORT=2567$/m);
    assert.match(env, /^# keep this comment$/m);

    // Same author again (even as hex) is a no-op.
    run(root, ["add", npubA]);
    env = readFileSync(join(root, ".env"), "utf8");
    assert.equal(env.match(/REALM_PACK_AUTHORS=/g).length, 1);
    assert.match(env, new RegExp(`^REALM_PACK_AUTHORS=${npubA}$`, "m"));

    run(root, ["add", npubB]);
    env = readFileSync(join(root, ".env"), "utf8");
    assert.match(env, new RegExp(`^REALM_PACK_AUTHORS=${npubA},${npubB}$`, "m"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin add <npub> creates .env when missing", () => {
  const root = makeTempProject();
  const npub = hexToNpub("ef".repeat(32));
  try {
    run(root, ["add", npub]);
    const env = readFileSync(join(root, ".env"), "utf8");
    assert.match(env, new RegExp(`^REALM_PACK_AUTHORS=${npub}$`, "m"));
    assert.match(env, /kind-30333/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writePlugin(root, relDir, manifest) {
  mkdirSync(join(root, relDir), { recursive: true });
  writeFileSync(join(root, relDir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function makeTempProject() {
  const root = join(tmpdir(), `gorilator-plugin-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  mkdirSync(join(root, "packages", "client"), { recursive: true });
  mkdirSync(join(root, "packages", "server"), { recursive: true });
  mkdirSync(join(root, "packages", "shared"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(
    join(root, "package.json"),
    '{"name":"rpg-online","version":"1.0.0","scripts":{"dev":"node scripts/dev.mjs"}}\n',
  );
  writeFileSync(
    join(root, "packages", "cli", "package.json"),
    '{"name":"gorilator","version":"9.8.7"}\n',
  );
  writeFileSync(
    join(root, "packages", "client", "package.json"),
    '{"name":"@rpg/client","version":"2.0.0"}\n',
  );
  writeFileSync(
    join(root, "packages", "server", "package.json"),
    '{"name":"@rpg/server","version":"3.2.1"}\n',
  );
  writeFileSync(
    join(root, "packages", "shared", "package.json"),
    '{"name":"@rpg/shared","version":"4.0.0"}\n',
  );
  return root;
}
