# Foolscap — design system

The pages work and look unfinished. This file says why, and fixes it once so every page
stops drifting.

Read it before touching any page. It supersedes the design sections of SHELL.md.

---

## The diagnosis

Six pages were each built from a written description. No shared surface system, no shared
layout patterns, no designed empty or sparse states. The result is six columns of text on
black with hairlines between them — correct, legible, and clearly nobody's design.

Three specific failures, all fixable:

**No surfaces.** Everything sits directly on the page ground. A hairline is the only device
separating one region from another, so nothing feels grouped, contained, or deliberate.
There is no visual answer to "where does this thing end".

**No layout patterns.** Every page invented its own arrangement, and most landed on a
single left column with 50% of the viewport empty beside it. A tool page and a reading page
and a form page should not all be one column.

**Only the populated state was designed.** Empty, loading, sparse, overflowing and failed
states were improvised at build time, which is why the loading text was a whisper and the
empty lobby was a sentence.

---

## Surfaces

Four levels, and nothing else. Every region on every page sits on exactly one of them.

```css
--s0: transparent;                    /* page ground */
--s1: rgba(255,255,255,0.025);        /* panel — the default container */
--s2: rgba(255,255,255,0.05);         /* raised: headers, sticky bars, selected rows */
--s3: #14181F;                        /* opaque: menus, popovers, anything over content */
```

`--s3` is opaque and always opaque. A translucent surface floating over content is how the
listbox became unreadable, and it is how every such bug starts.

Borders are `1px solid rgba(255,255,255,0.09)`, never darker, never doubled. Radius is 12px
on panels, 8px on inner elements, 999px on pills. Nothing has a shadow: on near-black, a
shadow reads as smudge. Elevation is carried by surface value and border alone.

Panel interior padding is 20px at desktop, 16px at 375. Never less — cramped padding is the
single most reliable tell of an unfinished interface.

## The panel

One component, used everywhere. Not a div with a border repeated eleven times.

```
┌─────────────────────────────────────────┐  --s1, 1px border, 12px radius
│ TITLE                      [ action ]   │  header on --s2, 44px, bottom border
├─────────────────────────────────────────┤
│                                         │  body, 20px padding
│  content                                │
│                                         │
└─────────────────────────────────────────┘
```

The header is optional, the border is not. Variants: `--flush` (no body padding, for tables
and lists that draw their own), `--scroll` (capped height, internal scroll, sticky header).

Build `components/Panel.tsx` first and use it on all six pages. If a page needs a container
the panel can't express, change the panel.

## Layout patterns

Three, and every page picks one. This is the part that was missing entirely.

**A — Split** (`/lens`, `/vault`). A list beside a detail pane. Left column 320px fixed,
right fills, 20px gutter, both full height with independent scroll. The list has its own
search header. This is the correct shape for "pick one of many, look at it closely" and
both pages currently render it as two stacked columns of text.

**B — Console** (`/bench`, `/track`). A form or query at the top, results below, both in
panels, content capped at 62rem and centred rather than pinned left. The 45%-column-with-
empty-space problem is this pattern not being used.

**C — Document** (`/`, `/notary`). Full-width bands alternating between measure-width prose
and full-width data. This is the only pattern currently in use, and it's right for these two
pages and wrong for the other four.

## The Q&A block

Every page gets one, at the bottom, above the footer. The client is right that the tools
are unexplained — a page that says what it does but never what it means leaves the reader
to guess.

Panel, `--flush`, titled with the page's own question. Inside, 4–6 disclosure rows:

```
┌ QUESTIONS ──────────────────────────────┐
│ What does "verified" actually mean?   + │  44px row, 1px divider, chevron rotates
│ Why can't you tell me when it expires?+ │
│ Is my key ever sent anywhere?         + │
└─────────────────────────────────────────┘
```

Closed by default. Native `<details>`/`<summary>` so it works without JS and is accessible
for free. Answers are two or three sentences of plain prose at `--measure`, never bullets.

Write the questions a sceptical user actually asks, not marketing FAQ. Each page's set must
include at least one question the answer to which is a limitation.

## States — design all of them, every time

This is the checklist that was missing. Every list, pane and query on every page needs all
six specified before it is built:

| state | requirement |
|---|---|
| loading | visible at a glance — `--t-h2`, centred, with the sweeping rule already built |
| empty | says why it's empty and what to do about it, in one sentence plus an action |
| sparse | one or two items must not look broken — no stretched rows, no lonely card |
| populated | the normal case |
| overflowing | capped, with the cap stated and a way to see more |
| failed | what failed, whether to retry, in `--alarm`, never a blank pane |

A page reported as done with an undesigned empty state is not done.

## Density

Rows are 40px minimum, 44px where tappable. Table cells get 12px vertical padding. Row
dividers are `rgba(255,255,255,0.06)`, not the panel border colour — internal structure is
quieter than the container's edge.

Alternating row stripes only in tables over 8 rows. Below that they read as noise.

---

# Per-page work

## Fix first — `/bench` listbox closes on scroll

My spec said "close on outside click and on scroll", which is wrong for a list you scroll
inside. Close on outside click and on Escape only. Scrolling the page while open should
reposition the panel, not dismiss it. This currently makes the control unusable.

## `/lens` — rebuild on pattern A

Currently a column of text. It should be the split:

- **Left, 320px:** room list. Search at the top in the panel header. Each row: room name in
  mono, retained size, and a live dot where the room is active. Selected row on `--s2` with
  a 2px `--accent` left edge. This list is the page's primary navigation and currently
  isn't treated as navigation at all.
- **Right, fills:** the room. Panel header carries the room name, the verified count, the
  seq range and the filter control. Body is the message list, `--flush`, scrolling.
- **Message row:** 2px state rule on the left edge (existing behaviour, keep it), then DID
  in mono truncated, timestamp right-aligned, text below. 12px vertical padding, divider
  between. Failed rows expand to show the full DID, nonce and signature.
- **Empty:** no room selected is the first thing a visitor sees. Make it a real state —
  the question the page answers, and three suggested rooms to open.

## `/vault` — rebuild on pattern A

Same split. Keys list left, note detail right. The note pane gets the raw line and the
parsed reading as two panels stacked, not two headings in one column. The watch state
belongs in the list panel's header, not below the fold.

## `/track` and `/bench` — move to pattern B

Stop pinning content to a 45% left column. Centre at 62rem. The lookup or form goes in a
panel at the top; results go in panels below it.

## `/notary` and `/` — keep pattern C

These two are right. Wrap their existing bands in panels where they contain data — the
coverage ledger, the anchor log, the holes table — and leave the prose bands unwrapped.

## `/city` — after the above

The client wants this one worked on separately once the six are consistent. Leave it.

---

# Build process

Same as before, plus one addition that matters more than the rest.

**Build `Panel.tsx` and the Q&A block first.** Two components, used everywhere. Do not
start on a page until both exist and are used on at least one.

**One page at a time, committed separately.** Six pages in one commit is how a regression
hides.

**Before each commit, render and look:** the page at 1440 and at 375, and every one of the
six states in the table above for every list and pane on it. Fix what is wrong. A state you
did not look at is not done.

**Then critique:** one element on the page should be memorable, everything else quiet. Cut
one thing before committing.
