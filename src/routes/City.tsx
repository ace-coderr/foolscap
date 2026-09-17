// City.tsx — what is the network doing right now?
//
// A CANVAS WITH PANELS OVER IT, not a page with a canvas in it. The plan is the
// page; everything else floats on it and is sized to be read at a glance rather
// than studied. What went to make room for that was a scrolling column of forty
// room names with their message counts beside them — honest, and a data dump.
// Nobody reads a list like that. What survives of it is six rows of the rooms
// actually moving right now, and a field to find any of the rest by name.
//
// The picture is a picture of two different things and the page never lets them
// blur together. Height and footprint come from the survey, which is a map. State
// comes from the eight rooms Foolscap reads itself, which is a reading. A building
// with a lit roof is a room Foolscap has current evidence about; a grey one is a
// room it knows the size of and nothing else. There is no third case, and nothing
// on this page infers a room's state from its neighbours, its name or its topic.
// The band across the bottom says so, in those words, without being clicked on.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Shell } from '../components/Shell';
import { pageById } from '../pages';
import { useTheme } from '../theme';
import { drive, ping, useAudio } from '../audio';
import { Speaker, soundTitle } from '../components/Sound';
import { districtById } from '../city/districts';
import type { CityRoom } from '../city/model';
import type { CityApi } from '../city/CityCanvas';
import type { Form, Zone } from '../city/radial';
import { SURVEY_ROOMS, useCity, WATCHED } from '../useCity';
import { useLens } from '../useLens';
import { matchRooms, shortDid } from '../lib/lens';
import { Glyph } from '../components/Glyph';
import { PaneState } from '../components/Panel';
import { formatAge, formatUtc, num, plural } from '../format';

/**
 * Three.js is most of what this page weighs and none of what the Tracker needs,
 * so it arrives in its own chunk, on this route only. The panels do not wait for
 * it: every figure on them is computed from the same two readings whether or not
 * anything is ever drawn, which is also why a browser with no WebGL still gets a
 * working page rather than an apology.
 */
const CityCanvas = lazy(() => import('../city/CityCanvas'));

/** A media query, as a boolean that re-reads itself when it changes. */
function useMediaQuery(query: string): boolean {
  const list = useMemo(
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null),
    [query]
  );
  const [matches, setMatches] = useState(() => list?.matches ?? false);
  useEffect(() => {
    if (!list) return;
    // AND A RESIZE LISTENER, because the change event is not reliable enough to
    // be the only one. A height query under viewport emulation updates
    // `matches` without ever firing `change`, which left the district list open
    // on a window that had shrunk under it — and this hook is the thing
    // deciding whether that list fits. Re-reading on resize costs a boolean
    // comparison that React drops when it has not moved.
    const read = () => setMatches(list.matches);
    read();
    list.addEventListener('change', read);
    window.addEventListener('resize', read);
    return () => {
      list.removeEventListener('change', read);
      window.removeEventListener('resize', read);
    };
  }, [list]);
  return matches;
}

/**
 * When the district list can be open without anything having to scroll.
 *
 * MEASURED, NOT CHOSEN FOR ROUNDNESS. The left column is the window less the
 * nav and the band; the head panel is what is left of that once the busiest
 * panel has taken its six rows. Closed, it fits a 900-tall window with about
 * thirty pixels to spare; open, it needs sixty more than that and about thirty
 * fewer than a 1000-tall window has. So a thousand, where all seven rows fit
 * with room either side of the measurement.
 *
 * The second clause is the narrow layout, where the panels stack and the page
 * itself scrolls. There is no fixed column to fit there and so nothing to
 * ration: the list is open because it can be.
 */
const ROOMY = '(min-height: 1000px), (max-width: 62rem)';

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

/** Rows in the busiest list, and in the search results. Both are a glance. */
const BUSIEST = 6;
const MATCHES = 6;

