// vaultStore.ts — the one place on this site that writes to localStorage.
//
// SHELL.md says "No localStorage or sessionStorage", and that rule was right
// for every page before this one: nothing else here has state worth keeping
// between visits, and a tool that reads public data has no business leaving
// anything behind. This file is the stated exception, and the exception is
// recorded in SHELL.md rather than left as a contradiction between the spec and
// the code.
//
// WHY IT HAS TO EXIST. The seven-day decay clock is invisible — the server
// publishes no written-at, no expires-at, no age, and the only `last-modified`
// on offer is the time of your own request. So the only way anyone can learn
// that a note has gone is to have looked before and remembered. Without
// somewhere to remember, /vault can report on the last few minutes and nothing
// more, which is the one span in which nothing ever expires.
//
// WHAT IT KEEPS, and it is deliberately the least that works:
//
//   the namespaces the user chose to watch, and
//   for each, the keys present at the last look and when that look happened.
//
// Nothing about the user, no note contents, no DIDs, nothing from any other
// page. All of it is public data that was on screen anyway, and all of it is
// removable from the page with one control — which exists, because a store the
// user cannot empty is a store they did not agree to.

import type { Sighting } from './lib/vault.ts';

const KEY = 'foolscap.vault.watch.v1';

export interface WatchState {
  /** Namespace -> what was there last time Foolscap looked. */
  watching: Record<string, Sighting>;
}

const EMPTY: WatchState = { watching: {} };

/**
 * Reading never throws.
 *
 * localStorage is absent in a server render, throws in a Safari private window,
 * and can hold whatever a previous version of this code wrote. A page that fell
 * over because a browser setting was on would be a worse page than one that
 * simply cannot remember, so every failure lands on "no history yet".
 */
export function loadWatch(): WatchState {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<WatchState>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.watching !== 'object') return EMPTY;

    // Validated on the way in rather than trusted. This is our own data, but it
    // has been sitting in a store the user can edit and a future version of
    // this file has to survive whatever an older one left.
    const watching: Record<string, Sighting> = {};
    for (const [ns, value] of Object.entries(parsed.watching ?? {})) {
      const sighting = value as Partial<Sighting>;
      if (!Array.isArray(sighting?.keys)) continue;
      if (typeof sighting.lastLookedMs !== 'number' || !Number.isFinite(sighting.lastLookedMs)) {
        continue;
      }
      watching[ns] = {
        lastLookedMs: sighting.lastLookedMs,
        keys: sighting.keys.filter((key): key is string => typeof key === 'string'),
      };
    }
    return { watching };
  } catch {
    return EMPTY;
  }
}

/** Writing never throws either. A full quota is not worth a broken page. */
export function saveWatch(state: WatchState): boolean {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function forgetAll(): boolean {
  try {
    globalThis.localStorage?.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** True where this browser will actually remember anything. */
export function storageAvailable(): boolean {
  try {
    const probe = '__foolscap_probe__';
    globalThis.localStorage?.setItem(probe, '1');
    globalThis.localStorage?.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}
