// npm test — vitest
//
// The glyph is a drawing of a key, and the only thing that makes it worth
// putting on screen is that it is the SAME drawing every time. A mark that
// wobbled between renders would be worse than no mark at all: a reader would
// learn a shape, see it change, and conclude the participant had changed.
//
// So this file pins both halves of the claim in DESIGN.md's amendment — "two
// DIDs that differ produce different glyphs; the same DID always produces the
// same one" — and is honest about the first half being a tendency rather than a
// guarantee. Fifteen cells is fifteen bits. Two keys CAN collide, the rate is
// measured below rather than asserted away, and nothing on this site treats a
// glyph as proof of anything.

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  GLYPH_BYTES,
  GLYPH_DECIDED,
  GLYPH_SIZE,
  GLYPH_WEIGHTS,
  glyphFor,
  glyphFromKey,
  glyphSignature,
} from '../src/lib/glyph.ts';
import { didFromPublicKey } from '../src/lib/did.ts';

/** The author's key, and the referee's. Two DIDs this repo already pins. */
const AUTHOR = 'did:key:z6Mko5gbL5nHyfofMpxdVPFWChStScejMzJ3HtPRUzKdkEnd';
const REFEREE = 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';

/** A deterministic byte source, so a failure here is reproducible. */
function keyFrom(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  let x = seed >>> 0;
  for (let i = 0; i < 32; i++) {
    // xorshift32 — not a PRNG anyone should trust, and nothing here needs one.
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const render = (cells: boolean[]): string[] =>
  Array.from({ length: GLYPH_SIZE }, (_, row) =>
    cells
      .slice(row * GLYPH_SIZE, row * GLYPH_SIZE + GLYPH_SIZE)
      .map((cell) => (cell ? '#' : '.'))
      .join('')
  );

describe('the glyph is a function of the key', () => {
  test('the same DID always draws the same glyph', () => {
    for (const did of [AUTHOR, REFEREE]) {
      const first = glyphSignature(glyphFor(did)!);
      for (let i = 0; i < 50; i++) {
        assert.equal(glyphSignature(glyphFor(did)!), first, `${did} drifted on call ${i}`);
      }
    }
  });

  test('and the same glyph across a thousand keys, drawn twice each', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      assert.equal(
        glyphSignature(glyphFromKey(keyFrom(seed))),
        glyphSignature(glyphFromKey(keyFrom(seed))),
        `seed ${seed} drew two different glyphs`
      );
    }
  });

  // The regression pin. If the mapping ever changes, every glyph anyone has
  // learned to recognise changes with it — so changing it should mean editing
  // this, deliberately, with the drawings in front of you.
  test('these two real DIDs draw these two exact marks', () => {
    assert.deepEqual(render(glyphFor(AUTHOR)!.cells), [
      '..#..',
      '.###.',
      '..#..',
      '#.#.#',
      '#####',
    ]);
    assert.equal(glyphFor(AUTHOR)!.weight, 1);

    assert.deepEqual(render(glyphFor(REFEREE)!.cells), [
      '..#..',
      '##.##',
      '..#..',
      '..#..',
      '.###.',
    ]);
    assert.equal(glyphFor(REFEREE)!.weight, 0);
  });
});

