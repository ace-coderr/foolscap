// DrawingSonnet.tsx — verse being written while its own beginning disappears.
//
// Fourteen lines of abstract handwriting: stroke paths with the rhythm and the
// ragged right edge of written verse, readable as writing at a glance and as
// nothing at all up close. Lines draw left to right in sequence; once the eighth
// is down the first starts to go, erasing from its own opening; when the
// fourteenth lands the block scrolls up a line and another begins beneath. It
// never empties and it never resets.
//
// That is the product, drawn: Technocore's rooms are rings, and what is being
// written is always outrunning what is being lost.
//
// ---------------------------------------------------------------------------
// HOW THE INK WORKS, because one number does all of it.
//
// With `stroke-dasharray: 1 1` on a path declaring `pathLength="1"`, the first
// dash spans [-offset, -offset + 1] and the ink is that intersected with [0, 1]:
//
//   offset +1   nothing          offset  0   the whole stroke
//   offset +0.5 the first half   offset -0.5 the second half
//   offset -1   nothing again
//
// So a single sweep from +1 through 0 to -1 takes a stroke from empty to full
// to empty, and both halves run left to right — drawing and erasing are the same
// parameter in opposite directions rather than two mechanisms.
//
// `pathLength="1"` is the other half of that. Declaring the length means the
// dash maths is in a normalised space, so nothing here ever calls
// getTotalLength() — which is a layout read, and layout reads inside an
// animation loop are how this page lost half its frame rate once already.
//
// ---------------------------------------------------------------------------
// WHY THE DOM IS BUILT BY HAND rather than rendered.
//
// A line is recycled roughly once a second and React would rebuild twenty-two
// groups of six paths to do it. The SVG is built once in an effect and the loop
// writes attributes on the elements it already has; React never sees a frame.

import { useEffect, useRef } from 'react';
import { pointerWithin } from '../pointer';

/** Lines standing at once. Fourteen, because that is what a sonnet is. */
const VISIBLE = 14;
/**
 * Line elements kept. More than are visible: a line goes on fading after it has
 * scrolled off the top, and while the pointer is over the block it may go on
 * fading for a while. The surplus is that grace period.
 */
const RING = 22;

const LINE_H = 26;
const VIEW_W = 273;
const VIEW_H = VISIBLE * LINE_H; // 364 — and 273:364 is 3:4.

const DRAW_MS = 900;
const GAP_MS = 250;
/** Start to start. Fourteen of these is 16.1s for a whole sonnet. */
const STEP_MS = DRAW_MS + GAP_MS;
const FADE_MS = 2000;
const SCROLL_MS = 900;
/** Line k begins to go when line k + this completes. */
const FADE_BEHIND = 7;

/** Wet while the pen is moving, dry once the line is down. */
const INK_WET = 'rgba(255, 255, 255, 0.55)';
const INK_DRY = 'rgba(255, 255, 255, 0.32)';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// The hand
// ---------------------------------------------------------------------------

/**
 * A small deterministic generator, seeded per line.
 *
 * Deterministic so a line looks the same every time it is built, and so the
 * still frame served under reduced motion is the same page of verse every load
 * rather than a fresh scribble.
 */
