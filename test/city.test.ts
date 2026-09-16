// city.test.ts — the City's pure half.
//
// The canvas is not tested here and does not need to be: everything it draws is
// decided before it is handed anything. What is tested is the part that could be
// wrong in a way nobody would notice — a district that quietly claims authority,
// a layout that shuffles itself between loads, a brightness derived from a number
// that cannot support it, and the survey-lag estimate, which is the one figure on
// the page that is inferred rather than read.
//
// No network. The survey rows below are shaped exactly like the live ones.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { RoomSummary } from '../src/lib/technocore.ts';
import { districtFor } from '../src/city/districts.ts';
import { CORE_RADIUS, formFor, layoutRadial, LOT, RING_MIN } from '../src/city/radial.ts';
import { buildCity, estimateSurveyLag, heightFor, type Reading } from '../src/city/model.ts';

function summary(room: string, lastSeq: number, extra: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room,
    lastSeq,
    bytes: 1_000_000,
    idleSeconds: 0,
    topic: null,
    window: 200,
    zeroResponseShare: 0.005,
    nickDiversity: 0.9,
    ...extra,
  };
}

function reading(room: string, over: Partial<Reading> = {}): Reading {
  return {
    room,
    lastSeq: 0,
    newestTsMs: null,
    readAt: 1_000_000,
    ratePerMin: null,
    rateSpanMs: null,
    error: null,
    ...over,
  };
}

describe('districts', () => {
  it('sorts the rooms this tool exists for into their own district', () => {
    assert.equal(districtFor('mb-sonnet-2-registration').id, 'contest');
    assert.equal(districtFor('d-sonnet-2-rules').id, 'contest');
    assert.equal(districtFor('d-sonnet-2-team-anything').id, 'contest');
  });

  it('puts a pair mailbox in pairs, not in contest, despite the shared prefix', () => {
    assert.equal(districtFor('mb-pair-0012-4653').id, 'pairs');
    assert.equal(districtFor('mb-ffab01b2feb8').id, 'pairs');
  });

  it('never leaves a room unsorted', () => {
    for (const room of ['', 'x', 'floppy-91b328da', '3ca2e51464b43c4a', 'ca-cxxphyi']) {
      assert.ok(districtFor(room).id.length > 0, room);
    }
  });

  it('is the name and only the name — a room can name itself into any district', () => {
    // Not a bug to fix, a caveat to state. Anyone may create this room; it is not
    // the contest's and Foolscap must not imply that it is. The page says so.
    assert.equal(districtFor('mb-sonnet-2-registration-impostor').id, 'contest');
  });
});

