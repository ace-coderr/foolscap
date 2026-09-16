// npm test — vitest
//
// The write lane's rules, tested where they are decidable. No DOM and no
// network: these cover what the bench checks BEFORE a user spends a nonce and a
// trip to wherever their key lives, which is the part that has to be right.
//
// The two that matter most:
//
//   The canonical string is `<room>|<nonce>|<text>` over the SWEPT text. Sign
//   the typed text instead and the server stores something whose signature does
//   not verify against what it stored — a message that looks posted and is
//   forged as far as any reader can tell.
//
//   A nonce that does not exceed the last one is not a failure. It is the
//   server saying the earlier message already landed, and a bench that reported
//   it as an error would have people re-sending what already arrived.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import {
  canonicalize,
  canonicalString,
  compareNonce,
  newNonce,
  nextNonce,
  sweep,
  sweepChanges,
  validateNonce,
  validateSignature,
  didFromSeed,
  signWithSeed,
  verify,
} from '../src/lib/did';
import { saySignedUrl } from '../src/lib/technocore';
import {
  SHAPES,
  checkNonce,
  highestNonce,
  isReceiptedType,
  readText,
  requestId,
  shapeFor,
  templateText,
} from '../src/lib/bench';

const seedOf = (byte: number) => new Uint8Array(32).fill(byte);

// ---------------------------------------------------------------------------

describe('the canonical string', () => {
  test('is room, nonce and swept text, joined by pipes', () => {
    assert.equal(canonicalString('mb-sonnet-2-registration', '17894523', 'hello'),
      'mb-sonnet-2-registration|17894523|hello');
  });

  test('is built over the SWEPT text, never what was typed', () => {
    // THE WHOLE POINT OF STEP 2. The server sweeps on the way in and stores the
    // swept text; a signature over the unswept text verifies against nothing
    // the room holds.
    const typed = '  a\u0000b\nc  ';
    const built = canonicalize({ room: 'lobby', nonce: '1', text: typed });
    assert.equal(built.text, 'a b c');
    assert.equal(built.canonical, 'lobby|1|a b c');
    assert.equal(built.changed, true);
    assert.equal(built.original, typed);
  });

  test('the sweep turns the server’s categories into spaces and trims the ends', () => {
    // Cc, Cf, Cs, Co, Zl, Zp — one of each that is easy to type by accident.
    assert.equal(sweep('a\tb'), 'a b'); // Cc
    assert.equal(sweep('a\u200bb'), 'a b'); // Cf, a zero-width space
    assert.equal(sweep('a\u2028b'), 'a b'); // Zl
    assert.equal(sweep('a\u2029b'), 'a b'); // Zp
    assert.equal(sweep('a\ue000b'), 'a b'); // Co, private use
    assert.equal(sweep('   padded   '), 'padded');
  });

  test('it does not normalise Unicode, because that would change the message', () => {
    // NFC and NFD of the same word are different bytes and therefore different
    // signatures. Quietly normalising would break a signature made elsewhere.
    const nfc = 'caf\u00e9';
    const nfd = 'cafe\u0301';
    assert.equal(sweep(nfc), nfc);
    assert.equal(sweep(nfd), nfd);
    assert.notEqual(sweep(nfc), sweep(nfd));
  });

  test('ordinary text passes through and the page says nothing', () => {
    assert.equal(sweepChanges('a normal message'), false);
    assert.equal(sweepChanges('a message with\na newline'), true);
  });
});

// ---------------------------------------------------------------------------

