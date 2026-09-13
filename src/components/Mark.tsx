// Mark.tsx — the Foolscap mark, and the lockup it sits in.
//
// A ring with a gap, and one solid dot held in the gap.
//
// The ring is a room rotating its history away: it comes round almost whole,
// then loses definition and breaks into three fading dashes before the gap,
// which is the part already gone. The dot is the one record kept — full
// opacity, filled, the only closed shape in the drawing, sitting exactly where
// the ring is missing.
//
// GEOMETRY, so nobody has to reverse-engineer the path data. Angles below are
// measured CLOCKWISE from twelve o'clock, which in SVG's y-down space puts a
// point at (cx + r·sin θ, cy − r·cos θ):
//
//   60°           the arc starts, at two o'clock
//   60° → 300.5°  solid, sweeping clockwise the long way round
//   300.5° → 358° the dissolve: three dashes at .6, .4 and .25 opacity
//   358° → 60°    the gap, through twelve o'clock
//   30°           the dot, at the midpoint of the missing arc
//
// THE SPACING IS SET AGAINST THE CAPS, not chosen for the numbers, and it is the
// reason the dissolve is ~57° rather than the ~40° it was drawn at first. A round
// cap extends half a stroke — 0.75 units here — past each endpoint, so two marks
// need about 10° between them before any black appears at all, and four
// separations (one after the solid arc, three between the dashes) cost 40° on
// their own. At 40° total the dashes merged into one smear with a gradient
// across it; at 40° with real gaps they come out three near-identical dots, and
// the brief asks for decreasing length. 13.5° between marks puts 0.62 units of
// black in each gap — 41% of the stroke — and leaves the dashes at 9°, 5.5° and
// 2.5°, which draw as 2.91, 2.36 and 1.89 units: visibly shortening, visibly
// separate.
//
// The gap after the SOLID arc matters as much as the ones between the dashes.
// Without it the first dash shares an endpoint with the ring and its cap is
// swallowed, so the ring appears to fade rather than to break.
//
// Strokes are currentColor, so the mark takes the colour of whatever text it is
// set beside and needs no variant per surface.

export interface MarkProps {
  /** Rendered size in px. The viewBox is fixed; this scales it. */
  size?: number;
  className?: string;
  /**
   * Only where the mark stands alone. Beside the wordmark it is decorative —
   * the word is already the name, and a title would have a screen reader say it
   * twice.
   */
  title?: string;
}

export function Mark({ size = 24, className, title }: MarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}

      {/* Two o'clock, clockwise the long way round to ten o'clock. */}
      <path d="M19.794 7.5A9 9 0 1 1 4.245 7.432" />

      {/* The dissolve. Shorter and fainter the closer it gets to the gap. */}
      <path d="M5.526 5.748A9 9 0 0 1 6.584 4.812" opacity="0.6" />
      <path d="M8.411 3.746A9 9 0 0 1 9.219 3.44" opacity="0.4" />
      <path d="M11.294 3.028A9 9 0 0 1 11.686 3.005" opacity="0.25" />

      {/* What was kept. */}
      <circle cx="16.5" cy="4.206" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Mark plus wordmark, as one piece.
 *
 * The nav and the footer both show it and neither draws it: a lockup assembled
 * twice is a lockup that drifts, and the gap between the mark and the word is
 * the whole of the relationship between them.
 *
 * It renders no link of its own — the nav wraps it in one to `/`, the footer
 * does not — so it can sit wherever the name belongs without deciding what
 * clicking the name should do.
 */
export function Lockup({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span className={className ? `lockup ${className}` : 'lockup'}>
      <Mark size={size} className="lockup__mark" />
      <span className="lockup__word">Foolscap</span>
    </span>
  );
}
