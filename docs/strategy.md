# Strategy — positioning, funding & growth

The public business/growth strategy for Gorilator. It lives in the repo on
purpose: an open-source project's strategy is a marketing asset, not a secret
— grant committees, contributors, and operators should all be able to read
where this is going. The product side: [vision.md](vision.md) ·
[ROADMAP.md](../ROADMAP.md). The protocol artifact most cited below:
[federation.md](federation.md).

## Positioning

**Primary tagline:** *Your character belongs to you. Not to a server.*

| Audience | Pitch |
| --- | --- |
| **Players** | An MMO where your character is yours — log in with your Nostr key, play anywhere, and no company can delete you. |
| **Operators** | *Run a world in five minutes.* `npx gorilator install` → a self-hosted realm with its own policies, auto-announced to the network. |
| **Creators** | Build content inside the game, publish it as a signed Nostr event, watch it appear in other people's worlds. |
| **Nostr community** | *The MMORPG that is a Nostr app.* Identity, saves, discovery, content, and (eventually) payments — all NIPs and relays, no proprietary backend. |
| **Grant committees** | A working reference implementation that Nostr is an application platform: portable game identity, a federation spec other games can adopt ([federation.md](federation.md)), and verifiable on-relay traction. |

**Pivot messaging — expansion, not replacement.** Nothing players love is
removed: "the siege is over; now we rebuild the town — and the goblins still
come back on Fridays." Tower defense becomes the first event module
("La Crypta Defense") of a growing sandbox.

## Business model

Sequenced, grants-first. Each stage funds the next without compromising the
open-source core:

1. **Grants** (primary, years 1–2) — see the funding sequence below.
2. **Donations/zaps** — a [Geyser](https://geyser.fund) page,
   [GitHub Sponsors](https://github.com/sponsors), and NIP-57 zaps to the
   project npub.
3. **Managed realms** (~$10–30/mo, from month 6+) — productizes the existing
   CLI/installer: we host your world, you own its policy and keys.
4. **Hosted AI Forge generation fees** (Phase 4+) — sats-native, per-generation
   pricing on prompt-to-content creation ([ai-creation.md](ai-creation.md));
   complements managed realms (operators can always bring their own provider
   keys instead).
5. **Marketplace fee experiments** (month 9+) — opt-in, operator-adjustable
   fees on sats-economy trades; never required to play or host.
6. **Sponsorships & bounties** — sponsored events, feature bounties.
7. **Custom worlds consulting** — branded realms for communities/companies.

**Never:** a token, pay-to-win defaults, custodial sats, an ad-injected
client.

## Funding sequence

### First wave — three applications out together (July 2026)

1. **[OpenSats](https://opensats.org) Nostr Fund** — apply when the window
   reopens early July. Frame as **protocol + infrastructure deliverables**:
   the portable-identity spec, the content protocol (kind 30333), federation
   ([federation.md](federation.md)) — not "fund my game". Needs two reference
   letters — source via the [La Crypta](https://lacrypta.ar) network.
2. **[Spiral](https://spiral.xyz) developer grant** — a **primary target, not
   a fallback**. Spiral funds full-time open-source Bitcoin/Lightning/Nostr
   developers on renewable year-long grants and skews protocol/infrastructure,
   so the pitch is the *protocol layer*, not the game: portable game identity
   as NIP drafts, the federation/save spec other games can implement
   (the application artifact — [federation.md](federation.md) — already
   exists), and NWC sats-economy rails, with Gorilator as the reference
   implementation proving Nostr is an application platform. The flagship
   game's traction (servers online, verifiable on relays) is the evidence; the
   spec work is the deliverable. A Spiral grant is the single best outcome for
   the solo-dev model: one full-time renewable salary with no milestone
   bureaucracy.
3. **[Btrust](https://btrust.tech) developer grant** — now covers LatAm;
   rolling applications, quarterly cohorts, BTC-paid. Second route in via La
   Crypta education/events programs.

### Second wave

- **[HRF Bitcoin Development Fund](https://hrf.org/devfund)** — Q3, freedom-tech
  framing: censorship-resistant identity and community spaces, fully
  self-hostable, built from Latin America.
- **[Geyser](https://geyser.fund) rewards campaign** — timed with the rebrand
  launch: Launchpad 30-day draft first, 21-follower gate cleared via La
  Crypta. Rewards: founding-player NIP-58 badge, a named NPC, a commissioned
  community entity, a year of managed realm. Goal kept modest and beatable:
  **0.5–1 BTC**.
- Optional: a [Sovereign Engineering](https://sovereignengineering.io) cohort
  later.

### VC (optional, much later)

Only worth telling at ~**50+ servers / thousands of weekly npubs / real
marketplace volume**: "federated game network + creator-economy rails."
[ZBD](https://zbd.gg)'s $40M Series C (January 2026) proves investor appetite
for bitcoin-gaming infrastructure — Gorilator owns the **world layer**, not
payments. Until those numbers exist, grants + revenue are a better deal than
dilution.

## Competitive position

- **[THNDR](https://www.thndr.games)** pivoted to iGaming B2B — vacated the
  bitcoin-native consumer-game space.
- **[ZBD](https://zbd.gg)** is proprietary payments infrastructure — a
  potential rail, not a competitor for worlds.
- **Nobody credible occupies "open-source, self-hostable, Nostr-federated
  multiplayer game."** That's the position, and it is defensible because it is
  expensive to fake: the moat is the open network, not the code.
- **The AI Forge sharpens the wedge:** create a creature from a prompt on your
  phone, pay sats, publish to the network ([ai-creation.md](ai-creation.md)) —
  nobody else has this.
- **Adjacent allies, not rivals:** [Nostr Game Engine](https://ngengine.org)
  (shared NIP interests), [Zapstore](https://zapstore.dev) (distribution).
- **Precedents to steal from:** [Luanti](https://content.luanti.org)'s
  ContentDB (a web directory of community content → ours is the entity
  browser + landing profiles), [Veloren](https://veloren.net)'s weekly devlog
  cadence, [Mindustry](https://mindustrygame.github.io)'s zero-friction
  third-party server culture.

## Marketing — the 8-week rebrand launch

| Weeks | Push |
| --- | --- |
| 1–2 | Landing repositioned to the sandbox identity; flagship server hardened (uptime, onboarding, persistence live). |
| 3–4 | **Nostr-first announcement** — kind 30023 long-form post + a 90-second demo video (npub login → play → publish an entity → it appears on another server), in **EN + ES**. |
| 5–6 | **"Founding of the Town"** launch event weekend on the flagship, streamed on [zap.stream](https://zap.stream); Geyser Launchpad draft goes up. |
| 7–8 | **"Run-a-world week"** — operators spin up servers that auto-appear on the [stats dashboard](https://gorilator.io/stats.html); the first 21 operators get founder status. |

**Ongoing, Nostr-native:**

- Devlogs as Nostr long-form (kind 30023) first; mirrored elsewhere later.
- A bot npub that celebrates new servers and realm records straight from the
  discovery feed (kind 30078 events → posts).
- Zappable achievements; quarterly creator contest with sats prizes.
- **Ads: none early** — the target audiences are ad-immune. The only paid
  option worth considering later: sponsoring a Nostr client's release notes or
  a LatAm bitcoin podcast.

## Conferences (pick three)

Format for all: **a live local server people join from the room** — the
five-minute self-host pitch, demonstrated.

1. Riga — Bitcoin Week / Nostr unconference
   ([Baltic Honeybadger](https://baltichoneybadger.com), late August, if the
   2026 edition confirms).
2. [bitcoin++](https://btcplusplus.dev) Berlin, payments edition — October 1–3.
3. [Satsconf](https://satsconf.com.br) São Paulo — ~November (home-region
   anchor).

## Partnerships (ranked)

1. **[La Crypta](https://lacrypta.ar)** — flagship server host + pitch a
   Gorilator challenge into the remaining 2026 hackathon months (**action this
   month**).
2. **[Alby](https://getalby.com) / NWC wallets** — when sats ship (Phase 6).
3. **Nostr client devs** — NIP drafts for game identity/discovery.
4. **Blossom hosts** — mirroring guarantees for community-entity assets.
5. **[Zapstore](https://zapstore.dev) + [Nostr Game Engine](https://ngengine.org)**
   — ecosystem co-marketing.
6. **LatAm Bitcoin educators** — the managed-realms channel (a classroom world
   per cohort).

## Community & governance

- **Channels:** Nostr is the public voice; **Discord** for contributor work
  (La Crypta's hackathon already lives there); skip Telegram.
- **Contributor ladder** (each rung is a real on-ramp that exists today):
  1. **Creators** — in-game Dev Mode, no git ([community-entities.md](community-entities.md));
  2. **JSON content** — manifests + data plugins, no code execution;
  3. **Plugin authors** — code plugins against the versioned API ([plugins.md](plugins.md));
  4. **Core** — `packages/*/src`, PRs with the verification ladder.
- **Governance-lite:** BDFL for the engine and flagship; **NIP-style public
  RFCs** for protocol surfaces (the federation spec is the first —
  [federation.md](federation.md) is explicitly a request for comments).
- **Bus factor**, stated plainly because grant committees read for
  sustainability: everything is MIT, self-hostable, and documented in-repo;
  saves live on public relays under players' keys-of-record; any operator can
  fork the network state. If the maintainer disappears, the worlds keep
  running and the protocol survives — that is the design goal, not an
  accident.

## Metrics & targets

**Lead metric: servers online** — it compounds (each server markets the
network) and it is publicly verifiable on relays by anyone (`{kinds:[30078],
"#t":["gorilator"]}`). Supporting metrics: weekly active npubs, kind-30333
entities published (+ unique authors), external contributors, funding
pipeline.

| Horizon | Servers | Weekly npubs | Milestones |
| --- | --- | --- | --- |
| 3 mo | 10 | 150 | OpenSats + Spiral + Btrust applications out; federation spec published |
| 6 mo | 25 | 400 | 1 grant landed; HRF applied; Geyser closed at/above goal |
| 12 mo | 50+ | 1,500 | 2 grants active; 10 managed realms |
