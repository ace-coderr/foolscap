// useTracker.ts — reading the rooms, on behalf of the Tracker page.
//
// Ported from the boot half of js/ui.js. The sequence and every reason for it
// are unchanged:
//
//   pass 1  the newest ~200 messages carrying the pinned DID. That is where the
//           frontier, the recent receipts and the status post live, so it is
//           everything the referee panel needs, and it paints in about a second.
//   pass 2  the rest of the backfill, in chunks, yielding between each one.
//
// Nothing is rendered as authoritative before its own signature has verified:
// ContestTracker enforces that at the data layer, and this file never reaches
// around it to read a raw message.

import { useEffect, useRef, useState } from 'react';
import { exportRoom, RoomWatcher, type ExportResult, type Gap, type Message } from './lib/technocore.ts';
import { ContestTracker, WATCHED_ROOMS, REFEREE_DID } from './lib/contest.ts';
import { plural } from './format.ts';

/**
 * Messages per poll. The read endpoint's default is 50 and its ceiling is 200,
 * and it returns the NEWEST messages after the cursor rather than the next ones
 * in order — so a burst above the cap is skipped past, not queued. Asking for
 * the maximum makes that rarer; it does not make it impossible, which is what
 * the hole recovery below is for.
 */
const POLL_LIMIT = 200;

/** Attempts to re-export a room to recover a skipped range before giving up. */
const RECOVERY_ATTEMPTS = 3;
const RECOVERY_RETRY_MS = 4000;

/** How many of the newest referee messages to verify before the first paint. */
const HEAD_SIZE = 200;
/** Messages per chunk in pass 2. Small enough to keep frames cheap. */
const CHUNK = 120;
/** Ages are relative, so repaint occasionally even when no data arrives. */
const TICK_MS = 10_000;

export type Phase = 'reading' | 'verifying-head' | 'verifying-tail' | 'following' | 'failed';

export interface Hole {
  room: string;
  from: number;
  to: number;
  state: 'recovering' | 'recovered' | 'lost';
  recovered: number;
  missing: number | null;
}

export interface TrackerState {
  ready: boolean;
  phase: Phase;
  progressText: string;
  progressFraction: number | null;
  problems: string[];
  gaps: string[];
  holes: Hole[];
  recovering: number;
}

const initialState: TrackerState = {
  ready: false,
  phase: 'reading',
  progressText: '',
  progressFraction: null,
  problems: [],
  gaps: [],
  holes: [],
  recovering: 0,
};

export interface Tracker {
  tracker: ContestTracker;
  state: TrackerState;
  /** Bumped whenever the tracker's contents change, to drive a repaint. */
  version: number;
  lostHoles: Hole[];
  lostCount: number;
}

