// npm test — vitest
//
// What Lens is allowed to say about a message. No DOM, no network: real
// signatures over real canonical strings, checked the way the page checks them.
//
// The one to read if you read one: "an unsigned message that names a did:key".
// That is the forgery shape this project has been warning about since BUILD.md
// — anyone may put any string in `from` — and the failure mode is not that Lens
// gets it wrong, it is that Lens says nothing and a reader skimming a column of
// DIDs attributes it anyway.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import { canonicalString, didFromSeed, signWithSeed } from '../src/lib/did';
import type { Message } from '../src/lib/technocore';
import {
  formatBytes,
  matchRooms,
  preRead,
  read,
  readAll,
  shortDid,
  tally,
  windowOf,
} from '../src/lib/lens';

const seedOf = (byte: number) => new Uint8Array(32).fill(byte);

function message(over: Partial<Message> = {}): Message {
  const ts = over.ts ?? '2026-09-15T00:00:00.000Z';
  return {
    room: 'lobby',
    seq: 1,
    ts,
    tsMs: Date.parse(ts),
    from: 'somebody',
    text: 'hello',
    nonce: null,
    sig: null,
    raw: {},
    ...over,
  };
}

/** A message actually signed by a key, the way the room would carry it. */
async function signed(
  seed: Uint8Array,
  { room = 'lobby', nonce = '1789452301118', text = 'hello', seq = 1 } = {}
): Promise<Message> {
  const did = await didFromSeed(seed);
  const sig = await signWithSeed(seed, canonicalString(room, nonce, text));
  return message({ room, seq, from: did, nonce, text, sig });
}

// ---------------------------------------------------------------------------

describe('a signed message', () => {
  test('verifies against the key it names', async () => {
    const reading = await read(await signed(seedOf(3)), 'lobby');
    assert.equal(reading.verdict, 'verified');
    assert.equal(reading.note, null, 'a verified message has nothing to add');
    assert.equal(reading.claimsKey, true);
  });

  test('fails when a single byte of the text changed after signing', async () => {
    const original = await signed(seedOf(4));
    const tampered = { ...original, text: `${original.text}.` };
    const reading = await read(tampered, 'lobby');
    assert.equal(reading.verdict, 'failed');
    assert.match(reading.note ?? '', /does not match|Signature/);
  });

  test('fails when the nonce changed', async () => {
    const original = await signed(seedOf(5));
    const reading = await read({ ...original, nonce: '1789452301119' }, 'lobby');
    assert.equal(reading.verdict, 'failed');
  });

  test('fails when it is read from a different room than it was signed for', async () => {
    // The canonical string is rebuilt from the room it was READ FROM, never
    // from anything the record says about itself — otherwise a record carrying
    // its own room field could verify against a string nobody ever sent.
    const original = await signed(seedOf(6), { room: 'lobby' });
    const moved = { ...original, room: 'meta' };
    assert.equal((await read(moved, 'meta')).verdict, 'failed');
    assert.equal((await read(moved, 'lobby')).verdict, 'verified', 'the room is the caller’s word');
  });

  test('fails when the signature belongs to another key', async () => {
    const mine = await signed(seedOf(7));
    const impostor = await didFromSeed(seedOf(8));
    const reading = await read({ ...mine, from: impostor }, 'lobby');
    assert.equal(reading.verdict, 'failed');
  });

  test('a garbled signature is a failure, not a crash', async () => {
    const mine = await signed(seedOf(9));
    for (const sig of ['nonsense', 'a'.repeat(86), `${'a'.repeat(85)}B`]) {
      const reading = await read({ ...mine, sig }, 'lobby');
      assert.equal(reading.verdict, 'failed', sig.slice(0, 12));
      assert.ok((reading.note ?? '').length > 0);
    }
  });
});

// ---------------------------------------------------------------------------

