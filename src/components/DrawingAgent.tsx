// DrawingAgent.tsx — a constructed intelligence, drawn and unmade on a loop.
//
// Head and shoulders in three-quarter turn, as an engineering schematic rather
// than a face: contour for the skull, jaw, neck and shoulder, a faceted web
// across the cranium, a few panel seams, and one sensor. It draws in the order
// it would be constructed, holds, and is swept away in the same order.
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

const HEAVY = 1.8;
const LIGHT = 1;

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

const chord = (x1: number, y1: number, x2: number, y2: number): Stroke =>
  stroke(LIGHT, (p) => p.move(x1, y1).line(x2, y2));

// ---------------------------------------------------------------------------
// The figure, in construction order
// ---------------------------------------------------------------------------

/**
 * Skull, then jaw and neck, then shoulder, then the web across the cranium,
 * then the seams, and the sensor last — the order it would be built in, which
 * is also the order it is taken apart in.
 */
function buildAgent(): Stroke[] {
  // The web's vertices. Named once and used twice, so the chords cannot drift
  // off the ring curves that share them.
  const P1 = [108, 190] as const; // brow, front
  const P2 = [134, 152] as const;
  const P3 = [168, 132] as const; // crown
  const P4 = [204, 150] as const;
  const P5 = [228, 190] as const; // occiput
  const P6 = [124, 222] as const; // cheek
  const P7 = [156, 198] as const;
  const P8 = [194, 190] as const;
  const P9 = [218, 224] as const;
  const P10 = [140, 250] as const; // jaw, front
  const P11 = [176, 240] as const;

  return [
    // --- skull ------------------------------------------------------------
    stroke(HEAVY, (p) => p.move(100, 182).curve(100, 126, 136, 100, 168, 102).curve(210, 104, 234, 140, 232, 182)),
    stroke(HEAVY, (p) => p.move(232, 182).curve(231, 212, 220, 232, 204, 244)),
    stroke(HEAVY, (p) => p.move(100, 182).curve(98, 200, 104, 214, 114, 222)),
    stroke(HEAVY, (p) => p.move(114, 222).curve(121, 238, 123, 252, 119, 266)),

    // --- jaw and neck -----------------------------------------------------
    stroke(HEAVY, (p) => p.move(119, 266).curve(142, 280, 176, 274, 199, 252)),
    stroke(HEAVY, (p) => p.move(199, 252).curve(203, 249, 204, 246, 204, 244)),
    stroke(HEAVY, (p) => p.move(134, 274).curve(132, 290, 130, 300, 128, 308)),
    stroke(HEAVY, (p) => p.move(194, 270).curve(197, 288, 201, 300, 205, 310)),

    // --- shoulders --------------------------------------------------------
    stroke(HEAVY, (p) => p.move(128, 308).curve(106, 314, 84, 326, 70, 346)),
    stroke(HEAVY, (p) => p.move(70, 346).curve(60, 358, 56, 372, 54, 400)),
    stroke(HEAVY, (p) => p.move(205, 310).curve(229, 316, 251, 330, 263, 350)),
    stroke(HEAVY, (p) => p.move(263, 350).curve(271, 364, 275, 380, 277, 400)),
    stroke(HEAVY, (p) => p.move(128, 308).curve(152, 320, 182, 322, 205, 310)),

    // --- the web across the cranium ---------------------------------------
    stroke(LIGHT, (p) => p.move(...P2).quad(168, 140, ...P4)),
    stroke(LIGHT, (p) => p.move(...P1).quad(168, 176, ...P5)),
    stroke(LIGHT, (p) => p.move(...P6).quad(170, 238, ...P9)),
    chord(...P1, ...P7),
    chord(...P2, ...P7),
    chord(...P3, ...P7),
    chord(...P3, ...P8),
    chord(...P4, ...P8),
    chord(...P5, ...P8),
    chord(...P6, ...P7),
    chord(...P7, ...P8),
    chord(...P8, ...P9),
    chord(...P6, ...P10),
    chord(...P7, ...P10),
    chord(...P7, ...P11),
    chord(...P8, ...P11),
    chord(...P10, ...P11),
    chord(...P9, ...P11),

    // --- panel seams ------------------------------------------------------
    chord(142, 280, 178, 276),
    chord(132, 296, 202, 294),
    chord(98, 334, 124, 322),
    chord(238, 334, 212, 322),

    // --- the sensor, last -------------------------------------------------
    stroke(LIGHT, (p) => p.move(110, 200).line(128, 190).line(146, 200).line(128, 210).line(110, 200), true),
    stroke(LIGHT, (p) => p.circle(128, 200, 6), true),
    stroke(LIGHT, (p) => p.move(146, 200).line(158, 198), true),
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
