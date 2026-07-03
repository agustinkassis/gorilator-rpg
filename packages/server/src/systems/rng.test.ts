import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFixedRng, resolveCycleSeed, rng, rngSeedInfo, seedRng } from "./rng";

describe("seeded RNG service (#70)", () => {
  afterEach(() => {
    delete process.env.GORILATOR_SEED;
  });

  it("same seed → identical sequences, different seed → different", () => {
    const a = {};
    const b = {};
    const c = {};
    seedRng(a, 1234, "env");
    seedRng(b, 1234, "env");
    seedRng(c, 99, "env");
    const draw = (s: object) => Array.from({ length: 20 }, () => rng(s, "combat")());
    const seqA = draw(a);
    expect(seqA).toEqual(draw(b));
    expect(seqA).not.toEqual(draw(c));
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("streams are independent — draining one never shifts another", () => {
    const a = {};
    const b = {};
    seedRng(a, 42, "env");
    seedRng(b, 42, "env");
    // Drain 100 combat rolls on `a` only; the drops stream must be unaffected.
    for (let i = 0; i < 100; i++) rng(a, "combat")();
    const dropsA = Array.from({ length: 10 }, () => rng(a, "drops")());
    const dropsB = Array.from({ length: 10 }, () => rng(b, "drops")());
    expect(dropsA).toEqual(dropsB);
    // …and the two streams produce different sequences from the same seed.
    seedRng(a, 42, "env");
    const combat = Array.from({ length: 10 }, () => rng(a, "combat")());
    seedRng(a, 42, "env");
    const drops = Array.from({ length: 10 }, () => rng(a, "drops")());
    expect(combat).not.toEqual(drops);
  });

  it("reseeding restarts the sequences; lazy use self-seeds randomly", () => {
    const s = {};
    seedRng(s, 7, "env");
    const first = rng(s, "spawns")();
    seedRng(s, 7, "env");
    expect(rng(s, "spawns")()).toBe(first);

    const lazy = {};
    expect(rng(lazy, "misc")()).toBeGreaterThanOrEqual(0); // no explicit seed needed
    expect(rngSeedInfo(lazy)?.source).toBe("random");
  });

  it("installFixedRng pins every stream (the test hook)", () => {
    const s = {};
    installFixedRng(s, 0.5);
    expect(rng(s, "combat")()).toBe(0.5);
    expect(rng(s, "drops")()).toBe(0.5);
    installFixedRng(s, 0.9);
    expect(rng(s, "world")()).toBe(0.9);
  });

  it("resolveCycleSeed prefers scenario, then GORILATOR_SEED, then random", () => {
    process.env.GORILATOR_SEED = "555";
    expect(resolveCycleSeed(111)).toEqual({ seed: 111, source: "scenario" });
    expect(resolveCycleSeed()).toEqual({ seed: 555, source: "env" });
    delete process.env.GORILATOR_SEED;
    expect(resolveCycleSeed().source).toBe("random");
  });

  it("GUARD: no Math.random in server gameplay code outside rng.ts", () => {
    // The ratchet that keeps new systems seeded (engineering.md §3): every
    // gameplay roll must go through rng(state, stream). Add new sanctioned
    // files here only with a written justification.
    const allow = new Set(["rng.ts"]);
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        if (allow.has(entry.name)) continue;
        if (readFileSync(path, "utf8").includes("Math.random(")) offenders.push(path);
      }
    };
    scan(resolve(__dirname, ".."));
    expect(offenders).toEqual([]);
  });
});
