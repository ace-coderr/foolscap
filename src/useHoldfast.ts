// useHoldfast.ts — reading the board, politely.
//
// Same budget discipline as useCity, against a store with a different shape. The
// server's published ceiling is 600 reads a minute per IP (/config, rate_read).
// Holdfast takes about a tenth of it:
//
//   the listings   one request per land, every ninety seconds. This is the cheap
//                  half and it establishes the whole board — which plots exist,
//                  where each sits, who is next to whom.
//   the notes      ONE note every 400ms, round-robin over a priority order.
//                  About 150 a minute, flat and burst-free whatever the board
//                  grows to, because a bigger board makes the ROTATION longer
//                  rather than the rate higher. A burst is what a limiter
//                  notices, and Foolscap has been limited on this network once
//                  already.
//
// A full sweep of a 300-plot board therefore takes about two minutes, and the
// page says how far round it has got rather than pretending the board is
// complete. That is not an apology — the alternative is 300 requests on load,
// which is the behaviour that gets a client throttled and leaves every other
// reader of the network worse off.
//
// Nothing here throws the board away on failure. A listing that fails leaves the
// last one standing with its age showing; a note that fails keeps its previous
// reading and marks it. A plot did not stop existing because a request did.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TechnocoreError } from './lib/technocore.ts';
import { listNamespace, readNote } from './lib/kv.ts';
import { assessClaim } from './holdfast/rules.ts';
import {
  buildBoard,
  readOrder,
  splitPlotId,
  type Board,
  type NoteReading,
} from './holdfast/board.ts';
import type { Layout } from './city/districts.ts';

/**
 * The lands Holdfast watches.
 *
 * Namespaces are never enumerated by the server — there is no "list all
 * namespaces" and there is not going to be, since a namespace is created by
 * writing to it. So the board cannot be discovered; it has to be declared, and
 * this is the declaration. A plot outside these three is not in the game, however
 * legitimately somebody wrote it.
 *
 * Three rather than one because the contiguity rule stops at a land's edge, so
 * more lands means more edges, and an edge is somewhere a block cannot grow
 * through. One land would make the whole board a single line of neighbours.
 */
export const LANDS = ['holdfast', 'holdfast-reach', 'holdfast-wilds'];

/** One note read per tick. About 150 a minute — a quarter of the published ceiling. */
const NOTE_TICK_MS = 400;
const LIST_INTERVAL_MS = 90_000;

/**
 * The most plots one land can put on the board.
 *
 * A namespace holds up to 250,000 notes and the board cannot draw or read
 * anything like that: at one note per tick, even a thousand plots is a
 * three-minute sweep, and the layout stops being legible long before the
 * renderer stops coping. Measured against a real namespace — /kv/topic carries
 * 3,325 keys, 2,103 of them under one prefix — so this is not a hypothetical
 * ceiling.
 *
 * Applied in KEY ORDER, so the cut is deterministic and the board is the same
 * for everyone: the plots that are drawn are the first N of the land, and they
 * keep their neighbours. What it costs is real and the page says it — a land
 * past the cap has territory nobody can see, and a run that continues past the
 * cut is scored only as far as the cut.
 */
export const MAX_PLOTS_PER_LAND = 600;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 300_000;

/** Reclaim countdowns are relative, so the page repaints even when nothing lands. */
const CLOCK_MS = 5_000;

export type FeedState = 'starting' | 'reading' | 'backing-off' | 'failed';

interface Listing {
  keys: string[];
  /** How many the land actually has, before MAX_PLOTS_PER_LAND. */
  total: number;
  listedAt: number | null;
  error: string | null;
}

export interface HoldfastFeed {
  board: Board;
  state: FeedState;
  resumeAt: number | null;
  lastError: string | null;
  paused: boolean;
  now: number;
  /** True until every land has been listed once. The board is partial before it. */
  listing: boolean;
}

