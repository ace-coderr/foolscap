// db.ts — Postgres access for the Notary archive.
//
// Nonces are passed to and from Postgres as strings, end to end. node-postgres
// returns numeric as a string by default and we never coerce it, because the
// moment a nonce becomes a JS number it stops reproducing the canonical string
// the signature covers.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

/**
 * A record on its way into the archive.
 *
 * `nonce` is a string here and stays one all the way to Postgres: it is written
 * to a numeric(20,0) column, and anything that let it become a JS number would
 * silently break re-verification for every nonce past 2^53.
 */
export interface ArchiveRecord {
  did: string;
  room: string;
  nonce: string;
  sig: string;
  text: string;
  source: 'submitted' | 'mirrored';
  sourceTs?: string | null;
  sourceSeq?: number | null;
  /** Set only for rooms under the sampling policy. */
  sighting?: 'first' | 'last';
  activityDay?: string;
}

export interface GapRow {
  room: string;
  /** 'missed' and 'downtime' are loss; 'rotated' marks where coverage begins. */
  kind: 'missed' | 'downtime' | 'regenerated' | 'rotated';
  missing?: number | null;
  expectedSeq?: number | null;
  firstSeq?: number | null;
  generation?: number | null;
}

export interface ArchiveTotals {
  records: string;
  dids: string;
  missed_gaps: string;
  first_capture: Date | null;
  last_capture: Date | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Postgres numeric OID. Left as a string on the way out — see the note above. */
const NUMERIC_OID = 1700;
pg.types.setTypeParser(NUMERIC_OID, (value) => value);

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Create a Supabase project, copy its Direct connection ' +
        'string (or the Session pooler string on an IPv4-only network), and put it in .env as ' +
        'DATABASE_URL=postgresql://...'
    );
  }

  pool = new pg.Pool({
    connectionString,
    // Supabase presents a certificate the default Node trust store does not
    // chain. The connection is still encrypted; to verify the chain as well,
    // download the project CA certificate and pass { ca } here instead.
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX ?? 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
  });

  pool.on('error', (err) => {
    console.error(`[db] idle client error: ${err.message}`);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/** Apply db/schema.sql. Idempotent. */
export async function migrate(): Promise<void> {
  const sql = await readFile(join(HERE, '..', 'db', 'schema.sql'), 'utf8');
  await getPool().query(sql);
}

/**
 * Every table the schema file declares, read from the file.
 *
 * NOT A LIST WRITTEN OUT HERE. There was one, and the migrate script had a
 * second copy of it in a console.log, and when `cursors` was added neither was
 * updated — so a migration that had correctly created the table reported three
 * tables and left it looking like it had not. A list of what the schema
 * contains, kept anywhere other than the schema, is a list that goes stale on
 * the first change nobody thinks to mirror.
 *
 * Comments are stripped first so the prose above each table — which discusses
 * tables at length — cannot be read as a declaration.
 */
export async function schemaTables(): Promise<string[]> {
  return parseTableNames(await readFile(join(HERE, '..', 'db', 'schema.sql'), 'utf8'));
}

/**
 * The parsing half, separated so it can be tested without a file or a database.
 *
 * Line comments go first. The schema's prose discusses tables at length — "the
 * mirror writes down where it read", "an archive that quietly has holes" — and
 * a parser that read the commentary would report whatever the last person
 * happened to write about.
 */
export function parseTableNames(sql: string): string[] {
  const stripped = sql.replace(/--.*$/gm, '');
  const names = new Set<string>();
  for (const match of stripped.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi
  )) {
    names.add(match[1].toLowerCase());
  }
  return [...names].sort();
}

/** The public tables that exist right now. */
export async function publicTables(): Promise<Set<string>> {
  const { rows } = await getPool().query(
    `select table_name from information_schema.tables where table_schema = 'public'`
  );
  return new Set(rows.map((r: { table_name: string }) => r.table_name));
}

/** Fail loudly and early rather than a thousand times inside the write loop. */
export async function assertSchema(): Promise<void> {
  const expected = await schemaTables();
  const found = await publicTables();
  const missing = expected.filter((t) => !found.has(t));
  if (missing.length) {
    throw new Error(
      `Missing table(s): ${missing.join(', ')}. Run "npm run migrate" against this database first.`
    );
  }
}

const COLUMNS = ['did', 'room', 'nonce', 'sig', 'text', 'source', 'source_ts', 'source_seq'];

/**
 * Insert a batch of records, ignoring any (did, room, nonce) already held.
 *
 * Agents retry and rings overlap, so re-seeing a message is normal, not an
 * error. Returns how many rows were new.
 */
export async function insertRecords(records: ArchiveRecord[]): Promise<StoredRecord[]> {
  if (records.length === 0) return [];

  const values: string[] = [];
  const params: unknown[] = [];
  records.forEach((record, i) => {
    const base = i * COLUMNS.length;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}::numeric, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}::timestamptz, $${base + 8}::bigint, ` +
        `now(), (now() at time zone 'utc')::date)`
    );
    params.push(
      record.did,
      record.room,
      // A string, deliberately. See the module comment.
      String(record.nonce),
      record.sig,
      record.text,
      record.source,
      record.sourceTs ?? null,
      record.sourceSeq ?? null
    );
  });

  // RETURNING, because the summary tier has to be built from the rows that
  // actually landed. `on conflict do nothing` silently drops retries and
  // overlapping ring reads, and a summary counted from the batch instead of
  // from the result would inflate message_count every time the mirror re-read
  // a stretch it already had.
  const { rows } = await getPool().query(
    `insert into records (${COLUMNS.join(', ')}, captured_at, day)
     values ${values.join(', ')}
     on conflict (did, room, nonce) where sighting is null do nothing
     returning id, did, room, captured_at, source_ts`,
    params
  );
  return rows.map((r: InsertedRow) => ({
    id: String(r.id),
    did: r.did,
    room: r.room,
    capturedAt: r.captured_at,
    sourceTs: r.source_ts,
  }));
}

interface InsertedRow {
  id: string | number;
  did: string;
  room: string;
  captured_at: Date;
  source_ts: Date | null;
}

/** What an insert actually wrote, which is what the summary tier is built from. */
export interface StoredRecord {
  id: string;
  did: string;
  room: string;
  capturedAt: Date;
  sourceTs: Date | null;
}

/**
 * Fold a batch of stored records into the permanent tier.
 *
 * One row per (did, room), upserted on every capture rather than derived at
 * prune time — deriving it later would mean reading the records it is meant to
 * replace, on the run that is deleting them.
 *
 * least() and greatest() ignore nulls in Postgres, which is what makes
 * source_ts safe here: a message the room gave no timestamp for leaves the
 * claimed-clock bounds alone instead of poisoning them.
 *
 * The pin moves only backwards. It names the earliest record Notary CAPTURED —
 * the strongest thing it can say, and the one whose captured_at the summary's
 * first_captured_at reports — so the evidence offered always matches the
 * witnessed answer. A backfill reaching further back re-pins; nothing else does.
 */
export async function upsertSummaries(stored: StoredRecord[]): Promise<number> {
  if (stored.length === 0) return 0;

  const folded = new Map<string, {
    did: string; room: string; first: StoredRecord; firstSrc: Date | null;
    lastCap: Date; lastSrc: Date | null; count: number;
  }>();

  for (const r of stored) {
    const key = `${r.did} ${r.room}`;
    const seen = folded.get(key);
    if (!seen) {
      folded.set(key, {
        did: r.did, room: r.room, first: r, firstSrc: r.sourceTs,
        lastCap: r.capturedAt, lastSrc: r.sourceTs, count: 1,
      });
      continue;
    }
    seen.count++;
    if (r.capturedAt < seen.first.capturedAt) seen.first = r;
    if (r.sourceTs && (!seen.firstSrc || r.sourceTs < seen.firstSrc)) seen.firstSrc = r.sourceTs;
    if (r.capturedAt > seen.lastCap) seen.lastCap = r.capturedAt;
    if (r.sourceTs && (!seen.lastSrc || r.sourceTs > seen.lastSrc)) seen.lastSrc = r.sourceTs;
  }

  const values: string[] = [];
  const params: unknown[] = [];
  let i = 0;
  for (const f of folded.values()) {
    const b = i * 8;
    values.push(
      `($${b + 1}, $${b + 2}, $${b + 3}::timestamptz, $${b + 4}::timestamptz, ` +
        `$${b + 5}::timestamptz, $${b + 6}::timestamptz, $${b + 7}::bigint, $${b + 8}::bigint)`
    );
    params.push(
      f.did, f.room, f.first.capturedAt, f.firstSrc,
      f.lastCap, f.lastSrc, f.count, f.first.id
    );
    i++;
  }

  const { rowCount } = await getPool().query(
    `insert into summaries (did, room, first_captured_at, first_source_ts,
                            last_captured_at, last_source_ts, message_count, pinned_record_id)
     values ${values.join(', ')}
     on conflict (did, room) do update set
       first_source_ts  = least(summaries.first_source_ts, excluded.first_source_ts),
       last_captured_at = greatest(summaries.last_captured_at, excluded.last_captured_at),
       last_source_ts   = greatest(summaries.last_source_ts, excluded.last_source_ts),
       message_count    = summaries.message_count + excluded.message_count,
       last_updated     = now(),
       -- The pin and the first_captured_at it explains move together or not at
       -- all: splitting them would let the summary report a witnessed time the
       -- record it offers does not show.
       pinned_record_id = case
         when excluded.first_captured_at < summaries.first_captured_at
           then excluded.pinned_record_id else summaries.pinned_record_id end,
       first_captured_at = least(summaries.first_captured_at, excluded.first_captured_at)`,
    params
  );
  return rowCount ?? 0;
}

/**
 * Store first/last sightings for a sampled room.
 *
 * 'first' moves only backwards and 'last' only forwards, so records arriving out
 * of order — a sweep filling a hole, say — settle to the true earliest and
 * latest rather than to whatever happened to be written last.
 *
 * One statement per row: the rows in a batch routinely collide with each other
 * on (did, room, activity_day, sighting), and Postgres will not let a single
 * INSERT touch the same conflict target twice.
 */
export async function upsertSightings(records: ArchiveRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const pool = getPool();
  let written = 0;

  for (const record of records) {
    const newer = record.sighting === 'last';
    const { rowCount } = await pool.query(
      `insert into records
         (did, room, nonce, sig, text, source, source_ts, source_seq,
          sighting, activity_day, captured_at, day)
       values ($1, $2, $3::numeric, $4, $5, $6, $7::timestamptz, $8::bigint,
               $9, $10::date, now(), (now() at time zone 'utc')::date)
       on conflict (did, room, activity_day, sighting) where sighting is not null
       do update set
            nonce      = excluded.nonce,
            sig        = excluded.sig,
            text       = excluded.text,
            source_ts  = excluded.source_ts,
            source_seq = excluded.source_seq,
            captured_at = excluded.captured_at
          where ${newer
            ? 'excluded.source_seq > records.source_seq'
            : 'excluded.source_seq < records.source_seq'}`,
      [
        record.did,
        record.room,
        String(record.nonce),
        record.sig,
        record.text,
        record.source,
        record.sourceTs ?? null,
        record.sourceSeq ?? null,
        record.sighting,
        record.activityDay,
      ]
    );
    written += rowCount ?? 0;
  }
  return written;
}

/** Record a hole in the archive. Returns its id so a later sweep can amend it. */
export async function insertGap({
  room,
  kind,
  missing,
  expectedSeq,
  firstSeq,
  generation,
}: GapRow): Promise<number | null> {
  const { rows } = await getPool().query(
    `insert into gaps (room, kind, missing, expected_seq, first_seq, generation)
     values ($1, $2, $3, $4::bigint, $5::bigint, $6)
     returning id`,
    [room, kind, missing ?? null, expectedSeq ?? null, firstSeq ?? null, generation ?? null]
  );
  return rows[0]?.id ?? null;
}

/** Note how much of a hole a re-export got back. */
export async function markGapRecovered(id: number | null, recovered: number): Promise<void> {
  if (id == null) return;
  await getPool().query(`update gaps set recovered = recovered + $2 where id = $1`, [id, recovered]);
}

/** The highest source_seq held for a room, so a restart resumes where it stopped. */
/**
 * The highest sequence STORED for a room.
 *
 * No longer the resume point — see readCursor. It survives as the one-time seed
 * for an archive that predates the cursors table, and as the honest answer to a
 * different question: what is the newest thing actually held.
 */
export async function lastSeqFor(room: string): Promise<number> {
  const { rows } = await getPool().query(
    `select max(source_seq) as seq from records where room = $1`,
    [room]
  );
  const seq = rows[0]?.seq;
  return seq == null ? 0 : Number(seq);
}

/** Where the mirror has read to, or null if it has never written one. */
export async function readCursor(room: string): Promise<number | null> {
  const { rows } = await getPool().query(`select last_seq from cursors where room = $1`, [room]);
  const seq = rows[0]?.last_seq;
  return seq == null ? null : Number(seq);
}

/**
 * Advance the cursor, never retreat it.
 *
 * `greatest` rather than a plain assignment because the sweep re-exports a room
 * to fill an old hole, and that read ends far below the follow cursor. A write
 * that took the last value would drag the resume point backwards and the next
 * restart would book everything since as lost.
 */
export async function writeCursor(room: string, lastSeq: number): Promise<void> {
  await getPool().query(
    `insert into cursors (room, last_seq) values ($1, $2::bigint)
     on conflict (room) do update
       set last_seq = greatest(cursors.last_seq, excluded.last_seq),
           updated_at = now()`,
    [room, lastSeq]
  );
}

/** What /capture answers with, and whether this call is what created the row. */
export interface CaptureResult {
  id: string;
  capturedAt: string;
  day: string;
  /** False when an identical submission was already held. */
  created: boolean;
}

/**
 * Store one submitted record, idempotently.
 *
 * Agents retry — on a timeout, on a 500, on a restart — and a retry must not
 * mint a second row. (did, room, nonce) is unique for full records, so the
 * insert simply does nothing on a clash and the original is read back and
 * returned. The caller sees the same id and the same captured_at it saw the
 * first time, which is what makes the endpoint safe to hammer with retries and
 * is also why the timestamp cannot drift on a resubmission: the anchor already
 * committed to the first one.
 */
export async function captureRecord(record: {
  did: string;
  room: string;
  nonce: string;
  sig: string;
  text: string;
}): Promise<CaptureResult> {
  const pool = getPool();
  const params = [record.did, record.room, String(record.nonce), record.sig, record.text];

  const inserted = await pool.query(
    `insert into records (did, room, nonce, sig, text, source, captured_at, day)
     values ($1, $2, $3::numeric, $4, $5, 'submitted', now(), (now() at time zone 'utc')::date)
     on conflict (did, room, nonce) where sighting is null do nothing
     returning id::text as id, captured_at, to_char(day, 'YYYY-MM-DD') as day`,
    params
  );

  if (inserted.rows[0]) {
    const row = inserted.rows[0];
    return { id: row.id, capturedAt: row.captured_at.toISOString(), day: row.day, created: true };
  }

  const existing = await pool.query(
    `select id::text as id, captured_at, to_char(day, 'YYYY-MM-DD') as day
       from records
      where did = $1 and room = $2 and nonce = $3::numeric and sighting is null`,
    params.slice(0, 3)
  );
  const row = existing.rows[0];
  if (!row) {
    // The insert hit a conflict and the row is not there to read back. That
    // means a sighting row holds the key, which cannot happen for a submitted
    // record — better to fail loudly than to invent an id.
    throw new Error('capture conflicted but the original could not be read back');
  }
  return { id: row.id, capturedAt: row.captured_at.toISOString(), day: row.day, created: false };
}

/** Write a day's Merkle root. Re-running a day overwrites its row. */
export async function upsertAnchor(anchor: {
  day: string;
  root: string | null;
  recordCount: number;
  firstCapture: string | null;
  lastCapture: string | null;
}): Promise<void> {
  await getPool().query(
    `insert into anchors (day, root, record_count, first_capture, last_capture)
     values ($1::date, $2, $3, $4::timestamptz, $5::timestamptz)
     on conflict (day) do update set
       root = excluded.root,
       record_count = excluded.record_count,
       first_capture = excluded.first_capture,
       last_capture = excluded.last_capture`,
    [anchor.day, anchor.root, anchor.recordCount, anchor.firstCapture, anchor.lastCapture]
  );
}

/** Note where a root was published, once it is in a room. */
export async function markAnchorPublished(day: string, seq: number | null): Promise<void> {
  await getPool().query(
    `update anchors set published_seq = $2::bigint, published_at = now() where day = $1::date`,
    [day, seq]
  );
}

export async function archiveStats(): Promise<ArchiveTotals> {
  const { rows } = await getPool().query(
    `select
       (select count(*) from records)                      as records,
       (select count(distinct did) from records)           as dids,
       (select count(*) from gaps where kind = 'missed')   as missed_gaps,
       (select min(captured_at) from records)              as first_capture,
       (select max(captured_at) from records)              as last_capture`
  );
  return rows[0];
}
