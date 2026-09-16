// useRetention.ts — the four-step measurement, as a state machine.
//
// probe → probed → (confirm) → exporting → measured
//
// THE STOP IN THE MIDDLE IS THE DESIGN. Between `probed` and `exporting` the
// page waits for the reader to agree, because the second half of this
// measurement is a multi-megabyte download and nothing in the API will say how
// big before it starts. The estimate shown at that moment comes from the survey,
// which matched a real export to the byte on a quiet room and came in about a
// fifth under on a busy one — and whose message count was tens of thousands
// behind on the same read. Both facts are on the page; neither is allowed to be
// a rounding of the other.
//
// EVERY READ IS ABORTABLE and every one of them is aborted on unmount or on a
// new measurement. A ten-second probe and a ten-megabyte export are both long
// enough for a reader to change their mind, and a fetch nobody is waiting for is
// a fetch that will still call setState on a component that has gone.
//
// NOTHING IS STORED. SHELL.md allows two exceptions to the no-storage rule and
// this is not one of them: measurements last as long as the visit, and a table
// that survived a reload would be presenting yesterday's reading of a room whose
// rate has since changed — the single thing this page exists to warn about.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PROBE_MS,
  measure,
  rateBetween,
  spanOf,
  type HeadSample,
  type Measurement,
  type Rate,
  type RateProblem,
} from './lib/retention.ts';

export type Phase =
  | { kind: 'idle' }
  /** First head read away; `first` lands part-way through. */
  | { kind: 'probing'; room: string; first: HeadSample | null; endsAt: number }
  | {
      kind: 'probed';
      room: string;
      rate: Rate | null;
      problem: { problem: RateProblem; detail: string } | null;
      lastSeq: number;
    }
  | { kind: 'exporting'; room: string; bytes: number }
  | { kind: 'measured'; room: string; measurement: Measurement }
  | { kind: 'failed'; room: string; at: 'probe' | 'export'; error: string };

export interface Retention {
  phase: Phase;
  /** Every measurement this visit, newest last. */
  measurements: Measurement[];
  /** Start the cheap half. */
  probe: (room: string) => void;
  /** Agree to the expensive half. Only meaningful from `probed`. */
  confirm: () => void;
  /** Abandon whatever is in flight and go back to idle. */
  cancel: () => void;
}

/**
 * `surveyFor` is passed in rather than read here so this hook does not own the
 * survey. The page already has it for the room picker, and two components
 * fetching /rooms to answer the same question would be the one request this
 * client is careful never to make twice.
 */
export function useRetention(
  surveyFor: (room: string) => { bytes: number; lastSeq: number } | null
): Retention {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [measurements, setMeasurements] = useState<Measurement[]>([]);

  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** What `confirm` needs, held out of the phase so a re-render cannot lose it. */
  const probed = useRef<{
    room: string;
    rate: Rate | null;
    problem: { problem: RateProblem; detail: string } | null;
  } | null>(null);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const cancel = useCallback(() => {
    stop();
    probed.current = null;
    setPhase({ kind: 'idle' });
  }, [stop]);

  const probe = useCallback(
    (room: string) => {
      stop();
      probed.current = null;

      const controller = new AbortController();
      abort.current = controller;
      setPhase({ kind: 'probing', room, first: null, endsAt: Date.now() + PROBE_MS });

      void (async () => {
        try {
          const { readHead } = await import('./lib/technocore.ts');

          // The two reads that make a rate. `limit=1` on both: this measures how
          // fast a room is moving without reading any of what moved through it.
          const one = await readHead(room, { signal: controller.signal });
          if (controller.signal.aborted) return;
          const first: HeadSample = {
            room,
            lastSeq: one.lastSeq,
            generation: null,
            readAt: one.readAt,
          };
          setPhase((current) =>
            current.kind === 'probing' && current.room === room ? { ...current, first } : current
          );

          await new Promise<void>((resolve, reject) => {
            timer.current = setTimeout(resolve, PROBE_MS);
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
              once: true,
            });
          });
          if (controller.signal.aborted) return;

          const two = await readHead(room, { signal: controller.signal });
          if (controller.signal.aborted) return;
          const second: HeadSample = {
            room,
            lastSeq: two.lastSeq,
            generation: null,
            readAt: two.readAt,
          };

          const result = rateBetween(first, second);
          const rate = result.ok ? result.rate : null;
          const problem = result.ok ? null : { problem: result.problem, detail: result.detail };
          probed.current = { room, rate, problem };
          setPhase({ kind: 'probed', room, rate, problem, lastSeq: second.lastSeq });
        } catch (err) {
          if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
          setPhase({ kind: 'failed', room, at: 'probe', error: (err as Error).message });
        }
      })();
    },
    [stop]
  );

  const confirm = useCallback(() => {
    const ready = probed.current;
    if (!ready) return;
    const { room, rate, problem } = ready;

    stop();
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: 'exporting', room, bytes: 0 });

    /**
     * WHEN THE SNAPSHOT WAS CUT, not when it finished arriving.
     *
     * This is the difference between a correct reading and a confident wrong
     * one, and it took a live measurement to see. /export is cut at the moment
     * the server starts streaming; a busy room's dump then takes minutes to come
     * down a normal connection. Dating the reading from the last byte therefore
     * charges the whole download to the room — the first run against lobby
     * reported it reaching back 19.2 minutes while holding 14 minutes of
     * traffic, and explained the five-minute difference as the room having gone
     * quiet. Lobby takes twenty-six messages a second. It had not gone quiet;
     * the download had taken five minutes.
     *
     * The request's own start is the closest moment this client can observe to
     * the cut. What is left over is the server's latency before it began
     * writing, which is well under a second and does not move any figure here.
     */
    const startedAt = Date.now();

    void (async () => {
      try {
        const { exportRoom } = await import('./lib/technocore.ts');
        const result = await exportRoom(room, {
          signal: controller.signal,
          // The only honest progress available: there is no content-length to
          // measure against, so the page reports what has landed and compares it
          // to the survey's figure rather than to a promise the server made.
          onBytes: (bytes) =>
            setPhase((current) =>
              current.kind === 'exporting' && current.room === room ? { ...current, bytes } : current
            ),
        });
        if (controller.signal.aborted) return;

        const survey = surveyFor(room);
        const measurement = measure({
          span: spanOf(result, startedAt),
          rate,
          rateProblem: problem,
          surveyBytes: survey?.bytes ?? null,
          // How far behind the survey was, in messages, at the moment we read
          // the room's true last_seq. A number rather than an adjective.
          surveyBehind: survey ? Math.max(0, result.lastSeq - survey.lastSeq) : null,
        });

        setMeasurements((previous) => [...previous, measurement]);
        setPhase({ kind: 'measured', room, measurement });
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
        setPhase({ kind: 'failed', room, at: 'export', error: (err as Error).message });
      }
    })();
  }, [stop, surveyFor]);

  return { phase, measurements, probe, confirm, cancel };
}

/**
 * A countdown that ticks, for the probe's ten seconds.
 *
 * Its own hook because the wait is the one part of this page where a reader is
 * looking at a number that has to move. A static "measuring…" for ten seconds is
 * indistinguishable from a page that has stopped.
 */
export function useCountdown(endsAt: number | null): number {
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (endsAt == null) return;
    const tick = () => setLeft(Math.max(0, endsAt - Date.now()));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [endsAt]);

  return left;
}
