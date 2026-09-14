// DrawingAgent.tsx — a robot head, drawn and unmade on a loop.
//
// Twelve strokes: a rounded head, a faceplate inset evenly inside it,
// headphones over the top with an earcup each side, an antenna, two eyes and a
// mouth. It draws in the order it would be built, holds, and is swept away in
// the same order.
//
// Line art rather than a schematic. Everything is a rounded rectangle, a circle,
// or one arc — no construction lines, no detail for its own sake. The whole
// figure is a dozen shapes a child would recognise.
//
// The pen, the dasharray sweep and the loop all live in drawing.ts now, shared
// with /notary's Merkle tree. What is left here is this figure's geometry and
// its ink, which is the part that is actually about a robot.

import { useEffect, useRef } from 'react';
import { box, q, runDrawLoop, stroke, type Stroke } from './drawing';

const VIEW_W = 300;
const VIEW_H = 400; // 3:4

const DRAW_MS = 12_000;
const HOLD_MS = 2_000;
const ERASE_MS = 6_000;

/** Wet while the pen is moving, dry once the stroke is down. */
const INK_WET = 'rgba(255, 255, 255, 0.55)';
const INK_DRY = 'rgba(255, 255, 255, 0.30)';
/**
 * The sensor, and the only colour in the figure.
 *
 * The accent is state-only everywhere else on this site. It is state here too:
 * of forty-odd strokes this is the one that is meant to be reading you back.
 */
const EYE = '#3fb3c4';

// ---------------------------------------------------------------------------
// The figure, in construction order
// ---------------------------------------------------------------------------

// The head is 156 x 160 — square enough to read as one — in a 300 x 400 frame.
// Everything else is placed off its edges rather than by eye, so the faceplate's
// border is even on all four sides by construction and not by adjustment.
const HEAD_X = 72;
const HEAD_Y = 154;
const HEAD_W = 156;
const HEAD_H = 160;
const HEAD_R = 34;
/** The faceplate's inset, and therefore its border, on every side. */
const INSET = 22;

const PLATE_X = HEAD_X + INSET;
const PLATE_Y = HEAD_Y + INSET;
const PLATE_W = HEAD_W - INSET * 2;
const PLATE_H = HEAD_H - INSET * 2;
const PLATE_R = 22;

const HEAVY = 2;
const PLATE = 1.6;
const FINE = 1.4;

/**
 * Head, faceplate, headphones, earcups, antenna, eyes, mouth — which is the
 * order it is drawn in and the order it is taken away in.
 *
 * The head and the faceplate are each split into two strokes meeting at their
 * side midpoints, so the outline arrives as two sweeps rather than one long
 * crawl around the perimeter. With round caps the join is invisible.
 */
function buildAgent(): Stroke[] {
  const midY = HEAD_Y + HEAD_H / 2;
  const plateMidY = PLATE_Y + PLATE_H / 2;

  return [
    // --- head outline -----------------------------------------------------
    stroke(HEAVY, (p) =>
      p
        .move(HEAD_X, midY)
        .line(HEAD_X, HEAD_Y + HEAD_R)
        .arcTo(HEAD_R, 1, HEAD_X + HEAD_R, HEAD_Y, q(HEAD_R))
        .line(HEAD_X + HEAD_W - HEAD_R, HEAD_Y)
        .arcTo(HEAD_R, 1, HEAD_X + HEAD_W, HEAD_Y + HEAD_R, q(HEAD_R))
        .line(HEAD_X + HEAD_W, midY)
    ),
    stroke(HEAVY, (p) =>
      p
        .move(HEAD_X + HEAD_W, midY)
        .line(HEAD_X + HEAD_W, HEAD_Y + HEAD_H - HEAD_R)
        .arcTo(HEAD_R, 1, HEAD_X + HEAD_W - HEAD_R, HEAD_Y + HEAD_H, q(HEAD_R))
        .line(HEAD_X + HEAD_R, HEAD_Y + HEAD_H)
        .arcTo(HEAD_R, 1, HEAD_X, HEAD_Y + HEAD_H - HEAD_R, q(HEAD_R))
        .line(HEAD_X, midY)
    ),

    // --- faceplate --------------------------------------------------------
    stroke(PLATE, (p) =>
      p
        .move(PLATE_X, plateMidY)
        .line(PLATE_X, PLATE_Y + PLATE_R)
        .arcTo(PLATE_R, 1, PLATE_X + PLATE_R, PLATE_Y, q(PLATE_R))
        .line(PLATE_X + PLATE_W - PLATE_R, PLATE_Y)
        .arcTo(PLATE_R, 1, PLATE_X + PLATE_W, PLATE_Y + PLATE_R, q(PLATE_R))
        .line(PLATE_X + PLATE_W, plateMidY)
    ),
    stroke(PLATE, (p) =>
      p
        .move(PLATE_X + PLATE_W, plateMidY)
        .line(PLATE_X + PLATE_W, PLATE_Y + PLATE_H - PLATE_R)
        .arcTo(PLATE_R, 1, PLATE_X + PLATE_W - PLATE_R, PLATE_Y + PLATE_H, q(PLATE_R))
        .line(PLATE_X + PLATE_R, PLATE_Y + PLATE_H)
        .arcTo(PLATE_R, 1, PLATE_X, PLATE_Y + PLATE_H - PLATE_R, q(PLATE_R))
        .line(PLATE_X, plateMidY)
    ),

    // --- headphones -------------------------------------------------------
    // A band, not a halo: it clears the crown by twenty units and comes down
    // onto the earcups, which are centred on the head rather than hung below it.
    stroke(HEAVY, (p) =>
      p.move(65, 208).curve(65, 154, 104, 134, 150, 134).curve(196, 134, 235, 154, 235, 208)
    ),
    box(PLATE, 52, 204, 26, 58, 12),
    box(PLATE, 222, 204, 26, 58, 12),

    // --- antenna ----------------------------------------------------------
    stroke(FINE, (p) => p.move(242, 206).curve(252, 190, 260, 174, 266, 160)),
    stroke(FINE, (p) => p.circle(268, 151, 7)),

    // --- eyes, then the mouth last ----------------------------------------
    stroke(FINE, (p) => p.circle(126, 212, 12), EYE),
    stroke(FINE, (p) => p.circle(174, 212, 12), EYE),
    stroke(FINE, (p) => p.move(126, 256).quad(150, 272, 174, 256)),
  ];
}

export interface DrawingAgentProps {
  className?: string;
  reducedMotion: boolean;
}

export default function DrawingAgent({ className, reducedMotion }: DrawingAgentProps) {
  const hostRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = hostRef.current;
    if (!svg) return;
    return runDrawLoop(svg, {
      strokes: buildAgent(),
      inkWet: INK_WET,
      inkDry: INK_DRY,
      drawMs: DRAW_MS,
      holdMs: HOLD_MS,
      eraseMs: ERASE_MS,
      reducedMotion,
    });
  }, [reducedMotion]);

  return (
    <svg
      className={className}
      ref={hostRef}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    />
  );
}
