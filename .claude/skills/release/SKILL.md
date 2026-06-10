---
name: release
description: Bump versions and prepare a release per the SemVer policy. Use for release/publish/bump version requests.
---

# Release / version bump

**Never hand-edit a `version` field.** The tool keeps package + app versions in lock-step:

1. `pnpm bump <cli|client|server|shared|landing|app> <major|minor|patch>` — bumps the package AND the root app version together. Package versions (including the CLI's) are independent of the app release version; CI publishes the CLI only when its version isn't already on npm.
2. `pnpm version:check` — verifies the bump topology (CI's version-guard runs the same script; it FAILS the PR otherwise).
3. Merge to the `targetBranch` from `codex-workflow.json` (do not assume `main`).
4. Create a GitHub Release tagged with the **app** version. CI then:
   - publishes `gorilator` to npm via OIDC Trusted Publishing (no token; skips if that version already exists) — `.github/workflows/publish-cli.yml`
   - builds + attaches the prebuilt dist tarball — `.github/workflows/release-dist.yml`

Full policy: `docs/versioning.md` · CLI pipeline: `docs/publishing-cli.md`.
