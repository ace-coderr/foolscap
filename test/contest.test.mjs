// node --test test/
//
// Every fixture in test/fixtures is a byte-exact recording from technocore.chat
// taken on 2026-09-11, except forged-synthetic.jsonl, which is generated (the
// signatures in it are real Ed25519 signatures, so the forgeries are exactly as
// convincing as an attacker's would be). Nothing here touches the network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseRecord, normalizeMessage } from '../js/technocore.js';
import {
  REFEREE_DID,
  ROOMS,
  KIND,
  STATUS,
  LIVENESS,
  COPY,
  classify,
  parsePayload,
  isActionable,
  ReceiptIndex,
  IntakeStats,
  ContestTracker,
} from '../js/contest.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(name, room) {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => normalizeMessage(parseRecord(line), room));
}

const REG = ROOMS.registration;
const receiptsFixture = load('registration-receipts.jsonl', REG);
const requestsFixture = load('registration-requests.jsonl', REG);
const windowFixture = load('registration-window.jsonl', REG);
const pendingFixture = load('registration-pending.jsonl', REG);
const rulesFixture = load('rules.jsonl', ROOMS.rules);
const submissionsFixture = load('submissions.jsonl', ROOMS.submissions);
const forgedRegistration = load('forged-synthetic.jsonl', REG).filter((m) => m.seq !== 900003);
const forgedRules = load('forged-synthetic.jsonl', ROOMS.rules).filter((m) => m.seq === 900003);

/** The moment just after the last recorded message, used as "now" throughout. */
const NOW = Date.parse('2026-09-11T23:58:30Z');
const MINUTE = 60_000;

const intakeOf = (message) => parsePayload(message.text).intake_seq;

/** The window fixture carries its own receipts; these are the requests only. */
const windowRequests = windowFixture.filter((m) => m.from !== REFEREE_DID);

/** Rewind the receipt stream to the moment intake reached `intakeSeq`. */
const receiptsUpTo = (intakeSeq) => receiptsFixture.filter((m) => intakeOf(m) <= intakeSeq);

async function trackerWith(batches, options) {
  const tracker = new ContestTracker(options);
  for (const [messages, room] of batches) await tracker.ingest(messages, room);
  return tracker;
}

// ---------------------------------------------------------------------------

