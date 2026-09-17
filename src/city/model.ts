// model.ts — turning two different kinds of reading into one city.
//
// Foolscap has two sources here and they are not equivalent, so this file keeps
// them apart all the way to the surface rather than averaging them into a number
// nobody can trace:
//
//   THE SURVEY   /rooms, one request, fifty rooms. A snapshot the server takes on
//                its own schedule and the edge holds for up to a day. Good for
//                which rooms exist and how much they have carried. Not current,
//                and never presented as if it were.
//
//   THE WATCH    a handful of rooms Foolscap reads itself, one at a time, on a
//                slow rotation. Half a kilobyte each. This is the only source
//                that can support the word "now", so it is the only source a
//                state colour is ever derived from.
//
// A building whose state Foolscap has not read has no state colour. That is the
// whole rule, and it is why most of the city is unlit: the network is far larger
// than anything a browser should be polling, and showing an unread room as live
// would be inventing the one fact the page exists to report.

import type { RoomSummary } from '../lib/technocore.ts';
import { districtFor } from './districts.ts';
import { layoutRadial, type RadialLayout } from './radial.ts';

/** A room is live if Foolscap has seen a message this recently. */
export const LIVE_MS = 120_000;
/** Below this rate, and with nothing recent, a watched room reads as quiet. */
export const QUIET_MS = 600_000;

/** What one direct read of a room's head established. */
export interface Reading {
  room: string;
  /** The room's true message count at `readAt`. */
  lastSeq: number;
  /** When the newest message in it was posted, if there was one to see. */
  newestTsMs: number | null;
  readAt: number;
  /** Messages per minute, measured between this read and an earlier one. */
  ratePerMin: number | null;
  /** How long the rate was measured over. A short span is a rough number. */
  rateSpanMs: number | null;
  /**
   * Rate between each pair of adjacent reads, oldest first, messages a minute.
   *
   * NOT THE SAME MEASUREMENT AS `ratePerMin`, deliberately: that one is taken
   * across the whole window because a rate over half a minute is mostly
   * rounding, and this one is taken between adjacent reads because it is drawn
   * as a shape and a smoothed series has no shape. Empty until a room has been
   * read twice.
   */
  series: number[];
  /**
   * What happened when the newest message in the room was checked, here, in
   * this browser, against the key it names. Null where there was nothing to
   * check or the check has not run.
   *
   * ONE MESSAGE, NOT THE ROOM. This is the newest message and only the newest
   * message. It is enough to decide whether the traffic arriving right now
   * carries proof, which is what the accent is spent on — and it is nowhere near
   * enough to say the room is trustworthy, which is why nothing on the page
   * says that. /lens is where a room gets read properly.
   */
  proof: Proof | null;
  /** Set when the most recent attempt to read this room failed. */
  error: string | null;
}

/**
 * Whether the newest message verified. Lens's three verdicts, unchanged.
 *
 * `unsigned` is not a failure and must never be drawn as one. Most traffic on
 * this network carries no signature at all; a message without one is not a
 * forgery, it is a message nobody made a claim about.
 */
export type Proof = 'verified' | 'unsigned' | 'failed';

export type RoomState = 'live' | 'quiet' | 'failing' | 'unwatched';

export interface CityRoom {
  /** UNTRUSTED — the name its creator chose. See districts.ts. */
  room: string;
  districtId: string;
  x: number;
  z: number;
  /** World units. A log scale; the real figure is in `volume`. */
  height: number;
  /** World units square. From the district's crowding — see footprintFor. */
  footprint: number;
  /** Messages the room has carried, from the better of the two sources. */
  volume: number;
  /** True where `volume` came from a read Foolscap made itself. */
  volumeRead: boolean;
  /** 0–1, drives brightness. Zero where nothing was measured. */
  activity: number;
  activityBasis: 'read' | 'none';
  state: RoomState;
  /** See Reading.proof. */
  proof: Proof | null;
  /**
   * WHETHER THIS ROOM GETS THE ACCENT, decided in one place.
   *
   * The rule, and it is the whole of the rule: a room is lit when Foolscap has
   * read it, found it live, AND the newest message in it verified against the
   * key that message names. Live but unsigned is not lit. Quiet is not lit.
   * Unread is not lit.
   *
   * The old page lit every watched room and used hue for the state — teal for
   * live, amber for quiet — and the result was a city where almost everything
   * glowed, so the glow said nothing. If brightness is going to mean "there is
   * something arriving here and it is provably from who it says", then it has to
   * be rare enough that seeing it is information.
   */
  lit: boolean;
  /**
   * Something here wants looking at: the read failed, or the newest message did
   * not verify against the key it names.
   *
   * A message that carries NO signature is not in here. Most traffic on this
   * network is unsigned, and drawing an unsigned room as alarming would turn the
   * ordinary case into the alarming one — which is the same mistake as lighting
   * every watched room, made in the other direction.
   */
  alarming: boolean;
  watched: boolean;
  ratePerMin: number | null;
  rateSpanMs: number | null;
  /** See Reading.series. Empty for a room Foolscap has not read twice. */
  series: number[];
  newestTsMs: number | null;
  readAt: number | null;
  error: string | null;
  /** Bytes held in the ring, and that as a share of the largest ring surveyed. */
  bytes: number | null;
  ringFill: number | null;
  idleSeconds: number | null;
  /** UNTRUSTED — a note any caller can set on any room. */
  topic: string | null;
  zeroResponseShare: number | null;
  nickDiversity: number | null;
  surveyLastSeq: number | null;
}

