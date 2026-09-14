// mirror.ts — the Notary mirror worker.
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
//   npm run mirror --workspace services/notary
//
// Stop it with Ctrl-C; it drains what it has verified and closes cleanly.

import { pathToFileURL } from 'node:url';
import type { Message, Gap } from '../../../src/lib/technocore.ts';
import type { ArchiveRecord } from './db.ts';
import { RoomWatcher, exportRoom } from '../../../src/lib/technocore.ts';
import { verifyMessage, validateNonce, looksLikeDid } from '../../../src/lib/did.ts';
import {
  isFullRoom,
  policyFor,
  reduceToSightings,
  throttleSightings,
  pruneThrottleCache,
  WATCHED_ROOMS,
} from './policy.ts';
import {
  assertSchema,
  insertRecords,
  upsertSightings,
  insertGap,
  markGapRecovered,
  closePool,
  archiveStats,
  lastSeqFor,
  upsertSummaries,
  readCursor,
  writeCursor,
} from './db.ts';

/**
 * The rooms this worker follows, defined in policy.ts and re-exported here.
 *
 * It used to be a list of its own — the busy public rooms plus the sonnet-2
 * rooms, fastest-rotating first — and that ordering was written when the risk
 * was losing lobby's history during startup. The real risk turned out to be the
 * other end: backfill is sequential, the mirror restarts more often than it
 * finishes the list, and the sonnet-2 rooms sat last. d-sonnet-2-rules went
 * four hours without a capture while lobby was followed continuously.
 *
 * The chat rooms are gone entirely rather than sampled. They were 540,147 rows
 * and 38% of the archive; sampling them saved almost nothing, because lobby's
 * DID-days are 100% single messages and there was no second message to drop.
 * Notary's claim is now "these rooms, completely" instead of "the network,
 * partially", which is a smaller claim and a much stronger one.
 */
export const MIRROR_ROOMS = WATCHED_ROOMS;

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
  gapsDowntime: 0,
  summarised: 0,
  recovered: 0,
  lost: 0,
  sampledAway: 0,
  errors: 0,
  startedAt: Date.now(),
};

const log = (...parts: unknown[]): void => console.log(`[${new Date().toISOString()}]`, ...parts);

/** A sequence range polling stepped over, and the gap row recording it. */
interface Hole {
  id: number | null;
  from: number;
  to: number;
}

/**
 * Open holes, by room: { id, from, to } sequence ranges that polling skipped.
 *
 * These sit BELOW the newest sequence already absorbed, which is what makes a
 * naive "anything newer than the high-water mark" sweep useless — the skipped
 * messages are older than what arrived after them.
 */
const holes = new Map<string, Hole[]>();

const addHole = (room: string, hole: Hole): void => {
  const existing = holes.get(room);
  if (existing) existing.push(hole);
  else holes.set(room, [hole]);
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
export async function verifyBatch(messages: Message[], room: string): Promise<ArchiveRecord[]> {
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

      const record: ArchiveRecord = {
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
      return record;
    })
  );

  return checked.filter((record): record is ArchiveRecord => record !== null);
}

/**
 * Store a run of verified records under the room's policy.
 *
 * A sampled room reduces to first/last per DID per day before anything is
 * written. The dropped messages were verified and then deliberately not kept —
 * counted as `sampledAway`, because silently discarding evidence would be the
 * same sin as silently losing it.
 */
async function store(records: ArchiveRecord[], room: string): Promise<void> {
  if (records.length === 0) return;

  if (isFullRoom(room)) {
    if (DRY_RUN) {
      stats.captured += records.length;
      return;
    }
    for (let i = 0; i < records.length; i += INSERT_BATCH) {
      const slice = records.slice(i, i + INSERT_BATCH);
      const inserted = await insertRecords(slice);
      stats.captured += inserted.length;
      stats.duplicate += slice.length - inserted.length;

      // The permanent tier is written on every capture, from the rows that
      // actually landed. Building it at prune time instead would mean reading
      // the records it exists to replace, on the run that deletes them — and a
      // prune that failed halfway would leave a period with neither.
      stats.summarised += await upsertSummaries(inserted);
    }
    return;
  }

  const sightings = throttleSightings(reduceToSightings(records));
  stats.sampledAway += records.length - sightings.length;
  if (DRY_RUN) {
    stats.captured += sightings.length;
    return;
  }
  const written = await upsertSightings(sightings);
  stats.captured += written;
  stats.duplicate += sightings.length - written;
}

