// rules.ts — Holdfast, as rules rather than as a page.
//
// Pure, synchronous apart from the one signature check, and every function here
// is a rule a player could check by hand. Nothing in this file talks to the
// network.
//
// ---------------------------------------------------------------------------
// WHAT THE SERVER GUARANTEES, AND WHAT IT DOES NOT. Read this before the code.
//
// A note on technocore.chat is world-writable and unsigned. Anyone may overwrite
// any note, at any time, for the cost of one HTTP request. The server does not
// know or care who wrote it and will not tell you when. There is no owner, no
// permission, no history, and no undo.
//
// So Holdfast cannot be a game about property, and pretending otherwise on a
// network built around signatures would be worse than not building it. What it
// is instead is a game about two things the server genuinely does enforce:
//
//   THE RACE      ?if_absent=1 is settled at the origin. When two players go for
//                 a free key at once, exactly one gets a 200 and the other gets a
//                 409, and neither of them decides which.
//
//   THE DECAY     a note with no write for seven days is deleted. Holding
//                 ground means coming back to it. Nobody is exempt and nobody
//                 has to be asked.
//
// Everything else — who holds a plot, since when, for how long unbroken — lives
// in the note's own text, put there by whoever wrote last, about themselves.
//
// TWO THINGS NARROW THAT, and neither closes it:
//
//   A SIGNATURE binds the claim to a key. The value carries a did:key and an
//   Ed25519 signature over the plot and the timestamps, so a claim cannot be
//   moved to another plot, and one player cannot post a claim in another's name.
//   What it cannot do is stop that player's note being erased: an attacker who
//   overwrites your plot with a valid claim of their own has taken it, and one
//   who overwrites it with rubbish has taken it from both of you. The signature
//   makes identity checkable; it does not make territory defensible.
//
//   EXISTENCE bounds the renewal. A listed key was written inside seven days —
//   the server deleted it otherwise — so a value claiming it was last renewed
//   three weeks ago is provably inconsistent with its own presence, and is shown
//   as such rather than believed. There is no matching check on the FIRST claim:
//   `claimed_at` can say anything, and a player who backdates it gets a taller
//   building. The page says so where it draws the building, because a height
//   that is a claim and looks like a measurement is the one lie the design could
//   tell without anyone typing it.
//
// The short version, which belongs on the page in these words: ownership here
// means wrote-it-last-and-kept-it-alive. Nothing more is on offer.

import { BASE58_ALPHABET, DID_KEY_ED25519_RE, SIGNATURE_RE, verify } from '../lib/did.ts';
import { KV_NAME_RE } from '../lib/kv.ts';
import { plural } from '../format.ts';

/** The server deletes a note with no write for seven days. */
export const DECAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Inside this much of reclamation, a plot is in danger and the board shows it. */
export const DANGER_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The letter rule
// ---------------------------------------------------------------------------

/**
 * Which keys a DID is allowed to name.
 *
 * sonnet-2 constrains a poem to the letters of the key that writes it. The same
 * idea, on the only alphabet both halves share: a did:key is base58btc, a note
 * key is [a-z0-9_-], and a player may name a plot only out of the characters
 * their own DID contains.
 *
 * CASE IS FOLDED, and it has to be. base58 omits four characters to stop
 * lookalikes being confused — `0`, `O`, `I` and `l` — so a case-sensitive rule
 * would put `l` out of reach of every player alive, and `o` out of reach of
 * anyone whose DID happened to carry only the capital. Folding means `L`
 * anywhere in the DID buys `l`, and the whole of a–z is reachable by somebody.
 *
 * `0` is reachable by nobody, ever. It is not in base58 at all, so no DID can
 * contain it, so no plot can be named with it. That is a real hole in the board
 * and it is left in: it is the rule being visibly the rule rather than a rule
 * with an exception where it got inconvenient.
 *
 * HYPHEN AND UNDERSCORE ARE FREE. Neither is in base58 either, and making them
 * unavailable would leave every key a single run of characters — no prefixes, no
 * districts, no neighbours, and the board's whole structure gone with them. They
 * are punctuation between letters rather than letters, and they are granted to
 * everyone on that basis.
 */
export const FREE_CHARACTERS = '-_';

export function lettersFor(did: string): Set<string> {
  const set = new Set<string>();
  if (!DID_KEY_ED25519_RE.test(did)) return set;
  // Past `did:key:`. The leading `z` is the multibase tag rather than part of
  // the key, and it is left in: it is a character the DID visibly contains, and
  // taking it out would mean explaining on the page why the z everyone can see
  // does not count.
  for (const ch of did.slice('did:key:'.length).toLowerCase()) {
    if (BASE58_ALPHABET.toLowerCase().includes(ch)) set.add(ch);
  }
  return set;
}