export interface City {
  rooms: CityRoom[];
  layout: RadialLayout;
  /** How far the survey has fallen behind, measured rather than assumed. */
  surveyLag: SurveyLag;
  /** Messages a minute across the rooms Foolscap reads. The page's one answer. */
  watchedRate: number | null;
  watchedCounts: {
    live: number;
    quiet: number;
    failing: number;
    measured: number;
    /** Live AND verifying. The only rooms on the page that take the accent. */
    lit: number;
  };
}

export interface SurveyLag {
  ms: number | null;
  /** Rooms the estimate was computed from. */
  samples: number;
}

// --- the height scale -------------------------------------------------------
//
// Volumes run from single figures to fifty million, so the scale is logarithmic
// or it is nothing: linear would make every room but the lobby a paving slab.
// The floor is deliberate — under a hundred messages a room is a stub, and giving
// stubs visible height would imply a distinction that is not there.
//
// THE FLOOR IS A BUILDING, NOT A TILE, which is what it was. At 0.28 units a
// stub drew about two pixels tall at the default framing, and two pixels of
// height on a shape whose top face is fully lit is not a block, it is a
// diamond — so a city of two hundred rooms, most of them stubs, read as a
// scatter of flat tiles with eight towers in it. The figures below are set in
// world units against what they come out as on screen: at 1440 the plan's
// frustum puts about seven pixels of screen on a world unit of height, so the
// floor is six pixels and the ceiling ninety.
//
// The ceiling is a clamp rather than a compression: nothing on this network is
// near it — the lobby, at fifty-three million, lands two units under — and a
// room that did exceed it would be drawn at the same height as the lobby rather
// than flattening every other building to make room for it.

const HEIGHT_FLOOR_MESSAGES = 100;
/** ~6px at the default framing. A stub is a low block, not a tile. */
const HEIGHT_MIN = 0.85;
/** ~90px. Nothing reaches it; it is there so nothing ever can run away with it. */
const HEIGHT_MAX = 12.9;
/** World units per tenfold increase in messages. */
export const HEIGHT_PER_DECADE = 2.05;

export function heightFor(volume: number): number {
  // No `+ 1` softening inside the log: Math.max already keeps it defined at zero,
  // and the extra one would make a decade near the floor measurably shorter than
  // a decade near the top. The whole point of the scale is that the step is the
  // same wherever you are on it.
  const decades = Math.log10(Math.max(1, volume)) - Math.log10(HEIGHT_FLOOR_MESSAGES);
  return Math.min(HEIGHT_MAX, HEIGHT_MIN + HEIGHT_PER_DECADE * Math.max(0, decades));
}

// --- the footprint ----------------------------------------------------------

/**
 * How much ground one room's building takes, from how many rooms share the
 * district it stands in.
 *
 * NOT A PROPERTY OF THE ROOM, and the legend says so. Three rooms on a plot
 * this size can each have a wide footprint; a hundred and thirty mailboxes
 * cannot, and drawing them as if they could would either overlap them or
 * inflate the district until it swallowed the plan. So the size is the
 * district's crowding, which is a real figure — it is the count printed in the
 * list — expressed as how much room each building gets.
 *
 * Three sizes rather than a curve: a continuous footprint would look like a
 * measurement of the room itself, and this is not one. Three sizes read as
 * three kinds of place.
 *
 * Every one is under LOT, which is the spacing the layout uses, and the largest
 * is under the tightest pitch any form packs at — the stack's, at LOT * 0.78 —
 * so the caps on two neighbouring buildings cannot touch.
 */
