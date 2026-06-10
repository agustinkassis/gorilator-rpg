import { expect, test } from "@playwright/test";

// Landing assertions are DOM-state based, never screenshots: the scroll-reveal
// animations race visual captures (opacity transitions), but locator state and
// fetched responses are deterministic.

test("the landing page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Gorilator/i);
  // The React root mounts real content (not an empty shell).
  await expect
    .poll(async () => (await page.locator("body").innerText()).trim().length)
    .toBeGreaterThan(50);
});

test("install.sh is served from the site root", async ({ request }) => {
  // packages/cli/install.sh is the single source of truth; the vite plugin
  // serves it live in dev and emits it into dist on build.
  const res = await request.get("/install.sh");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain("gorilator");
});

test("the live stats dashboard mounts without crashing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto("/stats.html");
  await expect(page).toHaveTitle(/Live Stats/i);
  // The dashboard polls external Nostr relays — reachability isn't asserted,
  // only that the app itself mounts and doesn't throw.
  await expect
    .poll(async () => (await page.locator("body").innerText()).trim().length)
    .toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