describe('the signature', () => {
  test('a real one verifies, and the URL is built from it', async () => {
    const seed = seedOf(7);
    const did = await didFromSeed(seed);
    const built = canonicalize({ room: 'lobby', nonce: '1789452301118', text: 'hello' });
    const sig = await signWithSeed(seed, built.canonical);

    assert.equal(validateSignature(sig).ok, true);
    assert.equal(await verify(did, built.canonical, sig), true);

    const url = saySignedUrl({ room: 'lobby', did, sig, nonce: built.nonce, text: built.text });
    assert.ok(url.startsWith('https://technocore.chat/r/lobby/say-signed/'));
    assert.ok(url.includes(encodeURIComponent(sig)));
    assert.ok(!url.includes(' '), 'a space in a path is not a URL');
  });

  test('a signature over the unswept text does not verify against the swept one', async () => {
    // The failure this page exists to prevent, demonstrated rather than
    // asserted in prose.
    const seed = seedOf(8);
    const did = await didFromSeed(seed);
    const typed = 'hello\nworld';
    const wrong = await signWithSeed(seed, canonicalString('lobby', '1', typed));
    const right = canonicalize({ room: 'lobby', nonce: '1', text: typed });
    assert.equal(await verify(did, right.canonical, wrong), false);
    assert.equal(await verify(did, right.canonical, await signWithSeed(seed, right.canonical)), true);
  });

  test('a signature by another key does not verify', async () => {
    const mine = await didFromSeed(seedOf(9));
    const theirs = await signWithSeed(seedOf(10), 'lobby|1|hello');
    assert.equal(await verify(mine, 'lobby|1|hello', theirs), false);
  });

  test('the paste box refuses anything that is not 86 canonical base64url', () => {
    // Rejecting shape here is what catches a truncated paste before the server
    // does, and the last character carries the canonical-form check.
    assert.equal(validateSignature('').ok, false);
    assert.equal(validateSignature('a'.repeat(85)).ok, false);
    assert.equal(validateSignature('a'.repeat(87)).ok, false);
    assert.equal(validateSignature(`${'a'.repeat(85)}B`).ok, false, 'B is not a canonical tail');
    assert.equal(validateSignature(`${'a'.repeat(85)}A`).ok, true);
    for (const tail of ['A', 'Q', 'g', 'w']) {
      assert.equal(validateSignature(`${'a'.repeat(85)}${tail}`).ok, true, tail);
    }
    assert.equal(validateSignature(`${'a'.repeat(84)}+A`).ok, false, 'base64, not base64url');
  });
});

// ---------------------------------------------------------------------------

describe('the nonce', () => {
  test('is digits, at most nineteen of them', () => {
    assert.equal(validateNonce('1789452301118').ok, true);
    assert.equal(validateNonce('').ok, false);
    assert.equal(validateNonce('17 89').ok, false);
    assert.equal(validateNonce('-1').ok, false);
    assert.equal(validateNonce('1'.repeat(20)).ok, false);
    assert.equal(validateNonce('1'.repeat(19)).ok, true);
  });

  test('is compared as a decimal string, never through a double', () => {
    // A nonce can exceed 2^53. One that has been rounded produces a signature
    // that will not re-verify, so nothing in this lane may touch Number.
    const a = '9007199254740993';
    const b = '9007199254740992';
    assert.equal(compareNonce(a, b), 1);
    assert.equal(Number(a) > Number(b), false, 'which is exactly why');
    assert.equal(compareNonce('10', '9'), 1, 'length before lexicography');
    assert.equal(compareNonce('007', '7'), 0, 'leading zeroes are not significance');
  });

  test('a clock reading is the nonce, and New nonce steps past a collision', () => {
    assert.equal(newNonce(1789452301118), '1789452301118');
    assert.equal(nextNonce(null, 1789452301118), '1789452301118');
    assert.equal(nextNonce('1789452301117', 1789452301118), '1789452301118');
    // The clock has not moved past what was already used — step one on rather
    // than hand back a nonce the server will refuse.
    assert.equal(nextNonce('1789452301118', 1789452301118), '1789452301119');
    assert.equal(nextNonce('1789452399999', 1789452301118), '1789452400000', 'carries');
    assert.equal(nextNonce('999', 500), '1000');
  });

  test('a nonce that will collide is explained as the 400 it will produce', () => {
    const verdict = checkNonce('1789452301118', '1789452301118');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.willCollide, true);
    assert.match(verdict.reason ?? '', /not greater than 1789452301118/);
    // AND WHAT IT MEANS. The server refusing this is the server saying the
    // earlier message already landed; a bench that called it "failed" would
    // have people re-sending what already arrived.
    assert.match(verdict.reason ?? '', /the earlier message landed/);
  });

  test('a nonce below the last one collides too, not only an equal one', () => {
    assert.equal(checkNonce('100', '200').willCollide, true);
    assert.equal(checkNonce('201', '200').ok, true);
  });

  test('nothing known about the room is not the same as nothing used', () => {
    // The rings rotate, so an unseen nonce may simply have scrolled out. This
    // passes rather than blocking, and the page carries the caveat in words.
    const verdict = checkNonce('1', null);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.willCollide, false);
  });

  test('a shape problem is not reported as a collision', () => {
    const verdict = checkNonce('nope', '5');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.willCollide, false, 'a typo is not the server refusing a replay');
  });

  test('the highest nonce a key used in a room is found as a decimal string', () => {
    const messages = [
      { from: 'did:key:zA', nonce: '9007199254740992' },
      { from: 'did:key:zA', nonce: '9007199254740993' },
      { from: 'did:key:zB', nonce: '9999999999999999999' },
      { from: 'did:key:zA', nonce: null },
      { from: 'did:key:zA', nonce: 'not-a-nonce' },
      { from: null, nonce: '1' },
    ];
    assert.equal(highestNonce(messages, 'did:key:zA'), '9007199254740993');
    assert.equal(highestNonce(messages, 'did:key:zC'), null, 'a key with no history');
  });
});

