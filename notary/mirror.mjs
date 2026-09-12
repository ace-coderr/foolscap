// mirror.mjs — the Notary mirror worker.
//
// Follows the busy public rooms and stores every validly signed message before
// the rings drop it. This is where the archive comes from, and it accrues
// whether or not anything else is built, so it runs first.
//
// It reuses js/technocore.js for reading — export backfill, long-poll follow,
// cursor advance, ring-gap detection, read-budget pacing — and js/did.js for
// verification. There is deliberately no second Technocore client: a divergence
// between how the archive reads a room and how the site reads it would be a
// source of exactly the silent inconsistency this product cannot afford.
//
//   node notary/mirror.mjs
//
// Stop it with Ctrl-C; it drains what it has verified and closes cleanly.

import { pathToFileURL } from 'node:url';
import { RoomWatcher, exportRoom } from '../js/technocore.js';
import { verifyMessage, validateNonce, looksLikeDid } from '../js/did.js';
import { WATCHED_ROOMS as SONNET_ROOMS } from '../js/contest.js';
import {
  assertSchema,
  insertRecords,
  insertGap,
  markGapRecovered,
  closePool,
  archiveStats,
  lastSeqFor,
} from './db.mjs';

/**
 * The busy public rooms, plus the sonnet-2 rooms. Ordered so the fastest-
 * rotating rooms are backfilled first: lobby drops messages within hours, and
 * whatever is lost during startup is lost permanently.
 */
export const MIRROR_ROOMS = [
  'lobby',
  'meta',
  'technocore',
  'flop-network',
  'ashflop',
  'kibble',
  'tclk-offers',
  ...SONNET_ROOMS,
];

/**
 * NOTARY_DRY_RUN=1 reads and verifies but writes nothing and needs no database.
 * Useful for watching the pipeline work while the Supabase database is still being
 * created — and for confirming a room is worth mirroring before it is added.
 */
const DRY_RUN = process.env.NOTARY_DRY_RUN === '1';

/** Only this many rooms in a dry run, so it finishes quickly. */
const DRY_RUN_ROOMS = Number(process.env.NOTARY_DRY_RUN_ROOMS ?? 2);

/** Messages verified per batch. Each batch is one round of parallel verifies. */
const VERIFY_BATCH = 250;
/** Rows per INSERT. 8 columns, so this stays far inside the parameter limit. */
const INSERT_BATCH = 500;
const STATS_EVERY_MS = 30_000;

/** The most the read endpoint will return per poll. Its default is 50. */
const POLL_LIMIT = 200;

/**
 * How often to re-export rooms that reported a missed gap.
 *
 * A poll returns at most POLL_LIMIT messages and returns the NEWEST ones after
 * the cursor, so a room busier than that per poll is skipped past rather than
 * followed. Logging that would be honest but useless: /export still holds the
 * skipped messages until the ring drops them, so the fix is to go back and get
 * them. Only rooms that actually reported a gap are swept, which keeps quiet
 * rooms free and spends the bandwidth where the archive is genuinely losing.
 */
const SWEEP_MS = Number(process.env.NOTARY_SWEEP_MS ?? 120_000);

const stats = {
  seen: 0,
  captured: 0,
  duplicate: 0,
  unsigned: 0,
  badSignature: 0,
  badNonce: 0,
  gapsMissed: 0,
  recovered: 0,
  lost: 0,
  errors: 0,
  startedAt: Date.now(),
};

const log = (...parts) => console.log(`[${new Date().toISOString()}]`, ...parts);

/**
 * Open holes, by room: { id, from, to } sequence ranges that polling skipped.
 *
 * These sit BELOW the newest sequence already absorbed, which is what makes a
 * naive "anything newer than the high-water mark" sweep useless — the skipped
 * messages are older than what arrived after them.
 */
const holes = new Map();

const addHole = (room, hole) => {
  if (!holes.has(room)) holes.set(room, []);
  holes.get(room).push(hole);
};

// ---------------------------------------------------------------------------
// Verify, then store
// ---------------------------------------------------------------------------

/**
 * Keep only what a stranger could re-verify.
 *
 * Unsigned chatter is skipped, and so is anything whose signature does not check
 * out against its own sender — storing either would put records in the archive
 * that prove nothing, which is worse than not having them.
 */
export async function verifyBatch(messages, room) {
  const checked = await Promise.all(
    messages.map(async (message) => {
      stats.seen++;

      if (!message.sig || !looksLikeDid(message.from)) {
        stats.unsigned++;
        return null;
      }
      if (!validateNonce(message.nonce).ok) {
        // The server will not accept these, so seeing one means something odd.
        stats.badNonce++;
        return null;
      }

      const { verified } = await verifyMessage(message, { room });
      if (!verified) {
        stats.badSignature++;
        return null;
      }

      return {
        did: message.from,
        room,
        // String all the way to Postgres.
        nonce: String(message.nonce),
        sig: message.sig,
        // Never normalised, never trimmed: the bytes are what the signature covers.
        text: message.text,
        source: 'mirrored',
        sourceTs: message.ts ?? null,
        sourceSeq: Number.isFinite(message.seq) ? message.seq : null,
      };
    })
  );

  return checked.filter(Boolean);
}

