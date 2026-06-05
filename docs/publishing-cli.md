# Publishing the CLI to npm

The [`gorilator`](https://www.npmjs.com/package/gorilator) CLI (in
[`packages/cli`](../packages/cli)) is published to the npm registry **automatically
by CI whenever a GitHub Release is published**. There is no manual `npm publish`
step and **no npm token is stored** — authentication uses npm
[OIDC Trusted Publishing](https://docs.npmjs.com/trusted-publishers).

## How it works

The workflow lives at [`.github/workflows/publish-cli.yml`](../.github/workflows/publish-cli.yml).

1. **Trigger** — `release: [published]` (a published GitHub Release). It also exposes
   `workflow_dispatch` so it can be run manually from the **Actions** tab as a fallback.
2. **Build & test** — in `packages/cli`: `npm install`, `npm run build` (tsc), `npm test`.
3. **Publish** — `npm publish`. No `NODE_AUTH_TOKEN`; the runner authenticates to npm
   via OIDC. Provenance is attached automatically (the job has `id-token: write`).
4. **npm version** — CI upgrades npm to latest first, because Trusted Publishing
   requires **npm ≥ 11.5.1** (Node 20 ships an older npm).

## One-time setup (already done)

Two things had to be configured once; they're in place and don't need redoing:

- **npm Trusted Publisher** — on the package's npmjs.com page
  (*Settings → Trusted Publisher*), GitHub Actions is linked to:
  - Organization/user: `agustinkassis`
  - Repository: `gorilator-rpg`
  - Workflow filename: `publish-cli.yml`
  - Allowed action: `npm publish`
- **Workflow on the default branch** — release-triggered workflows always run from
  the version of the file on the **default branch** (`main`), so the workflow must be
  merged to `main` to take effect.

> If the workflow file is ever renamed, the Trusted Publisher entry on npmjs.com must
> be updated to match the new filename, or publishes will fail authentication.

## Versioning

Each workspace package keeps its **own** version. The root `package.json` version is
the project-wide **umbrella ("app") version** — it advances by the same semver level
whenever any package is bumped. Always bump with the helper so the two move together:

```
pnpm bump <cli|client|server|shared|landing> <major|minor|patch>
# e.g. pnpm bump cli minor   →  cli 1.4.0→1.5.0  AND  app 0.3.0→0.4.0
pnpm bump app <level>        # bump only the umbrella version (catch-up)
```

(See [`scripts/bump.mjs`](../scripts/bump.mjs). It rewrites just the `version` field,
so all other package.json formatting is preserved.)

A PR CI check enforces this — [`version-guard.yml`](../.github/workflows/version-guard.yml)
fails if a package version changed without the app version bumping by at least the same
level. Run it locally with `pnpm version:check` (compares against `origin/main`).

## Releasing a new version

1. **Bump the CLI:** `pnpm bump cli <major|minor|patch>` (this also bumps the app
   umbrella version). npm rejects re-publishing an existing version, so this **must**
   change the CLI version.
2. Commit and merge to `main`.
3. Create a **GitHub Release** (e.g. tag `cli-vX.Y.Z`). Publishing the release fires CI.
4. Watch the run in the **Actions** tab; on success the new version is live on npm.

### Manual publish (fallback)

You can trigger the workflow by hand from **Actions → Publish CLI to npm → Run workflow**.
Only do this when `package.json` already has a fresh, unpublished version — otherwise the
`npm publish` step fails with "version already exists".

## Auto-update check

A self-hosted daemon (`gorilator install`) **automatically checks GitHub for new
releases** and surfaces an alert so operators know when to run `gorilator update`.

**How it works**

- The game server (the supervised daemon process) runs a periodic check
  ([`packages/server/src/systems/updateCheck.ts`](../packages/server/src/systems/updateCheck.ts)).
  It calls the GitHub Releases API for the repo and compares the latest release's
  publish date against the local git `HEAD` commit date — i.e. "was a release cut
  after the code I'm running?".
- The verdict is cached and exposed at **`GET /api/update`**.
- **Game splash:** on load, the client polls `/api/update` and, if an update
  exists, shows a small dismissible "⬆ Update available — &lt;tag&gt;" banner
  linking to the GitHub release (see `packages/client/src/ui/splash.ts`).
- **CLI:** `gorilator status` (and the interactive menu's *Status*) prints an
  `Update:` line — `⬆ <tag> available — run 'gorilator update'` — when the daemon
  reports one.

**Configuring the interval**

In `gorilator setup → Server settings → Auto-update check interval`, enter the
check interval in hours (`0` disables it). This writes `UPDATE_CHECK_HOURS` to the
install's `.env` and restarts the daemon. Default is **every 1 hour**.

Related env vars (see [configuration.md](configuration.md#2-environment-variables-envexample)):
`UPDATE_CHECK_HOURS`, `UPDATE_REPO`, `GITHUB_TOKEN` (optional, lifts the API rate limit).

## Notes

- `packages/cli` is intentionally **excluded from the pnpm workspace** and uses plain
  `npm` (it ships standalone). CI reflects that — it runs `npm`, not `pnpm`, inside
  `packages/cli`.
- Only `dist/` and `README.md` are published (see the `files` field in `package.json`);
  the `prepublishOnly` script rebuilds `dist/` as a safety net.
