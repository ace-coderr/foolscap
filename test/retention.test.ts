// npm test — vitest
//
// What a room retains, and what may be said about it. No DOM, no network: the
// figures below are the ones this project measured against the live network on
// 2026-09-16, and they are in here so the arithmetic that produced the page's
// headline can be checked against readings someone else can go and repeat.
//
//   d-technocore-radar  292 messages, 187,004 bytes, first_seq 1, span 16.3 days
//   lobby               ~20.16 messages a second, first_seq in the millions
//
// The one to read if you read one: "a room that has never been trimmed is not
// reporting its retention". Both rooms above hold everything they have. Only
// one of them has ever had to drop anything, and calling radar's sixteen days a
// retention window would be this page's worst possible error — it reads as "this
// room keeps a fortnight" when it means "this room has never filled up".

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import type { ExportResult, Message } from '../src/lib/technocore';
import {
  MIN_ELAPSED_MS,
  bandWorthShowing,
  humanRate,
  humanSpan,
  measure,
  rank,
  rateBetween,
  rowsFrom,
  spanOf,
  type HeadSample,
  type Measurement,
} from '../src/lib/retention';

const head = (over: Partial<HeadSample> = {}): HeadSample => ({
  room: 'lobby',
  lastSeq: 52_046_260,
  generation: 0,
  readAt: 1_789_550_305_920,
  ...over,
});

const message = (seq: number, ts: string): Message => ({
  room: 'lobby',
  seq,
  ts,
  tsMs: Date.parse(ts),
  from: 'did:key:z6MkTest',
  text: 'hello',
  nonce: null,
  sig: null,
  raw: { seq, ts },
});

