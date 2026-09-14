// npm test — vitest
//
// The mirror worker's gatekeeping, tested against recorded fixtures. No
// database and no network: these cover the decision of what is allowed into the
// archive, which is the part that has to be right before anything is captured.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseRecord, normalizeMessage } from '../src/lib/technocore';
import {
  verifyBatch,
  MIRROR_ROOMS,
  classifyRingStart,
  storedMissing,
} from '../services/notary/src/mirror';
import { LOSS_KINDS } from '../services/notary/src/archive';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ROOM = 'mb-sonnet-2-registration';

const load = (name) =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => normalizeMessage(parseRecord(l), ROOM));

const receipts = load('registration-receipts.jsonl');
const requests = load('registration-requests.jsonl');
const forged = load('forged-synthetic.jsonl');

describe('what the mirror lets into the archive', () => {
  test('validly signed messages are captured', async () => {
    const batch = requests.slice(0, 10);
    const kept = await verifyBatch(batch, ROOM);
    assert.equal(kept.length, batch.length);
    assert.equal(kept[0].source, 'mirrored');
    assert.equal(kept[0].room, ROOM);
    assert.equal(kept[0].did, batch[0].from);
  });

  test('referee receipts are captured like anything else', async () => {
    const kept = await verifyBatch(receipts.slice(0, 5), ROOM);
    assert.equal(kept.length, 5);
  });

  test('the nonce stays a string, never a number', async () => {
    const kept = await verifyBatch(requests.slice(0, 5), ROOM);
    for (const record of kept) {
      assert.equal(typeof record.nonce, 'string');
      assert.match(record.nonce, /^[0-9]{1,19}$/);
    }
    // The fixture nonces are past 2^53 in magnitude of digits; going through a
    // double would change them, and the stored record would stop verifying.
    const viaNumber = String(Number(kept[0].nonce));
    assert.equal(kept[0].nonce, viaNumber, 'fixture sanity: these happen to be safe integers');
    assert.equal(typeof kept[0].nonce, 'string', 'but the type is what protects the ones that are not');
  });

  test('a nonce beyond 2^53 survives intact', async () => {
    const big = '17891667804471234567';
    const record = parseRecord(`{"seq":1,"ts":"2026-09-12T00:00:00Z","from":"x","text":"t","nonce":${big},"sig":"s"}`);
    assert.equal(record.nonce, big, 'technocore.js keeps it a string');
    assert.notEqual(String(Number(big)), big, 'and a double would not');
  });

  test('text is stored exactly as received, never normalised', async () => {
    const kept = await verifyBatch(requests.slice(0, 3), ROOM);
    for (let i = 0; i < kept.length; i++) {
      assert.equal(kept[i].text, requests[i].text);
    }
  });

  test('the room timestamp is kept alongside, as its own field', async () => {
    const kept = await verifyBatch(requests.slice(0, 1), ROOM);
    assert.equal(kept[0].sourceTs, requests[0].ts);
    assert.equal(kept[0].sourceSeq, requests[0].seq);
  });

  test('unsigned messages are skipped', async () => {
    const kept = await verifyBatch([{ ...requests[0], sig: null }], ROOM);
    assert.deepEqual(kept, []);
  });

  test('a message with no did:key sender is skipped', async () => {
    const kept = await verifyBatch([{ ...requests[0], from: 'not-a-did' }], ROOM);
    assert.deepEqual(kept, []);
  });

  test('a tampered message is skipped — an unverifiable record proves nothing', async () => {
    const tampered = { ...requests[0], text: requests[0].text + ' ' };
    assert.deepEqual(await verifyBatch([tampered], ROOM), []);
  });

  test('a signature that does not match its sender is skipped', async () => {
    // seq 900002 carries the referee DID with a signature that does not verify.
    const bad = forged.find((m) => m.seq === 900002);
    assert.deepEqual(await verifyBatch([bad], ROOM), []);
  });

  test('an impostor with a valid self-signature IS captured, and that is correct', async () => {
    // seq 900001 is signed correctly by a key that is not the referee. For the
    // contest tracker that is a forgery; for the archive it is simply a message
    // that key really did sign, which is all Notary ever claims.
    const impostor = forged.find((m) => m.seq === 900001);
    const kept = await verifyBatch([impostor], ROOM);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].did, impostor.from);
  });

  test('verification is per-room: the same message under another room name fails', async () => {
    // The room is half the canonical string, so a record filed under the wrong
    // room would not re-verify and must not be stored.
    assert.deepEqual(await verifyBatch([requests[0]], 'lobby'), []);
  });
});

