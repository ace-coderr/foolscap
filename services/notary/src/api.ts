// api.ts — the four endpoints, plus the one the honesty rules made necessary.
//
//   POST /api/notary/capture       store a signed message, idempotently
//   GET  /api/notary/did/:did      what the archive holds for a DID, and the
//                                  cutoff answer when ?before= is given
//   GET  /api/notary/record/:id    one original, with its Merkle proof
//   GET  /api/notary/anchors       published roots by day
//   GET  /api/notary/coverage      what the archive can speak to at all
//
// The fifth is not in NOTARY.md. It is here because the page has to state the
// coverage start and the recorded gaps BEFORE anyone types a DID — an archive
// that only admits its limits inside a result is an archive that looks complete
// on the way in. Folding it into /did/:did would have meant no honest empty
// state; folding it into /anchors would have meant lying about what /anchors is.
//
// No framework. One `pg` dependency for the service and nothing else: a router
// over node:http is forty lines, and every line of it is visible here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  looksLikeDid,
  validateNonce,
  validateSignature,
  verifyMessage,
} from '../../../src/lib/did.ts';
import { ROOM_RE } from '../../../src/lib/technocore.ts';
import { captureRecord } from './db.ts';
import {
  anchorForDay,
  anchors,
  summaryAnchors,
  coverage,
  dayOfRecord,
  didReport,
  recordById,
  recordsForDay,
  CAVEAT,
} from './archive.ts';
import { buildProof, isoStamp, leafHash, leafPreimage } from './merkle.ts';
import { signingStatus, ANCHOR_ROOM } from './anchor.ts';
import { RateLimiter, clientKey } from './ratelimit.ts';

/** Where a submission lands when the caller does not name a room. */
export const NOTARY_ROOM = process.env.NOTARY_ROOM ?? 'foolscap-notary';

/** NOTARY.md: reject text over 4096 bytes. Bytes, not characters. */
export const MAX_TEXT_BYTES = 4096;

/** Refuse a body larger than this outright rather than buffering it. */
const MAX_BODY_BYTES = 16_384;

export const CAPTURE_LIMIT = {
  capacity: Number(process.env.NOTARY_CAPTURE_BURST ?? 60),
  refillPerSecond: Number(process.env.NOTARY_CAPTURE_RATE ?? 1),
};

// ---------------------------------------------------------------------------
// Validation — pure, so the rejection rules can be tested without a socket
// ---------------------------------------------------------------------------

export interface CaptureInput {
  did: string;
  room: string;
  nonce: string;
  sig: string;
  text: string;
}

export type ParseResult = { ok: true; value: CaptureInput } | { ok: false; error: string };

/**
 * Shape-check a submission. Everything here is decidable without the network;
 * the signature check itself is async and happens in the handler.
 *
 * `text` is measured in BYTES. A 4096-character limit would let a caller store
 * 16KB of astral-plane text, and the cap exists to bound storage.
 *
 * Text is never normalised. NFC and NFD are different byte sequences, different
 * canonical strings and different signatures — "cleaning up" the text here
 * would produce a stored record whose own signature no longer verifies, which
 * is the single worst outcome this service has.
 */