function exported(over: Partial<ExportResult> = {}): ExportResult {
  const messages = over.messages ?? [
    message(1, '2026-08-30T23:15:11.537Z'),
    message(292, '2026-09-16T07:30:07.402Z'),
  ];
  return {
    room: 'd-technocore-radar',
    messages,
    malformed: [],
    truncatedTail: null,
    generation: 0,
    firstSeq: messages.length ? messages[0].seq : null,
    lastSeq: messages.length ? messages[messages.length - 1].seq : 0,
    bytes: 187_004,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The rate
// ---------------------------------------------------------------------------

describe('the rate, from two head reads', () => {
  test('the live reading this page was built on', () => {
    // Measured against lobby: 261 messages in 12.948 seconds.
    const result = rateBetween(
      head({ lastSeq: 52_046_260, readAt: 1_789_550_305_920 }),
      head({ lastSeq: 52_046_521, readAt: 1_789_550_318_868 })
    );
    assert.ok(result.ok);
    assert.equal(result.rate.delta, 261);
    assert.equal(result.rate.perSecond.toFixed(2), '20.16');
    assert.equal(result.rate.belowOne, false);
  });

  test('the samples may arrive in either order', () => {
    const a = head({ lastSeq: 100, readAt: 1_000_000 });
    const b = head({ lastSeq: 400, readAt: 1_010_000 });
    const forwards = rateBetween(a, b);
    const backwards = rateBetween(b, a);
    assert.ok(forwards.ok && backwards.ok);
    assert.equal(forwards.rate.perSecond, backwards.rate.perSecond);
    assert.equal(forwards.rate.delta, 30 * 10);
  });

  test('nothing arrived is not a rate of zero', () => {
    // A room reported at "0 per minute" would be a room this page had declared
    // dead on ten seconds of evidence. It is an upper bound, and says so.
    const result = rateBetween(
      head({ lastSeq: 900, readAt: 1_000_000 }),
      head({ lastSeq: 900, readAt: 1_010_000 })
    );
    assert.ok(result.ok);
    assert.equal(result.rate.delta, 0);
    assert.equal(result.rate.belowOne, true);
    assert.equal(result.rate.perSecond, 0);
    // The ceiling: fewer than one message in ten seconds.
    assert.equal(result.rate.hi, 0.1);
  });

  test('two readings too close together are refused, not rounded', () => {
    const result = rateBetween(
      head({ readAt: 1_000_000 }),
      head({ lastSeq: 52_046_300, readAt: 1_000_000 + MIN_ELAPSED_MS - 1 })
    );
    assert.ok(!result.ok);
    assert.equal(result.problem, 'too-soon');
  });

  test('a ring that went backwards is refused', () => {
    const result = rateBetween(
      head({ lastSeq: 900, readAt: 1_000_000 }),
      head({ lastSeq: 40, readAt: 1_010_000 })
    );
    assert.ok(!result.ok);
    assert.equal(result.problem, 'rewound');
  });

  test('a generation bump is caught even when the seq climbed', () => {
    // The nastier half of the same failure: a rebuilt ring whose seq happens to
    // have passed its old value looks exactly like traffic.
    const result = rateBetween(
      head({ lastSeq: 100, generation: 3, readAt: 1_000_000 }),
      head({ lastSeq: 900, generation: 4, readAt: 1_010_000 })
    );
    assert.ok(!result.ok);
    assert.equal(result.problem, 'regenerated');
  });

  test('the band is shown on a quiet room and hidden on a busy one', () => {
    const busy = rateBetween(
      head({ lastSeq: 0, readAt: 0 }),
      head({ lastSeq: 261, readAt: 12_948 })
    );
    const quiet = rateBetween(head({ lastSeq: 0, readAt: 0 }), head({ lastSeq: 3, readAt: 10_000 }));
    assert.ok(busy.ok && quiet.ok);
    // +/-1 in 261 is noise; +/-1 in 3 is the reading.
    assert.equal(bandWorthShowing(busy.rate), false);
    assert.equal(bandWorthShowing(quiet.rate), true);
  });
});

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

describe('what an export says the room is holding', () => {
  test('the live reading for d-technocore-radar', () => {
    const now = Date.parse('2026-09-16T09:17:54Z');
    const span = spanOf(exported(), now);
    assert.equal(span.count, 2);
    assert.equal(span.bytes, 187_004);
    assert.equal(span.firstSeq, 1);
    assert.equal(span.forgotten, 0);
    // 2026-08-30T23:15:11.537Z to 2026-09-16T07:30:07.402Z
    assert.equal(Math.round(span.spanSeconds!), 1_412_096);
    assert.equal(humanSpan(span.spanSeconds), '16.3 days');
  });

  test('bytes per message comes off the dump, not off an estimate', () => {
    const span = spanOf(exported({ bytes: 187_004 }), 0);
    assert.equal(span.bytesPerMessage, 187_004 / 2);
  });

  test('reach and span are different numbers and both are kept', () => {
    // A room that took a burst and went quiet: it holds seconds of traffic and
    // remembers an hour. Reporting either one as the other is wrong.
    const messages = [
      message(40, '2026-09-16T08:00:00.000Z'),
      message(41, '2026-09-16T08:00:04.000Z'),
    ];
    const span = spanOf(exported({ messages, firstSeq: 40, lastSeq: 41 }), Date.parse('2026-09-16T09:00:04Z'));
    assert.equal(span.spanSeconds, 4);
    assert.equal(span.reachSeconds, 3604);
  });

  test('a room holding one message reports no rate rather than an infinite one', () => {
    const span = spanOf(
      exported({ messages: [message(3, '2026-09-16T07:30:06.982Z')], firstSeq: 3, lastSeq: 3, bytes: 333 }),
      Date.parse('2026-09-16T09:00:00Z')
    );
    assert.equal(span.spanSeconds, 0);
    assert.equal(span.historicalPerSecond, null);
    assert.equal(span.bytesPerMessage, 333);
    // last_seq 3 with only seq 3 retained: two messages are gone.
    assert.equal(span.forgotten, 2);
  });

  test('an empty export is empty rather than zero', () => {
    const span = spanOf(exported({ messages: [], firstSeq: null, lastSeq: 0, bytes: 0 }), 1000);
    assert.equal(span.count, 0);
    assert.equal(span.spanSeconds, null);
    assert.equal(span.reachSeconds, null);
    assert.equal(span.bytesPerMessage, null);
    assert.equal(span.forgotten, null);
  });

  test('messages that cannot be dated are counted, not dropped', () => {
    const undated = { ...message(2, '2026-09-16T08:00:00.000Z'), ts: null, tsMs: NaN };
    const span = spanOf(
      exported({
        messages: [message(1, '2026-09-16T08:00:00.000Z'), undated, message(3, '2026-09-16T08:10:00.000Z')],
      }),
      Date.parse('2026-09-16T08:10:00Z')
    );
    assert.equal(span.count, 3);
    assert.equal(span.undated, 1);
    assert.equal(span.spanSeconds, 600);
  });
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

describe('the two kinds of answer', () => {
  const now = Date.parse('2026-09-16T09:17:54Z');

  test('A ROOM THAT HAS NEVER BEEN TRIMMED IS NOT REPORTING ITS RETENTION', () => {
    // first_seq 1: d-technocore-radar still holds its own first message, so
    // 16.3 days is how old it is and says nothing about what it would drop.
    const m = measure({ span: spanOf(exported(), now), rate: null });
    assert.equal(m.verdict, 'whole-life');
    assert.equal(m.span.forgotten, 0);
    // And no projection: nothing is being evicted, so there is no "how long
    // until this is dropped" to project.
    assert.equal(m.projectedSeconds, null);
  });

  test('a room that has dropped messages has a measured horizon', () => {
    const messages = [
      message(52_015_000, '2026-09-16T08:52:00.000Z'),
      message(52_046_402, '2026-09-16T09:17:00.000Z'),
    ];
    const span = spanOf(
      exported({ room: 'lobby', messages, firstSeq: 52_015_000, lastSeq: 52_046_402, bytes: 7_145_802 }),
      now
    );
    const m = measure({ span, rate: null });
    assert.equal(m.verdict, 'horizon');
    assert.equal(m.span.forgotten, 52_014_999);
    assert.equal(humanSpan(m.span.spanSeconds), '25 minutes');
  });

  test('the projection is only made where something is actually being evicted', () => {
    const messages = [
      message(52_015_000, '2026-09-16T08:52:00.000Z'),
      message(52_046_402, '2026-09-16T09:17:00.000Z'),
    ];
    const span = spanOf(exported({ room: 'lobby', messages, firstSeq: 52_015_000, lastSeq: 52_046_402 }), now);
    const rate = rateBetween(
      head({ lastSeq: 52_046_260, readAt: 1_789_550_305_920 }),
      head({ lastSeq: 52_046_521, readAt: 1_789_550_318_868 })
    );
    assert.ok(rate.ok);
    const m = measure({ span, rate: rate.rate });
    // 2 retained messages at 20.16/s. A toy number from a toy export, but the
    // arithmetic is the one the page prints.
    assert.equal(m.projectedSeconds, 2 / rate.rate.perSecond);
  });

  test('an idle room gets no projection, because a bound is not a rate', () => {
    const messages = [
      message(500, '2026-09-16T08:52:00.000Z'),
      message(900, '2026-09-16T09:17:00.000Z'),
    ];
    const span = spanOf(exported({ messages, firstSeq: 500, lastSeq: 900 }), now);
    const rate = rateBetween(head({ lastSeq: 900, readAt: 0 }), head({ lastSeq: 900, readAt: 10_000 }));
    assert.ok(rate.ok);
    const m = measure({ span, rate: rate.rate });
    assert.equal(m.verdict, 'horizon');
    assert.equal(m.projectedSeconds, null);
  });

  test('dropping one message of eighteen hundred is still a horizon', () => {
    // The verdict is a fact about the mechanism and stays binary: something has
    // been evicted or nothing has. How near the room is to settling at its limit
    // is a matter of degree, and the page says that in words rather than by
    // inventing a third verdict for it.
    const messages = [
      message(2, '2026-09-02T08:00:00.000Z'),
      message(1822, '2026-09-16T08:00:00.000Z'),
    ];
    const m = measure({ span: spanOf(exported({ messages, firstSeq: 2, lastSeq: 1822 }), now), rate: null });
    assert.equal(m.verdict, 'horizon');
    assert.equal(m.span.forgotten, 1);
  });

  test('a room whose messages carry no readable date is unreadable, not zero', () => {
    const undated = { ...message(1, '2026-09-16T08:00:00.000Z'), ts: null, tsMs: NaN };
    const m = measure({ span: spanOf(exported({ messages: [undated] }), now), rate: null });
    assert.equal(m.verdict, 'unreadable');
    assert.equal(m.seconds, null);
  });

  test('an empty room is empty, which is not the same finding as undated', () => {
    // These were one verdict for an hour and it read badly: an unwritten room
    // came back as "nothing in it carries a timestamp this browser can read",
    // which is true the way a statement about the empty set is true.
    const m = measure({
      span: spanOf(exported({ messages: [], firstSeq: null, lastSeq: 0, bytes: 0 }), now),
      rate: null,
    });
    assert.equal(m.verdict, 'empty');
    assert.equal(m.seconds, null);
  });

  test('a refused rate is carried with its reason rather than dropped', () => {
    const m = measure({
      span: spanOf(exported(), now),
      rate: null,
      rateProblem: { problem: 'regenerated', detail: 'the room was reset' },
    });
    assert.equal(m.rate, null);
    assert.equal(m.rateProblem?.problem, 'regenerated');
  });
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('the table', () => {
  const at = (room: string, seconds: number, when: number): Measurement =>
    ({ room, at: when, seconds, verdict: 'horizon' }) as Measurement;

  test('longest memory first — the spread is the story', () => {
    const ordered = rank([at('lobby', 1500, 1), at('radar', 1_412_096, 2), at('kibble', 90_000, 3)]);
    assert.deepEqual(
      ordered.map((m) => m.room),
      ['radar', 'kibble', 'lobby']
    );
  });

  test('a measurement with no answer sorts last rather than first', () => {
    const none = { room: 'dark', at: 4, seconds: null, verdict: 'unreadable' } as Measurement;
    const ordered = rank([none, at('lobby', 1500, 1)]);
    assert.deepEqual(
      ordered.map((m) => m.room),
      ['lobby', 'dark']
    );
  });

  test('re-measuring a room keeps the earlier reading, because that is the caveat', () => {
    // "A rate changes, so retention changes" is the page's standing warning, and
    // two readings of one room minutes apart is the only evidence of it anyone
    // can actually see. The row carries its own history rather than replacing it.
    const rows = rowsFrom([at('lobby', 1500, 100), at('lobby', 1380, 200), at('radar', 1_412_096, 150)]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].latest.room, 'radar');
    const lobby = rows[1];
    assert.equal(lobby.latest.at, 200);
    assert.equal(lobby.latest.seconds, 1380);
    assert.equal(lobby.earlier.length, 1);
    assert.equal(lobby.earlier[0].seconds, 1500);
  });

  test('one measurement is one row with nothing behind it', () => {
    const rows = rowsFrom([at('lobby', 1500, 100)]);
    assert.deepEqual(rows[0].earlier, []);
  });

  test('nothing measured is no rows, not an empty room', () => {
    assert.deepEqual(rowsFrom([]), []);
  });
});

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

describe('saying it out loud', () => {
  test('the two figures this page was built to print', () => {
    assert.equal(humanSpan(1_500), '25 minutes');
    assert.equal(humanSpan(1_412_096), '16.3 days');
  });

  test('one decimal below ten and none above — the precision the method has', () => {
    assert.equal(humanSpan(86_400 * 3.46), '3.5 days');
    assert.equal(humanSpan(86_400 * 34.6), '34.6 days');
    assert.equal(humanSpan(90), '1.5 minutes');
  });

  test('singular where it should be', () => {
    assert.equal(humanSpan(86_400), '1 day');
    assert.equal(humanSpan(3_600), '1 hour');
  });

  test('a span of nothing is not nothing', () => {
    assert.equal(humanSpan(0), 'under a second');
    assert.equal(humanSpan(null), null);
    assert.equal(humanSpan(Number.NaN), null);
  });

  test('the rate picks a unit that does not start with a zero', () => {
    assert.equal(humanRate(20.157), '20.16 per second');
    assert.equal(humanRate(0.4), '24 per minute');
    assert.equal(humanRate(0.001), '3.6 per hour');
    assert.equal(humanRate(null), null);
  });
});
