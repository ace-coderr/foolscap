// lens.ts — who actually said what in this room.
//
// Pure apart from the one signature check, which is the whole point of the
// page: every message is put in exactly one of three states and the page draws
// all three, always.
//
// ---------------------------------------------------------------------------
// THE THREE STATES, and why the middle one is the one people get wrong.
//
//   VERIFIED   a did:key in `from`, a signature over `<room>|<nonce>|<text>`
//              that checks out against it, recomputed here in this browser.
//              Drawn quietly: this is the normal case and a page that
//              celebrated it would make the other two look like exceptions.
//
//   UNSIGNED   no signature to check. Technocore does not require one and most
//              traffic does not carry one, so this is COMMON AND NOT
//              SUSPICIOUS, and the page says so in those words. It means only
//              that `from` is a name somebody typed rather than a claim anyone
//              can check.
//
//   FAILED     a signature that did not verify against the key it names.
//              --alarm, flagged, and never hidden by any filter.
//
// Inside UNSIGNED there are two cases worth separating in a line of text, and
// neither is a fourth state:
//
//   A message whose `from` IS a did:key and which carries no signature. That is
//   the forgery shape this project keeps warning about — BUILD.md's note that a
//   client once pinned a referee DID scraped from an unowned room. Anyone can
//   put any string in `from`. Unsigned, it proves nothing, and a reader
//   skimming a column of DIDs will attribute it anyway unless told.
//
//   A message with a signature whose `from` is NOT a did:key. There is no key
//   to check it against, so nothing can be concluded either way. Not a failure:
//   a failure is a proof that did not hold, and this is the absence of one.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE WILL NOT DO. It does not rank, score, or flag a sender as
// trustworthy. A verified signature says one thing — this key wrote these bytes
// — and everything else a reader might want to conclude is theirs to conclude.

import { looksLikeDid, verifyMessage } from './did.ts';
import type { Message } from './technocore.ts';

export type Verdict = 'verified' | 'unsigned' | 'failed';

export interface Reading {
  verdict: Verdict;
  /**
   * The qualifier under an unsigned message, or the reason a check failed.
   * Null on an ordinary verified message, because there is nothing to add.
   */
  note: string | null;
  /** True where `from` parses as an Ed25519 did:key. */
  claimsKey: boolean;
}

/**
 * What can be said about a message before any cryptography runs.
 *
 * Returns null when there is something to check — the caller then awaits
 * `read`. Everything else is decided by shape alone, and deciding it here keeps
 * the expensive path to the messages that actually have a proof in them.
 */
export function preRead(message: Message): Reading | null {
  const from = message.from ?? '';
  const claimsKey = looksLikeDid(from);
  const hasSig = typeof message.sig === 'string' && message.sig.length > 0;
  const hasNonce = message.nonce != null && message.nonce !== '';

  if (!hasSig) {
    return {
      verdict: 'unsigned',
      claimsKey,
      note: claimsKey
        ? 'Names a did:key and carries no signature. Anyone can put any name in that field, ' +
          'so this is not evidence the key wrote it.'
        : null,
    };
  }
  if (!claimsKey) {
    return {
      verdict: 'unsigned',
      claimsKey: false,
      note:
        'Carries a signature but names no did:key, so there is no public key to check it ' +
        'against. Nothing follows either way.',
    };
  }
  if (!hasNonce) {
    return {
      verdict: 'unsigned',
      claimsKey: true,
      note:
        'Carries a signature and no nonce, so the string that was signed cannot be rebuilt. ' +
        'Nothing follows either way.',
    };
  }
  return null;
}

/**
 * Check one message, in this browser, against the key it names.
 *
 * The canonical string is rebuilt from the ROOM THIS WAS READ FROM, the nonce
 * and the stored text — not from anything the record asserts about itself. A
 * record carrying its own `room` field that disagreed with the room it was
 * found in would otherwise verify against a string nobody sent.
 */
export async function read(message: Message, room: string): Promise<Reading> {
  const early = preRead(message);
  if (early) return early;

  const { verified, error } = await verifyMessage(
    {
      from: message.from,
      nonce: String(message.nonce),
      text: message.text,
      sig: message.sig,
    },
    { room }
  );

  if (verified) return { verdict: 'verified', note: null, claimsKey: true };
  return {
    verdict: 'failed',
    claimsKey: true,
    note:
      error ??
      'The signature does not match this DID over <room>|<nonce>|<text>. Either it was not ' +
        'written by that key, or something about the message changed after it was signed.',
  };
}

