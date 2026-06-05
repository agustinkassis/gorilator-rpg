#!/usr/bin/env node
/*
 * Cross-platform checkout wrapper around the native Node CLI.
 *
 * The POSIX `gorilator` shell wrapper is still useful on fresh Linux/macOS
 * hosts because it can install Node. This file is for environments that
 * already have Node, including Windows shells and npm/pnpm scripts.
 */
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const cliDir = __dirname;
const cliEntry = join(cliDir, "dist", "index.js");
const isWindows = process.platform === "win32";

function info(message) {
  process.stdout.write(`==> ${message}\n`);
}

function warn(message) {
  process.stderr.write(`! ${message}\n`);
}

function die(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function command(name) {
  return isWindows ? `${name}.cmd` : name;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    stdio: "inherit",
    windowsHide: false,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function nodeOk() {
  const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number(part));
  return major > 20 || (major === 20 && minor >= 6);
}

function isVersionRequest(args) {
  return args.length === 1 && ["--version", "-v", "version"].includes(args[0]);
}

function printCliVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
    if (pkg.name === "gorilator" && typeof pkg.version === "string" && pkg.version.trim()) {
      process.stdout.write(`gorilator ${pkg.version}\n`);
      return;
    }
  } catch {
    // fall through
  }
  process.stdout.write("gorilator 0.0.0\n");
}

function buildLocalCli() {
  info("Building the gorilator CLI...");
  const installStatus = run(command("npm"), ["install", "--no-audit", "--no-fund", "--silent"], { cwd: cliDir });
  if (installStatus !== 0) return installStatus;
  return run(command("npm"), ["run", "build", "--silent"], { cwd: cliDir });
}

function main() {
  const args = process.argv.slice(2);

  if (!nodeOk()) {
    die(`Node >= 20.6 is required. Current Node is ${process.version}.`);
  }

  if (isVersionRequest(args)) {
    printCliVersion();
    return;
  }

  try {
    require("node:fs").accessSync(cliEntry);
  } catch {
    if (buildLocalCli() !== 0) {
      warn("Local CLI build failed.");
    }
  }

  try {
    require("node:fs").accessSync(cliEntry);
    process.exit(run(process.execPath, [cliEntry, ...args]));
  } catch {
    warn("Using the published gorilator package (npx) - local build unavailable.");
    process.exit(run(command("npx"), ["-y", "gorilator", ...args]));
  }
}

main();
