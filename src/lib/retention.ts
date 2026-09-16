// retention.ts — how long a room actually remembers, worked out from readings.
//
// Pure. No network, no clock it was not handed, no DOM. Everything here is
// arithmetic over two head samples and one export, and every figure it produces
// can be re-derived by hand from numbers printed on the page.
//
// ---------------------------------------------------------------------------
// WHY THIS HAS NOT BEEN MEASURED BEFORE
//
// It looks like it should be cheap and it is not, for two specific reasons that
// are worth writing down because they are what the page has to explain:
//
// 1. `first_seq` ON A READ IS BATCH-SCOPED. It is the first seq of the batch
//    that came back, not the oldest seq the ring still holds. `?limit=1` returns
//    `first_seq == last_seq`, and `?limit=200` returns `last_seq - 199`. So the
//    obvious cheap probe — ask for one message, read the floor off the reply —
//    does not exist. There is no endpoint that reports the ring floor.
//
// 2. /export SENDS NO CONTENT-LENGTH. It is chunked, so the only way to learn
//    how big a room's retained history is, is to download all of it. On the
//    busiest rooms that is eight to ten megabytes.
//
// Between them: the answer is exact, and it costs a multi-megabyte download per
// room, and nothing in the API hints at either. Which is why the flow is probe,
// warn, confirm, export — and why the warning is a real one rather than a
// formality.
//
// ---------------------------------------------------------------------------
// THE TWO KINDS OF ANSWER
//
// The distinction this whole file exists to hold: a room that has dropped
// messages has a MEASURED HORIZON, and a room that has not has no horizon yet.
//
//   d-technocore-radar  first_seq 1, 292 messages, 16.3 days
//   lobby               first_seq in the millions, ~31k messages, ~25 minutes
//
// Both hold "everything they have". Only one of them has been trimmed, and only
// for that one is the span a fact about the room's memory rather than about its
// age. Reporting 16.3 days as radar's retention would be the single most
// misleading thing this page could do: it would read as "this room keeps a
// fortnight" when what it means is "this room has never filled up".

import type { ExportResult } from './technocore.ts';

/** The cheapest reading there is: one message, and the room's true last_seq. */
export interface HeadSample {
  room: string;
  lastSeq: number;
  generation: number | null;
  /** When this client received it. Not the server's clock. */
  readAt: number;
}

/**
 * Two samples closer together than this measure noise rather than traffic.
 *
 * At lobby's twenty messages a second a one-second window is twenty messages
 * give or take one, which is a five percent quantisation error on its own, and
 * scheduling jitter on the two requests is the same size again. Ten seconds is
 * what the page waits; two is the floor below which the answer is not worth
 * printing.
 */
export const MIN_ELAPSED_MS = 2_000;

/** What the page waits between the two head reads. */
export const PROBE_MS = 10_000;

export type RateProblem = 'too-soon' | 'rewound' | 'regenerated';

export interface Rate {
  /** Messages per second, as measured. */
  perSecond: number;
  delta: number;
  elapsedMs: number;
  /**
   * Nothing arrived in the window.
   *
   * The rate is then not zero — it is BELOW one message per elapsed second, and
   * the page says so in those words. A room reported at "0 per minute" would be
   * a room this page had declared dead on ten seconds of evidence.
   */
  belowOne: boolean;
  /**
   * The band the true rate lies in, from the +/-1 message quantisation.
   *
   * A window that catches 261 messages could have caught 260 or 262 of the same
   * traffic depending on where its edges fell. On a busy room that is noise; on
   * a room taking three messages a minute it is the whole reading, and the page
   * shows the band instead of the point wherever it is wide enough to matter.
   */
  lo: number;
  hi: number;
  /** The later sample's readAt. A rate is a fact about a moment. */
  at: number;
}

export type RateResult =
  | { ok: true; rate: Rate }
  | { ok: false; problem: RateProblem; detail: string };

/**
 * The rate between two head samples.
 *
 * REFUSES RATHER THAN GUESSES, three times over. Too close together and the
 * quantisation swamps the signal. A `last_seq` that went backwards means the
 * ring was reset under us and the difference is not traffic. A generation bump
 * means the same thing, said explicitly by the server, and is caught even when
 * the seq happens to have climbed past its old value.
 */
