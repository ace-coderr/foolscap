// board.ts — two kinds of reading, made into one board.
//
// The same split the City makes, for the same reason, because the notes store
// has exactly the same shape of problem:
//
//   THE LISTING   GET /kv/<ns>, one request per land. It returns every key, so
//                 it establishes the board completely: which plots exist, where
//                 each one sits, who is next to whom. And because the server
//                 deletes a note unwritten for seven days, a key being in the
//                 list is proof somebody wrote it this week. That is the whole
//                 of what the listing knows. It does not carry a value.
//
//   THE NOTES     GET /kv/<ns>/<key>, one request per plot. This is where the
//                 holder is, and the timestamps, and the signature. It is also
//                 one request PER PLOT, so on a board of any size Foolscap has
//                 read some of them and not the others, and which ones changes
//                 minute by minute.
//
// So a plot has three states and the board keeps them apart to the surface: not
// read, read and attributed, read and not attributed. An unread plot is drawn as
// a flat tile at the dim end of the scale, and the page says how many there are.
// It is never drawn as unclaimed — the difference between "nobody holds this"
// and "Foolscap has not looked" is the entire difference between a map and a
// guess, and it is the one this file exists to protect.
//
// HEIGHT IS A CLAIM. It comes from the writer's own `claimed_at`, which nothing
// can check (rules.ts explains why at length). A player who backdates it gets a
// tower. That is a property of the game, not a bug in it, and the page states it
// beside the board rather than letting a skyline imply a measurement.

import { layoutCity, type District, type Layout, type Plot } from '../city/districts.ts';
import type { Building } from '../city/CityCanvas.tsx';
import { DANGER_MS, DECAY_MS, districtOf, longestRun, type ClaimFault, type Holding } from './rules.ts';

/** `<ns>/<key>` — a plot's identity everywhere, and what the canvas reports back. */
export const plotId = (ns: string, key: string): string => `${ns}/${key}`;

export function splitPlotId(id: string): { ns: string; key: string } | null {
  const cut = id.indexOf('/');
  if (cut <= 0) return null;
  return { ns: id.slice(0, cut), key: id.slice(cut + 1) };
}

/** What one note read established, or the absence of one. */
export interface NoteReading {
  value: string | null;
  holding: Holding;
  readAt: number;
  error: string | null;
}

export interface BoardPlot extends Building {
  ns: string;
  key: string;
  /** The land and the prefix, as one label. Districts do not cross namespaces. */
  districtId: string;
  prefix: string;
  /** Position in its land's sorted key order. Adjacency is defined on this. */
  index: number;
  /** Null until the note has been read. Never a claim that nobody holds it. */
  holder: string | null;
  fault: ClaimFault | null;
  read: boolean;
  readAt: number | null;
  error: string | null;
  heldMs: number | null;
  reclaimInMs: number | null;
  /** True when the note read gave a real renewal time, rather than the 7-day bound. */
  reclaimExact: boolean;
  /** Held by the DID the visitor connected, and verified. Drives the accent. */
  mine: boolean;
}

export interface Standing {
  did: string;
  plots: number;
  /** The longest single hold among their plots, as that plot's writer states it. */
  longestHeldMs: number;
  /** The longest run of adjacent plots they hold in any one land. */
  largestBlock: number;
}

export interface Board {
  plots: BoardPlot[];
  layout: Layout;
  districts: District[];
  lands: LandSummary[];
  standings: Standing[];
  counts: {
    plots: number;
    read: number;
    held: number;
    unattributed: number;
    inDanger: number;
    mine: number;
  };
}

export interface LandSummary {
  ns: string;
  /** Plots ON THE BOARD. Capped; see MAX_PLOTS_PER_LAND. */
  plots: number;
  /** Plots the land actually has. Larger than `plots` where the cap bit. */
  total: number;
  read: number;
  listedAt: number | null;
  error: string | null;
}

// --- the two scales ---------------------------------------------------------

/**
 * Height: world units per day held, as claimed.
 *
 * Linear, not logarithmic like the City's. The City spans single figures to
 * forty million messages and has no choice; this spans hours to weeks, and a log
 * scale over two decades would flatten exactly the difference the game is about
 * — a plot held nine days against one held two is the whole story, and both sit
 * inside one decade.
 */