/** The alphabet a player can draw on, in the order it reads best: digits, then letters. */
export function availableCharacters(did: string): string[] {
  const letters = lettersFor(did);
  const digits = [...'123456789'].filter((ch) => letters.has(ch));
  const alpha = [...'abcdefghijklmnopqrstuvwxyz'].filter((ch) => letters.has(ch));
  return [...digits, ...alpha];
}

export interface KeyCheck {
  ok: boolean;
  /** The characters of the key this DID cannot name, in the order they appear. */
  missing: string[];
  reason: string | null;
}

export function checkKey(did: string, key: string): KeyCheck {
  if (!KV_NAME_RE.test(key)) {
    return {
      ok: false,
      missing: [],
      reason:
        'A key is lowercase letters, digits, hyphen and underscore, starting with a letter ' +
        'or digit, up to 48 characters. That is the server’s rule, not Holdfast’s.',
    };
  }
  const letters = lettersFor(did);
  if (letters.size === 0) {
    return { ok: false, missing: [], reason: 'That is not an Ed25519 did:key.' };
  }
  const missing: string[] = [];
  for (const ch of key) {
    if (FREE_CHARACTERS.includes(ch)) continue;
    if (!letters.has(ch) && !missing.includes(ch)) missing.push(ch);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `Your key does not contain ${missing.map((ch) => `“${ch}”`).join(', ')}.`,
    };
  }
  return { ok: true, missing: [], reason: null };
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

/**
 * What a plot's note says, as one line.
 *
 *   holdfast1 <did> <claimed_at> <renewed_at> <sig>
 *
 * One line because the server collapses every newline in a note to a space on
 * the way in, so a multi-line format would arrive as a single line anyway and
 * the parser may as well be honest about it. Space-separated because none of the
 * five fields can contain a space, and a format whose separator cannot appear in
 * its own fields needs no escaping and no quoting to get wrong.
 *
 * Timestamps are unix SECONDS. Milliseconds would be three digits of precision
 * nobody can use for a clock the writer sets themselves.
 */
export const CLAIM_VERSION = 'holdfast1';

export interface Claim {
  did: string;
  /** Unix seconds, as the writer states them. Unverifiable. See the header. */
  claimedAt: number;
  renewedAt: number;
  sig: string;
}

/**
 * What is signed.
 *
 * NS AND KEY ARE IN IT, and that is the point of having it at all. Without them
 * a valid claim is a portable token: anyone could copy the line off one plot
 * onto every free key on the board and populate a whole district in somebody
 * else's name. Binding the signature to the plot makes a claim mean "I claim
 * THIS", which is the only thing worth signing.
 */
export function claimMessage({
  ns,
  key,
  did,
  claimedAt,
  renewedAt,
}: {
  ns: string;
  key: string;
  did: string;
  claimedAt: number;
  renewedAt: number;
}): string {
  return ['holdfast', ns, key, did, String(claimedAt), String(renewedAt)].join('|');
}

export function formatClaim(claim: Claim): string {
  return [CLAIM_VERSION, claim.did, String(claim.claimedAt), String(claim.renewedAt), claim.sig].join(
    ' '
  );
}

/** Shape only. Says nothing about whether the signature is good. */
export function parseClaim(value: string | null): Claim | null {
  if (!value) return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] !== CLAIM_VERSION) return null;
  const [, did, claimedAt, renewedAt, sig] = parts;
  if (!DID_KEY_ED25519_RE.test(did)) return null;
  if (!/^\d{1,12}$/.test(claimedAt) || !/^\d{1,12}$/.test(renewedAt)) return null;
  if (!SIGNATURE_RE.test(sig)) return null;
  return { did, claimedAt: Number(claimedAt), renewedAt: Number(renewedAt), sig };
}

/**
 * Why a plot is not attributed to anyone.
 *
 * Every one of these is a plot that EXISTS — somebody wrote it inside the last
 * seven days — and that Holdfast will not put a name against. They are kept
 * apart rather than collapsed into one "invalid", because they mean different
 * things to a player: `unreadable` is very often somebody's ordinary note in a
 * namespace the game also watches, and `bad-signature` is the only one of them
 * that suggests anybody tried anything.
 */
export type ClaimFault =
  | 'unreadable'
  | 'bad-signature'
  | 'future'
  | 'renewed-before-claimed'
  | 'stale';

export interface Holding {
  /** Null where the note is present but not a claim this page will stand behind. */
  claim: Claim | null;
  fault: ClaimFault | null;
  /** Milliseconds the writer says it has been held. Their figure, not a measurement. */
  heldMs: number | null;
  /**
   * Milliseconds until the server deletes the note, from the claimed renewal.
   *
   * Clamped into (0, DECAY_MS]: the note is present, so the server's clock has
   * not run out whatever the value says. A claim whose own arithmetic puts it
   * past the deadline is faulted `stale` and the clamp is what keeps the board
   * from drawing a negative.
   */
  reclaimInMs: number;
  reclaimExact: boolean;
}