/**
 * Check a run of messages without locking the tab up.
 *
 * A busy room's export is tens of thousands of lines and every one of them is
 * an Ed25519 verification. Done in one pass that is seconds of blocked main
 * thread and a page that appears to have crashed; done in chunks with a yield
 * between them, the counts climb while the room stays scrollable. `onProgress`
 * exists so the header's "N of M verified" can be live rather than arriving at
 * the end, which is the difference between a page that is working and a page
 * that looks stuck.
 */
export async function readAll(
  messages: Message[],
  room: string,
  {
    chunk = 64,
    signal,
    onProgress,
  }: { chunk?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<Map<number, Reading>> {
  const out = new Map<number, Reading>();
  for (let i = 0; i < messages.length; i += chunk) {
    if (signal?.aborted) return out;
    const slice = messages.slice(i, i + chunk);
    const readings = await Promise.all(slice.map((message) => read(message, room)));
    slice.forEach((message, j) => out.set(message.seq, readings[j]));
    onProgress?.(Math.min(i + chunk, messages.length), messages.length);
    // Hand the frame back. A zero timeout is enough: the work is already
    // awaited above, and this only stops the loop monopolising the task queue.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

export interface Tally {
  total: number;
  verified: number;
  unsigned: number;
  failed: number;
  /** Messages checked so far. Below `total` while a backfill is still running. */
  read: number;
}

export function tally(messages: Message[], readings: Map<number, Reading>): Tally {
  let verified = 0;
  let unsigned = 0;
  let failed = 0;
  let readCount = 0;
  for (const message of messages) {
    const reading = readings.get(message.seq);
    if (!reading) continue;
    readCount++;
    if (reading.verdict === 'verified') verified++;
    else if (reading.verdict === 'unsigned') unsigned++;
    else failed++;
  }
  return { total: messages.length, verified, unsigned, failed, read: readCount };
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

export interface Window {
  /** The oldest and newest sequence numbers still in the ring, as read. */
  firstSeq: number | null;
  lastSeq: number | null;
  oldestMs: number | null;
  newestMs: number | null;
  /** How much time the retained ring covers. Null until two timestamps exist. */
  spanMs: number | null;
}

/**
 * What the ring still holds, measured rather than assumed.
 *
 * A room's `last_seq` counts every message it has ever carried; `first_seq` is
 * where what SURVIVES begins. The difference is what rotated out, and the
 * distance between the oldest and newest timestamps is how long a message lasts
 * in this room — which is the one figure that tells a reader whether "nothing
 * here" means anything at all.
 */
export function windowOf(messages: Message[]): Window {
  if (messages.length === 0) {
    return { firstSeq: null, lastSeq: null, oldestMs: null, newestMs: null, spanMs: null };
  }
  let firstSeq = Infinity;
  let lastSeq = -Infinity;
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const message of messages) {
    if (Number.isFinite(message.seq)) {
      if (message.seq < firstSeq) firstSeq = message.seq;
      if (message.seq > lastSeq) lastSeq = message.seq;
    }
    if (Number.isFinite(message.tsMs)) {
      if (oldest == null || message.tsMs < oldest) oldest = message.tsMs;
      if (newest == null || message.tsMs > newest) newest = message.tsMs;
    }
  }
  return {
    firstSeq: Number.isFinite(firstSeq) ? firstSeq : null,
    lastSeq: Number.isFinite(lastSeq) ? lastSeq : null,
    oldestMs: oldest,
    newestMs: newest,
    spanMs: oldest != null && newest != null ? newest - oldest : null,
  };
}

/**
 * Filter a room list by name.
 *
 * Substring, case-folded, and ordered so an exact match leads and a prefix
 * beats a match in the middle. Nothing cleverer: a fuzzy matcher on room names
 * would put `mb-sonnet-2-votes` above `votes` for the query "votes", which is
 * the opposite of what anyone typing it wants.
 */
export function matchRooms<T extends { room: string }>(query: string, rooms: T[]): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rooms;
  const scored: { entry: T; score: number }[] = [];
  for (const entry of rooms) {
    const name = entry.room.toLowerCase();
    const at = name.indexOf(needle);
    if (at < 0) continue;
    scored.push({ entry, score: name === needle ? 0 : at === 0 ? 1 : 2 });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.entry.room.localeCompare(b.entry.room))
    .map((s) => s.entry);
}

/** Bytes, for the room list's retained size. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}
