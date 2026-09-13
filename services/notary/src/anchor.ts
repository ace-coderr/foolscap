// anchor.ts — the daily commitment.
//
// Once a day, Notary builds a Merkle tree over everything it captured that day,
// stores the root, and publishes it into a public Technocore room signed by its
// own key. After that, Notary cannot backdate a record, remove one, or move one
// between days without the published root failing to reproduce — and anyone can
// check, because the leaves are built only from fields the API already serves.
//
// NOTARY.md: "Anchor before you have users. An archive that only starts
// anchoring once it matters is an archive nobody can trust for the period that
// matters." So this runs from the first day, over whatever is there.
//
//   npm run anchor --workspace services/notary                 # yesterday
//   npm run anchor --workspace services/notary -- 2026-09-12   # a given day
//   npm run anchor --workspace services/notary -- --all        # every unanchored day

import { pathToFileURL } from 'node:url';
import { recordsForDay, anchors, type AnchorRow } from './archive.ts';
import { closePool, getPool, upsertAnchor, markAnchorPublished } from './db.ts';
import { leafHash, merkleRoot, isoStamp } from './merkle.ts';
import { didFromSeed, parseSeed, signWithSeed } from '../../../src/lib/did.ts';
import { canonicalString } from '../../../src/lib/did.ts';
import { postSigned, readRoom } from '../../../src/lib/technocore.ts';
import { NOTARY_DID, ANCHOR_ROOM as PINNED_ROOM, anchorPayload as buildPayload } from '../../../src/lib/notary.ts';

/** Where roots are published. See src/lib/notary.ts — the room is pinned too. */
export const ANCHOR_ROOM = process.env.NOTARY_ANCHOR_ROOM ?? PINNED_ROOM;

export { NOTARY_DID };

export interface BuiltAnchor {
  day: string;
  root: string | null;
  recordCount: number;
  firstCapture: string | null;
  lastCapture: string | null;
}

/**
 * Build (or rebuild) a day's root and store it.
 *
 * Rebuilding is safe and is how a verifier checks Notary: run this against the
 * same day and the root either matches what was published or it does not.
 */
export async function buildAnchor(day: string): Promise<BuiltAnchor> {
  const records = await recordsForDay(day);

  const leaves = records.map((record) =>
    leafHash({
      did: record.did,
      room: record.room,
      nonce: record.nonce,
      sig: record.sig,
      capturedAt: isoStamp(record.capturedAt),
    })
  );

  const built: BuiltAnchor = {
    day,
    root: merkleRoot(leaves),
    recordCount: records.length,
    firstCapture: records[0]?.capturedAt ?? null,
    lastCapture: records[records.length - 1]?.capturedAt ?? null,
  };

  await upsertAnchor(built);
  return built;
}

/** The message body published into the room. One shape, shared with the client. */
export function anchorPayload(anchor: BuiltAnchor): string {
  return buildPayload({ ...anchor, root: anchor.root ?? '' });
}

/**
 * The signing key, checked against the DID the client pins.
 *
 * A seed that derives a different DID is refused rather than used. The failure
 * it prevents is the quiet one: anchors would publish, look published, and
 * verify against nothing any reader pins — an archive that believes it is
 * tamper-evident while being exactly as trustworthy as its database. Better to
 * publish nothing and say so.
 */
export async function signingKey(): Promise<
  { ok: true; seed: Uint8Array; did: string } | { ok: false; reason: string }
> {
  const raw = process.env.NOTARY_SEED;
  if (!raw) return { ok: false, reason: 'NOTARY_SEED is not set' };

  let seed: Uint8Array;
  try {
    seed = parseSeed(raw);
  } catch (err) {
    return { ok: false, reason: `NOTARY_SEED is not a 32-byte seed: ${(err as Error).message}` };
  }

  const did = await didFromSeed(seed);
  if (did !== NOTARY_DID) {
    return {
      ok: false,
      reason:
        `NOTARY_SEED derives ${did}, but the client pins ${NOTARY_DID}. ` +
        'Anchors signed by this key would verify against nothing anyone checks.',
    };
  }
  return { ok: true, seed, did };
}

/**
 * Publish a root, signed by Notary's own key.
 *
 * NOTARY_SEED is the private key and it never leaves this process: the seed is
 * read from the environment, used to sign one string, and nothing derived from
 * it is stored. Without it, anchors are still built and served — they are just
 * not yet witnessed by anyone, and `/anchors` says exactly that rather than
 * implying a publication that never happened.
 */
export async function publishAnchor(anchor: BuiltAnchor): Promise<{ published: boolean; seq: number | null; reason?: string }> {
  if (!anchor.root) return { published: false, seq: null, reason: 'nothing captured that day' };

  const key = await signingKey();
  if (!key.ok) return { published: false, seq: null, reason: key.reason };

  const { seed, did } = key;
  const text = anchorPayload(anchor);
  // Nonces must increase per key per room, and the day is a natural monotonic
  // choice that also makes a republication of the same day collide rather than
  // quietly appear twice.
  const nonce = String(Date.now());
  const sig = await signWithSeed(seed, canonicalString(ANCHOR_ROOM, nonce, text));

  const reply = (await postSigned({ room: ANCHOR_ROOM, did, sig, nonce, text })) as {
    seq?: number;
  } | null;

  // Read it back rather than trusting the reply. The POST response does not
  // reliably carry a seq, and an anchor nobody can point at is an anchor nobody
  // can check — the locator is half of what makes the commitment useful.
  const seq = typeof reply?.seq === 'number' ? reply.seq : await locatePublication(did, nonce);
  await markAnchorPublished(anchor.day, seq);
  return { published: true, seq };
}

