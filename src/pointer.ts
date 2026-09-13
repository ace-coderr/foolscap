// pointer.ts — one pointer, one loop, one set of custom properties.
//
// Five of the landing page's effects want to know where the pointer is: the
// glow, the grid brightening under it, the sphere's rotation, the magnetic
// pills, and (indirectly) the card tilt. Five listeners and five rAF loops would
// be five chances to drop a frame while the sphere is drawing eight thousand
// points, so there is one of each and everything else reads from it.
//
// READ FIRST, THEN WRITE, and never the other way round. Every frame needs some
// element rects, and a rect read after a style write forces the browser to
// recalculate and lay out synchronously before it can answer. Doing the reads at
// the top of the frame answers them from the layout the previous frame already
// produced, which costs nothing. Getting this backwards halved the frame rate —
// 60fps to 30 — with no visible change to the page, which is exactly how this
// kind of mistake survives a look.
//
// The other half of that: custom properties go on the elements that use them,
// never on documentElement. A property set on the root invalidates style for the
// whole document, so the next rect read has the entire tree to recalculate.
// --glow-on is the exception, because the grid overlays in three sections read
// it and it changes twice a session rather than sixty times a second.
//
// The loop stops when there is nothing left to move. A page that keeps a rAF
// alive to lerp a value that has already arrived is a page that never lets the
// machine idle.

/** Live pointer position, in viewport coordinates. Read, never written. */
export const pointer = { x: -9999, y: -9999, inside: false };

/** Fraction of the remaining distance the glow closes each frame. */
const LAG = 0.12;
/** Magnetic pills pull from this far away, and by at most this much. */
const MAGNET_RANGE = 60;
const MAGNET_SHIFT = 4;
/** Below this, the lerp has arrived and the loop can stop. */
const SETTLED = 0.1;

export interface PointerFieldOptions {
  /** The glow itself. Its position is written onto it, not onto the root. */
  glow: () => HTMLElement | null;
  /** Grid layers to brighten. Each gets the pointer in its OWN coordinates. */
  grids: () => HTMLElement[];
  /** Elements that lean toward the pointer. */
  magnets: () => HTMLElement[];
}

/**
 * Start tracking. Returns a teardown.
 *
 * Does nothing at all on a device without a fine pointer, or when the reader has
 * asked for reduced motion — in both cases the page is left exactly as the
 * stylesheet drew it.
 */
