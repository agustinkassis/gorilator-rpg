import { expect, test } from "@playwright/test";
import { E2E_SCENARIO_SERVER_PORT } from "../../playwright.config";

// Feature Lab e2e (#65/#66/#68/#69): the server is staged by
// scenarios/bot-arena.json (GORILATOR_SCENARIO) and the client auto-joins via
// ?scenario=. Assertions follow the DOM-not-canvas rule (docs/TESTING.md):
// /api/status, room state through window.__rpg, and panel DOM — never pixels.

const serverUrl = (path: string) => `http://localhost:${E2E_SCENARIO_SERVER_PORT}${path}`;

test("the server reports the active scenario and its pinned seed", async ({ request }) => {
  const res = await request.get(serverUrl("/api/status"));
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    activeScenario: string | null;
    cycleSeed: { seed: number; source: string } | null;
  };
  expect(body.activeScenario).toBe("bot-arena");
  expect(body.cycleSeed?.source).toBe("scenario"); // manifest seed 68 pins the cycle
  expect(body.cycleSeed?.seed).toBe(68);
});

test("?scenario= auto-joins single-player with bots alive and the tweaks panel pinned", async ({
  page,
}) => {
  const wsPromise = page.waitForEvent("websocket", {
    predicate: (ws) => ws.url().includes(`:${E2E_SCENARIO_SERVER_PORT}`),
    timeout: 60_000,
  });

  await page.goto("/?scenario=bot-arena");

  // No splash gate: the realtime channel opens without any name/credentials UI.
  await wsPromise;

  // The room holds me + the manifest's two bots (GORILATOR_TEST=1 disables the
  // realm event, NOT scenario bots — this guards the events-disabled path).
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const rpg = (window as { __rpg?: { net?: { room?: { state?: { players?: { size: number } } } } } }).__rpg;
          return rpg?.net?.room?.state?.players?.size ?? 0;
        }),
      { timeout: 60_000 },
    )
    .toBe(3);

  // The render loop is alive (frames are being produced — canvas never inspected).
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const perf = (window as { __perf?: { latest?: () => { fps?: number } | null } }).__perf;
          return perf?.latest?.()?.fps ?? 0;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);

  // The Dev Mode gameplay panel carries the pinned Scenario tweaks + Bake button
  // (rendered into #devGameplayPanel on the server's "scenario" message).
  const panel = page.locator("#devGameplayPanel");
  await expect(panel).toContainText("Scenario tweaks — bot-arena", { timeout: 30_000 });
  await expect(panel).toContainText("Bake values");
  await expect(panel).toContainText("Bots");
});
