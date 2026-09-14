// archive.ts — the read side of the archive, and the shape of an honest answer.
//
// TWO CLOCKS, AND THEY ARE NOT INTERCHANGEABLE.
//
//   captured_at  when Notary held the message. Notary's own clock, the thing it
//                vouches for, and the thing the daily anchor commits to.
//   source_ts    when the room says the message was posted. Notary did not
//                witness it; a backfill reads ring history that is already hours
//                old, so source_ts routinely precedes captured_at — in this
//                archive by about thirty hours at the extreme.
//
// Both are served, always labelled, and never blended. An attestation that
// quietly used the room's timestamp would be Notary vouching for a clock it does
// not own; one that used only its own would throw away most of what it holds.
//
// AND THE RULE THAT OUTRANKS EVERYTHING: absence is not evidence. There is no
// code path in this file that returns "this DID was not active". The strongest
// negative statement available is "nothing in what Notary captured", which is a
// fact about the archive rather than a fact about the DID.

import { getPool } from './db.ts';
import { policyFor, POLICY, type Policy } from './policy.ts';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RoomActivity {
  room: string;
  policy: Policy;
  /** Rows held. For a sampled room this is a sighting count, not a message count. */
  records: number;
  /** True when the rows for this room are samples rather than everything. */
  sampled: boolean;
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  firstSourceTs: string | null;
  lastSourceTs: string | null;
}

export interface RecordRow {
  id: string;
  did: string;
  room: string;
  nonce: string;
  sig: string;
  text: string;
  capturedAt: string;
  sourceTs: string | null;
  sourceSeq: string | null;
  sighting: 'first' | 'last' | null;
  source: 'submitted' | 'mirrored';
}

/**
 * Three states, and deliberately not the boolean NOTARY.md sketches.
 *
 * `no-evidence` is not `false`. A false would be Notary asserting something
 * about the DID; this asserts something about the archive, which is the only
 * one of the two Notary is in a position to know. Every consumer — including
 * the page — is forced to handle the difference because the type will not let
 * them collapse it.
 */
export type CutoffAnswer = 'witnessed' | 'claimed' | 'no-evidence';

export interface CutoffResult {
  before: string;
  answer: CutoffAnswer;
  /** Notary's own clock beat the cutoff. The strongest thing it can say. */
  witnessedBefore: string | null;
  /** The room's claimed post time beat it. Notary did not see this happen. */
  claimedBefore: string | null;
  /** A record to go and re-verify, when there is one. */
  evidenceRecordId: string | null;
  /** Always present, always shown. */
  caveat: string;
}

export interface DidReport {
  did: string;
  totalRecords: number;
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  firstSourceTs: string | null;
  lastSourceTs: string | null;
  rooms: RoomActivity[];
  /** Days the rooms say this DID posted on, with row counts. */
  days: Array<{ day: string; records: number }>;
  /** The earliest few, because a cutoff question is always about the earliest. */
  earliest: RecordRow[];
  cutoff: CutoffResult | null;
  coverage: Coverage;
  caveat: string;
}

export interface GapRow {
  id: string;
  room: string;
  kind: 'missed' | 'downtime' | 'regenerated' | 'rotated';
  missing: number | null;
  recovered: number;
  /** missing - recovered, floored at zero. What is actually gone. */
  lost: number;
  expectedSeq: string | null;
  firstSeq: string | null;
  noticedAt: string;
}

export interface Coverage {
  /** Notary's clock: nothing before this exists, at all, for any DID. */
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  /** The oldest post time the archive holds, from ring history read at startup. */
  earliestSourceTs: string | null;
  latestSourceTs: string | null;
  records: number;
  dids: number;
  rooms: number;
  /** Records handed to Notary through /capture rather than swept from a room. */
  submitted: number;
  /**
   * Seconds since the MIRROR last captured. Large means sweeping has stopped
   * and the rings are turning over uncovered.
   */
  staleSeconds: number | null;
  /**
   * The largest accountable holes, not all of them. There are already a
   * thousand rows and the number only grows; every client so far shows the top
   * handful. `gapsTotal` is how many exist.
   */
  gaps: GapRow[];
  gapsTotal: number;

