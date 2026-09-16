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

export interface StoredRecord {
  id: string;
  did: string;
  room: string;
  capturedAt: Date;
}

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
    // No `source` column any more: everything is submitted, and a column that
    // can only hold one value is a column pretending to be a choice. The
    // conflict target is the plain unique index now that there are no partial
    // sighting rows for it to have to step around.
    `insert into records (did, room, nonce, sig, text, captured_at, day)
     values ($1, $2, $3::numeric, $4, $5, now(), (now() at time zone 'utc')::date)
     on conflict (did, room, nonce) do nothing
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
      where did = $1 and room = $2 and nonce = $3::numeric`,
    params.slice(0, 3)
  );
  const row = existing.rows[0];
  if (!row) {
    // The insert hit a conflict and the row is not there to read back, which
    // should be impossible on a single unique index. Better to fail loudly
    // than to invent an id and hand it back as if something were stored.
    throw new Error('capture conflicted but the original could not be read back');
  }
  return { id: row.id, capturedAt: row.captured_at.toISOString(), day: row.day, created: false };
}

/** Write a day's Merkle root. Re-running a day overwrites its row. */
/**
 * Store a day's root.
 *
 * A PUBLISHED ROOT IS NEVER OVERWRITTEN. It used to be, unconditionally, while
 * published_at and published_seq stayed put — so rebuilding an already-anchored
 * day left the table holding a root that disagreed with the message in the
 * room, silently, which is precisely the failure the whole anchor mechanism
 * exists to make impossible. It happened here: a day was rebuilt after its
 * contents had grown and been pruned, and the stored root moved while the
 * published one could not.
 *
 * Returns what is stored afterwards, so the caller can say out loud when a
 * recomputation disagrees with a commitment. That disagreement is information,
 * not an error — it means the day's records are no longer the set that was
 * committed to — and the one thing that must not happen is for it to pass
 * unremarked.
 */
export async function upsertAnchor(anchor: {
  day: string;
  root: string | null;
  recordCount: number;
  firstCapture: string | null;
  lastCapture: string | null;
}): Promise<{ storedRoot: string | null; wasPublished: boolean }> {
  const { rows } = await getPool().query(
    `insert into anchors (day, root, record_count, first_capture, last_capture)
     values ($1::date, $2, $3, $4::timestamptz, $5::timestamptz)
     on conflict (day) do update set
       root = case when anchors.published_at is null
                   then excluded.root else anchors.root end,
       record_count = case when anchors.published_at is null
                   then excluded.record_count else anchors.record_count end,
       first_capture = case when anchors.published_at is null
                   then excluded.first_capture else anchors.first_capture end,
       last_capture = case when anchors.published_at is null
                   then excluded.last_capture else anchors.last_capture end
     returning root, (published_at is not null) as was_published`,
    [anchor.day, anchor.root, anchor.recordCount, anchor.firstCapture, anchor.lastCapture]
  );
  return {
    storedRoot: rows[0]?.root ?? null,
    wasPublished: rows[0]?.was_published === true,
  };
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