export function parseCapture(body: unknown): ParseResult {
  if (body == null || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = body as Record<string, unknown>;

  if (!looksLikeDid(input.did)) {
    return { ok: false, error: 'did must be a did:key Ed25519 identifier.' };
  }

  const room = input.room == null || input.room === '' ? NOTARY_ROOM : input.room;
  if (typeof room !== 'string' || !ROOM_RE.test(room)) {
    return { ok: false, error: 'room must be a lowercase room name.' };
  }

  const nonce = validateNonce(input.nonce);
  if (!nonce.ok) return { ok: false, error: nonce.reason };

  const sig = validateSignature(input.sig);
  if (!sig.ok) return { ok: false, error: sig.reason };

  if (typeof input.text !== 'string') return { ok: false, error: 'text is required.' };
  const bytes = Buffer.byteLength(input.text, 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    return { ok: false, error: `text is ${bytes} bytes; the limit is ${MAX_TEXT_BYTES}.` };
  }

  return {
    ok: true,
    value: {
      did: input.did,
      room,
      nonce: nonce.nonce!,
      sig: sig.signature ?? String(input.sig).trim(),
      text: input.text,
    },
  };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * Reads are open to everyone. The static pages are served from a different
 * origin than the API — Vercel and Railway — so without this the page could not
 * call it at all, and the whole archive is public by design anyway.
 */
function cors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-max-age', '86400');
}

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload, null, 2);
  cors(res);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`Body over ${MAX_BODY_BYTES} bytes.`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Body is not valid JSON.');
  }
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export function createApi({ limiter = new RateLimiter(CAPTURE_LIMIT) }: { limiter?: RateLimiter } = {}) {
  setInterval(() => limiter.sweep(), 300_000).unref?.();

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'notary'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // --- capture ---------------------------------------------------------
      if (path === '/api/notary/capture') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only.' });

        const verdict = limiter.take(clientKey(req.headers, req.socket.remoteAddress ?? 'unknown'));
        if (!verdict.allowed) {
          return send(
            res,
            429,
            { error: 'Rate limited. The archive is for signed messages, not volume.', retry_after: verdict.retryAfter },
            { 'retry-after': String(verdict.retryAfter) }
          );
        }

        let body: unknown;
        try {
          body = await readBody(req);
        } catch (err) {
          return send(res, 400, { error: (err as Error).message });
        }

        const parsed = parseCapture(body);
        if (!parsed.ok) return send(res, 400, { error: parsed.error });

        // The one check that matters. Notary stores originals, so anything it
        // stores must be something a stranger can re-verify — a record whose
        // signature does not check out would be a row that proves nothing while
        // looking exactly like a row that proves something.
        const check = await verifyMessage(
          { from: parsed.value.did, nonce: parsed.value.nonce, text: parsed.value.text, sig: parsed.value.sig },
          { room: parsed.value.room }
        );
        if (!check.verified) {
          return send(res, 400, { error: check.error ?? 'Signature does not verify.' });
        }

        const stored = await captureRecord(parsed.value);
        return send(res, 200, {
          record_id: stored.id,
          captured_at: stored.capturedAt,
          day: stored.day,
          anchored: false,
          created: stored.created,
          room: parsed.value.room,
          note:
            'captured_at is Notary’s clock, not the room’s. It becomes tamper-evident when ' +
            'the day it belongs to is anchored.',
        });
      }

      if (req.method !== 'GET') return send(res, 405, { error: 'GET only.' });

      // --- coverage --------------------------------------------------------
      if (path === '/api/notary/coverage') {
        return send(res, 200, { ...(await coverage()), caveat: CAVEAT }, { 'cache-control': 'public, max-age=30' });
      }

      // --- one DID ---------------------------------------------------------
      if (path.startsWith('/api/notary/did/')) {
        const did = decodeURIComponent(path.slice('/api/notary/did/'.length));
        if (!looksLikeDid(did)) return send(res, 400, { error: 'Not a did:key Ed25519 identifier.' });

        const before = url.searchParams.get('before');
        if (before != null && !Number.isFinite(Date.parse(before))) {
          return send(res, 400, { error: 'before must be an ISO 8601 timestamp.' });
        }

        return send(res, 200, await didReport(did, before), { 'cache-control': 'public, max-age=15' });
      }

      // --- one record, and its proof ---------------------------------------
      if (path.startsWith('/api/notary/record/')) {
        const id = path.slice('/api/notary/record/'.length);
        if (!/^\d+$/.test(id)) return send(res, 400, { error: 'Record id is a positive integer.' });

        const record = await recordById(id);
        if (!record) return send(res, 404, { error: 'No such record.' });

        const day = (await dayOfRecord(id))!;
        const anchor = await anchorForDay(day);

        // The proof is only meaningful against a published root, so it is built
        // only when one exists. Serving a proof against an unpublished root
        // would look like evidence while being a number Notary could still
        // change.
        let proof = null;
        if (anchor?.root) {
          const dayRecords = await recordsForDay(day);
          const leaves = dayRecords.map((r) =>
            leafHash({ did: r.did, room: r.room, nonce: r.nonce, sig: r.sig, capturedAt: isoStamp(r.capturedAt) })
          );
          const index = dayRecords.findIndex((r) => r.id === record.id);
          proof = index < 0 ? null : buildProof(leaves, index);
        }

        return send(res, 200, {
          record: {
            id: record.id,
            did: record.did,
            room: record.room,
            // A string. Anything that renders this as a JSON number breaks
            // re-verification for every nonce past 2^53.
            nonce: record.nonce,
            sig: record.sig,
            text: record.text,
            captured_at: isoStamp(record.capturedAt),
            source_ts: record.sourceTs,
            source_seq: record.sourceSeq,
            source: record.source,
            sighting: record.sighting,
          },
          canonical_string: `${record.room}|${record.nonce}|${record.text}`,
          leaf: leafHash({
            did: record.did,
            room: record.room,
            nonce: record.nonce,
            sig: record.sig,
            capturedAt: isoStamp(record.capturedAt),
          }),
          leaf_preimage: leafPreimage({
            did: record.did,
            room: record.room,
            nonce: record.nonce,
            sig: record.sig,
            capturedAt: isoStamp(record.capturedAt),
          }),
          anchor: anchor ?? null,
          proof,
          how_to_verify:
            'Re-verify the signature yourself over canonical_string with the public key in the ' +
            'did. That proves who wrote it. captured_at is Notary’s claim about when it held ' +
            'the message; fold proof into leaf to reach anchor.root to check Notary has not ' +
            'moved it since the root was published.',
        });
      }

      // --- anchors ---------------------------------------------------------
      if (path === '/api/notary/anchors') {
        const [rows, summaries] = await Promise.all([anchors(), summaryAnchors()]);
        return send(
          res,
          200,
          {
            // The PINNED DID, not one derived from whatever seed this process
            // happens to hold. `can_sign` is the honest half: it says whether
            // this service can actually publish as that key.
            ...(await signingStatus().then((s) => ({
              notary_did: s.did,
              can_sign: s.canSign,
              signing_problem: s.reason,
            }))),
            anchor_room: ANCHOR_ROOM,
            anchors: rows,
            unpublished: rows.filter((row) => row.publishedSeq == null).length,
            // Its own set, never folded into `anchors`. A record anchor covers
            // one day's messages; a summary anchor covers the whole tier at one
            // moment. Same room, same key, different claims.
            summary_anchors: summaries,
            summary_unpublished: summaries.filter((row) => row.publishedSeq == null).length,
            note:
              'A root with no published_seq has been computed but not yet witnessed by anyone. ' +
              'Only a published root constrains what Notary can change. Verify an anchor by ' +
              'finding its message in anchor_room and checking the signature against notary_did.',
          },
          { 'cache-control': 'public, max-age=60' }
        );
      }

      if (path === '/api/notary/health' || path === '/') {
        return send(res, 200, { ok: true, service: 'foolscap-notary' });
      }

      return send(res, 404, { error: 'No such endpoint.' });
    } catch (err) {
      // THE USER'S MESSAGE STAYS VAGUE; THE LOG MUST NOT. What was logged here
      // was err.message alone, which for a `pg` error is the one line Postgres
      // put at the top and none of the fields that say what actually happened.
      // A production outage was diagnosed by reproducing the queries by hand
      // against the database, because the log said
      //
      //     [api] GET /api/notary/coverage — could not write to file ...
      //
      // with no code, no severity and no stack — and for a connection-pool
      // failure it said "timeout exceeded when trying to connect", which names
      // neither the pool nor the query that was waiting for it.
      //
      // The fields below are the ones that answer "is this us or is this the
      // database": `code` alone separates 53100 disk-full from 57014 statement
      // timeout from 25006 read-only transaction, and those three want three
      // completely different responses from whoever is reading the log.
      logFailure(req.method ?? 'GET', path, err);
      return send(res, 500, { error: 'The archive could not answer that.' });
    }
  };
}