const HEIGHT_PER_DAY = 0.46;
/** A read plot always has some volume, so it is not mistaken for an unread tile. */
const HEIGHT_READ_MIN = 0.34;
/** An unread plot is a paving slab: on the board, visibly not a building. */
const HEIGHT_UNREAD = 0.1;
/** Past this, extra days stop adding height. Nothing here needs a mile-high tower. */
const HEIGHT_CAP = 7.5;

export function heightForHold(heldMs: number | null): number {
  if (heldMs == null) return HEIGHT_UNREAD;
  const days = Math.max(0, heldMs) / 86_400_000;
  return Math.min(HEIGHT_CAP, HEIGHT_READ_MIN + days * HEIGHT_PER_DAY);
}

/**
 * Brightness: how much of the seven days is left, on the writer's own figure.
 *
 * Linear in time remaining, so the last day of a plot's life is a seventh of the
 * range and visibly the dim end. That is the tension the game runs on and it is
 * the same for every viewer at once — nobody has a private view of who is about
 * to lose something.
 *
 * An unread plot gets 0, which puts it at the same end as a plot about to fall.
 * They are told apart by HEIGHT — a tile against a tower — rather than by a
 * second colour, because the brightness scale has one dimension and giving it
 * two meanings that could be confused is how a board starts lying.
 */
export function brightnessFor(reclaimInMs: number | null): number {
  if (reclaimInMs == null) return 0;
  return Math.max(0, Math.min(1, reclaimInMs / DECAY_MS));
}

// --- assembling -------------------------------------------------------------

export interface BuildBoardInput {
  /** Every land Holdfast watches, and the keys last listed in it. */
  listings: Map<string, { keys: string[]; total?: number; listedAt: number | null; error: string | null }>;
  /** Keyed by plotId. Missing means the note has not been read. */
  readings: Map<string, NoteReading>;
  /** The visitor's did:key, or null. Public identifier; never a secret. */
  connected: string | null;
  now: number;
  /** Reused while the set of plots is unchanged — see buildCity for why. */
  layout?: Layout;
}

export function buildBoard({
  listings,
  readings,
  connected,
  now,
  layout: given,
}: BuildBoardInput): Board {
  const plots: BoardPlot[] = [];
  const lands: LandSummary[] = [];
  /** Holder per land, in key order, for the contiguity scan. */
  const byLand = new Map<string, (string | null)[]>();

  for (const [ns, listing] of listings) {
    const holders: (string | null)[] = [];
    let read = 0;

    listing.keys.forEach((key, index) => {
      const id = plotId(ns, key);
      const reading = readings.get(id) ?? null;
      const holding = reading?.holding ?? null;
      const holder = holding?.claim?.did ?? null;
      if (reading) read++;
      holders.push(holder);

      const heldMs = holding?.heldMs ?? null;
      // The seven-day bound applies to every listed plot whether or not its note
      // has been read — the server deleted it otherwise — so an unread plot has
      // a reclaim time of "within a week", which is true and useless. It is kept
      // null rather than shown as a countdown, because a countdown that is
      // really a bound would be the page inventing precision.
      const reclaimInMs = reading && holding?.reclaimExact ? holding.reclaimInMs : null;
      const mine = connected != null && holder === connected;

      plots.push({
        room: id,
        ns,
        key,
        prefix: districtOf(key),
        districtId: `${ns}:${districtOf(key)}`,
        index,
        x: 0,
        z: 0,
        height: heightForHold(heldMs),
        activity: brightnessFor(reclaimInMs),
        // A roof, and therefore a state colour, only on plots the visitor holds.
        // Everything else on this board is monochrome: the accent means "yours"
        // here and it is the only thing it means.
        watched: mine,
        state: mine ? 'live' : 'unwatched',
        holder,
        fault: holding?.fault ?? null,
        read: reading != null,
        readAt: reading?.readAt ?? null,
        error: reading?.error ?? null,
        heldMs,
        reclaimInMs,
        reclaimExact: holding?.reclaimExact === true,
        mine,
      });
    });

    byLand.set(ns, holders);
    lands.push({
      ns,
      plots: listing.keys.length,
      total: listing.total ?? listing.keys.length,
      read,
      listedAt: listing.listedAt,
      error: listing.error,
    });
  }

  // Districts are discovered rather than declared: nobody can know in advance
  // which prefixes players will invent. Ordered by land, then by size, then by
  // name — stable, so the board does not rearrange itself as plots arrive.
  const sizes = new Map<string, number>();
  for (const plot of plots) sizes.set(plot.districtId, (sizes.get(plot.districtId) ?? 0) + 1);
  const districts: District[] = [...sizes.entries()]
    .sort((a, b) => {
      const [ansA] = a[0].split(':');
      const [ansB] = b[0].split(':');
      return ansA.localeCompare(ansB) || b[1] - a[1] || a[0].localeCompare(b[0]);
    })
    .map(([id]) => {
      const [ns, prefix] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
      return {
        id,
        label: prefix,
        basis: `keys in ${ns} beginning “${prefix}”`,
        match: (room: string) => {
          const split = splitPlotId(room);
          return split != null && split.ns === ns && districtOf(split.key) === prefix;
        },
      };
    });

  // volume 0 throughout, which leaves layoutCity sorting inside a plot by name —
  // and name order IS adjacency here, so the board draws neighbours as
  // neighbours. See the note on layoutCity.
  const layout =
    given ?? layoutCity(plots.map((plot) => ({ room: plot.room, volume: 0 })), districts);
  for (const plot of plots) {
    const placement = layout.placements.get(plot.room);
    if (placement) {
      plot.x = placement.x;
      plot.z = placement.z;
    }
  }

  return {
    plots,
    layout,
    districts,
    lands,
    standings: standingsFor(plots, byLand, now),
    counts: {
      plots: plots.length,
      read: plots.filter((plot) => plot.read).length,
      held: plots.filter((plot) => plot.holder != null).length,
      unattributed: plots.filter((plot) => plot.read && plot.holder == null).length,
      inDanger: plots.filter(
        (plot) => plot.reclaimInMs != null && plot.reclaimInMs < DANGER_MS
      ).length,
      mine: plots.filter((plot) => plot.mine).length,
    },
  };
}

