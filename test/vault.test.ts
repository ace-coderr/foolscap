// npm test — vitest
//
// Reading a note, and what may be said about when it will go.
//
// The tests that matter most are the ones about the second half. The seven-day
// decay clock is real, running and invisible — the server publishes nothing
// that exposes it — so every claim /vault makes about expiry has to be an
// observation about the past. The temptation is to reason a little further than
// the evidence allows, and one of the tests below exists because I did exactly
// that in the first draft and it was wrong.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import { didFromSeed, signWithSeed } from '../src/lib/did';
import { NOTE_BANNER, stripBanner, isPrivateKey, KV_NAME_RE } from '../src/lib/kv';
import {
  authorityOf,
  checkDelegate,
  describeGap,
  diffSighting,
  findDelegates,
  parseFields,
  readNote,
  type Sighting,
} from '../src/lib/vault';

const seedOf = (byte: number) => new Uint8Array(32).fill(byte);
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------

describe('what the server wraps a note in', () => {
  test('the banner is stripped by exact prefix and nothing cleverer', () => {
    const value = 'did:key:z6MkqMYmixoLMvGLRRwJn4aEEN272FdQHC4anKKeeEmD38Wn';
    assert.equal(stripBanner(`${NOTE_BANNER}\n\n${value}`), value);
    assert.equal(stripBanner(value), value, 'a note with no banner is untouched');
  });

  test('a note that merely starts similarly is left alone', () => {
    // A prefix match is the whole guard. Anything looser would eat a real note
    // whose first words happened to resemble the warning.
    const lookalike = '!! UNTRUSTED CONTENT of my own, actually';
    assert.equal(stripBanner(lookalike), lookalike);
  });

  test('the banner is not confused by a value containing it later', () => {
    const value = `something ${NOTE_BANNER} quoted inside`;
    assert.equal(stripBanner(value), value);
  });
});

describe('what the listing hides', () => {
  test('p- keys are filtered whatever the server does', () => {
    assert.equal(isPrivateKey('p-secret'), true);
    assert.equal(isPrivateKey('public'), false);
    assert.equal(isPrivateKey('pp-not-private'), false);
  });

  test('a key has to match the server’s own name rule', () => {
    assert.equal(KV_NAME_RE.test('000857fca5d5be'), true);
    assert.equal(KV_NAME_RE.test('d-000032d3ecd6'), true);
    assert.equal(KV_NAME_RE.test('UPPER'), false);
    assert.equal(KV_NAME_RE.test('-leading'), false);
    assert.equal(KV_NAME_RE.test('a'.repeat(49)), false);
  });
});

// ---------------------------------------------------------------------------

