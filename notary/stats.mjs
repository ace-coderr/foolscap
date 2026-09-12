// stats.mjs — where the archive stands, and how long the disk lasts.
//
//   npm run stats
//
// Everything here is measured from the database rather than estimated, except
// the runway projection, which is labelled as a projection.

import { getPool, closePool } from './db.mjs';
import { ROOM_POLICY, DEFAULT_POLICY, POLICY } from './policy.mjs';

/** Supabase free tier. Override with NOTARY_DISK_MB if the plan changes. */
const DISK_MB = Number(process.env.NOTARY_DISK_MB ?? 500);

const mb = (bytes) => Number(bytes) / 1024 / 1024;
const n = (v) => Number(v ?? 0).toLocaleString('en');

function bar(fraction, width = 28) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

try {
  const pool = getPool();

  const [totals, sizes, rooms, gaps, rate] = await Promise.all([
    pool.query(`select count(*) rows, count(distinct did) dids,
                       min(captured_at) first_capture, max(captured_at) last_capture
                  from records`),
    pool.query(`select pg_total_relation_size('records') records_bytes,
                       pg_total_relation_size('gaps')    gaps_bytes,
                       pg_database_size(current_database()) db_bytes`),
    pool.query(`select room, count(*) rows, count(distinct did) dids,
                       sum(pg_column_size(records.*)) bytes
                  from records group by room order by bytes desc nulls last`),
    pool.query(`select kind, count(*) events, coalesce(sum(missing), 0) missing,
                       coalesce(sum(recovered), 0) recovered
                  from gaps group by kind order by kind`),
    pool.query(`select count(*) rows from records where captured_at > now() - interval '10 minutes'`),
  ]);

  const t = totals.rows[0];
  const s = sizes.rows[0];
  const dbMb = mb(s.db_bytes);
  const recordsMb = mb(s.records_bytes);

  console.log('\nARCHIVE');
  console.log(`  rows            ${n(t.rows)}`);
  console.log(`  distinct DIDs   ${n(t.dids)}`);
  if (t.first_capture) {
    console.log(`  capturing since ${new Date(t.first_capture).toISOString()}`);
    console.log(`  last capture    ${new Date(t.last_capture).toISOString()}`);
  }

  console.log('\nSIZE');
  console.log(`  records table   ${recordsMb.toFixed(1)} MB  (including indexes)`);
  console.log(`  whole database  ${dbMb.toFixed(1)} MB of ${DISK_MB} MB  ${bar(dbMb / DISK_MB)}  ${((dbMb / DISK_MB) * 100).toFixed(1)}%`);
  if (Number(t.rows) > 0) {
    console.log(`  per row         ${(recordsMb * 1024 * 1024 / Number(t.rows)).toFixed(0)} bytes on disk`);
  }

  console.log('\nBY ROOM');
  console.log(`  ${'room'.padEnd(28)}${'policy'.padEnd(16)}${'rows'.padStart(10)}${'DIDs'.padStart(9)}${'MB'.padStart(8)}`);
  for (const r of rooms.rows) {
    const policy = ROOM_POLICY[r.room] ?? DEFAULT_POLICY;
    console.log(
      `  ${r.room.padEnd(28)}${policy.padEnd(16)}${n(r.rows).padStart(10)}${n(r.dids).padStart(9)}${mb(r.bytes).toFixed(1).padStart(8)}`
    );
  }

  // Rooms configured but not yet seen.
  const seen = new Set(rooms.rows.map((r) => r.room));
  const unseen = Object.keys(ROOM_POLICY).filter((r) => !seen.has(r));
  if (unseen.length) console.log(`  (not yet captured: ${unseen.join(', ')})`);

  if (gaps.rows.length) {
    console.log('\nHOLES');
    for (const g of gaps.rows) {
      const lost = Number(g.missing) - Number(g.recovered);
      const tail =
        g.kind === 'missed'
          ? `  ${n(g.missing)} skipped, ${n(g.recovered)} recovered, ${n(lost)} lost for good`
          : '';
      console.log(`  ${String(g.kind).padEnd(14)}${n(g.events).padStart(6)} event(s)${tail}`);
    }
  }

  const perMin = Number(rate.rows[0].rows) / 10;
  console.log('\nRUNWAY (projection, at the rate of the last 10 minutes)');
  if (perMin <= 0 || Number(t.rows) === 0) {
    console.log('  nothing captured recently — is the mirror running?');
  } else {
    const bytesPerRow = (recordsMb * 1024 * 1024) / Number(t.rows);
    const mbPerDay = (perMin * 60 * 24 * bytesPerRow) / 1024 / 1024;
    const daysLeft = (DISK_MB - dbMb) / Math.max(mbPerDay, 0.0001);
    console.log(`  ${perMin.toFixed(0)} rows/min  ≈  ${mbPerDay.toFixed(0)} MB/day`);
    const hoursLeft = daysLeft * 24;
    console.log(
      daysLeft > 365
        ? `  over a year of headroom at this rate.`
        : hoursLeft < 48
          ? `  FULL IN ${hoursLeft < 1 ? `${Math.max(0, Math.round(hoursLeft * 60))} MINUTES` : `${hoursLeft.toFixed(1)} HOURS`} at this rate — capture stops when it fills.`
          : `  ${daysLeft.toFixed(1)} days until ${DISK_MB} MB is full.`
    );
  }

  console.log(`\nPolicies: ${Object.values(POLICY).join(', ')}. See notary/policy.mjs.\n`);
} catch (err) {
  console.error(`stats failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
