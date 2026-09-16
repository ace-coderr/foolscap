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
import type { Form, Zone } from '../city/radial';
import { useCity, WATCHED } from '../useCity';
import { useLens } from '../useLens';
import { shortDid } from '../lib/lens';
import { Glyph } from '../components/Glyph';
import { PaneState } from '../components/Panel';
import { formatAge, formatUtc, num, plural } from '../format';

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

  /**
   * The district the reader has gone into, and the room being read inside it.
   *
   * Two pieces of state rather than one because they move independently: you
   * enter a district and the busiest room in it starts being read, and then you
   * can pick a different room without leaving. `null` is the whole city, which
   * is the state the page starts and ends in.
   */
  const [entered, setEntered] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);

  // Stable, or the canvas would tear itself down and rebuild on every repaint.
  const onSelect = useCallback((room: string | null) => setSelected(room), []);
  const onHover = useCallback((room: string | null) => setHovered(room), []);
  const onUnavailable = useCallback((reason: string) => setNoCanvas(reason), []);

  const zones = city.layout.zones;
  const zone = entered ? zones.find((entry) => entry.district.id === entered) ?? null : null;

  /** The district's rooms, busiest first. The layout already sorted them. */
  const inZone = useMemo(
    () => (entered ? city.rooms.filter((entry) => entry.districtId === entered) : []),
    [city.rooms, entered]
  );

  const onEnter = useCallback(
    (districtId: string) => {
      setEntered(districtId);
      setSelected(null);
      // The busiest room in the district, which the room list is already sorted
      // by. Entering somewhere and being shown nothing would make the gesture
      // feel like it had failed.
      const first = city.rooms.find((entry) => entry.districtId === districtId);
      setReading(first?.room ?? null);
    },
    [city.rooms]
  );

  const leave = useCallback(() => {
    setEntered(null);
    setReading(null);
  }, []);

  /**
   * Clicking a building enters its district and reads that room.
   *
   * So the two gestures land in the same place: the ground takes you to the
   * district's busiest room, a building takes you to that one. Neither is a
   * different kind of arrival.
   */
  const enterRoom = useCallback(
    (name: string) => {
      const entry = city.rooms.find((candidate) => candidate.room === name);
      if (!entry) return;
      setEntered(entry.districtId);
      setReading(name);
      setSelected(null);
    },
    [city.rooms]
  );

  // ESCAPE LEAVES, from anywhere on the page. A view you can get into with one
  // click and out of only by finding a button is a trap, and this one covers the
  // whole viewport.
  useEffect(() => {
    if (!entered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') leave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entered, leave]);

  const shown = selected ?? hovered;
  const room = shown ? city.rooms.find((entry) => entry.room === shown) ?? null : null;

  const { live, quiet, failing, measured, lit } = city.watchedCounts;
  const lag = city.surveyLag.ms != null ? formatAge(city.surveyLag.ms) : null;
  /** Rooms the survey counts and does not name. The one label about absence. */
  const overflow = Math.max(0, (survey?.totalRooms ?? 0) - city.rooms.length);

  return (
    <Shell page="city" variant="bleed">
      <div className="city" data-canvas-stage>
        {noCanvas === null && (
          <Suspense fallback={<div className="city__stage" />}>
            <CityCanvas
              rooms={city.rooms}
              zones={city.layout.zones}
              wallRadius={city.layout.wallRadius}
              radius={city.layout.radius}
              overflow={overflow}
              selected={selected}
              entered={entered}
              onSelect={onSelect}
              onEnter={onEnter}
              onHover={onHover}
              reducedMotion={reducedMotion}
              onUnavailable={onUnavailable}
            />
          </Suspense>
        )}

        <aside className="panel" data-canvas-panel aria-label="What the network is doing">
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

            {/* LIT IS THE HEADLINE COUNT, because it is the one the accent is
                spent on. Live-but-unsigned is folded into the quiet count with
                its own word, so a reader can see how much of the live traffic
                carries no proof at all — which on this network is most of it. */}
            <p className="panel__counts">
              <StateChip state="live" n={lit} label="lit" />{' '}
              <StateChip state="quiet" n={live - lit + quiet} label="watched, unlit" />{' '}
              {failing > 0 && <StateChip state="failing" n={failing} label="failing" />}
            </p>
          </section>

          {zone ? (
            <DistrictView
              zone={zone}
              rooms={inZone}
              reading={reading}
              onRead={setReading}
              onLeave={leave}
            />
          ) : room ? (
            <RoomDetail room={room} now={now} pinned={selected != null} onClear={() => setSelected(null)} />
          ) : (
            <Legend
              surveyed={survey?.rooms.length ?? 0}
              lag={lag}
              total={survey?.totalRooms ?? null}
              zones={zones}
            />
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
                    aria-pressed={selected === entry.room || reading === entry.room}
                    onClick={() =>
                      entered ? enterRoom(entry.room) : setSelected(selected === entry.room ? null : entry.room)
                    }
                    onDoubleClick={() => enterRoom(entry.room)}
                    onMouseEnter={() => setHovered(entry.room)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <span
                      className={`rooms__dot rooms__dot--${
                        entry.alarming ? 'failing' : entry.lit ? 'live' : entry.watched ? 'quiet' : 'unwatched'
                      }`}
                      aria-hidden="true"
                    />
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

function StateChip({ state, n, label }: { state: CityRoom['state']; n: number; label: string }) {
  if (n === 0 && state !== 'live') return null;
  return (
    <span className={`chip chip--${state}`}>
      <span className="chip__dot" aria-hidden="true" />
      {n} {label}
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
  zones,
}: {
  surveyed: number;
  lag: string | null;
  total: number | null;
  zones: Zone[];
}) {
  return (
    <section className="panel__legend">
      <h2 className="panel__title">
        The districts
        <span className="panel__title-note">busiest at the centre</span>
      </h2>
      {/* The key to the numbers on the plan. Ordered exactly as the rings are —
          which is what makes "1 is innermost" a rule a reader can check rather
          than a claim they have to take. */}
      <ol className="key">
        {zones.map((zone) => (
          <li className="key__row" key={zone.district.id}>
            <span className="key__n">{zone.index}</span>
            <span className="key__label">{zone.district.label}</span>
            <span className="key__form">{FORM_SHORT[zone.form]}</span>
            <span className="key__count">{plural(zone.count, 'room')}</span>
          </li>
        ))}
      </ol>

      <h2 className="panel__title">How to read it</h2>
      <dl className="legend">
        <dt>Distance from the centre</dt>
        <dd>
          the district&rsquo;s rank by messages carried — busiest innermost. A rank, not a
          quantity: the counts are in the list below. The compass bearing means nothing at all
          and is only packing.
        </dd>
        <dt>Shape</dt>
        <dd>
          each district is arranged by its own character — a ring of peers, a stepped sequence, a
          plain grid, a dense stack — so one can be told from another without spending a colour
          on it.
        </dd>
        <dt>Height</dt>
        <dd>
          messages the room has carried, on a log scale — every {HEIGHT_PER_DECADE.toFixed(2)}{' '}
          units of height is ten times the traffic.
        </dd>
        <dt>
          <span className="legend__swatch legend__swatch--live" aria-hidden="true" /> Lit
        </dt>
        <dd>
          the room is one Foolscap reads, it is live, <em>and</em> its newest message verified
          against the key that message names — checked here, in this browser. All three, or it
          stays grey. A room can be taking twenty messages a second that nobody signed, and
          lighting it would claim something about traffic nothing can vouch for.
        </dd>
        <dt>
          <span className="legend__swatch legend__swatch--failing" aria-hidden="true" /> Marked
        </dt>
        <dd>
          the read failed, or the newest message did <em>not</em> verify. An unsigned message is
          neither of those and is never drawn as a problem — most traffic here carries no
          signature, and that is ordinary.
        </dd>
        <dt>Grey with a cap</dt>
        <dd>a room Foolscap reads that is quiet, or live and unsigned. Watched, not lit.</dd>
        <dt>Grey, no cap</dt>
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
        Click a district&rsquo;s ground to go into it and watch its traffic arrive, checked as it
        lands. Click a building for one room. Drag to orbit, scroll to zoom.
      </p>

      <p className="panel__caption">
        Waiting on a sonnet-2 receipt? <Link to="/track">The Tracker</Link> reads the contest
        rooms in full and checks every receipt against the pinned referee key.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Inside a district
// ---------------------------------------------------------------------------

/** One word each, for the district key. */
const FORM_SHORT: Record<Form, string> = {
  ring: 'ring',
  stepped: 'stepped',
  grid: 'grid',
  stack: 'stack',
};

const FORM_WORD: Record<Form, string> = {
  ring: 'a ring — its rooms are peers, and none of them is first',
  stepped: 'stepped — its rooms are stages of one process, tallest in the middle',
  grid: 'a grid — regular, and claiming nothing more than that',
  stack: 'a stack — a few rooms carrying an enormous amount between them',
};

/** How many message cards the pane holds. Everything is checked; this is drawn. */
const CARDS = 40;

/**
 * The live view, which is the whole point of going in.
 *
 * READING IS LENS'S JOB AND THIS DOES NOT REDO IT. `useLens` opens the same
 * watcher /lens opens, verifies every message the same way, and hands back the
 * same three verdicts. A second implementation here would be a second answer to
 * "did this verify", and two answers to that question is worse than none.
 *
 * What is different is the shape: cards rather than a log, because a card is
 * what a message looks like when it is arriving rather than when it is being
 * scrolled through, and forty of them rather than four hundred, because this is
 * a glance and /lens is the place to actually read a room.
 */
function DistrictView({
  zone,
  rooms,
  reading,
  onRead,
  onLeave,
}: {
  zone: Zone;
  rooms: CityRoom[];
  reading: string | null;
  onRead: (room: string) => void;
  onLeave: () => void;
}) {
  // FOLLOW, DO NOT BACKFILL. The Lens pulls the whole retained ring because
  // reading a room properly is what it is for; this is a glance at what is
  // arriving, on a page somebody is passing through, and backfilling would spend
  // several megabytes to show them messages from before they clicked. The first
  // build did exactly that and the first thing a reader saw was a long wait.
  const feed = useLens(reading, { backfill: false });
  const shown = feed.messages.slice(-CARDS).reverse();

  return (
    <section className="inside">
      <div className="inside__head">
        <p className="inside__eyebrow">
          <span className="inside__n">{zone.index}</span>
          {zone.district.label}
        </p>
        <button type="button" className="inside__leave" onClick={onLeave}>
          Back to the city <kbd>Esc</kbd>
        </button>
      </div>

      <p className="inside__basis">
        {plural(zone.count, 'room')}, drawn as {FORM_WORD[zone.form]}. They are grouped by NAME —{' '}
        {zone.district.basis} — and a name is a string its creator chose, so this is a rough sort
        and never a claim about who runs a room.
      </p>

      {rooms.length > 1 && (
        <div className="inside__rooms">
          {rooms.slice(0, 8).map((entry) => (
            <button
              key={entry.room}
              type="button"
              className="inside__room mono"
              aria-pressed={entry.room === reading}
              onClick={() => onRead(entry.room)}
            >
              {entry.room}
            </button>
          ))}
          {rooms.length > 8 && (
            <span className="inside__more">
              and {num.format(rooms.length - 8)} more, in the list below
            </span>
          )}
        </div>
      )}

      <div className="inside__live">
        <p className="inside__title">
          {reading ? (
            <>
              Following <span className="mono">{reading}</span> from here on
            </>
          ) : (
            'Nothing being read'
          )}
          {feed.counts.total > 0 && (
            <span className="inside__tally">
              {num.format(feed.counts.verified)} verified · {num.format(feed.counts.unsigned)}{' '}
              unsigned
              {feed.counts.failed > 0 ? ` · ${num.format(feed.counts.failed)} failed` : ''}
            </span>
          )}
        </p>

        <Cards feed={feed} shown={shown} room={reading} />
      </div>
    </section>
  );
}

/** The six states of the message pane, which is the one list on this view. */
function Cards({
  feed,
  shown,
  room,
}: {
  feed: ReturnType<typeof useLens>;
  shown: ReturnType<typeof useLens>['messages'];
  room: string | null;
}) {
  if (!room) {
    return (
      <PaneState
        state="empty"
        title="No room picked."
        detail="Every room in this district is in the list; pick one and Foolscap will read it here."
      />
    );
  }
  if (feed.error) {
    return (
      <PaneState
        state="failed"
        title={`${room} could not be read.`}
        detail={`${feed.error} Nothing is shown as verified from a read that did not happen.`}
      />
    );
  }
  if (shown.length === 0) {
    return feed.status === 'stopped' || feed.status === 'starting' ? (
      <PaneState state="loading" title={`Opening ${room}…`} />
    ) : (
      <PaneState
        state="empty"
        title="Nothing has arrived yet."
        detail={
          <>
            The room is open and being followed from its head — this shows what lands from here
            on, not what was already in it. A quiet room can sit like this for a long time.{' '}
            <Link to={`/lens?room=${encodeURIComponent(room)}`}>The Lens</Link> reads what it is
            already holding.
          </>
        }
      />
    );
  }

  return (
    <>
      <ul className="cards">
        {shown.map((message) => {
          const verdict = feed.readings.get(message.seq)?.verdict ?? null;
          return (
            <li className={`card3 card3--${verdict ?? 'checking'}`} key={message.seq}>
              <div className="card3__head">
                <Glyph did={message.from} size={20} />
                <span className="card3__did mono" title={message.from ?? undefined}>
                  {message.from ? shortDid(message.from) : 'no sender'}
                </span>
                <span className="card3__seq mono">#{num.format(message.seq)}</span>
              </div>
              <p className="card3__text">{message.text}</p>
              <p className="card3__foot">
                <span className={`card3__verdict card3__verdict--${verdict ?? 'checking'}`}>
                  {verdict === 'verified'
                    ? 'Verified'
                    : verdict === 'failed'
                      ? 'Does not verify'
                      : verdict === 'unsigned'
                        ? 'Unsigned'
                        : 'Checking…'}
                </span>
                {message.tsMs ? (
                  <time dateTime={new Date(message.tsMs).toISOString()}>
                    {formatUtc(message.tsMs)}
                  </time>
                ) : null}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="cards__cap">
        {feed.seen > shown.length
          ? `Showing the newest ${num.format(shown.length)} of ${num.format(feed.seen)} that have arrived since you came in. Every one was checked; only the list is capped. `
          : 'Everything that has arrived since you came in, each one checked against the key it names as it landed. '}
        This is not the room&rsquo;s history —{' '}
        <Link to={`/lens?room=${encodeURIComponent(room)}`}>the Lens</Link> reads what it is
        holding.
      </p>
    </>
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
