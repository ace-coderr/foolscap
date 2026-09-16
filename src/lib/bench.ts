// bench.ts — the shapes the bench knows, and the checks it makes before the
// user spends a request.
//
// Pure. No network, no clock it was not handed, no DOM. Everything here is a
// rule a user could apply themselves; the page is a way of not having to.
//
// WHAT THIS FILE IS NOT. It is not a schema validator and it must not become
// one. Technocore accepts any text in any room — the types below are a
// convention the contest uses, not something the server enforces — so a shape
// this file does not recognise is a message Foolscap has nothing to say about,
// never a message Foolscap refuses to build. The freeform path is the default
// for exactly that reason, and every known shape is a template the user can
// edit or delete.

import { compareNonce, validateNonce } from './did.ts';
import { isReceiptedType, ROOMS } from './contest.ts';

/**
 * A message shape worth offering a skeleton for.
 *
 * `room` is where the type is normally posted, and it is a SUGGESTION the page
 * applies when you pick the shape — not a constraint. Nothing stops anyone
 * posting anything anywhere, and a bench that pretended otherwise would be
 * lying about the network it writes to.
 *
 * The templates carry the fields each type is observed to carry, with the
 * values left as placeholders. They are a starting point for editing, which is
 * why the text area stays the source of truth: what gets signed is what is in
 * it, not what this file thinks the shape should be.
 */
export interface Shape {
  type: string;
  label: string;
  room: string | null;
  /** One line on what the type is for. Shown under the picker. */
  summary: string;
  /** What a reader most needs warning about before they spend a request. */
  note: string | null;
  template: Record<string, unknown>;
}

const RID = '<a fresh id per attempt>';

/**
 * Where a witnessing submission goes.
 *
 * It matches NOTARY_ROOM in services/notary/src/api.ts, which is what /capture
 * defaults to when a caller does not name a room. Written here as a literal
 * rather than imported: the service is a separate workspace with its own
 * deployment, and a browser bundle that reached into it for one string would
 * be a build dependency on a thing that is not built.
 */
const NOTARY_ROOM = 'foolscap-notary';

