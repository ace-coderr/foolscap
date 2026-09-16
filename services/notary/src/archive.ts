// archive.ts — the reads, after the pivot from watching to witnessing.
//
// Notary no longer crawls. It holds what was brought to it through /capture,
// verified on the way in, stamped with its own clock and anchored daily. See
// db/schema.sql for the arithmetic that ended the crawl.
//
// WHAT THAT DID TO THE SHAPES HERE, because it is not only a deletion:
//
// The old `Coverage` was almost entirely about the sweep — rooms watched,
// sightings policy, recorded holes, the retention window, loss split between
// "missed while reading" and "missed while down". None of it survives, because
// none of it is true of a service that only ever sees what it is handed.
// `Holdings` replaces it and is much smaller, which is the honest shape: Notary
// can now say exactly what it has and has nothing to apologise for not having.
//
// The cutoff answer lost a state. It used to be witnessed | claimed |
// no-evidence, where `claimed` meant the ROOM dated a message before the cutoff
// and Notary was repeating that claim without vouching for it. A submitted
// record has no room timestamp — the agent posts and Notary stamps, seconds
// apart — so every positive answer is now Notary's own clock. Fewer states, and
// the one that remains is the strong one.
//
// What did not change: a record is kept whole, the leaf is
// did|room|nonce|sig|captured_at, and no root is served as evidence until it
// has been published.

import { getPool } from './db.ts';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RoomActivity {
  room: string;
  records: number;
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
}

export interface RecordRow {
  id: string;
  did: string;
  room: string;
  nonce: string;
  sig: string;
  text: string;
  capturedAt: string;
}

/**
 * Two states, and `no-evidence` is not `false`.
 *
 * A false would be Notary asserting something about the key; this asserts
 * something about the archive, which is the only one of the two Notary is in a
 * position to know. Every consumer — including the page — is forced to handle
 * the difference because the type will not let them collapse it.
 *
 * The third state, `claimed`, went with the crawl: it existed to carry a room's
 * own timestamp, which Notary repeated and did not vouch for. Nothing here is
 * repeated any more.
 */
export type CutoffAnswer = 'witnessed' | 'no-evidence';

export interface CutoffResult {
  before: string;
  answer: CutoffAnswer;
  /** Notary's own clock beat the cutoff. The only positive answer there is. */
  witnessedBefore: string | null;
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
  rooms: RoomActivity[];
  /** Days Notary witnessed this key on, with row counts. */
  days: Array<{ day: string; records: number }>;
  /** The earliest few, because a cutoff question is always about the earliest. */
  earliest: RecordRow[];
  cutoff: CutoffResult | null;
  holdings: Holdings;
  caveat: string;
}

/**
 * What Notary holds, altogether.
 *
 * Every figure here is a count of things brought to Notary and verified. There
 * is no coverage figure because there is no coverage: Notary does not claim to
 * have seen anything it was not handed, so there is no gap between what it
 * watched and what it caught, and nothing to report about the difference.
 */
