# Versioning

The repo follows **[Semantic Versioning 2.0.0](https://semver.org/)**
(`MAJOR.MINOR.PATCH`). Every version — each package and the umbrella — is a valid
SemVer string; the tooling validates against the official grammar and rejects
anything else (`1.2`, `01.2.3`, `v1.2.3`, …).

## Two kinds of version

| | What it is | Examples here |
| --- | --- | --- |
| **Package versions** | Each workspace package versions itself independently. | `cli 1.4.0`, `server 0.2.1`, `client 0.2.0`, `shared 0.2.0`, `landing 0.4.0` |
| **App (umbrella) version** | The root `package.json` version — the project-wide roll-up shown in the game footer (`v…`). | `app 0.3.0` |

**The rule:** whenever a package is bumped, the **app** is bumped by **at least the
same SemVer level**. The app is a monotonic “how much has the project moved overall”
counter; it is *not* required to equal any single package's number.

What each level means (standard SemVer):

- **MAJOR** — incompatible/breaking change. Resets minor + patch to `0`.
- **MINOR** — backward-compatible feature. Resets patch to `0`.
- **PATCH** — backward-compatible fix.

## Bumping — `pnpm bump`

One command bumps a package **and** the app together, so they can't drift:

```bash
pnpm bump <cli|client|server|shared|landing> <major|minor|patch>
#  pnpm bump cli minor    → cli 1.4.0 → 1.5.0   AND  app 0.3.0 → 0.4.0
#  pnpm bump server patch → server 0.2.1 → 0.2.2 AND  app 0.4.0 → 0.4.1
pnpm bump app <level>     # bump only the umbrella version (catch-up)
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

The CLI is the only package published (to npm). To cut a release:

1. `pnpm bump cli <level>` (this also moves the app umbrella version).
2. Commit + merge to `main`.
3. Create a **GitHub Release** → CI publishes the CLI to npm.

Full publish details: [publishing-cli.md](publishing-cli.md).
