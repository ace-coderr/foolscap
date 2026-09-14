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
import { policyFor, POLICY, WATCHED_ROOMS, type Policy } from './policy.ts';

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
  /**
   * The permanent tier, per room. Empty for a key whose records are all still
   * inside the retention window — there is nothing the originals do not say.
   */
  summary: SummaryRow[];
  cutoff: CutoffResult | null;
  coverage: Coverage;
  caveat: string;
}

/**
 * What the permanent tier says about one (did, room) pair.
 *
 * A SECOND SOURCE, NOT A CORRECTION TO THE FIRST. The record-derived figures
 * beside it are counted from originals Notary still holds and can hand over;
 * these are counted from originals it held and deleted. Both are true and they
 * answer different questions, so they are served apart and labelled apart —
 * the same discipline the page already applies to live-versus-archive, for the
 * same reason: a reader has to know which kind of thing they are leaning on.
 *
 * The cutoff answer is never built from these. The pinned record is the
 * earliest Notary captured and it survives the prune, so the strongest claim
 * on the page stays backed by a signed message anyone can re-verify.
 */
export interface SummaryRow {
  room: string;
  firstCapturedAt: string;
  firstSourceTs: string | null;
  lastCapturedAt: string;
  lastSourceTs: string | null;
  messageCount: number;
  /** The one original kept back from pruning, if there is one. */
  pinnedRecordId: string | null;
  /** True when the tier stands for messages that are no longer held whole. */
  prunedBehind: boolean;
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

  /**
   * The rooms the mirror follows, and it follows all of them completely.
   *
   * Served so the page can name them. Notary's claim changed shape when the
   * chat rooms were dropped: it was "the network, partially" and is now "these
   * rooms, entirely", which is smaller, stronger, and only honest if the list
   * is on the page rather than in a config file nobody reads.
   */
  roomsWatched: string[];