export const LOT_ROOMY = 3;
export const LOT_TIGHT = 16;

export function footprintFor(roomsInDistrict: number): number {
  if (roomsInDistrict <= LOT_ROOMY) return 1.5;
  if (roomsInDistrict < LOT_TIGHT) return 1.26;
  return 1.0;
}

// --- brightness -------------------------------------------------------------

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Rate, on a log curve, so a busy room and a very busy room stay tellable apart. */
function activityFromRate(ratePerMin: number): number {
  return clamp01(Math.log10(Math.max(0, ratePerMin) + 1) / Math.log10(10_001));
}

/** Falls to nothing over QUIET_MS. Used until a rate has been measured. */
function activityFromAge(ageMs: number): number {
  return clamp01(1 - ageMs / QUIET_MS);
}

// --- assembling -------------------------------------------------------------

export interface BuildInput {
  survey: RoomSummary[];
  readings: Map<string, Reading>;
  /** Rooms Foolscap intends to read, whether or not it has managed to yet. */
  watched: string[];
  now: number;
  /**
   * A layout computed earlier, reused.
   *
   * Placement is volume-ordered, and volumes only ever grow, so recomputing it on
   * every reading would eventually swap two buildings that crossed — the city
   * would rearrange itself under the reader for no reason they could see. The
   * caller holds the layout for as long as the set of rooms is unchanged.
   */
  layout?: RadialLayout;
}

export function buildCity({ survey, readings, watched, now, layout: given }: BuildInput): City {
  const watchedSet = new Set(watched);
  const surveyByRoom = new Map(survey.map((entry) => [entry.room, entry]));

  // Every room either source knows about. A watched room absent from the survey
  // still gets a building — the survey lists the busiest fifty of tens of
  // thousands, and the contest rooms are not among them.
  const names = new Set<string>([...surveyByRoom.keys(), ...watchedSet]);

  const largestRing = survey.reduce((n, entry) => Math.max(n, entry.bytes), 0);

  // How many rooms each district holds, which is what a building's footprint is
  // decided from. Counted before anything is placed, so the first room in a
  // district is the same size as the last.
  const perDistrict = new Map<string, number>();
  for (const name of names) {
    const id = districtFor(name).id;
    perDistrict.set(id, (perDistrict.get(id) ?? 0) + 1);
  }

  const rooms: CityRoom[] = [];
  for (const name of names) {
    const summary = surveyByRoom.get(name) ?? null;
    const reading = readings.get(name) ?? null;
    const isWatched = watchedSet.has(name);

    const volume = Math.max(reading?.lastSeq ?? 0, summary?.lastSeq ?? 0);
    const ageMs = reading?.newestTsMs != null ? now - reading.newestTsMs : null;

    let activity = 0;
    let activityBasis: CityRoom['activityBasis'] = 'none';
    if (reading && reading.ratePerMin != null) {
      activity = activityFromRate(reading.ratePerMin);
      activityBasis = 'read';
    } else if (ageMs != null) {
      activity = activityFromAge(ageMs);
      activityBasis = 'read';
    }
    // Nothing else. The survey carries an `idle_seconds` and it is tempting, but
    // it reports 0 to 4 seconds for every room it lists — it lists the busiest
    // fifty, so of course it does — and it is minutes stale besides. Using it
    // would paint the whole city bright and mean "these are all busy right now",
    // which is a claim the number cannot support. An unread room is drawn flat.

    let state: RoomState = 'unwatched';
    if (isWatched && reading?.error) state = 'failing';
    else if (isWatched && reading) {
      const busy = (reading.ratePerMin ?? 0) > 0;
      const recent = ageMs != null && ageMs < LIVE_MS;
      state = busy || recent ? 'live' : 'quiet';
    }

    // THE ACCENT, DECIDED ONCE. Live is not enough and never was: a room can be
    // taking twenty messages a second that nobody has signed, and lighting it
    // would be this page saying "something is provably happening here" about
    // traffic it cannot vouch for a word of.
    const proof = reading?.proof ?? null;
    const lit = state === 'live' && proof === 'verified';
    const alarming = state === 'failing' || proof === 'failed';

    const districtId = districtFor(name).id;
    rooms.push({
      room: name,
      districtId,
      x: 0,
      z: 0,
      height: heightFor(volume),
      footprint: footprintFor(perDistrict.get(districtId) ?? 1),
      volume,
      volumeRead: reading != null && reading.lastSeq >= (summary?.lastSeq ?? 0),
      activity,
      activityBasis,
      state,
      proof,
      lit,
      alarming,
      watched: isWatched,
      ratePerMin: reading?.ratePerMin ?? null,
      rateSpanMs: reading?.rateSpanMs ?? null,
      series: reading?.series ?? [],
      newestTsMs: reading?.newestTsMs ?? null,
      readAt: reading?.readAt ?? null,
      error: reading?.error ?? null,
      bytes: summary?.bytes ?? null,
      ringFill: summary && largestRing > 0 ? summary.bytes / largestRing : null,
      idleSeconds: summary?.idleSeconds ?? null,
      topic: summary?.topic ?? null,
      zeroResponseShare: summary?.zeroResponseShare ?? null,
      nickDiversity: summary?.nickDiversity ?? null,
      surveyLastSeq: summary?.lastSeq ?? null,
    });
  }

  const layout =
    given ?? layoutRadial(rooms.map((room) => ({ room: room.room, volume: room.volume })));
  for (const room of rooms) {
    const placement = layout.placements.get(room.room);
    if (placement) {
      room.x = placement.x;
      room.z = placement.z;
    }
  }
  // Stable order for the list, and for the instance indices the canvas assigns.
  rooms.sort((a, b) => b.volume - a.volume || a.room.localeCompare(b.room));

  const measured = rooms.filter((room) => room.watched && room.ratePerMin != null);
  const watchedRate = measured.length
    ? measured.reduce((n, room) => n + (room.ratePerMin ?? 0), 0)
    : null;

  return {
    rooms,
    layout,
    surveyLag: estimateSurveyLag(rooms),
    watchedRate,
    watchedCounts: {
      live: rooms.filter((r) => r.state === 'live').length,
      quiet: rooms.filter((r) => r.state === 'quiet').length,
      failing: rooms.filter((r) => r.state === 'failing').length,
      measured: measured.length,
      lit: rooms.filter((r) => r.lit).length,
    },
  };
}

