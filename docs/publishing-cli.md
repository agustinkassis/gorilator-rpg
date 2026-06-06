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
2. **Version gate** — the job first checks `npm view gorilator@<version>`. If that exact
   CLI version is **already on npm, it skips** build/test/publish (the job still passes).
   The CLI package version should match the app release tag, so npm and GitHub
   publish the same SemVer version.
3. **Build & test** — in `packages/cli`: `npm install`, `npm run build` (tsc), `npm test`.
4. **Publish** — `npm publish`. No `NODE_AUTH_TOKEN`; the runner authenticates to npm
   via OIDC. Provenance is attached automatically (the job has `id-token: write`).
   CI upgrades npm to latest first (Trusted Publishing needs **npm ≥ 11.5.1**).

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

The root `package.json` version is the project-wide **app release version**.
GitHub Release tags use that version, and the npm `gorilator` package must match
it. Always bump with the helper so the CLI package and app release move together:

```
pnpm bump <cli|client|server|shared|landing> <major|minor|patch>
# e.g. pnpm bump cli minor   →  cli 1.4.0→1.5.0  AND  app 1.4.0→1.5.0
pnpm bump app <level>        # bump the app release version
```

(See [`scripts/bump.mjs`](../scripts/bump.mjs). It rewrites just the `version` field,
so all other package.json formatting is preserved.)

A PR CI check enforces this — [`version-guard.yml`](../.github/workflows/version-guard.yml)
fails if a package version changed without the app version bumping by at least the same
level, or if the CLI/npm package version differs from the app release version.
Run it locally with `pnpm version:check` (compares against `origin/main`).

## Releasing a new version

1. **Bump the CLI:** `pnpm bump cli <major|minor|patch>` (this also bumps the app
   release version). The CLI package version and app version must match before
   releasing.
2. Commit and merge to `main`.
3. Create a **GitHub Release** tagged with the **app release version**, e.g.
   `vX.Y.Z` — the daemon auto-update compares the release tag's version against the
   app version (see [Auto-update check](#auto-update-check) below). Publishing the
   release fires CI.
4. Watch the run in the **Actions** tab; on success the new CLI version is live on npm.

Publishing a release also fires
[`release-dist.yml`](../.github/workflows/release-dist.yml), which builds the game once
and attaches a **prebuilt dist** asset (`gorilator-dist-<tag>.tar.gz` + `SHA256SUMS`) to
the release. `gorilator install`/`update` download that instead of building locally — see
[Prebuilt install](#prebuilt-install-fast-path) below.

## Prebuilt install (fast path)

`gorilator install`/`update` default to the **latest published release** (ref `latest`) and,
for the standard same-origin deploy, **download the release's prebuilt dist** rather than
running the ~45s client build. The daemon serves that prebuilt `packages/client/dist` and
runs the server from source via `tsx`, so building the client on the box is unnecessary.

- It still runs `pnpm install` (for the server's runtime deps + `tsx`); only the build is skipped.
- Falls back to **building from source** when there's no prebuilt asset — branch refs
  (`--ref main`), forks without the asset, non-same-origin builds (`--server-url` / an explicit
  `--client-port`), a checksum mismatch, or offline.
- `gorilator update` re-resolves the newest release each run when installed on the `latest`
  channel (stored in the install config); a pinned `--ref` updates to that ref.

Build the artifact for an existing tag manually via **Actions → Release prebuilt dist → Run
workflow** (`tag` input). The asset is **same-origin only**.

### Manual publish (fallback)

You can trigger the workflow by hand from **Actions → Publish CLI to npm → Run workflow**.
It's safe to run anytime: if the CLI version is already on npm the version gate skips,
otherwise it publishes.

## Auto-update check

A self-hosted daemon (`gorilator install`) **automatically checks GitHub for new
releases** and surfaces an alert so operators know when to run `gorilator update`.

**How it works**

- The game server (the supervised daemon process) runs a periodic check
  ([`packages/server/src/systems/updateCheck.ts`](../packages/server/src/systems/updateCheck.ts)).
  It calls the GitHub Releases API and compares (SemVer) the latest release's tag
  version against the local **app (umbrella) version** — the root `package.json`
  version, **not** the CLI or server version. So releases must be tagged with the app
  version (e.g. `v0.4.0`). If a tag has no parseable version, it falls back to
  comparing the release date against the local git `HEAD` commit date.
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
