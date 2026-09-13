// useCity.ts — reading the network for the City, politely.
//
// Polling thirteen rooms at full rate is what got Foolscap rate-limited once
// already, so the budget here is deliberate and small:
//
//   the survey   one request every three minutes, not cache-busted, so the edge
//                answers most of them and the origin sees almost nothing.
//   the watch    ONE room every four seconds, round-robin. Eight rooms means each
//                is read about every half minute, and the request rate is a flat
//                quarter per second that never bursts, however many rooms are
//                added. A burst is what a rate limiter notices.
//
// That is roughly 0.26 requests a second, all of it half-kilobyte reads. It stops
// entirely when the tab is hidden, and on a 429 it stands down for minutes rather
// than retrying into a limiter that is already saying no.
//
// Nothing here throws a page away on failure. A read that fails leaves the last
// good reading in place with its age on it, which is the honest thing to show:
// the room did not stop existing because Foolscap could not reach it.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  readHead,
  readRoomsIndex,
  TechnocoreError,
  type RoomsIndex,
} from './lib/technocore.ts';
import { ROOMS } from './lib/contest.ts';
import { buildCity, type City, type Reading } from './city/model.ts';
import type { Layout } from './city/districts.ts';

/**
 * The rooms Foolscap reads directly.
 *
 * Eight, and each one earns its place. Two are the contest rooms this whole tool
 * exists for and neither appears in the survey — the survey lists the busiest
 * fifty of some forty thousand rooms, and a contest that has been running two
 * days is not among them. Four are the busiest general rooms, so the headline
 * rate means something. Two are the rooms where signed protocol traffic lives.
 *
 * Adding to this list costs a longer rotation, not a higher request rate. That is
 * the property worth keeping: the ceiling is a request every four seconds no
 * matter how long the list gets.
 */
export const WATCHED = [
  ROOMS.registration,
  ROOMS.rules,
  'lobby',
  'technocore',
  'meta',
  'kibble',
  'flop-network',
  'tclk-offers',
];

/** One room read per tick. */
const WATCH_TICK_MS = 4_000;
const SURVEY_INTERVAL_MS = 180_000;

/** Rate is measured over a window, not between two adjacent reads. */
const RATE_WINDOW_MS = 300_000;
/** Too short a span makes a rate that is mostly rounding. */
const RATE_MIN_SPAN_MS = 20_000;

/** First stand-down after a rate limit, doubling to the ceiling. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 300_000;

/** Ages on the page are relative, so it repaints even when no data arrives. */
const CLOCK_MS = 5_000;

export type FeedState = 'starting' | 'reading' | 'backing-off' | 'failed';

export interface CityFeed {
  city: City;
  survey: RoomsIndex | null;
  /** Null until the first survey lands; set if it could not be read at all. */
  surveyError: string | null;
  state: FeedState;
  /** Set while standing down after a rate limit. */
  resumeAt: number | null;
  /** The most recent read failure, whatever it was. */
  lastError: string | null;
  /** True when the tab is in the background and Foolscap has stopped reading. */
  paused: boolean;
  now: number;
}

interface Sample {
  seq: number;
  at: number;
}

