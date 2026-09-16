# Foolscap — shell spec

One system, one page per tool. This defines the shell everything is built
into: tokens, navigation, layout, and the boundary between pages.

Build this before any new page. Retro-fit `track.html` onto it last.

---

## The six pages

Each answers a question no other page answers. If two pages would answer the same
question, one of them is wrong.

| page | question it answers |
|---|---|
| **City** (`/`) | What is the network doing right now? |
| **Tracker** (`/track`) | What happened to my request? |
| **Bench** (`/bench`) | How do I sign and post a message without handing over my key? |
| **Lens** (`/lens`) | Who actually said what in this room? |
| **Vault** (`/vault`) | What notes exist, who owns them, and when do they expire? |

The shell must not assume this list is final. It has been six and it has been five; PAGES
is the only place the count is written down, and that is what makes changing it cheap.

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

The colophon is fixed copy on every page: reads only, no keys, nothing posted on your
behalf, no backend of any kind, referee DID pinned from LAUNCH.md, source on GitHub,
Apache-2.0.

---

## There is no backend

Every page is a static file calling `technocore.chat` directly — CORS is open, no proxy, no
server, nothing of ours on the request path.

This was once qualified: Notary, a durable archive, was the one part of Foolscap with a
server behind it, and the sentence above read "no backend except Notary's archive". That
service is gone — it failed on storage arithmetic, and the account is in `docs/NOTARY.md`.
The claim is now unconditional, which is a better claim than the one it replaced and is
worth defending: **if a page here needs a server, the page is wrong.**

What that costs is real and has to be said rather than hidden. Foolscap can only report what
the rings still hold, which on a busy room is minutes. It cannot answer a question about last
week. A page that would like to must say so in its own words rather than implying coverage it
does not have.

## Rules that apply to every page

- Never render a status computed from unverified data. Verify signatures first.
- A hole in coverage invalidates conclusions drawn from absence, not conclusions backed by
  evidence in hand. Warn on the former only.
- No private key input anywhere except Bench, and there only behind an explicit opt-in that
  defaults to paste-your-signature.
- No request is built from a template with an unfilled `<placeholder>` still in it. A room
  takes no edits and no deletions; see `placeholders()` in `src/lib/bench.ts`.
- Poll with `limit=200`, detect holes from `first_seq`, recover by re-export. The read
  endpoint skips rather than queues — this is not optional.
- No localStorage or sessionStorage, with two stated exceptions. The second is the theme: one
  key holding one of two words, written only when the reader clicks the switch in the nav, in
  `src/theme.ts`. A theme that forgot itself on every navigation is a theme nobody uses twice.
  `prefers-color-scheme` decides the first visit only; after that the stored choice wins, even
  where it agrees with the system. The first exception is larger: `/vault` keeps the namespaces
  a reader chose to watch, plus the keys present at the last look and when that look happened.
  It has to. The seven-day note decay is invisible — the server publishes no written-at, no
  expires-at and no age — so the only way anyone learns a note has gone is to have looked before
  and remembered, and without somewhere to remember the page can report on the last few minutes,
  which is the one span in which nothing ever expires. It keeps public data that was on screen
  anyway, nothing about the reader, nothing from any other page, and it has a control that empties
  it. All of that lives in `src/vaultStore.ts` and nowhere else.
- React + TypeScript, built with Vite. The build compiles the pages; it never moves the
  signature checking off the reader's machine, and no server sits on the request path.
- `pg` is the only database dependency, worker-side only. Never the Supabase JS client.

## Order of work

1. Tokens, nav partial, page shell, colophon. Nothing else.
2. Retro-fit `track.html` onto it — proves the shell holds a real page.
3. City.
4. Bench, Lens, Vault.

Ship 1 and 2 together. A shell with no page in it is untested.
