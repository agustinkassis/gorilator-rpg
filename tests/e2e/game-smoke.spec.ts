import { expect, test } from "@playwright/test";
import { E2E_SERVER_PORT } from "../../playwright.config";

// Headless smoke test of the full stack: Vite client + Colyseus server
// (GORILATOR_TEST=1 → no goblin waves, reproducible room). Asserts on observable
// side effects — the WebSocket, /api/status, and window.__perf — NEVER on canvas
// pixels (WebGL output under swiftshader is not a stable assertion target).

const serverUrl = (path: string) => `http://localhost:${E2E_SERVER_PORT}${path}`;

test("server health endpoints respond", async ({ request }) => {
  const health = await request.get(serverUrl("/healthz"));
  expect(health.status()).toBe(200);
  const status = await request.get(serverUrl("/api/status"));
  expect(status.status()).toBe(200);
  const body = await status.json();
  expect(body).toHaveProperty("name");
  expect(body).toHaveProperty("version");
});

test("a guest can join: websocket connects, the room sees the player, the render loop runs", async ({
  page,
}) => {
  // The Colyseus WS goes to the game server port (Vite's HMR socket stays on the
  // client port, so the predicate can't confuse them).
  const wsPromise = page.waitForEvent("websocket", {
    predicate: (ws) => ws.url().includes(`:${E2E_SERVER_PORT}`),
    timeout: 60_000,
  });

  await page.goto("/");

  // Splash → type a guest name → ENTER unlocks → join.
  const name = page.locator("#nameInput");
  await name.waitFor({ state: "visible", timeout: 30_000 });
  await name.fill("SmokeBot");
  const enter = page.locator("#enterBtn");
  await expect(enter).toBeEnabled();
  await enter.click();

  // 1. The realtime channel to the authoritative server opens.
  await wsPromise;

  // 2. The server's realm tracker registers the player.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(serverUrl("/api/status"));
        const body = (await res.json()) as {
          currentRealm: { players: number } | null;
        };
        return body.currentRealm?.players ?? 0;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);

  // 3. The Babylon render loop is alive (fps > 0 proves frames are being built —
  //    the canvas itself is never inspected).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const perf = (window as { __perf?: { latest(): { fps: number } | null } }).__perf;
          return perf?.latest()?.fps ?? 0;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
});

test("hunger scenario auto-joins and food restores hunger", async ({ page }) => {
  const wsPromise = page.waitForEvent("websocket", {
    predicate: (ws) => ws.url().includes(`:${E2E_SERVER_PORT}`),
    timeout: 60_000,
  });

  await page.goto("/?scenario=hunger&autojoin=HungerBot");
  await wsPromise;

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const rpg = (window as { __rpg?: { net?: { room?: unknown } } }).__rpg;
          const room = rpg?.net?.room as
            | { sessionId: string; state: { players: Map<string, { hunger: number }> } }
            | undefined;
          return room?.state.players.get(room.sessionId)?.hunger ?? null;
        }),
      { timeout: 60_000 },
    )
    .not.toBeNull();

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const rpg = (window as { __rpg?: { net?: { room?: unknown } } }).__rpg;
          const room = rpg?.net?.room as
            | { sessionId: string; state: { players: Map<string, { hunger: number }> } }
            | undefined;
          return room?.state.players.get(room.sessionId)?.hunger ?? 100;
        }),
      { timeout: 60_000 },
    )
    .toBeLessThan(32);
  const before = await page.evaluate(() => {
    const rpg = (window as { __rpg?: { net?: { room?: unknown } } }).__rpg;
    const room = rpg?.net?.room as
      | { sessionId: string; state: { players: Map<string, { hunger: number }> } }
      | undefined;
    return room?.state.players.get(room.sessionId)?.hunger ?? 0;
  });

  await page.evaluate(() => {
    const rpg = (window as { __rpg?: { net?: { sendUseItem(slot: number): void } } }).__rpg;
    rpg?.net?.sendUseItem(0);
  });

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const rpg = (window as { __rpg?: { net?: { room?: unknown } } }).__rpg;
          const room = rpg?.net?.room as
            | { sessionId: string; state: { players: Map<string, { hunger: number }> } }
            | undefined;
          return room?.state.players.get(room.sessionId)?.hunger ?? 0;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(before + 10);
});