  // --- the three categories, and they are never added together --------------
  //
  // LOSS is what Notary was responsible for and did not capture: it was
  // following the room, or should have been. It is knowable to the message and
  // it is the number the product should be judged on.
  /** Lines that rotated past while the mirror was reading the room. */
  lostMissed: number;
  /** Lines that went past while the mirror was not running at all. */
  lostDowntime: number;
  /** lostMissed + lostDowntime. The honest loss figure. */
  lostMessages: number;

  // BEFORE COVERAGE is not loss. Each room Notary started following mid-ring
  // had history behind it that had already rotated out — nobody captured it and
  // nobody can say how much there was. It is reported as a count of ROOMS that
  // began mid-ring, never as a count of messages: the 'rotated' rows carry a
  // number, and summing it was what overstated this archive's loss forty-fold.
  /** How many rooms Notary first looked at after their ring had already turned. */
  roomsBegunMidRing: number;

  roomsCovered: Array<{ room: string; policy: Policy; records: number; firstCapturedAt: string | null; lastCapturedAt: string | null }>;
}

export interface AnchorRow {
  day: string;
  root: string | null;
  recordCount: number | null;
  publishedSeq: string | null;
  publishedAt: string | null;
  firstCapture: string | null;
  lastCapture: string | null;
}

// ---------------------------------------------------------------------------
// The sentence that goes on every answer
// ---------------------------------------------------------------------------

/**
 * Attached to every DID response and every cutoff result, by construction
 * rather than by the caller remembering.
 *
 * NOTARY.md: "Absence of a record is never evidence a DID was inactive, and
 * every response must say so." Putting it in the payload means a third party
 * building on this API gets the caveat whether or not they read the docs, and
 * cannot render an answer that has lost it without deliberately stripping it.
 */
export const CAVEAT =
  'This reflects only what Notary captured. Notary began capturing at its coverage start; ' +
  'it holds nothing from before then, it has recorded gaps where messages rotated past it, ' +
  'and rooms under the sightings policy are sampled. Absence of a record here is never ' +
  'evidence that a DID was inactive.';

const iso = (value: Date | string | null): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const int = (value: unknown): number => (value == null ? 0 : Number(value));

/**
 * How many gap rows /coverage ships, largest first.
 *
 * The endpoint used to send all of them: a thousand rows today, more after
 * every restart, on every page load, for a client that renders eight and keeps
 * the rest behind a scroll window. Two hundred leaves room for any client that
 * wants to rank or group them without the response growing without bound. The
 * totals beside them are computed over every row regardless, so nothing the
 * page states as a figure depends on this number.
 */
const GAP_LIMIT = 200;

/**
 * The gap kinds Notary is accountable for, and the only ones that may be summed.
 *
 * WRITTEN ONCE AND PASSED TO THE QUERY, rather than spelled out in the SQL, so
 * that "which holes are loss" is a single fact with a name. It was previously
 * not a fact anywhere: the coverage query summed every row, which quietly
 * enrolled 'rotated' — the marker for where a room's coverage BEGINS — as
 * messages the archive had lost, and overstated the loss by a factor of forty.
 *
 * 'rotated' is not loss: nobody captured that history and nobody can say how
 * much of it there was. 'regenerated' is not loss either; it is a room being
 * recreated, and its rows carry no count.
 */
export const LOSS_KINDS = ['missed', 'downtime'] as const;

// ---------------------------------------------------------------------------
// Coverage — what the archive can speak to at all
// ---------------------------------------------------------------------------

