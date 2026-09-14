// retain.ts — the retention window.
//
//   npm run retain --workspace services/notary              dry run
//   npm run retain --workspace services/notary -- --apply   delete
//
// Full records are kept for NOTARY_RETAIN_HOURS (12). Past that they are
// deleted, and what remains for the period is the summary tier — one row per
// (did, room), for ever — plus the single earliest record of each pair, pinned
// back from the delete.
//
// WHY THERE IS A WINDOW AT ALL. The archive takes about 840 MB a day and the
// database it lives in holds 500. That is not a tuning problem; it is the rate
// against the tier. A window is the honest answer: say what is kept in full,
// say what survives past it, and say on the page which of the two a given
// answer came from.
//
// ---------------------------------------------------------------------------
// THE ANCHOR RULE, and it outranks the window.
//
// Records are committed to by a daily Merkle root published into a public room.
// Deleting a record before its day's root is built and PUBLISHED would destroy
// the only thing that makes the archive tamper-evident for that day: the root
// could never be reproduced, and Notary would be asking to be taken at its word
// for a period it had promised not to.
//
// So a record is deletable only when BOTH hold:
//
//   captured_at < now() - retention window
//   its day has an anchors row with published_at set
//
// The second is the binding one at twelve hours, because anchors are daily: a
// record captured this morning is inside today's open day, which cannot be
// anchored until the day closes. The effective window is therefore "twelve
// hours, or until your day is anchored, whichever is longer" — in practice one
// to two days. Shortening it means anchoring more often, not pruning harder.
// The run says which constraint bound it rather than leaving it to be inferred.

import { getPool, closePool, assertSchema } from './db.ts';
import { merkleRoot } from './merkle.ts';
import { createHash } from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const BACKFILL = process.argv.includes('--backfill');
const RETAIN_HOURS = Number(process.env.NOTARY_RETAIN_HOURS ?? 12);

/**
 * Pinned rows are never deleted, whatever the window says.
 *
 * NOTARY.md: "Store originals, not assertions… never store a verified: true
 * flag as the only evidence." A summary row is that flag with timestamps on it.
 * The cutoff question — was this key active before X — is answered by the FIRST
 * sighting, so keeping that one original keeps the answer re-verifiable by a
 * stranger, and keeps the record inside a published root where its proof still
 * folds. Turn it off and every pruned period becomes Notary's word.
 */
const PIN = process.env.NOTARY_PIN_EARLIEST !== '0';

const n = (v: unknown) => Number(v ?? 0).toLocaleString('en');

/** One leaf per summary row, over the fields the tier actually promises. */
function summaryLeaf(row: {
  did: string;
  room: string;
  first_captured_at: Date;
  first_source_ts: Date | null;
  last_captured_at: Date;
  last_source_ts: Date | null;
  message_count: string;
}): string {
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : '');
  return createHash('sha256')
    .update(
      [
        row.did,
        row.room,
        iso(row.first_captured_at),
        iso(row.first_source_ts),
        iso(row.last_captured_at),
        iso(row.last_source_ts),
        String(row.message_count),
      ].join('|'),
      'utf8'
    )
    .digest('hex');
}

/**
 * Build the tier from the records already held. Once, for an archive older than
 * the tier.
 *
 * The live path writes a summary on every capture, so from here on the tier is
 * always current and the retention run only has to check it. Everything
 * captured BEFORE the tier existed has no row, and the retention run refuses to
 * delete a record with nothing standing in for it — correctly, but that means
 * it can never touch the backlog until this has run.
 *
 * It SETS rather than adds, because it recomputes from the records themselves.
 * Run it with the mirror stopped for an exact message_count; run it live and a
 * capture landing mid-statement may be counted twice or not at all. That figure
 * is descriptive rather than evidential — the timestamps and the pinned record
 * are what answers are built on — so the trade is stated rather than guarded.
 */
async function backfill(): Promise<void> {
  const pool = getPool();
  console.log('Building the summary tier from existing records...');
  console.time('backfill');
  const { rowCount } = await pool.query(
    `with firsts as (
       select distinct on (did, room) did, room, id
         from records order by did, room, captured_at, id)
     insert into summaries (did, room, first_captured_at, first_source_ts,
                            last_captured_at, last_source_ts, message_count, pinned_record_id)
     select r.did, r.room,
            min(r.captured_at), min(r.source_ts),
            max(r.captured_at), max(r.source_ts),
            count(*), f.id
       from records r join firsts f on f.did = r.did and f.room = r.room
      group by r.did, r.room, f.id
     on conflict (did, room) do update set
       first_captured_at = least(summaries.first_captured_at, excluded.first_captured_at),
       first_source_ts   = least(summaries.first_source_ts, excluded.first_source_ts),
       last_captured_at  = greatest(summaries.last_captured_at, excluded.last_captured_at),
       last_source_ts    = greatest(summaries.last_source_ts, excluded.last_source_ts),
       message_count     = greatest(summaries.message_count, excluded.message_count),
       pinned_record_id  = case
         when excluded.first_captured_at <= summaries.first_captured_at
           then excluded.pinned_record_id else summaries.pinned_record_id end,
       last_updated      = now()`
  );
  console.timeEnd('backfill');
  console.log(`${n(rowCount)} summary rows written.
`);
}