export function useTracker(): Tracker {
  const trackerRef = useRef<ContestTracker>(null as unknown as ContestTracker);
  if (trackerRef.current === null) trackerRef.current = new ContestTracker();
  const [state, setState] = useState<TrackerState>(initialState);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let stopped = false;
    const watchers: RoomWatcher[] = [];
    const holes: Hole[] = [];

    const bump = () => {
      if (!stopped) setVersion((v) => v + 1);
    };
    const patch = (next: Partial<TrackerState>) => {
      if (!stopped) setState((prev) => ({ ...prev, ...next }));
    };
    const syncHoles = () => patch({ holes: [...holes] });

    // scheduler.yield() where the browser has it; a macrotask everywhere else.
    const scheduling = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    const yieldToPaint = (): Promise<void> =>
      typeof scheduling?.yield === 'function'
        ? scheduling.yield()
        : new Promise((resolve) => setTimeout(resolve, 0));

    const problems: string[] = [];
    const gaps: string[] = [];

    /**
     * Go back for messages a poll skipped.
     *
     * The reply cap means a burst larger than POLL_LIMIT is stepped over rather
     * than queued, and the skipped sequences sit BELOW everything that arrived
     * after them — so the only way back is a re-export, filtered to the missing
     * range. A receipt inside the hole would make Foolscap show Unanswered for a
     * request that was actually answered, which is the wrong answer to give
     * someone deciding whether to re-post.
     */
    async function recoverHole(hole: Hole) {
      setState((prev) => ({ ...prev, recovering: prev.recovering + 1 }));

      try {
        for (let attempt = 1; attempt <= RECOVERY_ATTEMPTS; attempt++) {
          if (stopped) return;
          let dump: ExportResult;
          try {
            dump = await exportRoom(hole.room);
          } catch (err) {
            problems.push(
              `${hole.room}: could not re-read to recover skipped messages — ${(err as Error).message}`
            );
            patch({ problems: [...problems] });
            break;
          }

          const inHole = dump.messages.filter((m) => m.seq >= hole.from && m.seq <= hole.to);
          if (inHole.length) {
            await trackerRef.current.ingest(inHole, hole.room);
            hole.recovered += inHole.length;
            hole.from = Math.max(hole.from, Math.max(...inHole.map((m) => m.seq)) + 1);
            bump();
          }

          if (hole.from > hole.to) {
            hole.state = 'recovered';
            syncHoles();
            return;
          }

          // Below the ring's current start it is gone, and no number of retries
          // will bring it back.
          if (dump.firstSeq != null && dump.firstSeq > hole.to) break;

          if (attempt < RECOVERY_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, RECOVERY_RETRY_MS));
          }
        }

        hole.state = 'lost';
        hole.missing = hole.to - hole.from + 1;
        syncHoles();
      } finally {
        setState((prev) => ({ ...prev, recovering: Math.max(0, prev.recovering - 1) }));
      }
    }

    function noteGap(room: string, gap: Gap) {
      if (gap.kind === 'rotated') return;

      if (gap.kind === 'regenerated') {
        gaps.push(`${room} was recreated; Foolscap restarted from the top of the new ring.`);
        patch({ gaps: [...gaps] });
        return;
      }

      const hole: Hole = {
        room,
        from: gap.expected ?? 0,
        to: (gap.firstSeq ?? 1) - 1,
        state: 'recovering',
        recovered: 0,
        missing: gap.missing,
      };
      holes.push(hole);
      syncHoles();
      void recoverHole(hole);
    }

    async function ingestChunked(messages: Parameters<ContestTracker['ingest']>[0], total: number, done: { n: number }) {
      let sinceRender = 0;
      for (let i = 0; i < messages.length; i += CHUNK) {
        if (stopped) return;
        await trackerRef.current.ingest(messages.slice(i, i + CHUNK));
        done.n = Math.min(total, done.n + CHUNK);
        sinceRender += CHUNK;

        patch({
          progressText: `Verifying the rest of the backfill — ${done.n.toLocaleString('en')} of ${total.toLocaleString('en')}`,
          progressFraction: done.n / Math.max(1, total),
        });

        if (sinceRender >= CHUNK * 6) {
          sinceRender = 0;
          bump();
        }
        await yieldToPaint();
      }
      bump();
    }

    async function boot() {
      // --- read -----------------------------------------------------------
      // In parallel: the registration ring is an order of magnitude bigger than
      // the rest put together, so reading in sequence means waiting out every
      // small room before the one that carries the frontier even starts.
      let read = 0;
      patch({ progressText: `Reading ${plural(WATCHED_ROOMS.length, 'room')}…`, progressFraction: 0 });

      const dumps = (
        await Promise.all(
          WATCHED_ROOMS.map(async (room) => {
            try {
              return await exportRoom(room);
            } catch (err) {
              problems.push(`${room}: ${(err as Error).message}`);
              return null;
            } finally {
              read++;
              patch({
                progressText: `Reading the rooms — ${read} of ${WATCHED_ROOMS.length}`,
                progressFraction: read / WATCHED_ROOMS.length,
                problems: [...problems],
              });
            }
          })
        )
      ).filter((dump): dump is ExportResult => dump !== null);

      if (stopped) return;
      if (dumps.length === 0) {
        patch({ phase: 'failed' });
        return;
      }

      // --- split ----------------------------------------------------------
      // Anything carrying the pinned DID is what the panel is built from, so it
      // is verified first. Everything else is only ever counted.
      const refereeClaims: Message[] = [];
      const rest: Message[] = [];
      for (const dump of dumps) {
        for (const message of dump.messages) {
          (message.from === REFEREE_DID ? refereeClaims : rest).push(message);
        }
      }
      refereeClaims.sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));

      const head = refereeClaims.slice(-HEAD_SIZE);
      const tail = refereeClaims.slice(0, -HEAD_SIZE);

      // --- pass 1 ---------------------------------------------------------
      patch({
        phase: 'verifying-head',
        progressText: `Verifying the newest ${head.length.toLocaleString('en')} signatures…`,
        progressFraction: 0,
      });
      await trackerRef.current.ingest(head);
      if (stopped) return;
      patch({ ready: true });
      bump();
      await yieldToPaint();

      // --- pass 2 ---------------------------------------------------------
      patch({ phase: 'verifying-tail' });
      const total = tail.length + rest.length;
      const done = { n: 0 };

      // The older referee messages first: they are the ones that can still
      // change a count. The participant backfill only deepens the queue estimate.
      await ingestChunked(tail, total, done);
      await ingestChunked(rest, total, done);
      if (stopped) return;

      patch({ phase: 'following' });
      bump();

      // --- follow ---------------------------------------------------------
      for (const dump of dumps) {
        const watcher = new RoomWatcher(dump.room, {
          since: dump.lastSeq,
          backfill: false,
          limit: POLL_LIMIT,
          onMessages: async ({ messages }) => {
            await trackerRef.current.ingest(messages, dump.room);
            bump();
          },
          onGap: (gap) => noteGap(dump.room, gap),
          onError: (err) => {
            problems.push(`${dump.room}: ${(err as Error).message}`);
            patch({ problems: [...problems] });
          },
        });
        watcher.start();
        watchers.push(watcher);
      }
    }

    void boot().catch((err) => {
      problems.push((err as Error).message);
      patch({ phase: 'failed', problems: [...problems] });
    });

    const ticker = setInterval(bump, TICK_MS);

    return () => {
      stopped = true;
      clearInterval(ticker);
      watchers.forEach((w) => w.stop());
    };
  }, []);

  const lostHoles = state.holes.filter((h) => h.state === 'lost');
  return {
    tracker: trackerRef.current,
    state,
    version,
    lostHoles,
    lostCount: lostHoles.reduce((n, h) => n + (h.missing ?? 0), 0),
  };
}