export async function coverage(): Promise<Coverage> {
  const pool = getPool();

  // THE WINDOW IS THE MIRROR'S, NOT THE TABLE'S.
  //
  // A submitted record is somebody handing Notary a message; it says nothing
  // about whether the mirror is still sweeping rooms. Measuring the window over
  // every row meant one submission a day after sweeping stopped moved the
  // window's end to the present and silenced the "capture is not running"
  // warning — the archive claiming twenty-four hours of coverage it did not
  // have, which is the exact failure this page exists to prevent. Found by a
  // single test capture, and it would have been found in production by the
  // first real one.
  const [totals, gaps, gapTotals, rooms] = await Promise.all([
    pool.query(
      `select
         count(*)::text                  as records,
         count(distinct did)::text       as dids,
         count(distinct room)::text      as rooms,
         count(*) filter (where source = 'submitted')::text as submitted,
         min(captured_at) filter (where source = 'mirrored') as first_captured_at,
         max(captured_at) filter (where source = 'mirrored') as last_captured_at,
         min(source_ts)                  as earliest_source_ts,
         max(source_ts)                  as latest_source_ts
       from records`
    ),
    // The largest accountable holes, and the counts, in one round trip.
    //
    // It used to be `order by noticed_at` with no limit, which shipped every
    // row on the table to every visitor — a thousand today and climbing, for a
    // page that shows eight. Ordered by size now, because a client that keeps
    // the top N wants the biggest N and not the newest.
    //
    // 'rotated' is excluded from the rows AND from every total here. It is not
    // a hole in the record; it is where the record starts.
    pool.query(
      `select id::text, room, kind, missing, recovered,
              expected_seq::text as expected_seq, first_seq::text as first_seq, noticed_at
         from gaps
        where kind = any($1::text[])
        order by greatest(0, coalesce(missing, 0) - recovered) desc, noticed_at desc
        limit $2`,
      [LOSS_KINDS, GAP_LIMIT]
    ),
    pool.query(
      `select
         count(*) filter (where kind = any($1::text[]))::text         as accountable,
         coalesce(sum(greatest(0, coalesce(missing,0) - recovered))
                  filter (where kind = 'missed'), 0)::text            as lost_missed,
         coalesce(sum(greatest(0, coalesce(missing,0) - recovered))
                  filter (where kind = 'downtime'), 0)::text          as lost_downtime,
         count(distinct room) filter (where kind = 'rotated')::text   as rooms_begun_mid_ring
       from gaps`,
      [LOSS_KINDS]
    ),
    pool.query(
      `select room, count(*)::text as records,
              min(captured_at) as first_captured_at, max(captured_at) as last_captured_at
         from records group by room order by room`
    ),
  ]);

  const t = totals.rows[0] ?? {};
  const g = gapTotals.rows[0] ?? {};
  const gapRows: GapRow[] = gaps.rows.map((row) => ({
    id: row.id,
    room: row.room,
    kind: row.kind,
    missing: row.missing == null ? null : Number(row.missing),
    recovered: Number(row.recovered ?? 0),
    lost: Math.max(0, Number(row.missing ?? 0) - Number(row.recovered ?? 0)),
    expectedSeq: row.expected_seq ?? null,
    firstSeq: row.first_seq ?? null,
    noticedAt: iso(row.noticed_at)!,
  }));

  const lastCapturedAt = iso(t.last_captured_at);

  return {
    firstCapturedAt: iso(t.first_captured_at),
    lastCapturedAt,
    earliestSourceTs: iso(t.earliest_source_ts),
    latestSourceTs: iso(t.latest_source_ts),
    records: int(t.records),
    dids: int(t.dids),
    rooms: int(t.rooms),
    submitted: int(t.submitted),
    staleSeconds:
      lastCapturedAt == null ? null : Math.round((Date.now() - Date.parse(lastCapturedAt)) / 1000),
    gaps: gapRows,
    gapsTotal: int(g.accountable),

    // Summed in the database over EVERY accountable row, not over the page of
    // rows above it. `gaps` is the largest few hundred; a total derived from
    // them would shrink as the cap tightened, which is a headline figure that
    // depends on a display setting.
    lostMissed: int(g.lost_missed),
    lostDowntime: int(g.lost_downtime),
    lostMessages: int(g.lost_missed) + int(g.lost_downtime),

    roomsBegunMidRing: int(g.rooms_begun_mid_ring),

    roomsCovered: rooms.rows.map((row) => ({
      room: row.room,
      policy: policyFor(row.room),
      records: Number(row.records),
      firstCapturedAt: iso(row.first_captured_at),
      lastCapturedAt: iso(row.last_captured_at),
    })),
  };
}

