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
import { districtFor, layoutCity, type Layout } from './districts.ts';

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
  /** Set when the most recent attempt to read this room failed. */
  error: string | null;
}

export type RoomState = 'live' | 'quiet' | 'failing' | 'unwatched';

export interface CityRoom {
  /** UNTRUSTED — the name its creator chose. See districts.ts. */
  room: string;
  districtId: string;
  x: number;
  z: number;
  /** World units. A log scale; the real figure is in `volume`. */
  height: number;
  /** Messages the room has carried, from the better of the two sources. */
  volume: number;
  /** True where `volume` came from a read Foolscap made itself. */
  volumeRead: boolean;
  /** 0–1, drives brightness. Zero where nothing was measured. */
  activity: number;
  activityBasis: 'read' | 'none';
  state: RoomState;
  watched: boolean;
  ratePerMin: number | null;
  rateSpanMs: number | null;
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
  layout: Layout;
  /** How far the survey has fallen behind, measured rather than assumed. */
  surveyLag: SurveyLag;
  /** Messages a minute across the rooms Foolscap reads. The page's one answer. */
  watchedRate: number | null;
  watchedCounts: { live: number; quiet: number; failing: number; measured: number };
}

export interface SurveyLag {
  ms: number | null;
  /** Rooms the estimate was computed from. */
  samples: number;
}

// --- the height scale -------------------------------------------------------
//
// Volumes run from single figures to forty million, so the scale is logarithmic
// or it is nothing: linear would make every room but the lobby a paving slab.
// The floor is deliberate — under a hundred messages a room is a stub, and giving
// stubs visible height would imply a distinction that is not there.

const HEIGHT_FLOOR_MESSAGES = 100;
const HEIGHT_MIN = 0.28;
/** World units per tenfold increase in messages. */
export const HEIGHT_PER_DECADE = 1.55;

export function heightFor(volume: number): number {
  // No `+ 1` softening inside the log: Math.max already keeps it defined at zero,
  // and the extra one would make a decade near the floor measurably shorter than
  // a decade near the top. The whole point of the scale is that the step is the
  // same wherever you are on it.
  const decades = Math.log10(Math.max(1, volume)) - Math.log10(HEIGHT_FLOOR_MESSAGES);
  return HEIGHT_MIN + HEIGHT_PER_DECADE * Math.max(0, decades);
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
  layout?: Layout;
}

export function buildCity({ survey, readings, watched, now, layout: given }: BuildInput): City {
  const watchedSet = new Set(watched);
  const surveyByRoom = new Map(survey.map((entry) => [entry.room, entry]));

  // Every room either source knows about. A watched room absent from the survey
  // still gets a building — the survey lists the busiest fifty of tens of
  // thousands, and the contest rooms are not among them.
  const names = new Set<string>([...surveyByRoom.keys(), ...watchedSet]);

  const largestRing = survey.reduce((n, entry) => Math.max(n, entry.bytes), 0);

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

    rooms.push({
      room: name,
      districtId: districtFor(name).id,
      x: 0,
      z: 0,
      height: heightFor(volume),
      volume,
      volumeRead: reading != null && reading.lastSeq >= (summary?.lastSeq ?? 0),
      activity,
      activityBasis,
      state,
      watched: isWatched,
      ratePerMin: reading?.ratePerMin ?? null,
      rateSpanMs: reading?.rateSpanMs ?? null,
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

  const layout = given ?? layoutCity(rooms.map((room) => ({ room: room.room, volume: room.volume })));
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
 */
export function estimateSurveyLag(rooms: CityRoom[]): SurveyLag {
  const estimates: number[] = [];
  for (const room of rooms) {
    if (room.surveyLastSeq == null || !room.volumeRead) continue;
    if (room.ratePerMin == null || room.ratePerMin <= 0) continue;
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