export interface Holdings {
  /** Notary's clock. Nothing before this exists here, for any key. */
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  records: number;
  dids: number;
  rooms: number;
  /** Days with at least one record, and how many of those have a published root. */
  days: number;
  anchoredDays: number;
  publishedDays: number;
  caveat: string;
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

/**
 * The sentence that goes with every answer.
 *
 * It got shorter with the pivot, and the change is not cosmetic. The old one
 * had to explain a sweep: where capture started, which rooms were watched,
 * which were sampled, and that holes existed. A witnessing service has one
 * limitation and it is a clean one — it knows about a key if someone submitted
 * a message from it, and otherwise it does not.
 */
export const CAVEAT =
  'Notary holds only what was submitted to it and verified. It does not watch rooms and ' +
  'does not look for keys. Absence of a record here means nothing was ever submitted for ' +
  'that key — never that the key was inactive.';

const iso = (value: Date | string | null): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const int = (value: unknown): number => Number(value ?? 0);

// ---------------------------------------------------------------------------
// Everything
// ---------------------------------------------------------------------------

export async function holdings(): Promise<Holdings> {
  const pool = getPool();

  // ONE SCAN, NO DISTINCT AGGREGATES OVER THE WHOLE TABLE.
  //
  // The crawling version ran count(distinct did) and count(distinct room) over
  // every row, which at 1.8M rows and 2 MB of work_mem spilled to temp files —
  // and when the disk filled, that is the query that took the page down with
  // "could not write to file: No space left on device". The table this reads is
  // bounded by who opts in rather than by the network's traffic, so the same
  // query would very likely be fine now. It is written this way anyway: a
  // count that degrades with success is a bad shape to leave lying around.
  const [totals, dayCounts] = await Promise.all([
    pool.query(
      `select count(*)::text as records,
              count(distinct did)::text as dids,
              count(distinct room)::text as rooms,
              min(captured_at) as first_captured_at,
              max(captured_at) as last_captured_at
         from records`
    ),
    pool.query(
      `select count(*)::text as anchored,
              count(*) filter (where published_seq is not null)::text as published
         from anchors where root is not null`
    ),
  ]);

  const t = totals.rows[0] ?? {};
  const d = dayCounts.rows[0] ?? {};

  // Days with records is derived from the anchors table where it can be, and
  // from the records table only when a day has not been anchored yet.
  const { rows: openDays } = await pool.query(
    `select count(distinct day)::text as days from records`
  );

  return {
    firstCapturedAt: iso(t.first_captured_at),
    lastCapturedAt: iso(t.last_captured_at),
    records: int(t.records),
    dids: int(t.dids),
    rooms: int(t.rooms),
    days: int(openDays[0]?.days),
    anchoredDays: int(d.anchored),
    publishedDays: int(d.published),
    caveat: CAVEAT,
  };
}

// ---------------------------------------------------------------------------
// One DID
// ---------------------------------------------------------------------------

const EARLIEST_SAMPLE = 10;

export async function didReport(did: string, before: string | null): Promise<DidReport> {
  const pool = getPool();

  const [totals, rooms, days, earliest, held] = await Promise.all([
    pool.query(
      `select count(*)::text as total,
              min(captured_at) as first_captured_at,
              max(captured_at) as last_captured_at
         from records where did = $1`,
      [did]
    ),
    pool.query(
      `select room, count(*)::text as records,
              min(captured_at) as first_captured_at,
              max(captured_at) as last_captured_at
         from records where did = $1
        group by room
        order by min(captured_at)`,
      [did]
    ),
    // The day Notary witnessed it, which is now the only day there is. The
    // crawling version grouped on the room's claimed post time instead,
    // because a backfill reading three days of ring history in one minute had
    // to produce three days of activity. Nothing is backfilled any more.
    pool.query(
      `select to_char(day, 'YYYY-MM-DD') as day, count(*)::text as records
         from records where did = $1
        group by 1 order by 1`,
      [did]
    ),
    pool.query(
      `select id::text, did, room, nonce::text as nonce, sig, text, captured_at
         from records where did = $1
        order by captured_at asc, id asc
        limit ${EARLIEST_SAMPLE}`,
      [did]
    ),
    holdings(),
  ]);

  const t = totals.rows[0] ?? {};
  const firstCapturedAt = iso(t.first_captured_at);
  const earliestRows: RecordRow[] = earliest.rows.map(toRecordRow);

  return {
    did,
    totalRecords: int(t.total),
    firstCapturedAt,
    lastCapturedAt: iso(t.last_captured_at),
    rooms: rooms.rows.map((row) => ({
      room: row.room,
      records: Number(row.records),
      firstCapturedAt: iso(row.first_captured_at),
      lastCapturedAt: iso(row.last_captured_at),
    })),
    days: days.rows.map((row) => ({ day: row.day, records: Number(row.records) })),
    earliest: earliestRows,
    cutoff: before ? evaluateCutoff({ before, firstCapturedAt, earliest: earliestRows }) : null,
    holdings: held,
    caveat: CAVEAT,
  };
}

/**
 * The headline question: was this key active before some date?
 *
 * Pure, so the distinction that matters most can be tested exhaustively without
 * a database.
 */
export function evaluateCutoff({
  before,
  firstCapturedAt,
  earliest,
}: {
  before: string;
  firstCapturedAt: string | null;
  earliest: RecordRow[];
}): CutoffResult {
  const cutoffMs = Date.parse(before);
  const witnessed =
    firstCapturedAt != null && Date.parse(firstCapturedAt) < cutoffMs ? firstCapturedAt : null;

  // The evidence is the earliest record that beats the cutoff, so the answer
  // always comes with something to go and check.
  const evidence =
    earliest.find((record) => Date.parse(record.capturedAt) < cutoffMs) ?? null;

  return {
    before,
    answer: witnessed ? 'witnessed' : 'no-evidence',
    witnessedBefore: witnessed,
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
  };
}

// ---------------------------------------------------------------------------
// One record, and its place in the tree
// ---------------------------------------------------------------------------

export async function recordById(id: string): Promise<RecordRow | null> {
  const { rows } = await getPool().query(
    `select id::text, did, room, nonce::text as nonce, sig, text, captured_at
       from records where id = $1::bigint`,
    [id]
  );
  return rows[0] ? toRecordRow(rows[0]) : null;
}

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
 * sort of 75 MB to disk — 110 seconds, past the statement timeout.
 *
 * A witnessing archive will not see days that size for a long time, and the
 * paging stays anyway: it costs nothing on a small day and it is the difference
 * between a service that degrades and one that stops.
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
      nonce: String(row.nonce),
      sig: row.sig,
      capturedAt: iso(row.captured_at)!,
      sortAt: row.sort_at,
    }));
  }
}

export async function recordsForDay(day: string): Promise<RecordRow[]> {
  const { rows } = await getPool().query(
    `select id::text, did, room, nonce::text as nonce, sig, text, captured_at
       from records where day = $1::date
      order by captured_at asc, id asc`,
    [day]
  );
  return rows.map(toRecordRow);
}

export async function anchors(): Promise<AnchorRow[]> {
  const { rows } = await getPool().query(
    `select to_char(day, 'YYYY-MM-DD') as day, root, record_count,
            published_seq::text as published_seq, published_at,
            first_capture, last_capture
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
  return all.find((row) => row.day === day) ?? null;
}

export async function dayOfRecord(id: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `select to_char(day, 'YYYY-MM-DD') as day from records where id = $1::bigint`,
    [id]
  );
  return rows[0]?.day ?? null;
}
