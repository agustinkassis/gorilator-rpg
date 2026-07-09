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
const playerStats = new Set([
  "level",
  "xp",
  "hp",
  "maxHp",
  "stamina",
  "maxStamina",
  "attack",
  "armor",
  "critChance",
  "moveSpeed",
  "throwPower",
  "mana",
  "maxMana",
  "hunger",
  "maxHunger",
]);
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

function validateString(file, path, value, { optional = true, nonEmpty = false } = {}) {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || (nonEmpty && !value.trim())) addError(file, path, "must be a string");
}

function validateFinite(file, path, value, { optional = true } = {}) {
  if (value === undefined && optional) return;
  if (!finiteNumber(value)) addError(file, path, "must be a finite number");
}

function validateBoolean(file, path, value, { optional = true } = {}) {
  if (value === undefined && optional) return;
  if (typeof value !== "boolean") addError(file, path, "must be a boolean");
}

function validateStringArray(file, path, value, { optional = true } = {}) {
  if (value === undefined && optional) return;
  if (!Array.isArray(value)) {
    addError(file, path, "must be an array of strings");
    return;
  }
  value.forEach((entry, index) => validateString(file, `${path}[${index}]`, entry, { optional: false, nonEmpty: true }));
}

function validatePoint(file, path, value) {
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  unknownKeys(file, path, value, new Set(["x", "z"]));
  validateFinite(file, `${path}.x`, value.x, { optional: false });
  validateFinite(file, `${path}.z`, value.z, { optional: false });
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
      validateFinite(file, "policy.death.xpPenalty", value.death.xpPenalty);
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
      validateBoolean(file, "policy.progression.persistAcrossWipes", value.progression.persistAcrossWipes);
      validateBoolean(file, "policy.progression.keepInventoryOnWipe", value.progression.keepInventoryOnWipe);
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
    validateFinite(file, `tuning.${key}`, raw, { optional: false });
  }
}

function validatePlugins(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "plugins", "must be an object");
    return;
  }
  unknownKeys(file, "plugins", value, new Set(["disabled"]));
  validateStringArray(file, "plugins.disabled", value.disabled);
}

function validateEvents(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "events", "must be an object");
    return;
  }
  unknownKeys(file, "events", value, new Set(["enabled", "autoStart", "module", "config"]));
  if (value.enabled !== undefined && typeof value.enabled !== "boolean" && !Array.isArray(value.enabled)) {
    addError(file, "events.enabled", "must be a boolean or an array of module ids");
  }
  if (Array.isArray(value.enabled)) validateStringArray(file, "events.enabled", value.enabled, { optional: false });
  validateBoolean(file, "events.autoStart", value.autoStart);
  validateString(file, "events.module", value.module);
  if (value.config !== undefined && !isObject(value.config)) addError(file, "events.config", "must be an object");
}

function validateRealmWorld(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "world", "must be an object");
    return;
  }
  unknownKeys(file, "world", value, new Set(["homeObjective", "waves"]));
  validateBoolean(file, "world.homeObjective", value.homeObjective);
  validateBoolean(file, "world.waves", value.waves);
}

function validateStats(file, path, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  unknownKeys(file, path, value, playerStats);
  for (const [key, raw] of Object.entries(value)) validateFinite(file, `${path}.${key}`, raw, { optional: false });
}

function validateLoadout(file, path, value) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    addError(file, path, "must be an array");
    return;
  }
  value.forEach((entry, index) => {
    const p = `${path}[${index}]`;
    if (!isObject(entry)) {
      addError(file, p, "must be an object");
      return;
    }
    unknownKeys(file, p, entry, new Set(["item", "count"]));
    validateString(file, `${p}.item`, entry.item, { optional: false, nonEmpty: true });
    validateFinite(file, `${p}.count`, entry.count);
  });
}

function validateScenarioPlayer(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "player", "must be an object");
    return;
  }
  unknownKeys(file, "player", value, new Set(["loadout", "stats", "position"]));
  validateLoadout(file, "player.loadout", value.loadout);
  validateStats(file, "player.stats", value.stats);
  if (value.position !== undefined) validatePoint(file, "player.position", value.position);
}

function validateScenarioResource(file, path, value) {
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  unknownKeys(file, path, value, new Set(["type", "kind", "id", "x", "z", "count", "scale", "rotY", "hp"]));
  validateString(file, `${path}.type`, value.type);
  validateString(file, `${path}.kind`, value.kind);
  validateString(file, `${path}.id`, value.id);
  validateFinite(file, `${path}.x`, value.x, { optional: false });
  validateFinite(file, `${path}.z`, value.z, { optional: false });
  for (const key of ["count", "scale", "rotY", "hp"]) validateFinite(file, `${path}.${key}`, value[key]);
}

function validateScenarioGroundItem(file, path, value) {
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  unknownKeys(file, path, value, new Set(["item", "x", "z", "count"]));
  validateString(file, `${path}.item`, value.item, { optional: false, nonEmpty: true });
  validateFinite(file, `${path}.x`, value.x, { optional: false });
  validateFinite(file, `${path}.z`, value.z, { optional: false });
  validateFinite(file, `${path}.count`, value.count);
}

