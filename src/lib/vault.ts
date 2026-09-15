// vault.ts — reading a note, and remembering that you saw it.
//
// Two halves, and the second is the reason the page exists.
//
// ---------------------------------------------------------------------------
// READING. A note is one line of text somebody wrote. The server stores it and
// says nothing about it — not who wrote it, not when, not whether it means
// anything. So everything below is a CONVENTION observed in the wild, offered
// as a reading BESIDE the raw line and never instead of it. A note that does
// not match any of them is not malformed; it is a note, and the raw line is
// always the truth.
//
// The conventions here were checked against the live network rather than taken
// from a document:
//
//   FIELDS    `did:key:z6Mk… x25519:<b64url> mailbox:mb-p-…` — space-separated
//             `name:value` pairs on one line. The commonest shape by far.
//   BARE DID  a note whose whole content is one did:key. room-owners is all of
//             these; so is most of did-<shard> and agent.
//   JSON      an object. Some DID notes carry one instead of fields.
//   DELEGATE  `delegate: <agent-did> <scope> <expires> <nonce> <sig>` inside a
//             DID note, as llms.txt specifies. Found by scanning for the token
//             and taking the five fields after it — NEVER by splitting lines,
//             because the sweep has already turned every newline into a space.
//
// ---------------------------------------------------------------------------
// THE EXPIRY PROBLEM, and what this file refuses to do about it.
//
// A note untouched for seven days is reclaimed. That clock is real, it is
// running, and NOTHING on the network exposes it: there is no written-at, no
// expires-at, no age. Foolscap cannot see it either.
//
// So there is no countdown here and there must never be one. What there is
// instead is a record of OBSERVATIONS — the times Foolscap itself looked at a
// namespace and found a key present — and a comparison between the last look
// and this one. "This key was here on Monday and is not here now" is something
// Foolscap actually knows. "This key expires in three days" is not, and a page
// that said it would be inventing the one number the server withholds.
//
// The difference is not pedantry. A countdown would be wrong in both
// directions: a note rewritten an hour ago has a full week left and would show
// as expiring, and a note nobody has touched in six days would show as fresh
// because Foolscap first saw it this morning.

import { looksLikeDid, verify, DID_KEY_ED25519_RE, SIGNATURE_RE } from './did.ts';

// ---------------------------------------------------------------------------
// Reading a note
// ---------------------------------------------------------------------------

export type NoteShape = 'fields' | 'did' | 'json' | 'text' | 'empty';

export interface Field {
  name: string;
  value: string;
  /** True where the value is itself an Ed25519 did:key. */
  isDid: boolean;
}

export interface DelegateRecord {
  agent: string;
  scope: string;
  expires: number;
  nonce: string;
  sig: string;
}

export interface NoteReading {
  shape: NoteShape;
  /** Parsed `name:value` pairs, for the fields shape. */
  fields: Field[];
  /** The did:key this note is about, where there is an unambiguous one. */
  did: string | null;
  /** Pretty-printed, for the json shape. Null otherwise. */
  json: string | null;
  /** Delegate records found by scanning for the token. */
  delegates: DelegateRecord[];
}

/**
 * What a note appears to be.
 *
 * Order matters: JSON is checked first because a JSON object containing a colon
 * would otherwise parse as a field list, and a bare DID before fields because
 * `did:key:z6Mk…` is itself a `name:value` pair and reading it as one would
 * report the field `did` with the value `key:z6Mk…`.
 */
export function readNote(value: string | null): NoteReading {
  const empty: NoteReading = { shape: 'empty', fields: [], did: null, json: null, delegates: [] };
  const text = (value ?? '').trim();
  if (text === '') return empty;

  const delegates = findDelegates(text);

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const did = typeof parsed.did === 'string' && looksLikeDid(parsed.did) ? parsed.did : null;
      return { shape: 'json', fields: [], did, json: JSON.stringify(parsed, null, 2), delegates };
    } catch {
      // Not JSON after all. Fall through and read it as anything else.
    }
  }

  if (looksLikeDid(text)) {
    return { shape: 'did', fields: [], did: text, json: null, delegates };
  }

  const fields = parseFields(text);
  if (fields.length > 0) {
    const didField = fields.find((field) => field.isDid);
    return { shape: 'fields', fields, did: didField?.value ?? null, json: null, delegates };
  }

  return { shape: 'text', fields: [], did: null, json: null, delegates };
}

/**
 * Space-separated `name:value` pairs.
 *
 * A did:key value contains colons of its own, so the split is on the FIRST
 * colon only and the whole remainder is the value. A token with no colon is not
 * a field and makes the whole thing prose — which is the right answer for a
 * topic note that happens to contain a URL.
 */
export function parseFields(text: string): Field[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const fields: Field[] = [];
  for (const token of tokens) {
    const at = token.indexOf(':');
    if (at <= 0 || at === token.length - 1) return [];
    const name = token.slice(0, at);
    const value = token.slice(at + 1);
    // `did:key:z6Mk…` is the one field whose name is two segments.
    if (name === 'did' && value.startsWith('key:')) {
      fields.push({ name: 'did:key', value: token, isDid: looksLikeDid(token) });
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return [];
    fields.push({ name, value, isDid: looksLikeDid(value) });
  }
  return fields;
}

/**
 * Delegate records, found by scanning for the token.
 *
 * llms.txt is explicit about this: "find records by scanning the note's fields
 * for the `delegate:` token and taking the five after it, never by splitting
 * lines." A note is one line whatever was written, because the sweep collapsed
 * the newlines, so a line-splitting parser would find exactly one record in a
 * note carrying three.
 */
export function findDelegates(text: string): DelegateRecord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: DelegateRecord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'delegate:') continue;
    const [agent, scope, expires, nonce, sig] = tokens.slice(i + 1, i + 6);
    if (!agent || !scope || !expires || !nonce || !sig) continue;
    if (!DID_KEY_ED25519_RE.test(agent)) continue;
    if (!/^\d{1,12}$/.test(expires)) continue;
    out.push({
      agent,
      scope,
      expires: Number(expires),
      nonce,
      sig,
    });
    i += 5;
  }
  return out;
}

