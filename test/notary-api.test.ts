// npm test — vitest
//
// The Notary API, in the parts that can be tested without a database: the
// Merkle tree, the cutoff rule, the submission validator and the rate limiter.
// The mirror, the room list and the capture policy are next door in
// notary.test.ts; this file is the serving half.
//
// The cutoff tests are the ones that matter. NOTARY.md's sketch has
// `active_before: true|false`, and a `false` there would be Notary asserting
// that a key was inactive — which it cannot know and which the same document
// forbids two paragraphs earlier. The answer is therefore three-valued, and
// these tests exist to make the third value impossible to quietly collapse back
// into a boolean later.

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildProof,
  buildLevels,
  leafHash,
  leafPreimage,
  merkleRoot,
  rootFromProof,
  verifyProof,
} from '../services/notary/src/merkle.ts';
import { evaluateCutoff, CAVEAT, type RecordRow } from '../services/notary/src/archive.ts';
import { parseCapture, MAX_TEXT_BYTES, NOTARY_ROOM } from '../services/notary/src/api.ts';
import { RateLimiter, clientKey } from '../services/notary/src/ratelimit.ts';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------

describe('the Merkle tree', () => {
  test('the leaf is the documented preimage, and nothing else', () => {
    const record = {
      did: 'did:key:z6MkTest',
      room: 'lobby',
      nonce: '1789246401336',
      sig: 'QK3hSKqw',
      capturedAt: '2026-09-12T21:05:41.095Z',
    };
    assert.equal(
      leafPreimage(record),
      'did:key:z6MkTest|lobby|1789246401336|QK3hSKqw|2026-09-12T21:05:41.095Z'
    );
    assert.equal(leafHash(record), sha(leafPreimage(record)));
  });

  test('a single leaf is its own root', () => {
    assert.equal(merkleRoot(['aa']), 'aa');
  });

  test('a pair hashes in order', () => {
    assert.equal(merkleRoot(['aa', 'bb']), sha('aabb'));
  });

  test('an empty day has no root rather than a root over nothing', () => {
    // A fixed "empty" hash would let a day that HAD records be presented as
    // empty later, which is the one edit the anchor exists to catch.
    assert.equal(merkleRoot([]), null);
  });

  test('an odd node is promoted, so duplicating a leaf changes the root', () => {
    // The Bitcoin behaviour — duplicating the last node — makes [a, b] and
    // [a, b, b] collapse to the same root. Two different days' records sharing
    // a root would make the anchor meaningless for both.
    const two = merkleRoot(['aa', 'bb']);
    const three = merkleRoot(['aa', 'bb', 'bb']);
    assert.notEqual(two, three);
    assert.equal(three, sha(`${sha('aabb')}bb`));
  });

  test('every leaf in an awkwardly sized tree proves against the root', () => {
    // 1..33 leaves: covers powers of two, one over, one under, and the odd
    // promotions in the middle levels that a tidy size would never exercise.
    for (let size = 1; size <= 33; size++) {
      const leaves = Array.from({ length: size }, (_, i) => sha(`leaf-${size}-${i}`));
      const root = merkleRoot(leaves)!;
      for (let i = 0; i < size; i++) {
        const proof = buildProof(leaves, i)!;
        assert.ok(verifyProof(proof, root), `size ${size}, leaf ${i} failed to prove`);
      }
    }
  });

  test('a proof for the wrong leaf does not reach the root', () => {
    const leaves = Array.from({ length: 9 }, (_, i) => sha(`x${i}`));
    const root = merkleRoot(leaves)!;
    const proof = buildProof(leaves, 3)!;
    assert.notEqual(rootFromProof(sha('not-in-the-tree'), proof.steps), root);
  });

  test('an out-of-range index has no proof', () => {
    assert.equal(buildProof(['aa'], 1), null);
    assert.equal(buildProof(['aa'], -1), null);
  });

  test('the level count is what a binary tree over the leaves requires', () => {
    assert.equal(buildLevels(Array.from({ length: 8 }, (_, i) => `${i}`)).length, 4);
    assert.equal(buildLevels(Array.from({ length: 5 }, (_, i) => `${i}`)).length, 4);
  });
});

// ---------------------------------------------------------------------------