// ---------------------------------------------------------------------------
// One DID
// ---------------------------------------------------------------------------

const EARLIEST_SAMPLE = 10;

export async function didReport(did: string, before: string | null): Promise<DidReport> {
  const pool = getPool();

  const [totals, rooms, days, earliest, cov] = await Promise.all([
    pool.query(
      `select count(*)::text as total,
              min(captured_at) as first_captured_at, max(captured_at) as last_captured_at,
              min(source_ts)   as first_source_ts,   max(source_ts)   as last_source_ts
         from records where did = $1`,
      [did]
    ),
    pool.query(
      `select room,
              count(*)::text as records,
              count(*) filter (where sighting is not null)::text as sampled,
              min(captured_at) as first_captured_at, max(captured_at) as last_captured_at,
              min(source_ts)   as first_source_ts,   max(source_ts)   as last_source_ts
         from records where did = $1
        group by room
        order by min(source_ts) nulls last`,
      [did]
    ),
    // The day a message was POSTED, which is the day a reader means when they
    // ask what this DID was doing. Capture day would answer a question about
    // Notary's schedule instead.
    pool.query(
      `select to_char((source_ts at time zone 'utc')::date, 'YYYY-MM-DD') as day,
              count(*)::text as records
         from records where did = $1 and source_ts is not null
        group by 1 order by 1`,
      [did]
    ),
    pool.query(
      `select id::text, did, room, nonce::text as nonce, sig, text,
              captured_at, source_ts, source_seq::text as source_seq, sighting, source
         from records where did = $1
        order by source_ts asc nulls last, captured_at asc
        limit ${EARLIEST_SAMPLE}`,
      [did]
    ),
    coverage(),
  ]);

  const t = totals.rows[0] ?? {};
  const firstCapturedAt = iso(t.first_captured_at);
  const firstSourceTs = iso(t.first_source_ts);

  const earliestRows: RecordRow[] = earliest.rows.map(toRecordRow);

  return {
    did,
    totalRecords: int(t.total),
    firstCapturedAt,
    lastCapturedAt: iso(t.last_captured_at),
    firstSourceTs,
    lastSourceTs: iso(t.last_source_ts),
    rooms: rooms.rows.map((row) => ({
      room: row.room,
      policy: policyFor(row.room),
      records: Number(row.records),
      sampled: Number(row.sampled) > 0 || policyFor(row.room) === POLICY.SIGHTINGS,
      firstCapturedAt: iso(row.first_captured_at),
      lastCapturedAt: iso(row.last_captured_at),
      firstSourceTs: iso(row.first_source_ts),
      lastSourceTs: iso(row.last_source_ts),
    })),
    days: days.rows.map((row) => ({ day: row.day, records: Number(row.records) })),
    earliest: earliestRows,
    cutoff: before
      ? evaluateCutoff({ before, firstCapturedAt, firstSourceTs, earliest: earliestRows })
      : null,
    coverage: cov,
    caveat: CAVEAT,
  };
}

/**
 * The headline question: was this DID active before some date?
 *
 * Three answers, and the two positive ones are different claims:
 *
 *   witnessed   Notary's own clock says it held a signed message from this DID
 *               before the cutoff. The strongest statement in the product.
 *   claimed     the archive holds a signed message the ROOM dates before the
 *               cutoff. The signature is still real and still re-verifiable;
 *               what is unverified is the time, and the room is the one making
 *               that claim, not Notary.
 *   no-evidence nothing found. This says something about the archive and
 *               nothing whatever about the DID.
 *
 * Pure, so the distinction that matters most can be tested exhaustively without
 * a database.
 */
