// ToolMark.tsx — one mark per tool, for the landing's cards.
//
// DESIGN.md's amendment: "Landing tool card: the tool's own mark, drawn once
// per tool." And, two lines above it: "Never a stock icon. Every visual on this
// site is derived from its own data."
//
// A tool has no bytes to derive a mark from the way a key does, so these are
// drawn — but each one draws the thing its page actually does, in the same
// vocabulary the rest of the site uses for data: bars, marks, rules and one
// closed shape. Not a magnifying glass for Lens and not a padlock for Vault.
// Those are pictures of the category; these are pictures of the mechanism.
//
//   city     rooms drawn to scale, which is the City's whole method
//   track    a queue, with the one you asked about marked
//   bench    room | nonce | text — the canonical string, as three segments
//   lens     a column of verdict rules with one that did not hold
//   vault    a field of keys with two of them gone
//
// currentColor throughout, so a mark takes the colour of whatever it sits in
// and needs no variant per surface. Square viewBox, 48 units, drawn to sit
// inside a card's 88px visual block at about 56px.

const BOX = 48;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="tmark"
      width="56"
      height="56"
      viewBox={`0 0 ${BOX} ${BOX}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Rooms drawn to scale. Four heights, because the City's point is the range. */
const City = () => (
  <Frame>
    <rect x="4" y="30" width="8" height="14" fill="currentColor" stroke="none" opacity="0.45" />
    <rect x="16" y="14" width="8" height="30" fill="currentColor" stroke="none" />
    <rect x="28" y="24" width="8" height="20" fill="currentColor" stroke="none" opacity="0.7" />
    <rect x="40" y="36" width="4" height="8" fill="currentColor" stroke="none" opacity="0.3" />
  </Frame>
);

/** A queue, and the one you asked about. */
const Track = () => (
  <Frame>
    {[8, 16, 24, 32, 40].map((y, i) => (
      <rect
        key={y}
        x={i === 2 ? 4 : 10}
        y={y - 2}
        width={i === 2 ? 34 : 22}
        height="4"
        fill="currentColor"
        stroke="none"
        opacity={i === 2 ? 1 : 0.4}
      />
    ))}
  </Frame>
);

/** room | nonce | text. The two pipes are the mark. */
const Bench = () => (
  <Frame>
    <rect x="4" y="20" width="10" height="8" fill="currentColor" stroke="none" opacity="0.55" />
    <path d="M19 14v20" />
    <rect x="24" y="20" width="6" height="8" fill="currentColor" stroke="none" opacity="0.55" />
    <path d="M35 14v20" />
    <rect x="40" y="20" width="4" height="8" fill="currentColor" stroke="none" opacity="0.55" />
  </Frame>
);

/**
 * A column of verdict rules with one that did not hold.
 *
 * The odd one out is shorter rather than coloured: this mark sits in a card, and
 * --alarm on a landing page would be a state colour spent on decoration.
 */
const Lens = () => (
  <Frame>
    {[8, 17, 26, 35].map((y, i) => (
      <g key={y}>
        <rect x="6" y={y} width="3" height="6" fill="currentColor" stroke="none" opacity={i === 2 ? 0.35 : 1} />
        <rect
          x="14"
          y={y + 1}
          width={i === 2 ? 12 : 28}
          height="4"
          fill="currentColor"
          stroke="none"
          opacity={i === 2 ? 0.35 : 0.6}
        />
      </g>
    ))}
  </Frame>
);

/** A field of keys, two of them gone. */
const Vault = () => (
  <Frame>
    {Array.from({ length: 16 }, (_, i) => {
      const gone = i === 5 || i === 10;
      return (
        <rect
          key={i}
          x={5 + (i % 4) * 11}
          y={5 + Math.floor(i / 4) * 11}
          width="8"
          height="8"
          fill={gone ? 'none' : 'currentColor'}
          stroke={gone ? 'currentColor' : 'none'}
          strokeWidth={1}
          opacity={gone ? 0.35 : 0.85}
        />
      );
    })}
  </Frame>
);

const MARKS: Record<string, () => React.ReactElement> = {
  city: City,
  track: Track,
  bench: Bench,
  lens: Lens,
  vault: Vault,
};

/**
 * The mark for a page id, or nothing.
 *
 * Nothing rather than a fallback glyph: a tool with no mark of its own would
 * get somebody else's, and the whole point is that each one draws its own
 * mechanism. A new tool without a mark is a gap that shows.
 */
export function ToolMark({ id }: { id: string }) {
  const Mark = MARKS[id];
  return Mark ? <Mark /> : null;
}
