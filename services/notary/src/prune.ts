// prune.ts — bring already-captured rows into line with the capture policy.
//
//   npm run prune           what it would do, and nothing else
//   npm run prune --workspace services/notary -- --apply   actually delete
//
// Only rooms under the 'sightings' policy are touched, and within those only the
// messages between a DID's first and last sighting on a given day. The first and
// the last are kept, so every DID keeps a verifiable record of having been
// active that day — which is the only claim Notary makes about a sampled room.
//
// Dry run by default. Deleting captured evidence is a decision, not a detail.

import { getPool, closePool } from './db.ts';
import { ROOM_POLICY, POLICY } from './policy.ts';

const APPLY = process.argv.includes('--apply');
const n = (v: unknown): string => Number(v ?? 0).toLocaleString('en');

const SAMPLED = Object.entries(ROOM_POLICY)
  .filter(([, policy]) => policy === POLICY.SIGHTINGS)
  .map(([room]) => room);

/**
 * Within each (room, did, day-of-activity), rank by the room's own sequence and
 * keep the extremes. day-of-activity comes from source_ts where the room gave us
 * one, so a backfill that read several days at once still leaves a sighting per
 * day rather than one for the whole read.
 */
const SELECT_DOOMED = `
  with ranked as (
    select id,
           row_number() over w  as asc_rank,
           row_number() over (partition by room, did,
                                           coalesce(source_ts::date, day)
                              order by source_seq desc nulls last) as desc_rank
      from records
     where room = any($1)
       and sighting is null
    window w as (partition by room, did, coalesce(source_ts::date, day)
                 order by source_seq asc nulls last)
  )
  select id from ranked where asc_rank > 1 and desc_rank > 1
`;

try {
  const pool = getPool();

  const before = await pool.query(
    `select count(*) rows, pg_total_relation_size('records') bytes from records`
  );
  const doomed = await pool.query(
    `select count(*) c from (${SELECT_DOOMED}) d`,
    [SAMPLED]
  );

  const perRoom = await pool.query(
    `select room, count(*) c from records
      where id in (${SELECT_DOOMED}) group by room order by c desc`,
    [SAMPLED]
  );

  const totalRows = Number(before.rows[0].rows);
  const bytesPerRow = Number(before.rows[0].bytes) / Math.max(totalRows, 1);
  const removable = Number(doomed.rows[0].c);

  console.log(`\nSampled rooms: ${SAMPLED.join(', ')}`);
  console.log(`\n  ${'room'.padEnd(22)}${'removable rows'.padStart(16)}`);
  for (const r of perRoom.rows) {
    console.log(`  ${r.room.padEnd(22)}${n(r.c).padStart(16)}`);
  }

  console.log(`\n  archive now        ${n(totalRows)} rows`);
  console.log(`  removable          ${n(removable)} rows  (~${(removable * bytesPerRow / 1024 / 1024).toFixed(0)} MB)`);
  console.log(`  would remain       ${n(totalRows - removable)} rows`);

  if (!APPLY) {
    console.log('\nDry run. Nothing was deleted. Re-run with --apply to delete.\n');
  } else {
    console.log('\nDeleting…');
    // In chunks: one enormous DELETE would hold a long transaction and bloat
    // the table further before autovacuum could catch up.
    let removed = 0;
    for (;;) {
      const { rowCount } = await pool.query(
        `delete from records where id in (select id from (${SELECT_DOOMED}) d limit 20000)`,
        [SAMPLED]
      );
      if (!rowCount) break;
      removed += rowCount;
      process.stdout.write(`  ${n(removed)} deleted\r`);
    }
    console.log(`\n  ${n(removed)} rows deleted.`);
    console.log('  Running VACUUM to return the space to the table…');
    await pool.query('vacuum (analyze) records');
    const after = await pool.query(`select pg_total_relation_size('records') bytes from records`);
    console.log(`  records table now ${(Number(after.rows[0].bytes) / 1024 / 1024).toFixed(1)} MB\n`);
  }
} catch (err) {
  console.error(`prune failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
