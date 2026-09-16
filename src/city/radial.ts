// radial.ts — the city as concentric rings around a centre.
//
// Pure and deterministic: the same survey lays out the same city every time.
// That matters more than it sounds. A room that moved between loads would make
// the picture unreadable AS a picture, and anyone comparing two screenshots
// would be comparing noise.
//
// ---------------------------------------------------------------------------
// WHY RADIAL, AND WHAT THE RADIUS MEANS
//
// The rectangular field this replaces was honest and said nothing. Districts sat
// in rows because rows are how you pack rectangles, so a reader could learn
// where a district was and never learn anything from where it was. Every
// position on the plan was arbitrary.
//
// Here one thing is not arbitrary: DISTANCE FROM THE CENTRE IS VOLUME RANK. The
// district carrying the most messages sits innermost, the least outermost, and
// the ranks in between are evenly spaced across the band. A reader who notices
// that Pairs sits out by the wall has learned something true about the network
// — and it is a rank, not a quantity, which is why the panel prints the figures
// and the picture only orders them.
//
// Angle means NOTHING and must not be made to. It is packing, and packing only:
// each zone takes whatever arc it needs at its own radius. If a reader could
// learn something from the compass bearing of a district, this file would be
// claiming an authority the survey cannot support.
//
// ---------------------------------------------------------------------------
// HOW THE RINGS ARE GUARANTEED TO CLOSE
//
// The hard part of a radial plan is that a zone's angular width depends on its
// radius, and its radius is supposed to come from its rank. Solving those
// together usually means giving up on one of them.
//
// It does not here, because of one property: scaling every radius by the same
// factor divides every angular width by that same factor. So:
//
//   1. radius from rank, evenly across the band
//   2. the arc each zone needs at that radius, plus a gap
//   3. if the total exceeds a full turn, multiply EVERY radius by the overflow
//
// After step 3 the arcs sum to exactly a turn, the ring closes, and the rank
// order is untouched — because every radius moved by the same factor, which
// cannot reorder anything. The city grows rather than the districts shrinking,
// which is also the honest direction: the plan gets bigger when there is more
// in it.

import { DISTRICTS, districtFor, type District } from './districts.ts';

/** World units between the centres of two adjacent buildings. */
export const LOT = 2.2;

/** The hole in the middle. Nothing is drawn inside it; the spokes start here. */
export const CORE_RADIUS = 4;

/** Where the innermost zone's centre sits, and where the outermost one does. */
const BAND_INNER = 10;
const BAND_OUTER = 26;

/** Blank arc between two neighbouring zones, in radians. */
const ZONE_GAP = 0.13;

/** Clear ground between the outermost zone's edge and the wall. */
const WALL_GAP = 3.5;

/** How far outside the wall a district's numbered label sits. */
const LABEL_GAP = 3.2;

/**
 * Where the overflow label is anchored, in radians.
 *
 * Due south in world terms, which is the bottom of the plan at the default
 * camera. Reserved: no zone is placed here, so the one label on this page that
 * is about the rooms NOT drawn always has clear ground under it.
 */
export const OVERFLOW_ANGLE = Math.PI / 2;

// ---------------------------------------------------------------------------
// Built form
// ---------------------------------------------------------------------------

/**
 * How a district's rooms are arranged on its own ground.
 *
 * FORM CARRIES WHAT COLOUR IS NOT ALLOWED TO. The mass of this city is one grey;
 * the accent is reserved for a room that is live and whose traffic verifies. So
 * the only thing left to tell one district from another at a glance is its
 * shape, and a shape that was assigned rather than derived would be decoration
 * pretending to be information.
 *
 *   ring     rooms evenly on a circle. Says PEERS: no room is first, and the
 *            arrangement has no centre to be at.
 *   stepped  concentric square rings, volume-sorted outward from the middle, so
 *            the district reads as a ziggurat. Says ORDERED STAGES.
 *   grid     regular rows and columns. Says REGULAR and claims nothing else.
 *   stack    two tight columns, shoulder to shoulder. Says DEPTH: a few rooms
 *            carrying an enormous amount between them.
 */
export type Form = 'ring' | 'stepped' | 'grid' | 'stack';

/** At or above this many rooms, a district is drawn as peers on a circle. */
export const RING_MIN = 10;

/**
 * The form a district takes, from its own character.
 *
 * Order matters and the first rule is the strongest: a contest is a sequence of
 * stages — register, submit, vote — and its rooms carry wildly different
 * volumes because of where they sit in that sequence. A ziggurat is the one
 * shape here that says "these are steps of one thing", and it stays the contest's
 * whatever its room count does.
 *
 * Everything after that is quantity. Ten near-identical mailboxes are peers and
 * get a circle. A handful of rooms carrying tens of millions of messages between
 * them are depth and get a slab. What is left is regular and gets a grid, which
 * is the shape that asserts the least — the right default for a district whose
 * only common property is that its rooms matched the same name pattern.
 */
