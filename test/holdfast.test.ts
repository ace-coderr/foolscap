// npm test — vitest
//
// Holdfast's rules, tested where they are decidable. No network: the board is
// assembled from listings and note values handed in directly, which is exactly
// how the page assembles it.
//
// The tests that matter most here are the ones about what Holdfast REFUSES to
// say. A note that exists is not a claim; a claim that does not verify is not a
// holder; a plot nobody has read is not a free plot. Each of those is a place
// where the page could quietly become a nicer game by being wrong, so each has
// a test standing on it.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import { didFromSeed, signWithSeed } from '../src/lib/did';
import { stripBanner, NOTE_BANNER, noteWriteUrl } from '../src/lib/kv';
import {
  assessClaim,
  availableCharacters,
  checkKey,
  claimMessage,
  DECAY_MS,
  districtOf,
  formatClaim,
  formatSpan,
  lettersFor,
  longestRun,
  parseClaim,
} from '../src/holdfast/rules';
import { brightnessFor, buildBoard, heightForHold, plotId } from '../src/holdfast/board';

const seedOf = (byte: number) => new Uint8Array(32).fill(byte);

/** A signed claim on a plot, as a player would produce one. */
async function claimFor(
  seed: Uint8Array,
  ns: string,
  key: string,
  claimedAt: number,
  renewedAt: number
): Promise<{ did: string; value: string }> {
  const did = await didFromSeed(seed);
  const sig = await signWithSeed(seed, claimMessage({ ns, key, did, claimedAt, renewedAt }));
  return { did, value: formatClaim({ did, claimedAt, renewedAt, sig }) };
}

const SEC = (ms: number) => Math.floor(ms / 1000);

// ---------------------------------------------------------------------------

describe('the letter rule', () => {
  test('a key may only be named out of the characters its DID contains', async () => {
    const did = await didFromSeed(seedOf(7));
    const letters = lettersFor(did);
    assert.ok(letters.size > 0, 'a did:key should yield an alphabet');
    for (const ch of did.slice('did:key:'.length).toLowerCase()) {
      // Every character of the DID, case-folded, is available — that IS the rule.
      assert.ok(letters.has(ch), `${ch} is in the DID and should be available`);
    }
  });

  test('case is folded, so a capital in the key buys the small letter', () => {
    // base58 has no lowercase l and no uppercase O. Folding is what keeps the
    // whole of a–z reachable by somebody; without it `l` is reachable by nobody.
    const withL = lettersFor('did:key:z6MkL' + 'A'.repeat(40));
    assert.ok(withL.has('l'), 'an uppercase L should make l nameable');
  });

  test('nobody can ever name a plot with a zero in it', async () => {
    // base58 omits 0 to stop it being confused with O, so no did:key contains
    // one, so no letter set can. This is a hole in the board on purpose.
    for (const byte of [1, 2, 3, 40, 255]) {
      const did = await didFromSeed(seedOf(byte));
      assert.ok(!lettersFor(did).has('0'), '0 is not in base58 and must never be available');
      assert.ok(!availableCharacters(did).includes('0'));
    }
  });

  test('hyphen and underscore are free to everyone', async () => {
    const did = await didFromSeed(seedOf(9));
    const letters = [...lettersFor(did)];
    // Build a key out of characters this DID has, joined by punctuation.
    const key = `${letters[0]}${letters[1]}-${letters[2]}_${letters[3]}`;
    assert.equal(checkKey(did, key).ok, true, 'separators must not need to be in the key');
  });

  test('a missing character is named, in the order it appears', async () => {
    const did = 'did:key:z6Mk' + 'a'.repeat(44);
    const check = checkKey(did, 'qqq-www-aaa');
    assert.equal(check.ok, false);
    assert.deepEqual(check.missing, ['q', 'w']);
    assert.match(check.reason ?? '', /does not contain/);
  });

  test('the multibase z counts, because it is a character the DID has', () => {
    // Every did:key begins `did:key:z`, so `z` is available to everybody. It
    // could have been excluded as a tag rather than a letter — the reason it is
    // not is that the page shows the player their own alphabet, and a z that is
    // plainly there and missing from the list needs explaining every time.
    const did = 'did:key:z6Mk' + 'a'.repeat(44);
    assert.ok(lettersFor(did).has('z'));
    assert.equal(checkKey(did, 'zaz').ok, true);
  });

  test("the server's own name rule is enforced before the game's", async () => {
    const did = await didFromSeed(seedOf(11));
    for (const bad of ['UPPER', 'has space', '-leading', 'a'.repeat(49), '']) {
      const check = checkKey(did, bad);
      assert.equal(check.ok, false, `${bad || '(empty)'} is not a key name`);
      // The reason cites the server, not the letter set, because that is what
      // refused it — a player told "your key does not contain a space" would
      // go looking for the wrong thing.
      assert.match(check.reason ?? '', /server/);
    }
  });
});

