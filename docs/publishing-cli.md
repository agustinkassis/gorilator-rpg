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

## Releasing a new version

1. Bump `version` in [`packages/cli/package.json`](../packages/cli/package.json).
   npm rejects re-publishing a version that already exists, so this **must** change.
2. Commit and merge to `main`.
3. Create a **GitHub Release** (e.g. tag `cli-vX.Y.Z`). Publishing the release fires CI.
4. Watch the run in the **Actions** tab; on success the new version is live on npm.

### Manual publish (fallback)

You can trigger the workflow by hand from **Actions → Publish CLI to npm → Run workflow**.
Only do this when `package.json` already has a fresh, unpublished version — otherwise the
`npm publish` step fails with "version already exists".

## Notes

- `packages/cli` is intentionally **excluded from the pnpm workspace** and uses plain
  `npm` (it ships standalone). CI reflects that — it runs `npm`, not `pnpm`, inside
  `packages/cli`.
- Only `dist/` and `README.md` are published (see the `files` field in `package.json`);
  the `prepublishOnly` script rebuilds `dist/` as a safety net.