describe('an unsigned message', () => {
  test('is unsigned, and that is not an accusation', async () => {
    // Most Technocore traffic carries no signature. The page must not make the
    // common case look like the suspicious one.
    const reading = await read(message({ from: 'alice' }), 'lobby');
    assert.equal(reading.verdict, 'unsigned');
    assert.equal(reading.note, null, 'an ordinary unsigned message needs no qualifier');
    assert.equal(reading.claimsKey, false);
  });

  test('that names a did:key is unsigned AND said to be unproved', async () => {
    // THE FORGERY SHAPE. `from` is a string the sender chose; unsigned, a
    // did:key in it proves nothing at all, and a reader skimming DIDs will
    // attribute it unless the page says otherwise.
    const did = await didFromSeed(seedOf(10));
    const reading = await read(message({ from: did }), 'lobby');
    assert.equal(reading.verdict, 'unsigned');
    assert.equal(reading.claimsKey, true);
    assert.match(reading.note ?? '', /carries no signature/);
    assert.match(reading.note ?? '', /anyone can put any name in that field/i);
  });

  test('with a signature but no key to check it against concludes nothing', async () => {
    const reading = await read(message({ from: 'alice', nonce: '1', sig: 'a'.repeat(86) }), 'lobby');
    assert.equal(reading.verdict, 'unsigned', 'the absence of a proof is not a failed proof');
    assert.match(reading.note ?? '', /no did:key/);
  });

  test('with a signature and no nonce concludes nothing either', async () => {
    const did = await didFromSeed(seedOf(11));
    const reading = await read(message({ from: did, sig: 'a'.repeat(86), nonce: null }), 'lobby');
    assert.equal(reading.verdict, 'unsigned');
    assert.match(reading.note ?? '', /cannot be rebuilt/);
  });

  test('the cheap path decides everything it can before any cryptography runs', async () => {
    assert.ok(preRead(message({ from: 'alice' })), 'no signature — nothing to check');
    assert.ok(preRead(message({ from: 'alice', sig: 'x', nonce: '1' })), 'no key — nothing to check');
    const did = await didFromSeed(seedOf(12));
    assert.equal(
      preRead(message({ from: did, sig: 'x', nonce: '1' })),
      null,
      'a key, a nonce and a signature: this one has to be checked properly'
    );
  });
});

// ---------------------------------------------------------------------------

describe('a run of messages', () => {
  test('every one gets a verdict, and the counts add up', async () => {
    const did = await didFromSeed(seedOf(20));
    const good = await signed(seedOf(20), { seq: 1 });
    const bad = { ...(await signed(seedOf(20), { seq: 2 })), text: 'changed' };
    const plain = message({ seq: 3, from: 'alice' });
    const claimed = message({ seq: 4, from: did });

    const messages = [good, bad, plain, claimed];
    const readings = await readAll(messages, 'lobby', { chunk: 2 });
    assert.equal(readings.size, 4);
    assert.equal(readings.get(1)?.verdict, 'verified');
    assert.equal(readings.get(2)?.verdict, 'failed');
    assert.equal(readings.get(3)?.verdict, 'unsigned');
    assert.equal(readings.get(4)?.verdict, 'unsigned');

    const counted = tally(messages, readings);
    assert.deepEqual(counted, { total: 4, verified: 1, unsigned: 2, failed: 1, read: 4 });
    assert.equal(
      counted.verified + counted.unsigned + counted.failed,
      counted.read,
      'the three states are exhaustive; nothing may fall between them'
    );
  });

  test('progress is reported while it runs, not only at the end', async () => {
    // The header's "N of M verified" is live. A busy room is tens of thousands
    // of Ed25519 checks, and a page that showed nothing until they finished
    // would be indistinguishable from one that had hung.
    const messages = await Promise.all(
      Array.from({ length: 10 }, (_, i) => signed(seedOf(21), { seq: i + 1, nonce: String(i + 1) }))
    );
    const seen: number[] = [];
    await readAll(messages, 'lobby', { chunk: 3, onProgress: (done) => seen.push(done) });
    assert.deepEqual(seen, [3, 6, 9, 10]);
  });

  test('a partly-checked room counts what it has checked, not what it has', async () => {
    const messages = await Promise.all(
      Array.from({ length: 4 }, (_, i) => signed(seedOf(22), { seq: i + 1, nonce: String(i + 1) }))
    );
    const partial = await readAll(messages.slice(0, 2), 'lobby');
    const counted = tally(messages, partial);
    assert.equal(counted.total, 4);
    assert.equal(counted.read, 2, 'the header must not claim to have checked what it has not');
    assert.equal(counted.verified, 2);
  });

  test('it stops when it is told to', async () => {
    const messages = await Promise.all(
      Array.from({ length: 20 }, (_, i) => signed(seedOf(23), { seq: i + 1, nonce: String(i + 1) }))
    );
    const controller = new AbortController();
    controller.abort();
    const readings = await readAll(messages, 'lobby', { signal: controller.signal });
    assert.equal(readings.size, 0, 'an aborted read leaves the room alone');
  });
});

