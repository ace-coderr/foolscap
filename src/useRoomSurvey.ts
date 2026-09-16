// useRoomSurvey.ts — the fifty rooms the server chooses to list.
//
// It lived in useLens.ts, which was right while the Lens was the only page that
// needed a room list. /retention needs the same request and then some — it reads
// the `bytes` figure as its export-size estimate and the `last_seq` as the thing
// to measure the survey's own staleness against — so it moved here rather than
// being written a second time. SHELL.md: "If two pages need the same logic, it
// moves into js/, it does not get copied."
//
// ONE REQUEST, DELIBERATELY NOT CACHE-BUSTED, and taken as a map rather than as
// a reading. The server takes this snapshot on its own schedule and Cloudflare
// holds it at the edge for up to a day: sampling it for three minutes returns
// byte-identical figures while the rooms it describes take a hundred messages a
// second. Nothing that has to be current may be derived from it — which on
// /retention is the point rather than a caveat, because the gap between the
// survey's last_seq and a room's true one is a number that page prints.

import { useCallback, useEffect, useState } from 'react';

export interface SurveyRoom {
  room: string;
  bytes: number;
  lastSeq: number;
}

export interface Survey {
  rooms: SurveyRoom[];
  /** Rooms that exist, of which `rooms` is only the busiest handful. */
  total: number | null;
  /** When this client received it. Not when the server took it. */
  readAt: number | null;
  error: string | null;
  loading: boolean;
}

export function useRoomSurvey(): Survey {
  const [state, setState] = useState<Survey>({
    rooms: [],
    total: null,
    readAt: null,
    error: null,
    loading: true,
  });

  const load = useCallback(async () => {
    try {
      const { readRoomsIndex } = await import('./lib/technocore.ts');
      const index = await readRoomsIndex({});
      setState({
        rooms: index.rooms
          .map((entry) => ({ room: entry.room, bytes: entry.bytes, lastSeq: entry.lastSeq }))
          .sort((a, b) => b.lastSeq - a.lastSeq),
        total: index.totalRooms,
        readAt: index.readAt,
        error: null,
        loading: false,
      });
    } catch (err) {
      setState((previous) => ({
        ...previous,
        error: (err as Error).message,
        loading: false,
      }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return state;
}