export const SHAPES: Shape[] = [
  {
    // FIRST, BECAUSE IT IS THE ONE SHAPE THAT ANSWERS TO FOOLSCAP ITSELF.
    // Everything else here is a message to the sonnet-2 referee, which may or
    // may not still be listening; this one is a submission to Notary, and
    // Notary is the reason /bench and /notary are one flow rather than two
    // pages that happen to be on the same site.
    type: 'notary.witness.v1',
    label: 'notary.witness.v1 — have Notary witness this key',
    room: NOTARY_ROOM,
    summary:
      'Submits a signed message to Notary, which checks the signature, stamps it with its own ' +
      'clock, keeps it whole and folds it into that day’s Merkle root. Not receipted — the ' +
      'referee has nothing to do with this one; Notary answers it directly with a record id.',
    note:
      'Notary does not watch rooms and will not come and find your key — this is how a key gets ' +
      'on the record at all. One submission is enough to give it a witnessed origin; submit ' +
      'again whenever you want another moment on the record. It is idempotent on ' +
      '(did, room, nonce), so a retry returns the original rather than minting a second record. ' +
      'The text is yours: Notary vouches for the key and the moment, never for what it says.',
    template: {
      type: 'notary.witness.v1',
      statement: '<anything you want on the record>',
      request_id: RID,
    },
  },
  {
    type: 'sonnet.register.v1',
    label: 'sonnet.register.v1 — register for the contest',
    room: ROOMS.registration,
    summary: 'Asks the referee to register this DID in a role. Answered with a receipt.',
    note:
      'Writers must give a canonical https://x.com/<handle> URL; voters and organizers must ' +
      'omit the field entirely. Writer and voter also need signed activity before the identity ' +
      'cutoff. Only an ACCEPTED registration fixes the role — a rejection costs nothing and can ' +
      'be retried with a new request_id, so trying writer first is free.',
    template: {
      type: 'sonnet.register.v1',
      contest_id: 'sonnet-2',
      role: 'writer',
      x_account_url: 'https://x.com/<handle>',
      request_id: RID,
    },
  },
  {
    type: 'sonnet.submit.v1',
    label: 'sonnet.submit.v1 — submit a completed poem',
    room: ROOMS.submissions,
    summary: 'A completion packet. Answered with a receipt.',
    note: null,
    template: { type: 'sonnet.submit.v1', contest_id: 'sonnet-2', request_id: RID },
  },
  {
    type: 'sonnet.ballot.v1',
    label: 'sonnet.ballot.v1 — cast a vote',
    room: ROOMS.votes,
    summary: 'A ballot. Answered with a receipt.',
    note: null,
    template: { type: 'sonnet.ballot.v1', contest_id: 'sonnet-2', request_id: RID },
  },
  {
    type: 'sonnet.team-request.v1',
    label: 'sonnet.team-request.v1 — ask to join or form a team',
    room: ROOMS.discovery,
    summary: 'A team request. Answered with a receipt.',
    note: null,
    template: { type: 'sonnet.team-request.v1', contest_id: 'sonnet-2', request_id: RID },
  },
  {
    type: 'sonnet.roster.v1',
    label: 'sonnet.roster.v1 — declare a team roster',
    room: ROOMS.discovery,
    summary: 'A roster declaration. Answered with a receipt.',
    note: 'Members have to consent separately with sonnet.roster-consent.v1.',
    template: { type: 'sonnet.roster.v1', contest_id: 'sonnet-2', request_id: RID },
  },
  {
    type: 'sonnet.invite.v1',
    label: 'sonnet.invite.v1 — invite someone to a team',
    room: ROOMS.campaign,
    summary: 'An invitation. Answered with a receipt.',
    note: null,
    template: { type: 'sonnet.invite.v1', contest_id: 'sonnet-2', request_id: RID },
  },
  {
    type: 'sonnet.withdraw.v1',
    label: 'sonnet.withdraw.v1 — withdraw an entry',
    room: ROOMS.registration,
    summary: 'A withdrawal. Answered with a receipt.',
    note: null,
    template: { type: 'sonnet.withdraw.v1', contest_id: 'sonnet-2', request_id: RID },
  },
  {
    type: 'sonnet.claim.v1',
    label: 'sonnet.claim.v1 — claim a prize',
    room: ROOMS.registration,
    summary: 'A prize claim. Named in the contest package; answered with a receipt.',
    note: 'No claim receipt has been seen in the live rooms yet — this shape is from the package.',
    template: { type: 'sonnet.claim.v1', contest_id: 'sonnet-2', request_id: RID },
  },

  // --- the unreceipted half ------------------------------------------------
  // Posting one of these is not a request. It puts a message in a room and that
  // is the whole of it: no intake queue, no receipt, nothing to track. The page
  // says so, because "sent and never answered" reads as a failure otherwise.
  {
    type: 'sonnet.question.v1',
    label: 'sonnet.question.v1 — ask a question',
    room: ROOMS.registration,
    summary: 'A question in the open. Not receipted — nobody is obliged to answer.',
    note: null,
    template: { type: 'sonnet.question.v1', contest_id: 'sonnet-2', text: '<your question>' },
  },
  {
    type: 'sonnet.reply.v1',
    label: 'sonnet.reply.v1 — reply to a message',
    room: ROOMS.registration,
    summary: 'A reply. Not receipted.',
    note: null,
    template: { type: 'sonnet.reply.v1', contest_id: 'sonnet-2', text: '<your reply>' },
  },
  {
    type: 'sonnet.roster-consent.v1',
    label: 'sonnet.roster-consent.v1 — consent to being on a roster',
    room: ROOMS.discovery,
    summary: 'Consent to a roster that names you. Not receipted.',
    note: null,
    template: { type: 'sonnet.roster-consent.v1', contest_id: 'sonnet-2' },
  },
  {
    type: 'sonnet.recruit.v1',
    label: 'sonnet.recruit.v1 — recruit teammates',
    room: ROOMS.discovery,
    summary: 'A recruiting post. Not receipted.',
    note: null,
    template: { type: 'sonnet.recruit.v1', contest_id: 'sonnet-2', text: '<what you are after>' },
  },
  {
    type: 'sonnet.application.v1',
    label: 'sonnet.application.v1 — apply to a team',
    room: ROOMS.discovery,
    summary: 'An application to a team. Not receipted.',
    note: null,
    template: { type: 'sonnet.application.v1', contest_id: 'sonnet-2', text: '<your case>' },
  },
  {
    type: 'sonnet.word.v1',
    label: 'sonnet.word.v1 — propose a word',
    room: null,
    summary: 'A word proposal, in a per-team room. Not receipted.',
    note: 'Team rooms are d-sonnet-2-team-<game_id>; set the room yourself.',
    template: { type: 'sonnet.word.v1', contest_id: 'sonnet-2', word: '<one word>' },
  },
  {
    type: 'sonnet.poem-complete.v1',
    label: 'sonnet.poem-complete.v1 — announce a finished poem',
    room: null,
    summary: 'An announcement in a team room. Not receipted.',
    note: null,
    template: { type: 'sonnet.poem-complete.v1', contest_id: 'sonnet-2' },
  },
  {
    type: 'sonnet.note.v1',
    label: 'sonnet.note.v1 — a general note',
    room: ROOMS.registration,
    summary: 'A note. Not receipted.',
    note: null,
    template: { type: 'sonnet.note.v1', contest_id: 'sonnet-2', text: '<your note>' },
  },
];

/**
 * Which types the referee answers is contest.ts's question, and it is asked
 * there rather than answered again here. Re-exported so a caller that only
 * knows about the bench does not have to know where the list lives.
 */
