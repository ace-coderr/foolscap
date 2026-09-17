// audio.test.ts — the two things the network decides, and nothing that needs ears.
//
// The instrument itself is not tested here and cannot be: there is no
// AudioContext in node, and a mock of one would only prove the mock. What is
// testable is the arithmetic between a reading and a sound — the filter's
// cutoff for a rate, and the note a key gets — which is the part that could be
// wrong in a way nobody would hear as wrong.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  CUTOFF_BUSY,
  CUTOFF_QUIET,
  MASTER_GAIN,
  RATE_CEILING,
  cutoffFor,
  toneFor,
} from '../src/audio.ts';

const REFEREE = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const AUTHOR = 'did:key:z6Mko5gbL5nHyfofMpxdVPFWChStScejMzJ3HtPRUzKdkEnd';

describe('the drone follows the rate', () => {
  it('sits closed when nothing is arriving', () => {
    assert.equal(cutoffFor(0), CUTOFF_QUIET);
    assert.equal(cutoffFor(null), CUTOFF_QUIET);
    assert.equal(cutoffFor(undefined), CUTOFF_QUIET);
    // A rate cannot be negative, and if one ever is, it is not a wide-open room.
    assert.equal(cutoffFor(-5), CUTOFF_QUIET);
  });

  it('opens with the rate, and never past its ceiling', () => {
    assert.ok(cutoffFor(10) > CUTOFF_QUIET);
    assert.ok(cutoffFor(1000) > cutoffFor(10));
    assert.ok(cutoffFor(RATE_CEILING) <= CUTOFF_BUSY + 1e-9);
    // The network cannot make this shriek by getting busier than expected.
    assert.ok(cutoffFor(50_000_000) <= CUTOFF_BUSY + 1e-9);
  });

  it('spends more of its travel on the quiet end, where the rooms are', () => {
    // A room going from silent to ten a minute is a bigger change than one
    // going from a thousand to a thousand and ten.
    const early = cutoffFor(10) - cutoffFor(0);
    const late = cutoffFor(1010) - cutoffFor(1000);
    assert.ok(early > late, `${early} should beat ${late}`);
  });
});

describe('a key gets a note', () => {
  it('is the same note for the same key, every time', () => {
    assert.equal(toneFor(REFEREE), toneFor(REFEREE));
    assert.notEqual(toneFor(REFEREE), null);
  });

  it('is not the same note for every key', () => {
    const notes = new Set(
      [REFEREE, AUTHOR, 'did:key:z6MkfYsUPbMy5gsBLHmjdvvNMxnFnCrrxKFPqmvJLkCNbzMv'].map(toneFor)
    );
    assert.ok(notes.size > 1);
  });

  it('says nothing rather than something, where there is no key to say it from', () => {
    assert.equal(toneFor(null), null);
    assert.equal(toneFor(undefined), null);
    assert.equal(toneFor(''), null);
    // A `from` is usually a name somebody typed. A name is not a key.
    assert.equal(toneFor('anon'), null);
    assert.equal(toneFor('did:key:notbase58!!'), null);
  });

  it('stays in a range that sits under the drone rather than over it', () => {
    for (const did of [REFEREE, AUTHOR]) {
      const hz = toneFor(did);
      assert.ok(hz != null && hz >= 200 && hz <= 1800, `${did} -> ${hz}`);
    }
  });
});

describe('the cap', () => {
  it('is atmosphere, not music', () => {
    assert.ok(MASTER_GAIN <= 0.08);
  });
});
