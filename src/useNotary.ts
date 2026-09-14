// useNotary.ts — the two sources behind the Notary page, deliberately apart.
//
// LIVE is the rings, read in this browser, exactly as every other page reads
// them: signatures checked here, nothing trusted from a server. It can only see
// what the rings still hold, which for a busy room is minutes.
//
// ARCHIVE is the Notary API. It reaches back to whenever capture started and no
// further, it has recorded holes, and its timestamps are Notary's claim rather
// than something this browser watched happen.
//
// They are never merged into one number. A combined "first seen" would be a
// figure with two different epistemic statuses inside it, and the reader could
// not tell which half they were leaning on — which is the whole thing this page
// exists to make clear. Two answers, two labels, and the page says what each one
// can and cannot support.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readRoom, TechnocoreError, type Message } from './lib/technocore.ts';
import { looksLikeDid, verifyMessage } from './lib/did.ts';
import { NOTARY_DID } from './lib/notary.ts';

// ---------------------------------------------------------------------------
// Where the archive lives
// ---------------------------------------------------------------------------

/**
 * The API's origin, set at build time.
 *
 * Empty is a real state, not an error to paper over: the static site deploys
 * fine without an archive behind it, and when it does the page says the archive
 * is not reachable rather than rendering an empty result that would read as
 * "this DID has no history".
 */
export const NOTARY_API = (import.meta.env?.VITE_NOTARY_API ?? '').replace(/\/+$/, '');

export const archiveConfigured = (): boolean => NOTARY_API.length > 0;

// ---------------------------------------------------------------------------
// Shapes, mirroring services/notary/src/archive.ts
// ---------------------------------------------------------------------------

export type CutoffAnswer = 'witnessed' | 'claimed' | 'no-evidence';

export interface ArchiveGap {
  id: string;
  room: string;
  /** 'missed' and 'downtime' are loss; 'rotated' marks where coverage begins. */
  kind: 'missed' | 'downtime' | 'regenerated' | 'rotated';
  missing: number | null;
  recovered: number;
  lost: number;
  noticedAt: string;
}

export interface Coverage {
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  earliestSourceTs: string | null;
  latestSourceTs: string | null;
  records: number;
  dids: number;
  rooms: number;
  submitted: number;
  staleSeconds: number | null;
  /** The largest accountable holes, not all of them. `gapsTotal` is how many exist. */
  gaps: ArchiveGap[];
  gapsTotal: number;

  // The three categories, never added together. See services/notary/src/archive.ts.
  /** Lines that rotated past while the mirror was reading the room. */
  lostMissed: number;
  /** Lines that went past while the mirror was not running at all. */
  lostDowntime: number;
  /** lostMissed + lostDowntime. What Notary was responsible for and did not capture. */
  lostMessages: number;
  /**
   * Rooms Notary first looked at after their ring had already turned. A COUNT
   * OF ROOMS, never of messages: how much history each had behind it is not
   * knowable, and summing the 'rotated' rows' own numbers is what overstated
   * this archive's loss forty-fold.
   */
  roomsBegunMidRing: number;
  /** The rooms the mirror follows — all of them completely. Named on the page. */
  roomsWatched: string[];
  /** Hours of full records kept. Past it: the summary tier plus pinned originals. */
  retainHours: number;
  pinsEarliest: boolean;
  roomsCovered: Array<{ room: string; policy: 'full' | 'sightings'; records: number }>;
  caveat: string;
}

export interface ArchiveRecord {
  id: string;
  room: string;
  nonce: string;
  sig: string;
  text: string;
  capturedAt: string;
  sourceTs: string | null;
  sourceSeq: string | null;
  sighting: 'first' | 'last' | null;
  source: 'submitted' | 'mirrored';
}

export interface Anchor {
  day: string;
  root: string | null;
  recordCount: number | null;
  publishedSeq: string | null;
  publishedAt: string | null;
  firstCapture: string | null;
  lastCapture: string | null;
}

export interface AnchorLog {
  /** What the API says its key is. Compared against the pinned one, never trusted. */
  notary_did: string;
  can_sign: boolean;
  signing_problem: string | null;
  anchor_room: string;
  anchors: Anchor[];
  unpublished: number;
}

