# Nostr authentication

Gorilator authenticates people with **Nostr keys** — no passwords, no accounts, no
sessions. The browser's NIP-07 signer (Alby, nos2x, …) signs a short challenge; the
server verifies the signature and never sees a secret key.

There are **two** authentication flows, for two different jobs:

| Flow | Used for | Mechanism | Event kind |
| --- | --- | --- | --- |
| **Player login** | joining the game as a verified npub | NIP-42-style challenge over the Colyseus join | `22242` |
| **Admin HTTP auth** | calling protected `/api/admin/*` REST endpoints | [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) `Authorization` header | `27235` |

Both prove *control of a key right now*; neither is a long-lived token. Everything
here is **optional for players** — anonymous name-only play works fully. Admin auth
only matters if you configure admins (see [admin.md](admin.md)).

---

## 1. Player login — challenge / response (kind 22242)

The server hands out a one-time challenge; the client signs it with NIP-07 to prove
it controls a pubkey, and passes the signed event in the Colyseus **join options**.

```
client                                    server
  │  GET /nostr/challenge                   │
  │ ───────────────────────────────────────▶  issue a stateless, HMAC-signed
  │  ◀── { challenge, serverPubkey } ───────│  challenge (nonce.expiry.mac, TTL 5m)
  │                                         │
  │  window.nostr.signEvent:                │
  │   • auth:  kind 22242, tag the          │
  │            challenge + app="gorilator"  │
  │   • profile (optional): kind-0 metadata │
  │                                         │
  │  joinOrCreate("game", { name, nostr })  │
  │ ───────────────────────────────────────▶  verifyNostrLogin():
  │  ◀──────── joined / rejected ───────────│   sig ✓ · kind 22242 ✓ · app tag ✓
  │                                         │   · created_at fresh ✓ · challenge ours
  │                                         │   & unreplayed ✓ · profile same key ✓
```

**Verification** (`packages/server/src/systems/nostr.ts`, `verifyNostrLogin`):

1. `verifyEvent(auth)` — the signature + id are valid, so `auth.pubkey` signed it.
2. `kind === 22242`, the `app` tag is `gorilator` (a signature for this game can't be
   replayed against another app), and `created_at` is within 5 minutes.
3. The embedded `challenge` was **issued by us** (HMAC keyed by the server's secret
   key — stateless, so it survives restarts) and hasn't been used before.
4. Optional `profile` is a **kind-0** event signed by the **same** key → its
   `name` / `picture` / `nip05` are vouched, not client-asserted.

**Challenge design.** The challenge is `nonce.expiryMs.hmac` — there is no
server-side challenge store, so a login in flight across a (tsx-watch / deploy)
restart still validates. Replay within the TTL is blocked by a best-effort
used-nonce set plus the event's own `created_at` freshness window.

**One session per identity.** A second login for the same npub kicks the first with
WebSocket close code `NOSTR_TAKEOVER_CODE` (**4001**); the new session inherits the
old place, stats, and inventory.

> Endpoint: `GET /nostr/challenge` → `{ challenge, serverPubkey }`. `serverPubkey`
> also lets the client read its own **server-signed save** off the relays to preview
> recovered progress on the splash (see [nostr.md](nostr.md#2-progress-saves--realm-player-updates--kind-30078-server-signed)).

---

## 2. Admin HTTP auth — NIP-98 (kind 27235)

REST endpoints under `/api/admin/*` are gated by **NIP-98 HTTP Auth**. The caller
signs a kind-27235 event binding the exact request, and sends it as a header:

```
Authorization: Nostr <base64(signed kind-27235 event)>
```

The signed event carries:

- `u` tag — the **absolute request URL** (e.g. `https://play.example.com/api/admin/update`)
- `method` tag — the **HTTP method** (`get`, `post`, …)
- a fresh `created_at` (validated to within ~60 s)

**Verification** (`packages/server/src/systems/nip98.ts`, `verifyNip98` /
`requireAdmin`):

1. Parse the `Authorization: Nostr …` header and verify the event signature.
2. `kind === 27235`, `created_at` fresh, and the `u` + `method` tags match **this**
   request (so a token can't be replayed against a different route or verb).
3. `requireAdmin` then checks `event.pubkey` against the admin list
   (`ADMIN_NPUBS` → `isAdmin()`), responding `401` (bad/missing token) or `403`
   (valid key, not an admin).

URL matching honors `x-forwarded-proto` / `x-forwarded-host`, so it works behind a
Cloudflare tunnel where the public origin differs from the local bind.

### Calling a protected endpoint from the browser

The client builds the header with `nostr-tools` NIP-98 + the NIP-07 signer
(`packages/client/src/net/nostr.ts`, `nip98AuthHeader`):

```ts
import { nip98AuthHeader } from "./net/nostr";

const url = `${httpBase}/api/admin/whoami`;
const auth = await nip98AuthHeader(url, "get"); // signs a kind-27235 event
const res = await fetch(url, { headers: { Authorization: auth } });
const { pubkey, isAdmin } = await res.json();
```

### Calling it from a script / curl

Sign the token with any Nostr library, then:

```bash
curl -H "Authorization: Nostr <base64-event>" https://play.example.com/api/admin/whoami
```

### Protecting a new route

```ts
import { requireAdmin } from "./systems/nip98";

app.post("/api/admin/something", requireAdmin, (req, res) => {
  // req.adminPubkey is the verified admin's hex pubkey
  res.json({ ok: true });
});
```

See [admin.md](admin.md) for the admin list, the endpoints, and the splash
"Update now" self-update button that this auth gates.

---

## Trust model at a glance

- The server **never receives a secret key** — only signed events it can verify.
- Each flow binds the signature to **one purpose**: the login `app` tag + one-time
  challenge; the NIP-98 `u` + `method` tags + freshness. A signature for one can't be
  replayed for the other, for another app, or against another request.
- The **server's own key** (`NOSTR_NSEC`) is separate: it *signs* player saves and the
  discovery event — it does not authenticate anyone. Keep it stable across restarts.

## Kinds used in auth

| Kind | Signed by | Purpose |
| --- | --- | --- |
| `22242` | the player | NIP-42 client-auth — login challenge |
| `0` | the player | metadata (name/avatar/nip05), optional, vouched on login |
| `27235` | an admin | NIP-98 HTTP auth for `/api/admin/*` |

> For the full picture of Nostr in the project — saves, realm/player updates, and
> server discovery — see [nostr.md](nostr.md).