/**
 * Check a claim against the two things that can actually be checked: the
 * signature, and the seven-day rule the note's own existence establishes.
 *
 * `now` is passed rather than read so the same board renders the same way twice,
 * and so the tests are not about what time it is.
 */
export async function assessClaim(
  ns: string,
  key: string,
  value: string | null,
  now: number
): Promise<Holding> {
  const none = (fault: ClaimFault | null): Holding => ({
    claim: null,
    fault,
    heldMs: null,
    reclaimInMs: DECAY_MS,
    reclaimExact: false,
  });

  const claim = parseClaim(value);
  if (!claim) return none(value == null ? null : 'unreadable');

  let ok = false;
  try {
    ok = await verify(
      claim.did,
      claimMessage({ ns, key, did: claim.did, claimedAt: claim.claimedAt, renewedAt: claim.renewedAt }),
      claim.sig
    );
  } catch {
    // A malformed DID or signature throws; for this purpose that is the same
    // answer as a signature that did not check out.
    ok = false;
  }
  if (!ok) return none('bad-signature');

  const claimedMs = claim.claimedAt * 1000;
  const renewedMs = claim.renewedAt * 1000;

  // A minute of slack, because the writer's clock is theirs and a page that
  // faulted every claim signed by a machine running thirty seconds fast would be
  // reporting clock drift as cheating.
  const SKEW_MS = 60_000;
  if (claimedMs > now + SKEW_MS || renewedMs > now + SKEW_MS) return none('future');
  if (renewedMs + SKEW_MS < claimedMs) return none('renewed-before-claimed');

  const elapsed = now - renewedMs;
  if (elapsed > DECAY_MS) {
    // The note is here, so it was written within seven days, so this value is
    // wrong about itself. Most likely somebody replayed an old line to keep a
    // plot alive without re-signing it. Alive, unattributed, and named.
    return none('stale');
  }

  return {
    claim,
    fault: null,
    heldMs: Math.max(0, now - claimedMs),
    reclaimInMs: Math.min(DECAY_MS, Math.max(0, DECAY_MS - elapsed)),
    reclaimExact: true,
  };
}

// ---------------------------------------------------------------------------
// Time, in the units this game is played in
// ---------------------------------------------------------------------------

/**
 * A span in days, hours and minutes.
 *
 * format.ts has formatAge and it stops at hours, correctly: everywhere else on
 * this site a duration is the age of a message or the wait on a queue, and those
 * live in minutes. Holdfast's spans are a seven-day decay clock and holds that
 * run for weeks, and formatAge renders those as "460 hours 49 minutes" — a
 * number nobody can read as "nineteen days". Rather than change what every other
 * page prints, this is the same idea in this game's units.
 *
 * Hours are shown beside days only under a week. Past that they are noise on a
 * figure that is measured in returns to a plot, not in afternoons.
 */
export function formatSpan(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${plural(hours, 'hour')} ${plural(rest, 'minute')}` : plural(hours, 'hour');
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest && days < 7 ? `${plural(days, 'day')} ${plural(rest, 'hour')}` : plural(days, 'day');
}

// ---------------------------------------------------------------------------
// Districts and neighbours
// ---------------------------------------------------------------------------

/**
 * A plot's district: everything in its namespace sharing its leading segment.
 *
 * `north-gate` and `north-well` are in the same district, `south-gate` is not.
 * A key with no hyphen is its own district of one, which is what makes founding
 * a new district a visible act: the first `west-*` plot anybody claims puts a
 * new block on the map, and the second one to arrive joins it.
 */
export function districtOf(key: string): string {
  const cut = key.indexOf('-');
  return cut > 0 ? key.slice(0, cut) : key;
}

/**
 * The largest run of consecutive plots one DID holds.
 *
 * Consecutive in the namespace's sorted key order, which is the order the board
 * lays out and the order the server lists in. This is the whole reason the
 * listing is sorted in kv.ts: neighbours are defined by position, so the
 * position has to be stable or a player's territory would rearrange itself
 * between two reads.
 *
 * The run is broken by a plot held by somebody else, by an unattributed one, and
 * by one Holdfast has not read yet. The last is the awkward case and it is
 * deliberately counted as a break: a gap that MIGHT be yours is not a block, and
 * the leaderboard says how much of the board has been read so a short run can be
 * read as "so far".
 */
export function longestRun(holders: (string | null)[], did: string): number {
  let best = 0;
  let run = 0;
  for (const holder of holders) {
    run = holder === did ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