async function store(records) {
  if (DRY_RUN) {
    stats.captured += records.length;
    return;
  }
  for (let i = 0; i < records.length; i += INSERT_BATCH) {
    const slice = records.slice(i, i + INSERT_BATCH);
    const inserted = await insertRecords(slice);
    stats.captured += inserted;
    stats.duplicate += slice.length - inserted;
  }
}

/** Verify and store a run of messages, in batches, without holding it all at once. */
async function absorb(messages, room) {
  for (let i = 0; i < messages.length; i += VERIFY_BATCH) {
    const batch = messages.slice(i, i + VERIFY_BATCH);
    await store(await verifyBatch(batch, room));
  }
}

// ---------------------------------------------------------------------------
// Holes
// ---------------------------------------------------------------------------

async function recordGap(room, gap) {
  const detail = {
    room,
    kind: gap.kind,
    missing: gap.missing ?? null,
    expectedSeq: gap.expected ?? null,
    firstSeq: gap.firstSeq ?? null,
    generation: gap.generation ?? null,
  };

  let id = null;
  try {
    if (!DRY_RUN) id = await insertGap(detail);
  } catch (err) {
    stats.errors++;
    log(`[${room}] could not record a ${gap.kind} gap: ${err.message}`);
  }

  if (gap.kind === 'missed') {
    stats.gapsMissed++;
    if (Number.isFinite(gap.expected) && Number.isFinite(gap.firstSeq)) {
      addHole(room, { id, from: gap.expected, to: gap.firstSeq - 1 });
    }
    // Loud on purpose. The archive is now missing these and always will be.
    log(
      `[${room}] GAP — ${gap.missing} message(s) rotated past before Notary read them ` +
        `(expected seq ${gap.expected}, reply starts at ${gap.firstSeq}). Recorded; queued for re-export.`
    );
  } else if (gap.kind === 'regenerated') {
    log(`[${room}] room was recreated (generation ${gap.generation}); restarting from the new ring.`);
  } else {
    log(`[${room}] coverage starts at seq ${gap.firstSeq}; earlier history had already rotated out.`);
  }
}

// ---------------------------------------------------------------------------
// Backfill, then follow
// ---------------------------------------------------------------------------

/**
 * Take everything the ring still holds, one room at a time.
 *
 * Sequential rather than parallel: it bounds memory to a single room's export
 * and keeps the read budget from being spent all at once.
 */
async function backfill(room) {
  const resumeFrom = DRY_RUN ? 0 : await lastSeqFor(room);
  const dump = await exportRoom(room);

  if (dump.messages.length === 0) {
    log(`[${room}] empty ring.`);
    return { lastSeq: resumeFrom, generation: dump.generation };
  }

  if (dump.firstSeq > 1) {
    await recordGap(room, { kind: 'rotated', firstSeq: dump.firstSeq, missing: null });
  }

  const fresh = dump.messages.filter((m) => m.seq > resumeFrom);
  log(
    `[${room}] ring holds ${dump.messages.length} (seq ${dump.firstSeq}–${dump.lastSeq}); ` +
      `${fresh.length} newer than what is already stored.`
  );

  await absorb(fresh, room);

  if (dump.malformed.length) {
    log(`[${room}] ${dump.malformed.length} record(s) in the export could not be parsed.`);
  }
  return { lastSeq: dump.lastSeq, generation: dump.generation };
}

function follow(room, since) {
  const watcher = new RoomWatcher(room, {
    since,
    backfill: false,
    wait: 10,
    limit: POLL_LIMIT,
    onMessages: async ({ messages }) => {
      try {
        await absorb(messages, room);
      } catch (err) {
        stats.errors++;
        log(`[${room}] write failed: ${err.message}`);
      }
    },
    onGap: (gap) => {
      recordGap(room, gap).catch(() => {});
    },
    onError: (err) => {
      stats.errors++;
      log(`[${room}] ${err.message}`);
    },
    onBudget: (budget) => {
      if (budget?.low) log(`[${room}] read budget low (${budget.remaining}); backing off.`);
    },
  });
  watcher.start();
  return watcher;
}

// ---------------------------------------------------------------------------
// Sweeping back over what polling skipped
// ---------------------------------------------------------------------------

/**
 * Go back for what polling skipped.
 *
 * For each open hole, re-export the room and absorb the messages whose sequence
 * falls inside it. Duplicates cost nothing — (did, room, nonce) is unique — so
 * the only question is whether the ring still holds them. If it has rotated past
 * the hole, those messages are gone for good and the gap row keeps the count.
 */
