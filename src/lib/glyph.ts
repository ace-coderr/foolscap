// glyph.ts — a DID, drawn.
//
// Every identity on this network is 32 bytes wearing a base58 coat. A column of
// `z6Mkf9...` truncations is unreadable at a glance and unmemorable at any
// speed, so a reader scanning a room cannot tell two participants apart without
// stopping to read. These bytes can draw themselves instead.
//
// THE SHAPE. A 5x5 field, mirrored on the vertical axis, so only fifteen cells
// are actually decided — columns 0, 1 and 2, with 3 and 4 reflecting 1 and 0.
// Symmetry is what makes the result read as a mark rather than as noise, and it
// is the same trick every identicon has used since the original.
//
// ONE BYTE PER DECIDED CELL, low bit set. DESIGN.md's amendment says "take the
// first 9 bytes; map each to a cell ... so only 15 cells are decided", and those
// two halves cannot both be true: nine bytes cannot be mapped one-to-one onto
// fifteen cells. The alternative readings are worse — spreading fifteen bits
// across nine bytes means fifteen bits drawn from the first two of them, with
// seven bytes of the key ignored — so the cell count wins and the byte count
// gives: bytes 0-14 decide the fifteen cells, byte 15 sets the weight.
//
// WHAT A GLYPH IS NOT. Fifteen cells is fifteen bits, so there are 32,768
// possible fields and two different DIDs can land on the same one. That is fine
// for what this does — recognising a participant you have already seen, in a
// room with a handful of them — and it is not fine for anything else. A glyph
// is never proof of identity. Where a DID is the evidence, the DID is printed
// in full; the glyph sits beside it, never instead of it. Every page carrying
// one says so in its questions.
//
// Two consequences worth expecting rather than filing: about one key in 32,768
// draws an empty field and about one in 32,768 draws a full one. Both are the
// rule working.
//
// Pure, synchronous and dependency-free apart from the did:key decoder, so it
// can be pinned by a test and called during render without an await.

import { publicKeyFromDid, type Bytes } from './did.ts';

/** The field is 5x5. */
export const GLYPH_SIZE = 5;

/** ...of which this many cells are decided; the rest are reflections. */
export const GLYPH_DECIDED = 15;

/**
 * Four weights, evenly spaced, so a wall of glyphs has texture rather than one
 * flat tone. Opacity only — a glyph is identity, and identity is not state, so
 * it never takes a hue.
 */
export const GLYPH_WEIGHTS = [0.6, 0.73, 0.86, 1] as const;

export interface Glyph {
  /** 25 cells, row-major. Symmetric about the vertical axis. */
  cells: boolean[];
  /** 0-3, an index into GLYPH_WEIGHTS. */
  weight: number;
  /** How many of the 25 are set. Handy for a test, and for nothing else. */
  filled: number;
}

/** The number of key bytes a glyph consumes: fifteen cells plus the weight. */
export const GLYPH_BYTES = GLYPH_DECIDED + 1;

/**
 * Draw the field for 32 raw public key bytes.
 *
 * Throws on a short key rather than padding one: a glyph derived from bytes
 * that were not in the key is a glyph that does not identify anything.
 */
export function glyphFromKey(key: Uint8Array | Bytes): Glyph {
  if (key.length < GLYPH_BYTES) {
    throw new Error(`A glyph needs ${GLYPH_BYTES} key bytes; got ${key.length}`);
  }

  const cells = new Array<boolean>(GLYPH_SIZE * GLYPH_SIZE).fill(false);
  let byte = 0;
  let filled = 0;

  for (let row = 0; row < GLYPH_SIZE; row++) {
    for (let col = 0; col < 3; col++) {
      const set = (key[byte++] & 1) === 1;
      if (!set) continue;
      cells[row * GLYPH_SIZE + col] = true;
      // Column 2 is the axis and reflects onto itself, so it is counted once.
      const mirror = GLYPH_SIZE - 1 - col;
      cells[row * GLYPH_SIZE + mirror] = true;
      filled += mirror === col ? 1 : 2;
    }
  }

  return { cells, weight: key[GLYPH_DECIDED] & 0b11, filled };
}

/**
 * Draw the field for a did:key string, or null if it is not one.
 *
 * Null rather than a throw because this is called during render, over message
 * rows that arrived from a room and can contain anything at all. A message with
 * a malformed `from` gets no glyph; it does not take the page down.
 */
export function glyphFor(did: string | null | undefined): Glyph | null {
  if (typeof did !== 'string' || did.length === 0) return null;
  try {
    return glyphFromKey(publicKeyFromDid(did));
  } catch {
    return null;
  }
}

/**
 * A glyph as one comparable string: cells, then weight.
 *
 * Only for tests and for React keys. Nothing user-facing should print this —
 * it is fifteen bits of a public key wearing a costume, and a reader could
 * reasonably mistake it for the key.
 */
export function glyphSignature(glyph: Glyph): string {
  return `${glyph.cells.map((cell) => (cell ? '1' : '0')).join('')}:${glyph.weight}`;
}