// ---------------------------------------------------------------------------

describe('a claim', () => {
  test('survives a round trip through the note format', async () => {
    const { did, value } = await claimFor(seedOf(3), 'holdfast', 'north-gate', 1000, 2000);
    const parsed = parseClaim(value);
    assert.ok(parsed);
    assert.equal(parsed.did, did);
    assert.equal(parsed.claimedAt, 1000);
    assert.equal(parsed.renewedAt, 2000);
    assert.equal(formatClaim(parsed), value);
  });

  test('is one line, because the server collapses newlines into spaces', async () => {
    const { value } = await claimFor(seedOf(3), 'holdfast', 'north-gate', 1000, 2000);
    assert.ok(!value.includes('\n'));
    assert.equal(value.split(' ').length, 5);
  });

  test('verifies where it was made', async () => {
    const now = Date.now();
    const { did, value } = await claimFor(
      seedOf(4),
      'holdfast',
      'north-gate',
      SEC(now - 3 * 86_400_000),
      SEC(now - 3600_000)
    );
    const held = await assessClaim('holdfast', 'north-gate', value, now);
    assert.equal(held.fault, null);
    assert.equal(held.claim?.did, did);
    assert.ok(held.heldMs != null && held.heldMs > 2.9 * 86_400_000);
    assert.equal(held.reclaimExact, true);
  });

  test('does not verify anywhere else', async () => {
    // THE BINDING TEST. Without ns and key in the signed message, one valid
    // claim would be a portable token: copy the line onto every free key on the
    // board and populate a district in somebody else's name.
    const now = Date.now();
    const { value } = await claimFor(seedOf(5), 'holdfast', 'north-gate', SEC(now - 1000), SEC(now));
    for (const [ns, key] of [
      ['holdfast', 'north-well'],
      ['holdfast-reach', 'north-gate'],
    ]) {
      const moved = await assessClaim(ns, key, value, now);
      assert.equal(moved.fault, 'bad-signature');
      assert.equal(moved.claim, null);
    }
  });

  test('signed by one key cannot be posted in another’s name', async () => {
    const now = Date.now();
    const impostor = await didFromSeed(seedOf(6));
    const { value } = await claimFor(seedOf(5), 'holdfast', 'north-gate', SEC(now - 1000), SEC(now));
    const swapped = value.replace(/did:key:\S+/, impostor);
    const checked = await assessClaim('holdfast', 'north-gate', swapped, now);
    assert.equal(checked.fault, 'bad-signature');
  });
});

// ---------------------------------------------------------------------------

describe('what the page will not put a name to', () => {
  const now = Date.now();

  test('an ordinary note is not a claim, and says so as its own fault', async () => {
    // The commonest real case by far: Holdfast watches a namespace and somebody
    // is using it for notes. That is not cheating and must not read as cheating.
    const held = await assessClaim('holdfast', 'lobby', 'A room for general chatter.', now);
    assert.equal(held.fault, 'unreadable');
    assert.equal(held.claim, null);
  });

  test('a missing note is not a fault at all', async () => {
    const held = await assessClaim('holdfast', 'nothing', null, now);
    assert.equal(held.fault, null);
    assert.equal(held.claim, null);
  });

  test('a claim dated in the future is refused', async () => {
    const { value } = await claimFor(
      seedOf(8),
      'holdfast',
      'north-gate',
      SEC(now + 86_400_000),
      SEC(now + 86_400_000)
    );
    assert.equal((await assessClaim('holdfast', 'north-gate', value, now)).fault, 'future');
  });

  test('a renewal older than the note can possibly be is refused', async () => {
    // THE ONE TIMING CHECK THE SERVER MAKES POSSIBLE. The note is in the
    // listing, so it was written inside seven days. A value claiming it was
    // last renewed three weeks ago contradicts its own existence — most likely
    // an old line replayed to keep a plot alive without re-signing it.
    const old = SEC(now - 21 * 86_400_000);
    const { value } = await claimFor(seedOf(9), 'holdfast', 'north-gate', old, old);
    assert.equal((await assessClaim('holdfast', 'north-gate', value, now)).fault, 'stale');
  });

  test('a renewal before its own claim is refused', async () => {
    const { value } = await claimFor(
      seedOf(10),
      'holdfast',
      'north-gate',
      SEC(now - 3600_000),
      SEC(now - 7200_000)
    );
    assert.equal(
      (await assessClaim('holdfast', 'north-gate', value, now)).fault,
      'renewed-before-claimed'
    );
  });

  test('a minute of clock skew is not cheating', async () => {
    const { value } = await claimFor(seedOf(11), 'holdfast', 'north-gate', SEC(now), SEC(now + 30_000));
    assert.equal((await assessClaim('holdfast', 'north-gate', value, now)).fault, null);
  });
});