export function evaluateCutoff({
  before,
  firstCapturedAt,
  firstSourceTs,
  earliest,
}: {
  before: string;
  firstCapturedAt: string | null;
  firstSourceTs: string | null;
  earliest: RecordRow[];
}): CutoffResult {
  const cutoffMs = Date.parse(before);
  const witnessed =
    firstCapturedAt != null && Date.parse(firstCapturedAt) < cutoffMs ? firstCapturedAt : null;
  const claimed = firstSourceTs != null && Date.parse(firstSourceTs) < cutoffMs ? firstSourceTs : null;

  // The evidence is the earliest record whose relevant clock beats the cutoff,
  // so the answer always comes with something to go and check.
  const evidence =
    earliest.find((record) => {
      const when = witnessed ? record.capturedAt : record.sourceTs;
      return when != null && Date.parse(when) < cutoffMs;
    }) ?? null;

  return {
    before,
    answer: witnessed ? 'witnessed' : claimed ? 'claimed' : 'no-evidence',
    witnessedBefore: witnessed,
    claimedBefore: claimed,
    evidenceRecordId: evidence?.id ?? null,
    caveat: CAVEAT,
  };
}

function toRecordRow(row: Record<string, any>): RecordRow {
  return {
    id: row.id,
    did: row.did,
    room: row.room,
    // Already a string from Postgres and kept one: see db.ts.
    nonce: String(row.nonce),
    sig: row.sig,
    text: row.text,
    capturedAt: iso(row.captured_at)!,
    sourceTs: iso(row.source_ts),
    sourceSeq: row.source_seq ?? null,
    sighting: row.sighting ?? null,
    source: row.source,
  };
}

// ---------------------------------------------------------------------------
// One record, and its place in the tree
// ---------------------------------------------------------------------------

export async function recordById(id: string): Promise<RecordRow | null> {
  const { rows } = await getPool().query(
    `select id::text, did, room, nonce::text as nonce, sig, text,
            captured_at, source_ts, source_seq::text as source_seq, sighting, source
       from records where id = $1::bigint`,
    [id]
  );
  return rows[0] ? toRecordRow(rows[0]) : null;
}

/**
 * Every record captured on a day, in the order the anchor commits to.
 *
 * Ordered by captured_at then id: capture timestamps can tie — a batch insert
 * gives a whole INSERT the same now() — and a tie broken differently on two
 * runs would produce two different roots for the same data.
 */
export async function recordsForDay(day: string): Promise<RecordRow[]> {
  const { rows } = await getPool().query(
    `select id::text, did, room, nonce::text as nonce, sig, text,
            captured_at, source_ts, source_seq::text as source_seq, sighting, source
       from records where day = $1::date
      order by captured_at asc, id asc`,
    [day]
  );
  return rows.map(toRecordRow);
}

export async function anchors(): Promise<AnchorRow[]> {
  const { rows } = await getPool().query(
    `select to_char(day, 'YYYY-MM-DD') as day, root, record_count, published_seq::text as published_seq,
            published_at, first_capture, last_capture
       from anchors order by day desc`
  );
  return rows.map((row) => ({
    day: row.day,
    root: row.root,
    recordCount: row.record_count == null ? null : Number(row.record_count),
    publishedSeq: row.published_seq ?? null,
    publishedAt: iso(row.published_at),
    firstCapture: iso(row.first_capture),
    lastCapture: iso(row.last_capture),
  }));
}

export async function anchorForDay(day: string): Promise<AnchorRow | null> {
  const all = await anchors();
  return all.find((anchor) => anchor.day === day) ?? null;
}

/** The capture day of a record, as the anchor tables key it. */
export async function dayOfRecord(id: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `select to_char(day, 'YYYY-MM-DD') as day from records where id = $1::bigint`,
    [id]
  );
  return rows[0]?.day ?? null;
}
