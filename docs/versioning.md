# Versioning

The repo follows **[Semantic Versioning 2.0.0](https://semver.org/)**
(`MAJOR.MINOR.PATCH`). Every version — each package and the umbrella — is a valid
SemVer string; the tooling validates against the official grammar and rejects
anything else (`1.2`, `01.2.3`, `v1.2.3`, …).

## Two kinds of version

| | What it is | Examples here |
| --- | --- | --- |
| **App release version** | The root `package.json` version — the project-wide version shown in the game footer (`v…`) and used for GitHub Release tags. | `app 1.5.0` |
| **npm CLI version** | The published `gorilator` package version. It is independent from the app release version. | `cli 1.5.0` |
| **Other package versions** | Internal workspace package versions. They still bump with SemVer when their package changes. | `server 0.2.1`, `client 0.2.0`, `shared 0.2.0` |

**The rule:** the **app** version is the release version. GitHub Release tags use
the app version. Whenever any package is bumped, the app is bumped by at least
the same SemVer level. Package versions are independent; the CLI only publishes
to npm when `packages/cli/package.json` changes to a version that is not already
published.

What each level means (standard SemVer):

- **MAJOR** — incompatible/breaking change. Resets minor + patch to `0`.
- **MINOR** — backward-compatible feature. Resets patch to `0`.
- **PATCH** — backward-compatible fix.

## Bumping — `pnpm bump`

One command bumps a package **and** the app together, so they can't drift:

```bash
pnpm bump <cli|client|server|shared> <major|minor|patch>
#  pnpm bump cli minor    → cli 1.4.0 → 1.5.0   AND  app 1.4.0 → 1.5.0
#  pnpm bump server patch → server 0.2.1 → 0.2.2 AND  app 0.4.0 → 0.4.1
pnpm bump app <level>     # bump the app release version
```

If several packages change in one release, bump each (the app advances each time)
or bump the app once by the **highest** level involved.

Increments follow npm's `semver.inc` semantics, including **finalizing a
prerelease** (`pnpm bump` on `1.4.0-rc.1`):

| current | `patch` | `minor` | `major` |
| --- | --- | --- | --- |
| `1.4.0` | `1.4.1` | `1.5.0` | `2.0.0` |
| `1.4.0-rc.1` | `1.4.0` | `1.4.0` | `2.0.0` |
| `1.0.0-rc.1` | `1.0.0` | `1.0.0` | `1.0.0` |

Build metadata (`+…`) is dropped on bump (it carries no precedence in SemVer).
The project ships plain releases; create a prerelease by hand only if you need one.

Source: [`scripts/bump.mjs`](../scripts/bump.mjs). It rewrites only the `version`
field, preserving the rest of each `package.json`'s formatting.

## Enforcement — the version guard

A PR check makes the rule un-skippable:

- Workflow: [`.github/workflows/version-guard.yml`](../.github/workflows/version-guard.yml)
  runs on every PR to `main`.
- Logic: [`scripts/check-versions.mjs`](../scripts/check-versions.mjs) compares each
  package's version against the branch's **fork point** with `main`. If any package
  changed, the app version must have changed by **≥** the highest level among them —
  otherwise the check fails with the exact `pnpm bump …` command to run.
- Run it locally: `pnpm version:check` (compares against `origin/main`).

A prerelease-only change (e.g. `1.4.0-rc.1` → `1.4.0-rc.2`) counts as a `patch` for
the guard, so it still requires an app bump.

## Releasing

GitHub Releases are tagged with the app release version. To cut a release:

1. Bump each changed package with `pnpm bump <package> <level>`; this also moves
   the app release version. Use `pnpm bump app <level>` for app-only releases.
2. Commit + merge to `main`.
3. Create a **GitHub Release** tagged with the app version. CI publishes the CLI
   only if the CLI package version in that release is not already on npm.

Full publish details: [publishing-cli.md](publishing-cli.md).