/** Verify and store a run of messages, in batches, without holding it all at once. */
async function absorb(messages: Message[], room: string): Promise<void> {
  for (let i = 0; i < messages.length; i += VERIFY_BATCH) {
    const batch = messages.slice(i, i + VERIFY_BATCH);
    await store(await verifyBatch(batch, room), room);
  }
}

// ---------------------------------------------------------------------------
// Holes
// ---------------------------------------------------------------------------

/**
 * A hole, written down.
 *
 * `kind` is wider than technocore's Gap because one kind has no equivalent in
 * the reader: 'downtime' is what a restart discovers, and only this process
 * knows it was ever away. See recordDowntime below.
 */
// Omit-and-replace, not an intersection: `Gap & { kind: ... }` intersects the
// two unions rather than widening, so the extra member is narrowed straight
// back out and 'downtime' stays unassignable.
export type RecordedGap = Omit<Gap, 'kind'> & { kind: Gap['kind'] | 'downtime' };

/**
 * What goes in the `missing` column. A 'rotated' row NEVER carries a count,
 * wherever it came from.
 *
 * detectGap computes missing = firstSeq - 1 for one of these, which is a fair
 * description of a single observation — that many sequence numbers precede our
 * window — and a trap as a stored quantity. Any poll starting from since = 0
 * writes another one, so the column collected three rows inside six hours each
 * claiming kibble's whole 6.4M history, and the coverage endpoint added them
 * up. first_seq carries the real information: where coverage begins. How much
 * came before it is not knowable, and it was never Notary's to lose.
 */
export function storedMissing(gap: RecordedGap): number | null {
  return gap.kind === 'rotated' ? null : (gap.missing ?? null);
}

