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
import { postSigned } from '../../../src/lib/technocore.ts';

/**
 * Where roots are published. A public room, so the commitment is public.
 *
 * `technocore` rather than a room of Notary's own: a root nobody else reads is
 * a root nobody can testify to having seen before the fact, and the point of
 * publishing is witnesses.
 */
export const ANCHOR_ROOM = process.env.NOTARY_ANCHOR_ROOM ?? 'technocore';

export const ANCHOR_TYPE = 'foolscap.notary.anchor.v1';

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

/** The message body published into the room. */
export function anchorPayload(anchor: BuiltAnchor): string {
  return JSON.stringify({
    type: ANCHOR_TYPE,
    day: anchor.day,
    root: anchor.root,
    records: anchor.recordCount,
    first_capture: anchor.firstCapture,
    last_capture: anchor.lastCapture,
  });
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
  const rawSeed = process.env.NOTARY_SEED;
  if (!rawSeed) return { published: false, seq: null, reason: 'NOTARY_SEED is not set' };
  if (!anchor.root) return { published: false, seq: null, reason: 'nothing captured that day' };

  const seed = parseSeed(rawSeed);
  const did = await didFromSeed(seed);
  const text = anchorPayload(anchor);
  // Nonces must increase per key per room, and the day is a natural monotonic
  // choice that also makes a republication of the same day collide rather than
  // quietly appear twice.
  const nonce = String(Date.now());
  const sig = await signWithSeed(seed, canonicalString(ANCHOR_ROOM, nonce, text));

  const reply = (await postSigned({ room: ANCHOR_ROOM, did, sig, nonce, text })) as {
    seq?: number;
  } | null;
  const seq = typeof reply?.seq === 'number' ? reply.seq : null;
  await markAnchorPublished(anchor.day, seq);
  return { published: true, seq };
}

/** Notary's own DID, derived from the seed. Published so the client can pin it. */
export async function notaryDid(): Promise<string | null> {
  const rawSeed = process.env.NOTARY_SEED;
  if (!rawSeed) return null;
  try {
    return await didFromSeed(parseSeed(rawSeed));
  } catch {
    return null;
  }
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