export default function City() {
  const { city, survey, surveyError, state, resumeAt, lastError, paused, now } = useCity();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const roomy = useMediaQuery(ROOMY);
  // The canvas cannot read a custom property, so the theme is handed to it and
  // it holds a palette of its own. See Palette in CityCanvas.
  const { theme } = useTheme();
  const page = pageById('city');

  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [noCanvas, setNoCanvas] = useState<string | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [info, setInfo] = useState(false);

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

  /** The camera, as the buttons in the corner drive it. Filled by the canvas. */
  const api = useRef<CityApi | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Stable, or the canvas would tear itself down and rebuild on every repaint.
  const onSelect = useCallback((room: string | null) => setSelected(room), []);
  const onHover = useCallback((room: string | null) => setHovered(room), []);
  const onUnavailable = useCallback((reason: string) => setNoCanvas(reason), []);
  const onFps = useCallback((next: number) => setFps(next), []);

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
   * different kind of arrival. The search field and the busiest list both end
   * here as well — there is one way into a room on this page, whatever you
   * touched to get there.
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
  // whole viewport. It closes the legend first, because that is the thing most
  // recently opened when both are.
  useEffect(() => {
    if (!entered && !info) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (info) setInfo(false);
      else leave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entered, info, leave]);

  const reset = useCallback(() => {
    leave();
    setSelected(null);
    api.current?.reset();
  }, [leave]);

  // THE DRONE FOLLOWS THE SAME FIGURE THE PANEL PRINTS, and it is handed over
  // whether or not anything is sounding — see drive(). One measurement, two
  // ways of reading it.
  useEffect(() => {
    drive(city.watchedRate);
  }, [city.watchedRate]);

  const shown = selected ?? hovered;
  const room = shown ? city.rooms.find((entry) => entry.room === shown) ?? null : null;

  const { live, quiet, failing, measured, lit } = city.watchedCounts;
  const lag = city.surveyLag.ms != null ? formatAge(city.surveyLag.ms) : null;
  /** Rooms the survey counts and does not name. The one label about absence. */
  const overflow = Math.max(0, (survey?.totalRooms ?? 0) - city.rooms.length);
  /** Rooms with a reading in hand — the live half of the picture, counted. */
  const open = city.rooms.filter((entry) => entry.watched && entry.readAt != null).length;

  return (
    <Shell page="city" variant="bleed">
      <div className="city" data-canvas-stage ref={stageRef}>
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
              theme={theme}
              onUnavailable={onUnavailable}
              api={api}
              onFps={onFps}
            />
          </Suspense>
        )}

        <div className="city__over">
          <div className="city__left" data-canvas-inset="left">
            <section className="cpanel chead" aria-label="What this is">
              <FeedPill state={state} paused={paused} resumeAt={resumeAt} now={now} />

              <h1 className="chead__title">{page?.title}</h1>
              <p className="chead__line">{page?.line}</p>

              <ul className="cstats">
                <Stat
                  n={survey?.totalRooms ?? null}
                  label="public rooms"
                  title="What the directory says exists. One figure, from a reply the edge caches for up to a day."
                />
                <Stat
                  n={city.rooms.length}
                  label="in the city"
                  title="Rooms drawn on the plan: the busiest the directory will name, plus the ones Foolscap reads."
                />
                <Stat
                  n={city.watchedRate == null ? null : Math.round(city.watchedRate)}
                  label="msg/min"
                  title="Measured across the rooms Foolscap reads directly. Not the network's rate — nobody has that."
                />
                <Stat
                  n={open}
                  label="in live windows"
                  title={`Rooms Foolscap is holding a current reading of, out of the ${WATCHED.length} it rotates through.`}
                />
                <Stat
                  n={fps}
                  label="fps"
                  title="Frames a second the loop is keeping. It draws only when something moved, so this is the rate available rather than work being done."
                />
              </ul>

              <Find
                query={query}
                onQuery={setQuery}
                rooms={city.rooms}
                total={survey?.totalRooms ?? null}
                onPick={enterRoom}
              />

              <Districts
                zones={zones}
                entered={entered}
                onEnter={onEnter}
                roomy={roomy}
                loading={survey == null && surveyError == null}
                error={surveyError}
              />
            </section>

            <Busiest
              rooms={city.rooms}
              open={open}
              live={state === 'reading' && !paused}
              onPick={enterRoom}
            />
          </div>

          {(zone || room) && (
            <div className="city__right">
              {zone ? (
                <DistrictView
                  zone={zone}
                  rooms={inZone}
                  reading={reading}
                  onRead={setReading}
                  onLeave={leave}
                />
              ) : (
                room && (
                  <RoomDetail
                    room={room}
                    now={now}
                    pinned={selected != null}
                    onClear={() => setSelected(null)}
                  />
                )
              )}
            </div>
          )}

          <div className="city__tools">
            {info && (
              <Legend
                surveyed={survey?.rooms.length ?? 0}
                lag={lag}
                total={survey?.totalRooms ?? null}
                live={live}
                quiet={quiet}
                failing={failing}
                measured={measured}
                lit={lit}
                onClose={() => setInfo(false)}
              />
            )}
            <Tools
              info={info}
              onInfo={() => setInfo((was) => !was)}
              onZoom={(factor) => api.current?.zoomBy(factor)}
              onReset={reset}
              stage={stageRef}
              disabled={noCanvas !== null}
            />
          </div>
        </div>

        <Band
          total={survey?.totalRooms ?? null}
          drawn={city.rooms.length}
          lag={lag}
          noCanvas={noCanvas}
          error={state === 'failed' ? lastError : null}
        />
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// The head panel
// ---------------------------------------------------------------------------