async function recordGap(room: string, gap: RecordedGap): Promise<void> {
  const missing = storedMissing(gap);

  const detail = {
    room,
    kind: gap.kind,
    missing,
    expectedSeq: gap.expected ?? null,
    firstSeq: gap.firstSeq ?? null,
    generation: gap.generation ?? null,
  };

  let id = null;
  try {
    if (!DRY_RUN) id = await insertGap(detail);
  } catch (err) {
    stats.errors++;
    log(`[${room}] could not record a ${gap.kind} gap: ${(err as Error).message}`);
  }

  if (gap.kind === 'missed') {
    stats.gapsMissed++;
    if (gap.expected != null && gap.firstSeq != null) {
      addHole(room, { id, from: gap.expected, to: gap.firstSeq - 1 });
    }
    // Loud on purpose. The archive is now missing these and always will be.
    log(
      `[${room}] GAP — ${gap.missing} message(s) rotated past before Notary read them ` +
        `(expected seq ${gap.expected}, reply starts at ${gap.firstSeq}). Recorded; queued for re-export.`
    );
  } else if (gap.kind === 'downtime') {
    stats.gapsDowntime++;
    if (gap.expected != null && gap.firstSeq != null) {
      addHole(room, { id, from: gap.expected, to: gap.firstSeq - 1 });
    }
    log(
      `[${room}] DOWNTIME GAP — ${gap.missing} message(s) went past while Notary was not ` +
        `running (last stored seq ${(gap.expected ?? 1) - 1}, ring now starts at ${gap.firstSeq}). ` +
        `Recorded; queued for re-export.`
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
 * Where to resume a room, and why it is not `max(source_seq)` any more.
 *
 * The cursor is what the mirror READ. The stored maximum is what it KEPT, and
 * under the sightings policy those differ by everything the sampling dropped.
 * Resuming from what was kept made the loss accounting a side effect of the
 * capture policy: widen the sampling and the archive would report itself losing
 * more messages while losing none. On a page whose whole argument is that
 * "lost" and "never ours to capture" are different things, the loss figure
 * cannot move because a storage decision changed.
 *
 * The fallback is a seed, not a strategy. An archive that predates the cursors
 * table has records and no cursor, and treating that as a first-ever look would
 * book every room's whole history as a hole on the first restart after this
 * ships. One read of the stored maximum, then the cursor is written and is
 * authoritative from then on.
 */
export function resumePoint({ cursor, stored }: { cursor: number | null; stored: number }): number {
  return cursor ?? stored;
}

/**
 * A ring starts above seq 1. Which of two different facts is that?
 *
 * NOTHING STORED FOR THIS ROOM YET — this is the first look, and everything
 * before the ring's start had rotated out before Notary existed. Not loss:
 * nobody could have captured it, and there is no way to say how much there was.
 * `missing` stays null and must never be summed. The row is still written,
 * because "coverage for this room begins mid-ring" is a fact every answer about
 * a DID has to be read against.
 *
 * SOMETHING IS STORED BELOW WHERE THE RING NOW STARTS — Notary was following
 * this room, went away, and the ring moved on without it. That span is known
 * exactly: the distance between the last message stored and the ring's new
 * first. It is loss of the same weight as a missed poll.
 *
 * Both used to come out as 'rotated' with missing: null. So the downtime was
 * counted as zero, while the same restart separately re-asserted the room's
 * entire history as freshly lost — two errors pointing opposite ways, and the
 * larger one won by a factor of forty.
 *
 * Returns null when the ring still reaches what is stored: nothing was lost and
 * there is nothing to write down. The old code wrote a 'rotated' row here too,
 * which is why the table had one per restart per room.
 */
export function classifyRingStart({
  resumeFrom,
  firstSeq,
}: {
  resumeFrom: number;
  firstSeq: number | null;
}): RecordedGap | null {
  if (firstSeq == null || firstSeq <= 1) return null;

  if (resumeFrom === 0) {
    return { kind: 'rotated', firstSeq, missing: null };
  }
  if (firstSeq > resumeFrom + 1) {
    return {
      kind: 'downtime',
      expected: resumeFrom + 1,
      firstSeq,
      missing: firstSeq - resumeFrom - 1,
    };
  }
  return null;
}

/**
 * Take everything the ring still holds, one room at a time.
 *
 * Sequential rather than parallel: it bounds memory to a single room's export
 * and keeps the read budget from being spent all at once.
 */
async function backfill(room: string): Promise<{ lastSeq: number; generation: number | null }> {
  // The stored maximum is read ONLY when there is no cursor. It was a cheap
  // lookup while records_room_seq_idx existed; that index cost 73 MB to serve
  // a query the cursors table replaced, so it is gone and this is now a
  // sequential scan. Once per room, on the first run after the table shipped.
  const cursor = DRY_RUN ? 0 : await readCursor(room);
  const resumeFrom = DRY_RUN
    ? 0
    : resumePoint({ cursor, stored: cursor == null ? await lastSeqFor(room) : 0 });
  const dump = await exportRoom(room);

  if (dump.messages.length === 0) {
    log(`[${room}] empty ring.`);
    return { lastSeq: resumeFrom, generation: dump.generation };
  }

  const ringStart = classifyRingStart({ resumeFrom, firstSeq: dump.firstSeq });
  if (ringStart) await recordGap(room, ringStart);

  const fresh = dump.messages.filter((m) => m.seq > resumeFrom);
  log(
    `[${room}] ring holds ${dump.messages.length} (seq ${dump.firstSeq}–${dump.lastSeq}); ` +
      `${fresh.length} past the cursor at ${resumeFrom}.`
  );

  await absorb(fresh, room);

  if (dump.malformed.length) {
    log(`[${room}] ${dump.malformed.length} record(s) in the export could not be parsed.`);
  }

  // After absorbing, not before: a crash mid-write must leave the cursor where
  // the next run will re-read the batch rather than past it.
  await advanceCursor(room, dump.lastSeq);

  return { lastSeq: dump.lastSeq, generation: dump.generation };
}

/** Write the cursor, unless this is a dry run, and never let a failure stop capture. */
async function advanceCursor(room: string, lastSeq: number): Promise<void> {
  if (DRY_RUN || !Number.isFinite(lastSeq) || lastSeq <= 0) return;
  try {
    await writeCursor(room, lastSeq);
  } catch (err) {
    // Capture matters more than bookkeeping. A cursor that failed to advance
    // costs a re-read and, at worst, a hole recorded larger than it was; a
    // throw here would take the room down.
    stats.errors++;
    log(`[${room}] could not advance the cursor: ${(err as Error).message}`);
  }
}

function follow(room: string, since: number): RoomWatcher {
  const watcher = new RoomWatcher(room, {
    since,
    backfill: false,
    wait: 10,
    limit: POLL_LIMIT,
    onMessages: async ({ messages, lastSeq }) => {
      try {
        await absorb(messages, room);
      } catch (err) {
        stats.errors++;
        log(`[${room}] write failed: ${(err as Error).message}`);
        // The cursor does NOT advance past a batch that failed to store. The
        // next run re-reads it, which costs a duplicate insert and nothing
        // else, where advancing would turn a write failure into a silent hole.
        return;
      }
      // lastSeq, not the highest message seq: this is the watcher's own cursor,
      // and a line it skipped as unparseable is behind it. Recording the
      // messages instead would leave that line looking like a hole at the next
      // restart, every restart, forever.
      await advanceCursor(room, lastSeq);
    },
    onGap: (gap) => {
      recordGap(room, gap).catch(() => {});
    },
    onError: (err) => {
      stats.errors++;
      log(`[${room}] ${(err as Error).message}`);
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
async function sweep(): Promise<void> {
  for (const [room, roomHoles] of holes) {
    if (roomHoles.length === 0) continue;

    let dump;
    try {
      dump = await exportRoom(room);
    } catch (err) {
      stats.errors++;
      log(`[${room}] sweep failed: ${(err as Error).message}`);
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

function report(): void {
  const mins = (Date.now() - stats.startedAt) / 60_000;
  log(
    `captured ${stats.captured.toLocaleString('en')} | dup ${stats.duplicate.toLocaleString('en')} | ` +
      `seen ${stats.seen.toLocaleString('en')} | unsigned ${stats.unsigned} | ` +
      `bad sig ${stats.badSignature} | bad nonce ${stats.badNonce} | ` +
      `missed gaps ${stats.gapsMissed} | recovered ${stats.recovered.toLocaleString('en')} | ` +
      `sampled away ${stats.sampledAway.toLocaleString('en')} | ` +
      `lost ${stats.lost} | errors ${stats.errors} | ` +
      `${(stats.captured / Math.max(mins, 1 / 60)).toFixed(0)}/min`
  );
}

/** A running mirror, so whoever started it can stop it. */
export interface MirrorHandle {
  stop: () => Promise<void>;
  rooms: number;
}

/**
 * Start the mirror and return a handle.
 *
 * It does NOT install signal handlers or close the pool: the owner does that.
 * When the API hosts the mirror in its own process — one service, one Postgres
 * connection pool, which is the whole reason for running them together — a
 * mirror that called process.exit on SIGTERM would take the HTTP server down
 * mid-request without draining it.
 */
export async function startMirror(): Promise<MirrorHandle> {
  log(`Notary mirror starting${DRY_RUN ? ' — DRY RUN, nothing will be written' : ''}.`);

  if (!DRY_RUN) {
    await assertSchema();
    const before = await archiveStats();
    log(
      `archive holds ${Number(before.records).toLocaleString('en')} records across ` +
        `${Number(before.dids).toLocaleString('en')} DIDs.`
    );
  }

  const watchers: RoomWatcher[] = [];
  let stopping = false;

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
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
        /* stopping anyway */
      }
    }
  };

  const ticker = setInterval(() => {
    report();
    pruneThrottleCache();
  }, STATS_EVERY_MS);
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
    if (stopping) return { stop, rooms: watchers.length };
    try {
      const { lastSeq } = await backfill(room);
      watchers.push(follow(room, lastSeq));
      log(`[${room}] following from seq ${lastSeq} (${policyFor(room)}).`);
    } catch (err) {
      stats.errors++;
      log(`[${room}] backfill failed, following from the live head instead: ${(err as Error).message}`);
      try {
        watchers.push(follow(room, 0));
      } catch (inner) {
        log(`[${room}] could not follow at all: ${(inner as Error).message}`);
      }
    }
    report();
  }

  log(`following ${watchers.length} room(s).`);
  return { stop, rooms: watchers.length };
}

/** Counters, exported so a test can read them without touching the database. */
export const mirrorStats = stats;

// Only when run as a script, so the verification path above can be imported and
// tested — or hosted by the API — without opening a connection or following a
// room. As a script it owns the process, so here it does install signal
// handlers and close the pool.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startMirror()
    .then((handle) => {
      let leaving = false;
      const leave = async (signal: string): Promise<void> => {
        if (leaving) return;
        leaving = true;
        log(`${signal} — stopping.`);
        await handle.stop();
        if (!DRY_RUN) await closePool().catch(() => {});
        process.exit(0);
      };
      process.on('SIGINT', () => void leave('SIGINT'));
      process.on('SIGTERM', () => void leave('SIGTERM'));
      log('Ctrl-C to stop.');
    })
    .catch(async (err) => {
      console.error(`[fatal] ${err.stack ?? (err as Error).message}`);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