async function main(): Promise<void> {
  await assertSchema();
  const pool = getPool();

  if (BACKFILL) await backfill();

  const { rows: cut } = await pool.query(
    `select (now() - ($1 || ' hours')::interval) as cutoff`,
    [RETAIN_HOURS]
  );
  const cutoff: Date = cut[0].cutoff;

  console.log(`Retention window: ${RETAIN_HOURS}h — full records before ${cutoff.toISOString()}`);
  console.log(`Pinning the earliest record per (did, room): ${PIN ? 'ON' : 'OFF'}`);

  // Which days are safe to touch, and which are held back by the anchor rule.
  const { rows: days } = await pool.query(
    `select r.day::text as day,
            count(*)::int as records,
            (a.published_at is not null) as anchored,
            a.root
       from records r
       left join anchors a on a.day = r.day
      where r.captured_at < $1
      group by r.day, a.published_at, a.root
      order by r.day`,
    [cutoff]
  );

  if (days.length === 0) {
    console.log('\nNothing is older than the window. Done.');
    return;
  }

  console.log('\nDays with records past the window:');
  for (const d of days) {
    const state = d.anchored ? 'anchored' : 'NOT ANCHORED — held back';
    console.log(`  ${d.day}  ${n(d.records).padStart(10)} records  ${state}`);
  }

  const safe = days.filter((d) => d.anchored).map((d) => d.day);
  const held = days.filter((d) => !d.anchored);
  if (held.length) {
    console.log(
      `\n${held.length} day(s) are past the window but unanchored, so their records stay. ` +
        `Run "npm run anchor" first; a record deleted before its root is published is a day ` +
        `nobody can check afterwards.`
    );
  }
  if (safe.length === 0) {
    console.log('\nNo day is both past the window and anchored. Nothing to do.');
    return;
  }

  // The summary tier is written on capture, so this is a check rather than a
  // build: every pair about to lose records must already be represented.
  const { rows: cover } = await pool.query(
    `select count(*)::int as missing
       from (select distinct did, room from records
              where day = any($1::date[]) and captured_at < $2) r
      where not exists (select 1 from summaries s where s.did = r.did and s.room = r.room)`,
    [safe, cutoff]
  );
  if (cover[0].missing > 0) {
    console.log(
      `\n${n(cover[0].missing)} (did, room) pair(s) have records to prune and no summary row. ` +
        `Refusing: that is evidence with nothing standing in for it.`
    );
    process.exitCode = 1;
    return;
  }
  console.log('\nEvery pair due for pruning has a summary row.');

  const { rows: doomed } = await pool.query(
    `select count(*)::int as c from records r
      where r.day = any($1::date[]) and r.captured_at < $2
        and ($3::bool = false
             or not exists (select 1 from summaries s where s.pinned_record_id = r.id))`,
    [safe, cutoff, PIN]
  );
  const { rows: pinned } = await pool.query(
    `select count(*)::int as c from summaries s
      join records r on r.id = s.pinned_record_id
     where r.day = any($1::date[]) and r.captured_at < $2`,
    [safe, cutoff]
  );

  console.log(`\n  ${n(doomed[0].c)} records would be deleted`);
  console.log(`  ${n(pinned[0].c)} pinned originals would be kept`);

  if (!APPLY) {
    console.log('\nDry run. Nothing was deleted. Re-run with --apply.\n');
    return;
  }

  let removed = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `delete from records where id in (
         select r.id from records r
          where r.day = any($1::date[]) and r.captured_at < $2
            and ($3::bool = false
                 or not exists (select 1 from summaries s where s.pinned_record_id = r.id))
          limit 20000)`,
      [safe, cutoff, PIN]
    );
    if (!rowCount) break;
    removed += rowCount;
    process.stdout.write(`  ${n(removed)} deleted\r`);
  }
  console.log(`  ${n(removed)} records deleted.      `);

  // A root over the tier as it now stands. The daily record roots stay
  // published and stay true; what they can no longer do is produce an inclusion
  // proof for a record nobody holds. The tier needs a commitment of its own or
  // it is the one part of the archive with nothing to check it against.
  const { rows: sums } = await pool.query(
    `select did, room, first_captured_at, first_source_ts,
            last_captured_at, last_source_ts, message_count
       from summaries order by did, room`
  );
  const root = merkleRoot(sums.map(summaryLeaf));
  if (root == null) {
    console.log('No summary rows, so no root to build.');
    return;
  }
  const { rows: anchored } = await pool.query(
    `insert into summary_anchors (row_count, root) values ($1, $2) returning id`,
    [sums.length, root]
  );
  console.log(`\nSummary root over ${n(sums.length)} rows: ${root}`);
  console.log(`Recorded as summary_anchors id ${anchored[0].id}.`);
  console.log('Publish it with "npm run anchor" — until it is published it constrains nothing.');
}

try {
  await main();
} catch (err) {
  console.error(`Retention run failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
