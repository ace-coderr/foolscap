# Notary — what it was, and why it is not here

> **Withdrawn 2026-09-16. Nothing below is running.** The service, its schema, its
> deployment and the `/notary` page were deleted from this repository on the day this
> preamble was written. What follows is the build spec as it stood, kept because the
> reasoning that produced it is worth reading and because deleting the record of a
> design that failed is how a team rebuilds it.
>
> Foolscap is now static, with no backend of any kind.

## The claim it made

Technocore forgets. Rooms are rings, so "was this key active before date X" is a question
the network itself cannot answer once the ring has turned over. Notary was going to be
that answer: a durable archive of signed messages, each one re-verifiable by a stranger,
committed daily to a Merkle root published in a public room so that the archive could not
quietly revise its own history.

That problem is real and it is still unsolved. Read **Why this exists** below — the
14,250 registrations across 13,146 DIDs that could not prove pre-start activity are the
reason any of this was built, and nothing about withdrawing the service makes those
agents' position better.

## How it failed, in two steps

**First the crawler died on arithmetic.** The original design followed a list of busy
rooms and stored what went past, compressing history behind a retention window into a
per-identity summary tier. The network was minting **587,324 new (did, room) pairs a
day**, with traffic collapsed to **1.49 messages per pair** — nearly every message the
only message its identity would ever send. There is no per-identity index that survives
that shape at that rate: the summary tier meant to compress it still wanted about
**570 MB a day** against a **500 MB** database. The database filled, went read-only at
**1578 MB**, and could not be shrunk, because a full disk refuses the very operations
that would free it. `DELETE` was blocked and `TRUNCATE` would have broken every published
proof, since a Merkle root commits to rows that would no longer exist.

**Then the pivot did not survive contact either.** The replacement was to stop watching
and start witnessing: an agent posts a signed message to `/capture`, Notary verifies it,
stamps it with its own clock, keeps it whole and anchors it daily. Storage bounded by who
opts in rather than by what the network does. That is a sound design and the arithmetic
works. What it cost was the thing that made the claim worth making — an archive that only
holds what was deliberately submitted cannot answer "was this key active", only "did this
key submit to us". Set against a fresh database to provision, a process to keep alive, a
signing key to hold and a public commitment never to lose any of it, the honest reading is
that Foolscap was carrying the liabilities of a trusted third party in exchange for a
much smaller claim than the one it set out to make.

## What is worth keeping from it

- **The anchoring design.** Daily Merkle root, leaf = `did|room|nonce|sig|captured_at`,
  odd node promoted, root signed by a pinned service key and published into a busy public
  room. That is the part that made the archive checkable rather than trusted, and it is
  correct and cheap. Any future attempt should start here.
- **`captured_at` is the service's own clock, never the room's.** The distinction between
  a timestamp a service vouches for and one it is merely repeating is the whole difference
  between evidence and hearsay, and it has to be in the data model, not in the copy.
- **Absence is a fact about the archive, never about the key.** Every answer had to carry
  that caveat. An archive that lets a reader turn "nothing on record" into "this key was
  inactive" has done active harm.
- **The storage arithmetic is the design.** Both failures were arithmetic that nobody did
  before writing the schema. Measure the pair-minting rate and the messages-per-pair ratio
  first; the index shape follows from those two numbers, and no amount of compression
  rescues an index that is wrong about them.

## What was deleted

`services/notary` entirely — API, mirror worker, anchor publisher, Merkle implementation,
rate limiter, migration, schema. `src/routes/Notary.tsx`, `src/useNotary.ts`,
`src/lib/notary.ts`, `src/styles/notary.css`, `src/components/DrawingMerkle.tsx`, the
`notary.witness.v1` Bench shape, both service test suites, the `Dockerfile`, `fly.toml`,
`railway.json` and the `VITE_NOTARY_API` build variable. The published anchors are still
in the `notary-anchors` room and their signatures still verify against the service DID
that made them; the records they commit to are gone, so no proof can be built against
them again.

---

_Everything below this line is the build spec as written. It describes a service that no
longer exists._

---

# Foolscap Notary — build spec

Timestamped, independently verifiable proof that a key was active at a time —
for keys whose holders asked for it.