/**
 * The anchor log, and the one check that matters about it.
 *
 * `matchesPinned` is false when the API reports a different DID than the client
 * pins. That is not a cosmetic mismatch: roots signed by an unpinned key are
 * roots this page cannot vouch for, and saying so is the difference between a
 * tamper-evident archive and one that merely claims to be.
 */
export function useAnchors(): Async<AnchorLog & { matchesPinned: boolean; pinned: string }> {
  const [state, setState] = useState<Async<AnchorLog & { matchesPinned: boolean; pinned: string }>>(
    archiveConfigured() ? { phase: 'loading' } : { phase: 'idle' }
  );

  useEffect(() => {
    if (!archiveConfigured()) return;
    const abort = new AbortController();
    getJson<AnchorLog>('/api/notary/anchors', abort.signal)
      .then((value) =>
        setState({
          phase: 'ready',
          value: { ...value, pinned: NOTARY_DID, matchesPinned: value.notary_did === NOTARY_DID },
        })
      )
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setState({ phase: 'failed', error: err.message });
      });
    return () => abort.abort();
  }, []);

  return state;
}

export interface Cutoff {
  before: string;
  answer: CutoffAnswer;
  witnessedBefore: string | null;
  claimedBefore: string | null;
  evidenceRecordId: string | null;
  caveat: string;
}

/**
 * What the permanent tier says about one (did, room) pair.
 *
 * A second source, never a correction to the first. The record figures beside
 * it are counted from originals Notary still holds; these are counted from
 * originals it held and deleted. Served apart and shown apart, the same way
 * live and archive are — a reader has to know which they are leaning on.
 */
export interface SummaryRow {
  room: string;
  firstCapturedAt: string;
  firstSourceTs: string | null;
  lastCapturedAt: string;
  lastSourceTs: string | null;
  messageCount: number;
  pinnedRecordId: string | null;
  /** True where the tier stands for messages no longer held whole. */
  prunedBehind: boolean;
}

export interface DidReport {
  did: string;
  totalRecords: number;
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  firstSourceTs: string | null;
  lastSourceTs: string | null;
  rooms: Array<{
    room: string;
    policy: 'full' | 'sightings';
    records: number;
    sampled: boolean;
    firstSourceTs: string | null;
    lastSourceTs: string | null;
  }>;
  days: Array<{ day: string; records: number }>;
  earliest: ArchiveRecord[];
  /** The permanent tier, per room. Shown only where it says more than the records. */
  summary: SummaryRow[];
  cutoff: Cutoff | null;
  coverage: Coverage;
  caveat: string;
}

