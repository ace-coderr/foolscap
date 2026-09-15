// theme.ts — which of the two palettes the page is wearing.
//
// DESIGN.md's amendment: "Two themes, toggled from the nav. Default stays as it
// is." The palettes themselves are four declarations in foolscap.css; this is
// only the memory and the switch.
//
// THE SECOND LOCALSTORAGE EXCEPTION. SHELL.md says no localStorage, /vault was
// the first stated exception, and this is the second. The justification is the
// same shape and much smaller: a preference the user set by clicking a control,
// nothing about them, nothing read from the network, one key holding one of two
// words. A theme that forgot itself on every navigation would be a theme nobody
// would use twice.
//
// FIRST VISIT ONLY, prefers-color-scheme decides. After that the stored choice
// wins, including when it agrees with the system — because a user who picked
// the thing the system would have picked anyway has still picked it, and a
// later change to their OS setting should not quietly undo that.
//
// AND WHAT "LIGHT" MEANS HERE. Both themes are dark; there is no light mode to
// switch to. So `prefers-color-scheme: light` is read as "the lighter one",
// which is flop — #0A1128 against black. That is a small interpretation and it
// is written down rather than left in the code as an unexplained branch.

import { useEffect, useState } from 'react';

export type Theme = 'ink' | 'flop';

export const THEMES: ReadonlyArray<{ id: Theme; label: string }> = [
  { id: 'ink', label: 'Ink' },
  { id: 'flop', label: 'Flop' },
];

export const STORAGE_KEY = 'foolscap.theme.v1';

/** How long the cross-fade runs. Matches the transition in foolscap.css. */
export const SHIFT_MS = 200;

export const isTheme = (value: unknown): value is Theme => value === 'ink' || value === 'flop';

/**
 * Reading never throws — localStorage is absent in a server render and throws
 * outright in a locked-down browser. A browser setting should not be able to
 * take the site down, so every failure lands on "no choice stored".
 */
export function storedTheme(): Theme | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, theme);
  } catch {
    // A private window that will not keep it is still allowed to show it.
  }
}

/** The theme to open in: the stored choice, or what the system asks for. */
export function initialTheme(): Theme {
  const stored = storedTheme();
  if (stored) return stored;
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'flop' : 'ink';
  } catch {
    return 'ink';
  }
}

/**
 * Put a theme on the document.
 *
 * `shift` turns on the 200ms cross-fade for the length of the cross-fade and
 * then takes it away again. It is off on the first call, because a page that
 * faded from one palette to another as it loaded would be animating a change
 * the reader never made.
 */
export function applyTheme(theme: Theme, { shift = false }: { shift?: boolean } = {}): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;

  if (!shift) {
    root.setAttribute('data-theme', theme);
    return;
  }

  root.setAttribute('data-theme-shift', '');
  root.setAttribute('data-theme', theme);
  globalThis.setTimeout(() => root.removeAttribute('data-theme-shift'), SHIFT_MS);
}

/**
 * The choice, held once for the whole nav.
 *
 * ONE HOOK, TWO CONTROLS. On a phone the switch cannot ride in the floating
 * pill — measured at 375, the pill's content box is 321px and the ring, the
 * menu button, the switch and the action want 365 — so the narrow layout shows
 * it inside the menu panel instead, which means the nav renders two of them and
 * exactly one is ever visible. Two copies of a component that each held their
 * own state would be two answers to the same question, and the invisible one
 * would be stale the moment the other was clicked. So the state is here.
 */
export function useTheme(): { theme: Theme; choose: (next: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(() => initialTheme());

  // Without the cross-fade on the first pass: a page that faded from one
  // palette to another as it loaded would be animating a change the reader
  // never made. This also re-asserts what the inline script in index.html
  // already put on <html>, which is the point at which the two agree.
  useEffect(() => {
    applyTheme(theme);
    // Once, deliberately. Every later change goes through choose().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Not inside the setState updater, which StrictMode calls twice: an updater
  // is meant to be pure, and a second applyTheme would arm a second timer to
  // take the cross-fade away.
  const choose = (next: Theme) => {
    if (next === theme) return;
    setTheme(next);
    storeTheme(next);
    applyTheme(next, { shift: true });
  };

  return { theme, choose };
}