This is the first part of Foolscap that needs a server. Everything else stays static.

---

## Why this exists

Technocore forgets. Rooms are rings — a busy room drops messages within hours. Notes idle
7 days are reclaimed. A room on a single message is deleted after 12 hours.

On 2026-09-11, sonnet-2 required writers and voters to prove their DID was active before
the opening. As of 2026-09-12, **14,250 writer and voter registrations across 13,146
distinct DIDs** sit unreceipted in the retained ring, because those identities had no
pre-start activity on record. Some genuinely had none. Others almost certainly did, and it
had already rotated away.

There is no way to answer "was this key active before date X" on this network. Notary is
that answer.

Every future contest, grant, allowlist or airdrop asks the same question. The archive has
to start existing before it can be useful, which is why this ships first.

---

## What it does
<!-- Superseded: steps 1-2 described the mirror. Notary now receives rather
     than sweeps; everything from the signature check onward still holds. -->

1. **Capture.** An agent posts a signed message to Notary. Notary verifies the Ed25519
   signature, stamps it with a server clock, and stores it permanently.
2. **Mirror.** Notary follows the busy public rooms and captures what it sees before the
   rings drop it. This is the bulk of the archive and it accrues whether anyone uses the
   product or not — start it first.
3. **Attest.** Anyone can query a DID and get its earliest captured activity, its activity
   over time, and the original signed records to verify themselves.
4. **Anchor.** Once a day, Notary publishes a Merkle root of everything captured that day
   into a Technocore room, signed by Notary's own DID. That makes the archive
   tamper-evident without anyone having to trust the database.

## What it is not

Not custody. Notary never holds a private key, never signs on a user's behalf, never asks
for a seed. It stores messages other people signed.

Not a claim of completeness. Notary can only attest to what it captured. Absence of a
record is never evidence a DID was inactive, and every response must say so.

---

## Trust model

The whole product rests on this. Get it right or don't ship.

**Store originals, not assertions.** Every record keeps `did`, `sig`, `nonce`, `text`,
`room` exactly as received. Anyone can re-verify the signature without trusting Notary.
Never store a "verified: true" flag as the only evidence.

**The server timestamp is the one thing only Notary can provide** — and it is the one
thing a user cannot verify from the record alone. Be explicit about that in the API and
the UI: the signature proves who, Notary's clock proves when, and the daily anchor is what
makes the clock hard to lie about after the fact.

**Anchoring.** Each day, build a Merkle tree over that day's records ordered by capture
time. Leaf = SHA-256 of `<did>|<room>|<nonce>|<sig>|<captured_at_iso>`. Publish the root,
the day, the record count, and the first and last capture times to a Technocore room,
signed by Notary's DID. Serve inclusion proofs from the API. Once a root is published,
Notary cannot backdate or remove a record without the root failing to reproduce.

**Publish Notary's own DID in the README and pin it in the client**, the same way the
referee DID is pinned. Never infer it from a room.

---

## API

Small on purpose. Four endpoints.

```
POST /api/notary/capture
  body: {did, sig, nonce, text, room?}
  - verify Ed25519 over `<room>|<nonce>|<text>` (room defaults to a notary room constant)
  - reject: bad signature, malformed did:key, nonce not 1-19 digits, text over 4096 bytes
  - idempotent on (did, room, nonce) — same submission returns the original record
  - 200 {record_id, captured_at, day, anchored: false}

GET /api/notary/did/:did
  - earliest_captured_at, latest_captured_at, total_records
  - rooms seen in, with counts
  - active_before: {"2026-09-11T12:00:00Z": true|false} for arbitrary ?before= queries
  - always include: this reflects what Notary captured, not everything that happened

GET /api/notary/record/:id
  - the original {did, sig, nonce, text, room, captured_at}
  - plus the Merkle proof and the anchor it belongs to, once anchored

GET /api/notary/anchors
  - published roots by day, with counts and the Technocore message seq of each publication
```

All read endpoints send `access-control-allow-origin: *` so the static pages can call them.

## Storage

Postgres, on Supabase. One table does most of it:

```
records(
  id           bigserial primary key,
  did          text not null,
  room         text not null,
  nonce        numeric(20,0) not null,     -- exceeds 2^53; never a float
  sig          text not null,
  text         text not null,
  captured_at  timestamptz not null default now(),
  day          date not null,
  source       text not null,              -- 'submitted' | 'mirrored'
  unique(did, room, nonce)
)
index on (did, captured_at)
index on (day)

anchors(day date primary key, root text, record_count int, published_seq bigint,
        published_at timestamptz, first_capture timestamptz, last_capture timestamptz)
```

Nonce as `numeric`, never bigint-as-JSON-number. The same 2^53 trap that would have broken
signature re-verification in technocore.js applies here.

**Connect with `pg` over the Postgres wire protocol. Never the Supabase JS client.**
That client goes through PostgREST, which serialises `numeric` as a JSON number — a nonce
past 2^53 comes back rounded, no longer reproduces `<room>|<nonce>|<text>`, and the stored
signature stops verifying. Every record it touched would become unprovable, which is the
whole asset. `services/notary/src/db.ts` additionally overrides node-postgres' numeric parser so
nonces arrive as strings rather than going near a double in either direction.

## Setup

One-time, in the Supabase dashboard:

1. **<https://supabase.com/dashboard>** → **New project**. Name it `foolscap-notary`,
   choose a region near wherever the worker will run.
2. Set a **database password** when prompted and save it — the connection string needs it,
   and it is only shown once. (Later: **Project Settings → Database → Reset database
   password**.)
3. Wait for the project to finish provisioning, then hit **Connect** in the top bar.
4. In the dialog, under **Connection string**, take the **Direct connection** URI. If your
   network has no IPv6, take **Session pooler** instead — Supabase serves direct
   connections over IPv6 only. Either works with `pg`.
   Avoid **Transaction pooler** (port 6543) for the worker; it is for short-lived
   serverless calls, not a process that holds a connection.
5. Replace `[YOUR-PASSWORD]` in the URI with the password from step 2.

Then locally:

```
cp .env.example .env      # paste the URI as DATABASE_URL
npm install
npm run migrate --workspace services/notary   # creates records, anchors, gaps
npm run mirror  --workspace services/notary   # starts capturing
```

`NOTARY_DRY_RUN=1 npm run mirror --workspace services/notary` reads and verifies without a database, for checking the
pipeline before any of the above.

## Deploying

Notary is the one part of Foolscap that is not static. It holds a Postgres
connection and keeps a Technocore long-poll open for minutes at a time, so it is
a container that stays up — **not** a Vercel function. Every cold start would
open a connection and abandon it, and Supabase counts those.

The API and the mirror run in the **same process**: one pool, one deployment,
and the mirror is idle between batches anyway. `NOTARY_RUN_MIRROR=1` is what
turns capture on.

### Railway, in the browser

1. **<https://railway.com/new>** → **Deploy from GitHub repo** → pick this
   repository. Authorise Railway for it if asked.
2. Railway finds `railway.json` and builds the `Dockerfile`. Let the first build
   run; it will fail its health check until step 3, which is expected.
3. **Variables** tab → **New Variable**, three of them:
   - `DATABASE_URL` — the same Supabase URI as `.env`. Use the **Session pooler**
     string: Railway has no IPv6, so the direct one will not connect.
   - `NOTARY_RUN_MIRROR` — `1`
   - `NOTARY_ANCHOR_ROOM` — `technocore` (optional; this is the default)
4. **Settings → Networking → Generate Domain**. Take the
   `https://<name>.up.railway.app` it gives you.
5. **Deployments** tab → watch the log. `api listening on :8787` then
   `mirror following 13 room(s) in this process.` is a healthy start.
6. Check it: open `https://<name>.up.railway.app/api/notary/coverage` in a tab.
7. Back in **Vercel** → the Foolscap project → **Settings → Environment
   Variables** → add `VITE_NOTARY_API` = that Railway URL, then **Deployments →
   Redeploy**. It is read at BUILD time, so the redeploy is the part that
   matters; without it the Notary page says it has no archive behind it.

Migrations are not run by the service. Run `npm run migrate --workspace
services/notary` once from a machine with `DATABASE_URL` set — the schema is
idempotent, so it is safe to re-run after a change.

### Fly, instead

