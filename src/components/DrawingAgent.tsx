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
// ---------------------------------------------------------------------------
// THE INK, unchanged from the sonnet this replaces, because it was right.
//
// With `stroke-dasharray: 1 1` on a path declaring `pathLength="1"`, the first
// dash spans [-offset, -offset + 1] and the ink is that intersected with [0, 1]:
//
//   offset +1   nothing          offset  0   the whole stroke
//   offset +0.5 the first half   offset -0.5 the second half
//   offset -1   nothing again
//
// One sweep from +1 through 0 to -1 takes a stroke from empty to full to empty,
// both halves running from the same end. That is also why the erase cannot
// fragment: the ink is always ONE interval [p, 1], a single clean edge moving
// along the stroke, never a dash pattern breaking into pieces.
//
// `pathLength="1"` keeps the maths normalised, so nothing here calls
// getTotalLength() — a layout read, and a layout read in an animation loop is
// how this page lost half its frame rate once already.
//
// ---------------------------------------------------------------------------
// LENGTHS ARE COMPUTED WHILE THE FIGURE IS DRAWN, not measured afterwards.
//
// Pacing has to be proportional or the long contours flash past while the short
// facet chords crawl. The pen below accumulates an approximation as it goes —
// for a cubic, the mean of the chord and the control polygon, which is within a
// percent or so over curves this shallow. Good enough to move a pen by, and it
// costs nothing.

import { useEffect, useRef } from 'react';
import { pointerWithin } from '../pointer';

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

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// A pen that remembers how far it has travelled
// ---------------------------------------------------------------------------

class Pen {
  private parts: string[] = [];
  private x = 0;
  private y = 0;
  len = 0;

  move(x: number, y: number): this {
    this.parts.push(`M${x} ${y}`);
    this.x = x;
    this.y = y;
    return this;
  }

  line(x: number, y: number): this {
    this.len += Math.hypot(x - this.x, y - this.y);
    this.parts.push(`L${x} ${y}`);
    this.x = x;
    this.y = y;
    return this;
  }

  /** Cubic. Length taken as the mean of the chord and the control polygon. */
  curve(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    const chord = Math.hypot(x - this.x, y - this.y);
    const poly =
      Math.hypot(x1 - this.x, y1 - this.y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2);
    this.len += (chord + poly) / 2;
    this.parts.push(`C${x1} ${y1} ${x2} ${y2} ${x} ${y}`);
    this.x = x;
    this.y = y;
    return this;
  }

  quad(cx: number, cy: number, x: number, y: number): this {
    const chord = Math.hypot(x - this.x, y - this.y);
    const poly = Math.hypot(cx - this.x, cy - this.y) + Math.hypot(x - cx, y - cy);
    this.len += (chord + poly) / 2;
    this.parts.push(`Q${cx} ${cy} ${x} ${y}`);
    this.x = x;
    this.y = y;
    return this;
  }

  /**
   * A circular arc to a point. The caller states its length, because for the
   * quarter-circles this figure is made of it is exactly πr/2 and working it
   * out from the endpoints would be arithmetic in service of nothing.
   */
  arcTo(r: number, sweep: 0 | 1, x: number, y: number, arcLen: number): this {
    this.parts.push(`A${r} ${r} 0 0 ${sweep} ${x} ${y}`);
    this.len += arcLen;
    this.x = x;
    this.y = y;
    return this;
  }

  /** A full circle, as two arcs. Its length is known exactly. */
  circle(cx: number, cy: number, r: number): this {
    this.parts.push(
      `M${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}`
    );
    this.len += 2 * Math.PI * r;
    this.x = cx - r;
    this.y = cy;
    return this;
  }

  d(): string {
    return this.parts.join('');
  }
}

interface Stroke {
  d: string;
  len: number;
  width: number;
  eye?: boolean;
}

const stroke = (width: number, build: (pen: Pen) => void, eye = false): Stroke => {
  const pen = new Pen();
  build(pen);
  return { d: pen.d(), len: pen.len, width, eye };
};

/** A quarter circle's length. Every corner in the figure is one of these. */
const q = (r: number) => (Math.PI * r) / 2;

/** A rounded rectangle, clockwise from the top-left corner, as one stroke. */
const box = (width: number, x: number, y: number, w: number, h: number, r: number): Stroke =>
  stroke(width, (p) =>
    p
      .move(x + r, y)
      .line(x + w - r, y)
      .arcTo(r, 1, x + w, y + r, q(r))
      .line(x + w, y + h - r)
      .arcTo(r, 1, x + w - r, y + h, q(r))
      .line(x + r, y + h)
      .arcTo(r, 1, x, y + h - r, q(r))
      .line(x, y + r)
      .arcTo(r, 1, x + r, y, q(r))
  );

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
    stroke(HEAVY, (p) => p.move(65, 208).curve(65, 154, 104, 134, 150, 134).curve(196, 134, 235, 154, 235, 208)),
    box(PLATE, 52, 204, 26, 58, 12),
    box(PLATE, 222, 204, 26, 58, 12),

    // --- antenna ----------------------------------------------------------
    stroke(FINE, (p) => p.move(242, 206).curve(252, 190, 260, 174, 266, 160)),
    stroke(FINE, (p) => p.circle(268, 151, 7)),

    // --- eyes, then the mouth last ----------------------------------------
    stroke(FINE, (p) => p.circle(126, 212, 12), true),
    stroke(FINE, (p) => p.circle(174, 212, 12), true),
    stroke(FINE, (p) => p.move(126, 256).quad(150, 272, 174, 256)),
  ];
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export interface DrawingAgentProps {
  className?: string;
  reducedMotion: boolean;
}

