// Shared server-settings menus (admins + auto-update interval) used by BOTH the
// system-install setup (commands/setup.ts) and the in-repo project setup
// (commands/projectSetup.ts). Each caller supplies how to read/write its env and
// restart its daemon; the menu logic lives here once.
import * as log from "./log.js";
import { selectMenu } from "./menu.js";
import { isValidNpub, nip05ToNpub } from "./npub.js";
import { ask, confirm } from "./proc.js";

/** Everything the shared menus need from a caller (system vs project differ). */
export interface ServerSettingsCtx {
  /** Current env (a fresh snapshot — the admins menu re-fetches per iteration). */
  env: Record<string, string>;
  /** Persist an env patch (system: install .env w/ sudo; project: repo .env). */
  write(patch: Record<string, string>, message: string): void;
  /** Restart the daemon so the change takes effect (may be async). */
  restart(): void | Promise<void>;
}

function pause(): void {
  ask("\nPress Enter to continue… ");
}

/** Parse ADMIN_NPUBS into a clean npub list. */
export function parseAdminNpubs(raw: string | undefined): string[] {
  return (raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Hint for the admins menu row: how many are configured. */
export function adminsHint(raw: string | undefined): string {
  const n = parseAdminNpubs(raw).length;
  return n === 0 ? "none" : `${n} configured`;
}

/** Hint for the auto-update menu row: the current interval (1h default, 0=off). */
export function updateCheckHint(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return "every 1h (default)";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "disabled";
  return `every ${n}h`;
}

/** Add/remove the admin npubs allowed to call the protected /api/admin/* API
 *  (NIP-98 auth) and trigger updates from the splash. `get` returns a fresh ctx
 *  each iteration so the list reflects prior edits. */
export async function adminsMenu(get: () => ServerSettingsCtx): Promise<void> {
  for (;;) {
    const ctx = get();
    const admins = parseAdminNpubs(ctx.env.ADMIN_NPUBS);
    const list =
      admins.length === 0
        ? "  (no admins configured)\n"
        : admins.map((n, i) => `  ${i + 1}. ${n.slice(0, 14)}…${n.slice(-6)}`).join("\n") + "\n";
    const choice = await selectMenu(`Admins (NIP-98)\n${list}`, [
      { label: "Add admin", hint: "npub1… or NIP-05 (name@domain)" },
      { label: "Remove an admin", hint: admins.length ? `${admins.length} configured` : "none" },
      { label: "Remove all admins", hint: admins.length ? `${admins.length} configured` : "none" },
      { label: "Back" },
    ]);

    if (choice === 0) await addAdmin(ctx);
    else if (choice === 1) await removeAdmin(ctx);
    else if (choice === 2) await removeAllAdmins(ctx);
    else return;
  }
}

/** Add an admin by npub1… or NIP-05 identifier (name@domain, resolved to npub). */
async function addAdmin(ctx: ServerSettingsCtx): Promise<void> {
  const input = ask("Admin npub1… or NIP-05 (name@domain): ").trim();
  if (!input) return;

  let npub: string | null = null;
  if (input.includes("@")) {
    log.info(`Resolving NIP-05 ${input}…`);
    npub = await nip05ToNpub(input);
    if (!npub) {
      log.warn(`Couldn't resolve NIP-05 '${input}'. No change made.`);
      pause();
      return;
    }
    log.ok(`Resolved to ${npub.slice(0, 14)}…${npub.slice(-6)}`);
  } else if (isValidNpub(input)) {
    npub = input;
  } else {
    log.warn("Enter a valid npub1… key or a NIP-05 identifier (name@domain). No change made.");
    pause();
    return;
  }

  const admins = parseAdminNpubs(ctx.env.ADMIN_NPUBS);
  if (admins.includes(npub)) {
    log.ok("That npub is already an admin.");
    pause();
    return;
  }
  admins.push(npub);
  ctx.write({ ADMIN_NPUBS: admins.join(",") }, `Added admin ${npub.slice(0, 14)}….`);
  await ctx.restart();
  pause();
}

async function removeAdmin(ctx: ServerSettingsCtx): Promise<void> {
  const admins = parseAdminNpubs(ctx.env.ADMIN_NPUBS);
  if (admins.length === 0) {
    log.warn("No admins to remove.");
    pause();
    return;
  }
  const raw = ask(`Remove which? Enter the number (1-${admins.length}) or paste the npub: `).trim();
  let idx = Number(raw) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= admins.length) {
    idx = admins.indexOf(raw);
  }
  if (idx < 0) {
    log.warn("No matching admin. No change made.");
    pause();
    return;
  }
  const [removed] = admins.splice(idx, 1);
  ctx.write({ ADMIN_NPUBS: admins.join(",") }, `Removed admin ${removed.slice(0, 14)}….`);
  await ctx.restart();
  pause();
}

async function removeAllAdmins(ctx: ServerSettingsCtx): Promise<void> {
  const admins = parseAdminNpubs(ctx.env.ADMIN_NPUBS);
  if (admins.length === 0) {
    log.warn("No admins to remove.");
    pause();
    return;
  }
  if (!confirm(`Remove ALL ${admins.length} admin(s)? This clears ADMIN_NPUBS.`)) return;
  ctx.write({ ADMIN_NPUBS: "" }, `Removed all ${admins.length} admin(s).`);
  await ctx.restart();
  pause();
}

/** Prompt for the daemon's release-check interval in hours (0 disables) and
 *  persist it as UPDATE_CHECK_HOURS, then restart so the server picks it up. */
export async function updateAutoUpdateInterval(ctx: ServerSettingsCtx): Promise<void> {
  const current = ctx.env.UPDATE_CHECK_HOURS?.trim() || "1";
  process.stdout.write(
    "How often should the daemon check GitHub for a new release?\n" +
      "  Enter hours (e.g. 1, 6, 24). Enter 0 to disable auto-update checks.\n",
  );
  const raw = ask(`Check interval in hours [${current}]: `).trim() || current;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    log.warn("Enter a non-negative number of hours. No change made.");
    pause();
    return;
  }
  const value = String(Math.floor(n));
  ctx.write(
    { UPDATE_CHECK_HOURS: value },
    n === 0
      ? "Disabled the daemon auto-update check."
      : `Set the daemon auto-update check to every ${value}h.`,
  );
  await ctx.restart();
  pause();
}
