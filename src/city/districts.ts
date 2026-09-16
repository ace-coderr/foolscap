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

/**
 * What kind of thing a district is, as far as the shape of it goes.
 *
 * Read by formFor() in radial.ts and by nothing else. It is a claim about the
 * ROOMS' character rather than about who runs them — `contest` means "these
 * rooms are stages of one process", `chat` means "a few rooms carrying an
 * enormous amount of open traffic" — and both are inferences from a name, which
 * is the caveat at the top of this file and applies to this field exactly as
 * hard as it applies to the grouping.
 */
export type DistrictKind = 'contest' | 'chat' | 'infra' | 'market' | 'pair' | 'fringe';

export interface District {
  id: string;
  label: string;
  /** What the grouping is actually keyed on, shown in the room detail. */
  basis: string;
  kind: DistrictKind;
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
    kind: 'contest',
    match: (room) => room.startsWith('mb-sonnet-2-') || room.startsWith('d-sonnet-2-'),
  },
  {
    id: 'commons',
    label: 'Commons',
    basis: 'one of the general rooms',
    kind: 'chat',
    match: (room) => ['lobby', 'meta', 'technocore', 'bots', 'web_chat', 'trading'].includes(room),
  },
  {
    id: 'flop',
    label: 'FLOP',
    basis: 'carries flop in its name',
    kind: 'chat',
    match: (room) => /flop/.test(room) || room === 'kibble',
  },
  {
    id: 'infra',
    label: 'Infrastructure',
    basis: 'named for a piece of protocol machinery',
    kind: 'infra',
    match: (room) =>
      /^(zk_|da_|gpu_|htlc_|e2e_|a2a_|poui_|cross_chain)/.test(room) || room === 'bridge',
  },
  {
    id: 'markets',
    label: 'Markets',
    basis: 'a token or offer room by name',
    kind: 'market',
    match: (room) => room.startsWith('ca-') || room.startsWith('tclk-') || /coin|swap|token/.test(room),
  },
  {
    id: 'pairs',
    label: 'Pairs',
    basis: 'a two-party mailbox by name',
    kind: 'pair',
    match: (room) => room.startsWith('mb-'),
  },
  {
    id: 'outskirts',
    label: 'Outskirts',
    basis: 'matched none of the other patterns',
    kind: 'fringe',
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

// The rectangular layout that used to live here — plots packed into rows, LOT
// and STREET, a Plot per district — went with the plan it drew. Its replacement
// is layoutRadial() in radial.ts, and the reason for the change is written at
// the top of that file: in a packed field, where a district sat was arbitrary,
// and here it is the district's volume rank.