/**
 * Whether Foolscap is reading, as a pill.
 *
 * It says "Live" only while that is true. A pill that read Live whatever was
 * happening would be the smallest possible version of the mistake this whole
 * page is arranged against — a light that is always on, saying nothing. The
 * other four states are the four things that can actually be going on, and each
 * one says which.
 */
function FeedPill({
  state,
  paused,
  resumeAt,
  now,
}: {
  state: string;
  paused: boolean;
  resumeAt: number | null;
  now: number;
}) {
  let tone = 'live';
  let word = 'Live';
  let why = 'Foolscap is reading one room every four seconds, in rotation.';

  if (paused) {
    tone = 'idle';
    word = 'Paused';
    why =
      'This tab is in the background, so Foolscap has stopped reading. It restarts when you come back.';
  } else if (state === 'backing-off') {
    const wait = resumeAt != null ? formatAge(Math.max(0, resumeAt - now)) : null;
    tone = 'warn';
    word = 'Backing off';
    why = `technocore.chat rate-limited Foolscap, so it has stopped reading${
      wait ? ` for about ${wait}` : ''
    }. The figures are the last ones it got.`;
  } else if (state === 'failed') {
    tone = 'alarm';
    word = 'Not reading';
    why = 'Nothing could be read.';
  } else if (state === 'starting') {
    tone = 'idle';
    word = 'Opening';
    why = 'The first reading is a few seconds away.';
  }

  return (
    <p className={`lpill lpill--${tone}`} title={why} role="status">
      <span className="lpill__dot" aria-hidden="true" />
      {word}
    </p>
  );
}

function Stat({ n, label, title }: { n: number | null; label: string; title: string }) {
  return (
    <li className="cstat" title={title}>
      <span className="cstat__n">{n == null ? '—' : num.format(n)}</span>
      <span className="cstat__k">{label}</span>
    </li>
  );
}

/** A did:key, near enough. Enough to tell a key from a room name and no more. */
const looksLikeDid = (value: string) => /^did:key:z[1-9A-HJ-NP-Za-km-z]{6,}$/.test(value.trim());

/**
 * Find a room.
 *
 * Six matches and a count, not a directory: the plan holds two hundred rooms of
 * fifty thousand, and a field that listed everything it could find would be the
 * room list this page just took out with a text box on top of it.
 *
 * A did:key gets an answer rather than no matches, because pasting one here is a
 * reasonable thing to try and "nothing found" would be a lie about why. Foolscap
 * has no index from keys to rooms — nothing on this network does — so the honest
 * reply is to say so and point at the page that checks a key against a message.
 */