describe('the radial layout', () => {
  const rooms = [
    { room: 'lobby', volume: 41_000_000 },
    { room: 'technocore', volume: 6_700_000 },
    { room: 'meta', volume: 2_600_000 },
    { room: 'mb-sonnet-2-registration', volume: 95_000 },
    { room: 'd-sonnet-2-rules', volume: 400 },
    { room: 'mb-pair-0001-1111', volume: 36_000 },
    { room: 'mb-pair-0002-2222', volume: 35_000 },
    { room: 'zk_rollups', volume: 123_000 },
  ];

  it('places every room exactly once', () => {
    const layout = layoutRadial(rooms);
    assert.equal(layout.placements.size, rooms.length);
    for (const room of rooms) assert.ok(layout.placements.has(room.room), room.room);
  });

  it('is the same city twice — nothing moves between loads', () => {
    const a = layoutRadial(rooms);
    const b = layoutRadial([...rooms].reverse());
    for (const room of rooms) {
      const first = a.placements.get(room.room)!;
      const second = b.placements.get(room.room)!;
      assert.equal(first.x, second.x, room.room);
      assert.equal(first.z, second.z, room.room);
    }
  });

  it('ties break on the name, so equal volumes cannot swap places', () => {
    const tied = [
      { room: 'bbb', volume: 100 },
      { room: 'aaa', volume: 100 },
    ];
    const a = layoutRadial(tied);
    const b = layoutRadial([...tied].reverse());
    assert.deepEqual(a.placements.get('aaa'), b.placements.get('aaa'));
    assert.deepEqual(a.placements.get('bbb'), b.placements.get('bbb'));
  });

  it('gives no two buildings the same lot', () => {
    const layout = layoutRadial(rooms);
    const seen = new Set<string>();
    for (const placement of layout.placements.values()) {
      const key = `${placement.x.toFixed(3)},${placement.z.toFixed(3)}`;
      assert.ok(!seen.has(key), `two rooms at ${key}`);
      seen.add(key);
    }
  });

  /**
   * THE ONE THAT MATTERS. Radius is rank and the ring has to close, and those
   * two pull against each other — a zone's angular width depends on its radius,
   * so anything that shrinks a zone to make room reorders the ranks.
   *
   * The file solves it by scaling every radius by one factor, which cannot
   * reorder anything. These two tests are what hold that: ranks come out in
   * volume order, and no two zones share an arc.
   */
  it('puts the busiest district innermost, and the rest in rank order', () => {
    const layout = layoutRadial(rooms);
    const byRadius = [...layout.zones].sort((a, b) => a.radius - b.radius);
    for (let i = 1; i < byRadius.length; i++) {
      assert.ok(
        byRadius[i - 1].volume >= byRadius[i].volume,
        `${byRadius[i - 1].district.id} is inside ${byRadius[i].district.id} on less volume`
      );
    }
    assert.equal(byRadius[0].index, 1, 'the innermost zone is numbered 1');
  });

  it('no two districts share an arc, so the rings close without overlap', () => {
    const layout = layoutRadial(rooms);
    for (let i = 0; i < layout.zones.length; i++) {
      for (let j = i + 1; j < layout.zones.length; j++) {
        const a = layout.zones[i];
        const b = layout.zones[j];
        // Distance between centres against the sum of the radii: the plain
        // circle test, which holds whatever the angles worked out to.
        const apart = Math.hypot(a.x - b.x, a.z - b.z);
        assert.ok(
          apart >= a.plotRadius + b.plotRadius - 1e-6,
          `${a.district.id} overlaps ${b.district.id}`
        );
      }
    }
  });

  it('keeps every building inside the wall and outside the core', () => {
    const layout = layoutRadial(rooms);
    for (const placement of layout.placements.values()) {
      const r = Math.hypot(placement.x, placement.z);
      assert.ok(r <= layout.wallRadius, `${placement.room} is outside the wall`);
      assert.ok(r >= CORE_RADIUS - LOT, `${placement.room} is inside the core`);
    }
  });

  it('numbers the districts from the centre out, with no gaps', () => {
    const layout = layoutRadial(rooms);
    const numbers = [...layout.zones].sort((a, b) => a.index - b.index).map((z) => z.index);
    assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
  });

  it('hangs every label outside the wall', () => {
    const layout = layoutRadial(rooms);
    for (const zone of layout.zones) {
      assert.ok(Math.hypot(zone.labelX, zone.labelZ) > layout.wallRadius, zone.district.id);
    }
  });

  it('an empty survey is an empty city rather than a crash', () => {
    const layout = layoutRadial([]);
    assert.equal(layout.placements.size, 0);
    assert.deepEqual(layout.zones, []);
    assert.ok(layout.wallRadius > 0);
  });

  it('one room is one district and still draws', () => {
    const layout = layoutRadial([{ room: 'lobby', volume: 10 }]);
    assert.equal(layout.zones.length, 1);
    assert.equal(layout.zones[0].index, 1);
    assert.ok(layout.wallRadius > layout.zones[0].radius);
  });
});

describe('built form', () => {
  /**
   * Form is the only thing telling one district from another at a glance, since
   * the mass is one grey and the accent is spent on something else. So it has to
   * come from the district's own character rather than being handed out.
   */
  it('a contest is stepped whatever its size — its rooms are stages', () => {
    assert.equal(formFor({ kind: 'contest', count: 3 }), 'stepped');
    assert.equal(formFor({ kind: 'contest', count: 40 }), 'stepped');
  });

  it('many rooms are peers on a ring', () => {
    assert.equal(formFor({ kind: 'pair', count: RING_MIN }), 'ring');
    assert.equal(formFor({ kind: 'fringe', count: 200 }), 'ring');
  });

  it('a few chat rooms are a stack — depth rather than spread', () => {
    assert.equal(formFor({ kind: 'chat', count: 6 }), 'stack');
  });

  it('...but enough of them are peers again, because the count wins', () => {
    assert.equal(formFor({ kind: 'chat', count: RING_MIN }), 'ring');
  });

  it('anything else is a grid, which asserts the least', () => {
    assert.equal(formFor({ kind: 'infra', count: 4 }), 'grid');
    assert.equal(formFor({ kind: 'market', count: 1 }), 'grid');
  });
});