// ---------------------------------------------------------------------------

describe('neighbours', () => {
  test('a district is everything sharing a key’s leading segment', () => {
    assert.equal(districtOf('north-gate'), 'north');
    assert.equal(districtOf('north-gate-two'), 'north');
    assert.equal(districtOf('lonely'), 'lonely');
    assert.equal(districtOf('-leading'), '-leading');
  });

  test('a block is a run of adjacent plots, and anyone can break it', () => {
    const me = 'did:me';
    assert.equal(longestRun([me, me, me], me), 3);
    assert.equal(longestRun([me, 'did:you', me], me), 1);
    assert.equal(longestRun([], me), 0);
    // An UNREAD plot breaks a run too. A gap that might be yours is not a
    // block, and scoring it as one would make the leaderboard a function of
    // how far round the read rotation happened to have got.
    assert.equal(longestRun([me, null, me], me), 1);
  });
});

// ---------------------------------------------------------------------------

describe('the two scales', () => {
  test('height is days held, from a floor, to a cap', () => {
    const tile = heightForHold(null);
    const fresh = heightForHold(0);
    assert.ok(tile < fresh, 'an unread plot must be visibly flatter than a read one');
    assert.ok(heightForHold(5 * 86_400_000) > fresh);
    assert.equal(heightForHold(400 * 86_400_000), heightForHold(90 * 86_400_000), 'capped');
  });

  test('brightness is time left, and an unread plot is dark', () => {
    assert.equal(brightnessFor(DECAY_MS), 1);
    assert.equal(brightnessFor(0), 0);
    assert.equal(brightnessFor(null), 0);
    assert.ok(brightnessFor(DECAY_MS / 2) > brightnessFor(DECAY_MS / 8));
  });

  test('a span reads in the units this game is played in', () => {
    // formatAge stops at hours and rendered a nineteen-day hold as "460 hours
    // 49 minutes". This is the fix and this is what it has to do.
    assert.equal(formatSpan(19 * 86_400_000), '19 days');
    assert.equal(formatSpan(86_400_000), '1 day');
    assert.equal(formatSpan(3 * 3600_000), '3 hours');
    assert.equal(formatSpan(90_000), '2 minutes');
    assert.equal(formatSpan(0), 'under a minute');
    assert.equal(formatSpan(null), null);
  });
});

// ---------------------------------------------------------------------------