/**
 * The leaderboard, computed here in the browser from what has been read.
 *
 * Three numbers, and they measure three different things on purpose: holding a
 * lot of ground, holding one piece of it for a long time, and holding a piece
 * that is all in one place. A player can lead on any one of them without leading
 * on the others, which is what stops the game being a single race to claim
 * everything claimable.
 *
 * Sorted by plots, then block, then longest hold. Ties broken on the DID so the
 * order is stable between reads — two players on identical figures must not swap
 * places every time a note arrives.
 */
export function standingsFor(
  plots: BoardPlot[],
  byLand: Map<string, (string | null)[]>,
  now: number
): Standing[] {
  const table = new Map<string, Standing>();

  for (const plot of plots) {
    if (plot.holder == null) continue;
    const row =
      table.get(plot.holder) ??
      ({ did: plot.holder, plots: 0, longestHeldMs: 0, largestBlock: 0 } satisfies Standing);
    row.plots++;
    if (plot.heldMs != null && plot.heldMs > row.longestHeldMs) row.longestHeldMs = plot.heldMs;
    table.set(plot.holder, row);
  }

  // Contiguity is per land — a run cannot cross a namespace boundary, because
  // the last key of one land and the first of the next are not neighbours in any
  // sense a player could act on.
  for (const row of table.values()) {
    for (const holders of byLand.values()) {
      const run = longestRun(holders, row.did);
      if (run > row.largestBlock) row.largestBlock = run;
    }
  }

  void now;
  return [...table.values()].sort(
    (a, b) =>
      b.plots - a.plots ||
      b.largestBlock - a.largestBlock ||
      b.longestHeldMs - a.longestHeldMs ||
      (a.did < b.did ? -1 : a.did > b.did ? 1 : 0)
  );
}

/** Plot ids in the order they should be read next. Highest priority first. */
export function readOrder(board: Board, connected: string | null): string[] {
  const score = (plot: BoardPlot): number => {
    if (!plot.read) return 0; // never seen — the board is incomplete without it
    if (connected != null && plot.holder === connected) return 1; // yours, kept fresh
    return 2;
  };
  return board.plots
    .slice()
    .sort(
      (a, b) =>
        score(a) - score(b) ||
        (a.readAt ?? 0) - (b.readAt ?? 0) ||
        (a.room < b.room ? -1 : a.room > b.room ? 1 : 0)
    )
    .map((plot) => plot.room);
}

export type { Plot };
