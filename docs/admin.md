# Admins & the protected API (NIP-98)

The server has an **admin list** of Nostr identities that may call protected
`/api/admin/*` endpoints and trigger a self-update from the game splash. Auth uses
**[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)** (HTTP Auth):
the caller signs a short-lived event with their Nostr key and sends it as an
`Authorization: Nostr …` header. No passwords, no sessions. For how the auth itself
works (and the player login flow), see [nostr-auth.md](nostr-auth.md).

## Configuring admins

Admins are stored in the **`ADMIN_NPUBS`** env var — a comma/space-separated list
of `npub1…` keys (raw 64-char hex also accepted):

```
ADMIN_NPUBS=npub1abc…,npub1def…
```

Manage it from the CLI (validates input, writes `.env`, restarts the daemon):

```
gorilator setup → Server settings → Manage admins (NIP-98)
   • Add admin        — paste an npub1… OR a NIP-05 identifier (name@domain,
                        resolved to an npub via /.well-known/nostr.json)
   • Remove an admin  — by list number or by pasting the npub
   • Remove all admins
```

The menu shows the current admin list. You can also set/edit `ADMIN_NPUBS` by hand
in the install's `.env` (comma/space-separated npubs); the daemon reads it on
(re)start, so changes apply after a restart (the CLI does this for you).

## Protected endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/admin/whoami` | NIP-98 (any valid key) | Returns `{ pubkey, isAdmin, adminCount, selfUpdate }`. Used by the splash to decide whether to show the admin "Update now" button. Does **not** 403 non-admins. |
| `GET /api/admin/admins` | NIP-98 (admin only) | Lists the configured admin npubs. |
| `POST /api/admin/update` | NIP-98 (admin only) | Triggers a self-update (see below). `202` when started, `409` when the server isn't a CLI-managed install. |

Server-side verification (`systems/nip98.ts`) checks the event signature, that the
`kind` is 27235, that the `u` (URL) and `method` tags match **this** request, and
that it's fresh — then checks the pubkey against `ADMIN_NPUBS` (`systems/admins.ts`).

To protect a new route, add the `requireAdmin` middleware:

```ts
import { requireAdmin } from "./systems/nip98";
app.post("/api/admin/something", requireAdmin, (req, res) => { /* req.adminPubkey is set */ });
```

## Admin self-update from the splash

When the auto-update check reports a new release (see
[publishing-cli.md](publishing-cli.md#auto-update-check)), the game splash shows an
"update available" banner. Below it:

- **Logged in via Nostr as an admin, on a CLI-managed install** → an **"⟳ Update now"**
  button. Clicking it `POST`s `/api/admin/update` (NIP-98 signed by the browser's
  NIP-07 extension). The server launches **`gorilator update`** detached (so it
  survives the daemon stopping), then the splash shows a **progress bar**, polls
  `/healthz` until the daemon has gone down and come back up on the new build, and
  **reloads** the page.
- **Anyone else** (not logged in, not an admin, or a non-managed deploy) → a hint to
  run `gorilator update` on the server instead.

Self-update only works when the server was started by `gorilator serve` (it sets
`GORILATOR_MANAGED=1` and `GORILATOR_BIN`). In dev / Docker / Railway, `/api/admin/update`
returns `409` and the splash shows the CLI hint. The detached updater logs to
`<appDir>/.gorilator-update.log`.

> Blast radius: triggering an update restarts the live daemon — identical to running
> `gorilator update` by hand. If the rebuild fails, the daemon is down until the
> updater finishes; check `gorilator logs` and `.gorilator-update.log`.