type Async<T> =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'failed'; error: string };

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${NOTARY_API}${path}`, { signal, headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `The archive answered ${res.status}.`);
  return body as T;
}

// ---------------------------------------------------------------------------
// Coverage — fetched before anything is typed
// ---------------------------------------------------------------------------

/**
 * Loaded on mount, not on lookup.
 *
 * The limits of the archive are not a footnote to a result; they are the frame
 * the result is read inside. A reader who types a DID and sees "nothing found"
 * without already knowing that capture began on a particular evening at a
 * particular minute has been misled by omission.
 */
export function useCoverage(): Async<Coverage> {
  const [state, setState] = useState<Async<Coverage>>(
    archiveConfigured() ? { phase: 'loading' } : { phase: 'failed', error: 'No archive is configured for this build.' }
  );

  useEffect(() => {
    if (!archiveConfigured()) return;
    const abort = new AbortController();
    getJson<Coverage>('/api/notary/coverage', abort.signal)
      .then((value) => setState({ phase: 'ready', value }))
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setState({ phase: 'failed', error: err.message });
      });
    return () => abort.abort();
  }, []);

  return state;
}

// ---------------------------------------------------------------------------
// The archive, for one DID
// ---------------------------------------------------------------------------

export function useArchive(): {
  state: Async<DidReport>;
  lookup: (did: string, before: string | null) => void;
  clear: () => void;
} {
  const [state, setState] = useState<Async<DidReport>>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const lookup = useCallback((did: string, before: string | null) => {
    abortRef.current?.abort();
    if (!archiveConfigured()) {
      setState({ phase: 'failed', error: 'No archive is configured for this build.' });
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    setState({ phase: 'loading' });

    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    getJson<DidReport>(`/api/notary/did/${encodeURIComponent(did)}${query}`, abort.signal)
      .then((value) => setState({ phase: 'ready', value }))
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setState({ phase: 'failed', error: err.message });
      });
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setState({ phase: 'idle' });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { state, lookup, clear };
}

// ---------------------------------------------------------------------------
// The rings, read here
// ---------------------------------------------------------------------------

/**
 * Rooms scanned in the browser.
 *
 * Six, and the heads only. This is a lookup a person triggers, not a poll, so
 * the cost is bounded by how often somebody presses the button — but a scan
 * that hit every mirrored room would be thirteen reads in a burst, which is
 * precisely the shape a rate limiter notices. These six are where identity
 * traffic actually lands.
 */
export const LIVE_ROOMS = [
  'mb-sonnet-2-registration',
  'mb-sonnet-2-discovery',
  'mb-sonnet-2-votes',
  'technocore',
  'flop-network',
  'lobby',
];

/** Messages per room. The read endpoint caps at 200 and returns the newest. */
const LIVE_BATCH = 200;
/** Between rooms. Never a burst — six reads spread over about a second and a half. */
const LIVE_SPACING_MS = 250;

export interface LiveHit {
  room: string;
  seq: number;
  ts: string | null;
  tsMs: number;
  text: string;
  nonce: string | null;
  sig: string | null;
}

export interface LiveResult {
  /** Rooms actually read. A 429 or an error leaves a room out, and it is named. */
  roomsRead: string[];
  roomsFailed: Array<{ room: string; reason: string }>;
  /** Verified messages from this DID, newest first. */
  hits: LiveHit[];
  /** Messages that claimed to be from this DID and did NOT verify. */
  forged: number;
  /**
   * The oldest message still in each room read, so the page can say how far back
   * "recent" actually reaches — which is the only honest bound on a live miss.
   */
  horizon: Array<{ room: string; oldest: string | null }>;
  scannedAt: number;
}

export function useLive(): {
  state: Async<LiveResult>;
  scan: (did: string) => void;
  clear: () => void;
} {
  const [state, setState] = useState<Async<LiveResult>>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const scan = useCallback((did: string) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setState({ phase: 'loading' });

    void (async () => {
      const roomsRead: string[] = [];
      const roomsFailed: Array<{ room: string; reason: string }> = [];
      const horizon: Array<{ room: string; oldest: string | null }> = [];
      const hits: LiveHit[] = [];
      let forged = 0;

      for (const room of LIVE_ROOMS) {
        if (abort.signal.aborted) return;
        try {
          const { messages } = await readRoom(room, { limit: LIVE_BATCH, signal: abort.signal });
          roomsRead.push(room);
          horizon.push({ room, oldest: oldestTs(messages) });

          // Filter first, verify second. Verifying two hundred signatures to
          // find the handful from one DID would cost a second of main thread
          // per room for no additional certainty.
          for (const message of messages.filter((m) => m.from === did)) {
            const check = await verifyMessage(message, { room });
            if (check.verified) {
              hits.push({
                room,
                seq: message.seq,
                ts: message.ts,
                tsMs: message.tsMs,
                text: message.text,
                nonce: message.nonce,
                sig: message.sig,
              });
            } else {
              // Someone else's message wearing this DID. Counted, never shown
              // as activity: that is the difference between this page and a
              // room viewer.
              forged++;
            }
          }
        } catch (err) {
          if (abort.signal.aborted) return;
          const reason =
            err instanceof TechnocoreError && err.status === 429
              ? 'rate limited'
              : err instanceof Error
                ? err.message
                : 'unreadable';
          roomsFailed.push({ room, reason });
        }
        await sleep(LIVE_SPACING_MS, abort.signal);
      }

      if (abort.signal.aborted) return;
      hits.sort((a, b) => b.tsMs - a.tsMs);
      setState({ phase: 'ready', value: { roomsRead, roomsFailed, hits, forged, horizon, scannedAt: Date.now() } });
    })();
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setState({ phase: 'idle' });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { state, scan, clear };
}

function oldestTs(messages: Message[]): string | null {
  let oldest: Message | null = null;
  for (const message of messages) {
    if (!oldest || message.tsMs < oldest.tsMs) oldest = message;
  }
  return oldest?.ts ?? null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------

export { looksLikeDid };
