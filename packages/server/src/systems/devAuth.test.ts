import { describe, expect, it } from "vitest";
import { canUseDevCommands, devCommandsOpen } from "./devAuth";

// The dev_* family must FAIL CLOSED: a `gorilator` CLI install runs the server
// with NODE_ENV unset, so anything but an explicit dev/test signal has to mean
// "admin-only". These tests pin that policy.

const anon = { nostrVerified: false, pubkey: "" };
const verifiedUser = { nostrVerified: true, pubkey: "a".repeat(64) };
const verifiedAdmin = { nostrVerified: true, pubkey: "b".repeat(64) };
const spoofedAdmin = { nostrVerified: false, pubkey: "b".repeat(64) };
const isAdminStub = (pubkey: string) => pubkey === verifiedAdmin.pubkey;

describe("devCommandsOpen", () => {
  it("opens only on an explicit dev/test signal", () => {
    expect(devCommandsOpen({ NODE_ENV: "development" })).toBe(true);
    expect(devCommandsOpen({ NODE_ENV: "test" })).toBe(true);
    expect(devCommandsOpen({ GORILATOR_TEST: "1" })).toBe(true);
  });

  it("is closed by default — production AND the unset CLI-install env", () => {
    expect(devCommandsOpen({ NODE_ENV: "production" })).toBe(false);
    expect(devCommandsOpen({})).toBe(false); // gorilator serve: NODE_ENV unset
    expect(devCommandsOpen({ NODE_ENV: "staging" })).toBe(false);
    expect(devCommandsOpen({ GORILATOR_TEST: "0" })).toBe(false);
  });
});

describe("canUseDevCommands", () => {
  it("allows everyone on an explicit dev server", () => {
    const env = { NODE_ENV: "development" };
    expect(canUseDevCommands(anon, env, isAdminStub)).toBe(true);
    expect(canUseDevCommands(undefined, env, isAdminStub)).toBe(true);
  });

  it("allows only Nostr-verified admins on a production server", () => {
    const env = { NODE_ENV: "production" };
    expect(canUseDevCommands(verifiedAdmin, env, isAdminStub)).toBe(true);
    expect(canUseDevCommands(verifiedUser, env, isAdminStub)).toBe(false);
    expect(canUseDevCommands(anon, env, isAdminStub)).toBe(false);
    expect(canUseDevCommands(undefined, env, isAdminStub)).toBe(false);
  });

  it("rejects an admin pubkey that was never signature-verified", () => {
    // A client can CLAIM any pubkey; only nostrVerified means the server
    // checked the signed login challenge. A spoofed admin key must not pass.
    expect(canUseDevCommands(spoofedAdmin, { NODE_ENV: "production" }, isAdminStub)).toBe(false);
  });

  it("fails closed on the env-less gorilator CLI install", () => {
    expect(canUseDevCommands(anon, {}, isAdminStub)).toBe(false);
    expect(canUseDevCommands(verifiedAdmin, {}, isAdminStub)).toBe(true);
  });
});