function validateScenarioNpc(file, path, value) {
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  unknownKeys(file, path, value, new Set(["defId", "x", "z", "brain", "level"]));
  validateString(file, `${path}.defId`, value.defId, { optional: false, nonEmpty: true });
  validateFinite(file, `${path}.x`, value.x, { optional: false });
  validateFinite(file, `${path}.z`, value.z, { optional: false });
  validateString(file, `${path}.brain`, value.brain);
  validateFinite(file, `${path}.level`, value.level);
}

function validateScenarioEnemy(file, path, value) {
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  unknownKeys(file, path, value, new Set(["kind", "x", "z", "level", "brain"]));
  validateString(file, `${path}.kind`, value.kind, { optional: false, nonEmpty: true });
  validateFinite(file, `${path}.x`, value.x, { optional: false });
  validateFinite(file, `${path}.z`, value.z, { optional: false });
  validateFinite(file, `${path}.level`, value.level);
  validateString(file, `${path}.brain`, value.brain);
}

function validateArrayEntries(file, path, value, validator) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    addError(file, path, "must be an array");
    return;
  }
  value.forEach((entry, index) => validator(file, `${path}[${index}]`, entry));
}

function validateScenarioWorld(file, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    addError(file, "world", "must be an object");
    return;
  }
  unknownKeys(
    file,
    "world",
    value,
    new Set([
      "clearPickups",
      "wavesEnabled",
      "waves",
      "homeObjective",
      "laCryptaDefense",
      "spawnersEnabled",
      "enemies",
      "props",
      "resources",
      "npcs",
      "groundItems",
    ]),
  );
  for (const key of ["clearPickups", "wavesEnabled", "waves", "homeObjective", "laCryptaDefense", "spawnersEnabled"]) {
    validateBoolean(file, `world.${key}`, value[key]);
  }
  validateArrayEntries(file, "world.resources", value.resources, validateScenarioResource);
  validateArrayEntries(file, "world.groundItems", value.groundItems, validateScenarioGroundItem);
  validateArrayEntries(file, "world.npcs", value.npcs, validateScenarioNpc);
  validateArrayEntries(file, "world.enemies", value.enemies, validateScenarioEnemy);
  if (value.props !== undefined && !Array.isArray(value.props)) addError(file, "world.props", "must be an array");
}

function validateScenarioBot(file, path, value) {
  if (!isObject(value)) {
    addError(file, path, "must be an object");
    return;
  }
  unknownKeys(file, path, value, new Set(["behavior", "count", "name", "position", "loadout", "stats", "assertions"]));
  validateString(file, `${path}.behavior`, value.behavior, { optional: false, nonEmpty: true });
  validateFinite(file, `${path}.count`, value.count);
  validateString(file, `${path}.name`, value.name);
  if (value.position !== undefined) validatePoint(file, `${path}.position`, value.position);
  validateLoadout(file, `${path}.loadout`, value.loadout);
  validateStats(file, `${path}.stats`, value.stats);
  validateStringArray(file, `${path}.assertions`, value.assertions);
}

function validateScenarioExtras(file, value) {
  validateFinite(file, "seed", value.seed);
  validateFinite(file, "timeScale", value.timeScale);
  if (value.systems !== undefined) {
    if (!isObject(value.systems)) {
      addError(file, "systems", "must be an object");
    } else {
      for (const [key, raw] of Object.entries(value.systems)) {
        if (typeof raw !== "boolean") addError(file, `systems.${key}`, "must be a boolean");
      }
    }
  }
  if (value.tweaks !== undefined) {
    if (!Array.isArray(value.tweaks)) {
      addError(file, "tweaks", "must be an array");
    } else {
      value.tweaks.forEach((key, index) => {
        if (typeof key !== "string" || !tuningKeys.has(key)) addError(file, `tweaks[${index}]`, "must be a known tuning key");
      });
    }
  }
  validateArrayEntries(file, "bots", value.bots, validateScenarioBot);
  validateScenarioPlayer(file, value.player);
  validateScenarioWorld(file, value.world);
}

function validateConfig(file, value, { scenario = false } = {}) {
  if (!isObject(value)) {
    addError(file, "", "must be a JSON object");
    return;
  }
  const allowed = scenario
    ? new Set([
        "name",
        "description",
        "seed",
        "plugins",
        "tuning",
        "policy",
        "events",
        "timeScale",
        "world",
        "player",
        "systems",
        "bots",
        "tweaks",
      ])
    : new Set(["name", "plugins", "world", "events", "tuning", "policy"]);
  unknownKeys(file, "", value, allowed);
  validateString(file, "name", value.name);
  if (scenario) validateString(file, "description", value.description);
  validatePlugins(file, value.plugins);
  validateEvents(file, value.events);
  validateTuning(file, value.tuning);
  validatePolicy(file, value.policy);
  if (scenario) validateScenarioExtras(file, value);
  else validateRealmWorld(file, value.world);
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
