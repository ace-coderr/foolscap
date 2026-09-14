// migrate.ts — apply db/schema.sql. Safe to run repeatedly.
//
// IT REPORTS WHAT IT DID, not what it was once written to expect. The line here
// used to be the string "Schema applied: records, anchors, gaps." — a literal,
// which stayed literally true of a three-table schema long after the schema had
// four. A run that had correctly created `cursors` printed three names and left
// it looking as though it had not, which is the worst kind of wrong for a
// migration to be: it succeeded and said otherwise.
//
// So the tables come from the schema file, the statuses come from comparing the
// database before and after, and neither is written down anywhere a change
// could fail to reach.

import {
  migrate,
  assertSchema,
  schemaTables,
  publicTables,
  closePool,
  getPool,
} from './db.ts';

try {
  const declared = await schemaTables();
  const before = await publicTables();

  await migrate();
  await assertSchema();

  const after = await publicTables();

  // Row counts alongside, because the other thing worth knowing when you have
  // just migrated something is whether it was the database you meant. An empty
  // `records` on a run you expected to be production is a louder signal than
  // any success message.
  const counts = new Map<string, string>();
  for (const table of declared) {
    try {
      const { rows } = await getPool().query(`select count(*)::text as n from ${table}`);
      counts.set(table, rows[0]?.n ?? '?');
    } catch {
      counts.set(table, '?');
    }
  }

  const width = Math.max(...declared.map((t) => t.length));
  console.log(`Schema applied — ${declared.length} table(s):`);
  for (const table of declared) {
    const status = before.has(table) ? 'already present' : 'CREATED';
    const rows = Number(counts.get(table) ?? 0).toLocaleString('en');
    console.log(`  ${table.padEnd(width)}  ${status.padEnd(14)}  ${rows} row(s)`);
  }

  // Anything in the database the schema does not declare. Not an error — a
  // hand-made table is allowed to exist — but it should be said out loud rather
  // than left for someone to find.
  const undeclared = [...after].filter((t) => !declared.includes(t)).sort();
  if (undeclared.length) {
    console.log(`Also present, not declared by schema.sql: ${undeclared.join(', ')}.`);
  }
} catch (err) {
  console.error(`Migration failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