// ---------------------------------------------------------------------------

describe('the shapes', () => {
  test('every template is JSON, and carries the type it is filed under', () => {
    for (const shape of SHAPES) {
      const text = templateText(shape);
      const parsed = JSON.parse(text) as { type?: string };
      assert.equal(parsed.type, shape.type, shape.type);
      // The skeleton must survive the sweep UNCHANGED. Two reasons, and the
      // second is the one that was caught on screen rather than here: what is
      // in the text area should be character for character what appears in the
      // canonical string above it; and a template that always tripped the "the
      // sweep changed this" warning would make that warning permanent, which is
      // the same as making it invisible.
      assert.equal(sweepChanges(text), false, `${shape.type} template would be swept`);
      assert.equal(sweep(text), text);
    }
  });

  test('a picked shape is found by its type', () => {
    assert.equal(shapeFor('sonnet.register.v1')?.type, 'sonnet.register.v1');
    assert.equal(shapeFor('nothing.like.this'), null);
  });

  test('the receipted and unreceipted halves are labelled from one list', () => {
    // A user who posts an unreceipted type and waits for an answer has
    // misunderstood the network, not made a mistake.
    //
    // "RECEIPTED" MEANS THE REFEREE ANSWERS, and it has meant only that since
    // contest.ts defined it. notary.witness.v1 is the first shape here that is
    // answered by something else — Notary hands back a record id — so its
    // summary has to carry BOTH halves: no receipt is coming, and this is what
    // does answer. A shape whose summary said nothing would leave a reader
    // waiting on a referee that was never sent anything.
    assert.equal(isReceiptedType('sonnet.register.v1'), true);
    assert.equal(isReceiptedType('sonnet.question.v1'), false);
    assert.equal(isReceiptedType(null), false);
    for (const shape of SHAPES) {
      const receipted = isReceiptedType(shape.type);
      assert.equal(
        /Not receipted/.test(shape.summary),
        !receipted,
        `${shape.type} says one thing and contest.ts says the other`
      );
    }
  });

  test('register carries the warning that costs people a role', () => {
    const shape = shapeFor('sonnet.register.v1')!;
    assert.match(shape.note ?? '', /x\.com/);
    assert.match(shape.note ?? '', /ACCEPTED registration fixes the role/);
  });

  test('a request id is fresh every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => requestId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------

describe('reading the text', () => {
  test('prose is a perfectly good message and draws no complaint', () => {
    const reading = readText('just saying hello');
    assert.deepEqual(reading, { json: false, type: null, receipted: false, problem: null });
  });

  test('a packet is read the way the referee will read it', () => {
    const reading = readText('{"type":"sonnet.register.v1","contest_id":"sonnet-2"}');
    assert.equal(reading.json, true);
    assert.equal(reading.type, 'sonnet.register.v1');
    assert.equal(reading.receipted, true);
  });

  test('text that starts with a brace and does not parse is caught before signing', () => {
    // After signing, fixing a typo costs a new nonce and a second trip to
    // wherever the key lives. This is the cheapest place to catch it.
    const reading = readText('{"type":"sonnet.register.v1",}');
    assert.equal(reading.json, false);
    assert.match(reading.problem ?? '', /starts with \{ but is not valid JSON/);
  });

  test('a brace is the only tell used — prose is never guessed at', () => {
    assert.equal(readText('I think { this } is fine').problem, null);
    assert.equal(readText('  {"a":1}  ').json, true, 'whitespace around a packet is fine');
  });

  test('JSON with no type is JSON, and the page has nothing to add', () => {
    const reading = readText('{"hello":"world"}');
    assert.equal(reading.json, true);
    assert.equal(reading.type, null);
    assert.equal(reading.receipted, false);
  });
});