/**
 * Everything the log needs and the response must not contain.
 *
 * The response stays "The archive could not answer that." — a stranger asking
 * about a DID does not need a Postgres error code, and an error message is a
 * way to learn about a database you cannot see. The log is the other half of
 * that bargain, and it was not being held up.
 *
 * pg's errors carry their diagnostics as own properties rather than in the
 * message, so they have to be read off deliberately; `severity` and `code` come
 * straight from the server, `detail` and `hint` are what psql prints under the
 * error, and `routine` names the C function that raised it, which is the
 * fastest way to tell a spill from a lock from a bad plan.
 */
function logFailure(method: string, path: string, err: unknown): void {
  const e = err as Record<string, unknown> | null;
  const parts: string[] = [];
  const add = (label: string, value: unknown) => {
    if (value != null && value !== '') parts.push(`${label}=${String(value)}`);
  };

  add('code', e?.code);
  add('severity', e?.severity);
  add('detail', e?.detail);
  add('hint', e?.hint);
  add('constraint', e?.constraint);
  add('table', e?.table);
  add('routine', e?.routine);

  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[api] ${method} ${path} — ${message}${parts.length ? ` (${parts.join(' ')})` : ''}`
  );
  // Separately, and only when there is one: a stack is several lines and would
  // bury the line above it if they were concatenated.
  if (err instanceof Error && err.stack) console.error(err.stack);
}