/**
 * Find a just-posted anchor in the room and return its sequence.
 *
 * Matched on (did, nonce), which is unique per key per room — not on the text,
 * because two anchors for the same day would have identical text and the
 * sequence is the only thing distinguishing them.
 */
export async function locatePublication(did: string, nonce: string): Promise<number | null> {
  try {
    const { messages } = await readRoom(ANCHOR_ROOM, { limit: 200 });
    const mine = messages.find((m) => m.from === did && String(m.nonce) === String(nonce));
    return mine ? mine.seq : null;
  } catch {
    // Not fatal: the anchor is published either way, and published_at records
    // that. Only the locator is missing.
    return null;
  }
}

/**
 * Whether this process can actually publish, and why not when it cannot.
 *
 * The DID it reports is the PINNED one, never one derived from whatever seed
 * happens to be in the environment — a service reporting its own key would let
 * a wrong key look correct to a client that trusted the answer.
 */
export async function signingStatus(): Promise<{ did: string; canSign: boolean; reason: string | null }> {
  const key = await signingKey();
  return { did: NOTARY_DID, canSign: key.ok, reason: key.ok ? null : key.reason };
}

/** Capture days that have records but no stored root. */
export async function unanchoredDays(): Promise<string[]> {
  const { rows } = await getPool().query(
    `select to_char(r.day, 'YYYY-MM-DD') as day
       from (select distinct day from records) r
       left join anchors a on a.day = r.day
      where a.root is null
      order by r.day`
  );
  return rows.map((row: { day: string }) => row.day);
}

/**
 * Complete days that are not yet witnessed.
 *
 * `day < today` is the important half: anchoring the current day would commit to
 * a partial one, and the next run would have to contradict a root that had
 * already been published. A day is only closed once UTC has left it.
 *
 * Days whose root exists but was never published are included, because an
 * unpublished root constrains nothing — it is a number in the same database it
 * is supposed to be holding to account.
 *
 * The test is `published_at is null`, NOT `published_seq is null`. The room's
 * POST reply does not always carry a sequence number, so a successful
 * publication can legitimately have a null seq — and keying off seq made the
 * sweep treat a published anchor as unpublished and post it again every hour.
 * published_at records that the post succeeded; published_seq is only where to
 * find it.
 */
export async function daysNeedingPublication(): Promise<string[]> {
  const { rows } = await getPool().query(
    `select to_char(r.day, 'YYYY-MM-DD') as day
       from (select distinct day from records) r
       left join anchors a on a.day = r.day
      where r.day < (now() at time zone 'utc')::date
        and (a.root is null or a.published_at is null)
      order by r.day`
  );
  return rows.map((row: { day: string }) => row.day);
}

/** How often to look for a day that needs anchoring. */
const ANCHOR_SWEEP_MS = Number(process.env.NOTARY_ANCHOR_SWEEP_MS ?? 3_600_000);

export interface AnchorHandle {
  stop: () => void;
}

/**
 * Anchor on a sweep rather than on a cron.
 *
 * A cron fires once and, if the process happened to be restarting or Technocore
 * happened to be rate limiting, the day is simply never anchored and nothing
 * says so. A sweep that asks "which closed days are still unwitnessed?" catches
 * up by construction — after an outage it publishes the backlog in order, and
 * when there is nothing to do it costs one indexed query an hour.
 */
export function startAnchoring(): AnchorHandle {
  let running = false;

  const sweep = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const key = await signingKey();
      if (!key.ok) {
        // Said once an hour rather than silently: a service that cannot sign is
        // building roots nobody can check, and that should be noisy.
        console.log(`[anchor] not publishing — ${key.reason}`);
        return;
      }
      for (const day of await daysNeedingPublication()) {
        const anchor = await buildAnchor(day);
        const result = await publishAnchor(anchor);
        console.log(
          result.published
            ? `[anchor] ${day}: ${anchor.recordCount} records, root ${anchor.root}, published to ${ANCHOR_ROOM} at seq ${result.seq ?? '?'}`
            : `[anchor] ${day}: not published — ${result.reason}`
        );
      }
    } catch (err) {
      // Never fatal. A failed anchor is retried next hour; taking the capture
      // process down with it would cost history, which is worse.
      console.error(`[anchor] sweep failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), ANCHOR_SWEEP_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const publish = !args.includes('--no-publish');

  let days: string[];
  if (args.includes('--all')) {
    days = await unanchoredDays();
  } else {
    const explicit = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg));
    // Yesterday by default: anchoring today's records mid-day would commit to a
    // partial day and the next run would have to contradict it.
    days = [explicit ?? utcDay(new Date(Date.now() - 86_400_000))];
  }

  if (days.length === 0) {
    console.log('Nothing to anchor: every day with records already has a root.');
    return;
  }

  for (const day of days) {
    const anchor = await buildAnchor(day);
    console.log(
      `${day}: ${anchor.recordCount.toLocaleString('en')} records, root ${anchor.root ?? '(none — no records)'}`
    );
    if (!publish) continue;
    const result = await publishAnchor(anchor);
    console.log(
      result.published
        ? `  published to ${ANCHOR_ROOM}${result.seq == null ? '' : ` at seq ${result.seq}`}`
        : `  not published: ${result.reason}`
    );
  }

  const stored: AnchorRow[] = await anchors();
  console.log(`${stored.length} day(s) anchored.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(`[fatal] ${err.stack ?? (err as Error).message}`);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