export function formFor(zone: { kind: District['kind']; count: number }): Form {
  if (zone.kind === 'contest') return 'stepped';
  if (zone.count >= RING_MIN) return 'ring';
  if (zone.kind === 'chat') return 'stack';
  return 'grid';
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Local offsets for `count` rooms, in world units, centred on the origin. */
function offsetsFor(form: Form, count: number): Array<[number, number]> {
  if (count === 0) return [];
  switch (form) {
    case 'ring': {
      // A radius that gives each room a lot of arc to itself. Floored, or three
      // rooms on a circle would sit closer than three in a row.
      const radius = Math.max(LOT, (count * LOT) / (2 * Math.PI));
      return Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number];
      });
    }
    case 'stepped': {
      // Concentric square rings: 1 at the centre, then 8, then 16, then 24.
      // Callers hand this volume-sorted members, so the tallest lands in the
      // middle and the district steps down as it goes out.
      const out: Array<[number, number]> = [];
      let ring = 0;
      while (out.length < count) {
        if (ring === 0) {
          out.push([0, 0]);
        } else {
          const side = ring * 2 + 1;
          for (let i = 0; i < side * side - (side - 2) * (side - 2) && out.length < count; i++) {
            // Walk the perimeter of the square ring, starting at a corner.
            const perimeter = (side - 1) * 4;
            const step = i % perimeter;
            const half = ring;
            let cx: number;
            let cz: number;
            if (step < side - 1) {
              cx = -half + step;
              cz = -half;
            } else if (step < 2 * (side - 1)) {
              cx = half;
              cz = -half + (step - (side - 1));
            } else if (step < 3 * (side - 1)) {
              cx = half - (step - 2 * (side - 1));
              cz = half;
            } else {
              cx = -half;
              cz = half - (step - 3 * (side - 1));
            }
            out.push([cx * LOT, cz * LOT]);
          }
        }
        ring++;
        // A guard, not a limit: without it a malformed count would spin here.
        if (ring > 64) break;
      }
      return out.slice(0, count);
    }
    case 'stack': {
      // Two columns, shoulder to shoulder. Tighter than a lot, on purpose: a
      // stack is meant to read as one mass rather than as separate towers.
      const pitch = LOT * 0.78;
      const rows = Math.ceil(count / 2);
      return Array.from({ length: count }, (_, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        return [(col - 0.5) * pitch, (row - (rows - 1) / 2) * pitch] as [number, number];
      });
    }
    case 'grid':
    default: {
      const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
      const rows = Math.ceil(count / cols);
      return Array.from({ length: count }, (_, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return [(col - (cols - 1) / 2) * LOT, (row - (rows - 1) / 2) * LOT] as [number, number];
      });
    }
  }
}

/** The radius a set of local offsets actually occupies, plus a building's half. */
function radiusOf(offsets: Array<[number, number]>): number {
  let most = 0;
  for (const [x, z] of offsets) most = Math.max(most, Math.hypot(x, z));
  return most + LOT * 0.7;
}

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

export interface Zone {
  district: District;
  form: Form;
  /** 1-based, and what the leader line's label says. Innermost is 1. */
  index: number;
  /** Centre of the zone, in world units. */
  x: number;
  z: number;
  /** Polar form of the same point, which the canvas draws spokes along. */
  angle: number;
  radius: number;
  /** Angular width of the zone's sector, gap excluded. */
  span: number;
  /** How much ground it occupies, as a radius about its own centre. */
  plotRadius: number;
  count: number;
  /** Messages the district's rooms have carried between them. */
  volume: number;
  /** Where the leader line ends and the numbered label sits. */
  labelX: number;
  labelZ: number;
}

export interface Placement {
  room: string;
  districtId: string;
  x: number;
  z: number;
}

export interface RadialLayout {
  placements: Map<string, Placement>;
  zones: Zone[];
  /** The outer wall. Everything drawn is inside it. */
  wallRadius: number;
  /** Half the extent of everything including labels, for framing the camera. */
  radius: number;
}

/**
 * Lay the city out in rings.
 *
 * Rooms are grouped by district, sorted by descending volume — and by name on a
 * tie, which is the line that makes the whole thing stable across loads: two
 * rooms with identical volume must not be able to swap places.
 */
