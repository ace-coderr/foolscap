// npm test — vitest
//
// What survives of the Notary suite after the pivot from watching to
// witnessing. The mirror's gatekeeping was most of this file — verifyBatch,
// MIRROR_ROOMS, ring-start classification, sighting reduction, loss accounting
// — and it went with the worker those things belonged to.
//
// What is left is what is still true of a service that only ever sees what it
// is handed: the schema can describe itself, and a day is not anchored until
// UTC has left it.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseTableNames } from '../services/notary/src/db';

describe('the schema describes itself', () => {
  test('every declared table is found, however it is declared', () => {
    assert.deepEqual(
      parseTableNames(`
        create table records (id bigserial);
        create table if not exists anchors (day date);
        CREATE TABLE IF NOT EXISTS  Gaps (id bigserial);
        create   table
          cursors (room text);
      `),
      ['anchors', 'cursors', 'gaps', 'records']
    );
  });

  test('prose about tables is not a table', () => {
    // Every line here is the kind of sentence schema.sql actually contains.
    assert.deepEqual(
      parseTableNames(`
        -- An archive that quietly has holes is worse than no archive.
        -- This used to create table lies out of a comment, which is the point.
        -- create table ghost (id int);
        create table real_one (id int);
      `),
      ['real_one']
    );
  });

  test('indexes, alters and constraints are not tables', () => {
    assert.deepEqual(
      parseTableNames(`
        create table only_one (id int);
        create unique index if not exists only_one_key on only_one (id);
        create index if not exists only_one_idx on only_one (id);
        alter table only_one add column if not exists extra text;
        alter table only_one add constraint only_one_check check (id > 0);
      `),
      ['only_one']
    );
  });

  test('the real schema declares exactly the two tables the service needs', () => {
    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'services', 'notary', 'db', 'schema.sql'),
      'utf8'
    );
    // EXACTLY, not at least. This was `for (const table of [...]) includes`,
    // which asserts the schema has not lost a table and says nothing about it
    // gaining one — and the pivot's whole risk is the opposite direction: a
    // crawl-era table left declared would have assertSchema demanding it on
    // every boot of a database that should never have had it.
    assert.deepEqual(parseTableNames(sql), ['anchors', 'records']);
  });
});

// ---------------------------------------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'services', 'notary');
const readSrc = (...parts) => readFileSync(join(SRC, ...parts), 'utf8');

/**
 * A day is anchored once, when it is over.
 *
 * Three code paths choose days to anchor: the default (yesterday), the hourly
 * sweep, and `--all`. Two of them waited for UTC to leave the day and `--all`
 * did not, so running it at 23:12 UTC built a root over 614,510 records of a
 * day that reached 885,187 by midnight. Published, that root would have been
 * frozen by upsertAnchor's own protection — a permanent commitment to a partial
 * day, defended by the mechanism meant to defend the day.
 *
 * Asserted against the source rather than a database because there is nothing
 * to query: the bug is a missing WHERE clause, and a fixture that reproduced it
 * would need the real table and a clock held at the wrong hour.
 */
describe('only a closed day is anchored', () => {
  const CLOSED = "r.day < (now() at time zone 'utc')::date";

  test('the day-selecting query waits for UTC to leave the day', () => {
    const src = readSrc('src', 'anchor.ts');
    const start = src.indexOf('export async function daysNeedingPublication(');
    assert.ok(start > -1, 'daysNeedingPublication should exist');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.ok(body.includes(CLOSED), 'it would anchor the day still being captured');
  });

  test('there is only one definition of a day that needs anchoring', () => {
    // There were two, and `--all` used the other one — "a day with no stored
    // root at all". So `--all` could not touch a day holding a root that had
    // never been published, which is precisely a day that needs anchoring: an
    // unpublished root constrains nothing. 2026-09-14 sat on one, built while
    // the day was still open and already wrong, and `--all` looked straight at
    // it and reported that every day already had a root.
    const src = readSrc('src', 'anchor.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!code.includes('unanchoredDays'), 'the second definition should stay gone');
    const main = code.slice(code.indexOf('async function main('));
    const all = main.indexOf("includes('--all')");
    assert.ok(all > -1, '--all should still be a flag');
    assert.ok(
      main.slice(all, all + 200).includes('daysNeedingPublication()'),
      '--all must select days the same way the hourly sweep does'
    );
  });
});

/**
 * Notary keeps a record of its own holes, including the one in its anchor log.
 *
 * 2026-09-12's anchor row was overwritten by a rebuild after publication. root
 * and record_count were restored from the published message; first_capture and
 * last_capture could not be, because that message had rotated out of the room
 * before the overwrite was noticed. The columns still hold the REBUILD's
 * window, so the reader has to be told not to believe them.
 *
 * If this flag ever stops being set, the page quietly starts reporting a
 * fifteen-minute capture window for a day that ran for hours, and reports it
 * with the same confidence as a real one. That is the failure worth a test.
 */