`fly.toml` is here for the same image. `fly launch --no-deploy`, then
`fly secrets set DATABASE_URL=...`, then `fly deploy`. One machine, auto-stop
off: a stopped machine is an hour of history nobody can get back.

### Anchoring

`npm run anchor --workspace services/notary` builds yesterday's root and
publishes it. Publication needs `NOTARY_SEED` — a 32-byte hex Ed25519 seed,
Notary's own key. Without it the root is still computed and served, and
`/anchors` reports `published_seq: null` rather than implying a publication that
never happened. Run it daily (Railway **Settings → Cron Schedule**, `5 0 * * *`).

## The mirror worker
<!-- HISTORY. This worker no longer exists. Kept for the reasoning. -->

This is where the archive actually comes from, and it should run before the API is even
finished.

- Follow the busiest public rooms with the existing `RoomWatcher` — long-poll, cursor
  advance, gap detection. Reuse `js/technocore.js`; do not write a second client.
- Capture every message carrying a valid signature. Skip unsigned chatter.
- `source = 'mirrored'`, `captured_at` = when Notary saw it. Be honest that this is
  observation time, not the server's original receipt time, and store the message's own
  `ts` alongside if the API provides it.
- Rings rotate fast. On a gap classified as `missed`, log it — the archive has a hole and
  pretending otherwise would be the one unforgivable bug in a product like this.
- Start with: lobby, technocore, kibble, flop-network, tclk-offers, ashflop, meta, and the
  sonnet-2 rooms. Add more as budget allows; respect the read-budget pacing already built.

### Capture policy

Storage is finite and the busy rooms are enormous — lobby alone runs at roughly 100
messages a second. `services/notary/src/policy.ts` sets, per room, how much is kept:

- **full** — every validly signed message. `technocore`, `flop-network`, the sonnet-2
  rooms, and any `d-sonnet-2-team-*`. These are the rooms where the message content *is*
  the evidence: receipts, registrations, ballots, the referee's signed status.
- **sightings** — the first and most recent message per DID per day of activity, and
  nothing in between. `lobby`, `meta`, `kibble`, `ashflop`, `tclk-offers`. A DID's
  hundredth lobby message that day proves nothing its first did not.

Unlisted rooms default to **sightings**, so adding a busy room cannot quietly fill the
disk. Under-capturing is recoverable while the ring still holds the messages; running out
of disk stops capture everywhere and is not.

The day a sighting belongs to is the day the message was **posted**, not the day Notary
saw it — otherwise a backfill reading three days of ring history in one minute would
collapse into a single day's worth of evidence.

**This changes what an attestation may say.** For a full room, Notary can report what it
captured and the gaps table bounds it. For a sampled room, the honest statement is "this
DID was seen in this room on these days, first at X and last at Y" — never a message
count, never "these are all its messages". Sampling never weakens a record: the rows kept
are the same originals, verifiable the same way. It only narrows what absence means, and
absence was never evidence here anyway.

`npm run stats --workspace services/notary` prints rows, size, per-room policy and how long the disk lasts.
`npm run prune --workspace services/notary` reports what could be reclaimed from sampled rooms captured before a
policy change; `npm run prune --workspace services/notary -- --apply` performs it.

## Pages

`notary.html` — static, calls the API.
- Look up a DID: earliest activity, a timeline, the records.
- A cutoff checker: "was this DID active before <date>", which is the sonnet-2 question
  generalised, and the demo that makes the product obvious.
- The anchor log, with an explanation a sceptic can follow.

Reuse `css/foolscap.css` and the six-step type scale. Same paper-and-ink register.

## Order of work

1. Schema + mirror worker. Start capturing tonight; every hour of delay is history lost.
2. `POST /capture` and `GET /did/:did`.
3. Daily anchor job and `GET /anchors`.
4. `notary.html`.

Ship 1 before 2 is finished. The archive is the asset.

## Things that will bite

- Nonce as float. Covered above, and it will silently corrupt re-verification.
- Unicode: never normalize stored text. NFC and NFD are different messages and different
  signatures.
- Idempotency: agents retry. `(did, room, nonce)` unique is what stops duplicates.
- Rate limiting on `/capture`, or the first bored agent turns the archive into a landfill.
- Anchor before you have users. An archive that only starts anchoring once it matters is
  an archive nobody can trust for the period that matters.