export function layoutRadial(rooms: { room: string; volume: number }[]): RadialLayout {
  const grouped = new Map<string, { room: string; volume: number }[]>();
  for (const entry of rooms) {
    const id = districtFor(entry.room).id;
    const list = grouped.get(id);
    if (list) list.push(entry);
    else grouped.set(id, [entry]);
  }

  const blocks = DISTRICTS.filter((district) => grouped.has(district.id)).map((district) => {
    const members = grouped.get(district.id)!;
    members.sort((a, b) => b.volume - a.volume || a.room.localeCompare(b.room));
    const form = formFor({ kind: district.kind, count: members.length });
    const offsets = offsetsFor(form, members.length);
    return {
      district,
      members,
      form,
      offsets,
      plotRadius: radiusOf(offsets),
      volume: members.reduce((n, member) => n + member.volume, 0),
    };
  });

  const placements = new Map<string, Placement>();
  if (blocks.length === 0) {
    return { placements, zones: [], wallRadius: CORE_RADIUS + WALL_GAP, radius: CORE_RADIUS + WALL_GAP };
  }

  // --- 1. radius from rank -------------------------------------------------
  // Busiest innermost. Ties broken by label so the order cannot wobble between
  // loads on two districts that happen to carry the same amount.
  const ranked = [...blocks].sort(
    (a, b) => b.volume - a.volume || a.district.label.localeCompare(b.district.label)
  );
  const last = Math.max(1, ranked.length - 1);
  const radii = ranked.map((_, rank) => BAND_INNER + (rank / last) * (BAND_OUTER - BAND_INNER));

  // --- 2. the arc each one needs at that radius ----------------------------
  const needed = ranked.map((block, i) => (2 * block.plotRadius) / radii[i]);
  const reserved = OVERFLOW_SPAN + ZONE_GAP;
  const total = needed.reduce((n, arc) => n + arc, 0) + ZONE_GAP * ranked.length + reserved;

  // --- 3. one scale factor, so the ring closes and the ranks survive -------
  const turn = Math.PI * 2;
  const scale = total > turn ? total / turn : 1;
  const scaled = radii.map((radius) => radius * scale);
  const spans = needed.map((arc) => arc / scale);

  // --- 4. walk the circle --------------------------------------------------
  // Starting a half-gap past the reserved overflow slot, so the first zone does
  // not butt up against the one label that has nowhere else to go.
  let cursor = OVERFLOW_ANGLE + OVERFLOW_SPAN / 2 + ZONE_GAP;
  const zones: Zone[] = [];

  ranked.forEach((block, i) => {
    const span = spans[i];
    const radius = scaled[i];
    const angle = cursor + span / 2;
    cursor += span + ZONE_GAP;

    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    // The zone's own frame is turned to face the centre, so a grid's rows run
    // across the radius rather than at whatever angle the packing happened to
    // land on. Without it the forms read as scattered rather than as placed.
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    block.members.forEach((member, j) => {
      const [lx, lz] = block.offsets[j] ?? [0, 0];
      placements.set(member.room, {
        room: member.room,
        districtId: block.district.id,
        x: x + lx * cos - lz * sin,
        z: z + lx * sin + lz * cos,
      });
    });

    zones.push({
      district: block.district,
      form: block.form,
      index: i + 1,
      x,
      z,
      angle,
      radius,
      span,
      plotRadius: block.plotRadius,
      count: block.members.length,
      volume: block.volume,
      labelX: 0,
      labelZ: 0,
    });
  });

  // --- 5. the wall, and the leader lines out to it -------------------------
  const wallRadius = Math.max(...zones.map((zone) => zone.radius + zone.plotRadius)) + WALL_GAP;
  const labelRadius = wallRadius + LABEL_GAP;
  for (const zone of zones) {
    zone.labelX = Math.cos(zone.angle) * labelRadius;
    zone.labelZ = Math.sin(zone.angle) * labelRadius;
  }

  return { placements, zones, wallRadius, radius: labelRadius };
}

/** The arc kept clear for the overflow label. Not a zone; nothing is placed in it. */
export const OVERFLOW_SPAN = 0.42;

/**
 * Where the overflow label hangs: outside the wall, in its reserved slot.
 *
 * "N more public rooms, not named to this page" is the one label here that is
 * about what is absent, and absence is the thing this whole site is careful
 * about. The survey returns the busiest fifty of tens of thousands; drawing
 * those fifty and saying nothing would leave a reader with a picture of a
 * network that looks complete and is not.
 */
export function overflowAnchor(wallRadius: number): { x: number; z: number } {
  const radius = wallRadius + LABEL_GAP;
  return { x: Math.cos(OVERFLOW_ANGLE) * radius, z: Math.sin(OVERFLOW_ANGLE) * radius };
}