function seeded(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * One word: a stroke that rises and falls about the baseline the way a hand
 * does, with the occasional ascender and rarer descender to break the band.
 */
function wordPath(x0: number, y: number, w: number, rnd: () => number): string {
  const steps = Math.max(2, Math.round(w / 2.6));
  const dx = w / steps;
  let d = `M${x0.toFixed(2)} ${y.toFixed(2)}`;
  let x = x0;
  for (let i = 0; i < steps; i++) {
    const up = i % 2 === 0;
    const amp = 2 + rnd() * 1.5;
    const ascender = rnd() < 0.13 ? 3.5 + rnd() * 3 : 0;
    const descender = rnd() < 0.09 ? 2.5 + rnd() * 2.5 : 0;
    const cy = up ? y - (amp + ascender) : y + amp * 0.55 + descender;
    const ny = y + (rnd() - 0.5) * 1.1;
    d += `Q${(x + dx / 2).toFixed(2)} ${cy.toFixed(2)} ${(x + dx).toFixed(2)} ${ny.toFixed(2)}`;
    x += dx;
  }
  return d;
}

interface Word {
  d: string;
  /** Where this word starts, as a fraction of the line's total inked width. */
  from: number;
  to: number;
}

/**
 * A line of verse: words of uneven length to a ragged right edge, the whole
 * line sitting a little high or low so the block breathes rather than ruling.
 */
function buildLine(index: number): Word[] {
  const rnd = seeded(index + 1);
  const target = VIEW_W * (0.72 + rnd() * 0.26);
  const drift = (rnd() - 0.5) * 1.7;

  const raw: { d: string; w: number }[] = [];
  let x = 0;
  while (x < target - 6) {
    const w = Math.min(target - x, 7 + rnd() * 19);
    if (w < 5) break;
    raw.push({ d: wordPath(x, drift, w, rnd), w });
    x += w + 3 + rnd() * 3.5;
  }

  // Sequencing is by inked width rather than true arc length: the squiggle has
  // a near-constant length per unit of width, so this is proportional enough to
  // pace a pen by, and it costs no measurement.
  const total = raw.reduce((n, word) => n + word.w, 0) || 1;
  let run = 0;
  return raw.map((word) => {
    const from = run / total;
    run += word.w;
    return { d: word.d, from, to: run / total };
  });
}

// ---------------------------------------------------------------------------

interface Line {
  /** Absolute index since the page opened, or -1 while unused. */
  n: number;
  group: SVGGElement;
  paths: SVGPathElement[];
  words: Word[];
  drawn: boolean;
  /** Milliseconds of fading actually spent. Pauses while the page is read. */
  fade: number;
  gone: boolean;
}

export interface DrawingSonnetProps {
  className?: string;
  reducedMotion: boolean;
}

export default function DrawingSonnet({ className, reducedMotion }: DrawingSonnetProps) {
  const hostRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = hostRef.current;
    if (!svg) return;

    const page = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(page);

    const lines: Line[] = [];
    for (let i = 0; i < RING; i++) {
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('fill', 'none');
      group.setAttribute('stroke-linecap', 'round');
      group.setAttribute('stroke-linejoin', 'round');
      group.setAttribute('stroke-width', '1.5');
      // The block is scaled to the viewport; without this the hairline would
      // scale with it and the verse would thicken on a large screen.
      group.setAttribute('vector-effect', 'non-scaling-stroke');
      group.setAttribute('opacity', '0');
      page.appendChild(group);
      lines.push({ n: -1, group, paths: [], words: [], drawn: false, fade: 0, gone: true });
    }

    /** Put line `n` into its slot in the ring, rebuilding its words. */
    const compose = (n: number, base: number) => {
      const line = lines[n % RING];
      const words = buildLine(n);

      while (line.paths.length < words.length) {
        const path = document.createElementNS(SVG_NS, 'path');
        // Normalised length: the dash maths below is in 0..1 for every stroke,
        // whatever its real length, and nothing has to measure it.
        path.setAttribute('pathLength', '1');
        path.setAttribute('stroke-dasharray', '1 1');
        line.group.appendChild(path);
        line.paths.push(path);
      }
      for (let i = words.length; i < line.paths.length; i++) {
        line.paths[i].setAttribute('d', '');
      }
      words.forEach((word, i) => line.paths[i].setAttribute('d', word.d));

      line.n = n;
      line.words = words;
      line.drawn = false;
      line.fade = 0;
      line.gone = false;
      line.group.setAttribute('stroke', INK_WET);
      line.group.setAttribute('opacity', '1');
      line.group.setAttribute('transform', `translate(0 ${((n - base + 1) * LINE_H).toFixed(2)})`);
      paint(line, 0, 0);
    };

    /** Write one line's ink. `drawn` and `erased` are both 0..1 of the line. */
    function paint(line: Line, drawnP: number, erasedP: number) {
      for (let i = 0; i < line.words.length; i++) {
        const { from, to } = line.words[i];
        const span = to - from || 1;
        const drawn = clamp01((drawnP - from) / span);
        const erased = clamp01((erasedP - from) / span);
        line.paths[i].setAttribute('stroke-dashoffset', (1 - drawn - erased).toFixed(4));
      }
    }

    // --- the still frame ---------------------------------------------------
    if (reducedMotion) {
      const base = 0;
      for (let n = 0; n < VISIBLE; n++) {
        compose(n, base);
        const line = lines[n % RING];
        line.group.setAttribute('stroke', INK_DRY);
        // Mid-cycle: the opening three have already gone.
        if (n < 3) {
          line.group.setAttribute('opacity', '0');
          paint(line, 1, 1);
        } else {
          paint(line, 1, 0);
        }
      }
      page.setAttribute('transform', 'translate(0 0)');
      return () => {
        page.remove();
      };
    }

    // --- the loop ----------------------------------------------------------
    let frame = 0;
    const started = performance.now();
    let previous = started;
    let next = 0;
    let base = 0;
    let scrollFrom = 0;
    let scrollAt = -Infinity;

    // Cached, and invalidated rather than measured every frame.
    let box: DOMRect | null = null;
    let boxStale = true;
    const markStale = () => {
      boxStale = true;
    };
    window.addEventListener('scroll', markStale, { passive: true });
    const observer = new ResizeObserver(markStale);
    observer.observe(svg);

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(64, now - previous);
      previous = now;
      const elapsed = now - started;

      if (boxStale) {
        box = svg.getBoundingClientRect();
        boxStale = false;
      }
      // Reading holds the forgetting: a fade under the pointer keeps whatever
      // opacity it had reached and waits.
      const held = box ? pointerWithin(box) : false;

      // Start whatever lines are due.
      while (elapsed >= next * STEP_MS) {
        const n = next++;
        const wantBase = Math.max(0, n - (VISIBLE - 1));
        if (wantBase !== base) {
          base = wantBase;
          // Every line jumps up one; the page is pushed down by the same amount
          // and eased back, which is the scroll.
          for (const line of lines) {
            if (line.n >= 0) {
              line.group.setAttribute(
                'transform',
                `translate(0 ${((line.n - base + 1) * LINE_H).toFixed(2)})`
              );
            }
          }
          scrollFrom = LINE_H;
          scrollAt = now;
        }
        compose(n, base);
      }

      // The scroll easing out.
      const scrollT = clamp01((now - scrollAt) / SCROLL_MS);
      const shift = scrollFrom * (1 - easeOut(scrollT));
      page.setAttribute('transform', `translate(0 ${shift.toFixed(2)})`);

      for (const line of lines) {
        if (line.n < 0 || line.gone) continue;

        const since = elapsed - line.n * STEP_MS;
        const drawnP = clamp01(since / DRAW_MS);

        if (!line.drawn && drawnP >= 1) {
          line.drawn = true;
          line.group.setAttribute('stroke', INK_DRY);
        }

        const fadesAt = (line.n + FADE_BEHIND) * STEP_MS + DRAW_MS;
        if (elapsed >= fadesAt && !held) line.fade = Math.min(FADE_MS, line.fade + dt);
        const fadeP = line.fade / FADE_MS;

        if (fadeP >= 1) {
          line.gone = true;
          line.group.setAttribute('opacity', '0');
          paint(line, 1, 1);
          continue;
        }

        // Only the lines actually moving are written to. A line that is down
        // and not yet going is left exactly as it was.
        if (drawnP < 1 || fadeP > 0) {
          paint(line, drawnP, fadeP);
          if (fadeP > 0) line.group.setAttribute('opacity', (1 - fadeP).toFixed(3));
        }
      }
    };

    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', markStale);
      observer.disconnect();
      page.remove();
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

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
