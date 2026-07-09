import { XP_DEATH_PENALTY } from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultRealmPolicy,
  realmPolicy,
  resetRealmPolicy,
  setRealmPolicy,
} from "./policy";

// The policy sanitizer guards realm.json input: operators hand-edit that file,
// so every invalid shape must fall back to a sane default instead of crashing
// or smuggling NaN into the death math.

describe("realm policy", () => {
  beforeEach(() => {
    resetRealmPolicy();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to persistent progression with the stock XP death penalty", () => {
    const p = realmPolicy();
    expect(p).toEqual(defaultRealmPolicy);
    expect(p.death.mode).toBe("xp-penalty");
    expect(p.death.xpPenalty).toBe(XP_DEATH_PENALTY);
    expect(p.progression.persistAcrossWipes).toBe(true);
    expect(p.progression.keepInventoryOnWipe).toBe(true);
  });

  it("applies a full valid policy block", () => {
    const p = setRealmPolicy({
      death: { mode: "hardcore", xpPenalty: 0.5 },
      progression: { persistAcrossWipes: false, keepInventoryOnWipe: false },
    });
    expect(p.death.mode).toBe("hardcore");
    expect(p.death.xpPenalty).toBe(0.5);
    expect(p.progression.persistAcrossWipes).toBe(false);
    expect(p.progression.keepInventoryOnWipe).toBe(false);
  });

  it("clamps xpPenalty into [0, 1]", () => {
    expect(setRealmPolicy({ death: { xpPenalty: 1.5 } }).death.xpPenalty).toBe(
      1,
    );
    expect(setRealmPolicy({ death: { xpPenalty: -0.2 } }).death.xpPenalty).toBe(
      0,
    );
  });

  it("rejects a non-numeric xpPenalty and keeps the default", () => {
    const p = setRealmPolicy({ death: { xpPenalty: "ouch" } });
    expect(p.death.xpPenalty).toBe(XP_DEATH_PENALTY);
    expect(console.warn).toHaveBeenCalled();
  });

  it("rejects an unknown death mode and keeps the default", () => {
    const p = setRealmPolicy({ death: { mode: "yolo" } });
    expect(p.death.mode).toBe("xp-penalty");
    expect(console.warn).toHaveBeenCalled();
  });

  it("fills unspecified fields from the defaults (partial blocks are fine)", () => {
    const p = setRealmPolicy({ death: { mode: "none" } });
    expect(p.death.mode).toBe("none");
    expect(p.death.xpPenalty).toBe(XP_DEATH_PENALTY);
    expect(p.progression).toEqual(defaultRealmPolicy.progression);
  });

  it("ignores non-boolean progression flags", () => {
    const p = setRealmPolicy({
      progression: { persistAcrossWipes: "nope", keepInventoryOnWipe: 0 },
    });
    expect(p.progression.persistAcrossWipes).toBe(true);
    expect(p.progression.keepInventoryOnWipe).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("treats garbage input as the default policy", () => {
    for (const raw of [null, undefined, 42, "policy", []]) {
      expect(setRealmPolicy(raw)).toEqual(defaultRealmPolicy);
    }
  });

  it("does not carry fields over from a previous set (each set starts from defaults)", () => {
    setRealmPolicy({
      death: { mode: "hardcore" },
      progression: { persistAcrossWipes: false },
    });
    const p = setRealmPolicy({ death: { xpPenalty: 0.1 } });
    expect(p.death.mode).toBe("xp-penalty");
    expect(p.progression.persistAcrossWipes).toBe(true);
  });
});