  /**
   * How many hours of full records are kept. Past it, a period survives as the
   * summary tier plus each pair's earliest pinned original.
   *
   * Served so the page can say what it no longer has rather than returning a
   * thinner answer that looks like a complete one.
   */
  retainHours: number;
  /** Whether the earliest original per (did, room) is held back from pruning. */
  pinsEarliest: boolean;

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
  /**
   * The day's capture window is gone — see the anchors table in schema.sql.
   * When this is set, firstCapture and lastCapture are served as null, because
   * what is stored in them belongs to the run that destroyed them. The root
   * still verifies; the window is simply a thing Notary no longer knows.
   */
  windowLost: boolean;
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
    //
    // AND SO ARE ROOMS NOTARY NO LONGER WATCHES. The chat rooms were followed
    // until 14 September and their holes are still on the table, correctly —
    // they describe history that really was missed. But the ratio above them
    // says "of the messages that went through the rooms it was watching", and
    // once a room is not watched its holes belong to a different question.
    // Counting them would put loss in the numerator for rooms the archive
    // holds nothing from, against a claim of "these rooms, completely".
    pool.query(
      `select id::text, room, kind, missing, recovered,
              expected_seq::text as expected_seq, first_seq::text as first_seq, noticed_at
         from gaps
        where kind = any($1::text[]) and room = any($2::text[])
        order by greatest(0, coalesce(missing, 0) - recovered) desc, noticed_at desc
        limit $3`,
      [LOSS_KINDS, WATCHED_ROOMS, GAP_LIMIT]
    ),
    pool.query(
      `select
         count(*) filter (where kind = any($1::text[]))::text         as accountable,
         coalesce(sum(greatest(0, coalesce(missing,0) - recovered))
                  filter (where kind = 'missed'), 0)::text            as lost_missed,
         coalesce(sum(greatest(0, coalesce(missing,0) - recovered))
                  filter (where kind = 'downtime'), 0)::text          as lost_downtime,
         count(distinct room) filter (where kind = 'rotated')::text   as rooms_begun_mid_ring
       from gaps
      where room = any($2::text[])`,
      [LOSS_KINDS, WATCHED_ROOMS]
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
    roomsWatched: [...WATCHED_ROOMS],
    retainHours: Number(process.env.NOTARY_RETAIN_HOURS ?? 12),
    pinsEarliest: process.env.NOTARY_PIN_EARLIEST !== '0',

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

  const [totals, rooms, days, earliest, summary, cov] = await Promise.all([
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
    // The tier, read alongside rather than folded in. A pair whose records are
    // all still held has a row here saying the same thing; the page shows it
    // only where it says MORE than the records do, which is where records have
    // been pruned out from under it.
    pool.query(
      `select s.room, s.first_captured_at, s.first_source_ts,
              s.last_captured_at, s.last_source_ts,
              s.message_count::text as message_count,
              s.pinned_record_id::text as pinned_record_id,
              (s.message_count > (select count(*) from records r
                                   where r.did = s.did and r.room = s.room)) as pruned_behind
         from summaries s where s.did = $1 order by s.room`,
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
    summary: summary.rows.map((row) => ({
      room: row.room,
      firstCapturedAt: iso(row.first_captured_at)!,
      firstSourceTs: iso(row.first_source_ts),
      lastCapturedAt: iso(row.last_captured_at)!,
      lastSourceTs: iso(row.last_source_ts),
      messageCount: Number(row.message_count),
      pinnedRecordId: row.pinned_record_id ?? null,
      prunedBehind: row.pruned_behind === true,
    })),
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
/** The five fields a Merkle leaf is made of. No text: it is not in the leaf. */
export interface AnchorLeafRow {
  id: string;
  did: string;
  room: string;
  nonce: string;
  sig: string;
  capturedAt: string;
  /**
   * captured_at at FULL precision, fixed-width, for ordering.
   *
   * node-postgres parses timestamptz into a JS Date, which is milliseconds —
   * and Postgres stores and sorts microseconds. Ordering on the parsed Date
   * silently reorders every pair of records captured inside the same
   * millisecond, which in a batch insert is most of them. Measured: the two
   * orderings diverged after 15,980 rows of one day.
   *
   * YYYYMMDDHH24MISSUS is zero-padded and fixed-width, so byte order is time
   * order, and it survives the driver as a string.
   */
  sortAt: string;
}

/**
 * A day's records, in pages, for building its anchor.
 *
 * recordsForDay pulled the whole day in one query with an ORDER BY, and at
 * 752,186 records that is a parallel sequential scan feeding an external merge
 * sort of 75 MB to disk — 110 seconds, past the statement timeout. The day
 * could not be anchored, so the retention run would not prune it, so the
 * window could not move: a deadlock at exactly the moment it needed to.
 *
 * Three things make this version cheap, and only the first is the obvious one.
 *
 * NO TEXT. A leaf is did|room|nonce|sig|captured_at. The message body is the
 * largest column in the table and was being hauled across the wire for every
 * record to be thrown away.
 *
 * PAGED ON THE PRIMARY KEY, which is the one index that can serve an ordered
 * scan here without a sort.
 *
 * NO ORDER BY AT ALL. The anchor's order is captured_at then id — and `id` in
 * that clause resolves to the SELECT's `id::text` alias, so Postgres has always
 * sorted it as a string. That is reproducible, which is what an anchor needs,
 * and it is also why no index could ever serve it. Ordering now happens in the
 * caller, over hashes rather than rows, on exactly the same key. See
 * buildAnchor: changing the key would change every root already published.
 */
export async function* anchorRowsForDay(
  day: string,
  pageSize = 20_000
): AsyncGenerator<AnchorLeafRow[]> {
  let after = '0';
  for (;;) {
    const { rows } = await getPool().query(
      // `id` BARE, NOT `id::text as id`. Aliasing the cast to the column's own
      // name makes ORDER BY bind to the text output instead of the bigint
      // column, so the page comes back in lexicographic order — "1000000"
      // before "459506" — while the keyset filters numerically. The pager then
      // takes a text-last row as its cursor and skips every id numerically
      // below it. Measured: 143,423 of 763,547 rows silently missing, and a
      // root built over the remainder.
      //
      // node-postgres returns int8 as a string already, so nothing is lost by
      // not casting, and the primary key can serve the ordering.
      `select id, did, room, nonce::text as nonce, sig, captured_at,
              to_char(captured_at at time zone 'utc', 'YYYYMMDDHH24MISSUS') as sort_at
         from records
        where day = $1::date and id > $2::bigint
        order by id asc
        limit $3`,
      [day, after, pageSize]
    );
    if (rows.length === 0) return;
    after = rows[rows.length - 1].id;
    yield rows.map((row) => ({
      id: row.id,
      did: row.did,
      room: row.room,
      nonce: row.nonce,
      sig: row.sig,
      capturedAt: iso(row.captured_at)!,
      sortAt: row.sort_at,
    }));
  }
}

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
            published_at, first_capture, last_capture, window_lost
       from anchors order by day desc`
  );
  return rows.map((row) => ({
    day: row.day,
    root: row.root,
    recordCount: row.record_count == null ? null : Number(row.record_count),
    publishedSeq: row.published_seq ?? null,
    publishedAt: iso(row.published_at),
    // SUPPRESSED RATHER THAN READ. A flagged day still has timestamps in those
    // columns; they are the window of the run that overwrote the real ones.
    // Serving them would be Notary inventing a fact about its own history,
    // which is the one kind of lie this whole service is built to make hard.
    firstCapture: row.window_lost ? null : iso(row.first_capture),
    lastCapture: row.window_lost ? null : iso(row.last_capture),
    windowLost: row.window_lost === true,
  }));
}

/**
 * Roots over the summary tier.
 *
 * SERVED APART FROM THE RECORD ANCHORS, and it is the same rule as everywhere
 * else on this page: a record anchor commits to the messages captured on one
 * day, a summary anchor commits to the whole tier as it stood at one moment.
 * One series has days and adds up; the other is a sequence of snapshots and
 * does not. Folding them together would let a reader take a summary root as
 * covering records, which is the confusion the tier must not cause.
 */
export interface SummaryAnchorRow {
  id: string;
  builtAt: string;
  rowCount: number;
  root: string;
  publishedSeq: string | null;
  publishedAt: string | null;
}

export async function summaryAnchors(): Promise<SummaryAnchorRow[]> {
  const { rows } = await getPool().query(
    `select id::text, built_at, row_count, root,
            published_seq::text as published_seq, published_at
       from summary_anchors order by built_at desc limit 50`
  );
  return rows.map((row) => ({
    id: row.id,
    builtAt: iso(row.built_at)!,
    rowCount: Number(row.row_count),
    root: row.root,
    publishedSeq: row.published_seq ?? null,
    publishedAt: iso(row.published_at),
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