export function startPointerField({ glow, grids, magnets }: PointerFieldOptions): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!fine || still) return () => {};

  const root = document.documentElement;
  let raw = { x: -9999, y: -9999 };
  let lag = { x: -9999, y: -9999 };
  let frame = 0;
  let running = false;

  // Document-space tops for the grid layers, so the loop can turn a viewport
  // position into a layer-local one with a scroll read instead of a rect read.
  let gridTops: Array<{ el: HTMLElement; top: number }> = [];
  let magnetEls: HTMLElement[] = [];
  let glowEl: HTMLElement | null = null;

  const remeasure = () => {
    glowEl = glow();
    gridTops = grids().map((el) => ({ el, top: el.getBoundingClientRect().top + window.scrollY }));
    magnetEls = magnets();
  };

  /** Scratch, reused every frame so the loop allocates nothing. */
  const pulls: Array<{ el: HTMLElement; x: number; y: number }> = [];

  const step = () => {
    frame = 0;

    // ---- read ------------------------------------------------------------
    // Everything that needs the browser to measure, before anything is
    // written. These answer from the previous frame's layout.
    const scrolled = window.scrollY;
    pulls.length = 0;
    for (const el of magnetEls) {
      const box = el.getBoundingClientRect();
      const dx = raw.x - (box.left + box.width / 2);
      const dy = raw.y - (box.top + box.height / 2);
      // Distance to the element's edge, not its centre, so a wide pill pulls
      // along its whole length rather than only near the middle.
      const ex = Math.max(0, Math.abs(dx) - box.width / 2);
      const ey = Math.max(0, Math.abs(dy) - box.height / 2);
      const distance = Math.hypot(ex, ey);
      const pull = distance > MAGNET_RANGE ? 0 : 1 - distance / MAGNET_RANGE;
      const length = Math.hypot(dx, dy) || 1;
      pulls.push({
        el,
        x: (dx / length) * MAGNET_SHIFT * pull,
        y: (dy / length) * MAGNET_SHIFT * pull,
      });
    }

    // ---- write -----------------------------------------------------------
    // Glow trails rather than sticks.
    lag.x += (raw.x - lag.x) * LAG;
    lag.y += (raw.y - lag.y) * LAG;

    if (glowEl) {
      glowEl.style.setProperty('--gx', `${lag.x.toFixed(1)}px`);
      glowEl.style.setProperty('--gy', `${lag.y.toFixed(1)}px`);
    }

    // The grid overlay is a child of each section, so it needs the pointer in
    // that section's coordinates. All of them span the full width, so only the
    // vertical offset differs.
    const pageY = lag.y + scrolled;
    for (const { el, top } of gridTops) {
      el.style.setProperty('--lx', `${lag.x.toFixed(1)}px`);
      el.style.setProperty('--ly', `${(pageY - top).toFixed(1)}px`);
    }

    for (const { el, x, y } of pulls) {
      el.style.setProperty('--mx', `${x.toFixed(2)}px`);
      el.style.setProperty('--my', `${y.toFixed(2)}px`);
    }

    pointer.x = raw.x;
    pointer.y = raw.y;

    const settled = Math.abs(raw.x - lag.x) < SETTLED && Math.abs(raw.y - lag.y) < SETTLED;
    if (!settled || running) frame = requestAnimationFrame(step);
    else running = false;
  };

  const wake = () => {
    running = true;
    if (!frame) frame = requestAnimationFrame(step);
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    if (!pointer.inside) {
      // First sight: put the glow where the pointer is rather than flying it in
      // from the corner it was parked in.
      lag = { x: event.clientX, y: event.clientY };
    }
    raw = { x: event.clientX, y: event.clientY };
    pointer.inside = true;
    root.style.setProperty('--glow-on', '1');
    wake();
  };

  const onLeave = () => {
    pointer.inside = false;
    root.style.setProperty('--glow-on', '0');
    for (const el of magnetEls) {
      el.style.setProperty('--mx', '0px');
      el.style.setProperty('--my', '0px');
    }
    running = false;
  };

  const onScrollOrResize = () => {
    remeasure();
    if (pointer.inside) wake();
  };

  remeasure();
  // The sphere arrives lazily, and the grids move as sections reveal.
  const settle = window.setTimeout(remeasure, 1200);

  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onLeave);
  window.addEventListener('resize', onScrollOrResize, { passive: true });
  window.addEventListener('scroll', onScrollOrResize, { passive: true });

  return () => {
    window.clearTimeout(settle);
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('blur', onLeave);
    window.removeEventListener('resize', onScrollOrResize);
    window.removeEventListener('scroll', onScrollOrResize);
    root.style.removeProperty('--glow-on');
    pointer.inside = false;
  };
}

/**
 * Props that make an element lean toward the pointer while it is over it.
 *
 * Four degrees at the corners. The transition is switched off while the pointer
 * is on the card so the tilt tracks rather than chases, and switched back on
 * when it leaves so the card eases flat instead of snapping.
 */
export function tiltProps(maxDegrees = 4) {
  return {
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse') return;
      const el = event.currentTarget;
      const box = el.getBoundingClientRect();
      // -1..1 from the centre.
      const px = (event.clientX - box.left) / box.width - 0.5;
      const py = (event.clientY - box.top) / box.height - 0.5;
      el.dataset.tilt = 'on';
      // Pointer right tips the right edge away: rotateY follows x, rotateX
      // opposes y, which is what reads as the card leaning toward the cursor.
      el.style.setProperty('--ry', `${(px * 2 * maxDegrees).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${(-py * 2 * maxDegrees).toFixed(2)}deg`);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      const el = event.currentTarget;
      delete el.dataset.tilt;
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    },
  };
}

/** Is the pointer inside this box right now? Used by the sphere. */
export function pointerWithin(box: DOMRect): boolean {
  return (
    pointer.inside &&
    pointer.x >= box.left &&
    pointer.x <= box.right &&
    pointer.y >= box.top &&
    pointer.y <= box.bottom
  );
}