const record = (over: Partial<RecordRow> = {}): RecordRow => ({
  id: '1',
  did: 'did:key:z6MkTest',
  room: 'lobby',
  nonce: '1789246401336',
  sig: 'sig',
  text: 'hello',
  capturedAt: '2026-09-12T21:10:00.000Z',
  ...over,
});

/**
 * The cutoff answer, after the pivot.
 *
 * THIS SUITE LOST A STATE AND GOT STRONGER FOR IT. It used to cover three
 * answers, and the middle one — `claimed` — was the interesting one: the
 * archive held a signed message that the ROOM dated before the cutoff, so the
 * signature was real and the timestamp was somebody else's word. Notary
 * repeated it without vouching for it, and most of the care in this file went
 * into making sure a reader could not mistake the two.
 *
 * A witnessing service has no such case. The agent submits and Notary stamps,
 * seconds apart, and the stamp is the only timestamp on the record. So there
 * are two answers, both of them Notary's own, and the tests that used to guard
 * the distinction now guard its absence: nothing can come back `claimed`
 * because there is nowhere for a claimed time to enter.
 */
describe('the cutoff answer', () => {
  const CUTOFF = '2026-09-12T00:00:00Z';

  test('witnessed when Notary’s own clock beats the cutoff', () => {
    const result = evaluateCutoff({
      before: CUTOFF,
      firstCapturedAt: '2026-09-11T22:00:00.000Z',
      earliest: [record({ capturedAt: '2026-09-11T22:00:00.000Z' })],
    });
    assert.equal(result.answer, 'witnessed');
    assert.equal(result.witnessedBefore, '2026-09-11T22:00:00.000Z');
    assert.equal(result.evidenceRecordId, '1');
  });

  test('no-evidence is never spelled false, and never says inactive', () => {
    const result = evaluateCutoff({
      before: CUTOFF,
      firstCapturedAt: '2026-09-12T05:00:00.000Z',
      earliest: [record({ capturedAt: '2026-09-12T05:00:00.000Z' })],
    });
    // The type carries the distinction; a boolean would have thrown it away.
    assert.equal(result.answer, 'no-evidence');
    assert.equal(result.witnessedBefore, null);
    assert.equal(result.evidenceRecordId, null);
    assert.match(result.caveat, /never that the key was inactive/);
  });

  test('a key with nothing at all is still only no-evidence', () => {
    const result = evaluateCutoff({
      before: CUTOFF,
      firstCapturedAt: null,
      earliest: [],
    });
    assert.equal(result.answer, 'no-evidence');
    assert.equal(result.witnessedBefore, null);
    assert.equal(result.evidenceRecordId, null);
  });

  test('there is no third answer to reach', () => {
    // The guard on the pivot. `claimed` existed to carry a room's timestamp;
    // if one ever finds its way back into a record, this fails rather than
    // quietly serving somebody else's word as Notary's.
    for (const capturedAt of ['2026-09-10T00:00:00.000Z', '2026-09-30T00:00:00.000Z']) {
      const result = evaluateCutoff({
        before: CUTOFF,
        firstCapturedAt: capturedAt,
        earliest: [record({ capturedAt })],
      });
      assert.ok(
        result.answer === 'witnessed' || result.answer === 'no-evidence',
        `unexpected answer ${result.answer}`
      );
    }
  });

  test('every cutoff carries the caveat, whatever the answer', () => {
    for (const first of ['2026-09-11T00:00:00.000Z', '2026-09-30T00:00:00.000Z', null]) {
      const result = evaluateCutoff({
        before: CUTOFF,
        firstCapturedAt: first,
        earliest: [],
      });
      assert.equal(result.caveat, CAVEAT);
      assert.match(result.caveat, /never that the key was inactive/);
    }
  });

  test('a record exactly on the cutoff is not before it', () => {
    const result = evaluateCutoff({
      before: CUTOFF,
      firstCapturedAt: CUTOFF,
      earliest: [record({ capturedAt: CUTOFF })],
    });
    assert.equal(result.answer, 'no-evidence');
  });
});

