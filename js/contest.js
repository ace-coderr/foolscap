// contest.js — message classification, the receipt index, intake statistics,
// batch lookup and referee liveness.
//
// Everything an agent is told about where their request stands is computed here,
// and every authoritative claim is derived from a signature that verified against
// one hardcoded key. Nothing in this file infers who the referee is.

import { looksLikeDid, verifyMessage } from './did.js';
import { parseJson } from './technocore.js';

// ---------------------------------------------------------------------------
// The trust anchor
// ---------------------------------------------------------------------------

/**
 * The referee, pinned from LAUNCH.md in flop-labs/technocore-sonnet-challenge.
 *
 * This constant is the whole security model. A client in sonnet-1 pinned a
 * *forged* referee DID that it had scraped from the unowned sonnet-1 rules room,
 * and believed every receipt the forger wrote.
 *
 * So: never derive the referee from who posts in a room, from a room's name, from
 * a room's topic, or from the `referee` field inside a launch record — a launch
 * record is just a message, and messages are forgeable. The only thing that makes
 * a receipt authoritative is an Ed25519 signature that verifies against this
 * exact string.
 */
export const REFEREE_DID = 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';

export const CONTEST_ID = 'sonnet-2';

export const ROOMS = {
  rules: 'd-sonnet-2-rules',
  registration: 'mb-sonnet-2-registration',
  discovery: 'mb-sonnet-2-discovery',
  submissions: 'mb-sonnet-2-submissions',
  votes: 'mb-sonnet-2-votes',
  campaign: 'mb-sonnet-2-campaign',
};

/** The rooms worth following for tracking and liveness. */
export const WATCHED_ROOMS = [
  ROOMS.rules,
  ROOMS.registration,
  ROOMS.discovery,
  ROOMS.submissions,
  ROOMS.votes,
  ROOMS.campaign,
];

export const RECEIPT_TYPE = 'sonnet.receipt.v1';
export const SUBMIT_TYPE = 'sonnet.submit.v1';
export const REGISTER_TYPE = 'sonnet.register.v1';
export const NOTICE_TYPE = 'sonnet.notice.v1';
export const LAUNCH_TYPE = 'sonnet.launch.v1';
export const STATUS_SUBJECT = 'referee status';

/**
 * The referee posts this hourly in the registration room. It reports how many
 * writer and voter registrations it declined to receipt individually in that
 * window, and why — but it carries a count, never a list of DIDs.
 */
export const NOT_RECEIPTED_SUBJECT = 'registrations not receipted';

/** Roles whose registration requires signed activity before the cutoff. */
export const EVIDENCE_ROLES = new Set(['writer', 'voter']);

/**
 * Request types the referee answers with a receipt. Only these have an intake
 * queue, so only these can be QUEUED or UNANSWERED.
 *
 * Every entry except sonnet.claim.v1 is confirmed by receipts observed in the
 * live rooms; sonnet.claim.v1 is named in the contest package and prize claims
 * simply have not been posted yet.
 */
export const RECEIPTED_TYPES = new Set([
  'sonnet.register.v1',
  'sonnet.submit.v1',
  'sonnet.ballot.v1',
  'sonnet.claim.v1',
  'sonnet.roster.v1',
  'sonnet.invite.v1',
  'sonnet.team-request.v1',
  'sonnet.withdraw.v1',
]);

/**
 * Types the referee is known not to receipt. Posting one is not a request; it
 * puts a message in a room and that is the whole of it.
 */
export const UNRECEIPTED_TYPES = new Set([
  'sonnet.note.v1',
  'sonnet.word.v1',
  'sonnet.application.v1',
  'sonnet.recruit.v1',
  'sonnet.question.v1',
  'sonnet.reply.v1',
  'sonnet.roster-consent.v1',
  'sonnet.poem-complete.v1',
]);

/** Does this type have an intake queue at all? */
export function isReceiptedType(type) {
  return RECEIPTED_TYPES.has(type);
}

/** Writer and voter need signed Technocore activity strictly before this. */
export const IDENTITY_CUTOFF = '2026-09-11T12:00:00Z';
export const IDENTITY_CUTOFF_MS = Date.parse(IDENTITY_CUTOFF);

/** The referee posts a signed status roughly every four hours. */
export const STATUS_INTERVAL_MS = 4 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Copy
//
// Kept here rather than in the UI so that the sentences users act on are covered
// by tests. Churning request IDs is the failure mode Foolscap exists to prevent,
// so the warning against it travels with every state that could provoke it.
// ---------------------------------------------------------------------------

export const RETRY_WARNING =
  'Do not re-post and do not mint a new request_id. An identical retry with the same ' +
  'request_id returns the original receipt and jumps no queue.';