describe('the pinned referee', () => {
  test('is hardcoded to the DID from LAUNCH.md', () => {
    assert.equal(REFEREE_DID, 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte');
  });

  test('the rules room is owned by it in the recording, but that is not why it is trusted', () => {
    // Every message in the rules room happens to be from the referee. The point
    // of the assertion is the next one: authority comes from the signature.
    assert.ok(rulesFixture.every((m) => m.from === REFEREE_DID));
  });
});

describe('classify', () => {
  test('a real referee receipt verifies and is a receipt', async () => {
    const c = await classify(receiptsFixture.at(-1), { room: REG });
    assert.equal(c.kind, KIND.RECEIPT);
    assert.equal(c.verified, true);
    assert.equal(c.type, 'sonnet.receipt.v1');
    assert.equal(typeof c.receipt.intakeSeq, 'number');
    assert.equal(typeof c.receipt.receivedAtMs, 'number');
  });

  test('every recorded receipt verifies against the pinned DID', async () => {
    const kinds = new Set();
    for (const message of receiptsFixture) {
      kinds.add((await classify(message, { room: REG })).kind);
    }
    assert.deepEqual([...kinds], [KIND.RECEIPT]);
  });

  test('a participant request is actionable', async () => {
    const c = await classify(requestsFixture[0], { room: REG });
    assert.equal(c.kind, KIND.REQUEST);
    assert.equal(c.type, 'sonnet.register.v1');
    assert.ok(c.requestId);
    assert.equal(c.verified, null, 'requests are counted, not believed, so they are not verified by default');
  });

  test('requests are verified on request', async () => {
    const c = await classify(requestsFixture[0], { room: REG, verifyRequests: true });
    assert.equal(c.verified, true);
  });

  test('the referee status post is a referee notice, not a receipt', async () => {
    const c = await classify(rulesFixture.at(-1), { room: ROOMS.rules });
    assert.equal(c.kind, KIND.REFEREE_NOTICE);
    assert.equal(c.verified, true);
    assert.equal(c.payload.subject, 'referee status');
  });

  test('non-JSON from a participant is chatter', async () => {
    const c = await classify({ ...requestsFixture[0], text: 'hello room' }, { room: REG });
    assert.equal(c.kind, KIND.CHATTER);
  });

  test('non-JSON carrying the referee DID is a forgery, not chatter', async () => {
    // The text is covered by the signature, so anything sent under the referee's
    // DID that does not verify has been altered or fabricated.
    const c = await classify({ ...receiptsFixture[0], text: 'hello room' }, { room: REG });
    assert.equal(c.kind, KIND.FORGED_REFEREE);
    assert.equal(c.verified, false);
  });

  test('a non-sonnet JSON payload is chatter', async () => {
    const message = { ...requestsFixture[0], from: 'did:key:z6Mkabc', text: '{"type":"chat","body":"hi"}' };
    assert.equal((await classify(message, { room: REG })).kind, KIND.CHATTER);
    assert.equal(isActionable(message), false);
  });
});

describe('forgeries', () => {
  test('a receipt signed by the wrong key is a forgery, however valid its own signature', async () => {
    const impostor = forgedRegistration.find((m) => m.seq === 900001);
    const c = await classify(impostor, { room: REG });

    assert.equal(c.kind, KIND.FORGED_RECEIPT);
    assert.equal(c.verified, false);
    assert.equal(c.forgery.reason, 'wrong-signer');
    assert.equal(c.forgery.selfSignatureValid, true, 'this is the sonnet-1 attack: a perfectly signed lie');
    assert.match(c.forgery.detail, /not the pinned referee DID/);
  });

  test('a tampered receipt carrying the referee DID is a forgery', async () => {
    const tampered = forgedRegistration.find((m) => m.seq === 900002);
    assert.equal(tampered.from, REFEREE_DID);

    const c = await classify(tampered, { room: REG });
    assert.equal(c.kind, KIND.FORGED_RECEIPT);
    assert.equal(c.verified, false);
    assert.equal(c.forgery.reason, 'signature-invalid');
    assert.equal(c.forgery.selfSignatureValid, false);
  });

  test('the specific verification failure is kept on the object, not in the prose', async () => {
    const tampered = forgedRegistration.find((m) => m.seq === 900002);
    const c = await classify(tampered, { room: REG });

    assert.ok(c.forgery.cause, 'the underlying failure must survive somewhere');
    // One sentence rendered; the cause does not double it up.
    assert.equal(c.forgery.detail.match(/\./g).length, 1);
    assert.ok(!c.forgery.detail.includes(c.forgery.cause));
  });

  test('a specific failure, not just a mismatch, reaches the cause', async () => {
    const tampered = forgedRegistration.find((m) => m.seq === 900002);
    const c = await classify({ ...tampered, sig: null }, { room: REG });

    assert.equal(c.forgery.reason, 'signature-invalid');
    assert.match(c.forgery.cause, /carries no signature/);
  });

  test('an impostor whose own signature is valid has no verification failure to report', async () => {
    const impostor = forgedRegistration.find((m) => m.seq === 900001);
    const c = await classify(impostor, { room: REG });

    assert.equal(c.forgery.selfSignatureValid, true);
    assert.equal(c.forgery.cause, null);
  });

  test('an impostor status post is a forged referee message, not ordinary traffic', async () => {
    // A status post is a shape only the referee legitimately produces, so the
    // signer is checked even though nothing here claims to be a receipt.
    const c = await classify(forgedRules[0], { room: ROOMS.rules });
    assert.equal(c.kind, KIND.FORGED_REFEREE);
    assert.equal(c.verified, false);
    assert.equal(c.forgery.reason, 'wrong-signer');
    assert.equal(c.forgery.selfSignatureValid, true);
  });

  test('an impostor status post is not counted as queue depth', async () => {
    const tracker = await trackerWith([[forgedRules, ROOMS.rules]]);
    assert.equal(tracker.counts.requests, 0);
    assert.equal(tracker.counts.forgeries, 1);
  });

  test('a forged acceptance never becomes an answer', async () => {
    const tracker = await trackerWith([
      [pendingFixture, REG],
      [receiptsFixture, REG],
      [forgedRegistration, REG],
    ]);

    // The impostor receipt claims ace-reg-writer-1 was accepted.
    const result = tracker.lookup('ace-reg-writer-1', { nowMs: NOW });
    assert.notEqual(result.status, STATUS.ACCEPTED);
    assert.equal(result.status, STATUS.UNANSWERED);
    assert.equal(tracker.receipts.byRequestId('ace-reg-writer-1'), null);
    assert.equal(tracker.forgeries.length, 2);
  });
});

describe('ReceiptIndex', () => {
  test('is built only from verified receipts', async () => {
    const index = new ReceiptIndex();
    for (const message of [...receiptsFixture, ...forgedRegistration]) {
      index.add(await classify(message, { room: REG }));
    }
    assert.equal(index.size, receiptsFixture.length);
    assert.equal(index.forgeries.length, 2);
  });

  test('is keyed by request_id and by sender_did', async () => {
    const index = new ReceiptIndex();
    for (const message of receiptsFixture) index.add(await classify(message, { room: REG }));

    const sample = index.all[0];
    assert.equal(index.byRequestId(sample.requestId), sample);
    assert.ok(index.bySenderDid(sample.senderDid).includes(sample));
    assert.equal(index.byRequestId('no-such-request'), null);
    assert.deepEqual(index.bySenderDid('did:key:z6Mknothing'), []);
  });

  test('a repeated receipt keeps the original and is counted as a duplicate', async () => {
    const index = new ReceiptIndex();
    const c = await classify(receiptsFixture[0], { room: REG });
    assert.equal(index.add(c), true);
    assert.equal(index.add(c), false);
    assert.equal(index.size, 1);
    assert.equal(index.duplicates, 1);
  });
});

describe('IntakeStats', () => {
  const stats = (() => {
    const s = new IntakeStats();
    for (const message of receiptsFixture) {
      const payload = parsePayload(message.text);
      s.addReceipt({
        intakeSeq: payload.intake_seq,
        receivedAt: payload.received_at,
        receivedAtMs: Math.round(payload.received_at * 1000),
      });
    }
    return s;
  })();

  test('the frontier is the highest intake_seq and its received_at', () => {
    const expected = receiptsFixture.reduce(
      (best, m) => (intakeOf(m) > intakeOf(best) ? m : best),
      receiptsFixture[0]
    );
    const payload = parsePayload(expected.text);

    assert.equal(stats.frontier.intakeSeq, payload.intake_seq);
    assert.equal(stats.frontier.receivedAtMs, Math.round(payload.received_at * 1000));
    assert.equal(stats.frontier.intakeSeq, 8774);
    assert.equal(
      new Date(stats.frontier.receivedAtMs).toISOString(),
      '2026-09-11T23:58:15.312Z'
    );
  });

  test('throughput matches the rate observed in the recording', () => {
    const t = stats.throughput();
    assert.ok(t.samples > 200, `expected a healthy sample, got ${t.samples}`);
    assert.ok(t.median > 24 && t.median < 30, `median ${t.median} outside the recorded ~27/min`);
  });

  test('throughput is trimmed, not a first-to-last slope', () => {
    const t = stats.throughput();
    assert.ok(t.p25 <= t.median && t.median <= t.p75);
    assert.ok(t.p75 - t.p25 > 0, 'the quartiles must actually spread, or the ETA has no range');
  });

  test('a burst does not drag the median, where a naive slope would be dragged', () => {
    const bursty = new IntakeStats();
    const start = Date.parse('2026-09-11T23:00:00Z');
    // Ten minutes at a steady 20/min...
    for (let i = 0; i <= 200; i++) {
      bursty.addReceipt({ intakeSeq: i, receivedAtMs: start + i * 3000 });
    }
    // ...then 400 items dumped in ten seconds.
    for (let i = 1; i <= 400; i++) {
      bursty.addReceipt({ intakeSeq: 200 + i, receivedAtMs: start + 600_000 + i * 25 });
    }

    const naive = 600 / ((610_000 - 0) / 60_000); // first-to-last slope: ~59/min
    const t = bursty.throughput({ sampleSize: 1000 });

    assert.ok(naive > 50, 'the fixture must actually be burst-shaped for this test to mean anything');
    assert.ok(t.median > 18 && t.median < 25, `median ${t.median} should stay near the steady 20/min`);
    assert.ok(t.median < naive / 2, 'the trimmed rate must not follow the burst');
  });

  test('aheadOf counts actionable messages between the frontier and a timestamp', () => {
    const s = new IntakeStats();
    s.addReceipt({ intakeSeq: 1, receivedAt: 1000, receivedAtMs: 1_000_000 });
    for (const tsMs of [900_000, 1_000_000, 1_500_000, 1_900_000, 2_000_000, 2_100_000]) {
      s.addActionable({ room: 'r', seq: tsMs, tsMs });
    }
    // Frontier at 1_000_000; counting strictly before 2_000_000.
    assert.equal(s.aheadOf(2_000_000), 3);
    assert.equal(s.aheadOf(1_000_000), 0, 'a message at the frontier has nothing ahead of it');
    assert.equal(s.aheadOf(999_999), 0, 'a message behind the frontier is not queued at all');
  });

  test('aheadOf ignores duplicate ingestion of the same message', () => {
    const s = new IntakeStats();
    s.addReceipt({ intakeSeq: 1, receivedAt: 1, receivedAtMs: 1000 });
    s.addActionable({ room: 'r', seq: 5, tsMs: 2000 });
    s.addActionable({ room: 'r', seq: 5, tsMs: 2000 });
    assert.equal(s.aheadOf(3000), 1);
  });

  test('with no receipts there is no frontier and no ETA', () => {
    const empty = new IntakeStats();
    assert.equal(empty.frontier, null);
    assert.equal(empty.aheadOf(NOW), null);
    assert.equal(empty.etaFor(NOW), null);
  });
});

describe('lookup', () => {
  test('an unknown request_id is NOT_SEEN', async () => {
    const tracker = await trackerWith([[receiptsFixture, REG]]);
    const result = tracker.lookup('nothing-like-this', { nowMs: NOW });
    assert.equal(result.status, STATUS.NOT_SEEN);
    assert.match(result.copy, /rotated out/);
  });

  test('an accepted request reports ACCEPTED', async () => {
    const tracker = await trackerWith([
      [requestsFixture, REG],
      [receiptsFixture, REG],
    ]);
    const accepted = receiptsFixture
      .map((m) => parsePayload(m.text))
      .find((p) => p.status === 'accepted' && tracker.lookup(p.request_id).entry.request);

    const result = tracker.lookup(accepted.request_id, { nowMs: NOW });
    assert.equal(result.status, STATUS.ACCEPTED);
    assert.equal(result.entry.receipt.intakeSeq, accepted.intake_seq);
    assert.equal(result.entry.reason, accepted.reason);
  });

  test('a rejected request reports REJECTED with the reason verbatim', async () => {
    const tracker = await trackerWith([
      [requestsFixture, REG],
      [receiptsFixture, REG],
    ]);
    const rejected = receiptsFixture
      .map((m) => parsePayload(m.text))
      .find((p) => p.status === 'rejected' && tracker.lookup(p.request_id).entry.request);

    const result = tracker.lookup(rejected.request_id, { nowMs: NOW });
    assert.equal(result.status, STATUS.REJECTED);
    assert.equal(result.entry.reason, rejected.reason);
    assert.equal(result.entry.reason, 'identity: verified pre-start evidence required');
    assert.match(result.copy, /NEW request_id/);
  });

  test('a receipt whose request has rotated out still answers', async () => {
    const tracker = await trackerWith([[receiptsFixture, REG]]);
    const payload = parsePayload(receiptsFixture.at(-1).text);
    const result = tracker.lookup(payload.request_id, { nowMs: NOW });

    assert.ok([STATUS.ACCEPTED, STATUS.REJECTED].includes(result.status));
    assert.equal(result.entry.request, null);
  });

  test('a DID lookup lists every request that DID made, newest first within rank', async () => {
    const tracker = await trackerWith([
      [requestsFixture, REG],
      [receiptsFixture, REG],
    ]);
    const didWithReceipt = parsePayload(receiptsFixture.at(-1).text).sender_did;
    const result = tracker.lookup(didWithReceipt, { nowMs: NOW });

    assert.equal(result.queryKind, 'did');
    assert.ok(result.entries.length >= 1);
    const rank = (e) => (e.status === STATUS.NO_RECEIPT_EXPECTED || e.status === STATUS.NOT_SEEN ? 0 : 1);
    for (let i = 1; i < result.entries.length; i++) {
      const [prev, cur] = [result.entries[i - 1], result.entries[i]];
      assert.ok(rank(prev) > rank(cur) || (rank(prev) === rank(cur) && prev.sortKey >= cur.sortKey));
    }
  });

  test('a queued request gets a position and an ETA range', async () => {
    // Rewind the recording: keep the requests, drop the receipts the referee had
    // not issued yet. That is exactly Foolscap's view at 23:48 — a real queue in
    // front of a real frontier.
    const tracker = await trackerWith([
      [receiptsUpTo(8508), REG],
      [windowRequests, REG],
    ]);

    const frontierMs = tracker.stats.frontier.receivedAtMs;
    const target = windowRequests.find(
      (m) => m.tsMs > frontierMs && parsePayload(m.text)?.request_id
    );
    assert.ok(target, 'the rewound recording must leave something queued');
    const result = tracker.lookup(parsePayload(target.text).request_id, { nowMs: NOW });

    assert.equal(result.status, STATUS.QUEUED);
    assert.ok(result.entry.eta.ahead >= 0);
    assert.equal(result.entry.eta.position, result.entry.eta.ahead + 1);
    assert.ok(result.entry.eta.fastestMinutes <= result.entry.eta.likelyMinutes);
    assert.ok(result.entry.eta.likelyMinutes <= result.entry.eta.slowestMinutes);
    assert.equal(result.entry.eta.estimate, true);
    assert.match(result.copy, /delay, not a rejection/);
    assert.match(result.copy, /jumps no queue/);
  });

  test('the queue depth matches an independent count of the fixture', async () => {
    const tracker = await trackerWith([
      [receiptsUpTo(8508), REG],
      [windowRequests, REG],
    ]);

    const frontierMs = tracker.stats.frontier.receivedAtMs;
    const lastMs = Math.max(...windowRequests.map((m) => m.tsMs));
    const expected = windowRequests.filter(
      (m) =>
        m.tsMs >= frontierMs &&
        m.tsMs < lastMs &&
        String(parsePayload(m.text)?.type ?? '').startsWith('sonnet.')
    ).length;

    assert.equal(tracker.stats.aheadOf(lastMs), expected);
    assert.ok(expected > 100, `the recorded window should hold a real queue, got ${expected}`);
  });

  test('overlapping batches are ingested once', async () => {
    const once = await trackerWith([[windowFixture, REG]]);
    const twice = await trackerWith([
      [windowFixture, REG],
      [windowFixture, REG],
    ]);
    assert.equal(twice.counts.requests, once.counts.requests);
    assert.equal(twice.stats.aheadOf(NOW), once.stats.aheadOf(NOW));
  });
});

describe('UNANSWERED — recorded live on 2026-09-11', () => {
  // mb-sonnet-2-registration seq 21925, posted 23:37:05Z, request_id
  // ace-reg-writer-1. The frontier passed 23:58 with receipts issued for
  // hundreds of requests either side of it, and this one was never answered.
  const REQUEST_ID = 'ace-reg-writer-1';
  const SENDER = 'did:key:z6Mko5gbL5nHyfofMpxdVPFWChStScejMzJ3HtPRUzKdkEnd';

  const tracked = () => trackerWith([
    [pendingFixture, REG],
    [receiptsFixture, REG],
  ]);

  test('the fixture is what it claims to be', () => {
    const message = pendingFixture.find((m) => m.seq === 21925);
    assert.equal(message.ts, '2026-09-11T23:37:05.336805Z');
    assert.equal(message.from, SENDER);
    assert.equal(parsePayload(message.text).request_id, REQUEST_ID);
    assert.equal(parsePayload(message.text).role, 'writer');
  });

  test('no receipt exists for it, by request_id or by sender_did', async () => {
    const tracker = await tracked();
    assert.equal(tracker.receipts.byRequestId(REQUEST_ID), null);
    assert.deepEqual(tracker.receipts.bySenderDid(SENDER), []);
  });

  test('it is behind the frontier, so it is UNANSWERED rather than QUEUED', async () => {
    const tracker = await tracked();
    const result = tracker.lookup(REQUEST_ID, { nowMs: NOW });

    assert.equal(result.status, STATUS.UNANSWERED);
    assert.equal(result.entry.unansweredKind, 'deferred');
    assert.ok(result.entry.behindFrontierMs > 20 * MINUTE);
    assert.equal(result.entry.eta, undefined, 'an unanswered request must not be given an ETA');
  });

  test('the same answer comes back from a DID lookup', async () => {
    const tracker = await tracked();
    const result = tracker.lookup(SENDER, { nowMs: NOW });
    assert.equal(result.status, STATUS.UNANSWERED);
    assert.equal(result.entry.requestId, REQUEST_ID);
  });

  test('the copy says pending reconciliation and forbids a fresh request_id', async () => {
    const tracker = await tracked();
    const { copy } = tracker.lookup(REQUEST_ID, { nowMs: NOW });

    assert.match(copy, /still pending reconciliation/);
    assert.match(copy, /delay, not a rejection/);
    assert.match(copy, /Do not re-post/);
    assert.match(copy, /do not mint a new request_id/);
    assert.match(copy, /identical retry with the same request_id returns the original receipt/);
    assert.match(copy, /jumps no queue/);
  });
});

describe('registrations the referee did not receipt individually', () => {
  // 16 real hourly notices recorded from mb-sonnet-2-registration on 2026-09-12.
  const notices = load('not-receipted-notices.jsonl', REG);
  const FIRST_NOTICE = Date.parse('2026-09-12T04:33:24.238529Z');
  const LAST_NOTICE = Date.parse('2026-09-12T19:36:12.575398Z');

  /** A registration that landed at `tsMs`, with a frontier already past it. */
  async function trackerFor({ role, tsMs, type = 'sonnet.register.v1' }) {
    const tracker = await trackerWith([[notices, REG]]);
    const payload = { type, contest_id: 'sonnet-2', role, request_id: 'probe-1' };
    if (type === 'sonnet.register.v1' && role === 'writer') {
      payload.x_account_url = 'https://x.com/probe';
    }
    await tracker.ingest(
      [{ room: REG, seq: 1, ts: new Date(tsMs).toISOString(), tsMs, from: 'did:key:z6MkProbe', text: JSON.stringify(payload), nonce: '1', sig: null }],
      REG
    );
    // Give it a frontier past the request so the lookup resolves to UNANSWERED.
    tracker.stats.addReceipt({ intakeSeq: 1, receivedAt: (tsMs + 60_000) / 1000, receivedAtMs: tsMs + 60_000 });
    return tracker;
  }

  test('the notices are parsed with their counts', async () => {
    const tracker = await trackerWith([[notices, REG]]);
    assert.equal(tracker.notReceiptedNotices.length, 16);
    const last = tracker.notReceiptedNotices.at(-1);
    assert.equal(last.count, 35);
    assert.equal(last.reason, 'identity: verified pre-start evidence required');
    assert.match(last.detail, /signed activity strictly before the opening/);
  });

  test('they are verified referee notices, not requests', async () => {
    const c = await classify(notices.at(-1), { room: REG });
    assert.equal(c.kind, KIND.REFEREE_NOTICE);
    assert.equal(c.verified, true);
  });

  test('an impostor cannot post one', async () => {
    const forged = { ...notices.at(-1), from: 'did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z' };
    const c = await classify(forged, { room: REG });
    assert.equal(c.kind, KIND.FORGED_REFEREE);
    assert.equal(c.verified, false);
  });

  test('the covering notice is the first one posted after the request', async () => {
    const tracker = await trackerWith([[notices, REG]]);
    const covering = tracker.noticeCovering(Date.parse('2026-09-12T16:00:00Z'));
    assert.equal(new Date(covering.tsMs).toISOString(), '2026-09-12T16:35:28.731Z');
    assert.equal(covering.count, 2221);
  });

  test('a request newer than every notice is not covered', async () => {
    const tracker = await trackerWith([[notices, REG]]);
    assert.equal(tracker.noticeCovering(LAST_NOTICE + 60_000), null);
  });

  test('a writer registration gets the notice as the likely explanation', async () => {
    const tracker = await trackerFor({ role: 'writer', tsMs: Date.parse('2026-09-12T16:00:00Z') });
    const result = tracker.lookup('probe-1');

    assert.equal(result.status, STATUS.UNANSWERED);
    assert.equal(result.entry.unansweredKind, 'not-receipted');
    assert.equal(result.entry.notice.count, 2221);
    assert.match(result.copy, /2,221 registrations in the window ending/);
    assert.match(result.copy, /identity: verified pre-start evidence required/);
  });

  test('it is worded as likely, never as a verdict on this request', async () => {
    const tracker = await trackerFor({ role: 'voter', tsMs: Date.parse('2026-09-12T16:00:00Z') });
    const { copy } = tracker.lookup('probe-1');

    assert.match(copy, /likely explanation/);
    assert.match(copy, /cannot confirm that this is what happened to this request/);
    assert.match(copy, /count, not a list of DIDs/);
    assert.match(copy, /rather than a verdict/);
    // It must not claim the request was rejected, or that it is finished.
    assert.ok(!/\bwas rejected\b/.test(copy));
    assert.ok(!/\bwill not be receipted\b/.test(copy));
  });

  test('it says what to do, without contradicting the retry advice', async () => {
    const tracker = await trackerFor({ role: 'writer', tsMs: Date.parse('2026-09-12T16:00:00Z') });
    const { copy } = tracker.lookup('probe-1');

    assert.match(copy, /organizer is the one role that does not require it/);
    assert.match(copy, /2026-09-11T12:00:00Z/);
    assert.match(copy, /Re-posting the same writer or voter registration changes nothing/);
    assert.match(copy, /identical retry returns the original receipt/);
    // Switching role is a different request, so it legitimately needs a new id.
    assert.match(copy, /different request and takes its own request_id/);
  });

  test('organizer registrations keep the plain wording', async () => {
    const tracker = await trackerFor({ role: 'organizer', tsMs: Date.parse('2026-09-12T16:00:00Z') });
    const result = tracker.lookup('probe-1');

    assert.equal(result.status, STATUS.UNANSWERED);
    assert.equal(result.entry.unansweredKind, 'deferred');
    assert.equal(result.copy, COPY.UNANSWERED);
  });

  test('other receipted request types keep the plain wording', async () => {
    // A ballot is receipted, so it still has a queue — but the registration
    // notice says nothing about it.
    const tracker = await trackerFor({
      role: 'writer',
      tsMs: Date.parse('2026-09-12T16:00:00Z'),
      type: 'sonnet.ballot.v1',
    });
    const result = tracker.lookup('probe-1');
    assert.equal(result.entry.unansweredKind, 'deferred');
    assert.equal(result.copy, COPY.UNANSWERED);
  });

  test('a writer registration older than every notice still keeps the plain wording when uncovered', async () => {
    const tracker = await trackerFor({ role: 'writer', tsMs: LAST_NOTICE + 120_000 });
    const result = tracker.lookup('probe-1');
    assert.equal(result.entry.unansweredKind, 'deferred');
    assert.equal(result.copy, COPY.UNANSWERED);
  });

  test('with no notices read at all, nothing is claimed', async () => {
    const tracker = new ContestTracker();
    await tracker.ingest(
      [{ room: REG, seq: 1, ts: '2026-09-12T16:00:00.000Z', tsMs: Date.parse('2026-09-12T16:00:00Z'), from: 'did:key:z6MkProbe', text: JSON.stringify({ type: 'sonnet.register.v1', role: 'writer', request_id: 'probe-1' }), nonce: '1', sig: null }],
      REG
    );
    tracker.stats.addReceipt({ intakeSeq: 1, receivedAt: 1789000000, receivedAtMs: Date.parse('2026-09-12T17:00:00Z') });
    const result = tracker.lookup('probe-1');
    assert.equal(result.entry.unansweredKind, 'deferred');
    assert.equal(result.copy, COPY.UNANSWERED);
    assert.ok(FIRST_NOTICE < LAST_NOTICE);
  });
});

describe('types the referee does not receipt', () => {
  // A real-shaped DID: looksLikeDid requires 40+ base58 characters, so a
  // placeholder would be read as a request_id and match nothing.
  const SENDER = 'did:key:z6MkjA8Br94B6hAbE8CgCKQjn7aDo7RcouBEzLu2DEHkwQRA';

  /** One posted message from SENDER, with a frontier already past it. */
  async function posted(payloads) {
    const tracker = new ContestTracker();
    const base = Date.parse('2026-09-12T16:00:00Z');
    const messages = payloads.map((payload, i) => ({
      room: REG,
      seq: 100 + i,
      ts: new Date(base + i * 1000).toISOString(),
      tsMs: base + i * 1000,
      from: SENDER,
      text: JSON.stringify(payload),
      nonce: String(i),
      sig: null,
    }));
    await tracker.ingest(messages, REG);
    tracker.stats.addReceipt({ intakeSeq: 1, receivedAt: 1789000000, receivedAtMs: base + 3_600_000 });
    return tracker;
  }

  test('a note is Posted, not Unanswered', async () => {
    const tracker = await posted([{ type: 'sonnet.note.v1', request_id: 'note-1' }]);
    const result = tracker.lookup('note-1');

    assert.equal(result.status, STATUS.NO_RECEIPT_EXPECTED);
    assert.equal(result.entry.knownUnreceipted, true);
    assert.match(result.copy, /does not issue receipts for sonnet\.note\.v1/);
    assert.match(result.copy, /no intake queue/);
  });

  test('a note is given no queue position, no frontier and no retry advice', async () => {
    const tracker = await posted([{ type: 'sonnet.note.v1', request_id: 'note-1' }]);
    const { entry, copy } = tracker.lookup('note-1');

    assert.equal(entry.eta, undefined);
    assert.equal(entry.behindFrontierMs, undefined);
    assert.ok(!/re-post/i.test(copy), 'nothing is pending, so there is nothing to warn against re-posting');
    assert.ok(!/request_id/.test(copy));
    assert.ok(!/frontier/i.test(copy));
  });

  test('every type the live rooms show unreceipted lands here', async () => {
    for (const type of ['sonnet.note.v1', 'sonnet.word.v1', 'sonnet.question.v1', 'sonnet.recruit.v1', 'sonnet.reply.v1', 'sonnet.application.v1']) {
      const tracker = await posted([{ type, request_id: 'x-1' }]);
      assert.equal(tracker.lookup('x-1').status, STATUS.NO_RECEIPT_EXPECTED, type);
    }
  });

  test('receipted types still get queue statuses', async () => {
    for (const type of ['sonnet.register.v1', 'sonnet.ballot.v1', 'sonnet.roster.v1', 'sonnet.invite.v1', 'sonnet.team-request.v1', 'sonnet.withdraw.v1', 'sonnet.claim.v1']) {
      const tracker = await posted([{ type, request_id: 'x-1', role: 'organizer' }]);
      const status = tracker.lookup('x-1').status;
      assert.ok(status === STATUS.UNANSWERED || status === STATUS.QUEUED, `${type} -> ${status}`);
    }
  });

  test('an unknown type is flagged as probably unanswered, and names the misspelling trap', async () => {
    // sonnet.registere.v1 is a real typo observed in the registration room.
    const tracker = await posted([{ type: 'sonnet.registere.v1', request_id: 'typo-1' }]);
    const result = tracker.lookup('typo-1');

    assert.equal(result.status, STATUS.NO_RECEIPT_EXPECTED);
    assert.equal(result.entry.knownUnreceipted, false);
    assert.match(result.copy, /seen the referee receipt no message of type sonnet\.registere\.v1/);
    assert.match(result.copy, /misspelled type posts successfully and is then ignored/);
  });

  test('a receipt still wins, whatever the type', async () => {
    // If the referee did answer it, that is the answer — the allowlist only
    // decides what to say when there is no receipt.
    const tracker = await posted([{ type: 'sonnet.note.v1', request_id: 'note-1' }]);
    tracker.receipts.add({
      kind: KIND.RECEIPT,
      verified: true,
      receipt: {
        intakeSeq: 5, receivedAt: 1789000000, receivedAtMs: Date.parse('2026-09-12T16:30:00Z'),
        requestId: 'note-1', senderDid: SENDER, participantDid: null, status: 'accepted',
        reason: '', role: null, room: REG, seq: 9, issuedAtMs: Date.parse('2026-09-12T16:30:00Z'), payload: {},
      },
    });
    assert.equal(tracker.lookup('note-1').status, STATUS.ACCEPTED);
  });

  test('a note does not outrank a registration as the DID headline', async () => {
    const tracker = await posted([
      { type: 'sonnet.register.v1', role: 'organizer', request_id: 'reg-1' },
      { type: 'sonnet.note.v1', request_id: 'note-1' }, // newer
    ]);
    const result = tracker.lookup(SENDER);

    assert.equal(result.entries.length, 2);
    assert.equal(result.entry.requestId, 'reg-1', 'the registration is what the user is asking about');
    assert.equal(result.status, STATUS.UNANSWERED);
    assert.equal(result.entries[1].requestId, 'note-1');
  });

  test('with only notes, the newest note is still the headline', async () => {
    const tracker = await posted([
      { type: 'sonnet.note.v1', request_id: 'note-1' },
      { type: 'sonnet.note.v1', request_id: 'note-2' },
    ]);
    const result = tracker.lookup(SENDER);
    assert.equal(result.entry.requestId, 'note-2');
    assert.equal(result.status, STATUS.NO_RECEIPT_EXPECTED);
  });
});

describe('submissions', () => {
  test('an unreceipted submission is never shown as a stuck queue', async () => {
    const tracker = await trackerWith([
      [submissionsFixture, ROOMS.submissions],
      [receiptsFixture, REG],
    ]);
    const result = tracker.lookup('submit-flopdropteam3-1', { nowMs: NOW });

    assert.equal(result.status, STATUS.UNANSWERED);
    assert.equal(result.entry.unansweredKind, 'submission');
    assert.equal(result.entry.eta, undefined);
    assert.equal(result.copy, COPY.UNANSWERED_SUBMISSION);
    assert.match(result.copy, /not a stuck queue/);
    assert.match(result.copy, /do not mint a new request_id/);
  });

  test('a submission that did get a receipt reports it', async () => {
    const tracker = await trackerWith([[submissionsFixture, ROOMS.submissions]]);
    const accepted = tracker.lookup('bub-submit-1', { nowMs: NOW });
    assert.equal(accepted.status, STATUS.ACCEPTED);

    const rejected = tracker.lookup('s2-submit-wakeverse-1789153740', { nowMs: NOW });
    assert.equal(rejected.status, STATUS.REJECTED);
    assert.equal(rejected.entry.reason, 'publication: unverified');
  });
});

describe('liveness', () => {
  const alive = () => trackerWith([
    [receiptsFixture, REG],
    [rulesFixture, ROOMS.rules],
  ]);

  test('live when receipts are landing and the frontier is current', async () => {
    const l = (await alive()).liveness(NOW);
    assert.equal(l.state, LIVENESS.LIVE);
    assert.ok(l.receipts5 > 0);
    assert.ok(l.receipts5 <= l.receipts15 && l.receipts15 <= l.receipts60);
    assert.ok(l.frontierLagMs < MINUTE);
  });

  test('lagging when the referee is posting but the frontier falls behind', async () => {
    const l = (await alive()).liveness(NOW + 11 * MINUTE);
    assert.equal(l.state, LIVENESS.LAGGING);
    assert.equal(l.receipts5, 0);
    assert.match(l.reasons.join(' '), /frontier is \d+ minutes behind/);
  });

  test('quiet when nothing verified has arrived for a while', async () => {
    const l = (await alive()).liveness(NOW + 40 * MINUTE);
    assert.equal(l.state, LIVENESS.QUIET);
    assert.ok(l.secondsSinceLastReferee > 15 * 60);
  });

  test('the frontier is stated in plain words', async () => {
    const tracker = await alive();
    assert.match(tracker.liveness(NOW).frontierSummary, /caught up/);
    assert.match(
      tracker.liveness(NOW + 41 * MINUTE).frontierSummary,
      /working on requests received 41 minutes ago/
    );
    assert.match(
      tracker.liveness(NOW + 121 * MINUTE).frontierSummary,
      /working on requests received 2 hours 1 minute ago/
    );
  });

  test('the 4-hourly signed status is found, with its age', async () => {
    const l = (await alive()).liveness(NOW);
    assert.equal(l.status.payload.subject, 'referee status');
    assert.ok(l.status.ageMs > 39 * MINUTE && l.status.ageMs < 41 * MINUTE);
    assert.equal(l.status.overdue, false);
    assert.equal(typeof l.status.counts.accepted, 'number');
  });

  test('the status goes overdue past four hours plus grace', async () => {
    const l = (await alive()).liveness(NOW + 5 * 60 * MINUTE);
    assert.equal(l.status.overdue, true);
  });

  test('forgeries are counted and reported but never move the light', async () => {
    const clean = (await alive()).liveness(NOW);
    const dirty = (
      await trackerWith([
        [receiptsFixture, REG],
        [rulesFixture, ROOMS.rules],
        [forgedRegistration, REG],
        [forgedRules, ROOMS.rules],
      ])
    ).liveness(NOW);

    assert.equal(dirty.state, clean.state);
    assert.equal(dirty.receipts5, clean.receipts5);
    assert.equal(dirty.frontier.intakeSeq, clean.frontier.intakeSeq);
    assert.equal(dirty.unverified, 3);
    assert.equal(dirty.forgeries.length, 3);
  });

  test('a forged-only view is never green', async () => {
    const tracker = await trackerWith([
      [forgedRegistration, REG],
      [forgedRules, ROOMS.rules],
    ]);
    const l = tracker.liveness(Date.parse('2026-09-12T00:21:30Z'));

    assert.equal(l.state, LIVENESS.QUIET);
    assert.equal(l.lastRefereeMessage, null);
    assert.equal(l.receipts60, 0);
    assert.equal(l.frontier, null);
    assert.equal(l.status, null);
    assert.equal(l.unverified, 3);
  });

  test('an impostor cannot advance the frontier', async () => {
    const tracker = await trackerWith([
      [receiptsFixture, REG],
      [forgedRegistration, REG],
    ]);
    // The impostor receipt claims intake_seq 99999.
    assert.equal(tracker.stats.frontier.intakeSeq, 8774);
  });
});