export { RECEIPTED_TYPES, isReceiptedType } from './contest.ts';

export const shapeFor = (type: string): Shape | null =>
  SHAPES.find((shape) => shape.type === type) ?? null;

/**
 * A shape's skeleton, formatted the way it will be SIGNED if left alone.
 *
 * ONE LINE, and pretty-printing it was wrong for a reason that only showed up
 * on screen. Indented JSON contains newlines, the server's sweep turns every
 * newline into a space, so a pretty template tripped the "the sweep changed
 * this" warning the instant it was inserted — on every shape, every time. A
 * warning that is always on is a warning nobody reads, and this one has to
 * survive for the one occasion it matters.
 *
 * It also makes the slab honest: what is in the text area is character for
 * character what appears in the canonical string above it.
 */
export function templateText(shape: Shape): string {
  return JSON.stringify(shape.template);
}

/**
 * A request id that is unique per attempt.
 *
 * BUILD.md: "must be unique per attempt. Generate one; don't let them reuse a
 * rejected one." Reusing the id of a rejected attempt is the quiet way to make
 * a retry look like a duplicate.
 */
export function requestId(random: () => number = Math.random): string {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues && random === Math.random) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256) & 0xff;
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// What the text is
// ---------------------------------------------------------------------------

export interface TextReading {
  /** Whether it parses as JSON at all. Freeform text is fine and this is false. */
  json: boolean;
  /** The `type` field, when there is one. */
  type: string | null;
  /** True where the type is one the referee answers. */
  receipted: boolean;
  /** Set when the text looks like it wants to be JSON and is not. */
  problem: string | null;
}

/**
 * Read the text the way the referee will.
 *
 * A LEADING BRACE IS THE TELL. Plain prose is a perfectly good Technocore
 * message and gets no complaint here. But text that starts with `{` and does
 * not parse is somebody who meant to send a packet and has a typo in it, and
 * that is worth catching before they sign — after signing, the fix costs a new
 * nonce and a second trip to wherever their key lives.
 */
export function readText(text: string): TextReading {
  const trimmed = text.trim();
  const looksJson = trimmed.startsWith('{');
  if (!looksJson) return { json: false, type: null, receipted: false, problem: null };

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    return {
      json: false,
      type: null,
      receipted: false,
      problem: `This starts with { but is not valid JSON: ${(err as Error).message}`,
    };
  }
  const type =
    typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
      ? ((value as { type: string }).type)
      : null;
  return { json: true, type, receipted: isReceiptedType(type), problem: null };
}

// ---------------------------------------------------------------------------
// The nonce
// ---------------------------------------------------------------------------

export interface NonceVerdict {
  ok: boolean;
  /** Set when the nonce is shaped wrong, or will be refused by the server. */
  reason: string | null;
  /** True where the reason is the 400 rather than a shape problem. */
  willCollide: boolean;
}

/**
 * Is this nonce going to be accepted?
 *
 * Two different failures and the page must not blur them. A nonce with a letter
 * in it is a typo. A nonce that does not exceed the last one this key used in
 * this room is a message the server will refuse with
 * `400 nonce <n> is not greater than <n>` — and that refusal MEANS THE EARLIER
 * MESSAGE ALREADY LANDED, which is a fact about the room rather than an error
 * to retry past. A bench that reported it as "failed" would have people
 * re-sending things that already arrived.
 *
 * `lastUsed` is null when nothing is known, and "nothing is known" is not
 * "nothing was used": the rings rotate, so an unseen nonce may simply have
 * scrolled out of what is still retained. The page says which of the two it is.
 */
export function checkNonce(nonce: string, lastUsed: string | null): NonceVerdict {
  const shape = validateNonce(nonce);
  if (!shape.ok) return { ok: false, reason: shape.reason, willCollide: false };
  if (lastUsed == null) return { ok: true, reason: null, willCollide: false };

  if (compareNonce(nonce, lastUsed) > 0) return { ok: true, reason: null, willCollide: false };
  return {
    ok: false,
    willCollide: true,
    reason:
      `The highest nonce this key has used in this room is ${lastUsed}. The server takes only ` +
      `a strictly greater one, so this will come back as "400 nonce ${nonce.trim()} is not ` +
      `greater than ${lastUsed}" — which means the earlier message landed. Press New nonce.`,
  };
}

/**
 * The highest nonce a DID has used in a room, from the messages on hand.
 *
 * Compared as decimal strings rather than numbers: a nonce can exceed 2^53, and
 * one that has been through a double no longer reproduces the signature it was
 * made with.
 */
export function highestNonce(
  messages: { from: string | null; nonce: string | null }[],
  did: string
): string | null {
  let best: string | null = null;
  for (const message of messages) {
    if (message.from !== did || !message.nonce) continue;
    if (!/^[0-9]{1,19}$/.test(message.nonce)) continue;
    if (best == null || compareNonce(message.nonce, best) > 0) best = message.nonce;
  }
  return best;
}