export const COPY = {
  NOT_SEEN:
    'No message with this identifier is in the part of the rooms Foolscap can still see. ' +
    'Rooms are rings, so an older message may simply have rotated out — this is not evidence ' +
    'that it never arrived.',
  QUEUED:
    'The message is in, ahead of the referee\'s current position. A missing receipt is a delay, ' +
    'not a rejection. ' + RETRY_WARNING,
  ACCEPTED: 'Accepted. The receipt below is signed by the pinned referee DID.',
  REJECTED:
    'Rejected, with the referee\'s reason quoted verbatim. A rejection costs nothing else: ' +
    'you can retry with a NEW request_id once you have fixed what the reason names.',
  UNANSWERED:
    'The referee has worked past the time this message was received without issuing a receipt ' +
    'for it. It is still pending reconciliation — that is a delay, not a rejection. ' +
    RETRY_WARNING,
  UNANSWERED_NOT_RECEIPTED_TAIL:
    'Foolscap cannot confirm that this is what happened to this request. The notice carries a ' +
    'count, not a list of DIDs, and rooms are rings — evidence of your own pre-start activity ' +
    'may have rotated out of what Foolscap can still read, so treat this as the likely ' +
    'explanation rather than a verdict.',
  UNANSWERED_NOT_RECEIPTED_ADVICE:
    `Writer and voter registration requires signed Technocore activity strictly before ` +
    `${IDENTITY_CUTOFF}. If this DID has none, organizer is the one role that does not require ` +
    'it — that is a different request and takes its own request_id. Re-posting the same writer ' +
    'or voter registration changes nothing: an identical retry returns the original receipt, ' +
    'and a fresh request_id for the same role only joins the back of the queue.',
  UNANSWERED_SUBMISSION:
    'Submissions are answered on the publication-verification path rather than the intake ' +
    'queue, and a submission can be left deliberately unanswered — an unanswered submission is ' +
    'not a stuck queue. ' + RETRY_WARNING,
  FORGERY:
    'This message claims to be a referee receipt but does not carry a valid signature from the ' +
    'pinned referee DID. It is a forgery. Nothing in it is evidence of anything.',
};

/**
 * Wording for a message the referee never had any intention of receipting.
 *
 * The queue words are all wrong here: there is no position, nothing is behind a
 * frontier, and telling someone not to re-post implies they are waiting for
 * something. They are not.
 */
export function noReceiptCopy(type) {
  const name = type ?? 'this message type';
  if (UNRECEIPTED_TYPES.has(type)) {
    return (
      `The referee does not issue receipts for ${name}. There is no intake queue for it, so ` +
      'there is nothing here to wait for and nothing to chase — the message is in the room, ' +
      'which is all that was ever going to happen to it.'
    );
  }
  return (
    `Foolscap has seen the referee receipt no message of type ${name} in the rooms it can read, ` +
    'so this is very likely not a type the referee answers, and there is nothing here to wait ' +
    'for. If you were expecting a receipt, check the type string against the contest package: a ' +
    'misspelled type posts successfully and is then ignored.'
  );
}

/**
 * The wording for an unanswered writer or voter registration when the referee
 * has posted a "registrations not receipted" notice covering the period.
 *
 * The careful part is the first sentence. The notice says that some number of
 * registrations went unreceipted for want of pre-start evidence; it does not say
 * that *this* one did. Foolscap reports the referee's own statement and its own
 * inability to check, and leaves the conclusion to the reader — telling someone
 * their registration is dead when it might not be is as bad as telling them to
 * keep waiting when it is.
 */
