// useLens.ts — one room, read and checked.
//
// The reading half is RoomWatcher's, unchanged: it backfills from /export, then
// follows with limit=200 long polls, and reports a hole when the ring rotated
// past it. That client is written, tested and already in use on the Tracker, so
// this file drives it rather than reimplementing it.
//
// What this file adds is the checking, and the order it happens in. A batch
// arrives, is merged by sequence number, and every message in it is verified
// before its verdict reaches the page — but the MESSAGE reaches the page
// immediately, marked as still being checked. The alternative is a room that
// stays blank until thousands of Ed25519 verifications finish, which is
// indistinguishable from a page that has hung.
//
// A HOLE IS NOT A VERDICT. When lines rotate out before Foolscap reads them,
// the messages that went past are not unverified — they are absent, and nothing
// can be said about them at all. They are reported separately and never counted
// into the tally, because "412 of 500 verified" is a different claim from
// "88 messages are gone and 412 of what is left verified".

import { useEffect, useRef, useState } from 'react';
import { RoomWatcher, ROOM_RE, type Gap, type Message, type WatcherStatus } from './lib/technocore.ts';
import { read, tally, windowOf, type Reading, type Tally, type Window } from './lib/lens.ts';

/**
 * How many messages the pane keeps.
 *
 * A busy room's export runs to tens of thousands of lines and a DOM that size
 * is a page nobody can scroll. The cap is on what is HELD, not on what is
 * checked: everything that arrives is verified on the way past and counted, and
 * only then does the oldest fall out of the list. So the header's figures cover
 * the whole read even when the pane shows the newest few hundred of it, and a
 * failure is never dropped — see `failures`, which is kept whole.
 */
export const KEEP = 400;

export interface LensFeed {
  messages: Message[];
  readings: Map<number, Reading>;
  counts: Tally;
  /** Every failure seen, whether or not it is still inside KEEP. */
  failures: Message[];
  window: Window;
  status: WatcherStatus['state'];
  gaps: Gap[];
  error: string | null;
  /** Messages checked so far across the whole read, including any dropped. */
  checked: number;
  /** Total seen across the whole read, including messages dropped from the list. */
  seen: number;
}

const EMPTY: LensFeed = {
  messages: [],
  readings: new Map(),
  counts: { total: 0, verified: 0, unsigned: 0, failed: 0, read: 0 },
  failures: [],
  window: { firstSeq: null, lastSeq: null, oldestMs: null, newestMs: null, spanMs: null },
  status: 'stopped',
  gaps: [],
  error: null,
  checked: 0,
  seen: 0,
};

export interface LensOptions {
  /**
   * Whether to pull the whole retained ring before following.
   *
   * TRUE IS RIGHT FOR /lens AND WRONG FOR THE CITY. The Lens exists to let
   * somebody read a room properly, and a room's history is the thing they came
   * for — so it backfills from /export, which on a busy room is the five-to-ten
   * megabyte download /retention exists to warn about.
   *
   * The City's live view is a glance at what is ARRIVING. Backfilling there
   * would spend several megabytes to show a reader messages from before they
   * clicked, on a page they are passing through, and the first thing they would
   * see is a long wait — which is what it did, before this option existed.
   * Following from the head costs half a kilobyte a poll.
   */
  backfill?: boolean;
}

export function useLens(room: string | null, { backfill = true }: LensOptions = {}): LensFeed {
  const [feed, setFeed] = useState<LensFeed>(EMPTY);

  /**
   * Running totals over the WHOLE read, including messages that have since
   * fallen out of the kept list. In a ref because they are written on every
   * batch and read only when a render is already happening for another reason.
   */
  const totals = useRef({ verified: 0, unsigned: 0, failed: 0, seen: 0 });

  useEffect(() => {
    setFeed(EMPTY);
    totals.current = { verified: 0, unsigned: 0, failed: 0, seen: 0 };
    if (!room || !ROOM_RE.test(room)) return;

    let stopped = false;
    const controller = new AbortController();
    const kept = new Map<number, Message>();
    const readings = new Map<number, Reading>();
    const failures = new Map<number, Message>();

    const publish = () => {
      if (stopped) return;
      const messages = [...kept.values()].sort((a, b) => a.seq - b.seq);
      const counted = tally(messages, readings);
      setFeed((previous) => ({
        ...previous,
        messages,
        readings: new Map(readings),
        counts: {
          ...counted,
          // The header speaks for the whole read, not for the window. A room
          // showing its newest 400 of 9,000 has still checked 9,000.
          total: totals.current.seen,
          verified: totals.current.verified,
          unsigned: totals.current.unsigned,
          failed: totals.current.failed,
          read: totals.current.verified + totals.current.unsigned + totals.current.failed,
        },
        failures: [...failures.values()].sort((a, b) => a.seq - b.seq),
        window: windowOf(messages),
        checked: totals.current.verified + totals.current.unsigned + totals.current.failed,
        seen: totals.current.seen,
      }));
    };

    const watcher = new RoomWatcher(room, {
      limit: 200,
      backfill,
      onStatus: (status) => {
        if (!stopped) setFeed((previous) => ({ ...previous, status: status.state }));
      },
      onGap: (gap) => {
        // Reported, never folded into the counts. A rotated line is absent, and
        // absence is not a verdict.
        if (!stopped) setFeed((previous) => ({ ...previous, gaps: [...previous.gaps, gap] }));
      },
      onError: (err) => {
        if (!stopped) {
          setFeed((previous) => ({ ...previous, error: (err as Error)?.message ?? String(err) }));
        }
      },
      onMessages: ({ messages }) => {
        if (stopped || messages.length === 0) return;
        for (const message of messages) {
          if (kept.has(message.seq)) continue;
          kept.set(message.seq, message);
        }
        // Show them now, checked or not. The verdicts follow within a frame or
        // two and the page marks the difference rather than hiding the room.
        publish();

        void (async () => {
          for (const message of messages) {
            if (stopped || controller.signal.aborted) return;
            if (readings.has(message.seq)) continue;
            const reading = await read(message, room);
            if (stopped) return;
            readings.set(message.seq, reading);
            totals.current.seen++;
            totals.current[reading.verdict]++;
            if (reading.verdict === 'failed') failures.set(message.seq, message);
          }
          // Trim only after checking, so nothing falls out uncounted.
          if (kept.size > KEEP) {
            const order = [...kept.keys()].sort((a, b) => a - b);
            for (const seq of order.slice(0, kept.size - KEEP)) {
              // A failure stays in `failures` whatever happens to the list.
              kept.delete(seq);
            }
          }
          publish();
        })();
      },
    });

    void watcher.start();

    return () => {
      stopped = true;
      controller.abort();
      watcher.stop();
    };
  }, [room, backfill]);

  return feed;
}