describe('the field', () => {
  test('is mirrored on the vertical axis', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { cells } = glyphFromKey(keyFrom(seed));
      for (let row = 0; row < GLYPH_SIZE; row++) {
        for (let col = 0; col < GLYPH_SIZE; col++) {
          assert.equal(
            cells[row * GLYPH_SIZE + col],
            cells[row * GLYPH_SIZE + (GLYPH_SIZE - 1 - col)],
            `seed ${seed} is not symmetric at row ${row}`
          );
        }
      }
    }
  });

  test('reads the first sixteen bytes and nothing after them', () => {
    const key = keyFrom(7);
    const before = glyphSignature(glyphFromKey(key));

    for (let i = GLYPH_BYTES; i < key.length; i++) {
      const altered = Uint8Array.from(key);
      altered[i] ^= 0xff;
      assert.equal(
        glyphSignature(glyphFromKey(altered)),
        before,
        `byte ${i} changed the glyph, and the glyph only reads the first ${GLYPH_BYTES}`
      );
    }
  });

  test('gives each decided byte exactly one cell, plus its reflection', () => {
    const key = keyFrom(11);
    const base = glyphFromKey(key).cells;

    for (let i = 0; i < GLYPH_DECIDED; i++) {
      const altered = Uint8Array.from(key);
      altered[i] ^= 1;
      const moved = glyphFromKey(altered).cells.filter((cell, at) => cell !== base[at]).length;
      // One cell when it lands on the axis, two either side of it.
      assert.ok(moved === 1 || moved === 2, `byte ${i} moved ${moved} cells`);
    }
  });

  test('takes its weight from byte fifteen, and there are four', () => {
    const seen = new Set<number>();
    for (let value = 0; value < 256; value++) {
      const key = keyFrom(3);
      key[GLYPH_DECIDED] = value;
      const { weight } = glyphFromKey(key);
      assert.ok(weight >= 0 && weight < GLYPH_WEIGHTS.length, `weight ${weight} is off the scale`);
      seen.add(weight);
    }
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
  });
});

describe('two different keys', () => {
  test('nearly always draw different marks, and this is the collision rate', () => {
    const signatures = new Set<string>();
    const total = 4000;
    for (let seed = 1; seed <= total; seed++) {
      signatures.add(glyphSignature(glyphFromKey(keyFrom(seed))));
    }

    // 15 cells and 4 weights is 131,072 possible marks, so 4,000 draws collide
    // a little by the birthday bound and that is the honest number rather than
    // a defect. It is also why the DID is printed beside every glyph on this
    // site: the mark helps you recognise someone you have seen before, and it
    // never identifies them.
    assert.ok(
      signatures.size > total * 0.95,
      `only ${signatures.size} of ${total} keys drew a distinct mark — the mapping has lost entropy`
    );
  });

  test('and the two DIDs this repo ships differ visibly', () => {
    const a = glyphFor(AUTHOR)!;
    const b = glyphFor(REFEREE)!;
    assert.notEqual(glyphSignature(a), glyphSignature(b));
    const differing = a.cells.filter((cell, at) => cell !== b.cells[at]).length;
    assert.ok(differing >= 4, `they differ by only ${differing} cells, which is not a glance apart`);
  });

  test('a one-bit change to a decided byte redraws the mark', () => {
    // Not true of the other sixteen bytes, and deliberately so — the test above
    // pins that. This is the half that matters for telling neighbours apart.
    for (let seed = 1; seed <= 100; seed++) {
      const key = keyFrom(seed);
      const before = glyphSignature(glyphFromKey(key));
      for (let i = 0; i < GLYPH_DECIDED; i++) {
        const altered = Uint8Array.from(key);
        altered[i] ^= 1;
        assert.notEqual(glyphSignature(glyphFromKey(altered)), before, `seed ${seed}, byte ${i}`);
      }
    }
  });
});

describe('what is not a key', () => {
  test('gets no glyph rather than an exception', () => {
    for (const input of [
      null,
      undefined,
      '',
      'nonsense',
      'did:key:zNotBase58btcAtAll0OIl',
      // A well-formed did:key for the wrong curve.
      'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme',
      AUTHOR.slice(0, 20),
      `${AUTHOR}x`,
    ]) {
      assert.equal(glyphFor(input as string), null, `${String(input)} should not have drawn`);
    }
  });

  test('a short key throws rather than drawing something invented', () => {
    assert.throws(() => glyphFromKey(new Uint8Array(GLYPH_BYTES - 1)), /needs 16 key bytes/);
  });

  test('every valid Ed25519 did:key draws', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const did = didFromPublicKey(keyFrom(seed));
      assert.ok(glyphFor(did), `${did} did not draw`);
    }
  });
});
