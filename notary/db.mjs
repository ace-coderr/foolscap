// db.mjs — Postgres access for the Notary archive.
//
// Nonces are passed to and from Postgres as strings, end to end. node-postgres
// returns numeric as a string by default and we never coerce it, because the
// moment a nonce becomes a JS number it stops reproducing the canonical string
// the signature covers.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Postgres numeric OID. Left as a string on the way out — see the note above. */
const NUMERIC_OID = 1700;
pg.types.setTypeParser(NUMERIC_OID, (value) => value);

let pool = null;

export function getPool() {
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

export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/** Apply db/schema.sql. Idempotent. */
export async function migrate() {
  const sql = await readFile(join(HERE, '..', 'db', 'schema.sql'), 'utf8');
  await getPool().query(sql);
}

/** Fail loudly and early rather than a thousand times inside the write loop. */
export async function assertSchema() {
  const { rows } = await getPool().query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('records', 'anchors', 'gaps')`
  );
  const found = new Set(rows.map((r) => r.table_name));
  const missing = ['records', 'anchors', 'gaps'].filter((t) => !found.has(t));
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
export async function insertRecords(records) {
  if (records.length === 0) return 0;

  const values = [];
  const params = [];
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

  const { rowCount } = await getPool().query(
    `insert into records (${COLUMNS.join(', ')}, captured_at, day)
     values ${values.join(', ')}
     on conflict (did, room, nonce) where sighting is null do nothing`,
    params
  );
  return rowCount;
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
export async function upsertSightings(records) {
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
    written += rowCount;
  }
  return written;
}

/** Record a hole in the archive. Returns its id so a later sweep can amend it. */
export async function insertGap({ room, kind, missing, expectedSeq, firstSeq, generation }) {
  const { rows } = await getPool().query(
    `insert into gaps (room, kind, missing, expected_seq, first_seq, generation)
     values ($1, $2, $3, $4::bigint, $5::bigint, $6)
     returning id`,
    [room, kind, missing ?? null, expectedSeq ?? null, firstSeq ?? null, generation ?? null]
  );
  return rows[0]?.id ?? null;
}

/** Note how much of a hole a re-export got back. */
export async function markGapRecovered(id, recovered) {
  if (id == null) return;
  await getPool().query(`update gaps set recovered = recovered + $2 where id = $1`, [id, recovered]);
}

/** The highest source_seq held for a room, so a restart resumes where it stopped. */
export async function lastSeqFor(room) {
  const { rows } = await getPool().query(
    `select max(source_seq) as seq from records where room = $1`,
    [room]
  );
  const seq = rows[0]?.seq;
  return seq == null ? 0 : Number(seq);
}

export async function archiveStats() {
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