async function sweep() {
  for (const [room, roomHoles] of holes) {
    if (roomHoles.length === 0) continue;

    let dump;
    try {
      dump = await exportRoom(room);
    } catch (err) {
      stats.errors++;
      log(`[${room}] sweep failed: ${err.message}`);
      continue;
    }

    const remaining = [];
    for (const hole of roomHoles) {
      const inHole = dump.messages.filter((m) => m.seq >= hole.from && m.seq <= hole.to);
      if (inHole.length) {
        await absorb(inHole, room);
        stats.recovered += inHole.length;
        if (!DRY_RUN) await markGapRecovered(hole.id, inHole.length).catch(() => {});
      }

      const wanted = hole.to - hole.from + 1;
      if (inHole.length >= wanted) {
        log(`[${room}] sweep recovered all ${wanted} skipped message(s) (seq ${hole.from}-${hole.to}).`);
        continue;
      }

      // Anything below the ring's current start is unrecoverable, now and ever.
      if (dump.firstSeq != null && dump.firstSeq > hole.to) {
        stats.lost += wanted - inHole.length;
        log(
          `[${room}] LOST — ${wanted - inHole.length} message(s) in seq ${hole.from}-${hole.to} ` +
            `rotated out before Notary could go back for them. The archive is short that many.`
        );
        continue;
      }

      log(
        `[${room}] sweep recovered ${inHole.length} of ${wanted} (seq ${hole.from}-${hole.to}); ` +
          'retrying on the next sweep.'
      );
      remaining.push({ ...hole, from: Math.max(hole.from, dump.firstSeq ?? hole.from) });
    }
    holes.set(room, remaining);
  }
}

// ---------------------------------------------------------------------------

function report() {
  const mins = (Date.now() - stats.startedAt) / 60_000;
  log(
    `captured ${stats.captured.toLocaleString('en')} | dup ${stats.duplicate.toLocaleString('en')} | ` +
      `seen ${stats.seen.toLocaleString('en')} | unsigned ${stats.unsigned} | ` +
      `bad sig ${stats.badSignature} | bad nonce ${stats.badNonce} | ` +
      `missed gaps ${stats.gapsMissed} | recovered ${stats.recovered.toLocaleString('en')} | ` +
      `lost ${stats.lost} | errors ${stats.errors} | ` +
      `${(stats.captured / Math.max(mins, 1 / 60)).toFixed(0)}/min`
  );
}

async function main() {
  log(`Notary mirror starting${DRY_RUN ? ' — DRY RUN, nothing will be written' : ''}.`);

  if (!DRY_RUN) {
    await assertSchema();
    const before = await archiveStats();
    log(
      `archive holds ${Number(before.records).toLocaleString('en')} records across ` +
        `${Number(before.dids).toLocaleString('en')} DIDs.`
    );
  }

  const watchers = [];
  let stopping = false;

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — stopping.`);
    watchers.forEach((w) => w.stop());
    clearInterval(ticker);
    clearInterval(sweeper);
    report();
    if (!DRY_RUN) {
      try {
        const after = await archiveStats();
        log(
          `archive now holds ${Number(after.records).toLocaleString('en')} records across ` +
            `${Number(after.dids).toLocaleString('en')} DIDs.`
        );
      } catch {
        /* closing anyway */
      }
      await closePool();
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const ticker = setInterval(report, STATS_EVERY_MS);
  ticker.unref?.();

  let sweeping = false;
  const sweeper = setInterval(async () => {
    const open = [...holes.values()].reduce((n, h) => n + h.length, 0);
    if (sweeping || stopping || open === 0) return;
    sweeping = true;
    try {
      await sweep();
    } finally {
      sweeping = false;
    }
  }, SWEEP_MS);
  sweeper.unref?.();

  // Backfill first, room by room, following each as soon as it is caught up so
  // the fast rooms are not left unwatched while the slow ones are read.
  const rooms = DRY_RUN ? MIRROR_ROOMS.slice(0, DRY_RUN_ROOMS) : MIRROR_ROOMS;
  for (const room of rooms) {
    if (stopping) return;
    try {
      const { lastSeq } = await backfill(room);
      watchers.push(follow(room, lastSeq));
      log(`[${room}] following from seq ${lastSeq}.`);
    } catch (err) {
      stats.errors++;
      log(`[${room}] backfill failed, following from the live head instead: ${err.message}`);
      try {
        watchers.push(follow(room, 0));
      } catch (inner) {
        log(`[${room}] could not follow at all: ${inner.message}`);
      }
    }
    report();
  }

  log(`following ${watchers.length} room(s). Ctrl-C to stop.`);
}

/** Counters, exported so a test can read them without touching the database. */
export const mirrorStats = stats;

// Only when run as a script, so the verification path above can be imported and
// tested without opening a connection or following a room.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(async (err) => {
    console.error(`[fatal] ${err.stack ?? err.message}`);
    await closePool().catch(() => {});
    process.exit(1);
  });
}