describe('reading a note', () => {
  // Every string in this block was taken off the live network.
  test('a bare did:key is a did note', () => {
    const value = 'did:key:z6MkqMYmixoLMvGLRRwJn4aEEN272FdQHC4anKKeeEmD38Wn';
    const reading = readNote(value);
    assert.equal(reading.shape, 'did');
    assert.equal(reading.did, value);
  });

  test('space-separated name:value pairs are fields, and did:key stays whole', () => {
    // The commonest shape there is. `did:key:z6Mk…` contains two colons, and a
    // parser that split on all of them would report the field `did` with the
    // value `key:z6Mk…`, which is not a DID and verifies against nothing.
    const value =
      'did:key:z6Mkk9DbNUH6QwY6Ut3wy1yeyFTa9etaVFB1mLu4U7TbGkiq ' +
      'x25519:A5BcbRx9g8MrO4g4e1P9U_KXUiy_oHH3MZVR62n_QkA ' +
      'mailbox:mb-p-ac2c3c2c6ceac9a2cebf';
    const reading = readNote(value);
    assert.equal(reading.shape, 'fields');
    assert.deepEqual(
      reading.fields.map((f) => f.name),
      ['did:key', 'x25519', 'mailbox']
    );
    assert.equal(reading.did, 'did:key:z6Mkk9DbNUH6QwY6Ut3wy1yeyFTa9etaVFB1mLu4U7TbGkiq');
    assert.equal(reading.fields[0].isDid, true);
    assert.equal(reading.fields[1].isDid, false);
  });

  test('a JSON note is read as JSON', () => {
    const value = '{"did":"did:key:z6MkfREj4VRyT9kDjGfHhtStziVc4oZf9D6Cjvx2kTqpReFD","caps":["A2A"]}';
    const reading = readNote(value);
    assert.equal(reading.shape, 'json');
    assert.equal(reading.did, 'did:key:z6MkfREj4VRyT9kDjGfHhtStziVc4oZf9D6Cjvx2kTqpReFD');
    assert.ok(reading.json?.includes('\n'), 'pretty-printed for reading');
  });

  test('prose is prose, and that is not a failure', () => {
    // A topic note. Most of the network is this, and a page that rendered it as
    // "unparseable" would be calling ordinary content broken.
    const value = 'Short how-tos for new agents: since/wait polling, did:key signing, /kv notes.';
    const reading = readNote(value);
    assert.equal(reading.shape, 'text');
    assert.deepEqual(reading.fields, []);
    assert.equal(reading.did, null);
  });

  test('a bare integer is prose too', () => {
    // presence/hb-* notes are a sequence number and nothing else.
    assert.equal(readNote('1789452904').shape, 'text');
    assert.equal(readNote('OPERATIONAL').shape, 'text');
  });

  test('an empty note is empty rather than anything else', () => {
    assert.equal(readNote('').shape, 'empty');
    assert.equal(readNote(null).shape, 'empty');
    assert.equal(readNote('   ').shape, 'empty');
  });

  test('one token without a colon makes the whole thing prose', () => {
    // Half-parsed is worse than unparsed: a reading that showed two of four
    // tokens as fields would look like the note only had two.
    assert.deepEqual(parseFields('a:1 b:2 loose c:3'), []);
    assert.equal(readNote('a:1 b:2 loose c:3').shape, 'text');
  });
});

// ---------------------------------------------------------------------------

describe('delegate records', () => {
  const agent = 'did:key:z6MkfDSNRs2i9S6LZ5vd4RbpZ6754H7R3btDqRTeHhamqvuJ';

  test('are found by scanning for the token, never by splitting lines', async () => {
    // llms.txt is explicit, and the reason is that the sweep has already turned
    // every newline into a space: a line-splitting parser finds exactly one
    // record in a note carrying three.
    const root = await didFromSeed(seedOf(2));
    const line =
      `${root} mailbox:mb-p-abc ` +
      `delegate: ${agent} r:lobby 1800000000 1 ${'a'.repeat(85)}A ` +
      `delegate: ${agent} kv:topic 1800000001 2 ${'b'.repeat(85)}Q`;
    const found = findDelegates(line);
    assert.equal(found.length, 2);
    assert.equal(found[0].scope, 'r:lobby');
    assert.equal(found[1].scope, 'kv:topic');
    assert.equal(found[1].expires, 1800000001);
  });

  test('verify against the note’s own key, and only that key', async () => {
    // THE PROPERTY THAT MATTERS. The root DID is inside the signed string, so a
    // record copied out of somebody else's note does not survive being checked
    // against the note it was pasted into.
    const rootSeed = seedOf(3);
    const root = await didFromSeed(rootSeed);
    const stranger = await didFromSeed(seedOf(4));
    const record = { agent, scope: '*', expires: 1900000000, nonce: '7', sig: '' };
    const message = ['delegate', root, agent, '*', '1900000000', '7'].join('|');
    record.sig = await signWithSeed(rootSeed, message);

    const good = await checkDelegate(record, root);
    assert.equal(good.ok, true);
    assert.equal(good.message, message);

    const pasted = await checkDelegate(record, stranger);
    assert.equal(pasted.ok, false);
    assert.match(pasted.reason ?? '', /copied from another note/);
  });

  test('an expired record is reported as expired, not as invalid', async () => {
    // Expiry is the only revocation there is. A record that verifies and has
    // run out is a true record of a permission that has lapsed, and saying
    // "invalid" would conflate the two.
    const rootSeed = seedOf(5);
    const root = await didFromSeed(rootSeed);
    const expires = Math.floor((Date.now() - DAY) / 1000);
    const record = { agent, scope: '*', expires, nonce: '1', sig: '' };
    record.sig = await signWithSeed(
      rootSeed,
      ['delegate', root, agent, '*', String(expires), '1'].join('|')
    );
    const checked = await checkDelegate(record, root);
    assert.equal(checked.ok, true, 'the signature is good');
    assert.equal(checked.expired, true, 'and the permission has lapsed');
  });

  test('a malformed record is skipped rather than half-read', () => {
    assert.deepEqual(findDelegates('delegate: not-a-did * 1 2 sig'), []);
    assert.deepEqual(findDelegates('delegate: ' + agent + ' * notanumber 2 sig'), []);
    assert.deepEqual(findDelegates('delegate:'), []);
  });
});

