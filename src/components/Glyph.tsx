// Glyph.tsx — the DID, drawn.
//
// DESIGN.md's amendment: "a reader scanning a room learns to recognise a
// participant by shape before they read a single character of base58 — which is
// the actual problem with a column of z6Mk... truncations."
//
// The derivation is in lib/glyph.ts and is pinned by test/glyph.test.ts. This
// file is only the drawing.
//
// MONOCHROME, ALWAYS. --ink on --s2, at one of four weights. A glyph is
// identity and identity is not state, so it never takes the accent, the warn or
// the alarm — those three colours mean something on this site and a mark that
// borrowed one would be claiming it.
//
// RUNS, NOT CELLS. Adjacent set cells in a row are drawn as one rect rather
// than as two touching ones: at 20px a cell is under three device pixels, and
// two abutting rects at that scale show a hairline seam down the join. Fewer
// nodes is a side benefit; the seam is the reason.
//
// DECORATIVE BY DEFAULT. Nearly every glyph on this site sits immediately
// beside the DID it was derived from, so announcing it would have a screen
// reader read the same identity twice, the second time as "image". Pass `title`
// only where the mark stands alone.

import { GLYPH_SIZE, GLYPH_WEIGHTS, glyphFor } from '../lib/glyph.ts';

/** One cell of padding all round, so the mark never touches its own edge. */
const PAD = 1;
const BOX = GLYPH_SIZE + PAD * 2;

export interface GlyphProps {
  /** A did:key. Anything else draws the empty ground, which is the honest answer. */
  did: string | null | undefined;
  /** 20 in rows, 32 in cards, 56 on a detail pane. */
  size?: number;
  className?: string;
  /** Only where the mark stands alone. See the note above. */
  title?: string;
}

/** Consecutive set cells in a row, as [start, length] pairs. */
function runs(cells: boolean[], row: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let col = 0; col <= GLYPH_SIZE; col++) {
    const set = col < GLYPH_SIZE && cells[row * GLYPH_SIZE + col];
    if (set && start < 0) start = col;
    if (!set && start >= 0) {
      out.push([start, col - start]);
      start = -1;
    }
  }
  return out;
}

export function Glyph({ did, size = 20, className, title }: GlyphProps) {
  const glyph = glyphFor(did);
  const classes = className ? `glyph ${className}` : 'glyph';

  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox={`0 0 ${BOX} ${BOX}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      shapeRendering="crispEdges"
    >
      {title ? <title>{title}</title> : null}

      {/* The ground, always drawn — an unreadable `from` gets an empty square
          rather than a gap, so a row with no key still lines up with the rows
          that have one. */}
      <rect
        className="glyph__ground"
        x="0"
        y="0"
        width={BOX}
        height={BOX}
        rx={BOX * 0.18}
      />

      {glyph && (
        <g className="glyph__cells" opacity={GLYPH_WEIGHTS[glyph.weight]}>
          {Array.from({ length: GLYPH_SIZE }, (_, row) =>
            runs(glyph.cells, row).map(([start, length]) => (
              <rect
                key={`${row}-${start}`}
                x={PAD + start}
                y={PAD + row}
                width={length}
                height={1}
              />
            ))
          )}
        </g>
      )}
    </svg>
  );
}
