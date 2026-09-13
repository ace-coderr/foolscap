// migrate.ts — apply db/schema.sql. Safe to run repeatedly.
import { migrate, assertSchema, closePool } from './db.ts';

try {
  await migrate();
  await assertSchema();
  console.log('Schema applied: records, anchors, gaps.');
} catch (err) {
  console.error(`Migration failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