describe('the board', () => {
  const listings = (keys: string[]) =>
    new Map([['holdfast', { keys, total: keys.length, listedAt: 1, error: null }]]);

  test('a plot nobody has read is not a plot nobody holds', async () => {
    const board = buildBoard({
      listings: listings(['north-gate', 'north-well']),
      readings: new Map(),
      connected: null,
      now: Date.now(),
    });
    assert.equal(board.counts.plots, 2);
    assert.equal(board.counts.read, 0);
    assert.equal(board.counts.held, 0);
    // The distinction that matters: neither is reported as unattributed, which
    // is a thing you can only be after somebody has looked.
    assert.equal(board.counts.unattributed, 0);
    for (const plot of board.plots) {
      assert.equal(plot.read, false);
      assert.equal(plot.holder, null);
      assert.equal(plot.reclaimInMs, null, 'an unread plot has no countdown, only a bound');
    }
  });

  test('a read plot with no attributable claim is unattributed', async () => {
    const now = Date.now();
    const readings = new Map([
      [
        plotId('holdfast', 'north-gate'),
        {
          value: 'somebody else’s note',
          holding: await assessClaim('holdfast', 'north-gate', 'somebody else’s note', now),
          readAt: now,
          error: null,
        },
      ],
    ]);
    const board = buildBoard({ listings: listings(['north-gate']), readings, connected: null, now });
    assert.equal(board.counts.read, 1);
    assert.equal(board.counts.unattributed, 1);
    assert.equal(board.counts.held, 0);
    assert.equal(board.plots[0].fault, 'unreadable');
  });

  test('standings count plots, longest hold and largest block', async () => {
    const now = Date.now();
    const keys = ['north-gate', 'north-well', 'north-mire', 'south-keep'];
    const seeds = [seedOf(20), seedOf(20), seedOf(21), seedOf(20)];
    const ages = [2, 9, 1, 3];
    const readings = new Map();
    let mine = '';
    for (let i = 0; i < keys.length; i++) {
      const { did, value } = await claimFor(
        seeds[i],
        'holdfast',
        keys[i],
        SEC(now - ages[i] * 86_400_000),
        SEC(now - 3600_000)
      );
      if (i === 0) mine = did;
      readings.set(plotId('holdfast', keys[i]), {
        value,
        holding: await assessClaim('holdfast', keys[i], value, now),
        readAt: now,
        error: null,
      });
    }

    const board = buildBoard({ listings: listings(keys), readings, connected: mine, now });
    const top = board.standings[0];
    assert.equal(top.did, mine);
    assert.equal(top.plots, 3);
    assert.ok(top.longestHeldMs > 8.9 * 86_400_000, 'the nine-day hold is the longest');
    // north-gate and north-well are adjacent; north-mire belongs to somebody
    // else and breaks the run before south-keep.
    assert.equal(top.largestBlock, 2);
    assert.equal(board.counts.mine, 3);
    for (const plot of board.plots) {
      assert.equal(plot.mine, plot.holder === mine);
      // The accent is the only state colour on this board and it means exactly
      // one thing: this plot is the connected key's.
      assert.equal(plot.watched, plot.mine);
      assert.equal(plot.state, plot.mine ? 'live' : 'unwatched');
    }
  });

  test('a block cannot cross a land boundary', async () => {
    const now = Date.now();
    const readings = new Map();
    let mine = '';
    for (const [ns, key] of [
      ['holdfast', 'zeta'],
      ['holdfast-reach', 'alpha'],
    ]) {
      const { did, value } = await claimFor(seedOf(22), ns, key, SEC(now - 1000), SEC(now - 100));
      mine = did;
      readings.set(plotId(ns, key), {
        value,
        holding: await assessClaim(ns, key, value, now),
        readAt: now,
        error: null,
      });
    }
    const board = buildBoard({
      listings: new Map([
        ['holdfast', { keys: ['zeta'], total: 1, listedAt: 1, error: null }],
        ['holdfast-reach', { keys: ['alpha'], total: 1, listedAt: 1, error: null }],
      ]),
      readings,
      connected: mine,
      now,
    });
    assert.equal(board.standings[0].plots, 2);
    assert.equal(board.standings[0].largestBlock, 1, 'two lands, two runs of one');
  });

  test('districts are discovered from the keys, per land', () => {
    const board = buildBoard({
      listings: new Map([
        ['holdfast', { keys: ['north-gate', 'north-well', 'south-keep'], total: 3, listedAt: 1, error: null }],
        ['holdfast-reach', { keys: ['north-tor'], total: 1, listedAt: 1, error: null }],
      ]),
      readings: new Map(),
      connected: null,
      now: Date.now(),
    });
    assert.deepEqual(
      board.districts.map((d) => d.id).sort(),
      ['holdfast-reach:north', 'holdfast:north', 'holdfast:south']
    );
    // Same prefix, different land, different district — or a block could be
    // drawn across a boundary it cannot be scored across.
    assert.notEqual(
      board.plots.find((p) => p.key === 'north-gate')?.districtId,
      board.plots.find((p) => p.key === 'north-tor')?.districtId
    );
  });
});

// ---------------------------------------------------------------------------

describe('the store', () => {
  test('the server’s untrusted-content banner is not part of the value', () => {
    const value = 'holdfast1 did:key:zAAA 1 2 sig';
    assert.equal(stripBanner(`${NOTE_BANNER}\n\n${value}`), value);
    // A value that merely looks like it starts with one is left alone.
    assert.equal(stripBanner('!! UNTRUSTED elsewhere'), '!! UNTRUSTED elsewhere');
    assert.equal(stripBanner(value), value);
  });

  test('a claim is if_absent and a renewal is if=, and never both', () => {
    const claim = noteWriteUrl({ ns: 'holdfast', key: 'north-gate', value: 'v', ifAbsent: true });
    assert.match(claim, /\?if_absent=1$/);
    const renew = noteWriteUrl({ ns: 'holdfast', key: 'north-gate', value: 'v', ifValue: 'old' });
    assert.match(renew, /\?if=old$/);
    // The server refuses the pair with a 400 rather than choosing between them,
    // so this refuses to build one.
    assert.throws(() =>
      noteWriteUrl({ ns: 'holdfast', key: 'north-gate', value: 'v', ifAbsent: true, ifValue: 'old' })
    );
  });

  test('the value is encoded, so a claim survives being a URL', async () => {
    const { value } = await claimFor(seedOf(30), 'holdfast', 'north-gate', 1, 2);
    const url = noteWriteUrl({ ns: 'holdfast', key: 'north-gate', value, ifAbsent: true });
    const roundTripped = decodeURIComponent(url.split('/set/')[1].split('?')[0]);
    assert.equal(roundTripped, value);
    assert.ok(!url.includes(' '), 'a space in a path is not a URL');
  });
});