describe('height', () => {
  it('is logarithmic, so forty million does not flatten everything else', () => {
    const lobby = heightFor(41_000_000);
    const registration = heightFor(95_000);
    assert.ok(lobby > registration);
    // Linear would make the ratio 430:1. It is under four.
    assert.ok(lobby / registration < 4, `${lobby} / ${registration}`);
  });

  it('floors the stubs, rather than drawing distinctions between them', () => {
    assert.equal(heightFor(1), heightFor(50));
    assert.equal(heightFor(50), heightFor(99));
    assert.ok(heightFor(1000) > heightFor(99));
  });

  it('rises by the same amount for every tenfold increase', () => {
    const a = heightFor(10_000) - heightFor(1_000);
    const b = heightFor(1_000_000) - heightFor(100_000);
    assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  });
});

describe('building the city', () => {
  const now = 1_700_000_000_000;

  it('draws a room the survey lists but nobody reads, with no state', () => {
    const city = buildCity({ survey: [summary('lobby', 41_000_000)], readings: new Map(), watched: [], now });
    const lobby = city.rooms.find((room) => room.room === 'lobby')!;
    assert.equal(lobby.state, 'unwatched');
    assert.equal(lobby.watched, false);
    assert.equal(lobby.activityBasis, 'none');
  });

  it('never derives brightness from the survey', () => {
    // idle_seconds is 0 for every room the survey lists, because it lists the
    // busiest. Using it would light the whole city and mean "all busy now".
    const city = buildCity({
      survey: [summary('lobby', 41_000_000, { idleSeconds: 0 })],
      readings: new Map(),
      watched: [],
      now,
    });
    assert.equal(city.rooms[0].activity, 0);
  });

  it('gives a watched room a state, from its own reading', () => {
    const readings = new Map([
      ['lobby', reading('lobby', { lastSeq: 41_000_100, newestTsMs: now - 2_000, ratePerMin: 600, rateSpanMs: 60_000 })],
    ]);
    const city = buildCity({ survey: [summary('lobby', 41_000_000)], readings, watched: ['lobby'], now });
    const lobby = city.rooms[0];
    assert.equal(lobby.state, 'live');
    assert.equal(lobby.activityBasis, 'read');
    assert.ok(lobby.activity > 0);
  });

  it('calls a watched room quiet when nothing has arrived for a while', () => {
    const readings = new Map([
      ['lobby', reading('lobby', { lastSeq: 10, newestTsMs: now - 30 * 60_000, ratePerMin: 0, rateSpanMs: 300_000 })],
    ]);
    const city = buildCity({ survey: [], readings, watched: ['lobby'], now });
    assert.equal(city.rooms[0].state, 'quiet');
  });

  it('calls a room failing when the read failed, and keeps the last figures', () => {
    const readings = new Map([
      ['lobby', reading('lobby', { lastSeq: 41_000_000, newestTsMs: now - 1_000, error: 'Rate limited' })],
    ]);
    const city = buildCity({ survey: [], readings, watched: ['lobby'], now });
    assert.equal(city.rooms[0].state, 'failing');
    assert.equal(city.rooms[0].volume, 41_000_000, 'the figures survive the failure');
    assert.equal(city.rooms[0].error, 'Rate limited');
  });

  it('builds a room the survey has never heard of, if Foolscap watches it', () => {
    // The contest rooms are exactly this case: the survey lists the busiest fifty
    // of some forty thousand, and they are not among them.
    const city = buildCity({
      survey: [summary('lobby', 41_000_000)],
      readings: new Map([['mb-sonnet-2-registration', reading('mb-sonnet-2-registration', { lastSeq: 95_941 })]]),
      watched: ['mb-sonnet-2-registration'],
      now,
    });
    const contest = city.rooms.find((room) => room.room === 'mb-sonnet-2-registration');
    assert.ok(contest, 'the contest room is missing from the city');
    assert.equal(contest.volume, 95_941);
    assert.equal(contest.surveyLastSeq, null, 'it should be clear the survey said nothing');
  });

  it('prefers a direct reading to the survey for the message count', () => {
    const readings = new Map([['lobby', reading('lobby', { lastSeq: 41_000_500 })]]);
    const city = buildCity({ survey: [summary('lobby', 41_000_000)], readings, watched: ['lobby'], now });
    assert.equal(city.rooms[0].volume, 41_000_500);
    assert.equal(city.rooms[0].volumeRead, true);
  });

  it('adds up only the rates it actually measured', () => {
    const readings = new Map([
      ['a', reading('a', { lastSeq: 10, ratePerMin: 100, rateSpanMs: 60_000 })],
      ['b', reading('b', { lastSeq: 10, ratePerMin: 50, rateSpanMs: 60_000 })],
      ['c', reading('c', { lastSeq: 10 })], // read, not yet measured
    ]);
    const city = buildCity({ survey: [], readings, watched: ['a', 'b', 'c'], now });
    assert.equal(city.watchedRate, 150);
    assert.equal(city.watchedCounts.measured, 2);
  });

  it('has no rate at all until something has been measured', () => {
    const city = buildCity({ survey: [summary('lobby', 41_000_000)], readings: new Map(), watched: ['lobby'], now });
    assert.equal(city.watchedRate, null, 'zero would read as "nothing is happening"');
  });
});