/**
 * How stale the survey is, in time rather than in adjectives.
 *
 * The survey carries no timestamp, so there is nothing to read off it. What there
 * is instead: for any room Foolscap reads directly, the difference between the
 * room's true message count and the survey's figure is how many messages went by
 * since the snapshot, and the measured rate converts that into minutes.
 *
 * The median across rooms, not the mean — one room that burst since the snapshot
 * would drag an average badly, and the answer is only ever offered as an order of
 * magnitude anyway.
 *
 * A TRICKLE CANNOT DATE A BACKLOG. Dividing by a rate near zero is where this
 * estimate falls apart: a room reporting a twentieth of a message a minute, with
 * two thousand messages of backlog, says the snapshot is a fortnight old — and
 * the page printed exactly that, "363 hours behind", for the few seconds before
 * the busier rooms had been read twice. The arithmetic is not wrong; the premise
 * is. It assumes the room has always run at the rate it is running now, which is
 * least true of a room that has gone quiet. Under a message a minute the sample
 * is dropped rather than softened: there is nothing to soften, the number is
 * simply not evidence.
 */
const LAG_MIN_RATE_PER_MIN = 1;

export function estimateSurveyLag(rooms: CityRoom[]): SurveyLag {
  const estimates: number[] = [];
  for (const room of rooms) {
    if (room.surveyLastSeq == null || !room.volumeRead) continue;
    if (room.ratePerMin == null || room.ratePerMin < LAG_MIN_RATE_PER_MIN) continue;
    const behind = room.volume - room.surveyLastSeq;
    if (behind <= 0) continue;
    estimates.push((behind / room.ratePerMin) * 60_000);
  }
  if (estimates.length === 0) return { ms: null, samples: 0 };
  estimates.sort((a, b) => a - b);
  const mid = Math.floor(estimates.length / 2);
  const ms =
    estimates.length % 2 === 1
      ? estimates[mid]
      : (estimates[mid - 1] + estimates[mid]) / 2;
  return { ms, samples: estimates.length };
}
