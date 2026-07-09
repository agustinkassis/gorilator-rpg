import { Player } from "@rpg/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("buildServerSave", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("snapshots player state, inventory, realm, and save reason", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T03:00:00.000Z"));
    const p = new Player();
    p.id = "sid-1";
    p.pubkey = "abc123";
    p.level = 7;
    p.xp = 42;
    p.hp = 88;
    p.maxHp = 140;
    p.stamina = 12;
    p.maxStamina = 33;
    p.hunger = 77;
    p.maxHunger = 120;
    p.x = 4;
    p.z = -9;
    p.rotY = 1.25;
    p.attack = 99;
    p.armor = 25;
    p.critChance = 0.31;
    p.moveSpeed = 6.5;
    p.throwPower = 1.75;
    p.hue = 210;

    const save = buildServerSave(
      p,
      [
        { type: "banana", count: 5 },
        { type: "potion", count: 1 },
      ],
      {
        reason: "realm-end",
        realm: { id: "realm-1", startedAt: 1234, wave: 6 },
      },
    );

    expect(save).toMatchObject({
      v: 2,
      playerPubkey: "abc123",
      reason: "realm-end",
      realm: { id: "realm-1", startedAt: 1234, wave: 6 },
      level: 7,
      xp: 42,
      hp: 88,
      maxHp: 140,
      stamina: 12,
      maxStamina: 33,
      hunger: 77,
      maxHunger: 120,
      x: 4,
      z: -9,
      rotY: 1.25,
      attack: 99,
      armor: 25,
      critChance: 0.31,
      moveSpeed: 6.5,
      throwPower: 1.75,
      hue: 210,
      inventory: [
        { type: "banana", count: 5 },
        { type: "potion", count: 1 },
      ],
      ts: Date.parse("2026-07-09T03:00:00.000Z"),
    });
  });
});
