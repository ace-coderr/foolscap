// Holdfast.tsx — a territory game played on note namespaces.
//
// THE HONEST VERSION FIRST, because the page is built around it and there is no
// reading order in which it comes second.
//
// A note on technocore.chat is world-writable and unsigned. Anybody can
// overwrite anybody's note with one HTTP request, and the server neither knows
// nor records who did. There is no owner and no permission. So "holding" a plot
// here does not mean owning it, and this page never uses a word that suggests it
// does: it means you wrote the note last and have kept coming back before the
// server reclaimed it. That is the whole of the claim, it is said in those words
// in the band at the bottom, and every figure on the page is qualified by it.
//
// What the game runs on is the two things the server DOES enforce, identically
// for everyone, with no appeal:
//
//   ?if_absent=1   the claim races at the origin. One 200, one 409.
//   seven days     an unwritten note is deleted. Go quiet and you lose it.
//
// And what Foolscap adds is the one thing it can add without holding anything: a
// signature inside the note, checked in this browser before a name is put
// against a plot. It cannot stop your plot being taken. It stops somebody taking
// it in YOUR name.
//
// ---------------------------------------------------------------------------
// THE BOARD IS THE CITY'S RENDERER. Not a copy of it, not a variant — the same
// file, with a structural prop type it can satisfy from either page. Plots are
// buildings; height is days held, brightness is time left before reclamation,
// districts are key prefixes. The one state colour on it is the accent, on the
// plots the connected key holds, and it is the only thing the accent means here.
//
// FOOLSCAP NEVER WRITES. It builds the URL that claims a plot and shows it. The
// player signs wherever their key lives and makes the request themselves. There
// is no field on this page that takes a private key, and the one that takes a
// signature takes a signature — public, already made, and checked here before
// the URL is offered.

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { pageById } from '../pages.ts';
import { num, plural, formatAge } from '../format.ts';
import { useInView, usePrefersReducedMotion } from '../motion.ts';
import { looksLikeDid, verify } from '../lib/did.ts';
import { noteReadUrl, noteWriteUrl } from '../lib/kv.ts';
import {
  availableCharacters,
  checkKey,
  claimMessage,
  DANGER_MS,
  formatClaim,
  formatSpan,
  type ClaimFault,
} from '../holdfast/rules.ts';
import type { BoardPlot, Standing } from '../holdfast/board.ts';
import { LANDS, MAX_PLOTS_PER_LAND, useHoldfast, usePlotRefresh } from '../useHoldfast.ts';

/** Three.js is most of this page's weight and none of it is needed to read the rules. */
const CityCanvas = lazy(() => import('../city/CityCanvas'));

/** The leaderboard is a top fifty, as specified. Below that is a different page. */
const LEADERBOARD_SIZE = 50;

const shortDid = (did: string): string => `${did.slice(0, 16)}…${did.slice(-6)}`;

/** Why a plot that exists is not attributed to anyone, in words a player can act on. */
const FAULT_WORD: Record<ClaimFault, string> = {
  unreadable: 'a note, but not a Holdfast claim',
  'bad-signature': 'a claim whose signature does not check out',
  future: 'a claim dated in the future',
  'renewed-before-claimed': 'a claim renewed before it was made',
  stale: 'a claim whose renewal is older than the note can be',
};

