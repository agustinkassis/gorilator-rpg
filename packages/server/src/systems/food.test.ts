import { Player } from "@rpg/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDevTuning, setDevTuning } from "./devTuning";
import { useFoodItem } from "./food";

function hungryPlayer(): Player {
  const p = new Player();
  p.hp = 50;
  p.maxHp = 100;
  p.stamina = 20;
  p.maxStamina = 100;
  p.hunger = 10;
  p.maxHunger = 100;
  return p;
}

describe("useFoodItem", () => {
  beforeEach(() => resetDevTuning());

  it("restores hunger, HP, and stamina from item food effects", () => {
    const p = hungryPlayer();
    const result = useFoodItem(p, "wild_berry");
    expect(result.used).toBe(true);
    expect(result.hungerRestored).toBe(18);
    expect(result.hpRestored).toBe(4);
    expect(result.staminaRestored).toBe(8);
    expect(p.hunger).toBe(28);
    expect(p.hp).toBe(54);
    expect(p.stamina).toBe(28);
  });

  it("treats cranberries as food from the hunger scenario bush", () => {
    const p = hungryPlayer();
    const result = useFoodItem(p, "cranberries");
    expect(result.used).toBe(true);
    expect(result.hungerRestored).toBe(12);
    expect(result.hpRestored).toBe(3);
    expect(result.staminaRestored).toBe(6);
  });

  it("does not consume food when all affected meters are full", () => {
    const p = hungryPlayer();
    p.hp = p.maxHp;
    p.stamina = p.maxStamina;
    p.hunger = p.maxHunger;
    expect(useFoodItem(p, "wild_berry").used).toBe(false);
  });

  it("applies food multipliers and clamps to meter caps", () => {
    const p = hungryPlayer();
    setDevTuning("foodHungerMult", 3);
    setDevTuning("foodHpMult", 20);
    setDevTuning("foodStaminaMult", 20);
    const result = useFoodItem(p, "wild_berry");
    expect(result.hungerRestored).toBe(54);
    expect(result.hpRestored).toBe(50);
    expect(result.staminaRestored).toBe(80);
    expect(p.hp).toBe(100);
    expect(p.stamina).toBe(100);
  });

  it("ignores items without food effects", () => {
    const p = hungryPlayer();
    expect(useFoodItem(p, "log").used).toBe(false);
  });
});
