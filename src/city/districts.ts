// districts.ts — grouping rooms, and putting them on the ground.
//
// Both halves are pure and deterministic. The same survey lays out the same city
// every time, which matters more than it sounds: a room that moved between loads
// would make the picture unreadable as a picture, and anyone comparing two
// screenshots would be comparing noise.
//
// THE HONEST CAVEAT, and it is load-bearing: a district is inferred from a room's
// NAME, and a room's name is a string its creator chose. The server says as much
// in the survey's own `untrusted` field. Nothing here is a claim about who runs a
// room or what it is for — anyone may create `mb-sonnet-2-registration-2` and it
// will land in the contest district next to the real one. The page has to say so
// rather than let the grouping imply an authority it does not have.

export interface District {
  id: string;
  label: string;
  /** What the grouping is actually keyed on, shown in the room detail. */
  basis: string;
  match: (room: string) => boolean;
}

/**
 * Ordered. The first match wins, so the specific patterns come before the broad
 * ones, and `other` catches whatever the survey turns up next week.
 */
export const DISTRICTS: District[] = [
  {
    id: 'contest',
    label: 'Contest',
    basis: 'named for the sonnet-2 contest',
    match: (room) => room.startsWith('mb-sonnet-2-') || room.startsWith('d-sonnet-2-'),
  },
  {
    id: 'commons',
    label: 'Commons',
    basis: 'one of the general rooms',
    match: (room) => ['lobby', 'meta', 'technocore', 'bots', 'web_chat', 'trading'].includes(room),
  },
  {
    id: 'flop',
    label: 'FLOP',
    basis: 'carries flop in its name',
    match: (room) => /flop/.test(room) || room === 'kibble',
  },
  {
    id: 'infra',
    label: 'Infrastructure',
    basis: 'named for a piece of protocol machinery',
    match: (room) =>
      /^(zk_|da_|gpu_|htlc_|e2e_|a2a_|poui_|cross_chain)/.test(room) || room === 'bridge',
  },
  {
    id: 'markets',
    label: 'Markets',
    basis: 'a token or offer room by name',
    match: (room) => room.startsWith('ca-') || room.startsWith('tclk-') || /coin|swap|token/.test(room),
  },
  {
    id: 'pairs',
    label: 'Pairs',
    basis: 'a two-party mailbox by name',
    match: (room) => room.startsWith('mb-'),
  },
  {
    id: 'outskirts',
    label: 'Outskirts',
    basis: 'matched none of the other patterns',
    match: () => true,
  },
];

const byId = new Map(DISTRICTS.map((d) => [d.id, d]));

export function districtFor(room: string): District {
  for (const district of DISTRICTS) {
    if (district.match(room)) return district;
  }
  // Unreachable while `outskirts` matches everything, and a thrown error here
  // would be a worse outcome than a room in the wrong place.
  return DISTRICTS[DISTRICTS.length - 1];
}

export function districtById(id: string): District | null {
  return byId.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** World units between the centres of two adjacent buildings. */
export const LOT = 2.2;
/**
 * Blank lots of street around each district's plot.
 *
 * Generous, because this is drawn in isometric: two plots that are clearly
 * separate on the ground overlap on screen, and a thin street disappears
 * entirely once the city is turned.
 */
export const STREET = 2.4;

export interface Plot {
  district: District;
  /** Plot centre, in world units, on the ground plane. */
  x: number;
  z: number;
  width: number;
  depth: number;
  count: number;
}

export interface Placement {
  room: string;
  districtId: string;
  x: number;
  z: number;
}

export interface Layout {
  placements: Map<string, Placement>;
  plots: Plot[];
  /** Half the width and depth of everything, for framing the camera. */
  radius: number;
}

/**
 * Lay the city out.
 *
 * Districts become rectangular plots, packed left to right into rows and wrapped
 * when a row gets wider than it is tall — a plan drawing rather than a skyline,
 * because the question the page answers is comparative and a skyline makes the
 * front row look important.
 *
 * Within a plot, rooms are sorted by descending volume and filled in rows, so the
 * tall buildings gather at one corner of each district instead of scattering. The
 * sort is by name on ties, which is what makes the layout stable across loads:
 * two rooms with identical volume must not be able to swap places.
 */
export function layoutCity(rooms: { room: string; volume: number }[]): Layout {
  const grouped = new Map<string, { room: string; volume: number }[]>();
  for (const entry of rooms) {
    const id = districtFor(entry.room).id;
    const list = grouped.get(id);
    if (list) list.push(entry);
    else grouped.set(id, [entry]);
  }

  // Plot dimensions first, in lots, before anything is given a position.
  const blocks = DISTRICTS.filter((d) => grouped.has(d.id)).map((district) => {
    const members = grouped.get(district.id)!;
    members.sort((a, b) => b.volume - a.volume || a.room.localeCompare(b.room));
    const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const rows = Math.ceil(members.length / cols);
    return { district, members, cols, rows };
  });

  // Wrap into rows of plots. The target width is the square root of the total
  // area, which keeps the city roughly square at any number of districts.
  const totalLots = blocks.reduce((n, b) => n + (b.cols + STREET) * (b.rows + STREET), 0);
  const targetWidth = Math.sqrt(totalLots) * 1.25;

  const placements = new Map<string, Placement>();
  const plots: Plot[] = [];

  let cursorX = 0;
  let cursorZ = 0;
  let rowDepth = 0;

  for (const block of blocks) {
    const width = block.cols + STREET;
    const depth = block.rows + STREET;

    if (cursorX > 0 && cursorX + width > targetWidth) {
      cursorX = 0;
      cursorZ += rowDepth;
      rowDepth = 0;
    }

    const originX = cursorX + STREET / 2;
    const originZ = cursorZ + STREET / 2;

    block.members.forEach((member, i) => {
      const col = i % block.cols;
      const row = Math.floor(i / block.cols);
      placements.set(member.room, {
        room: member.room,
        districtId: block.district.id,
        x: (originX + col) * LOT,
        z: (originZ + row) * LOT,
      });
    });

    plots.push({
      district: block.district,
      x: (cursorX + width / 2) * LOT,
      z: (cursorZ + depth / 2) * LOT,
      width: width * LOT,
      depth: depth * LOT,
      count: block.members.length,
    });

    cursorX += width;
    rowDepth = Math.max(rowDepth, depth);
  }

  // Recentre on the origin so the camera has nothing to compensate for.
  const spanX = Math.max(...plots.map((p) => p.x + p.width / 2), 0);
  const spanZ = Math.max(...plots.map((p) => p.z + p.depth / 2), 0);
  const shiftX = spanX / 2;
  const shiftZ = spanZ / 2;

  for (const placement of placements.values()) {
    placement.x -= shiftX;
    placement.z -= shiftZ;
  }
  for (const plot of plots) {
    plot.x -= shiftX;
    plot.z -= shiftZ;
  }

  return { placements, plots, radius: Math.max(spanX, spanZ) / 2 };
}