export function rateBetween(first: HeadSample, second: HeadSample): RateResult {
  const [a, b] = first.readAt <= second.readAt ? [first, second] : [second, first];
  const elapsedMs = b.readAt - a.readAt;

  if (elapsedMs < MIN_ELAPSED_MS) {
    return {
      ok: false,
      problem: 'too-soon',
      detail: `The two readings were ${(elapsedMs / 1000).toFixed(1)} seconds apart. Below ${
        MIN_ELAPSED_MS / 1000
      } seconds the count is mostly where the window's edges fell.`,
    };
  }

  if (a.generation != null && b.generation != null && a.generation !== b.generation) {
    return {
      ok: false,
      problem: 'regenerated',
      detail:
        `The room was reset between the two readings — generation ${a.generation} became ` +
        `${b.generation}. The difference in seq is not traffic, and nothing can be read from it.`,
    };
  }

  const delta = b.lastSeq - a.lastSeq;
  if (delta < 0) {
    return {
      ok: false,
      problem: 'rewound',
      detail:
        `last_seq went backwards, from ${a.lastSeq} to ${b.lastSeq}. A ring only ever counts ` +
        `up, so this room was rebuilt between the readings.`,
    };
  }

  const seconds = elapsedMs / 1000;
  return {
    ok: true,
    rate: {
      perSecond: delta / seconds,
      delta,
      elapsedMs,
      belowOne: delta === 0,
      lo: Math.max(0, (delta - 1) / seconds),
      hi: (delta + 1) / seconds,
      at: b.readAt,
    },
  };
}