export function useCity(): CityFeed {
  const [survey, setSurvey] = useState<RoomsIndex | null>(null);
  const [surveyError, setSurveyError] = useState<string | null>(null);
  const [readings, setReadings] = useState<Map<string, Reading>>(() => new Map());
  const [state, setState] = useState<FeedState>('starting');
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Per-room samples, for the rate. Not state: they drive a derived number and
  // re-rendering on every push would be a render per read for no visible change.
  const samplesRef = useRef<Map<string, Sample[]>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let cursor = 0;
    let backoff = 0;
    let standDownUntil = 0;
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    let surveyTimer: ReturnType<typeof setTimeout> | undefined;
    let haveSurvey = false;
    let surveyAttemptedAt = 0;

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    /**
     * A rate limit is the server asking for less, so take it at its word: stand
     * every read down, not just the one that was refused, and double the wait
     * each time it happens again. `retry-after` wins over the local schedule when
     * the server names a time.
     */
    function standDown(err: unknown) {
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
      // Decay rather than reset: a limiter that just let one request through has
      // not necessarily forgiven the burst that tripped it.
      backoff = Math.floor(backoff / 2);
      setResumeAt(null);
      setState('reading');
    }

    // --- the survey ---------------------------------------------------------

    async function takeSurvey() {
      if (stopped) return;
      if (!hidden() && Date.now() >= standDownUntil) {
        surveyAttemptedAt = Date.now();
        try {
          const index = await readRoomsIndex({ signal: controller.signal });
          if (stopped) return;
          haveSurvey = true;
          setSurvey(index);
          setSurveyError(null);
          recovered();
        } catch (err) {
          if (stopped || isAbort(err)) return;
          const message = (err as Error).message;
          setLastError(message);
          // Only the first failure is fatal to the survey — after that there is a
          // previous one on screen, and replacing it with an error would throw
          // away the map to report a hiccup.
          if (!haveSurvey) setSurveyError(message);
          standDown(err);
        }
      }
      if (!stopped) surveyTimer = setTimeout(takeSurvey, SURVEY_INTERVAL_MS);
    }

    // --- the watch ----------------------------------------------------------

    function rateFor(room: string, seq: number, at: number): Pick<Reading, 'ratePerMin' | 'rateSpanMs'> {
      const samples = samplesRef.current.get(room) ?? [];
      samples.push({ seq, at });
      // Keep the window, and always at least the two a rate needs.
      while (samples.length > 2 && at - samples[0].at > RATE_WINDOW_MS) samples.shift();
      samplesRef.current.set(room, samples);

      const first = samples[0];
      const span = at - first.at;
      if (samples.length < 2 || span < RATE_MIN_SPAN_MS) return { ratePerMin: null, rateSpanMs: null };
      return { ratePerMin: ((seq - first.seq) / span) * 60_000, rateSpanMs: span };
    }

    async function readOne() {
      if (stopped) return;

      const backgrounded = hidden();
      setPaused(backgrounded);

      if (!backgrounded && Date.now() >= standDownUntil) {
        const room = WATCHED[cursor % WATCHED.length];
        cursor++;
        try {
          const head = await readHead(room, { signal: controller.signal });
          if (stopped) return;
          const rate = rateFor(room, head.lastSeq, head.readAt);
          setReadings((previous) => {
            const next = new Map(previous);
            next.set(room, {
              room,
              lastSeq: head.lastSeq,
              newestTsMs: head.newest?.tsMs || null,
              readAt: head.readAt,
              error: null,
              ...rate,
            });
            return next;
          });
          recovered();
          setState((current) => (current === 'starting' ? 'reading' : current));
        } catch (err) {
          if (stopped || isAbort(err)) return;
          const message = (err as Error).message;
          setLastError(message);
          setReadings((previous) => {
            const next = new Map(previous);
            const held = previous.get(room);
            // Keep the last good figures and mark them failing. Blanking them
            // would say the room went silent, which is not what was observed.
            next.set(
              room,
              held
                ? { ...held, error: message }
                : {
                    room,
                    lastSeq: 0,
                    newestTsMs: null,
                    readAt: Date.now(),
                    ratePerMin: null,
                    rateSpanMs: null,
                    error: message,
                  }
            );
            return next;
          });
          if (!standDown(err)) {
            setState((current) => (current === 'starting' ? 'failed' : current));
          }
        }
      }

      if (!stopped) watchTimer = setTimeout(readOne, WATCH_TICK_MS);
    }

    void takeSurvey();
    void readOne();

    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    const onVisible = () => {
      if (hidden()) return;
      setPaused(false);
      setNow(Date.now());
      // The watch picks itself up on its next tick, four seconds away. The survey's
      // tick is three minutes, so a tab that was in the background when the survey
      // was due would sit there with no map. Ask for one now instead.
      const owed = !haveSurvey || Date.now() - surveyAttemptedAt >= SURVEY_INTERVAL_MS;
      if (owed && Date.now() >= standDownUntil) {
        clearTimeout(surveyTimer);
        void takeSurvey();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(watchTimer);
      clearTimeout(surveyTimer);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // The layout is held for as long as the set of rooms is unchanged; see the
  // note on BuildInput.layout for why it must not be recomputed on every read.
  const layoutRef = useRef<{ key: string; layout: Layout } | null>(null);

  const city = useMemo(() => {
    const built = buildCity({
      survey: survey?.rooms ?? [],
      readings,
      watched: WATCHED,
      now,
      layout: layoutRef.current?.layout,
    });

    const key = built.rooms
      .map((room) => room.room)
      .sort()
      .join('\n');
    if (layoutRef.current?.key !== key) {
      // A room appeared or went: lay the city out again, then rebuild on it so
      // this render already has the new positions.
      const fresh = buildCity({ survey: survey?.rooms ?? [], readings, watched: WATCHED, now });
      layoutRef.current = { key, layout: fresh.layout };
      return fresh;
    }
    return built;
  }, [survey, readings, now]);

  return { city, survey, surveyError, state, resumeAt, lastError, paused, now };
}

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