export default function DrawingAgent({ className, reducedMotion }: DrawingAgentProps) {
  const hostRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = hostRef.current;
    if (!svg) return;

    const strokes = buildAgent();
    const total = strokes.reduce((n, s) => n + s.len, 0) || 1;

    // Where each stroke sits along the whole figure, so drawing and erasing can
    // both be driven by one progress value running over the total length.
    const starts: number[] = [];
    let run = 0;
    for (const s of strokes) {
      starts.push(run / total);
      run += s.len;
    }
    const spans = strokes.map((s) => s.len / total);

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('fill', 'none');
    group.setAttribute('stroke-linecap', 'round');
    group.setAttribute('stroke-linejoin', 'round');
    // Without this the hairlines would thicken with the viewport.
    group.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(group);

    const paths = strokes.map((s) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', s.d);
      path.setAttribute('pathLength', '1');
      path.setAttribute('stroke-dasharray', '1 1');
      path.setAttribute('stroke-width', String(s.width));
      path.setAttribute('stroke', INK_WET);
      path.setAttribute('stroke-dashoffset', '1');
      group.appendChild(path);
      return path;
    });

    // Last values written, so a stroke that has not changed is never written
    // again. At any moment one stroke is drawing and one is erasing; the other
    // forty sit untouched.
    const settled = strokes.map(() => false);
    const written = strokes.map(() => 1);

    const setOffset = (i: number, value: number) => {
      const rounded = Math.round(value * 10000) / 10000;
      if (written[i] === rounded) return;
      written[i] = rounded;
      paths[i].setAttribute('stroke-dashoffset', String(rounded));
    };

    const setSettled = (i: number, done: boolean) => {
      if (settled[i] === done) return;
      settled[i] = done;
      paths[i].setAttribute('stroke', done ? (strokes[i].eye ? EYE : INK_DRY) : INK_WET);
    };

    // --- the still frame ---------------------------------------------------
    if (reducedMotion) {
      strokes.forEach((_, i) => {
        setOffset(i, 0);
        setSettled(i, true);
      });
      return () => {
        group.remove();
      };
    }

    // --- the loop ----------------------------------------------------------
    let frame = 0;
    let previous = performance.now();
    let phase: 'draw' | 'hold' | 'erase' = 'draw';
    let spent = 0;

    let box: DOMRect | null = null;
    let boxStale = true;
    const markStale = () => {
      boxStale = true;
    };
    window.addEventListener('scroll', markStale, { passive: true });
    const observer = new ResizeObserver(markStale);
    observer.observe(svg);

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(64, now - previous);
      previous = now;

      if (boxStale) {
        box = svg.getBoundingClientRect();
        boxStale = false;
      }
      // Watching holds the unmaking. Only the erase pauses: the figure goes on
      // being built either way.
      const held = phase === 'erase' && box !== null && pointerWithin(box);

      if (!held) spent += dt;

      let drawP = 1;
      let eraseP = 0;

      if (phase === 'draw') {
        drawP = clamp01(spent / DRAW_MS);
        if (spent >= DRAW_MS) {
          phase = 'hold';
          spent = 0;
          drawP = 1;
        }
      } else if (phase === 'hold') {
        if (spent >= HOLD_MS) {
          phase = 'erase';
          spent = 0;
        }
      } else {
        eraseP = clamp01(spent / ERASE_MS);
        if (spent >= ERASE_MS) {
          phase = 'draw';
          spent = 0;
          drawP = 0;
          eraseP = 0;
        }
      }

      for (let i = 0; i < paths.length; i++) {
        const from = starts[i];
        const span = spans[i] || 1;
        const drawn = clamp01((drawP - from) / span);
        const erased = clamp01((eraseP - from) / span);
        setOffset(i, 1 - drawn - erased);
        // Settled on having been DRAWN, not on still being whole. Including the
        // erase here flipped each stroke back to wet ink as the sweep reached
        // it, so the figure appeared to brighten and redraw itself while it was
        // being taken away. A stroke keeps the colour it settled to and simply
        // goes; only a new cycle, which puts drawn back to zero, makes it wet.
        setSettled(i, drawn >= 1);
      }
    };

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', markStale);
      observer.disconnect();
      group.remove();
    };
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