/** Whether the band is wide enough to be worth printing instead of the point. */
export function bandWorthShowing(rate: Rate): boolean {
  if (rate.belowOne) return false;
  return rate.hi - rate.lo > rate.perSecond * 0.2;
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

export interface Span {
  room: string;
  /** When the export finished arriving. */
  at: number;
  /** Messages that parsed. */
  count: number;
  malformed: number;
  /** Messages with no readable timestamp. They still count; they cannot date. */
  undated: number;
  bytes: number;
  bytesPerMessage: number | null;
  firstSeq: number | null;
  lastSeq: number;
  /**
   * How many messages the ring has dropped: `first_seq - 1`.
   *
   * Zero is the interesting value. It means the room still holds its own first
   * message and has therefore never been trimmed, so its span is its age.
   */
  forgotten: number | null;
  firstTsMs: number | null;
  lastTsMs: number | null;
  /** Newest retained minus oldest retained: the window of traffic it holds. */
  spanSeconds: number | null;
  /** Now minus oldest retained: how far back it can still see. */
  reachSeconds: number | null;
  /** count / span — the average rate across everything it is holding. */
  historicalPerSecond: number | null;
  /** The dump was cut mid-record; one line was dropped rather than half-parsed. */
  truncated: boolean;
}

/**
 * Read an export into the facts about what the room is holding.
 *
 * `now` is passed in rather than read: this is the difference between a
 * function whose output can be pinned in a test and one whose output depends on
 * when the test ran.
 */
export function spanOf(result: ExportResult, now: number): Span {
  const dated = result.messages
    .map((message) => message.tsMs)
    .filter((ms): ms is number => Number.isFinite(ms));

  const firstTsMs = dated.length ? Math.min(...dated) : null;
  const lastTsMs = dated.length ? Math.max(...dated) : null;
  const spanSeconds = firstTsMs != null && lastTsMs != null ? (lastTsMs - firstTsMs) / 1000 : null;

  return {
    room: result.room,
    at: now,
    count: result.messages.length,
    malformed: result.malformed.length,
    undated: result.messages.length - dated.length,
    bytes: result.bytes,
    bytesPerMessage: result.messages.length ? result.bytes / result.messages.length : null,
    firstSeq: result.firstSeq,
    lastSeq: result.lastSeq,
    forgotten: result.firstSeq == null ? null : Math.max(0, result.firstSeq - 1),
    firstTsMs,
    lastTsMs,
    spanSeconds,
    reachSeconds: firstTsMs != null ? Math.max(0, (now - firstTsMs) / 1000) : null,
    // Guarded against a zero span: a room holding one message, or a burst that
    // all landed in the same microsecond, would otherwise report an infinite
    // rate, which would then be drawn as a bar of infinite height.
    historicalPerSecond:
      spanSeconds != null && spanSeconds > 0 ? result.messages.length / spanSeconds : null,
    truncated: result.truncatedTail != null,
  };
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * `horizon`     the ring has dropped messages, so its span is what it keeps.
 * `whole-life`  it has never dropped one, so its span is how old it is.
 * `empty`       it is holding nothing at all.
 * `unreadable`  it holds messages and none of them carries a date.
 *
 * The last two are separated because they were one for about an hour and the
 * result read badly: an empty room was reported as "nothing in it carries a
 * timestamp this browser can read", which is true the way a statement about the
 * empty set is true and tells the reader nothing. A room with no messages and a
 * room whose messages are undated are different findings.
 */
export type Verdict = 'horizon' | 'whole-life' | 'empty' | 'unreadable';

export interface Measurement {
  room: string;
  at: number;
  verdict: Verdict;
  /** The headline figure, in seconds. Null only when `unreadable`. */
  seconds: number | null;
  span: Span;
  /** Null where the two head reads could not produce one; the reason is kept. */
  rate: Rate | null;
  rateProblem: { problem: RateProblem; detail: string } | null;
  /**
   * How long the retained messages are worth at the rate measured just now.
   *
   * Only meaningful for a room with a horizon: a room that has never filled has
   * nothing being evicted, so there is no "how long until this is dropped".
   * Compared against the observed span, this is the page's one forward-looking
   * figure and it is labelled as a projection everywhere it appears — the
   * difference between the two is the room forgetting faster or slower than it
   * has been.
   */
  projectedSeconds: number | null;
  /** The survey's figure for this ring, if the survey listed it at all. */
  surveyBytes: number | null;
  /** How far behind the survey's last_seq was, in messages, when probed. */
  surveyBehind: number | null;
}

export function measure({
  span,
  rate,
  rateProblem = null,
  surveyBytes = null,
  surveyBehind = null,
}: {
  span: Span;
  rate: Rate | null;
  rateProblem?: { problem: RateProblem; detail: string } | null;
  surveyBytes?: number | null;
  surveyBehind?: number | null;
}): Measurement {
  const verdict: Verdict =
    span.count === 0
      ? 'empty'
      : span.reachSeconds == null
        ? 'unreadable'
        : span.forgotten
          ? 'horizon'
          : 'whole-life';

  // THE REACH, NOT THE SPAN. "How long does it remember" is answered by the age
  // of the oldest thing it still holds, which is `now - firstTs`. The span —
  // newest minus oldest — is the window of TRAFFIC it holds, and the two come
  // apart on a room that has gone quiet: one that took a burst an hour ago and
  // nothing since has a span of seconds and remembers an hour. Both are on the
  // page, under their own names, because both are true and they answer
  // different questions.
  const seconds = span.reachSeconds;

  const projectedSeconds =
    verdict === 'horizon' && rate && !rate.belowOne && rate.perSecond > 0
      ? span.count / rate.perSecond
      : null;

  return {
    room: span.room,
    at: span.at,
    verdict,
    seconds,
    span,
    rate,
    rateProblem,
    projectedSeconds,
    surveyBytes,
    surveyBehind,
  };
}

/**
 * Longest memory first.
 *
 * `whole-life` rooms rank among the rest on their number, which is right: a room
 * holding sixteen days of history is holding sixteen days of history whether or
 * not it has ever been trimmed. What the row must not do is claim the number
 * means the same thing, and that is the verdict's job rather than the order's.
 */
export function rank(measurements: Measurement[]): Measurement[] {
  return [...measurements].sort((a, b) => (b.seconds ?? -1) - (a.seconds ?? -1));
}

/**
 * The newest measurement per room, plus what it had been before.
 *
 * Re-measuring is the point rather than a duplicate: the whole caveat on this
 * page is that a rate changes and so a retention changes, and two readings of
 * one room minutes apart is the only evidence of that anyone can actually see.
 * So the table keeps one row per room and the row carries its own history.
 */
export interface Row {
  latest: Measurement;
  earlier: Measurement[];
}

export function rowsFrom(measurements: Measurement[]): Row[] {
  const byRoom = new Map<string, Measurement[]>();
  for (const m of measurements) {
    const list = byRoom.get(m.room);
    if (list) list.push(m);
    else byRoom.set(m.room, [m]);
  }

  const rows: Row[] = [];
  for (const list of byRoom.values()) {
    const sorted = [...list].sort((a, b) => b.at - a.at);
    rows.push({ latest: sorted[0], earlier: sorted.slice(1) });
  }
  return rows.sort((a, b) => (b.latest.seconds ?? -1) - (a.latest.seconds ?? -1));
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * A duration as the page says it out loud: "25 minutes", "16.3 days".
 *
 * ONE DECIMAL, ALWAYS, and then a trailing `.0` dropped. That is the precision
 * the method actually supports and no more: an export is a snapshot of a ring
 * that kept moving while it was being read, so "16.34 days" claims a resolution
 * that is not there — and rounding the same figure to "16 days" throws away
 * eight hours, which at that scale is the difference worth knowing. The two
 * figures this page exists to print, 25 minutes and 16.3 days, both fall out of
 * the one rule.
 *
 * The largest unit the duration actually fills, so an hour is an hour rather
 * than 0.04 days and a day is a day rather than 24 hours.
 */
export function humanSpan(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const units: Array<[number, string]> = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [size, name] of units) {
    if (seconds < size) continue;
    const rounded = Math.round((seconds / size) * 10) / 10;
    return `${rounded} ${name}${rounded === 1 ? '' : 's'}`;
  }
  return 'under a second';
}

/**
 * A rate in whichever unit makes it readable without a leading zero.
 *
 * Two decimals under a hundred, because at lobby's twenty a second the second
 * decimal is the difference between two readings taken a minute apart — which
 * is the thing this page keeps insisting on.
 */
export function humanRate(perSecond: number | null | undefined): string | null {
  if (perSecond == null || !Number.isFinite(perSecond)) return null;
  if (perSecond >= 1) return `${perSecond.toFixed(perSecond < 100 ? 2 : 0)} per second`;
  const perMinute = perSecond * 60;
  if (perMinute >= 1) return `${perMinute.toFixed(perMinute < 10 ? 1 : 0)} per minute`;
  const perHour = perSecond * 3600;
  return `${perHour.toFixed(perHour < 10 ? 1 : 0)} per hour`;
}