// ---------------------------------------------------------------------------

describe('who a note proves anything about', () => {
  test('almost nothing, almost everywhere', () => {
    const ordinary = authorityOf('topic');
    assert.equal(ordinary.signedLane, false);
    assert.match(ordinary.note, /world-writable/);
    assert.match(ordinary.note, /a string somebody typed/);
  });

  test('except the two lanes the server itself checks', () => {
    for (const ns of ['room-owners', 'room-allow']) {
      const lane = authorityOf(ns);
      assert.equal(lane.signedLane, true, ns);
      assert.match(lane.note, /signature-checked by the server/);
    }
  });
});

// ---------------------------------------------------------------------------

describe('watching a namespace', () => {
  const at = Date.parse('2026-09-15T00:00:00Z');

  test('a first look reports no change at all', () => {
    // Not "everything arrived", which would read as news. There is nothing to
    // compare against yet.
    const change = diffSighting(null, ['a', 'b'], at);
    assert.deepEqual(change.gone, []);
    assert.deepEqual(change.arrived, []);
    assert.equal(change.sinceMs, null);
    assert.deepEqual(change.sighting.keys, ['a', 'b']);
  });

  test('a later look reports what went and what appeared', () => {
    const before: Sighting = { lastLookedMs: at - 2 * DAY, keys: ['a', 'b', 'c'] };
    const change = diffSighting(before, ['b', 'c', 'd'], at);
    assert.deepEqual(change.gone, ['a']);
    assert.deepEqual(change.arrived, ['d']);
    assert.equal(change.sinceMs, 2 * DAY);
  });

  test('the sighting it returns is what to store for next time', () => {
    const before: Sighting = { lastLookedMs: at - DAY, keys: ['a'] };
    const change = diffSighting(before, ['a', 'b'], at);
    assert.equal(change.sighting.lastLookedMs, at);
    assert.deepEqual(change.sighting.keys, ['a', 'b']);
  });
});

describe('what may be said about a key that has gone', () => {
  test('only how wide the window was — never which cause it was', () => {
    // THE MISTAKE THIS PINS. The first version of describeGap said that a gap
    // under seven days ruled the decay sweep out, "since it was still there at
    // the start of the window". That does not follow: being present at the
    // first look only proves the note had been WRITTEN within the seven days
    // before THAT. A note written six days before Monday is present on Monday
    // and reclaimed by Wednesday, and a two-day gap rules nothing out.
    const narrow = describeGap(2 * DAY) ?? '';
    assert.match(narrow, /Less than seven days/);
    assert.match(narrow, /not something this page can tell/);
    assert.doesNotMatch(narrow, /could not have/, 'no cause may be ruled out');

    const wide = describeGap(9 * DAY) ?? '';
    assert.match(wide, /More than seven days/);
    assert.match(wide, /not something this page can tell/);
  });

  test('both widths name all three possible causes and choose none', () => {
    for (const gap of [1000, 2 * DAY, 6.9 * DAY, 7 * DAY, 30 * DAY]) {
      const said = describeGap(gap) ?? '';
      assert.match(said, /reclaimed/);
      assert.match(said, /deleted/);
      assert.match(said, /overwritten/);
    }
  });

  test('with no previous look there is nothing to say', () => {
    assert.equal(describeGap(null), null);
  });
});
