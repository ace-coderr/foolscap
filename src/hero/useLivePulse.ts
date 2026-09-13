// useLivePulse.ts — the heartbeat behind the sphere.
//
// Two quiet rooms, one read every eight seconds, alternating: an eighth of a
// request a second, and never a burst. The City's budget with a smaller appetite,
// for the same reason — a burst is what a rate limiter notices, and this page is
// the first thing anyone loads.
//
// Every message is verified before it is allowed to light a point. That is not
// decoration: a pulse on this page means "a signed message arrived and its
// Ed25519 signature checked against its own DID, in this browser". An unverified
// message lights nothing, and a message whose signature fails lights nothing
// either — it is counted separately and never shown as life.
//
// Nothing here throws a page away. A 429 stands the reads down for minutes and
// the sphere keeps turning; the card says so, quietly, and the last count stays.

import { useEffect, useRef, useState } from 'react';
import { readRoom, TechnocoreError } from '../lib/technocore.ts';
import { verifyMessage } from '../lib/did.ts';

/**
 * The rooms the hero listens to.
 *
 * Two, both quiet. `mb-sonnet-2-discovery` runs at about a dozen messages a
 * minute — roughly one pulse every five seconds, which is a rhythm rather than a
 * flicker. `mb-sonnet-2-votes` is near-silent now and wakes when voting opens,
 * which is the moment this page most wants to be showing something.
 *
 * Not the lobby, not the registration room. Those carry a hundred messages a
 * second and would turn the sphere into noise while costing a signature check
 * for every one of them.
 */
export const LISTENING = ['mb-sonnet-2-discovery', 'mb-sonnet-2-votes'];

/** One room per tick. Two rooms, so each is read about every sixteen seconds. */
const TICK_MS = 8_000;
/** Messages per read. The reply is capped anyway; this keeps the work bounded. */
const BATCH = 25;

const BACKOFF_BASE_MS = 45_000;
const BACKOFF_MAX_MS = 300_000;

/** The card shows counts; it does not need a render per verified message. */
const REPORT_MS = 900;

export type PulseState = 'starting' | 'live' | 'quiet' | 'paused';

export interface LiveFeed {
  /** Signatures checked in this browser since the page opened. */
  verified: number;
  /** Messages that claimed a signature and did not verify. */
  failed: number;
  state: PulseState;
  /** Set while standing down after a rate limit. */
  resumeAt: number | null;
  rooms: string[];
  /**
   * Subscribe to verified messages, for the sphere.
   *
   * Deliberately not React state: a pulse is a frame's worth of animation, and
   * re-rendering the page for each one would put the whole hero through React
   * sixty times a minute for something the canvas can handle by itself.
   */
  subscribe: (listener: (count: number) => void) => () => void;
}

/** A message is worth checking only if it carries the parts of a signature. */
interface Signed {
  from: string | null;
  nonce: string | null;
  sig: string | null;
  text: string;
  room: string | null;
}

export function useLivePulse(): LiveFeed {
  const [verified, setVerified] = useState(0);
  const [failed, setFailed] = useState(0);
  const [state, setState] = useState<PulseState>('starting');
  const [resumeAt, setResumeAt] = useState<number | null>(null);

  const listeners = useRef(new Set<(count: number) => void>());
  const subscribeRef = useRef<LiveFeed['subscribe']>((listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  });

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let backoff = 0;
    let standDownUntil = 0;

    // Where each room was last left.
    const since = new Map<string, number>(LISTENING.map((room) => [room, 0]));
    // The first read of a room is a cursor, not a feed. Asked for in full it
    // returns the last twenty-five messages, which would light twenty-five
    // points at once and say "all of this just happened" about traffic that
    // took the previous few minutes. One message, so the sphere has something
    // immediately, and everything after it is genuinely while you were watching.
    const primed = new Set<string>();

    let pendingVerified = 0;
    let pendingFailed = 0;
    let lastReport = 0;
    let sawAnything = false;

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    function report(now: number, force = false) {
      if (!force && now - lastReport < REPORT_MS) return;
      lastReport = now;
      if (pendingVerified) {
        const n = pendingVerified;
        pendingVerified = 0;
        setVerified((total) => total + n);
      }
      if (pendingFailed) {
        const n = pendingFailed;
        pendingFailed = 0;
        setFailed((total) => total + n);
      }
    }

    async function tick() {
      if (stopped) return;

      if (!hidden() && Date.now() >= standDownUntil) {
        const room = LISTENING[cursor % LISTENING.length];
        cursor++;
        try {
          const first = !primed.has(room);
          const result = await readRoom(room, {
            since: since.get(room) ?? 0,
            limit: first ? 1 : BATCH,
            wait: 0,
            signal: controller.signal,
          });
          if (stopped) return;
          primed.add(room);

          // The read endpoint returns the newest messages after the cursor, so
          // advancing to lastSeq is right even when a burst was stepped over.
          // Nothing on this page counts, so a skipped message costs a pulse and
          // not a conclusion — which is why the hero can use the cheap read and
          // the Tracker cannot.
          since.set(room, Math.max(since.get(room) ?? 0, result.lastSeq));

          let lit = 0;
          for (const message of result.messages as Signed[]) {
            if (!message.sig || !message.from || message.nonce == null) continue;
            const check = await verifyMessage(message, { room });
            if (stopped) return;
            if (check.verified) lit++;
            else pendingFailed++;
          }

          if (lit) {
            pendingVerified += lit;
            sawAnything = true;
            for (const listener of listeners.current) listener(lit);
          }

          if (standDownUntil || backoff) {
            standDownUntil = 0;
            backoff = Math.floor(backoff / 2);
            setResumeAt(null);
          }
          setState(lit > 0 || sawAnything ? 'live' : 'quiet');
          report(Date.now());
        } catch (err) {
          if (stopped || isAbort(err)) return;
          // Silently, as asked. A rate limit is the server asking for less and
          // the right answer is to ask for less, not to put an error on a page
          // whose whole job is to be the first thing someone sees.
          if (err instanceof TechnocoreError && err.status === 429) {
            backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : BACKOFF_BASE_MS);
            const asked = err.retryAfter;
            standDownUntil = Date.now() + Math.max(backoff, asked != null ? asked * 1000 : 0);
            setResumeAt(standDownUntil);
            setState('paused');
          }
        }
      }

      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }

    void tick();

    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      report(Date.now(), true);
    };
  }, []);

  return { verified, failed, state, resumeAt, rooms: LISTENING, subscribe: subscribeRef.current };
}

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