describe('what /capture will accept', () => {
  const good = {
    did: 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte',
    nonce: '1789246401336',
    sig: 'a'.repeat(85) + 'A',
    text: 'hello',
  };

  test('a well-formed submission parses, and defaults the room', () => {
    const parsed = parseCapture(good);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.room, NOTARY_ROOM);
    assert.equal(parsed.value.nonce, '1789246401336');
  });

  test('the nonce stays a string', () => {
    const parsed = parseCapture({ ...good, nonce: '9007199254740993' });
    assert.ok(parsed.ok);
    // 2^53 + 1. Through a double it becomes ...992 and the signature over
    // <room>|<nonce>|<text> stops reproducing — the record would be unprovable.
    assert.equal(parsed.value.nonce, '9007199254740993');
    assert.equal(typeof parsed.value.nonce, 'string');
  });

  test('text is measured in bytes, not characters', () => {
    // 1,100 astral characters: 2,200 UTF-16 units, so `.length` is comfortably
    // under the limit, and 4,400 bytes, so the storage is over it. A check
    // written against `.length` would let this through.
    const astral = '𝔘'.repeat(1100);
    assert.ok(astral.length < MAX_TEXT_BYTES, 'the fixture must pass a length-based check');
    assert.ok(Buffer.byteLength(astral, 'utf8') > MAX_TEXT_BYTES, 'and fail a byte-based one');
    const parsed = parseCapture({ ...good, text: astral });
    assert.ok(!parsed.ok);
    assert.match(parsed.error, /bytes/);
  });

  test('text is never normalised', () => {
    // NFC and NFD are different byte sequences, different canonical strings and
    // different signatures. Tidying the text here would store a record whose
    // own signature no longer verifies.
    const nfd = 'é';
    const parsed = parseCapture({ ...good, text: nfd });
    assert.ok(parsed.ok);
    assert.equal(parsed.value.text, nfd);
    assert.notEqual(parsed.value.text, 'é');
  });

  test('malformed submissions are refused with a reason', () => {
    const cases: Array<[string, unknown]> = [
      ['bad did', { ...good, did: 'did:key:nope' }],
      ['no did', { ...good, did: undefined }],
      ['nonce with letters', { ...good, nonce: '12a' }],
      ['nonce too long', { ...good, nonce: '1'.repeat(20) }],
      ['padded signature', { ...good, sig: `${'a'.repeat(84)}==` }],
      ['no text', { ...good, text: undefined }],
      ['uppercase room', { ...good, room: 'Lobby' }],
      ['not an object', 'lobby'],
      ['null', null],
    ];
    for (const [name, body] of cases) {
      const parsed = parseCapture(body);
      assert.ok(!parsed.ok, `${name} should have been refused`);
      assert.ok(parsed.error.length > 0, `${name} was refused without a reason`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the capture rate limit', () => {
  test('a burst is allowed, and then it is not', () => {
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1 });
    for (let i = 0; i < 5; i++) {
      assert.ok(limiter.take('a', 0).allowed, `request ${i + 1} of the burst was refused`);
    }
    const refused = limiter.take('a', 0);
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfter >= 1, 'a Retry-After of 0 invites the retry being limited');
  });

  test('tokens come back at the refill rate', () => {
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 });
    limiter.take('a', 0);
    limiter.take('a', 0);
    assert.equal(limiter.take('a', 0).allowed, false);
    assert.equal(limiter.take('a', 1000).allowed, true);
  });

  test('the bucket never refills past its burst size', () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1 });
    limiter.take('a', 0);
    // An hour of quiet does not buy an hour's worth of burst.
    for (let i = 0; i < 3; i++) assert.ok(limiter.take('a', 3_600_000).allowed);
    assert.equal(limiter.take('a', 3_600_000).allowed, false);
  });

  test('one caller cannot spend another’s tokens', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
    assert.ok(limiter.take('a', 0).allowed);
    assert.equal(limiter.take('a', 0).allowed, false);
    assert.ok(limiter.take('b', 0).allowed);
  });

  test('idle buckets are forgotten', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, idleMs: 1000 });
    limiter.take('a', 0);
    limiter.take('b', 0);
    assert.equal(limiter.size, 2);
    assert.equal(limiter.sweep(5000), 0);
  });

  test('the client key prefers the forwarded address, and falls back', () => {
    assert.equal(clientKey({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, 'socket'), '1.2.3.4');
    assert.equal(clientKey({}, 'socket'), 'socket');
    assert.equal(clientKey({ 'x-forwarded-for': '' }, 'socket'), 'socket');
  });
});