/**
 * Check a delegate record against the key whose note it sits in.
 *
 * The signature covers `delegate|<root-did>|<agent-did>|<scope>|<expires>|<nonce>`,
 * and the ROOT DID IS INSIDE IT — which is the property that matters: a record
 * copied out of somebody else's note does not survive being checked against the
 * note it was pasted into. That is the whole of the delegation security model
 * and it is checkable here, in the browser, with no key and no network.
 */
export async function checkDelegate(
  record: DelegateRecord,
  rootDid: string
): Promise<{ ok: boolean; reason: string | null; message: string; expired: boolean; expiresAt: number }> {
  const message = [
    'delegate',
    rootDid,
    record.agent,
    record.scope,
    String(record.expires),
    record.nonce,
  ].join('|');
  const expiresAt = record.expires * 1000;
  const expired = Number.isFinite(expiresAt) && expiresAt < Date.now();

  if (!SIGNATURE_RE.test(record.sig)) {
    return { ok: false, reason: 'The signature is not 86 base64url characters.', message, expired, expiresAt };
  }
  try {
    const ok = await verify(rootDid, message, record.sig);
    return {
      ok,
      reason: ok
        ? null
        : 'The signature does not check out against this note’s own key. A record copied from ' +
          'another note fails exactly like this.',
      message,
      expired,
      expiresAt,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, message, expired, expiresAt };
  }
}

/**
 * Does this note prove anything about who wrote it?
 *
 * Almost always no, and saying so is the point. Every namespace but two is
 * world-writable and unsigned: anyone may overwrite any note, and a did:key
 * sitting in one is a string somebody typed. The two exceptions are the
 * server's own signed-write lanes.
 */
export const SIGNED_NAMESPACES = new Set(['room-owners', 'room-allow']);

export function authorityOf(ns: string): { signedLane: boolean; note: string } {
  if (SIGNED_NAMESPACES.has(ns)) {
    return {
      signedLane: true,
      note:
        `Writes to ${ns} are signature-checked by the server — it is one of only two namespaces ` +
        'where that is true. What is here was written by a key that could sign for it.',
    };
  }
  return {
    signedLane: false,
    note:
      'This note is world-writable and carries no signature the server checks. Anyone can ' +
      'overwrite it with one request, and a did:key inside it is a string somebody typed, not ' +
      'proof that key wrote it.',
  };
}

// ---------------------------------------------------------------------------
// Watching — observations, never predictions
// ---------------------------------------------------------------------------

export interface Sighting {
  /** When Foolscap last looked at this namespace, ms. Its own clock. */
  lastLookedMs: number;
  /** Keys present at that look. */
  keys: string[];
}

export interface Watch {
  ns: string;
  sighting: Sighting | null;
}

export interface Change {
  ns: string;
  /** Keys that were there last time and are not now. */
  gone: string[];
  /** Keys that were not there last time and are now. */
  arrived: string[];
  /** How long ago the previous look was. Null on a first look. */
  sinceMs: number | null;
}

/**
 * What changed between the last look and this one.
 *
 * AN OBSERVATION, NOT A PREDICTION, and the wording of everything built on it
 * has to keep saying so. A key in `gone` may have been reclaimed by the
 * seven-day sweep, or deleted, or overwritten to empty, or the listing may have
 * been served from a cache. What Foolscap knows is that it was in one listing
 * and not in the next.
 *
 * A first look produces no changes at all — not "everything arrived", which
 * would read as news. There is nothing to compare against yet.
 */
export function diffSighting(
  previous: Sighting | null,
  keys: string[],
  now: number
): Change & { sighting: Sighting } {
  const sighting: Sighting = { lastLookedMs: now, keys: [...keys] };
  if (!previous) {
    return { ns: '', gone: [], arrived: [], sinceMs: null, sighting };
  }
  const before = new Set(previous.keys);
  const after = new Set(keys);
  return {
    ns: '',
    gone: previous.keys.filter((key) => !after.has(key)),
    arrived: keys.filter((key) => !before.has(key)),
    sinceMs: now - previous.lastLookedMs,
    sighting,
  };
}

/**
 * How to describe a gap between looks, without implying a deadline.
 *
 * ALL THIS SAYS IS HOW WIDE THE WINDOW IS. It is tempting to go further — I
 * wrote a version that did, and it was wrong: "it was still here two days ago,
 * so the seven-day sweep cannot have taken it". That does not follow. Being
 * present at the first look only proves the note had been WRITTEN within the
 * seven days before THAT, not that it had seven days left. A note written six
 * days before Monday is present on Monday and reclaimed by Wednesday, and a gap
 * of two days rules nothing out.
 *
 * So the gap bounds when a key went and nothing else. Which of decay, deletion
 * and overwrite took it is not knowable from here at any gap length, and the
 * page says so rather than picking the interesting-sounding one.
 */
export function describeGap(sinceMs: number | null): string | null {
  if (sinceMs == null) return null;
  const how = sinceMs >= DECAY_WINDOW_MS ? 'More than seven days' : 'Less than seven days';
  return (
    `${how} passed between these two looks, so anything missing went somewhere in that window. ` +
    'Whether it was reclaimed by the seven-day sweep, deleted, or overwritten is not something ' +
    'this page can tell — the server publishes nothing that would separate them.'
  );
}

const DECAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
