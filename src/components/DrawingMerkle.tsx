// DrawingMerkle.tsx — a Merkle tree, drawn from the leaves up and unmade the
// same way.
//
// The figure behind /notary's hero, and it is not an ornament borrowed from
// somewhere: it is the page's own mechanism. Notary folds a day's records into
// leaves, pairs them upward, and publishes the one root that survives. A record
// that moves afterwards no longer reaches that root. The animation is that
// sentence, and the erase is the other half of the argument — the network
// forgets, and what is left afterwards is whatever was anchored.
//
// Thirty strokes: eight leaves, then each parent's two edges and the parent
// itself, up to a single root and the ring that marks it. Drawing order is
// construction order, so the erase — which sweeps in the same order — starts at
// the leaves and works up, which is also how a ring actually loses history.
//
// The pen and the loop are drawing.ts, shared with the landing's robot. Nothing
// here is teal: this figure reports nothing, and the accent means state.

import { useEffect, useRef } from 'react';
import { node, runDrawLoop, stroke, type Stroke } from './drawing';

const VIEW_W = 572;
const VIEW_H = 400;

// The robot's rhythm, which is the site's. It was tried half again as slow on
// the grounds that a tree is an argument rather than a face — but a face is
// recognisable from its first stroke and a tree built leaves-first means
// nothing until the edges arrive, so the slower version spent its opening
// seconds showing the visitor eight unexplained squares. Same pace, then.
const DRAW_MS = 12_000;
const HOLD_MS = 2_500;
const ERASE_MS = 6_000;

/** Wet while the pen is moving, dry once the stroke is down. */
const INK_WET = 'rgba(255, 255, 255, 0.40)';
const INK_DRY = 'rgba(255, 255, 255, 0.17)';

// ---------------------------------------------------------------------------
// The tree, by construction rather than by eye
// ---------------------------------------------------------------------------

/** Four rows, bottom to top. Every x below is derived from the row beneath it. */
const LEAF_Y = 356;
const L1_Y = 256;
const L2_Y = 150;
const ROOT_Y = 44;

const LEAF_X0 = 34;
const LEAF_STEP = 72;

/** Node sizes grow as the tree narrows: eight small leaves, one large root. */
const LEAF_SIZE = 14;
const L1_SIZE = 18;
const L2_SIZE = 22;
const ROOT_R = 17;
/** The ring around the root, and the only thing in the figure that is not the tree. */
const ROOT_RING_R = 27;

const EDGE = 1;
const LEAF_W = 1.3;
const L1_W = 1.5;
const L2_W = 1.7;
const ROOT_W = 2;
const RING_W = 1.2;

const leafX = (i: number) => LEAF_X0 + i * LEAF_STEP;
/** A parent sits midway between its two children, at every level. */
const midOf = (xs: number[], i: number) => (xs[i * 2] + xs[i * 2 + 1]) / 2;

/** Child top edge to parent bottom edge, drawn upward — leaves toward the root. */
const edge = (fromX: number, fromY: number, toX: number, toY: number): Stroke =>
  stroke(EDGE, (p) => p.move(fromX, fromY).line(toX, toY));

function buildTree(): Stroke[] {
  const leaves = Array.from({ length: 8 }, (_, i) => leafX(i));
  const l1 = Array.from({ length: 4 }, (_, i) => midOf(leaves, i));
  const l2 = Array.from({ length: 2 }, (_, i) => midOf(l1, i));
  const rootX = (l2[0] + l2[1]) / 2;

  const strokes: Stroke[] = [];

  // --- the leaves, left to right ------------------------------------------
  for (const x of leaves) strokes.push(node(LEAF_W, x, LEAF_Y, LEAF_SIZE, 3));

  // --- each parent: its two edges, then the parent ------------------------
  // Pairs, not a sweep across the row: a Merkle tree is built two at a time and
  // the animation should show that rather than four unexplained edges at once.
  l1.forEach((x, i) => {
    strokes.push(edge(leaves[i * 2], LEAF_Y - LEAF_SIZE / 2, x, L1_Y + L1_SIZE / 2));
    strokes.push(edge(leaves[i * 2 + 1], LEAF_Y - LEAF_SIZE / 2, x, L1_Y + L1_SIZE / 2));
    strokes.push(node(L1_W, x, L1_Y, L1_SIZE, 4));
  });

  l2.forEach((x, i) => {
    strokes.push(edge(l1[i * 2], L1_Y - L1_SIZE / 2, x, L2_Y + L2_SIZE / 2));
    strokes.push(edge(l1[i * 2 + 1], L1_Y - L1_SIZE / 2, x, L2_Y + L2_SIZE / 2));
    strokes.push(node(L2_W, x, L2_Y, L2_SIZE, 5));
  });

  // --- and the one root ---------------------------------------------------
  strokes.push(edge(l2[0], L2_Y - L2_SIZE / 2, rootX, ROOT_Y + ROOT_R));
  strokes.push(edge(l2[1], L2_Y - L2_SIZE / 2, rootX, ROOT_Y + ROOT_R));
  strokes.push(stroke(ROOT_W, (p) => p.circle(rootX, ROOT_Y, ROOT_R)));
  strokes.push(stroke(RING_W, (p) => p.circle(rootX, ROOT_Y, ROOT_RING_R)));

  return strokes;
}

export interface DrawingMerkleProps {
  className?: string;
  reducedMotion: boolean;
}

export default function DrawingMerkle({ className, reducedMotion }: DrawingMerkleProps) {
  const hostRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = hostRef.current;
    if (!svg) return;
    return runDrawLoop(svg, {
      strokes: buildTree(),
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