describe('survey lag', () => {
  const base = { survey: [] as RoomSummary[], readings: new Map<string, Reading>(), watched: [] as string[], now: 0 };

  it('converts the message gap into minutes, using the measured rate', () => {
    const city = buildCity({
      ...base,
      survey: [summary('lobby', 41_000_000)],
      readings: new Map([
        ['lobby', reading('lobby', { lastSeq: 41_006_000, ratePerMin: 1_000, rateSpanMs: 60_000 })],
      ]),
      watched: ['lobby'],
      now: 1_700_000_000_000,
    });
    // 6,000 messages behind at 1,000 a minute is six minutes.
    assert.equal(city.surveyLag.ms, 6 * 60_000);
    assert.equal(city.surveyLag.samples, 1);
  });

  it('takes the median, so one room that burst cannot drag the answer', () => {
    const rooms = ['a', 'b', 'c'];
    const city = buildCity({
      ...base,
      survey: rooms.map((room) => summary(room, 1_000)),
      readings: new Map(
        rooms.map((room, i) => [
          room,
          reading(room, { lastSeq: 1_000 + [100, 100, 100_000][i], ratePerMin: 100, rateSpanMs: 60_000 }),
        ])
      ),
      watched: rooms,
      now: 1_700_000_000_000,
    });
    assert.equal(city.surveyLag.ms, 60_000, 'the outlier should not move the median');
    assert.equal(city.surveyLag.samples, 3);
  });

  it('says nothing rather than guessing, with no rate to convert with', () => {
    const city = buildCity({
      ...base,
      survey: [summary('lobby', 41_000_000)],
      readings: new Map([['lobby', reading('lobby', { lastSeq: 41_006_000 })]]),
      watched: ['lobby'],
      now: 1_700_000_000_000,
    });
    assert.equal(city.surveyLag.ms, null);
    assert.equal(city.surveyLag.samples, 0);
  });

  it('ignores a room where the survey is somehow ahead', () => {
    const rooms = estimateSurveyLag([
      {
        room: 'lobby',
        districtId: 'commons',
        x: 0,
        z: 0,
        height: 1,
        volume: 100,
        volumeRead: true,
        activity: 0,
        activityBasis: 'read',
        state: 'live',
        watched: true,
        ratePerMin: 10,
        rateSpanMs: 60_000,
        newestTsMs: null,
        readAt: null,
        error: null,
        bytes: null,
        ringFill: null,
        idleSeconds: null,
        topic: null,
        zeroResponseShare: null,
        nickDiversity: null,
        surveyLastSeq: 200,
      },
    ]);
    assert.equal(rooms.ms, null);
  });
});