describe('rooms to mirror', () => {
  test('the busy public rooms and the sonnet-2 rooms are all covered', () => {
    for (const room of ['lobby', 'technocore', 'kibble', 'flop-network', 'tclk-offers', 'ashflop', 'meta']) {
      assert.ok(MIRROR_ROOMS.includes(room), room);
    }
    assert.ok(MIRROR_ROOMS.includes('mb-sonnet-2-registration'));
    assert.ok(MIRROR_ROOMS.includes('d-sonnet-2-rules'));
  });

  test('the fastest-rotating room is backfilled first', () => {
    assert.equal(MIRROR_ROOMS[0], 'lobby');
  });

  test('no room is listed twice', () => {
    assert.equal(new Set(MIRROR_ROOMS).size, MIRROR_ROOMS.length);
  });
});

// ---------------------------------------------------------------------------

import { reduceToSightings, policyFor, isFullRoom, POLICY, DEFAULT_POLICY } from '../services/notary/src/policy';

const sighting = (did, seq, ts) => ({
  did,
  room: 'lobby',
  nonce: String(seq),
  sig: 's',
  text: 't',
  source: 'mirrored',
  sourceTs: ts,
  sourceSeq: seq,
});

describe('capture policy', () => {
  test('the rooms that carry evidence are kept whole', () => {
    for (const room of [
      'technocore',
      'flop-network',
      'd-sonnet-2-rules',
      'mb-sonnet-2-registration',
      'mb-sonnet-2-votes',
      'mb-sonnet-2-submissions',
    ]) {
      assert.equal(policyFor(room), POLICY.FULL, room);
      assert.equal(isFullRoom(room), true, room);
    }
  });

  test('the high-volume rooms are sampled', () => {
    for (const room of ['lobby', 'meta', 'kibble', 'ashflop', 'tclk-offers']) {
      assert.equal(policyFor(room), POLICY.SIGHTINGS, room);
      assert.equal(isFullRoom(room), false, room);
    }
  });

  test('an unlisted room is sampled, so a new busy room cannot eat the disk', () => {
    assert.equal(policyFor('some-room-nobody-configured'), DEFAULT_POLICY);
    assert.equal(DEFAULT_POLICY, POLICY.SIGHTINGS);
  });

  test('a sonnet-2 team room is kept whole even though it is unlisted', () => {
    assert.equal(isFullRoom('d-sonnet-2-team-emberwick'), true);
  });
});

