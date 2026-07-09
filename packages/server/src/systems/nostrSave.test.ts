import { Player } from "@rpg/shared";
import { describe, expect, it } from "vitest";
import { sanitizeSaveContent } from "./nostr";
import { buildServerSave } from "./nostrSave";

describe("player save hunger compatibility", () => {
  it("loads v1 saves with default hunger", () => {
    const save = sanitizeSaveContent(JSON.stringify({ v: 1, hp: 50, maxHp: 100, stamina: 20, maxStamina: 100 }));
    expect(save?.v).toBe(1);
    expect(save?.hunger).toBe(100);
    expect(save?.maxHunger).toBe(100);
  });

  it("sanitizes v2 hunger values", () => {
    const save = sanitizeSaveContent(JSON.stringify({ v: 2, hunger: 120, maxHunger: 80 }));
    expect(save?.v).toBe(2);
    expect(save?.hunger).toBe(80);
    expect(save?.maxHunger).toBe(80);
  });

  it("publishes v2 saves with hunger fields", () => {
    const p = new Player();
    p.pubkey = "abc";
    p.hunger = 44;
    p.maxHunger = 90;
    const save = buildServerSave(p, []);
    expect(save.v).toBe(2);
    expect(save.hunger).toBe(44);
    expect(save.maxHunger).toBe(90);
  });
});
