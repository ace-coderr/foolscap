// City.tsx — what is the network doing right now?
//
// The picture is a picture of two different things and the page never lets them
// blur together. Height and footprint come from the survey, which is a map. State
// comes from the eight rooms Foolscap reads itself, which is a reading. A building
// with a lit roof is a room Foolscap has current evidence about; a grey one is a
// room it knows the size of and nothing else. There is no third case, and nothing
// on this page infers a room's state from its neighbours, its name or its topic.
//
// Everything the canvas shows is also here as text, so the list is not a fallback
// bolted on for browsers without WebGL — it is the same page, and the canvas is
// the part that can be missing.

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Shell } from '../components/Shell';
import { districtById } from '../city/districts';
import { HEIGHT_PER_DECADE, type CityRoom } from '../city/model';
import { useCity, WATCHED } from '../useCity';
import { formatAge, num, plural } from '../format';

/**
 * Three.js is most of what this page weighs and none of what the Tracker needs,
 * so it arrives in its own chunk, on this route only. The panel does not wait for
 * it: everything the canvas draws is in the list beside it, which is the same
 * reason the page works at all in a browser with no WebGL.
 */
const CityCanvas = lazy(() => import('../city/CityCanvas'));

/** Matches the media query the canvas honours, and re-reads it if it changes. */
function usePrefersReducedMotion(): boolean {
  const query = useMemo(
    () =>
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null,
    []
  );
  const [reduced, setReduced] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, [query]);
  return reduced;
}

const STATE_WORD: Record<CityRoom['state'], string> = {
  live: 'Live',
  quiet: 'Quiet',
  failing: 'Failing',
  unwatched: 'Not read',
};

function rateWords(perMin: number | null): string | null {
  if (perMin == null) return null;
  if (perMin === 0) return 'nothing arriving';
  if (perMin < 1) return `${(perMin * 60).toFixed(0)} an hour`;
  if (perMin < 10) return `${perMin.toFixed(1)} a minute`;
  return `${num.format(Math.round(perMin))} a minute`;
}

