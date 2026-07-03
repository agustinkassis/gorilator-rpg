import { defineConfig } from "@playwright/test";

// E2E ports are fixed and far from the dev ranges (5173/2567 defaults, 4100-7090
// worktree blocks) so test runs never collide with a live dev stack.
export const E2E_SERVER_PORT = 14620;
export const E2E_CLIENT_PORT = 14621;
// A second stack staged by scenarios/bot-arena.json (Feature Lab e2e).
export const E2E_SCENARIO_SERVER_PORT = 14630;
export const E2E_SCENARIO_CLIENT_PORT = 14631;

// The game canvas is WebGL — headless Chromium needs a software GL backend.
// RULE: assert on DOM / network / window.__perf, never on canvas pixels (the
// Babylon frame is timing-dependent and screenshots race HMR + animations).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  projects: [
    {
      name: "game",
      testMatch: /game-smoke\.spec\.ts/,
      use: {
        baseURL: `http://localhost:${E2E_CLIENT_PORT}`,
        launchOptions: {
          args: ["--use-gl=angle", "--use-angle=swiftshader"],
        },
      },
    },
    {
      name: "scenario",
      testMatch: /scenario\.spec\.ts/,
      use: {
        baseURL: `http://localhost:${E2E_SCENARIO_CLIENT_PORT}`,
        launchOptions: {
          args: ["--use-gl=angle", "--use-angle=swiftshader"],
        },
      },
    },
  ],
  // GORILATOR_TEST=1 keeps the room reproducible (no realm event → no waves).
  webServer: [
    {
      command: `GORILATOR_TEST=1 GAME_SERVER_PORT=${E2E_SERVER_PORT} pnpm --filter @rpg/server dev`,
      url: `http://localhost:${E2E_SERVER_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      command: `CLIENT_PORT=${E2E_CLIENT_PORT} VITE_SERVER_PORT=${E2E_SERVER_PORT} pnpm --filter @rpg/client dev`,
      url: `http://localhost:${E2E_CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    // The Feature Lab stack: same test mode, staged by scenarios/bot-arena.json
    // (GORILATOR_TEST must not disable scenario bots — scenario.spec.ts asserts it).
    {
      command: `GORILATOR_TEST=1 GORILATOR_SCENARIO=bot-arena GAME_SERVER_PORT=${E2E_SCENARIO_SERVER_PORT} pnpm --filter @rpg/server dev`,
      url: `http://localhost:${E2E_SCENARIO_SERVER_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      command: `CLIENT_PORT=${E2E_SCENARIO_CLIENT_PORT} VITE_SERVER_PORT=${E2E_SCENARIO_SERVER_PORT} pnpm --filter @rpg/client dev`,
      url: `http://localhost:${E2E_SCENARIO_CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
});