export function useHoldfast(connected: string | null): HoldfastFeed {
  const [listings, setListings] = useState<Map<string, Listing>>(() => new Map());
  const [readings, setReadings] = useState<Map<string, NoteReading>>(() => new Map());
  const [state, setState] = useState<FeedState>('starting');
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /**
   * The order to read notes in, and the cursor into it.
   *
   * A ref, not state. The order is recomputed from the board on every render and
   * the loop reads whatever is current when its timer fires; putting it in state
   * would restart the effect on every note that landed, which is 150 a minute.
   */
  const orderRef = useRef<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let cursor = 0;
    let backoff = 0;
    let standDownUntil = 0;
    let noteTimer: ReturnType<typeof setTimeout> | undefined;
    /** One timer per land, so a single land can be re-fired without the others. */
    const listTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** When each land was last ASKED for, successfully or not. */
    const attempted = new Map<string, number>();
    const listed = new Set<string>();

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    function standDown(err: unknown): boolean {
      const limited = err instanceof TechnocoreError && err.status === 429;
      if (!limited) return false;
      const asked = (err as TechnocoreError).retryAfter;
      backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : BACKOFF_BASE_MS);
      const wait = Math.max(backoff, asked != null ? asked * 1000 : 0);
      standDownUntil = Date.now() + wait;
      setResumeAt(standDownUntil);
      setState('backing-off');
      return true;
    }

    function recovered() {
      if (standDownUntil === 0 && backoff === 0) return;
      standDownUntil = 0;
      backoff = Math.floor(backoff / 2);
      setResumeAt(null);
      setState('reading');
    }

    // --- the listings -------------------------------------------------------

    async function listOne(ns: string): Promise<void> {
      if (stopped) return;
      if (!hidden() && Date.now() >= standDownUntil) {
        attempted.set(ns, Date.now());
        try {
          const all = await listNamespace(ns, { signal: controller.signal });
          if (stopped) return;
          listed.add(ns);
          setListings((previous) => {
            const next = new Map(previous);
            next.set(ns, {
              keys: all.slice(0, MAX_PLOTS_PER_LAND),
              total: all.length,
              listedAt: Date.now(),
              error: null,
            });
            return next;
          });
          recovered();
          setState((current) => (current === 'starting' ? 'reading' : current));
        } catch (err) {
          if (stopped || isAbort(err)) return;
          const message = (err as Error).message;
          setLastError(message);
          setListings((previous) => {
            const next = new Map(previous);
            const held = previous.get(ns);
            // Keep the keys already known and mark the land failing. Blanking
            // them would take everybody's territory off the board to report that
            // one request did not come back.
            next.set(
              ns,
              held ? { ...held, error: message } : { keys: [], total: 0, listedAt: null, error: message }
            );
            return next;
          });
          if (!standDown(err)) setState((current) => (current === 'starting' ? 'failed' : current));
        }
      }
      if (!stopped) listTimers.set(ns, setTimeout(() => void listOne(ns), LIST_INTERVAL_MS));
    }

    // --- the notes ----------------------------------------------------------

    async function readOne(): Promise<void> {
      if (stopped) return;

      const backgrounded = hidden();
      setPaused(backgrounded);

      const order = orderRef.current;
      if (!backgrounded && order.length > 0 && Date.now() >= standDownUntil) {
        if (cursor >= order.length) cursor = 0;
        const id = order[cursor];
        cursor++;
        const split = splitPlotId(id);
        if (split) {
          try {
            const value = await readNote(split.ns, split.key, { signal: controller.signal });
            if (stopped) return;
            // The signature is checked here, on the reader's machine, before the
            // holder is written down anywhere. Nothing downstream ever sees an
            // unverified claim as a holder — see SHELL.md: never render a status
            // computed from unverified data.
            const holding = await assessClaim(split.ns, split.key, value, Date.now());
            if (stopped) return;
            setReadings((previous) => {
              const next = new Map(previous);
              next.set(id, { value, holding, readAt: Date.now(), error: null });
              return next;
            });
            recovered();
          } catch (err) {
            if (stopped || isAbort(err)) return;
            const message = (err as Error).message;
            setLastError(message);
            setReadings((previous) => {
              const held = previous.get(id);
              if (!held) return previous;
              const next = new Map(previous);
              next.set(id, { ...held, error: message });
              return next;
            });
            standDown(err);
          }
        }
      }

      if (!stopped) noteTimer = setTimeout(() => void readOne(), NOTE_TICK_MS);
    }

    // Every land listed at once on load, a quarter second apart.
    //
    // This was a ninety-second stagger, so that the three listings never went
    // out together. Which it achieved, and the cost was a page that said
    // "reading the board" for a full minute while two thirds of the board did
    // not exist — a burst-avoidance measure applied to the one moment where
    // three requests is obviously fine. Each land re-lists ninety seconds after
    // its own read completes, so they stay a quarter second apart for ever
    // without the first pass paying for it.
    LANDS.forEach((ns, i) => {
      listTimers.set(ns, setTimeout(() => void listOne(ns), i * 250));
    });
    void readOne();

    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    const onVisible = () => {
      if (hidden()) return;
      setPaused(false);
      setNow(Date.now());

      // THE LISTINGS DO NOT PICK THEMSELVES UP, and the notes do.
      //
      // A note read is retried every 400ms, so a tab that comes forward is
      // reading again almost at once. A listing reschedules itself ninety
      // seconds out whether or not it actually ran — so a page opened in a
      // background tab had ASKED for its lands, been refused by the visibility
      // check, and booked its retry for a minute and a half later. Switch to
      // that tab and you get an empty board saying it is reading, for ninety
      // seconds, with no request in flight. The City has this handler for the
      // same reason and it is the same fix: ask now for whatever is owed.
      if (Date.now() < standDownUntil) return;
      for (const ns of LANDS) {
        const last = attempted.get(ns) ?? 0;
        if (listed.has(ns) && Date.now() - last < LIST_INTERVAL_MS) continue;
        clearTimeout(listTimers.get(ns));
        void listOne(ns);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(noteTimer);
      for (const timer of listTimers.values()) clearTimeout(timer);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Held while the set of plots is unchanged. A plot that moved between two
  // reads would take its neighbours' meaning with it, and adjacency is scored.
  const layoutRef = useRef<{ key: string; layout: Layout } | null>(null);

  const board = useMemo(() => {
    const complete: Map<string, Listing> = new Map();
    for (const ns of LANDS) complete.set(ns, listings.get(ns) ?? { keys: [], total: 0, listedAt: null, error: null });

    const built = buildBoard({ listings: complete, readings, connected, now, layout: layoutRef.current?.layout });
    const key = built.plots.map((plot) => plot.room).join('\n');
    if (layoutRef.current?.key !== key) {
      const fresh = buildBoard({ listings: complete, readings, connected, now });
      layoutRef.current = { key, layout: fresh.layout };
      return fresh;
    }
    return built;
  }, [listings, readings, connected, now]);

  const order = useMemo(() => readOrder(board, connected), [board, connected]);
  // In an effect rather than assigned during render: the loop reads this from a
  // timer, so being one commit behind costs nothing, and writing a ref while
  // rendering is the kind of thing that works until it is rendered twice.
  useEffect(() => {
    orderRef.current = order;
  }, [order]);

  return {
    board,
    state,
    resumeAt,
    lastError,
    paused,
    now,
    listing: LANDS.some((ns) => listings.get(ns)?.listedAt == null && listings.get(ns)?.error == null),
  };
}

/**
 * A plot's note, read on demand.
 *
 * The rotation gets round to every plot eventually, and "eventually" is minutes.
 * When a visitor opens one plot they are asking about that plot now, so it is
 * read now — one request, off the back of an interaction rather than a timer,
 * which is the one kind of read a rate limiter has never objected to.
 */
export function usePlotRefresh(): {
  refresh: (id: string) => Promise<NoteReading | null>;
  busy: string | null;
} {
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (id: string): Promise<NoteReading | null> => {
    const split = splitPlotId(id);
    if (!split) return null;
    setBusy(id);
    try {
      const value = await readNote(split.ns, split.key);
      const holding = await assessClaim(split.ns, split.key, value, Date.now());
      return { value, holding, readAt: Date.now(), error: null };
    } catch (err) {
      return {
        value: null,
        holding: { claim: null, fault: null, heldMs: null, reclaimInMs: 0, reclaimExact: false },
        readAt: Date.now(),
        error: (err as Error).message,
      };
    } finally {
      setBusy(null);
    }
  }, []);

  return { refresh, busy };
}

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