export default function City() {
  const { city, survey, surveyError, state, resumeAt, lastError, paused, now } = useCity();
  const reducedMotion = usePrefersReducedMotion();

  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [noCanvas, setNoCanvas] = useState<string | null>(null);

  // Stable, or the canvas would tear itself down and rebuild on every repaint.
  const onSelect = useCallback((room: string | null) => setSelected(room), []);
  const onHover = useCallback((room: string | null) => setHovered(room), []);
  const onUnavailable = useCallback((reason: string) => setNoCanvas(reason), []);

  const shown = selected ?? hovered;
  const room = shown ? city.rooms.find((entry) => entry.room === shown) ?? null : null;

  const { live, quiet, failing, measured } = city.watchedCounts;
  const lag = city.surveyLag.ms != null ? formatAge(city.surveyLag.ms) : null;

  return (
    <Shell page="city" variant="bleed">
      <div className="city">
        {noCanvas === null && (
          <Suspense fallback={<div className="city__stage" />}>
            <CityCanvas
              rooms={city.rooms}
              plots={city.layout.plots}
              radius={city.layout.radius}
              selected={selected}
              onSelect={onSelect}
              onHover={onHover}
              reducedMotion={reducedMotion}
              onUnavailable={onUnavailable}
            />
          </Suspense>
        )}

        <aside className="panel" aria-label="What the network is doing">
          <section className="panel__answer">
            {city.watchedRate == null ? (
              <>
                <p className="answer answer--waiting">Measuring</p>
                <p className="panel__caption">
                  A rate needs two readings of the same room. The first arrives in under a
                  minute.
                </p>
              </>
            ) : (
              <>
                <p className="answer">{num.format(Math.round(city.watchedRate))}</p>
                <p className="panel__caption">
                  messages a minute, counted across the{' '}
                  {plural(measured, 'room')} Foolscap is reading directly — not the network,
                  which is {survey?.totalRooms ? `${num.format(survey.totalRooms)} rooms` : 'far larger'}.
                </p>
              </>
            )}

            <FeedLine state={state} resumeAt={resumeAt} paused={paused} now={now} error={lastError} />

            <p className="panel__counts">
              <StateChip state="live" n={live} /> <StateChip state="quiet" n={quiet} />{' '}
              {failing > 0 && <StateChip state="failing" n={failing} />}
            </p>
          </section>

          {room ? (
            <RoomDetail room={room} now={now} pinned={selected != null} onClear={() => setSelected(null)} />
          ) : (
            <Legend surveyed={survey?.rooms.length ?? 0} lag={lag} total={survey?.totalRooms ?? null} />
          )}

          <section className="panel__list">
            <h2 className="panel__title">
              {plural(city.rooms.length, 'room')}
              <span className="panel__title-note">tallest first</span>
            </h2>
            <ul className="rooms">
              {city.rooms.map((entry) => (
                <li key={entry.room}>
                  <button
                    type="button"
                    className="rooms__row"
                    aria-pressed={selected === entry.room}
                    onClick={() => setSelected(selected === entry.room ? null : entry.room)}
                    onMouseEnter={() => setHovered(entry.room)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <span className={`rooms__dot rooms__dot--${entry.state}`} aria-hidden="true" />
                    <span className="rooms__name mono">{entry.room}</span>
                    <span className="rooms__volume">{num.format(entry.volume)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {city.rooms.length === 0 && (
              <p className="panel__caption">
                {surveyError ?? 'Reading the survey…'}
              </p>
            )}
          </section>

          {noCanvas !== null && (
            <p className="panel__caption panel__caption--warn">
              The map needs WebGL and this browser did not provide it — {noCanvas} Everything the
              map would show is in the list above.
            </p>
          )}
        </aside>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function StateChip({ state, n }: { state: CityRoom['state']; n: number }) {
  if (n === 0 && state !== 'live') return null;
  return (
    <span className={`chip chip--${state}`}>
      <span className="chip__dot" aria-hidden="true" />
      {n} {STATE_WORD[state].toLowerCase()}
    </span>
  );
}

function FeedLine({
  state,
  resumeAt,
  paused,
  now,
  error,
}: {
  state: string;
  resumeAt: number | null;
  paused: boolean;
  now: number;
  error: string | null;
}) {
  if (paused) {
    return (
      <p className="feed">
        Reading stopped while this tab is in the background. It restarts when you come back.
      </p>
    );
  }
  if (state === 'backing-off') {
    const wait = resumeAt != null ? formatAge(Math.max(0, resumeAt - now)) : null;
    return (
      <p className="feed feed--warn">
        technocore.chat rate-limited Foolscap, so it has stopped reading
        {wait ? ` for about ${wait}` : ''}. The figures above are the last ones it got.
      </p>
    );
  }
  if (state === 'failed') {
    return <p className="feed feed--alarm">{error ?? 'Nothing could be read.'}</p>;
  }
  return (
    <p className="feed">
      One room every four seconds, in rotation — about a quarter of a request a second, and
      never a burst.
    </p>
  );
}

function Legend({
  surveyed,
  lag,
  total,
}: {
  surveyed: number;
  lag: string | null;
  total: number | null;
}) {
  return (
    <section className="panel__legend">
      <h2 className="panel__title">How to read it</h2>
      <dl className="legend">
        <dt>Height</dt>
        <dd>
          messages the room has carried, on a log scale — every {HEIGHT_PER_DECADE.toFixed(2)}{' '}
          units of height is ten times the traffic.
        </dd>
        <dt>Brightness</dt>
        <dd>
          how much is arriving, in the rooms Foolscap reads. The rest are drawn flat — the
          survey cannot tell you what a room is doing now, so nothing here pretends it can.
        </dd>
        <dt>
          <span className="legend__swatch legend__swatch--live" aria-hidden="true" /> Lit roof
        </dt>
        <dd>
          a room Foolscap reads itself: <span className="legend__key legend__key--live">live</span>,{' '}
          <span className="legend__key legend__key--quiet">quiet</span>, or{' '}
          <span className="legend__key legend__key--failing">failing to read</span>.
        </dd>
        <dt>No roof</dt>
        <dd>
          a room from the survey only. Foolscap knows its size, not its state, and does not
          guess.
        </dd>
        <dt>Districts</dt>
        <dd>
          grouped by what the room is <em>called</em>. A name is a string its creator chose, so a
          district is a rough sort and never a claim about who runs a room.
        </dd>
      </dl>

      <p className="panel__caption">
        The survey is one request that returns the busiest{' '}
        {surveyed ? num.format(surveyed) : 'few dozen'} rooms
        {total ? ` of ${num.format(total)}` : ''}. The server caches it hard and it carries no
        timestamp
        {lag
          ? `; measured against the rooms Foolscap reads directly, it is running about ${lag} behind`
          : ''}
        . Nothing current is derived from it.
      </p>

      <p className="panel__caption">
        Click a building, or a room in the list. Drag to orbit, scroll to zoom.
      </p>

      <p className="panel__caption">
        Waiting on a sonnet-2 receipt? <Link to="/track">The Tracker</Link> reads the contest
        rooms in full and checks every receipt against the pinned referee key.
      </p>
    </section>
  );
}

function RoomDetail({
  room,
  now,
  pinned,
  onClear,
}: {
  room: CityRoom;
  now: number;
  pinned: boolean;
  onClear: () => void;
}) {
  const district = districtById(room.districtId);
  const age = room.newestTsMs != null ? formatAge(now - room.newestTsMs) : null;
  const rate = rateWords(room.ratePerMin);
  const span = room.rateSpanMs != null ? formatAge(room.rateSpanMs) : null;
  const readAge = room.readAt != null ? formatAge(now - room.readAt) : null;
  const isContest = room.districtId === 'contest';

  return (
    <section className="panel__detail">
      <div className="detail__head">
        <p className={`detail__state detail__state--${room.state}`}>{STATE_WORD[room.state]}</p>
        {pinned && (
          <button type="button" className="detail__clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      <p className="detail__name mono">{room.room}</p>

      <dl className="facts">
        <dt>Messages carried</dt>
        <dd>
          {num.format(room.volume)}
          <span className="facts__note">
            {room.volumeRead ? 'read directly just now' : 'from the survey'}
          </span>
        </dd>

        {room.watched ? (
          <>
            <dt>Arriving</dt>
            <dd>
              {rate ?? 'not measured yet'}
              {rate && span && <span className="facts__note">measured over {span}</span>}
            </dd>
            <dt>Newest message</dt>
            <dd>
              {age ? `${age} ago` : 'none in the ring'}
              {readAge && <span className="facts__note">read {readAge} ago</span>}
            </dd>
          </>
        ) : (
          <>
            <dt>State</dt>
            <dd>
              not read
              <span className="facts__note">
                Foolscap reads {WATCHED.length} rooms directly; this is not one of them
              </span>
            </dd>
          </>
        )}

        {room.bytes != null && (
          <>
            <dt>Held in the ring</dt>
            <dd>
              {(room.bytes / 1024 / 1024).toFixed(1)} MB
              <span className="facts__note">what it drops from when full — rooms are rings</span>
            </dd>
          </>
        )}

        <dt>District</dt>
        <dd>
          {district?.label ?? 'Unsorted'}
          <span className="facts__note">{district?.basis}</span>
        </dd>
      </dl>

      {room.error && <p className="detail__problem">{room.error}</p>}

      {room.topic && (
        <div className="detail__topic">
          <p className="detail__topic-label">Topic, as set on the room</p>
          <p className="detail__topic-text mono">{room.topic}</p>
          <p className="panel__caption">
            A topic can be set on any room by any caller, without ever posting to it. Shown
            because it is there, not because it is true.
          </p>
        </div>
      )}

      {isContest && (
        <p className="panel__caption">
          A sonnet-2 contest room. <Link to="/track">The Tracker</Link> reads this one in full and
          checks every receipt in it against the pinned referee key.
        </p>
      )}
    </section>
  );
}
