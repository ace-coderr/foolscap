// drawing.ts — the pen and the loop behind every figure that draws itself.
//
// This was all inside DrawingAgent.tsx, which was correct while the robot was
// the only figure on the site. A second figure — a Merkle tree, on the page that
// built one — would have meant two copies of the one part that has already been
// got wrong once, so the mechanism moved here and the figures kept only their
// own geometry. That second figure has since gone with the page it belonged to;
// the split stays, because the next figure is cheaper to draw than to re-derive.
//
// Nothing in this file names a colour. The ink is passed in, which is also what
// keeps the accent allowlist in test/accent.test.ts meaningful: the robot's
// sensor is teal because that figure argues it is state, and the argument lives
// next to the figure making it rather than in shared machinery.
//
// ---------------------------------------------------------------------------
// THE INK.
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
// chords crawl. The pen below accumulates an approximation as it goes — for a
// cubic, the mean of the chord and the control polygon, which is within a
// percent or so over curves this shallow. Good enough to move a pen by, and it
// costs nothing.

import { pointerWithin } from '../pointer';

export const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// A pen that remembers how far it has travelled
// ---------------------------------------------------------------------------

export class Pen {
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
      Math.hypot(x1 - this.x, y1 - this.y) +
      Math.hypot(x2 - x1, y2 - y1) +
      Math.hypot(x - x2, y - y2);
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
   * quarter-circles these figures are made of it is exactly PI*r/2 and working
   * it out from the endpoints would be arithmetic in service of nothing.
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

export interface Stroke {
  d: string;
  len: number;
  width: number;
  /**
   * What this stroke settles to when the pen has passed, if not the figure's
   * own dry ink. One stroke in the robot is its sensor and takes the accent;
   * everything else in both figures is grey.
   */
  ink?: string;
}

export const stroke = (width: number, build: (pen: Pen) => void, ink?: string): Stroke => {
  const pen = new Pen();
  build(pen);
  return { d: pen.d(), len: pen.len, width, ink };
};

/** A quarter circle's length. Every square corner in these figures is one. */
export const q = (r: number) => (Math.PI * r) / 2;

/** A rounded rectangle, clockwise from the top-left corner, as one stroke. */
export const box = (
  width: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): Stroke =>
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

/** A rounded square on a centre, which is how the tree places every node. */
export const node = (width: number, cx: number, cy: number, size: number, r: number): Stroke =>
  box(width, cx - size / 2, cy - size / 2, size, size, r);

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface DrawLoopOptions {
  /** In construction order. It is also the order the figure is taken away in. */
  strokes: Stroke[];
  /** Wet while the pen is moving, dry once the stroke is down. */
  inkWet: string;
  inkDry: string;
  drawMs: number;
  holdMs: number;
  eraseMs: number;
  /** One rendered frame, fully drawn, and no loop at all. */
  reducedMotion: boolean;
}

/**
 * Draw the figure into `svg`, hold it, sweep it away, repeat. Returns the
 * teardown.
 *
 * Watching holds the unmaking: while the pointer is over the figure only the
 * erase pauses, so it goes on being built either way.
 */
export function runDrawLoop(svg: SVGSVGElement, options: DrawLoopOptions): () => void {
  const { strokes, inkWet, inkDry, drawMs, holdMs, eraseMs, reducedMotion } = options;
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
    path.setAttribute('stroke', inkWet);
    path.setAttribute('stroke-dashoffset', '1');
    group.appendChild(path);
    return path;
  });

  // Last values written, so a stroke that has not changed is never written
  // again. At any moment one stroke is drawing and one is erasing; the rest sit
  // untouched.
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
    paths[i].setAttribute('stroke', done ? (strokes[i].ink ?? inkDry) : inkWet);
  };

  // --- the still frame -----------------------------------------------------
  if (reducedMotion) {
    strokes.forEach((_, i) => {
      setOffset(i, 0);
      setSettled(i, true);
    });
    return () => {
      group.remove();
    };
  }

  // --- the loop ------------------------------------------------------------
  let frame = 0;
  let previous = performance.now();
  let phase: 'draw' | 'hold' | 'erase' = 'draw';
  let spent = 0;

  let rect: DOMRect | null = null;
  let rectStale = true;
  const markStale = () => {
    rectStale = true;
  };
  window.addEventListener('scroll', markStale, { passive: true });
  const observer = new ResizeObserver(markStale);
  observer.observe(svg);

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(64, now - previous);
    previous = now;

    if (rectStale) {
      rect = svg.getBoundingClientRect();
      rectStale = false;
    }
    // Watching holds the unmaking. Only the erase pauses: the figure goes on
    // being built either way.
    const held = phase === 'erase' && rect !== null && pointerWithin(rect);

    if (!held) spent += dt;

    let drawP = 1;
    let eraseP = 0;

    if (phase === 'draw') {
      drawP = clamp01(spent / drawMs);
      if (spent >= drawMs) {
        phase = 'hold';
        spent = 0;
        drawP = 1;
      }
    } else if (phase === 'hold') {
      if (spent >= holdMs) {
        phase = 'erase';
        spent = 0;
      }
    } else {
      eraseP = clamp01(spent / eraseMs);
      if (spent >= eraseMs) {
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
      // erase here flipped each stroke back to wet ink as the sweep reached it,
      // so the figure appeared to brighten and redraw itself while it was being
      // taken away. A stroke keeps the colour it settled to and simply goes;
      // only a new cycle, which puts drawn back to zero, makes it wet.
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
}
