# Foolscap — shell spec

One system, six pages, each a distinct tool. This defines the shell everything is built
into: tokens, navigation, layout, and the boundary between pages.

Build this before any new page. Retro-fit `track.html` onto it last.

---

## The six pages

Each answers a question no other page answers. If two pages would answer the same
question, one of them is wrong.

| page | question it answers |
|---|---|
| **City** (`/`) | What is the network doing right now? |
| **Notary** (`/notary`) | When was this DID active, and can I prove it? |
| **Tracker** (`/track`) | What happened to my request? |
| **Bench** (`/bench`) | How do I sign and post a message without handing over my key? |
| **Lens** (`/lens`) | Who actually said what in this room? |
| **Vault** (`/vault`) | What notes exist, who owns them, and when do they expire? |

Holdfast — the territory game — comes later and gets its own page plus a leaderboard. The
shell must not assume six is final.

Shared plumbing lives in `js/`: `did.js`, `technocore.js`, `contest.js`. Pages own their own
view logic and nothing else. If two pages need the same logic, it moves into `js/`, it does
not get copied.

---

## Theme: dark only

Drop the light theme. One register across the whole site — less work, more coherent, and it
suits the city.

The palette is FLOP-adjacent, not FLOP. FLOP Labs uses `#0A1128` base, `#F5F7FA` ice white,
`#00B4D8` cyan. Foolscap reads as kin, never as an official property.

```css
:root {
  /* surfaces */
  --paper:       #0E1420;   /* page */
  --paper-sunk:  #161D2B;   /* insets, cards, table stripes */
  --paper-raised:#1C2434;   /* nav, overlays, anything above the page */

  /* text */
  --ink:         #E6ECF2;
  --ink-mid:     #A4B0BF;
  --ink-faint:   #7D8A9C;

  /* structure */
  --rule:        #262E3D;
  --rule-strong: #3A4353;

  /* state — never decoration */
  --accent:      #3FB3C4;   /* live, held, verified, current */
  --warn:        #D9A441;   /* degrading, expiring, uncertain */
  --alarm:       #E0674F;   /* forged, failed, lost */
}
```

Three state colours, not one — the earlier single-accent rule was right for a one-page tool
and is too thin for six. The rule that survives: **state colours never fill a background,
never make a gradient, never decorate.** They mark a status and nothing else.

Every text pair must clear 4.5:1 on both `--paper` and `--paper-sunk`. Check `--warn` and
`--alarm` when they land; they are new and unverified.

## Type

Six steps. Nothing outside this set.

```css
--t-answer: clamp(2.4rem, 6vw, 3.25rem);  /* the one answer on a page */
--t-h1:     2rem;
--t-h2:     1.25rem;
--t-body:   1.0625rem;
--t-small:  0.875rem;
--t-micro:  0.75rem;   /* labels only: uppercase, letterspaced */
```

Spectral for body, system mono for DIDs, signatures, room names, type strings. Mono is for
payloads a reader might copy or verify, never for labels.

`--t-answer` is used at most once per page. It is the answer the visitor came for — a status
word, a date, a count. If a page has no single answer, it does not use this step.

## Spacing

One unit and its multiples. No ad-hoc values.

```css
--space: 1.05rem;   /* 0.5 / 1 / 2 / 4 */
--measure: 46rem;   /* max line length for prose */
--shell:  72rem;    /* max width for page content */
```

---

## Navigation

Persistent, on every page including the city.

- Fixed top bar, `--paper-raised`, one hairline `--rule` underneath. No shadow.
- Left: "Foolscap" as a wordmark linking to `/`. Not a logo — set in Spectral, `--t-h2`.
- Centre or right: the six page links, `--t-small`, uppercase, letterspaced. Current page
  marked with `--accent` on the text and a 2px underline. Never a filled pill.
- On the city, the bar sits over the canvas with the surface at 85% opacity and a backdrop
  blur. Everywhere else it is opaque.
- Under 768px it collapses to the wordmark plus a menu button; the panel is a full-height
  sheet from `--paper-raised`, links at `--t-h2`.

Nav is one shared partial. Do not hand-write it per page — a link that only exists on four
of six pages is the bug this prevents.

## Page layout

```
[nav]
[page header]   eyebrow (--t-micro) + title (--t-h1) + one line of what this page answers
[content]       max-width --shell, prose blocks capped at --measure
[colophon]      the trust statement, same on every page
```

The city is the exception: full-bleed canvas, the header floating over it, content in a
panel rather than a column.

The colophon is fixed copy on every page: reads only, no keys, no backend except Notary's
archive, referee DID pinned from LAUNCH.md, source on GitHub, Apache-2.0.

---

## Where the backend enters

Only Notary has one. Everything else is a static page calling `technocore.chat` directly —
CORS is open, no proxy, no server.

Notary's page reads **both**:

- **Live** — the browser reads the rooms directly, same as every other page. Covers the last
  few hours, which is all the rings hold.
- **Archive** — the Notary API, for anything older than the rings.

The page must label which answer came from where, and say plainly that the archive covers
only what Notary captured. Absence is never evidence a DID was inactive.

This is the honest version of the product and it is also the resilient one: with the mirror
stopped, the page still works for recent activity.

## Rules that apply to every page

- Never render a status computed from unverified data. Verify signatures first.
- A hole in coverage invalidates conclusions drawn from absence, not conclusions backed by
  evidence in hand. Warn on the former only.
- No private key input anywhere except Bench, and there only behind an explicit opt-in that
  defaults to paste-your-signature.
- Poll with `limit=200`, detect holes from `first_seq`, recover by re-export. The read
  endpoint skips rather than queues — this is not optional.
- No localStorage or sessionStorage.
- No build step for the static pages. One dependency total (`pg`, worker-side only).

## Order of work

1. Tokens, nav partial, page shell, colophon. Nothing else.
2. Retro-fit `track.html` onto it — proves the shell holds a real page.
3. City.
4. Notary, Bench, Lens, Vault.

Ship 1 and 2 together. A shell with no page in it is untested.