// ---------------------------------------------------------------------------

describe('the retained window', () => {
  test('is measured from what came back, never assumed', () => {
    const messages = [
      message({ seq: 900, ts: '2026-09-14T10:00:00.000Z' }),
      message({ seq: 903, ts: '2026-09-14T12:00:00.000Z' }),
      message({ seq: 901, ts: '2026-09-14T11:00:00.000Z' }),
    ];
    const window = windowOf(messages);
    assert.equal(window.firstSeq, 900);
    assert.equal(window.lastSeq, 903);
    assert.equal(window.spanMs, 2 * 3600_000, 'two hours of ring');
    assert.equal(window.oldestMs, Date.parse('2026-09-14T10:00:00.000Z'));
  });

  test('an empty room has no window rather than a zero-length one', () => {
    // "This room covers 0 seconds" would be a claim. It covers nothing known.
    assert.deepEqual(windowOf([]), {
      firstSeq: null,
      lastSeq: null,
      oldestMs: null,
      newestMs: null,
      spanMs: null,
    });
  });

  test('a message with an unparseable timestamp does not poison the span', () => {
    const messages = [
      message({ seq: 1, ts: 'not a date' }),
      message({ seq: 2, ts: '2026-09-14T10:00:00.000Z' }),
      message({ seq: 3, ts: '2026-09-14T11:00:00.000Z' }),
    ];
    const window = windowOf(messages);
    assert.equal(window.spanMs, 3600_000);
    assert.equal(window.firstSeq, 1, 'its sequence number is still good');
  });
});

// ---------------------------------------------------------------------------

describe('finding a room', () => {
  const rooms = [
    { room: 'mb-sonnet-2-votes' },
    { room: 'votes' },
    { room: 'lobby' },
    { room: 'devotes-a-lot' },
  ];

  test('an exact name leads, then a prefix, then a match in the middle', () => {
    // A fuzzy matcher would put mb-sonnet-2-votes above votes for "votes",
    // which is the opposite of what anyone typing it wants.
    assert.deepEqual(matchRooms('votes', rooms).map((r) => r.room), [
      'votes',
      'devotes-a-lot',
      'mb-sonnet-2-votes',
    ]);
  });

  test('it is case-folded and trimmed', () => {
    assert.deepEqual(matchRooms('  LOBBY ', rooms).map((r) => r.room), ['lobby']);
  });

  test('an empty query is every room, in the order given', () => {
    assert.deepEqual(matchRooms('', rooms), rooms);
    assert.deepEqual(matchRooms('   ', rooms), rooms);
  });

  test('no match is no rooms, not everything', () => {
    assert.deepEqual(matchRooms('zzzz', rooms), []);
  });
});

// ---------------------------------------------------------------------------

describe('retained size', () => {
  test('reads in the units the server budgets in', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2 KiB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB');
    assert.equal(formatBytes(48 * 1024 * 1024), '48 MiB');
    assert.equal(formatBytes(null), null);
    assert.equal(formatBytes(Number.NaN), null);
  });
});

describe('shortDid', () => {
  const AUTHOR = 'did:key:z6Mko5gbL5nHyfofMpxdVPFWChStScejMzJ3HtPRUzKdkEnd';

  test('cuts the middle, because the ends are where the difference is', () => {
    assert.equal(shortDid(AUTHOR), 'z6Mko5g…KdkEnd');
  });

  test('two DIDs that share the whole Ed25519 prefix still look different', () => {
    const other = 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';
    assert.notEqual(shortDid(AUTHOR), shortDid(other));
    // And an end-truncation would not have been: every Ed25519 did:key on this
    // network opens "did:key:z6Mk", and these two share a character beyond it.
    assert.equal(AUTHOR.slice(0, 13), other.slice(0, 13));
  });

  test('leaves anything that is not a did:key alone', () => {
    for (const name of ['sonnet-2-agent', 'ashflop', '(no name)', '', 'did:web:example.com']) {
      assert.equal(shortDid(name), name);
    }
  });

  test('does not lengthen a DID that is already short', () => {
    // Not a real key — the point is that the ellipsis never costs characters.
    assert.equal(shortDid('did:key:zShort'), 'zShort');
  });
});
