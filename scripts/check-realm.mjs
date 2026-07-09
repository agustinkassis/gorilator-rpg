#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const realmTypeFile = join(root, "packages/shared/src/realmConfig.ts");

function exportedStringArray(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      let array = declaration.initializer;
      while (array && (ts.isAsExpression(array) || ts.isSatisfiesExpression(array))) {
        array = array.expression;
      }
      if (!array || !ts.isArrayLiteralExpression(array)) {
        throw new Error(`${name} must be an exported string array`);
      }
      return array.elements.map((el) => {
        if (!ts.isStringLiteral(el)) throw new Error(`${name} contains a non-string element`);
        return el.text;
      });
    }
  }
  throw new Error(`could not find exported array ${name}`);
}

const sourceFile = ts.createSourceFile(
  realmTypeFile,
  readFileSync(realmTypeFile, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const deathModes = new Set(exportedStringArray(sourceFile, "REALM_DEATH_MODES"));
const tuningKeys = new Set(exportedStringArray(sourceFile, "REALM_TUNING_KEYS"));
const errors = [];

function addError(file, path, message) {
  errors.push(`${file}${path ? ` ${path}` : ""}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function unknownKeys(file, path, value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(file, `${path}.${key}`, "unknown key");
  }
}

function validatePoint(file, path, value, { rotY = false } = {}) {
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  unknownKeys(file, path, value, new Set(rotY ? ["x", "z", "rotY"] : ["x", "z"]));
  for (const key of ["x", "z"]) {
    if (!finiteNumber(value[key])) addError(file, `${path}.${key}`, "must be a finite number");
  }
  if (rotY && value.rotY !== undefined && !finiteNumber(value.rotY)) {
    addError(file, `${path}.rotY`, "must be a finite number");
  }
}

function validatePolicy(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "policy", "must be an object");
    return;
  }
  unknownKeys(file, "policy", value, new Set(["death", "progression"]));

  if (value.death !== undefined) {
    if (!isObject(value.death)) {
      addError(file, "policy.death", "must be an object");
    } else {
      unknownKeys(file, "policy.death", value.death, new Set(["mode", "xpPenalty"]));
      if (value.death.mode !== undefined && !deathModes.has(value.death.mode)) {
        addError(file, "policy.death.mode", `must be one of ${[...deathModes].join(", ")}`);
      }
      if (value.death.xpPenalty !== undefined && !finiteNumber(value.death.xpPenalty)) {
        addError(file, "policy.death.xpPenalty", "must be a finite number");
      }
    }
  }

  if (value.progression !== undefined) {
    if (!isObject(value.progression)) {
      addError(file, "policy.progression", "must be an object");
    } else {
      unknownKeys(
        file,
        "policy.progression",
        value.progression,
        new Set(["persistAcrossWipes", "keepInventoryOnWipe"]),
      );
      for (const key of ["persistAcrossWipes", "keepInventoryOnWipe"]) {
        if (value.progression[key] !== undefined && typeof value.progression[key] !== "boolean") {
          addError(file, `policy.progression.${key}`, "must be a boolean");
        }
      }
    }
  }
}

function validateTuning(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "tuning", "must be an object");
    return;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (!tuningKeys.has(key)) addError(file, `tuning.${key}`, "unknown tuning key");
    if (!finiteNumber(raw)) addError(file, `tuning.${key}`, "must be a finite number");
  }
}

function validatePlugins(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "plugins", "must be an object");
    return;
  }
  unknownKeys(file, "plugins", value, new Set(["disabled"]));
  if (value.disabled !== undefined) {
    if (!Array.isArray(value.disabled)) {
      addError(file, "plugins.disabled", "must be an array of plugin names");
    } else {
      value.disabled.forEach((entry, index) => {
        if (typeof entry !== "string" || !entry.trim()) {
          addError(file, `plugins.disabled[${index}]`, "must be a non-empty string");
        }
      });
    }
  }
}

function validateStats(file, path, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  const allowed = new Set(["maxHp", "attack", "armor", "critChance", "moveSpeed", "throwPower", "level", "xp"]);
  unknownKeys(file, path, value, allowed);
  for (const [key, raw] of Object.entries(value)) {
    if (!finiteNumber(raw)) addError(file, `${path}.${key}`, "must be a finite number");
  }
}

function validateScenarioPlayer(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "player", "must be an object");
    return;
  }
  unknownKeys(file, "player", value, new Set(["level", "xp", "hp", "maxHp", "position"]));
  for (const key of ["level", "xp", "hp", "maxHp"]) {
    if (value[key] !== undefined && !finiteNumber(value[key])) {
      addError(file, `player.${key}`, "must be a finite number");
    }
  }
  if (value.position !== undefined) validatePoint(file, "player.position", value.position, { rotY: true });
}

function validateScenarioEnemy(file, path, value) {
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  unknownKeys(
    file,
    path,
    value,
    new Set(["idPrefix", "kind", "count", "level", "brain", "stats", "position", "offsetFromPlayer", "spread", "aggro"]),
  );
  for (const key of ["idPrefix", "kind", "brain"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      addError(file, `${path}.${key}`, "must be a string");
    }
  }
  for (const key of ["count", "level", "spread"]) {
    if (value[key] !== undefined && !finiteNumber(value[key])) {
      addError(file, `${path}.${key}`, "must be a finite number");
    }
  }
  if (value.aggro !== undefined && typeof value.aggro !== "boolean") {
    addError(file, `${path}.aggro`, "must be a boolean");
  }
  if (value.position !== undefined) validatePoint(file, `${path}.position`, value.position, { rotY: true });
  if (value.offsetFromPlayer !== undefined) validatePoint(file, `${path}.offsetFromPlayer`, value.offsetFromPlayer, { rotY: true });
  validateStats(file, `${path}.stats`, value.stats);
}

function validateScenarioWorld(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "world", "must be an object");
    return;
  }
  unknownKeys(file, "world", value, new Set(["clearEnemies", "enemies", "props", "resources", "npcs", "groundItems"]));
  if (value.clearEnemies !== undefined && typeof value.clearEnemies !== "boolean") {
    addError(file, "world.clearEnemies", "must be a boolean");
  }
  if (value.enemies !== undefined) {
    if (!Array.isArray(value.enemies)) {
      addError(file, "world.enemies", "must be an array");
    } else {
      value.enemies.forEach((enemy, index) => validateScenarioEnemy(file, `world.enemies[${index}]`, enemy));
    }
  }
  for (const key of ["props", "resources", "npcs", "groundItems"]) {
    if (value[key] !== undefined && !Array.isArray(value[key])) {
      addError(file, `world.${key}`, "must be an array");
    }
  }
}

function validateScenarioExtras(file, value) {
  if (value.timeScale !== undefined && !finiteNumber(value.timeScale)) {
    addError(file, "timeScale", "must be a finite number");
  }
  if (value.systems !== undefined) {
    if (!isObject(value.systems)) {
      addError(file, "systems", "must be an object");
    } else {
      for (const [key, raw] of Object.entries(value.systems)) {
        if (typeof raw !== "boolean") addError(file, `systems.${key}`, "must be a boolean");
      }
    }
  }
  if (value.bots !== undefined && !Array.isArray(value.bots)) {
    addError(file, "bots", "must be an array");
  }
  validateScenarioPlayer(file, value.player);
  validateScenarioWorld(file, value.world);
}

function validateConfig(file, value, { scenario = false } = {}) {
  if (!isObject(value)) {
    addError(file, "", "must be a JSON object");
    return;
  }
  const allowed = scenario
    ? new Set(["name", "description", "plugins", "tuning", "policy", "timeScale", "world", "player", "systems", "bots"])
    : new Set(["name", "plugins", "tuning", "policy"]);
  unknownKeys(file, "", value, allowed);
  if (value.name !== undefined && typeof value.name !== "string") addError(file, "name", "must be a string");
  if (scenario && value.description !== undefined && typeof value.description !== "string") {
    addError(file, "description", "must be a string");
  }
  validatePlugins(file, value.plugins);
  validateTuning(file, value.tuning);
  validatePolicy(file, value.policy);
  if (scenario) validateScenarioExtras(file, value);
}

function readJson(file, { scenario = false } = {}) {
  try {
    validateConfig(file, JSON.parse(readFileSync(join(root, file), "utf8")), { scenario });
  } catch (err) {
    addError(file, "", err instanceof Error ? err.message : String(err));
  }
}

if (existsSync(join(root, "realm.json"))) readJson("realm.json");
else console.log("[realm] no realm.json found (optional)");

const scenariosDir = join(root, "scenarios");
if (existsSync(scenariosDir) && statSync(scenariosDir).isDirectory()) {
  for (const name of readdirSync(scenariosDir).sort()) {
    if (name.endsWith(".json")) readJson(join("scenarios", name), { scenario: true });
  }
}

if (errors.length) {
  console.error("[realm] config check failed");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("[realm] config check passed");
