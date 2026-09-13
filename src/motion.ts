// motion.ts — the small amount of movement this site has, and the one switch
// that turns all of it off.
//
// Every hook here reads prefers-reduced-motion first and, when it is set,
// resolves immediately to the finished state rather than to nothing: a section
// that reveals on scroll must be visible, a number that counts up must show its
// number, a parallax must sit still. Reduced motion means no movement, never
// less content.
//
// The observers are one-shot. A section that faded up on the way down and faded
// out again on the way back would be an effect about scrolling rather than about
// arriving, and re-running it every pass is how a page starts to feel busy.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

export function usePrefersReducedMotion(): boolean {
  const query = useMemo(
    () =>
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null,
    []
  );
  const [reduced, setReduced] = useState(() => query?.matches ?? false);

  useEffect(() => {
    if (!query) return;
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, [query]);

  return reduced;
}

/**
 * True once the element has been seen, and true for good.
 *
 * The bottom margin holds the trigger back a little so a section starts moving
 * after it is properly on screen rather than the instant its first pixel is.
 */
export function useInView<T extends HTMLElement>(): [RefObject<T>, boolean] {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (reduced) {
      setSeen(true);
      return;
    }
    const node = ref.current;
    // No observer, no node: show it. Never leave content hidden behind a
    // capability check.
    if (!node || typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -8% 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduced]);

  return [ref, seen];
}

/**
 * Count from zero to `target` once `active` goes true.
 *
 * Ease-out cubic: quick at the start, settling rather than stopping. Under
 * reduced motion the target is simply the value from the first render — the
 * figure is the content, and the counting is decoration on top of it.
 */
export function useCountUp(target: number, active: boolean, duration = 900): number {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(() => (reduced ? target : 0));

  useEffect(() => {
    if (reduced) {
      setValue(target);
      return;
    }
    if (!active) return;

    // The first frame establishes the clock: performance.now() read at effect
    // time can already be a frame stale, which shows up as a dropped first step.
    let start: number | undefined;
    let frame = 0;

    const step = (now: number) => {
      start ??= now;
      const t = Math.min(1, (now - start) / duration);
      setValue(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);

    return () => cancelAnimationFrame(frame);
  }, [target, active, duration, reduced]);

  return value;
}

/**
 * Drift an element sideways as it passes through the viewport.
 *
 * Writes a percentage to `--drift` rather than setting a transform, so the
 * element's stylesheet decides what to do with it and nothing here has to know
 * whether it is already transformed.
 *
 * `travel` is the total movement across the whole pass, so the element sits at
 * minus half of it on the way in and plus half on the way out, and is exactly
 * where it was drawn when it is centred.
 */
export function useParallax<T extends HTMLElement>(travel = 2): RefObject<T> {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (reduced) {
      node.style.removeProperty('--drift');
      return;
    }

    let frame = 0;
    const update = () => {
      frame = 0;
      const box = node.getBoundingClientRect();
      const span = window.innerHeight + box.height;
      if (span <= 0) return;
      // 0 as the element enters from below, 1 as it leaves past the top.
      const progress = Math.min(1, Math.max(0, (window.innerHeight - box.top) / span));
      node.style.setProperty('--drift', `${((progress - 0.5) * travel).toFixed(3)}%`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [reduced, travel]);

  return ref;
}