export default function Holdfast() {
  const [connected, setConnected] = useState<string | null>(null);
  const { board, state, resumeAt, lastError, paused, now, listing } = useHoldfast(connected);
  const reducedMotion = usePrefersReducedMotion();

  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [noCanvas, setNoCanvas] = useState<string | null>(null);

  // Stable, or the canvas tears itself down and rebuilds on every note that lands.
  const onSelect = useCallback((id: string | null) => setSelected(id), []);
  const onHover = useCallback((id: string | null) => setHovered(id), []);
  const onUnavailable = useCallback((reason: string) => setNoCanvas(reason), []);

  const shown = selected ?? hovered;
  const plot = shown ? (board.plots.find((entry) => entry.room === shown) ?? null) : null;

  return (
    <Shell page="holdfast" variant="bands">
      <Hero connected={connected} setConnected={setConnected} board={board} listing={listing} />

      <BoardBand
        board={board}
        plot={plot}
        selected={selected}
        connected={connected}
        onSelect={onSelect}
        onHover={onHover}
        onUnavailable={onUnavailable}
        noCanvas={noCanvas}
        reducedMotion={reducedMotion}
        now={now}
        state={state}
        resumeAt={resumeAt}
        lastError={lastError}
        paused={paused}
      />

      <Standings standings={board.standings} connected={connected} board={board} />

      <Claiming connected={connected} board={board} />

      <Honesty />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

/**
 * The game on the left, the key on the right.
 *
 * --t-answer is spent here and nowhere else on the page: how much ground the
 * connected key holds, or — with nothing connected — how many plots are standing
 * at all. It is the figure a player came to find, and it is the only one on the
 * page set at that step.
 *
 * A did:key is a PUBLIC identifier. Typing one here is the same act as typing
 * one into Notary's lookup: it says which player to colour the board for. It is
 * not a login, it authorises nothing, and nothing on this page will ever ask for
 * the other half of it.
 */
function Hero({
  connected,
  setConnected,
  board,
  listing,
}: {
  connected: string | null;
  setConnected: (did: string | null) => void;
  board: ReturnType<typeof useHoldfast>['board'];
  listing: boolean;
}) {
  const page = pageById('holdfast')!;
  const [field, setField] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const mine = board.counts.mine;
  const answer = connected ? mine : board.counts.plots;

  return (
    <section className="section hband-hero" aria-labelledby="holdfast-title">
      <div className="band__inner hband-hero__inner">
        <div className="hband-hero__lede">
          <p className="hband-hero__eyebrow">{page.eyebrow}</p>
          <h1 className="hband-hero__title" id="holdfast-title">
            {page.title}
          </h1>
          <p className="hband-hero__line">{page.line}</p>

          <p className="answer hband-hero__answer">
            {listing && board.counts.plots === 0 ? '—' : num.format(answer)}
          </p>
          <p className="hband-hero__caption">
            {connected
              ? `${plural(mine, 'plot')} held by this key, of ${plural(board.counts.plots, 'plot')} standing. ` +
                'Held means its note carries a signature from this key and the server has not yet reclaimed it.'
              : listing
                ? 'Reading the board.'
                : `${plural(board.counts.plots, 'plot')} standing across ${plural(LANDS.length, 'land')}. ` +
                  'Every one of them is a note somebody wrote inside the last seven days.'}
          </p>
        </div>

        <div className="hband-hero__ask">
          <form
            className="hlookup glass"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              const did = field.trim();
              if (did === '') {
                setConnected(null);
                setProblem(null);
                return;
              }
              if (!looksLikeDid(did)) {
                setProblem(
                  'That is not an Ed25519 did:key. They begin did:key:z6Mk and run about 56 characters.'
                );
                return;
              }
              setProblem(null);
              setConnected(did);
            }}
          >
            <label className="lookup__label" htmlFor="holdfast-did">
              Your did:key
            </label>
            <input
              className="lookup__input mono hlookup__did"
              id="holdfast-did"
              name="did"
              type="text"
              inputMode="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="did:key:z6Mk…"
              value={field}
              onChange={(event) => setField(event.target.value)}
            />
            <div className="hlookup__row">
              <button className="lookup__submit" type="submit">
                {connected ? 'Change key' : 'Show my ground'}
              </button>
              {connected && (
                <button
                  className="hlookup__clear"
                  type="button"
                  onClick={() => {
                    setField('');
                    setConnected(null);
                  }}
                >
                  Disconnect
                </button>
              )}
            </div>
            {problem && <p className="hlookup__problem">{problem}</p>}
          </form>

          <p className="hlookup__nokey">
            The public half only. Holdfast never asks for a private key, never holds one, and
            never makes a write on your behalf — it builds the URL and you make the request. A
            did:key pasted here does nothing but decide which plots are drawn as yours.
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

function BoardBand({
  board,
  plot,
  selected,
  connected,
  onSelect,
  onHover,
  onUnavailable,
  noCanvas,
  reducedMotion,
  now,
  state,
  resumeAt,
  lastError,
  paused,
}: {
  board: ReturnType<typeof useHoldfast>['board'];
  plot: BoardPlot | null;
  selected: string | null;
  connected: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onUnavailable: (reason: string) => void;
  noCanvas: string | null;
  reducedMotion: boolean;
  now: number;
  state: string;
  resumeAt: number | null;
  lastError: string | null;
  paused: boolean;
}) {
  const { counts } = board;
  const unread = counts.plots - counts.read;

  return (
    <section className="hboard-band" id="board" aria-label="The board">
      <div className="hboard" data-canvas-stage>
        {noCanvas === null && counts.plots > 0 && (
          <Suspense fallback={<div className="city__stage" />}>
            <CityCanvas
              rooms={board.plots}
              plots={board.layout.plots}
              radius={board.layout.radius}
              selected={selected}
              onSelect={onSelect}
              onHover={onHover}
              reducedMotion={reducedMotion}
              onUnavailable={onUnavailable}
            />
          </Suspense>
        )}

        {counts.plots === 0 && (
          <div className="hboard__empty">
            <p className="hboard__empty-title">No ground has been claimed.</p>
            <p className="hboard__empty-line">
              Every plot on this board is a note somebody wrote. There are none, so there is no
              board yet — the first claim makes one. See <a href="#claim">how to claim a plot</a>.
            </p>
          </div>
        )}

        <aside className="panel hboard__panel" data-canvas-panel aria-label="Plot detail">
          {plot ? (
            <PlotPanel plot={plot} connected={connected} now={now} />
          ) : (
            <BoardSummary board={board} connected={connected} />
          )}

          <section>
            <p className="panel__title">How to read it</p>
            <ul className="hlegend">
              <li>
                <span className="hlegend__term">Height</span> days held unbroken, as the plot&rsquo;s
                own note claims. Nothing can check that figure.
              </li>
              <li>
                <span className="hlegend__term">Brightness</span> time left before the server
                reclaims it. A plot fades through its last day and everyone sees it fade.
              </li>
              <li>
                <span className="hlegend__term">A flat tile</span> a plot Foolscap has listed and
                not yet read. Not an empty one.
              </li>
              <li>
                <span className="hlegend__term">District</span> the key&rsquo;s prefix — everything
                before its first hyphen, in one land.
              </li>
              {connected && (
                <li>
                  <span className="hlegend__term hlegend__term--mine">A capped plot</span> held by
                  the key you connected.
                </li>
              )}
            </ul>
          </section>

          <section>
            <p className="panel__title">
              What has been read{' '}
              <span className="panel__title-note">
                {num.format(counts.read)} of {num.format(counts.plots)}
              </span>
            </p>
            <p className="panel__caption">
              Listing a land is one request and gives the whole board. Reading who holds a plot is
              one request <em>per plot</em>, so Foolscap goes round them slowly rather than firing
              hundreds at once.{' '}
              {unread > 0
                ? `${plural(unread, 'plot')} not yet read; they are drawn as flat tiles and are absent from the standings.`
                : 'Every plot on the board has been read at least once.'}
            </p>
            {paused && <p className="panel__caption">Paused — this tab is in the background.</p>}
            {state === 'backing-off' && (
              <p className="panel__caption panel__caption--warn">
                Rate limited. Standing down
                {resumeAt ? ` for ${formatAge(Math.max(0, resumeAt - now))}` : ''}.
              </p>
            )}
            {state === 'failed' && lastError && (
              <p className="panel__caption panel__caption--warn">{lastError}</p>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

function BoardSummary({
  board,
  connected,
}: {
  board: ReturnType<typeof useHoldfast>['board'];
  connected: string | null;
}) {
  const { counts, lands } = board;
  const capped = lands.filter((land) => land.total > land.plots);
  return (
    <section>
      <p className="panel__title">The board</p>
      <dl className="hfacts">
        <div>
          <dt>Standing</dt>
          <dd>{num.format(counts.plots)}</dd>
        </div>
        <div>
          <dt>Attributed</dt>
          <dd>{num.format(counts.held)}</dd>
        </div>
        <div>
          <dt>Unattributed</dt>
          <dd>{num.format(counts.unattributed)}</dd>
        </div>
        <div>
          <dt>Falling within a day</dt>
          <dd>{num.format(counts.inDanger)}</dd>
        </div>
      </dl>
      <p className="panel__caption">
        Unattributed means the note is there and Foolscap will not put a name to it — most often
        somebody&rsquo;s ordinary note in a land the game also watches.
        {connected ? '' : ' Connect a did:key to see which plots are yours.'}
      </p>
      <ul className="hlands">
        {lands.map((land) => (
          <li key={land.ns}>
            <span className="mono">{land.ns}</span>
            <span className="hlands__count">
              {land.error
                ? 'could not be listed'
                : land.listedAt == null
                  ? 'listing…'
                  : `${num.format(land.read)}/${num.format(land.plots)} read`}
            </span>
          </li>
        ))}
      </ul>
      {capped.length > 0 && (
        <p className="hlands__capped">
          {capped.map((land) => `${land.ns} holds ${num.format(land.total)} keys`).join(', ')}, and
          the board draws the first {num.format(MAX_PLOTS_PER_LAND)} of each in key order. The rest
          are real plots that are not on this board and are counted for nobody — a run that
          continues past the cut is scored only as far as the cut.
        </p>
      )}
      <p className="panel__caption">
        Click a plot for its note, its claim, and the URL that renews it.
      </p>
    </section>
  );
}

/**
 * One plot, and what is actually known about it.
 *
 * The layout of this panel is the argument the page keeps making: the server's
 * facts first, the note's claims second, visibly under a different heading. What
 * the server will vouch for is that the note exists and therefore was written
 * this week. Everything below that line is somebody's assertion about
 * themselves.
 */
function PlotPanel({
  plot,
  connected,
  now,
}: {
  plot: BoardPlot;
  connected: string | null;
  now: number;
}) {
  const { refresh, busy } = usePlotRefresh();
  const [fresh, setFresh] = useState<{ at: number; value: string | null } | null>(null);
  useEffect(() => setFresh(null), [plot.room]);

  const danger = plot.reclaimInMs != null && plot.reclaimInMs < DANGER_MS;

  return (
    <section>
      <p className="panel__title">
        <span className="mono">{plot.key}</span>
        <span className="panel__title-note">{plot.ns}</span>
      </p>

      <dl className="hfacts">
        <div>
          <dt>District</dt>
          <dd className="mono">{plot.prefix}</dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd>#{num.format(plot.index + 1)}</dd>
        </div>
      </dl>

      <p className="panel__caption">
        The server will say this much: the note exists, so somebody wrote it within the last seven
        days. It says nothing about who, and nothing about when.
      </p>

      {!plot.read ? (
        <p className="hplot__unread">
          Not read yet. Foolscap has listed this plot and has not fetched its note.
        </p>
      ) : plot.holder ? (
        <>
          <p className="panel__title hplot__heading">What the note claims</p>
          <dl className="hfacts">
            <div>
              <dt>Holder</dt>
              <dd className="mono hplot__did">{shortDid(plot.holder)}</dd>
            </div>
            <div>
              <dt>Held for</dt>
              <dd>{formatSpan(plot.heldMs) ?? '—'}</dd>
            </div>
            <div>
              <dt>Reclaimed in</dt>
              <dd className={danger ? 'hplot__danger' : undefined}>
                {formatSpan(plot.reclaimInMs) ?? '—'}
              </dd>
            </div>
          </dl>
          <p className="panel__caption">
            The signature checked out against that key, here in this browser, so the claim was
            made by whoever holds it.{' '}
            <strong>How long it has been held is the note&rsquo;s own figure</strong> — it is
            signed, which stops anyone else writing it, and nothing stops the holder backdating
            it.
          </p>
          {plot.mine && <p className="hplot__mine">This is yours. Renew it before it falls.</p>}
        </>
      ) : (
        <p className="hplot__fault">
          {plot.fault
            ? `Unattributed: ${FAULT_WORD[plot.fault]}.`
            : 'Unattributed: nothing was there when Foolscap last read it.'}
        </p>
      )}

      <p className="panel__caption">
        <a className="hplot__link mono" href={noteReadUrl(plot.ns, plot.key)} target="_blank" rel="noreferrer noopener">
          {noteReadUrl(plot.ns, plot.key)}
        </a>
      </p>

      <button
        className="hbutton"
        type="button"
        disabled={busy === plot.room}
        onClick={() => {
          void refresh(plot.room).then((reading) => {
            if (reading) setFresh({ at: reading.readAt, value: reading.value });
          });
        }}
      >
        {busy === plot.room ? 'Reading…' : 'Read this note now'}
      </button>

      {fresh && (
        <p className="panel__caption">
          Read {formatAge(Math.max(0, now - fresh.at)) ?? 'just now'} ago.{' '}
          {fresh.value == null ? 'Nothing is there — the plot is free.' : 'The board has it.'}
        </p>
      )}

      {connected == null && (
        <p className="panel__caption">Connect a did:key to build the URL that claims this plot.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

/**
 * Three columns because there are three ways to be ahead, and a game with one
 * is a race everybody runs the same way.
 *
 * PLOTS rewards breadth and is the easiest to move. LONGEST HOLD rewards coming
 * back, week after week, and cannot be bought quickly — except by backdating,
 * which is why the column says whose figure it is. LARGEST BLOCK rewards
 * choosing ground next to ground you already have, and it is the only one of
 * the three that another player can take from you without touching your plots:
 * claim the key in the middle of your run and the run is two runs.
 */
function Standings({
  standings,
  connected,
  board,
}: {
  standings: Standing[];
  connected: string | null;
  board: ReturnType<typeof useHoldfast>['board'];
}) {
  const [bandRef, seen] = useInView<HTMLElement>();
  const top = standings.slice(0, LEADERBOARD_SIZE);
  const unread = board.counts.plots - board.counts.read;

  return (
    <section
      className="band band--rules"
      id="standings"
      ref={bandRef}
      data-in={seen}
      aria-labelledby="standings-title"
    >
      <div className="band__inner band__split">
        <div className="band__left">
          <p className="band__eyebrow">Standings</p>
          <h2 className="band__title" id="standings-title">
            Who holds what, as far as anyone has looked.
          </h2>
          <p className="band__copy">
            Computed in this browser from the notes it has read — there is no server keeping
            score, and nothing to take anyone&rsquo;s word for beyond the notes themselves.
          </p>
        </div>
        <div className="band__right">
          <p className="band__copy">
            Three columns because there are three ways to be ahead. Breadth is the easiest to
            move. A long hold is the hardest to fake cheaply and the easiest to lose by going
            quiet for a week. A block is the only one another player can break without touching a
            plot of yours: claim the key in the middle of your run and it is two runs.
          </p>
          {unread > 0 && (
            <p className="hstandings__caveat">
              Foolscap has not yet read {plural(unread, 'plot')} on this board. Nothing is counted
              for them, and a run of yours that passes through one is scored as two runs.
            </p>
          )}
        </div>
      </div>

      <div className="band__inner">
        {top.length === 0 ? (
          <p className="empty">Nobody holds anything that Foolscap has read.</p>
        ) : (
          <div className="hstandings">
            <div className="hstandings__head" role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">Key</span>
              <span role="columnheader">Plots</span>
              <span role="columnheader">Longest hold</span>
              <span role="columnheader">Largest block</span>
            </div>
            <ol className="hstandings__rows">
              {top.map((row, i) => (
                <li
                  className={`hstandings__row${row.did === connected ? ' hstandings__row--mine' : ''}`}
                  key={row.did}
                >
                  <span className="hstandings__rank">{i + 1}</span>
                  <span className="mono hstandings__did" title={row.did}>
                    {shortDid(row.did)}
                  </span>
                  <span className="hstandings__figure">{num.format(row.plots)}</span>
                  <span className="hstandings__figure">{formatSpan(row.longestHeldMs) ?? '—'}</span>
                  <span className="hstandings__figure">{num.format(row.largestBlock)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <p className="band__copy band__prose hstandings__note">
          “Longest hold” is the figure the plot&rsquo;s own note states. It is signed, so no other
          player can write it, and the holder can set it to whatever they like. Treat the column
          as a claim in a ledger anyone can read rather than as a measurement.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

interface Draft {
  ns: string;
  key: string;
  claimedAt: number;
  renewedAt: number;
  /** Set when renewing: the exact value read, for ?if=. Null for a fresh claim. */
  ifValue: string | null;
}

/**
 * Name a plot, sign the line, make the request yourself.
 *
 * THE TIMESTAMPS ARE FROZEN WHEN THE DRAFT IS MADE and not a moment later. The
 * signature covers them; if the page re-read the clock while building the URL,
 * it would hand over a URL whose value no longer matched what was signed, and
 * the claim would land unattributed. The draft is the commitment point.
 *
 * The signature is verified here before the URL is shown. Not gatekeeping — the
 * player can construct the request without this page at all — but a URL that
 * carries a signature nobody will credit is worse than no URL, and the check is
 * one call to the same code that reads the board.
 */
function Claiming({
  connected,
  board,
}: {
  connected: string | null;
  board: ReturnType<typeof useHoldfast>['board'];
}) {
  const [bandRef, seen] = useInView<HTMLElement>();
  const [ns, setNs] = useState(LANDS[0]);
  const [key, setKey] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sig, setSig] = useState('');
  const [sigState, setSigState] = useState<'idle' | 'checking' | 'good' | 'bad'>('idle');

  const letters = useMemo(() => (connected ? availableCharacters(connected) : []), [connected]);
  const check = useMemo(
    () => (connected && key ? checkKey(connected, key) : null),
    [connected, key]
  );
  const taken = useMemo(
    () => board.plots.find((plot) => plot.ns === ns && plot.key === key) ?? null,
    [board.plots, ns, key]
  );

  const message = draft && connected ? claimMessage({ ...draft, did: connected }) : null;

  // Re-check whenever either half changes. Checked rather than pattern-matched:
  // a signature of the right shape over the wrong string is exactly the mistake
  // this catches, and it is the likely one — the string moved on while the
  // player was signing.
  useEffect(() => {
    if (!message || !connected || sig.trim() === '') {
      setSigState('idle');
      return;
    }
    let cancelled = false;
    setSigState('checking');
    void verify(connected, message, sig.trim())
      .then((ok) => {
        if (!cancelled) setSigState(ok ? 'good' : 'bad');
      })
      .catch(() => {
        if (!cancelled) setSigState('bad');
      });
    return () => {
      cancelled = true;
    };
  }, [message, connected, sig]);

  const url =
    draft && connected && sigState === 'good'
      ? noteWriteUrl({
          ns: draft.ns,
          key: draft.key,
          value: formatClaim({
            did: connected,
            claimedAt: draft.claimedAt,
            renewedAt: draft.renewedAt,
            sig: sig.trim(),
          }),
          ifAbsent: draft.ifValue == null,
          ifValue: draft.ifValue,
        })
      : null;

  return (
    <section
      className="band band--rules"
      id="claim"
      ref={bandRef}
      data-in={seen}
      aria-labelledby="claim-title"
    >
      <div className="band__inner band__split">
        <div className="band__left">
          <p className="band__eyebrow">Claiming</p>
          <h2 className="band__title" id="claim-title">
            Foolscap builds the URL. You make the request.
          </h2>
          <p className="band__copy">
            There is no field on this page that takes a private key, and there is no request this
            page makes on your behalf. It writes out the line to sign and the address to send, and
            the signing happens wherever your key lives.
          </p>
          <p className="band__copy">
            A claim goes out with <span className="mono">?if_absent=1</span>, so the server writes
            it only if the plot is free and answers <span className="mono">409</span> if somebody
            beat you to it. A renewal goes out with <span className="mono">?if=</span> the exact
            value now there, so it cannot land on top of whoever took the plot while you were
            signing.
          </p>
        </div>

        <div className="band__right">
          {connected == null ? (
            <p className="hclaim__gate">
              Connect a did:key at the top of the page. Which plots you can name depends on which
              characters are in it.
            </p>
          ) : (
            <>
              <p className="panel__title hclaim__heading">Your letters</p>
              <p className="hclaim__letters mono">
                {letters.map((ch) => (
                  <span className="hclaim__letter" key={ch}>
                    {ch}
                  </span>
                ))}
              </p>
              <p className="band__copy">
                A plot&rsquo;s name may only use characters your own key contains — the same idea
                as sonnet-2&rsquo;s word rule, on the alphabet a did:key and a note key share.
                Case is folded, so a capital in your key buys you the small letter. Hyphen and
                underscore are free to everyone; they are punctuation between letters rather than
                letters, and without them there would be no prefixes and so no districts.{' '}
                <strong>
                  Nobody can ever name a plot with a <span className="mono">0</span> in it
                </strong>{' '}
                — base58 leaves the digit out altogether, so no key contains one.
              </p>
            </>
          )}
        </div>
      </div>

      {connected && (
        <div className="band__inner">
          <form
            className="hclaim glass"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              const now = Math.floor(Date.now() / 1000);
              const held = taken?.mine ? taken : null;
              setSig('');
              setSigState('idle');
              setDraft({
                ns,
                key,
                // Renewing keeps the original claim date, so the hold stays
                // unbroken. Claiming fresh starts both clocks now.
                claimedAt: held?.heldMs != null ? Math.floor((Date.now() - held.heldMs) / 1000) : now,
                renewedAt: now,
                ifValue: null,
              });
            }}
          >
            <div className="hclaim__row">
              <div className="hclaim__field">
                <label className="lookup__label" htmlFor="holdfast-land">
                  Land
                </label>
                <select
                  className="lookup__input hclaim__select"
                  id="holdfast-land"
                  value={ns}
                  onChange={(event) => {
                    setNs(event.target.value);
                    setDraft(null);
                  }}
                >
                  {LANDS.map((land) => (
                    <option key={land} value={land}>
                      {land}
                    </option>
                  ))}
                </select>
              </div>
              <div className="hclaim__field hclaim__field--grow">
                <label className="lookup__label" htmlFor="holdfast-key">
                  Name a plot
                </label>
                <input
                  className="lookup__input mono"
                  id="holdfast-key"
                  type="text"
                  inputMode="text"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="north-gate"
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value.toLowerCase());
                    setDraft(null);
                  }}
                />
              </div>
              <button className="lookup__submit hclaim__go" type="submit" disabled={!check?.ok}>
                {taken?.mine ? 'Renew' : 'Claim'}
              </button>
            </div>

            {check && !check.ok && <p className="hclaim__problem">{check.reason}</p>}
            {check?.ok && taken && !taken.mine && (
              <p className="hclaim__problem">
                Somebody is standing there.{' '}
                {taken.holder
                  ? 'It is claimed and the claim checks out — you would be taking it, and the server will let you.'
                  : 'A note is there that Foolscap will not attribute.'}{' '}
                Claiming over it needs no <span className="mono">if_absent</span>, and that is
                exactly what makes this game what it is.
              </p>
            )}
            {check?.ok && !taken && (
              <p className="hclaim__free">
                Free as of the last listing. The race is settled at the server, not here.
              </p>
            )}
          </form>

          {draft && message && (
            <div className="hsteps">
              <ol className="hsteps__list">
                <li>
                  <p className="hsteps__label">Sign this line with {shortDid(connected)}</p>
                  <p className="hsteps__value mono">{message}</p>
                  <p className="hsteps__note">
                    Ed25519 over those exact bytes, base64url, unpadded — the same shape Foolscap
                    checks everywhere else. The timestamps are fixed now, at the moment you asked:
                    signing a different line would produce a claim this page, and anyone else
                    reading the board, would decline to attribute.
                  </p>
                </li>
                <li>
                  <p className="hsteps__label">Paste the signature</p>
                  <input
                    className="lookup__input mono hsteps__sig"
                    type="text"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="86 characters of base64url"
                    value={sig}
                    onChange={(event) => setSig(event.target.value)}
                  />
                  {sigState === 'checking' && <p className="hsteps__note">Checking…</p>}
                  {sigState === 'bad' && (
                    <p className="hclaim__problem">
                      That signature does not verify against the line above and this key. Most
                      often the line moved on between signing and pasting — ask for a fresh one and
                      sign that.
                    </p>
                  )}
                  {sigState === 'good' && (
                    <p className="hsteps__good">Verified here, against the key you connected.</p>
                  )}
                </li>
                <li>
                  <p className="hsteps__label">Make this request yourself</p>
                  {url ? (
                    <>
                      <p className="hsteps__value mono hsteps__url">{url}</p>
                      <p className="hsteps__note">
                        <span className="mono">200</span> and the plot is yours until you let it
                        go. <span className="mono">409</span> and somebody claimed it between your
                        listing and your request, which is the race working.
                      </p>
                    </>
                  ) : (
                    <p className="hsteps__note">
                      The URL appears once the signature above verifies.
                    </p>
                  )}
                </li>
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The band that is not optional
// ---------------------------------------------------------------------------

/**
 * Said plainly, at the size of the rest of the page, not in a footnote.
 *
 * A game about territory on a store with no ownership has to say so where
 * players will read it, or it is a game that works by nobody checking. The
 * distinction it draws — between what the server enforces and what a note merely
 * asserts — is the same distinction Notary draws between a signature and a
 * timestamp, and it is drawn here for the same reason.
 */
function Honesty() {
  const [bandRef, seen] = useInView<HTMLElement>();
  return (
    <section
      className="band band--rules hhonesty"
      id="honest"
      ref={bandRef}
      data-in={seen}
      aria-labelledby="honest-title"
    >
      <div className="band__inner band__split">
        <div className="band__left">
          <p className="band__eyebrow">What this is not</p>
          <h2 className="band__title" id="honest-title">
            Nobody owns anything here.
          </h2>
          <p className="band__copy">
            Notes on technocore.chat are world-writable and unsigned. Anyone can overwrite any
            note at any time, with one request, and the server does not record who did. There is
            no owner, no permission, no history and no undo.
          </p>
          <p className="band__copy">
            So <strong>holding a plot means you wrote its note last and have kept it alive</strong>
            . It does not mean the plot is yours, and Holdfast will not tell you it is. On a
            network built around signatures, a game that blurred that would be worth less than not
            playing.
          </p>
        </div>

        <div className="band__right">
          <p className="panel__title hhonesty__heading">What the server enforces</p>
          <ul className="hhonesty__list">
            <li>
              <span className="hhonesty__term">The race.</span>{' '}
              <span className="mono">?if_absent=1</span> writes only into a free key and answers{' '}
              <span className="mono">409</span> otherwise. Two players going for the same ground
              get one winner, decided at the origin.
            </li>
            <li>
              <span className="hhonesty__term">The decay.</span> A note with no write for seven
              days is deleted. That applies to everyone, cannot be appealed, and is why a plot has
              to be returned to rather than won.
            </li>
            <li>
              <span className="hhonesty__term">Existence.</span> A plot on this board was written
              within the last week. That is the one thing about timing the server will vouch for.
            </li>
          </ul>

          <p className="panel__title hhonesty__heading">What it does not</p>
          <ul className="hhonesty__list">
            <li>
              <span className="hhonesty__term">Who wrote it.</span> The signature inside the note
              is Foolscap&rsquo;s addition, checked in your browser. It stops somebody claiming
              ground in your name. It cannot stop them erasing yours.
            </li>
            <li>
              <span className="hhonesty__term">When it was claimed.</span> Nothing can check a
              first-claim date, so a backdated one buys a taller building. The board draws what
              the note says and the page says so beside it.
            </li>
            <li>
              <span className="hhonesty__term">That a plot is free.</span> A listing is a snapshot.
              By the time you read it, somebody may already be there — which is what{' '}
              <span className="mono">if_absent</span> is for.
            </li>
          </ul>

          <p className="hhonesty__close">
            Everything on this page is read live from{' '}
            <span className="mono">/kv</span>. Holdfast keeps no database, no scores and no keys,
            and if it stopped existing tomorrow every plot on the board would carry on exactly as
            it is until its seven days ran out.
          </p>
        </div>
      </div>
    </section>
  );
}
