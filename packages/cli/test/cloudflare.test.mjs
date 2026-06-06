import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const { extractQuickTunnelUrl } = await import(join(testDir, "..", "dist", "lib", "cloudflare.js"));

test("extracts the trycloudflare URL from cloudflared output", () => {
  const log = [
    "2026-06-06T20:00:00Z INF Thank you for trying Cloudflare Tunnel.",
    "2026-06-06T20:00:01Z INF +--------------------------------------+",
    "2026-06-06T20:00:01Z INF |  https://brave-gorilla-1234.trycloudflare.com |",
    "2026-06-06T20:00:01Z INF +--------------------------------------+",
  ].join("\n");
  assert.equal(extractQuickTunnelUrl(log), "https://brave-gorilla-1234.trycloudflare.com");
});

test("returns the most recent URL when the tunnel has restarted", () => {
  const log = [
    "https://old-one-0001.trycloudflare.com",
    "...later restart...",
    "https://new-two-9999.trycloudflare.com",
  ].join("\n");
  assert.equal(extractQuickTunnelUrl(log), "https://new-two-9999.trycloudflare.com");
});

test("returns null when no URL has been printed yet", () => {
  assert.equal(extractQuickTunnelUrl("INF Starting tunnel\nINF Registered connIndex=0"), null);
  assert.equal(extractQuickTunnelUrl(""), null);
});