function Find({
  query,
  onQuery,
  rooms,
  total,
  onPick,
}: {
  query: string;
  onQuery: (value: string) => void;
  rooms: CityRoom[];
  total: number | null;
  onPick: (room: string) => void;
}) {
  const trimmed = query.trim();
  const did = looksLikeDid(trimmed);
  const matches = useMemo(
    () => (trimmed === '' || did ? [] : matchRooms(trimmed, rooms)),
    [trimmed, did, rooms]
  );

  return (
    <div className="csearch">
      <form
        role="search"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          if (matches.length > 0) onPick(matches[0].room);
        }}
      >
        <input
          className="csearch__input mono"
          id="city-find"
          type="search"
          aria-label="Find a room, or paste a did:key"
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Find a room, or paste a did:key…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </form>

      {did && (
        <div className="cfound__did">
          <Glyph did={trimmed} size={22} />
          <p className="cfound__note">
            That is a key, and nothing here is indexed by one — the City reads rooms, not senders.{' '}
            <Link to="/lens">The Lens</Link> checks a key against the messages that name it.
          </p>
        </div>
      )}

      {!did && trimmed !== '' && matches.length === 0 && (
        <p className="cfound__note">
          No room on the plan is called that. It holds the {num.format(rooms.length)} the directory
          names{total ? ` of ${num.format(total)}` : ''}, so a room can exist and not be here.
        </p>
      )}

      {matches.length > 0 && (
        <>
          <ul className="cfound">
            {matches.slice(0, MATCHES).map((entry) => (
              <li key={entry.room}>
                <button type="button" className="cfound__row" onClick={() => onPick(entry.room)}>
                  <span
                    className={`cdot cdot--${
                      entry.alarming
                        ? 'failing'
                        : entry.lit
                          ? 'live'
                          : entry.watched
                            ? 'quiet'
                            : 'unwatched'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="cfound__name mono">{entry.room}</span>
                  <span className="cfound__n">{num.format(entry.volume)}</span>
                </button>
              </li>
            ))}
          </ul>
          {matches.length > MATCHES && (
            <p className="cfound__note">
              and {num.format(matches.length - MATCHES)} more on the plan that match.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** One word each, for the district list and the plan's key. */
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

/** How many rows a closed list shows. The top of a ranked list, not a sample. */
const DISTRICTS_SHUT = 3;

/**
 * The key to the numbers on the plan, and the way into a district without
 * having to find its ground with a pointer.
 *
 * Ordered exactly as the rings are, which is what makes "1 is innermost" a rule
 * a reader can check by looking rather than a claim they have to take on trust.
 * A row rather than a card each: seven cards is a stack taller than the panel,
 * and there is nothing on one of them that needs more than a line.
 *
 * IT CLOSES RATHER THAN SCROLLS. There is not room for seven rows and six
 * busiest rooms in a 900-tall window, and the first answer to that was to let
 * the list scroll inside itself — which showed three districts, looked like a
 * list of three, and hid the fact that there were four more behind a scrollbar
 * most people never see. A list that is cut and does not look cut is worse than
 * a shorter one. So it shows the top three by rank and says, in a control you
 * can press, exactly how many there are: "7 districts — show all".
 *
 * Above ROOMY it is open to begin with, because everything fits and closing it
 * would be hiding four rows for no reason. Once the reader decides either way
 * their choice holds, whatever the window then does.
 */
function Districts({
  zones,
  entered,
  onEnter,
  roomy,
  loading,
  error,
}: {
  zones: Zone[];
  entered: string | null;
  onEnter: (id: string) => void;
  /** Whether the window is tall enough to hold every row without scrolling. */
  roomy: boolean;
  loading: boolean;
  error: string | null;
}) {
  /** null while it is following the window; a boolean once someone has chosen. */
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? roomy;
  const shown = open ? zones : zones.slice(0, DISTRICTS_SHUT);

  return (
    <section className="cdist">
      <h2 className="ctitle">
        The districts
        <span className="ctitle__note">busiest at the centre</span>
      </h2>

      {error && zones.length === 0 ? (
        <PaneState
          state="failed"
          title="The directory could not be read."
          detail={`${error} Nothing is drawn from a survey that did not arrive.`}
        />
      ) : loading && zones.length === 0 ? (
        <PaneState state="loading" title="Reading the directory…" />
      ) : zones.length === 0 ? (
        <PaneState
          state="empty"
          title="The directory named no rooms."
          detail="It answered, and the list in it was empty."
        />
      ) : (
        <>
          <ol className="drows">
            {shown.map((zone) => (
              <li key={zone.district.id}>
                <button
                  type="button"
                  className="drow"
                  aria-current={zone.district.id === entered ? 'true' : undefined}
                  onClick={() => onEnter(zone.district.id)}
                >
                  <span className="drow__n">{zone.index}</span>
                  <span className="drow__name">{zone.district.label}</span>
                  <span className="drow__form">{FORM_SHORT[zone.form]}</span>
                  <span className="drow__count">{num.format(zone.count)}</span>
                </button>
              </li>
            ))}
          </ol>

          {zones.length > DISTRICTS_SHUT && (
            <button
              type="button"
              className="dmore"
              aria-expanded={open}
              onClick={() => setChosen(!open)}
            >
              {open
                ? `The busiest ${DISTRICTS_SHUT} only`
                : `${plural(zones.length, 'district')} — show all`}
              <svg className="dmore__v" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 6.2 8 10.4l4.5-4.2" />
              </svg>
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Busiest now
// ---------------------------------------------------------------------------

/**
 * A room's rate between each pair of reads, drawn.
 *
 * Deliberately unlabelled and deliberately not a chart: it has no axis, no
 * scale and no gridlines, because it is not making a quantitative claim — the
 * figure beside it is. What it says is the shape of the last few minutes, which
 * is the one thing a figure cannot say. Scaled to its own maximum, so two
 * sparklines side by side are two shapes and never a comparison.
 */
function Spark({ series }: { series: number[] }) {
  if (series.length < 2) return <span className="spark spark--flat" aria-hidden="true" />;
  const top = Math.max(...series, 1);
  const step = 100 / (series.length - 1);
  const points = series
    .map((value, i) => `${(i * step).toFixed(1)},${(100 - (value / top) * 100).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * The six rooms with the most arriving, right now.
 *
 * ONLY ROOMS FOOLSCAP READS CAN BE IN HERE, which is the whole caveat and it is
 * on the panel rather than under it: a rate is two readings of the same room,
 * and the directory provides neither. So this is the busiest of eight, not the
 * busiest of fifty thousand, and the difference is worth the line it costs.
 */
function Busiest({
  rooms,
  open,
  live,
  onPick,
}: {
  rooms: CityRoom[];
  /** Rooms Foolscap is holding a reading of, for the loading state's wording. */
  open: number;
  /** Whether Foolscap is reading at this moment. The tag is drawn only if so. */
  live: boolean;
  onPick: (room: string) => void;
}) {
  const measured = rooms
    .filter((entry) => entry.ratePerMin != null)
    .sort((a, b) => (b.ratePerMin ?? 0) - (a.ratePerMin ?? 0));
  const shown = measured.slice(0, BUSIEST);
  const rest = measured.slice(BUSIEST);
  const restRate = Math.round(rest.reduce((n, entry) => n + (entry.ratePerMin ?? 0), 0));

  return (
    <section className="cpanel cbusy" aria-label="Busiest now">
      <h2 className="ctitle">
        Busiest now
        {/* THE TAG IS ABSENT WHEN IT WOULD NOT BE TRUE, which is the only
            reason it is allowed to be the accent. A tag reading LIVE over a
            table of figures from before a rate limit is the one thing this
            page must never do. */}
        {live && <span className="ctag">live</span>}
        <span className="ctitle__note">msg/min</span>
      </h2>

      {shown.length === 0 ? (
        <PaneState
          state="loading"
          title={open === 0 ? 'Opening the first rooms…' : 'Measuring the rate…'}
        />
      ) : (
        <ul className="brows">
          {shown.map((entry) => (
            <li key={entry.room}>
              <button type="button" className="brow" onClick={() => onPick(entry.room)}>
                <span className="brow__name mono">{entry.room}</span>
                <span className="brow__n">
                  {(entry.ratePerMin ?? 0) < 10
                    ? (entry.ratePerMin ?? 0).toFixed(1)
                    : num.format(Math.round(entry.ratePerMin ?? 0))}
                </span>
                <Spark series={entry.series} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {rest.length > 0 && (
        <p className="cbusy__more">
          +{num.format(restRate)} more messages a minute in {plural(rest.length, 'other room')}
        </p>
      )}

    </section>
  );
}

// ---------------------------------------------------------------------------
// The camera's own controls
// ---------------------------------------------------------------------------

/**
 * Zoom, reset, full screen — and the legend.
 *
 * Icon-only, because the labels would be four times the size of the things they
 * name and this corner is the least important thing on the page. Every one of
 * them carries a real label for anyone not reading with their eyes; the icon is
 * the shorthand, not the name.
 *
 * The wheel and the drag do the same two jobs and always did. This is for the
 * reader who will not discover that a picture on a page can be dragged, which is
 * most readers.
 */
function Tools({
  info,
  onInfo,
  onZoom,
  onReset,
  stage,
  disabled,
}: {
  info: boolean;
  onInfo: () => void;
  onZoom: (factor: number) => void;
  onReset: () => void;
  stage: { current: HTMLDivElement | null };
  disabled: boolean;
}) {
  const sound = useAudio();
  const [full, setFull] = useState(false);
  /**
   * Whether full screen is on offer at all.
   *
   * TWO CHECKS, BECAUSE ONE IS NOT ENOUGH. `fullscreenEnabled` is false where
   * the document is not permitted it, and that catches most of it — but an
   * embedded frame can report true and then refuse the request, which is what
   * this page does inside the preview pane it was built in: "Permissions check
   * failed", thrown, caught, and nothing visibly happening. A button that does
   * nothing when pressed is worse than no button, so the first refusal takes it
   * away.
   */
  const [refused, setRefused] = useState(false);
  const canFull = typeof document !== 'undefined' && document.fullscreenEnabled && !refused;

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen().catch(() => setRefused(true));
  };

  return (
    <div className="ctools" role="group" aria-label="The view">
      {!sound.unavailable && (
        <button
          type="button"
          className="ctool"
          aria-pressed={sound.wanted}
          onClick={sound.toggle}
          title={soundTitle(sound)}
          aria-label={soundTitle(sound)}
        >
          <Speaker on={sound.wanted} />
        </button>
      )}
      <button
        type="button"
        className="ctool"
        aria-pressed={info}
        onClick={onInfo}
        title="How to read the plan"
        aria-label="How to read the plan"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7.25" />
          <path d="M10 9.2v4.6" />
          <path d="M10 6.2v.9" />
        </svg>
      </button>
      <button
        type="button"
        className="ctool"
        onClick={() => onZoom(1 / 1.35)}
        disabled={disabled}
        title="Zoom out"
        aria-label="Zoom out"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4.6 10h10.8" />
        </svg>
      </button>
      <button
        type="button"
        className="ctool"
        onClick={() => onZoom(1.35)}
        disabled={disabled}
        title="Zoom in"
        aria-label="Zoom in"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4.6 10h10.8" />
          <path d="M10 4.6v10.8" />
        </svg>
      </button>
      <button
        type="button"
        className="ctool"
        onClick={onReset}
        disabled={disabled}
        title="Back to the whole plan"
        aria-label="Back to the whole plan"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="3.4" />
          <path d="M10 2.6v2.4M10 15v2.4M2.6 10h2.4M15 10h2.4" />
        </svg>
      </button>
      {canFull && (
        <button
          type="button"
          className="ctool"
          onClick={toggleFull}
          title={full ? 'Leave full screen' : 'Full screen'}
          aria-label={full ? 'Leave full screen' : 'Full screen'}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            {full ? (
              <path d="M8.2 3.4v4.8H3.4M11.8 16.6v-4.8h4.8" />
            ) : (
              <path d="M3.4 8.2V3.4h4.8M16.6 11.8v4.8h-4.8" />
            )}
          </svg>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// How to read it
// ---------------------------------------------------------------------------

function Legend({
  surveyed,
  lag,
  total,
  live,
  quiet,
  failing,
  measured,
  lit,
  onClose,
}: {
  surveyed: number;
  lag: string | null;
  total: number | null;
  live: number;
  quiet: number;
  failing: number;
  measured: number;
  lit: number;
  onClose: () => void;
}) {
  return (
    <section className="cpanel cinfo" aria-label="How to read the plan">
      <div className="cinfo__head">
        <h2 className="ctitle">How to read it</h2>
        <button type="button" className="cinfo__close" onClick={onClose}>
          Close <kbd>Esc</kbd>
        </button>
      </div>

      <dl className="legend">
        <dt>Distance from the centre</dt>
        <dd>
          the district&rsquo;s rank by messages carried — busiest innermost. A rank, not a
          quantity. The compass bearing means nothing at all and is only packing.
        </dd>
        <dt>Shape</dt>
        <dd>
          each district is arranged by its own character — a ring of peers, a stepped sequence, a
          plain grid, a dense stack — so one can be told from another without spending a colour on
          it.
        </dd>
        <dt>Height</dt>
        <dd>
          messages the room has carried, on a log scale: ten times the traffic is one step
          taller, and the step is the same wherever you are on it. The lowest blocks are rooms
          with under a hundred messages in them, which is most of the plan.
        </dd>
        <dt>Footprint</dt>
        <dd>
          how many rooms share that district&rsquo;s ground, in three sizes — a district of three
          rooms gets wide plots, one of a hundred and thirty gets narrow ones. It is the count in
          the list above, drawn; it says nothing about the room standing on it.
        </dd>
        <dt>Shade</dt>
        <dd>
          one light, fixed, over your left shoulder: every block is lit the same way, so the face
          you are looking at tells you which way it faces and nothing more. The far side of the
          plan is slightly darker than the near side, which is distance and not a reading.
        </dd>
        <dt>
          <span className="cdot cdot--live" aria-hidden="true" /> Lit
        </dt>
        <dd>
          the room is one Foolscap reads, it is live, <em>and</em> its newest message verified
          against the key that message names — checked here, in this browser. All three, or it
          stays grey. A room can be taking twenty messages a second that nobody signed, and
          lighting it would claim something about traffic nothing can vouch for.
        </dd>
        <dt>
          <span className="cdot cdot--failing" aria-hidden="true" /> Marked
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
          a room from the directory only. Foolscap knows its size, not its state, and does not
          guess.
        </dd>
        <dt>fps</dt>
        <dd>
          frames a second the loop is keeping. It draws only when something moved, so this is the
          rate available rather than work being done.
        </dd>
        <dt>Sound</dt>
        <dd>
          off unless you switch it on, and generated here rather than played back — there is no
          audio file on this site. A drone whose filter opens as the measured rate rises, and one
          soft tone for each verified message in the live view, pitched by the first byte of the
          key that signed it. The same sender is always the same note. The tones are capped at a
          few a second, so they are who and not how many; the rate is in the drone.
        </dd>
      </dl>

      {/* The count of the thing the accent is spent on, next to the rule that
          decides it. It was a line on the busiest panel, which is where a
          reader sees the rates and not where they can find out what lit means.
          Two sentences rather than one list: the states and the rate are
          counted over different things, and joining them with an "of" said
          "5 live, of 0 rooms with a measured rate" for the first half minute
          of every visit. */}
      <p className="ccaption">
        Right now, of the {plural(live + quiet + failing, 'room')} Foolscap has read:{' '}
        {num.format(live)} live, {num.format(quiet)} quiet
        {failing > 0 ? `, ${num.format(failing)} failing` : ''}, and {num.format(lit)} lit — live{' '}
        <em>and</em> verifying.{' '}
        {measured === 0
          ? 'None has a rate measured yet; that needs two reads of the same room.'
          : `${plural(measured, 'room')} with a rate measured.`}
      </p>

      <p className="ccaption">
        The directory is one request that returns the busiest{' '}
        {surveyed ? num.format(surveyed) : SURVEY_ROOMS} rooms
        {total ? ` of ${num.format(total)}` : ''}. The server caches it hard and it carries no
        timestamp
        {lag
          ? `; measured against the rooms Foolscap reads directly, it is running about ${lag} behind`
          : ''}
        . Nothing current is derived from it.
      </p>

      <p className="ccaption">
        Click a district&rsquo;s ground to go into it and watch its traffic arrive, checked as it
        lands. Click a building for one room. Drag to orbit, scroll to zoom.
      </p>

      <p className="ccaption">
        Waiting on a sonnet-2 receipt? <Link to="/track">The Tracker</Link> reads the contest rooms
        in full and checks every receipt against the pinned referee key.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

/**
 * The caveat, across the bottom, always.
 *
 * It was in the legend, which meant it was behind a click, which meant most
 * people reading this page never saw the three things that qualify everything on
 * it. None of them is small print: the shape of the city is a snapshot that can
 * be a day old, the districts are guesses made from names strangers chose, and
 * the only current thing here is eight rooms wide.
 */
function Band({
  total,
  drawn,
  lag,
  noCanvas,
  error,
}: {
  total: number | null;
  drawn: number;
  lag: string | null;
  noCanvas: string | null;
  error: string | null;
}) {
  if (noCanvas !== null) {
    return (
      <p className="cband cband--alarm" data-canvas-inset="bottom" role="alert">
        <span className="cband__what">No plan</span>
        The drawing needs WebGL and this browser did not provide it — {noCanvas} Every figure on
        this page is measured and shown without it; the picture is the part that is missing.
      </p>
    );
  }

  return (
    <p className="cband" data-canvas-inset="bottom">
      <span className="cband__what">What this is not</span>
      The directory is edge-cached for up to a day, so the {num.format(drawn)} rooms drawn
      {total ? ` of ${num.format(total)}` : ''}, and every size on the plan, are a snapshot
      {lag ? ` running about ${lag} behind` : ''} rather than a reading.{' '}
      <span className="cband__sep" aria-hidden="true">
        ·
      </span>{' '}
      Districts are inferred from room names, and a name is a string its creator chose.{' '}
      <span className="cband__sep" aria-hidden="true">
        ·
      </span>{' '}
      Only the {WATCHED.length} rooms Foolscap reads itself can be live. It reads one every four
      seconds, and posts nothing, ever.
      {error ? ` · ${error}` : ''}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Inside a district
// ---------------------------------------------------------------------------

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

  /**
   * One tone per verified message, at most one per message, ever.
   *
   * Keyed on seq and remembered, because a message's verdict arrives after the
   * message does — the check is asynchronous — so this effect sees each one
   * twice: once unchecked, once decided. It fires on the second. An unsigned
   * message makes no sound, which is the same rule the city's roofs follow: it
   * is the ordinary case here and it is not a failure.
   *
   * ping() drops anything arriving faster than a tone every ninety
   * milliseconds, so a room at twenty-five a second is a texture rather than an
   * alarm. Nothing anywhere presents the tones as a count.
   */
  const sounded = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (sounded.current.size > 4000) sounded.current.clear();
    for (const message of feed.messages) {
      if (sounded.current.has(message.seq)) continue;
      const verdict = feed.readings.get(message.seq)?.verdict;
      if (!verdict) continue;
      sounded.current.add(message.seq);
      if (verdict === 'verified') ping(message.from);
    }
  }, [feed.messages, feed.readings]);

  // A different room is a different set of seqs; do not carry the old ones.
  useEffect(() => {
    sounded.current.clear();
  }, [reading]);

  return (
    <section className="cpanel inside" aria-label={`Inside ${zone.district.label}`}>
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
              and {num.format(rooms.length - 8)} more in this district, by name in the field above
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
        detail="Every room in this district is above; pick one and Foolscap will read it here."
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
    <section className="cpanel detail" aria-label={room.room}>
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
            {room.volumeRead ? 'read directly just now' : 'from the directory'}
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
          <p className="ccaption">
            A topic can be set on any room by any caller, without ever posting to it. Shown because
            it is there, not because it is true.
          </p>
        </div>
      )}

      {isContest && (
        <p className="ccaption">
          A sonnet-2 contest room. <Link to="/track">The Tracker</Link> reads this one in full and
          checks every receipt in it against the pinned referee key.
        </p>
      )}
    </section>
  );
}