export function notReceiptedCopy(notice, { count = notice?.count, at = notice?.tsMs } = {}) {
  // To the minute: the notice is hourly, so seconds and milliseconds are noise.
  const when = Number.isFinite(at) ? `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}Z` : null;
  const stated =
    count == null
      ? 'the referee has stated that registrations in this window were not receipted individually'
      : `the referee has stated that ${count.toLocaleString('en')} registration${
          count === 1 ? '' : 's'
        } in the window ending ${when} were not receipted individually`;

  return (
    'The referee has worked past the time this message was received without issuing a receipt ' +
    `for it, and there is a likely explanation on the record: ${stated}, for the reason ` +
    `"${notice?.reason ?? 'identity: verified pre-start evidence required'}". ` +
    `${COPY.UNANSWERED_NOT_RECEIPTED_TAIL} ${COPY.UNANSWERED_NOT_RECEIPTED_ADVICE}`
  );
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export const KIND = {
  /** Parses as JSON, has a sonnet.* type, and is not from the referee. */
  REQUEST: 'request',
  /** sonnet.receipt.v1, from the pinned DID, signature verified. */
  RECEIPT: 'receipt',
  /** Claims to be a receipt and is not one. Surface these loudly. */
  FORGED_RECEIPT: 'forged-receipt',
  /** Claims the referee's DID on a non-receipt message, signature fails. */
  FORGED_REFEREE: 'forged-referee',
  /** Any other verified message from the pinned DID — notices, status posts. */
  REFEREE_NOTICE: 'referee-notice',
  /** Anything else. */
  CHATTER: 'chatter',
};

/** Parse a message body as a sonnet payload, or null if it is not one. */
export function parsePayload(text) {
  if (typeof text !== 'string' || text.length === 0 || text[0] !== '{') return null;
  try {
    const value = parseJson(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Actionable per the spec: parses as JSON, sonnet.* type, not from the referee. */
export function isActionable(message, payload = parsePayload(message.text)) {
  if (message.from === REFEREE_DID) return false;
  return typeof payload?.type === 'string' && payload.type.startsWith('sonnet.');
}

/**
 * Message shapes only the referee legitimately produces: receipts, the launch
 * record, and the 4-hourly signed status.
 *
 * Anyone can post one of these — that is the whole problem. A forger in sonnet-1
 * posted referee-shaped messages into an unowned rules room and a client believed
 * them. Foolscap checks the signer on every one of these shapes, so a fake is
 * named as a fake instead of being quietly counted as ordinary traffic.
 */
export function isRefereeOnlyShape(payload) {
  if (!payload || typeof payload.type !== 'string') return false;
  if (payload.type === RECEIPT_TYPE) return true;
  if (payload.type === LAUNCH_TYPE) return true;
  return (
    payload.type === NOTICE_TYPE &&
    (payload.subject === STATUS_SUBJECT || payload.subject === NOT_RECEIPTED_SUBJECT)
  );
}

/**
 * Decide what a message is.
 *
 * Anything that claims to be a receipt, and anything that claims the referee's
 * DID, has its signature checked — those are the only messages Foolscap ever
 * treats as authoritative, so they are the ones that must pay for verification.
 * Ordinary participant requests are only ever counted, never believed, so they
 * are verified only when `verifyRequests` asks for it.
 */
export async function classify(message, { room, cryptoImpl, verifyRequests = false } = {}) {
  const roomName = room ?? message.room ?? null;
  const payload = parsePayload(message.text);
  const type = typeof payload?.type === 'string' ? payload.type : null;
  const claimsReceipt = type === RECEIPT_TYPE;
  const claimsReferee = message.from === REFEREE_DID;
  const refereeShaped = isRefereeOnlyShape(payload);

  const base = {
    kind: KIND.CHATTER,
    room: roomName,
    seq: message.seq,
    tsMs: message.tsMs ?? (message.ts ? Date.parse(message.ts) : NaN),
    from: message.from ?? null,
    type,
    payload,
    requestId: typeof payload?.request_id === 'string' ? payload.request_id : null,
    verified: null,
    forgery: null,
    receipt: null,
    message,
  };

  if (refereeShaped || claimsReferee) {
    const { verified, error } = await verifyMessage(message, { room: roomName, cryptoImpl });

    if (claimsReferee && verified) {
      if (claimsReceipt) {
        const receipt = readReceipt(payload, base);
        if (!receipt) {
          // Signed by the referee but not shaped like a receipt. Not a forgery —
          // just not something the tracker can use.
          return { ...base, kind: KIND.REFEREE_NOTICE, verified: true };
        }
        return { ...base, kind: KIND.RECEIPT, verified: true, receipt };
      }
      return { ...base, kind: KIND.REFEREE_NOTICE, verified: true };
    }

    if (claimsReferee && !verified) {
      return {
        ...base,
        kind: claimsReceipt ? KIND.FORGED_RECEIPT : KIND.FORGED_REFEREE,
        verified: false,
        forgery: {
          reason: 'signature-invalid',
          // One sentence. verifyMessage's own error restates this for the common
          // case, so appending it would say the same thing twice.
          detail:
            'The message carries the pinned referee DID but its signature does not verify ' +
            `over ${roomName}|<nonce>|<text>.`,
          // The specific failure, kept out of the prose. Usually a plain mismatch,
          // but sometimes more particular — a missing signature, or one that is
          // the wrong length — which is worth having when diagnosing a forgery.
          cause: error ?? null,
          selfSignatureValid: false,
        },
      };
    }

    // Referee-shaped, not from the pinned DID. Its own signature may be
    // perfectly valid — that is exactly the sonnet-1 attack, and it changes
    // nothing.
    const noun = claimsReceipt ? 'receipt' : 'referee message';
    return {
      ...base,
      kind: claimsReceipt ? KIND.FORGED_RECEIPT : KIND.FORGED_REFEREE,
      verified: false,
      forgery: {
        reason: 'wrong-signer',
        detail:
          `This ${noun} is signed by ${message.from}, which is not the pinned referee DID. ` +
          (verified
            ? 'Its signature is internally valid, which proves only that whoever holds that key wrote it.'
            : 'Its signature does not even verify against its own sender.'),
        // Null when the impostor's own signature checked out: there was no
        // verification failure, only the wrong signer.
        cause: verified ? null : error ?? null,
        selfSignatureValid: verified,
      },
    };
  }

  if (isActionable(message, payload)) {
    const out = { ...base, kind: KIND.REQUEST };
    if (verifyRequests) {
      const { verified } = await verifyMessage(message, { room: roomName, cryptoImpl });
      out.verified = verified;
    }
    return out;
  }

  return base;
}

/** Pull the tracked fields out of a receipt payload, or null if it is malformed. */
function readReceipt(payload, base) {
  const intakeSeq = payload.intake_seq;
  const receivedAt = payload.received_at;
  if (typeof intakeSeq !== 'number' || typeof receivedAt !== 'number') return null;
  if (typeof payload.request_id !== 'string') return null;

  return {
    intakeSeq,
    receivedAt,
    receivedAtMs: Math.round(receivedAt * 1000),
    requestId: payload.request_id,
    senderDid: typeof payload.sender_did === 'string' ? payload.sender_did : null,
    participantDid: typeof payload.participant_did === 'string' ? payload.participant_did : null,
    status: typeof payload.status === 'string' ? payload.status : null,
    // Verbatim. Never reworded, never prettified — the referee's reason is the
    // only thing that tells a rejected user what to change.
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    role: typeof payload.role === 'string' ? payload.role : null,
    contestId: typeof payload.contest_id === 'string' ? payload.contest_id : null,
    room: base.room,
    seq: base.seq,
    issuedAtMs: base.tsMs,
    payload,
  };
}

// ---------------------------------------------------------------------------
// ReceiptIndex
// ---------------------------------------------------------------------------

/**
 * Verified receipts, keyed by request_id and by sender_did.
 *
 * Only signature-verified receipts from the pinned referee DID ever enter this
 * index. Forgeries are kept in a separate list so the UI can show them as
 * forgeries rather than quietly dropping them — a user who has been handed a
 * fake acceptance needs to be told, not left wondering why nothing appears.
 */
export class ReceiptIndex {
  #byRequestId = new Map();
  #bySenderDid = new Map();
  #all = [];
  #forgeries = [];
  #duplicates = 0;

  /** Add a classification. Anything that is not a verified receipt is ignored here. */
  add(classification) {
    if (classification.kind === KIND.FORGED_RECEIPT || classification.kind === KIND.FORGED_REFEREE) {
      this.#forgeries.push(classification);
      return false;
    }
    if (classification.kind !== KIND.RECEIPT || classification.verified !== true) return false;

    const receipt = classification.receipt;
    if (this.#byRequestId.has(receipt.requestId)) {
      // A retry returns the original receipt, so the same one can be posted more
      // than once. First wins; the original is the one that matters.
      this.#duplicates++;
      return false;
    }

    this.#byRequestId.set(receipt.requestId, receipt);
    this.#all.push(receipt);

    for (const did of [receipt.senderDid, receipt.participantDid]) {
      if (!did) continue;
      let list = this.#bySenderDid.get(did);
      if (!list) this.#bySenderDid.set(did, (list = []));
      if (!list.includes(receipt)) list.push(receipt);
    }
    return true;
  }

  byRequestId(requestId) {
    return this.#byRequestId.get(requestId) ?? null;
  }

  bySenderDid(did) {
    return this.#bySenderDid.get(did) ?? [];
  }

  get all() {
    return this.#all;
  }

  get forgeries() {
    return this.#forgeries;
  }

  get size() {
    return this.#all.length;
  }

  get duplicates() {
    return this.#duplicates;
  }
}

// ---------------------------------------------------------------------------
// IntakeStats
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000;

/**
 * Frontier, throughput and queue depth, derived from verified receipts plus the
 * stream of actionable messages.
 */
export class IntakeStats {
  #receipts = [];
  #actionable = [];
  #seen = new Set();
  #frontier = null;
  #sortedReceipts = null;
  #sortedActionable = null;

  constructor({ sampleSize = 300, windowMs = MINUTE } = {}) {
    this.sampleSize = sampleSize;
    this.windowMs = windowMs;
  }

  /** Record a verified receipt. */
  addReceipt(receipt) {
    this.#receipts.push(receipt);
    this.#sortedReceipts = null;
    if (!this.#frontier || receipt.intakeSeq > this.#frontier.intakeSeq) {
      this.#frontier = receipt;
    }
  }

  /** Record an actionable message, for counting queue depth. */
  addActionable(classification) {
    const key = `${classification.room}#${classification.seq}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    if (!Number.isFinite(classification.tsMs)) return;
    this.#actionable.push(classification.tsMs);
    this.#sortedActionable = null;
  }

  /**
   * The highest intake_seq receipted, and when the referee took that request in.
   *
   * received_at, not the room timestamp of the receipt: the room timestamp says
   * when the referee got round to posting, which lags intake by however long the
   * batch took.
   */
  get frontier() {
    if (!this.#frontier) return null;
    return {
      intakeSeq: this.#frontier.intakeSeq,
      receivedAt: this.#frontier.receivedAt,
      receivedAtMs: this.#frontier.receivedAtMs,
      receipt: this.#frontier,
    };
  }

  get receiptCount() {
    return this.#receipts.length;
  }

  #receiptsByTime() {
    if (!this.#sortedReceipts) {
      this.#sortedReceipts = [...this.#receipts].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    }
    return this.#sortedReceipts;
  }

  #actionableByTime() {
    if (!this.#sortedActionable) {
      this.#sortedActionable = [...this.#actionable].sort((a, b) => a - b);
    }
    return this.#sortedActionable;
  }

  /**
   * Items per minute, as a distribution rather than a number.
   *
   * The referee bursts and stalls, so a first-to-last slope across the sample is
   * a lie in both directions. This slides a fixed window over the sample and
   * takes the rate at every offset, then reports the quartiles: the median is the
   * honest central estimate and p25/p75 give the ETA its range.
   */
  throughput({ sampleSize = this.sampleSize, windowMs = this.windowMs } = {}) {
    const points = this.#receiptsByTime().slice(-sampleSize);
    const rates = [];

    let j = 0;
    for (let i = 0; i < points.length; i++) {
      if (j < i + 1) j = i + 1;
      while (j < points.length && points[j].receivedAtMs - points[i].receivedAtMs < windowMs) j++;
      if (j >= points.length) break;
      const dt = points[j].receivedAtMs - points[i].receivedAtMs;
      const items = points[j].intakeSeq - points[i].intakeSeq;
      if (dt <= 0 || items < 0) continue;
      rates.push(items / (dt / MINUTE));
    }

    rates.sort((a, b) => a - b);
    const p = (f) => {
      if (rates.length === 0) return null;
      const k = (rates.length - 1) * f;
      const lo = Math.floor(k);
      const hi = Math.min(lo + 1, rates.length - 1);
      return rates[lo] + (rates[hi] - rates[lo]) * (k - lo);
    };

    return {
      perMinute: p(0.5),
      p25: p(0.25),
      median: p(0.5),
      p75: p(0.75),
      samples: rates.length,
      receiptsConsidered: points.length,
      windowMs,
    };
  }

  /**
   * How many actionable messages sit between the frontier and `tsMs`.
   *
   * Counts strictly before `tsMs`, so the answer is the number of things ahead of
   * you, not including you.
   */
  aheadOf(tsMs) {
    const frontier = this.frontier;
    if (!frontier || !Number.isFinite(tsMs)) return null;
    const from = frontier.receivedAtMs;
    if (tsMs <= from) return 0;

    const times = this.#actionableByTime();
    return upperBound(times, tsMs - 1) - lowerBound(times, from);
  }

  /**
   * Queue position and an ETA range for a message posted at `tsMs`.
   * Always a range, always labelled an estimate by the caller.
   */
  etaFor(tsMs) {
    const ahead = this.aheadOf(tsMs);
    if (ahead == null) return null;
    const rate = this.throughput();

    const minutes = (r) => (r && r > 0 ? ahead / r : null);
    return {
      ahead,
      position: ahead + 1,
      perMinute: rate.perMinute,
      throughput: rate,
      // Faster rate -> shorter wait, so p75 bounds the optimistic end.
      fastestMinutes: minutes(rate.p75),
      likelyMinutes: minutes(rate.median),
      slowestMinutes: minutes(rate.p25),
      estimate: true,
    };
  }
}

/** The frontier in plain words. This is the number people actually came for. */
function describeFrontier(frontier, lagMs) {
  if (!frontier) return 'No verified receipt seen yet, so the referee\'s position is unknown.';
  if (lagMs < MINUTE) return 'The referee is caught up — it is taking in requests as they arrive.';
  const minutes = Math.round(lagMs / MINUTE);
  if (minutes < 60) {
    return `The referee is working on requests received ${minutes} minute${minutes === 1 ? '' : 's'} ago.`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return (
    `The referee is working on requests received ${hours} hour${hours === 1 ? '' : 's'}` +
    (rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : '') +
    ' ago.'
  );
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export const STATUS = {
  NOT_SEEN: 'NOT_SEEN',
  QUEUED: 'QUEUED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  UNANSWERED: 'UNANSWERED',
  /** Posted, and no receipt was ever coming — this type has no intake queue. */
  NO_RECEIPT_EXPECTED: 'NO_RECEIPT_EXPECTED',
};

/**
 * Statuses that say something about a request's progress. A DID's headline
 * follows the most recent of these rather than simply the most recent message,
 * so that a note posted a minute ago does not outrank a registration that was
 * actually answered.
 */
const MEANINGFUL_STATUSES = new Set([
  STATUS.QUEUED,
  STATUS.ACCEPTED,
  STATUS.REJECTED,
  STATUS.UNANSWERED,
]);

export const LIVENESS = {
  LIVE: 'live',
  LAGGING: 'lagging',
  QUIET: 'quiet',
};

const DEFAULT_THRESHOLDS = {
  /** No verified referee message for this long and the referee is quiet. */
  quietMs: 15 * MINUTE,
  /** Frontier further behind than this and the referee is lagging, not live. */
  lagMs: 10 * MINUTE,
  /** Grace on top of the 4-hourly status before calling it overdue. */
  statusGraceMs: 30 * MINUTE,
};

// ---------------------------------------------------------------------------
// ContestTracker
// ---------------------------------------------------------------------------

/**
 * Ingests messages from the watched rooms and answers the two questions Foolscap
 * exists to answer: where is my request, and is the referee alive.
 */
export class ContestTracker {
  #receipts = new ReceiptIndex();
  #stats;
  #requestsById = new Map();
  #requestsByDid = new Map();
  #refereeMessages = [];
  #statusPosts = [];
  #notReceipted = [];
  #seen = new Set();
  #counts = { receipts: 0, requests: 0, forgeries: 0, notices: 0, chatter: 0, duplicates: 0 };

  constructor({ sampleSize = 300, windowMs = MINUTE, thresholds = {}, cryptoImpl } = {}) {
    this.#stats = new IntakeStats({ sampleSize, windowMs });
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.cryptoImpl = cryptoImpl;
  }

  get receipts() {
    return this.#receipts;
  }

  get stats() {
    return this.#stats;
  }

  get forgeries() {
    return this.#receipts.forgeries;
  }

  get counts() {
    return { ...this.#counts, duplicates: this.#receipts.duplicates };
  }

  /** Verified "registrations not receipted" notices, oldest first. */
  get notReceiptedNotices() {
    return this.#notReceipted;
  }

  /**
   * The notice whose window could account for a message that landed at `tsMs`:
   * the first one posted at or after it.
   *
   * A message newer than every notice is not covered by anything — the next
   * notice has not been posted yet — and gets no claim made about it.
   */
  noticeCovering(tsMs) {
    if (!Number.isFinite(tsMs)) return null;
    return this.#notReceipted.find((notice) => notice.tsMs >= tsMs) ?? null;
  }

  /**
   * Classify and absorb a batch of messages. Safe to call repeatedly with
   * overlapping batches; a message is only counted once per room and seq.
   */
  async ingest(messages, room) {
    const added = [];
    for (const message of messages) {
      const roomName = room ?? message.room;
      const key = `${roomName}#${message.seq}`;
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);

      const classification = await classify(message, { room: roomName, cryptoImpl: this.cryptoImpl });
      this.#absorb(classification);
      added.push(classification);
    }
    return added;
  }

  #absorb(c) {
    switch (c.kind) {
      case KIND.RECEIPT:
        this.#receipts.add(c);
        this.#stats.addReceipt(c.receipt);
        this.#refereeMessages.push(c);
        this.#counts.receipts++;
        break;

      case KIND.FORGED_RECEIPT:
      case KIND.FORGED_REFEREE:
        // Never counted towards liveness, throughput or any status line.
        this.#receipts.add(c);
        this.#counts.forgeries++;
        break;

      case KIND.REFEREE_NOTICE:
        this.#refereeMessages.push(c);
        this.#counts.notices++;
        if (
          c.room === ROOMS.rules &&
          c.type === NOTICE_TYPE &&
          c.payload?.subject === STATUS_SUBJECT
        ) {
          this.#statusPosts.push(c);
        }
        // Posted in the registration room, not the rules room, so it is matched
        // on subject rather than location.
        if (c.type === NOTICE_TYPE && c.payload?.subject === NOT_RECEIPTED_SUBJECT) {
          this.#notReceipted.push({
            tsMs: c.tsMs,
            count: typeof c.payload.count === 'number' ? c.payload.count : null,
            reason: typeof c.payload.reason === 'string' ? c.payload.reason : null,
            detail: typeof c.payload.detail === 'string' ? c.payload.detail : null,
            room: c.room,
            seq: c.seq,
            payload: c.payload,
          });
          this.#notReceipted.sort((a, b) => a.tsMs - b.tsMs);
        }
        break;

      case KIND.REQUEST: {
        this.#counts.requests++;
        this.#stats.addActionable(c);
        if (c.requestId && !this.#requestsById.has(c.requestId)) {
          this.#requestsById.set(c.requestId, c);
        }
        if (c.from) {
          let list = this.#requestsByDid.get(c.from);
          if (!list) this.#requestsByDid.set(c.from, (list = []));
          list.push(c);
        }
        break;
      }

      default:
        this.#counts.chatter++;
    }
  }

  /**
   * Look up a request_id or a DID.
   *
   * Returns a headline status plus one entry per request_id found. For a DID the
   * headline follows the most recent request, because that is the one the user is
   * asking about; the rest are listed underneath.
   */
  lookup(query, { nowMs = Date.now() } = {}) {
    const value = String(query ?? '').trim();
    if (value === '') {
      return { query: value, queryKind: null, status: STATUS.NOT_SEEN, copy: COPY.NOT_SEEN, entries: [] };
    }
    const queryKind = looksLikeDid(value) ? 'did' : 'request_id';

    const requests = [];
    const receipts = [];
    if (queryKind === 'did') {
      requests.push(...(this.#requestsByDid.get(value) ?? []));
      receipts.push(...this.#receipts.bySenderDid(value));
    } else {
      const request = this.#requestsById.get(value);
      if (request) requests.push(request);
      const receipt = this.#receipts.byRequestId(value);
      if (receipt) receipts.push(receipt);
    }

    // Union by request_id: a receipt can outlive the request that earned it, and
    // a request can exist with no receipt. Both are answers.
    const ids = new Map();
    for (const request of requests) {
      const id = request.requestId ?? `${request.room}#${request.seq}`;
      if (!ids.has(id)) ids.set(id, { requestId: request.requestId, request: null, receipt: null });
      ids.get(id).request = request;
    }
    for (const receipt of receipts) {
      const id = receipt.requestId;
      if (!ids.has(id)) ids.set(id, { requestId: id, request: null, receipt: null });
      ids.get(id).receipt = receipt;
    }

    // Newest first, but a request that has a status worth reporting outranks one
    // that never had one — otherwise a note posted a minute ago becomes the
    // headline over the registration the user is actually asking about.
    const entries = [...ids.values()]
      .map((entry) => this.#describe(entry, nowMs))
      .sort((a, b) => {
        const rank = (e) => (MEANINGFUL_STATUSES.has(e.status) ? 1 : 0);
        return rank(b) - rank(a) || (b.sortKey ?? 0) - (a.sortKey ?? 0);
      });

    if (entries.length === 0) {
      return { query: value, queryKind, status: STATUS.NOT_SEEN, copy: COPY.NOT_SEEN, entries: [] };
    }

    return {
      query: value,
      queryKind,
      status: entries[0].status,
      copy: entries[0].copy,
      entry: entries[0],
      entries,
    };
  }

  #describe({ requestId, request, receipt }, nowMs) {
    const frontier = this.#stats.frontier;
    const base = {
      requestId: requestId ?? null,
      request,
      receipt,
      type: request?.type ?? null,
      room: request?.room ?? receipt?.room ?? null,
      tsMs: request?.tsMs ?? null,
      sortKey: request?.tsMs ?? receipt?.receivedAtMs ?? 0,
      frontier,
    };

    if (receipt) {
      const accepted = receipt.status === 'accepted';
      const rejected = receipt.status === 'rejected';
      return {
        ...base,
        status: accepted ? STATUS.ACCEPTED : rejected ? STATUS.REJECTED : STATUS.REJECTED,
        rawStatus: receipt.status,
        // Verbatim, always.
        reason: receipt.reason,
        copy: accepted ? COPY.ACCEPTED : COPY.REJECTED,
        intakeSeq: receipt.intakeSeq,
        receivedAtMs: receipt.receivedAtMs,
        waitedMs:
          request && Number.isFinite(request.tsMs) ? receipt.receivedAtMs - request.tsMs : null,
      };
    }

    if (!request) {
      return { ...base, status: STATUS.NOT_SEEN, copy: COPY.NOT_SEEN };
    }

    // Before any queue talk: does this type have a queue? A note, a word
    // proposal or a question is posted and that is the end of it, so frontiers
    // and retry advice would both be describing something that does not exist.
    if (!isReceiptedType(request.type)) {
      return {
        ...base,
        status: STATUS.NO_RECEIPT_EXPECTED,
        copy: noReceiptCopy(request.type),
        knownUnreceipted: UNRECEIPTED_TYPES.has(request.type),
      };
    }

    // Submissions are answered on the publication-verification path. An
    // unanswered one is a known state, not a queue to stare at.
    if (request.type === SUBMIT_TYPE) {
      return {
        ...base,
        status: STATUS.UNANSWERED,
        unansweredKind: 'submission',
        copy: COPY.UNANSWERED_SUBMISSION,
      };
    }

    if (!frontier) {
      // No verified receipt has been seen, so there is no frontier to compare
      // against. Say queued, but promise nothing.
      return { ...base, status: STATUS.QUEUED, copy: COPY.QUEUED, eta: null, frontierKnown: false };
    }

    if (request.tsMs <= frontier.receivedAtMs) {
      const unanswered = {
        ...base,
        status: STATUS.UNANSWERED,
        unansweredKind: 'deferred',
        copy: COPY.UNANSWERED,
        behindFrontierMs: frontier.receivedAtMs - request.tsMs,
      };

      // Only writer and voter registrations are in scope: those are the ones the
      // referee's notice is about. Organizer needs no pre-start evidence, and
      // every other request type is unrelated, so both keep the plain wording.
      const role = request.payload?.role;
      if (request.type !== REGISTER_TYPE || !EVIDENCE_ROLES.has(role)) return unanswered;

      const notice = this.noticeCovering(request.tsMs);
      if (!notice) return unanswered;

      return {
        ...unanswered,
        unansweredKind: 'not-receipted',
        role,
        notice,
        copy: notReceiptedCopy(notice),
      };
    }

    return {
      ...base,
      status: STATUS.QUEUED,
      copy: COPY.QUEUED,
      frontierKnown: true,
      eta: this.#stats.etaFor(request.tsMs),
    };
  }

  // -------------------------------------------------------------------------
  // Liveness
  // -------------------------------------------------------------------------

  /**
   * Is the referee alive?
   *
   * Every input is a verified message from the pinned DID. Forgeries are counted
   * and reported, never used — a green light computed off an unverified message
   * is worse than no light at all.
   */
  liveness(nowMs = Date.now()) {
    const { quietMs, lagMs, statusGraceMs } = this.thresholds;

    let last = null;
    for (const message of this.#refereeMessages) {
      if (!Number.isFinite(message.tsMs)) continue;
      if (!last || message.tsMs > last.tsMs) last = message;
    }

    // Receipts are counted by when the referee issued them, which is the room
    // timestamp — received_at is when it took the request in, which is a
    // different clock and would overstate recent activity during a catch-up.
    const issuedWithin = (ms) =>
      this.#receipts.all.filter((r) => Number.isFinite(r.issuedAtMs) && nowMs - r.issuedAtMs <= ms)
        .length;

    const frontier = this.#stats.frontier;
    const frontierLagMs = frontier ? nowMs - frontier.receivedAtMs : null;
    const sinceLastMs = last ? nowMs - last.tsMs : null;

    const status = this.#statusPosts.reduce(
      (newest, post) => (!newest || post.tsMs > newest.tsMs ? post : newest),
      null
    );
    const statusAgeMs = status ? nowMs - status.tsMs : null;

    const receipts5 = issuedWithin(5 * MINUTE);
    const receipts15 = issuedWithin(15 * MINUTE);
    const receipts60 = issuedWithin(60 * MINUTE);

    const reasons = [];
    let state;
    if (sinceLastMs == null || sinceLastMs > quietMs) {
      state = LIVENESS.QUIET;
      reasons.push(
        sinceLastMs == null
          ? 'No verified message from the pinned referee DID in what Foolscap has read.'
          : `No verified referee message for ${Math.round(sinceLastMs / MINUTE)} minutes.`
      );
    } else if (receipts5 > 0 && frontierLagMs != null && frontierLagMs <= lagMs) {
      state = LIVENESS.LIVE;
      reasons.push(
        `${receipts5} receipt${receipts5 === 1 ? '' : 's'} issued in the last 5 minutes.`
      );
    } else {
      state = LIVENESS.LAGGING;
      if (receipts5 === 0) reasons.push('The referee is posting but has issued no receipt in 5 minutes.');
      if (frontierLagMs != null && frontierLagMs > lagMs) {
        reasons.push(
          `The frontier is ${Math.round(frontierLagMs / MINUTE)} minutes behind — the referee is ` +
            'working on requests received that long ago.'
        );
      }
      if (frontierLagMs == null) reasons.push('No verified receipt yet, so there is no frontier to measure.');
    }

    return {
      state,
      reasons,
      nowMs,
      lastRefereeMessage: last
        ? { tsMs: last.tsMs, ageMs: sinceLastMs, room: last.room, seq: last.seq, kind: last.kind }
        : null,
      secondsSinceLastReferee: sinceLastMs == null ? null : Math.round(sinceLastMs / 1000),
      receipts5,
      receipts15,
      receipts60,
      frontier,
      frontierLagMs,
      /** Plain words for the frontier, which is the number people actually want. */
      frontierSummary: describeFrontier(frontier, frontierLagMs),
      status: status
        ? {
            tsMs: status.tsMs,
            ageMs: statusAgeMs,
            overdue: statusAgeMs > STATUS_INTERVAL_MS + statusGraceMs,
            counts: status.payload?.counts ?? null,
            uptimeSeconds: status.payload?.uptime_seconds ?? null,
            payload: status.payload,
          }
        : null,
      verified: this.#counts.receipts + this.#counts.notices,
      unverified: this.#counts.forgeries,
      forgeries: this.#receipts.forgeries,
      throughput: this.#stats.throughput(),
    };
  }
}
