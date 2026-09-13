// merkle.ts — the tree that makes the archive tamper-evident.
//
// Notary's timestamp is the one thing in a record that a stranger cannot check
// for themselves. The signature proves who wrote the message; only Notary can
// say when it held it. That asymmetry is the whole reason this file exists: a
// daily root published into a public room turns "trust our clock" into "here is
// a commitment we made before you asked, reproduce it yourself".
//
// Pure. No database, no clock, no network — so the tree can be tested against
// hand-computed values, which is the only way to know a proof format is right.

import { createHash } from 'node:crypto';

/** A record reduced to the five fields the leaf commits to. */
export interface Leafish {
  did: string;
  room: string;
  /** A string. A nonce that has been through a double hashes to a lie. */
  nonce: string;
  sig: string;
  capturedAt: string;
}

/** One step on the path from a leaf to the root. */
export interface ProofStep {
  /** Which side the sibling sits on — needed to rebuild the parent in order. */
  side: 'left' | 'right';
  hash: string;
}

export interface Proof {
  index: number;
  leaf: string;
  steps: ProofStep[];
}

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

/**
 * The canonical leaf preimage, exactly as NOTARY.md specifies:
 * `<did>|<room>|<nonce>|<sig>|<captured_at_iso>`.
 *
 * The ISO string is the one written into the anchor, so `/record/:id` has to
 * serve captured_at in precisely this form or a verifier recomputing the leaf
 * would get a different hash and conclude — wrongly — that Notary had lied.
 * That is why `isoStamp` below is exported rather than left to each caller.
 */
export function leafPreimage(record: Leafish): string {
  return `${record.did}|${record.room}|${record.nonce}|${record.sig}|${record.capturedAt}`;
}

export function leafHash(record: Leafish): string {
  return sha256(leafPreimage(record));
}

/**
 * Postgres hands back a Date; JSON and the leaf need the same string every time.
 * `toISOString` gives millisecond precision UTC, which is what captured_at is
 * stored at.
 */
export function isoStamp(at: Date | string): string {
  return typeof at === 'string' ? new Date(at).toISOString() : at.toISOString();
}

/**
 * Hash two children into their parent.
 *
 * Concatenating the hex rather than the bytes: slower by an amount nobody will
 * ever measure on a day's records, and it keeps every intermediate value
 * something a person can paste into a shell and reproduce.
 */
const parent = (left: string, right: string): string => sha256(`${left}${right}`);

/**
 * Build the tree, bottom up, and return every level.
 *
 * AN ODD NODE IS PROMOTED, NOT DUPLICATED. Duplicating the last node — the
 * Bitcoin behaviour — makes two different leaf sets produce the same root,
 * because a tree of [a, b] and a tree of [a, b, b] collapse to the same value.
 * Here that would mean two different days' records could share a root, and the
 * root is the only thing standing behind the timestamps. Promotion has no such
 * collision.
 */
export function buildLevels(leaves: string[]): string[][] {
  if (leaves.length === 0) return [[]];
  const levels: string[][] = [leaves.slice()];

  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1];
    const above: string[] = [];
    for (let i = 0; i < below.length; i += 2) {
      above.push(i + 1 < below.length ? parent(below[i], below[i + 1]) : below[i]);
    }
    levels.push(above);
  }
  return levels;
}

/**
 * The root of a set of leaves.
 *
 * An empty day has no root rather than a root over nothing: publishing a fixed
 * hash for "nothing happened" would let a day with records be passed off as
 * empty later, which is exactly the edit the anchor exists to prevent.
 */
export function merkleRoot(leaves: string[]): string | null {
  if (leaves.length === 0) return null;
  const levels = buildLevels(leaves);
  return levels[levels.length - 1][0] ?? null;
}

/** The path from one leaf to the root. */
export function buildProof(leaves: string[], index: number): Proof | null {
  if (index < 0 || index >= leaves.length) return null;

  const levels = buildLevels(leaves);
  const steps: ProofStep[] = [];
  let i = index;

  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    const isRight = i % 2 === 1;
    const siblingIndex = isRight ? i - 1 : i + 1;

    // No sibling means this node was promoted rather than paired, so there is
    // nothing to record: the parent IS this node, and a verifier that skips the
    // step reaches the same value.
    if (siblingIndex < nodes.length) {
      steps.push({ side: isRight ? 'left' : 'right', hash: nodes[siblingIndex] });
    }
    i = Math.floor(i / 2);
  }

  return { index, leaf: leaves[index], steps };
}

/**
 * Recompute a root from a leaf and its path.
 *
 * This is the function a sceptic reimplements, so it is deliberately the
 * smallest thing in the file: fold the steps in, compare. The API serves
 * everything it needs and nothing it does not.
 */
export function rootFromProof(leaf: string, steps: ProofStep[]): string {
  return steps.reduce(
    (acc, step) => (step.side === 'left' ? parent(step.hash, acc) : parent(acc, step.hash)),
    leaf
  );
}

export function verifyProof(proof: Proof, root: string): boolean {
  return rootFromProof(proof.leaf, proof.steps) === root;
}