describe('reducing a sampled room to sightings', () => {
  const DAY = '2026-09-12T';

  test('one DID posting many times in a day yields first and last only', () => {
    const out = reduceToSightings([
      sighting('did:a', 10, `${DAY}01:00:00Z`),
      sighting('did:a', 20, `${DAY}02:00:00Z`),
      sighting('did:a', 30, `${DAY}03:00:00Z`),
      sighting('did:a', 40, `${DAY}04:00:00Z`),
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((r) => [r.sighting, r.sourceSeq]),
      [['first', 10], ['last', 40]]
    );
  });

  test('a DID seen once in a day yields one row, not a duplicated pair', () => {
    const out = reduceToSightings([sighting('did:a', 10, `${DAY}01:00:00Z`)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].sighting, 'first');
  });

  test('order of arrival does not matter', () => {
    const shuffled = reduceToSightings([
      sighting('did:a', 30, `${DAY}03:00:00Z`),
      sighting('did:a', 10, `${DAY}01:00:00Z`),
      sighting('did:a', 20, `${DAY}02:00:00Z`),
    ]);
    assert.deepEqual(
      shuffled.map((r) => [r.sighting, r.sourceSeq]),
      [['first', 10], ['last', 30]]
    );
  });

  test('each DID is counted separately', () => {
    const out = reduceToSightings([
      sighting('did:a', 10, `${DAY}01:00:00Z`),
      sighting('did:b', 11, `${DAY}01:00:01Z`),
      sighting('did:a', 12, `${DAY}01:00:02Z`),
    ]);
    assert.equal(out.filter((r) => r.did === 'did:a').length, 2);
    assert.equal(out.filter((r) => r.did === 'did:b').length, 1);
  });

  test('days are split by when the message was posted, not when it was captured', () => {
    // This is the one that matters: a backfill reads several days at once, and
    // grouping by capture time would collapse them into a single day.
    const out = reduceToSightings([
      sighting('did:a', 10, '2026-09-10T23:00:00Z'),
      sighting('did:a', 20, '2026-09-11T01:00:00Z'),
      sighting('did:a', 30, '2026-09-11T23:00:00Z'),
      sighting('did:a', 40, '2026-09-12T01:00:00Z'),
    ]);
    const days = [...new Set(out.map((r) => r.activityDay))].sort();
    assert.deepEqual(days, ['2026-09-10', '2026-09-11', '2026-09-12']);
    const eleventh = out.filter((r) => r.activityDay === '2026-09-11');
    assert.deepEqual(eleventh.map((r) => r.sourceSeq).sort((a, b) => a - b), [20, 30]);
  });

  test('the stored record is still the original, verbatim', () => {
    const original = sighting('did:a', 10, `${DAY}01:00:00Z`);
    original.text = '{"type":"sonnet.note.v1"}';
    original.sig = 'AAAA';
    const [kept] = reduceToSightings([original]);
    assert.equal(kept.text, original.text);
    assert.equal(kept.sig, original.sig);
    assert.equal(kept.nonce, original.nonce);
    assert.equal(typeof kept.nonce, 'string');
  });

  test('the reduction on a real room is the storage saving it claims', () => {
    // 400 messages from 20 DIDs across one day reduce to at most 40 rows.
    const many = [];
    for (let i = 0; i < 400; i++) {
      many.push(sighting(`did:${i % 20}`, 1000 + i, `${DAY}${String(i % 24).padStart(2, '0')}:00:00Z`));
    }
    const out = reduceToSightings(many);
    assert.ok(out.length <= 40, `expected at most 40 rows, got ${out.length}`);
    assert.equal(new Set(out.map((r) => r.did)).size, 20, 'every DID is still represented');
  });
});

// ---------------------------------------------------------------------------

/**
 * Loss accounting, which this archive got wrong in production.
 *
 * The coverage endpoint summed `missing` across every gap kind. 'rotated' marks
 * where a room's coverage BEGINS — history that had already gone before Notary
 * looked, which nobody captured and nobody can measure — and detectGap gives one
 * of those rows a `missing` of firstSeq - 1. So every restart that polled a room
 * from zero wrote another row claiming the room's whole history as freshly lost,
 * and the totals added them up: three kibble rows inside six hours, each
 * asserting the same 6.4M messages, against a room that does not produce 6.4M
 * messages in six hours. The headline read 8% held where the honest figure was
 * 18%.
 *
 * Two rules came out of it and both are tested here, because both are the kind
 * that live in a comment and get contradicted a month later:
 *
 *   a 'rotated' row never carries a count, and
 *   only 'missed' and 'downtime' are ever summed.
 *
 * The third fix was recording the downtime span at all. It used to be written as
 * another 'rotated' row with a null count, so the one number that WAS knowable —
 * the distance between the last message stored and where the ring had moved to —
 * was recorded as zero while the unknowable one was recorded as millions.
 */
describe('loss accounting', () => {
  test('a rotated row never carries a count, whatever it was handed', () => {
    // detectGap's own shape for a first read: a real number, and a trap.
    assert.equal(
      storedMissing({ kind: 'rotated', expected: 1, firstSeq: 6_442_524, missing: 6_442_523 }),
      null
    );
    assert.equal(storedMissing({ kind: 'rotated', firstSeq: 5_346_707, missing: null }), null);
  });

  test('the kinds that are loss keep their counts', () => {
    assert.equal(storedMissing({ kind: 'missed', expected: 100, firstSeq: 350, missing: 250 }), 250);
    assert.equal(storedMissing({ kind: 'downtime', expected: 100, firstSeq: 350, missing: 250 }), 250);
  });

  test('only missed and downtime are summable', () => {
    assert.deepEqual([...LOSS_KINDS], ['missed', 'downtime']);
    assert.ok(!LOSS_KINDS.includes('rotated' as never), 'rotated is where coverage starts, not loss');
    assert.ok(
      !LOSS_KINDS.includes('regenerated' as never),
      'a recreated room is not messages Notary lost'
    );
  });

  test('a first look at a room that has already turned is not loss', () => {
    const gap = classifyRingStart({ resumeFrom: 0, firstSeq: 6_442_524 });
    assert.equal(gap?.kind, 'rotated');
    assert.equal(gap?.missing, null, 'how much came before coverage is not knowable');
  });

  test('a restart that the ring has outrun is loss, and the span is exact', () => {
    // Real numbers: kibble stored up to 5,365,726 and came back to a ring
    // starting at 6,182,191.
    const gap = classifyRingStart({ resumeFrom: 5_365_726, firstSeq: 6_182_191 });
    assert.equal(gap?.kind, 'downtime');
    assert.equal(gap?.missing, 816_464);
    assert.equal(gap?.expected, 5_365_727, 'the hole starts at the next message it should have had');
  });

  test('a restart the ring still reaches writes nothing at all', () => {
    // This is what used to write a 'rotated' row per restart per room, which is
    // why the table grew a thousand rows and the total grew with it.
    assert.equal(classifyRingStart({ resumeFrom: 900, firstSeq: 901 }), null);
    assert.equal(classifyRingStart({ resumeFrom: 900, firstSeq: 400 }), null);
    assert.equal(classifyRingStart({ resumeFrom: 0, firstSeq: 1 }), null, 'a whole ring is no hole');
  });

  test('the three categories cannot be added into one number', () => {
    // The real table on 2026-09-14, reduced to one row per kind.
    const HELD = 1_271_363;
    const rows = [
      { kind: 'missed', missing: 536_452, recovered: 0 },
      { kind: 'downtime', missing: 5_176_431, recovered: 0 },
      { kind: 'rotated', missing: 24_116_673, recovered: 0 },
    ];
    const sum = (rs: typeof rows) => rs.reduce((n, r) => n + Math.max(0, r.missing - r.recovered), 0);
    const pct = (lost: number) => ((HELD / (HELD + lost)) * 100).toFixed(1);

    const lost = sum(rows.filter((r) => LOSS_KINDS.includes(r.kind as never)));
    assert.equal(lost, 5_712_883, 'missed plus downtime, and nothing else');
    assert.equal(pct(lost), '18.2');

    // What the endpoint actually reported before the fix. The downtime row is
    // NOT in this sum: those spans were being written as 'rotated' with a null
    // count, so they contributed nothing. The archive was simultaneously
    // counting 24M it had never been responsible for and 0 of the 5.1M it had.
    assert.equal(pct(sum(rows.filter((r) => r.kind !== 'downtime'))), '4.9', 'the bug, for the record');

    // And the other half of it: had downtime been recorded correctly while
    // rotated was still being summed, the answer would have been wronger still.
    assert.equal(pct(sum(rows)), '4.1');
  });
});
