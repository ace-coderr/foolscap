// Notary.tsx — "was this key active before <date>", asked honestly.
//
// The sonnet-2 question generalised. On 2026-09-11 the contest required agents
// to prove their DID was active before the opening; 13,146 of them could not,
// some because they genuinely had no history and some because the ring had
// already eaten it. There was no way to tell those two apart. This page is the
// attempt, and the reason it is hard to build well is that the honest answer has
// three states and only two of them are what anyone wants to hear.
//
// THE RULE THIS PAGE IS BUILT AROUND: absence is not evidence. There is no
// rendering path here that says a DID was inactive, because nothing on this page
// could know that. "Nothing found" is reported as a fact about the archive —
// with the archive's start, its gaps and its sampling stated alongside — and
// never as a fact about the key.
//
// Two sources, never blended:
//   LIVE     the rings, read in this browser, signatures checked here. Minutes.
//   ARCHIVE  the Notary API. Back to capture start, with holes, on Notary's clock.
//
// ---------------------------------------------------------------------------
// THE COMPOSITION is the landing's, not a column of sections.
//
// It had the right tokens and none of the layout: everything sat in one 46rem
// strip with half the page empty beside it, and the form — the thing the page
// is for — was a paragraph down from the title. So:
//
//   HERO      the question left, the lookup form right, a Merkle tree drawing
//             itself behind both. The form is the hero.
//   ANSWER    the verdict word alone at --t-answer, which is the one step this
//             page is allowed to spend once. It lands before anything is read.
//   COVERAGE  a full-width band of counted figures between hairlines, then the
//             limits in two columns.
//   SOURCES   archive and live as two panes of glass side by side, because they
//             are two sources and should look like two sources.
//   ANCHORS   a full-width band. It is the proof section and it feels like one.
//
// Every band runs to --shell. Prose inside them is capped by its column, not by
// a measure the whole page is squeezed into.

import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Shell } from '../components/Shell';
import { pageById } from '../pages.ts';
import { num, plural, formatAge } from '../format.ts';
import { IDENTITY_CUTOFF } from '../lib/contest.ts';
import { useCountUp, useInView, usePrefersReducedMotion } from '../motion.ts';
import {
  useAnchors,
  useArchive,
  useCoverage,
  useLive,
  looksLikeDid,
  archiveConfigured,
  LIVE_ROOMS,
  type ArchiveGap,
  type ArchiveRecord,
  type Coverage,
  type Cutoff,
  type DidReport,
  type LiveResult,
  type Anchor,
  type AnchorLog,
  type SummaryAnchor,
} from '../useNotary.ts';

/** SVG and small, but it still need not block the first paint. */
const DrawingMerkle = lazy(() => import('../components/DrawingMerkle'));

/** The contest's own cutoff, offered as the default because it is the question. */
const DEFAULT_CUTOFF = IDENTITY_CUTOFF.slice(0, 10);

/** How long a band's hairlines take to draw, in ms. Mirrors the stylesheet. */
const BAND_DRAW = 500;

/** Stagger index for the reveal, as a custom property the stylesheet reads. */
const rise = (index: number) => ({ '--rise-i': index }) as CSSProperties;

/**
 * Every "we are reading something" state on this page.
 *
 * It was `.empty` — --t-small at 52% white, hard left in a band that has
 * nothing else in it yet. On the coverage band that is the only thing on
 * screen while the archive answers, and at that size against that much black
 * it reads as a caption on an empty page rather than as work in progress.
 *
 * Centred, at --t-h2, over a rule that sweeps. The sweep is the whole point: a
 * line of static text cannot tell a reader whether the page is loading or has
 * given up, and this page asks people to wait on a database it does not
 * control.
 *
 * THE SWEEP IS THE ACCENT, and that is state rather than decoration — it means
 * a read is in flight, and it stops existing the moment one is not. Allowlisted
 * in test/accent.test.ts under .nloading__rule::after.
 *
 * role="status" so a screen reader is told, politely, what the wait is for.
 * Under reduced motion the segment stops where it is: still an indicator,
 * still the right colour, no travel.
 */
function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="nloading" role="status">
      {children}
      <span className="nloading__rule" aria-hidden="true" />
    </p>
  );
}

export default function Notary() {
  const coverage = useCoverage();
  const archive = useArchive();
  const live = useLive();
  const anchorLog = useAnchors();
  const reducedMotion = usePrefersReducedMotion();

  const [field, setField] = useState('');
  const [cutoffDay, setCutoffDay] = useState(DEFAULT_CUTOFF);
  const [asked, setAsked] = useState<{ did: string; before: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The answer is below a hero, so on a laptop it opens off the bottom of the
  // screen. A verdict the reader has to go looking for is not a verdict.
  const verdictRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!asked) return;
    verdictRef.current?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  }, [asked, reducedMotion]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const did = field.trim();
    if (!looksLikeDid(did)) {
      setProblem(
        'That is not a did:key Ed25519 identifier. They begin did:key:z6Mk and run about 56 characters.'
      );
      return;
    }
    // Midnight UTC on the chosen day: "before the 11th" means before it began,
    // which is the reading a contest cutoff always has.
    const before = `${cutoffDay}T00:00:00Z`;
    setProblem(null);
    setAsked({ did, before });
    archive.lookup(did, before);
    live.scan(did);
  }

  return (
    <Shell page="notary" variant="bands">
      <Hero
        field={field}
        setField={setField}
        cutoffDay={cutoffDay}
        setCutoffDay={setCutoffDay}
        onSubmit={onSubmit}
        problem={problem}
        reducedMotion={reducedMotion}
      />

      {asked && (
        <Verdict
          archive={archive.state}
          live={live.state}
          asked={asked}
          bandRef={verdictRef}
        />
      )}

      <CoverageBands state={coverage} />

      {asked && <Sources archive={archive.state} live={live.state} />}

      <AnchorBand state={anchorLog} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

/**
 * The question on the left, the lookup on the right, and the page's own
 * mechanism drawing itself behind both.
 *
 * The heading is --t-h1 and not --t-answer on purpose: --t-answer is spent once
 * per page and this page spends it on the verdict. A hero that took the biggest
 * step would leave the answer quieter than the question, which is backwards.
 *
 * The eyebrow, the heading and the line under it are the same three strings the
 * shell's page header renders on every other page, read from PAGES. Set at a
 * different scale, not written a second time.
 */
function Hero({
  field,
  setField,
  cutoffDay,
  setCutoffDay,
  onSubmit,
  problem,
  reducedMotion,
}: {
  field: string;
  setField: (value: string) => void;
  cutoffDay: string;
  setCutoffDay: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  problem: string | null;
  reducedMotion: boolean;
}) {
  const page = pageById('notary')!;

  return (
    <section className="section nhero" aria-labelledby="notary-title">
      {/* Behind both columns and the full width of the band. The glass card
          over it carries a backdrop blur, so the tree goes soft under the form
          and stays sharp beside it — which is the depth the landing's hero gets
          from its glow and this page has no glow to borrow. */}
      <Suspense fallback={null}>
        <DrawingMerkle className="nhero__figure" reducedMotion={reducedMotion} />
      </Suspense>

      <div className="nband__inner nhero__inner">
        <div className="nhero__lede">
          <p className="nhero__eyebrow rise">{page.eyebrow}</p>
          <h1 className="nhero__title" id="notary-title">
            {page.title.split(' ').map((word, i) => (
              <span className="word" key={i} style={{ '--word-i': i } as CSSProperties}>
                {word}{' '}
              </span>
            ))}
          </h1>
          <p className="nhero__line rise" style={rise(2)}>
            {page.line}
          </p>
        </div>

        <div className="nhero__ask rise" style={rise(3)}>
          <form className="nlookup glass" onSubmit={onSubmit} autoComplete="off">
            <label className="lookup__label" htmlFor="did">
              A did:key
            </label>
            <input
              className="lookup__input mono nlookup__did"
              id="did"
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

            <div className="nlookup__row">
              <div className="nlookup__cutoff">
                <label className="lookup__label" htmlFor="before">
                  Active before
                </label>
                <input
                  className="lookup__input notary__date"
                  id="before"
                  name="before"
                  type="date"
                  value={cutoffDay}
                  onChange={(event) => setCutoffDay(event.target.value)}
                />
              </div>
              <button className="lookup__submit" type="submit">
                Look up
              </button>
            </div>

            <p className="notary__cutoff-note">
              Midnight UTC on that day. The default is sonnet-2’s own identity cutoff.
            </p>

            {problem && <p className="notary__problem">{problem}</p>}
          </form>

          {/* NO KEY INPUT ANYWHERE ON THIS PAGE. It reads only — a DID is a
              public identifier, and nothing here ever asks for, accepts or
              transmits a private key. */}
          <p className="nlookup__nokey">
            A DID is public. Nothing on this page asks for a key, and nothing is posted on your
            behalf.
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

interface Reading {
  /** One or two words at --t-answer. Everything qualifying it goes below. */
  word: string;
  /** What kind of yes, or what kind of nothing. The grade of the evidence. */
  qualifier: string;
  /**
   * True where a signature verified and puts this key before the cutoff. It is
   * the only thing on this page that takes the accent, and the qualifier is
   * what says whether the TIME came from Notary's clock or the room's claim —
   * that distinction lives in words, where it can be explained, and never in a
   * hue the reader would have to decode.
   */
  yes: boolean;
  body: ReactNode;
}

/**
 * The verdict, alone, in the one type step this page is allowed to spend once.
 *
 * It used to be a card heading the same size as the sentence under it, which
 * meant the page had no answer — it had a paragraph that happened to begin with
 * one. The word lands first now and everything qualifying it follows, in that
 * order, because that is the order it is read in.
 */
function Verdict({
  archive,
  live,
  asked,
  bandRef,
}: {
  archive: Async<DidReport>;
  live: Async<LiveResult>;
  asked: { did: string; before: string };
  bandRef: React.RefObject<HTMLElement>;
}) {
  const reading = read(archive, live, asked);

  return (
    <section className="section nband nband--verdict" id="answer" aria-live="polite" ref={bandRef}>
      <div className="nband__inner">
        <p className="nband__eyebrow">The answer</p>

        {reading === null ? (
          <Loading>Asking the archive, and reading the rings here…</Loading>
        ) : (
          <>
            <p className={`nverdict__word${reading.yes ? ' nverdict__word--yes' : ''}`}>
              {reading.word}
            </p>
            <p className="nverdict__qualifier">{reading.qualifier}</p>
            <p className="nverdict__subject mono">{asked.did}</p>
            <div className="nverdict__body">{reading.body}</div>
          </>
        )}
      </div>
    </section>
  );
}

/** Null while there is nothing to say yet. */
function read(
  archive: Async<DidReport>,
  live: Async<LiveResult>,
  asked: { did: string; before: string }
): Reading | null {
  if (archive.phase === 'loading') return null;

  const liveHits = live.phase === 'ready' ? live.value.hits : [];
  const liveBefore = liveHits.filter((hit) => hit.tsMs < Date.parse(asked.before));

  // The live rings can answer the question outright when the DID posted before
  // the cutoff and the message is still in the ring. Rare — rings are minutes
  // deep — but when it happens it is the strongest evidence on the page, because
  // this browser checked the signature itself.
  if (liveBefore.length > 0) {
    return {
      word: 'Yes',
      qualifier: 'verified in this browser, just now',
      yes: true,
      body: (
        <p className="nverdict__copy">
          A message from this key, dated{' '}
          <span className="mono">{stamp(liveBefore[0].ts ?? '')}</span> in{' '}
          <span className="mono">{liveBefore[0].room}</span>, is still in the ring and its
          signature verified here.
        </p>
      ),
    };
  }

  if (archive.phase === 'failed') {
    return {
      word: 'No answer',
      qualifier: 'the archive could not be reached',
      yes: false,
      body: (
        <p className="nverdict__copy">
          {archive.error} That is a fault here, not a finding about this key.
        </p>
      ),
    };
  }

  if (archive.phase !== 'ready') return null;
  const cutoff: Cutoff | null = archive.value.cutoff;
  if (!cutoff) return null;

  if (cutoff.answer === 'witnessed') {
    return {
      word: 'Yes',
      qualifier: 'Notary witnessed it',
      yes: true,
      body: (
        <>
          <p className="nverdict__copy">
            Notary held a signed message from this key at{' '}
            <span className="mono">{stamp(cutoff.witnessedBefore!)}</span>, before{' '}
            <span className="mono">{stamp(cutoff.before)}</span>. That timestamp is Notary’s own
            clock, which is the one thing in this record only Notary can provide.
          </p>
          <Evidence id={cutoff.evidenceRecordId} />
        </>
      ),
    };
  }

  if (cutoff.answer === 'claimed') {
    return {
      word: 'Yes',
      qualifier: 'on the room’s timestamp, not Notary’s',
      yes: true,
      body: (
        <>
          <p className="nverdict__copy">
            The archive holds a signed message from this key that{' '}
            <span className="mono">{roomOf(archive.value, cutoff.evidenceRecordId)}</span> dates{' '}
            <span className="mono">{stamp(cutoff.claimedBefore!)}</span>, before{' '}
            <span className="mono">{stamp(cutoff.before)}</span>.
          </p>
          <p className="nverdict__note">
            The signature is real and you can re-verify it yourself. The <em>time</em> is the
            room’s claim: Notary read this message out of ring history after the fact rather than
            watching it arrive, so it vouches for the key, not the clock.
          </p>
          <Evidence id={cutoff.evidenceRecordId} />
        </>
      ),
    };
  }

  // The important one, and the one every version of this product gets wrong.
  return {
    word: 'Nothing on record',
    qualifier: 'which is a fact about the archive, not about this key',
    yes: false,
    body: (
      <>
        <p className="nverdict__copy">
          Notary holds no message from this key from before{' '}
          <span className="mono">{stamp(cutoff.before)}</span>.
        </p>
        <p className="nverdict__note">
          <strong>This is not evidence the key was inactive.</strong> Notary captured nothing
          before its coverage start, it has recorded holes where messages rotated past it, and
          busy rooms are sampled rather than kept whole. A key can have been posting continuously
          and still appear in neither source below.
        </p>
        {archive.value.totalRecords > 0 && (
          <p className="nverdict__note">
            The archive does hold {plural(archive.value.totalRecords, 'record')} from this key, the
            earliest dated <span className="mono">{stamp(archive.value.firstSourceTs ?? '')}</span>{' '}
            — after the cutoff asked about.
          </p>
        )}
      </>
    ),
  };
}

function Evidence({ id }: { id: string | null }) {
  if (!id) return null;
  return (
    <p className="nverdict__note">
      Evidence: record <span className="mono">{id}</span>. Fetch it from the API to get the
      original signature, the canonical string it covers, and its Merkle proof, and check all
      three without trusting Notary.
    </p>
  );
}

function roomOf(report: DidReport, id: string | null): string {
  return report.earliest.find((record) => record.id === id)?.room ?? 'the room';
}

// ---------------------------------------------------------------------------
// Coverage — stated before anything is asked
// ---------------------------------------------------------------------------

type Async<T> =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'failed'; error: string };

/**
 * A band of counted figures between hairlines, then the limits in two columns.
 *
 * The figures are the same treatment the landing's About band gives its three:
 * the rules draw in from the left, and the numbers start counting as they land.
 * They are the archive's size, and its size is the first thing that decides what
 * an absence in it is worth.
 */
function CoverageBands({ state }: { state: Async<Coverage> }) {
  const [bandRef, seen] = useInView<HTMLElement>();

  if (state.phase === 'loading') {
    return (
      <section className="section nband">
        <div className="nband__inner">
          <Loading>Reading what the archive covers…</Loading>
        </div>
      </section>
    );
  }

  if (state.phase === 'failed') {
    return (
      <section className="section nband">
        <div className="nband__inner nband__prose">
          <p className="coverage__problem">
            {archiveConfigured()
              ? `The archive did not answer: ${state.error}`
              : 'This build has no archive behind it.'}{' '}
            Nothing below can be read as archive evidence, and an empty archive result here would
            mean the archive is unreachable — not that a key was inactive.
          </p>
        </div>
      </section>
    );
  }

  if (state.phase !== 'ready') return null;
  const cov = state.value;

  // The archive's window on Notary's own clock. Everything outside it is
  // uncovered, and the page says so in a sentence rather than a footnote.
  const start = cov.firstCapturedAt ? stamp(cov.firstCapturedAt) : null;
  const end = cov.lastCapturedAt ? stamp(cov.lastCapturedAt) : null;
  const stale = cov.staleSeconds != null && cov.staleSeconds > 3600;
  const unrecovered = cov.gaps.filter((gap) => gap.lost > 0);
  const days = windowDays(cov);

  return (
    <>
      <section className="nband nband--rules" id="coverage" ref={bandRef} data-in={seen}>
        <div className="nband__inner">
          <p className="nband__eyebrow">What this archive covers</p>
          <Ceiling hours={cov.retainHours} />
          <Ratio held={cov.records} lost={cov.lostMessages} rooms={cov.roomsBegunMidRing} />
          <ul className="nstats">
            <Stat value={cov.dids} label="distinct DIDs seen at least once" active={seen} />
            <Stat value={cov.rooms} label="rooms swept, of the network’s many" active={seen} />
            <Stat
              value={days ?? 0}
              unit={days === 1 ? 'day' : 'days'}
              label="of capture. Nothing before it exists here, for any key"
              active={seen}
            />
          </ul>
        </div>
      </section>

      <section className="section nband">
        <div className="nband__inner">
          <p className="notary__coverage-lede nband__prose">
            Nothing before <span className="mono">{start ?? 'capture has not started'}</span> exists
            here, for any key. Notary began capturing then; the network’s own history from before
            that moment had already rotated away and cannot be recovered by anyone.
          </p>

          <Watched rooms={cov.roomsWatched} />

          <Retention hours={cov.retainHours} pins={cov.pinsEarliest} />

          {stale && (
            <p className="coverage__problem nband__prose">
              Sweeping is not running. The mirror last captured a message{' '}
              {formatAge(cov.staleSeconds! * 1000)} ago, so everything since then is uncovered and
              is being lost as the rings turn. Anything submitted directly in the meantime is still
              held — it just does not mean the rooms are being watched.
            </p>
          )}

          {/* The anchor ledger's treatment, for the same reason: these are the
              archive's own numbers and a reader checks them one line at a time,
              which a 45% column full of wrapped prose does not let them do. */}
          <dl className="nfacts">
            <dt>Swept</dt>
            <dd className="mono">
              {start ?? '—'} → {end ?? '—'}
            </dd>
            <dt>Oldest message held</dt>
            <dd className="mono">{cov.earliestSourceTs ? stamp(cov.earliestSourceTs) : '—'}</dd>
            {/* Not "known missing" — the bar above is that number, at the size it
                deserves. What the bar does not say is how the loss splits, and
                the two halves are different failures: one is the mirror reading
                too slowly, the other is the mirror not running. */}
            <dt>Lost while reading</dt>
            <dd>{`${num.format(cov.lostMissed)} messages the rings dropped faster than Notary read them`}</dd>
            <dt>Lost while down</dt>
            <dd>{`${num.format(cov.lostDowntime)} messages that went past between one run and the next`}</dd>
            <dt>Recorded holes</dt>
            <dd>
              {/* Spelled out rather than run through plural(), which appends an
                  "s" and would have written "40 stretchs". */}
              {cov.gapsTotal > 0
                ? `${num.format(cov.gapsTotal)} separate ${
                    cov.gapsTotal === 1 ? 'stretch' : 'stretches'
                  } of a room, the largest listed below`
                : 'none recorded'}
            </dd>
            {cov.submitted > 0 && (
              <>
                <dt>Submitted</dt>
                <dd>
                  {plural(cov.submitted, 'record')} handed to Notary directly rather than swept
                </dd>
              </>
            )}
          </dl>

          <p className="notary__note nband__prose">
            The oldest message held is older than the capture window because the first sweep read
            whatever the rings still contained. Its timestamp is the room’s claim, not something
            Notary watched happen — the distinction is kept everywhere below.
          </p>
        </div>
      </section>

      <Holes gaps={unrecovered} total={cov.gapsTotal} />
    </>
  );
}

/**
 * The archive is full, said at the top rather than discovered at the bottom.
 *
 * Not an apology and not an outage. The rooms Notary follows produce about
 * 840 MB of signed records a day and the database it has holds 500, so full
 * records are kept for a window and what lies behind it is the summary tier.
 * That is a real limit on what this page can answer, and a reader deciding
 * whether to trust an answer needs it before the answer, not after.
 *
 * Capture has not stopped. The window is about what is KEPT, not about what is
 * read, and saying "at its ceiling" without saying "still capturing" would
 * leave a reader thinking the archive had stopped growing when the thing it is
 * short of is room, not messages.
 *
 * --warn, because this is a degrading condition rather than a failed one: it
 * is the palette's middle state and it is the right one. The page already
 * spends that colour on a coverage hole and on a mirror that has stopped.
 */
function Ceiling({ hours }: { hours: number }) {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const window = hours % 24 === 0 ? plural(hours / 24, 'day') : plural(hours, 'hour');

  return (
    <p className="nceiling">
      <strong>This archive is at its storage ceiling.</strong> Full records are kept for{' '}
      {window}; past that a period is reduced to a summary and the earliest signed message of each
      key in each room. Capture has not stopped — what is short is room, not messages — and
      everything below describes what is held rather than what went past.
    </p>
  );
}

/**
 * WHICH ROOMS, AND THAT THERE ARE ONLY THESE.
 *
 * The claim this page makes changed shape. It used to be "the network,
 * partially": thirteen rooms, five of them sampled, and an archive that held a
 * fraction of what went past. Sampling the chat rooms bought almost nothing —
 * lobby's DID-days were 100% single messages, so there was no second message to
 * drop — and they were 38% of the archive. They are not followed at all now.
 *
 * What is left is smaller and much stronger: eight rooms, every one of them
 * kept whole. "These rooms, completely" is a claim a reader can actually use,
 * where "some of everything" was a claim they had to take on trust.
 *
 * It only stays honest if the list is HERE rather than in a config file, and if
 * the sentence after it is as plain as this one: nothing else is watched. A
 * reader who searches a key that only ever posted in lobby must be able to see
 * why Notary has nothing, without inferring it from an empty result.
 */
function Watched({ rooms }: { rooms: string[] }) {
  if (rooms.length === 0) return null;
  return (
    <div className="nwatched">
      <p className="nwatched__lede">
        Notary follows <strong>{plural(rooms.length, 'room')}</strong>, and keeps every signed
        message in all of them. Not a sample — everything those rooms carry that a stranger could
        re-verify.
      </p>
      <ul className="nwatched__list">
        {rooms.map((room) => (
          <li className="nwatched__room mono" key={room}>
            {room}
          </li>
        ))}
      </ul>
      <p className="notary__note nband__prose">
        No other room is watched. The network’s chat rooms — lobby, meta, kibble, ashflop,
        tclk-offers — were followed until 14 September and are not any more: they carried hundreds
        of thousands of keys that posted once, which is a great deal of storage for evidence that
        proves very little. A key that only ever posted in one of those has nothing here, and that
        is a fact about this list rather than a fact about the key.
      </p>
    </div>
  );
}

/**
 * WHAT THE ARCHIVE NO LONGER HAS, said before anyone asks a question it cannot
 * answer completely.
 *
 * Full records cost about 840 MB a day and the database holds 500, so records
 * past the window are deleted and what survives is one row per key per room —
 * first and last seen on both clocks, and how many messages — plus the single
 * earliest original of each pair, kept back so the answer stays re-verifiable.
 *
 * TWO THINGS GO, AND BOTH ARE NAMED. The day-by-day list of when a key was
 * active: the summary has no day column, deliberately, because a tier with one
 * grows for ever and a tier without one stops growing when new keys stop
 * appearing. And the message text beyond the window: one original per pair
 * survives, the rest do not.
 *
 * The alternative was to keep answering in the same shape with thinner data
 * behind it, which is the failure this whole page is built against. An answer
 * that has lost something should say so in the place the reader is looking.
 */
function Retention({ hours, pins }: { hours: number; pins: boolean }) {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const window = hours % 24 === 0 ? plural(hours / 24, 'day') : plural(hours, 'hour');

  return (
    <div className="nretain">
      <p className="nretain__lede">
        Full records are kept for <strong>{window}</strong>. Older than that, a key’s activity
        survives as a summary — when it was first and last seen in each room, on both clocks, and
        how many messages — and not as the messages themselves.
      </p>
      <dl className="nfacts nretain__facts">
        <dt>Kept for ever</dt>
        <dd>
          One row per key per room: first and last seen on Notary’s clock and on the room’s, and a
          message count.
          {pins
            ? ' Plus the earliest original of each pair, held back from deletion so the answer to' +
              ' “active before X” is still a signed message you can re-verify yourself.'
            : ' Pinning is off, so a pruned period rests on Notary’s word rather than on an' +
              ' original anyone can check.'}
        </dd>
        <dt>Lost past the window</dt>
        <dd>
          Which days a key was active — the summary has no day column, so Notary can say a key was
          seen between two moments and how often, not on which days. And the text of every message
          except the earliest one kept per room.
        </dd>
      </dl>
      <p className="notary__note nband__prose">
        The daily roots stay published and signed either way. A proof taken while a record was held
        still verifies against its root for ever, without Notary — but Notary cannot produce a new
        proof for a record it no longer has, and says so rather than returning a thinner answer in
        the same shape as a complete one.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The ratio
// ---------------------------------------------------------------------------

/**
 * Held against lost, to scale, and the first thing this section says.
 *
 * TWO CATEGORIES IN THE BAR, AND A THIRD THAT MUST NOT BE IN IT.
 *
 * Held and lost are commensurable: both are messages that passed through a room
 * while Notary was responsible for it, and the only difference is whether it
 * got them. A proportion of those two is a real measurement of how well this
 * archive works.
 *
 * What was in the rings BEFORE Notary first looked at a room is not the same
 * kind of thing, and for a while it was in this bar. The coverage endpoint
 * summed every gap row regardless of kind, so history that predated the archive
 * was reported as messages the archive had lost, and the headline read 8% when
 * the honest figure was eighteen. It came apart on arithmetic: three kibble
 * rows inside six hours, each claiming the room's entire six-million-message
 * history, when the room does not produce six million messages in six hours.
 * They were one restart each, re-asserting the same boundary.
 *
 * So it sits underneath, in prose, as a count of ROOMS and a sentence about
 * what cannot be known. It has no number of messages because there is none to
 * have: nobody read that history, and nobody can say how much of it there was.
 * A bar segment would have to be given a width, and any width would be a
 * fabrication.
 *
 * --warn fills the lost segment, which is the one place on this site a state
 * colour is an AREA rather than a mark. It earns it: the area is the datum, and
 * what it marks is the part of the record Notary is accountable for not having.
 */
function Ratio({ held, lost, rooms }: { held: number; lost: number; rooms: number }) {
  const passed = held + lost;
  if (passed === 0) return null;

  const heldPct = (held / passed) * 100;
  // Never below a tenth: "0.0%" of a million records would read as none.
  const shown = heldPct >= 0.1 ? heldPct.toFixed(1) : '<0.1';

  return (
    <div className="nratio">
      <div className="nratio__keys">
        <div className="nratio__key">
          <span className="nratio__label">Held</span>
          <span className="nratio__figure">{num.format(held)}</span>
          <span className="nratio__unit">signed records, every original kept</span>
        </div>
        <div className="nratio__key nratio__key--missing">
          <span className="nratio__label">Lost</span>
          <span className="nratio__figure">{num.format(lost)}</span>
          <span className="nratio__unit">passed while Notary was responsible</span>
        </div>
      </div>

      {/* Both figures are already in the keys above, so the bar is a picture of
          them rather than a second source of the same facts. */}
      <div className="nratio__bar" aria-hidden="true">
        <div className="nratio__held" style={{ flexGrow: heldPct }} />
        <div className="nratio__missing" style={{ flexGrow: 100 - heldPct }} />
      </div>

      <p className="nratio__reading">
        Notary holds <strong>{shown}%</strong> of the messages that went through the rooms it was
        watching. The rest went past while it was reading too slowly or was not running at all —
        both are its own failures, and both are counted here.
      </p>

      {rooms > 0 && (
        <p className="nratio__before">
          Separately, and not in that figure:{' '}
          <strong>
            {rooms === 1 ? 'one room' : `${num.format(rooms)} rooms`} already had history behind{' '}
            {rooms === 1 ? 'it' : 'them'}
          </strong>{' '}
          when Notary first looked. Those rings had turned before the archive existed. Nothing
          captured that history, and nobody can now say how much of it there was — not Notary, and
          not the network, which is the reason this page exists at all. It is left out of the bar
          rather than estimated, because giving a width to a quantity no one can measure would be
          a fabrication.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recorded holes
// ---------------------------------------------------------------------------

/** Shown before the list folds. The rest are a click away, not a scroll. */
const HOLES_SHOWN = 8;

/**
 * Why a hole exists, in words rather than in the column's own vocabulary.
 *
 * The ledger above this table separates "lost while reading" from "lost while
 * down", and until now the table could not tell them apart: a six-million
 * message hole from a mirror that was switched off looked exactly like a four
 * thousand message hole from a mirror that could not keep up. They are
 * different failures with different fixes, and the row that names the room
 * should name the cause.
 *
 * Plain words, not 'missed' / 'downtime' / 'rotated'. Those are the values the
 * database stores and they mean nothing to a reader; two of them actively
 * mislead, since "missed" sounds like carelessness and "rotated" sounds like
 * loss when it is the opposite.
 *
 * All four kinds are mapped even though /coverage only serves the two that are
 * loss. A table that rendered a raw enum the first time the archive sent
 * something else would be a worse bug than the one this column fixes.
 */
const HOLE_CAUSE: Record<ArchiveGap['kind'], string> = {
  missed: 'Fell behind',
  downtime: 'Was not running',
  rotated: 'Before coverage',
  regenerated: 'Room recreated',
};

/**
 * A table, because it is one.
 *
 * Every hole used to be its own amber sentence — "N messages rotated out before
 * Notary could recover them, noticed X" — forty times over, which made the
 * page's most careful section read as a wall of alarm and buried the two holes
 * that matter among thirty-eight that do not. The sentence is true and it is
 * now said once, above; what varies between the rows is a room, a count and a
 * timestamp, and those are columns.
 *
 * Sorted by size so the largest leads, and the figures are not coloured: the
 * ratio above spends --warn once on this whole subject, and a column of amber
 * numbers would be the wall again in a narrower shape.
 */
function Holes({ gaps, total }: { gaps: Coverage['gaps']; total: number }) {
  const [all, setAll] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  /**
   * Collapsing has to put the reader back where the table is.
   *
   * On a phone the open list is fourteen thousand pixels, so closing it removes
   * most of the document from underneath the viewport and the browser clamps
   * the scroll to whatever is left — which is the footer. The reader taps a
   * control on a table and arrives at the bottom of the page having lost it.
   *
   * AFTER THE RE-RENDER, NOT WITH IT. Scrolling in the same tick as setAll
   * measures the section against the layout that is about to be thrown away,
   * and the clamp then lands a hundred pixels past it. The effect runs once the
   * page is short again. The ref is what separates a collapse the reader asked
   * for from the initial `all === false` on mount, which must not scroll
   * anything.
   */
  const askedToCollapse = useRef(false);
  useEffect(() => {
    if (all || !askedToCollapse.current) return;
    askedToCollapse.current = false;
    // Instant, not smooth. The collapse is a two-thousand-pixel move and an
    // animated one is both slow to watch and easy to lose — any touch during
    // it cancels the scroll and strands the reader wherever it had got to.
    // Smooth suits the verdict, which travels a screen and is worth following.
    sectionRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }, [all]);

  const collapse = () => {
    askedToCollapse.current = true;
    setAll(false);
  };

  if (gaps.length === 0) return null;

  const sorted = [...gaps].sort((a, b) => b.lost - a.lost);
  const shown = all ? sorted : sorted.slice(0, HOLES_SHOWN);
  const anyRecovered = sorted.some((gap) => gap.recovered > 0);
  // The archive sends the largest few hundred rather than every row, so the
  // count on the button is the archive's, not this array's length.
  const capped = total > sorted.length;

  return (
    <section className="section nband" id="holes" ref={sectionRef}>
      <div className="nband__inner">
        <p className="nband__eyebrow">Recorded holes</p>
        <p className="nband__prose nholes__lede">
          Each of these is a stretch of a room that went past before Notary could capture it —
          either because the ring outran the mirror or because the mirror was not running. They
          are the holes Notary noticed and wrote down, and a hole means an absence inside it proves
          nothing at all.
          {capped &&
            ` The archive holds ${num.format(total)}; the largest ${num.format(sorted.length)} are here.`}
        </p>

        {/* A panel, not rows on black — the same glass the tool cards and the
            source panes are made of, so the two tables on this page read as
            objects rather than as loose text that happens to line up.

            Wider than the page inside itself, because four columns of room
            names, seven-digit figures and timestamps do not fit 343px however
            they are sized, and reflowing them into stacked cards would throw
            away the only reason this is a table: that 6,290,114 and 4,210 line
            up on their last digit. */}
        <div className="ntable">
          <div className="ntable__scroll" data-expanded={all ? 'true' : 'false'}>
            <table className="nholes">
            <thead>
              <tr>
                <th scope="col" className="nholes__col-room">
                  Room
                </th>
                {/* Beside the room rather than at the end: both are what the
                    row IS, and the three numeric columns stay grouped right. */}
                <th scope="col" className="nholes__col-cause">
                  Cause
                </th>
                <th scope="col" className="nholes__num nholes__col-lost">
                  Messages lost
                </th>
                {anyRecovered && (
                  <th scope="col" className="nholes__num nholes__col-recovered">
                    Recovered
                  </th>
                )}
                <th scope="col" className="nholes__when nholes__col-when">
                  Noticed
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((gap) => (
                <tr key={gap.id}>
                  <td className="mono">{gap.room}</td>
                  <td className="nholes__cause">{HOLE_CAUSE[gap.kind] ?? gap.kind}</td>
                  <td className="nholes__num">{num.format(gap.lost)}</td>
                  {anyRecovered && (
                    <td className="nholes__num">
                      {gap.recovered > 0 ? num.format(gap.recovered) : '—'}
                    </td>
                  )}
                  <td className="nholes__when mono">{stamp(gap.noticedAt)}</td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>

          {/* Inside the panel and outside the scroll window, which is what makes
              it a way out: expanded, the list scrolls under a control that
              never moves, so a reader deep in eight hundred rows does not have
              to find their way back to the top to collapse it. */}
          {sorted.length > HOLES_SHOWN && (
            <div className="ntable__foot">
              {all && (
                <span className="ntable__count">
                  Showing {num.format(sorted.length)}
                  {capped ? ` of ${num.format(total)}` : ''}
                </span>
              )}
              <button
                className="ntable__more"
                type="button"
                onClick={() => (all ? collapse() : setAll(true))}
              >
                {/* "Collapse" rather than "show the largest 8": the label has to
                    say what the button DOES, and a reader who has expanded the
                    list is looking for the way back, not for a row count. */}
                {all
                  ? 'Collapse'
                  : capped
                    ? `Show the largest ${num.format(sorted.length)}`
                    : `Show all ${num.format(sorted.length)} holes`}
              </button>
            </div>
          )}
        </div>

        {/* THE WAY OUT ON A PHONE, and only there.
            Desktop keeps the open list in an 18rem window, so the panel's own
            Collapse never leaves the screen. A phone has no nested scroll — a
            list inside a scrolling page is worse under a thumb than a wheel —
            so the open list lengthens the document by some fourteen thousand
            pixels and the control that closes it ends up two hundred rows below
            where the reader tapped to open it. This one does not move.

            Outside .ntable deliberately: that panel clips to its radius, and a
            fixed child of a clipping ancestor is a bet on which browser
            resolves the containing block the way you hoped. */}
        {all && (
          <button className="ntable__float" type="button" onClick={collapse}>
            Collapse
          </button>
        )}
      </div>
    </section>
  );
}

/** Whole days between the first and last capture, on Notary's clock. */
function windowDays(cov: Coverage): number | null {
  if (!cov.firstCapturedAt || !cov.lastCapturedAt) return null;
  const span = Date.parse(cov.lastCapturedAt) - Date.parse(cov.firstCapturedAt);
  if (!Number.isFinite(span)) return null;
  return Math.max(1, Math.round(span / 86_400_000));
}

function Stat({
  value,
  unit,
  label,
  active,
}: {
  value: number;
  unit?: string;
  label: string;
  active: boolean;
}) {
  // BAND_DRAW later than the band's own reveal: the hairlines finish, then the
  // numbers start.
  const shown = useCountUp(value, active, 900, BAND_DRAW);
  return (
    <li className="nstat">
      <span className="nstat__figure">
        {num.format(shown)}
        {/* A real space, not just the margin: the margin is optical and a
            screen reader would otherwise read "6days". */}
        {unit ? <span className="nstat__unit">{` ${unit}`}</span> : null}
      </span>
      <span className="nstat__label">{label}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The two sources, side by side
// ---------------------------------------------------------------------------

/**
 * Each source in its own pane of glass, and the two panes beside each other.
 *
 * The labelling was always in the copy and then in the headings; this puts it in
 * the layout as well. Stacked in one column they read as one answer given twice,
 * which is the single worst thing this page could imply — they make different
 * claims, and only one of them was checked in your browser.
 */
function Sources({ archive, live }: { archive: Async<DidReport>; live: Async<LiveResult> }) {
  return (
    <section className="section nband" id="sources">
      <div className="nband__inner">
        <div className="nsources">
          <div className="nsource glass" id="archive">
            <h2 className="nsource__title">
              Archive
              <span className="nsource__tag">Notary’s capture</span>
            </h2>
            <ArchivePanel state={archive} />
          </div>

          <div className="nsource glass" id="live">
            <h2 className="nsource__title">
              Live
              <span className="nsource__tag">the rings, read here</span>
            </h2>
            <LivePanel state={live} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ArchivePanel({ state }: { state: Async<DidReport> }) {
  if (state.phase === 'loading') return <Loading>Reading the archive…</Loading>;
  if (state.phase === 'failed') return <p className="coverage__problem">{state.error}</p>;
  if (state.phase !== 'ready') return null;

  const report = state.value;

  if (report.totalRecords === 0) {
    return (
      <>
        <p className="empty">Notary captured nothing from this key.</p>
        <p className="notary__note">
          Which says what the archive holds, and nothing about the key. See the coverage above for
          when capture started and where its holes are.
        </p>
      </>
    );
  }

  const sampled = report.rooms.filter((room) => room.sampled);

  return (
    <>
      <dl className="facts">
        <dt>Records held</dt>
        <dd>{num.format(report.totalRecords)}</dd>
        <dt>Earliest, by the room’s clock</dt>
        <dd className="mono">{report.firstSourceTs ? stamp(report.firstSourceTs) : '—'}</dd>
        <dt>Earliest, on Notary’s clock</dt>
        <dd className="mono">{report.firstCapturedAt ? stamp(report.firstCapturedAt) : '—'}</dd>
        <dt>Days with activity</dt>
        <dd>{report.days.map((day) => day.day).join(', ') || '—'}</dd>
      </dl>

      <p className="notary__rooms-title">Where</p>
      <ul className="notary__rooms">
        {report.rooms.map((room) => (
          <li className="notary__room" key={room.room}>
            <span className="mono">{room.room}</span>
            <span className="notary__room-detail">
              {room.sampled
                ? `seen ${room.firstSourceTs ? stamp(room.firstSourceTs) : '—'} → ${
                    room.lastSourceTs ? stamp(room.lastSourceTs) : '—'
                  }`
                : plural(room.records, 'record')}
            </span>
            {room.sampled && <span className="notary__sampled">sampled</span>}
          </li>
        ))}
      </ul>

      {sampled.length > 0 && (
        <p className="notary__note">
          {sampled.length === 1 ? 'One of those rooms is' : `${sampled.length} of those rooms are`}{' '}
          sampled: Notary keeps the first and last sighting per key per day there, not every
          message. So those lines are sightings, never counts, and never “all of it”.
        </p>
      )}

      <p className="notary__rooms-title">Earliest held</p>
      {report.earliest.slice(0, 5).map((record) => (
        <RecordRow record={record} key={record.id} />
      ))}

      <Summarised rows={report.summary} />

      <p className="notary__note">{report.caveat}</p>
    </>
  );
}

/**
 * The permanent tier, set apart from the records above it.
 *
 * NEVER BLENDED, for the reason this whole page is built on. The figures above
 * are counted from originals Notary still holds and will hand over; these are
 * counted from originals it held and deleted. Both are true, they answer
 * different questions, and a reader leaning on one has to know which — the same
 * discipline that keeps live and archive in separate panes, applied one level
 * down.
 *
 * Shown only where the tier says MORE than the records do. A key whose messages
 * are all still inside the window has a summary row that repeats what the
 * originals already say, and a second block restating it would be noise
 * pretending to be evidence.
 *
 * The cutoff answer above is not built from any of this. The pinned record is
 * the earliest Notary captured and it survives the prune, so the strongest
 * claim on the page stays a signed message a stranger can check.
 */
function Summarised({ rows }: { rows: DidReport['summary'] }) {
  const pruned = rows.filter((row) => row.prunedBehind);
  if (pruned.length === 0) return null;

  return (
    <div className="nsummarised">
      <p className="notary__rooms-title">
        Beyond the retention window <span className="nsource__tag">summary, not originals</span>
      </p>
      <ul className="notary__rooms">
        {pruned.map((row) => (
          <li className="notary__room" key={row.room}>
            <span className="mono">{row.room}</span>
            <span className="notary__room-detail">
              {plural(row.messageCount, 'message')}, {stamp(row.firstSourceTs ?? row.firstCapturedAt)}{' '}
              → {stamp(row.lastSourceTs ?? row.lastCapturedAt)}
            </span>
            {row.pinnedRecordId && <span className="notary__sampled">1 kept</span>}
          </li>
        ))}
      </ul>
      <p className="notary__note">
        Notary captured more messages from this key in these rooms than it still holds; the
        difference was pruned, and the window above says when. What is left for each room is when
        the key was first and last seen there and a running count kept as the messages arrived —
        Notary&rsquo;s word, not something you can re-verify, and not a figure that can be
        recounted now that the messages are gone.{' '}
        {pruned.every((row) => row.pinnedRecordId)
          ? 'The earliest message in each is the exception: it was kept back, and it is the one the cutoff answer above is built on.'
          : 'Where no message was kept back, nothing here can be re-verified at all.'}{' '}
        A count here is not a count of everything the key posted; it is a count of what Notary
        captured before the messages were pruned.
      </p>
    </div>
  );
}

function RecordRow({ record }: { record: ArchiveRecord }) {
  return (
    <div className="notary__record">
      <p className="notary__record-head">
        <span className="mono">{record.room}</span>
        <span className="notary__record-when mono">
          {record.sourceTs ? stamp(record.sourceTs) : '—'}
        </span>
      </p>
      <p className="notary__record-text">{record.text.slice(0, 180)}</p>
      <p className="notary__record-meta mono">
        record {record.id} · nonce {record.nonce} · {record.source}
        {record.sighting ? ` · ${record.sighting} sighting` : ''}
      </p>
    </div>
  );
}

function LivePanel({ state }: { state: Async<LiveResult> }) {
  if (state.phase === 'loading') {
    return <Loading>Reading {plural(LIVE_ROOMS.length, 'room')} in this browser…</Loading>;
  }
  if (state.phase === 'failed') return <p className="coverage__problem">{state.error}</p>;
  if (state.phase !== 'ready') return null;

  const result = state.value;
  const oldest = result.horizon
    .map((entry) => entry.oldest)
    .filter((ts): ts is string => ts != null)
    .sort()[0];

  return (
    <>
      {result.hits.length === 0 ? (
        <p className="empty">Nothing from this key is in the part of those rings still held.</p>
      ) : (
        <>
          <p className="notary__live-lede">
            {/* "in what was read", not a total: each room returns at most its
                newest 200, so this is a floor on what is there and never a
                count of what the key has posted. */}
            {plural(result.hits.length, 'message')} from this key in what was read, each signature
            checked in this browser.
          </p>
          {result.hits.slice(0, 5).map((hit) => (
            <div className="notary__record" key={`${hit.room}-${hit.seq}`}>
              <p className="notary__record-head">
                <span className="mono">{hit.room}</span>
                <span className="notary__record-when mono">{hit.ts ? stamp(hit.ts) : '—'}</span>
              </p>
              <p className="notary__record-text">{hit.text.slice(0, 180)}</p>
            </div>
          ))}
        </>
      )}

      <p className="notary__note">
        Read just now from {result.roomsRead.map((room) => room).join(', ') || 'no rooms'}. Rings
        are shallow: the oldest message in what was read is from{' '}
        <span className="mono">{oldest ? stamp(oldest) : '—'}</span>, so this source cannot see
        past that and an absence here means only that.
      </p>

      {result.roomsFailed.length > 0 && (
        <p className="coverage__problem">
          Not read:{' '}
          {result.roomsFailed.map((entry) => `${entry.room} (${entry.reason})`).join(', ')}. Those
          rooms were not checked at all.
        </p>
      )}

      {result.forged > 0 && (
        <p className="coverage__problem">
          {plural(result.forged, 'message')} claiming to be from this key did not verify and are
          counted, not shown.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The anchors, and the key they are signed by
// ---------------------------------------------------------------------------

/**
 * Why this section exists at all.
 *
 * Everything else on this page asks you to believe Notary's clock. The daily
 * root is the reason you do not have to: it was published into a public room,
 * signed by a key pinned in this page's own source, before anyone asked about
 * any particular record. Notary cannot now backdate, remove or move a record
 * without the published root failing to reproduce.
 *
 * THE DID IS PINNED HERE, not read from the API. The API is asked what key it
 * thinks it has only so the two can be compared — a service that reported its
 * own identity and was believed would let a wrong key look correct.
 *
 * A full-width band between hairlines, and the roots set large in mono. This is
 * the part a sceptic came for and the only part they can check against
 * something outside this page, so it is given the weight of evidence rather
 * than the weight of a footnote.
 */
function AnchorBand({
  state,
}: {
  state: Async<AnchorLog & { matchesPinned: boolean; pinned: string }>;
}) {
  const [bandRef, seen] = useInView<HTMLElement>();
  if (state.phase === 'idle') return null;

  // While there is nothing to put in it, the band does not lay out two columns.
  // Splitting first and filling one side leaves the loading line centred in the
  // left column with an empty column beside it, which is the arrangement the
  // loading treatment exists to stop.
  if (state.phase !== 'ready') {
    return (
      <section
        className="nband nband--rules nband--anchors"
        id="anchors"
        ref={bandRef}
        data-in={seen}
      >
        <div className="nband__inner">
          <p className="nband__eyebrow">Anchors</p>
          {state.phase === 'loading' ? (
            <Loading>Reading the anchor log…</Loading>
          ) : (
            <p className="coverage__problem nband__prose">{state.error}</p>
          )}
        </div>
      </section>
    );
  }

  const log = state.value;

  return (
    <section className="nband nband--rules nband--anchors" id="anchors" ref={bandRef} data-in={seen}>
      <div className="nband__inner nband__split">
        <div className="nband__left">
          <p className="nband__eyebrow">Anchors</p>
          <h2 className="nband__title">Why you need not trust the clock.</h2>
          <p className="nband__copy">
            Once a day Notary builds a Merkle tree over everything it captured that day and
            publishes the root into <span className="mono">{log.anchor_room}</span>, signed by its
            own key. Fetch any record from the API and it comes with a proof: fold it into the leaf
            and you reach one of the roots below, or Notary has moved something.
          </p>
        </div>

        <div className="nband__right">
          <p className="pinned__label">Notary’s key, pinned</p>
          <p className="pinned__did mono">{log.pinned}</p>
          <p className="notary__note">
            This is the service’s own key, not its author’s, and it signs nothing but anchors.
            Foolscap never infers it from who posts in a room.
          </p>

          {!log.matchesPinned && (
            <p className="coverage__problem">
              The archive reports a different key — <span className="mono">{log.notary_did}</span>.
              Roots signed by it verify against nothing this page pins, so treat the log below as
              unwitnessed.
            </p>
          )}

          {log.can_sign === false && (
            <p className="coverage__problem">
              The archive cannot sign right now
              {log.signing_problem ? `: ${log.signing_problem}` : ''}. Roots are still computed;
              until one is published it constrains nothing.
            </p>
          )}
        </div>
      </div>

      {/* The roots run the whole width of the band rather than sitting in a
          column beside the explanation. A 64-character hash in 45% of the page
          wraps to two lines, and a hash you have to reassemble across a line
          break is a hash nobody will check against the room. */}
      <div className="nband__inner">
        {log.anchors.length === 0 ? (
          <p className="empty">No day has been anchored yet.</p>
        ) : (
          // The holes table's panel, so the page's two tables are one object
          // seen twice. No scroll window and no footer: the anchor log is one
          // row per day and bounded by how long Notary has been running.
          <div className="ntable">
            <ul className="nanchors">
              {log.anchors.map((anchor) => (
                <AnchorRow anchor={anchor} room={log.anchor_room} key={anchor.day} />
              ))}
            </ul>
          </div>
        )}
      </div>

      <SummaryAnchors rows={log.summary_anchors ?? []} room={log.anchor_room} />
    </section>
  );
}

/**
 * Roots over the summary tier, beside the record roots and never among them.
 *
 * THE PRUNED HALF OF THE ARCHIVE IS THE HALF THAT MOST NEEDS THIS. A day whose
 * records Notary still holds can be checked by fetching one and folding it into
 * that day's root. A day whose records were pruned has only the tier — and
 * until the tier has a published root of its own, that half of the archive is
 * exactly as trustworthy as the database, which is the thing this whole section
 * exists to stop being true.
 *
 * Its own list because it is its own claim. A record anchor commits to the
 * messages captured on one day and the days add up to a history. A summary
 * anchor commits to every key the tier knows about at one moment; the
 * publications are snapshots and do not add up to anything. Shown in one series
 * a reader would read the second as the first.
 */
function SummaryAnchors({ rows, room }: { rows: SummaryAnchor[]; room: string }) {
  if (rows.length === 0) return null;

  return (
    <div className="nband__inner">
      <p className="notary__rooms-title nsummary-anchors__title">
        The summary tier <span className="nsource__tag">roots over what outlives the window</span>
      </p>
      <div className="ntable">
        <ul className="nanchors">
          {rows.map((row) => (
            <li className="nanchor" key={row.id}>
              <div className="nanchor__day">
                <span className="mono">{stamp(row.builtAt)}</span>
                <span className="nanchor__count">{plural(row.rowCount, 'key')} covered</span>
              </div>
              <div className="nanchor__proof">
                <p className="nanchor__root mono">{row.root}</p>
                <p className="nanchor__meta mono">
                  {row.publishedAt
                    ? `published to ${room}${row.publishedSeq ? ` at seq ${row.publishedSeq}` : ''} · ${stamp(row.publishedAt)}`
                    : 'computed, not yet published — constrains nothing until it is'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className="notary__note nband__prose">
        Each of these commits to the whole tier as it stood at that moment — every key, every room,
        first and last seen, how many times — rather than to one day&rsquo;s messages. They are
        snapshots and do not add up to a history the way the daily roots do. For any period whose
        records have been pruned, this is the only thing standing behind what Notary says, so a
        root here that has not been published is the pruned archive resting on nothing but its own
        database.
      </p>
    </div>
  );
}


/**
 * One day's root, and where to go and check it.
 *
 * A row can carry a hole of its own. The archive keeps a record of what it
 * failed to capture; this is the same admission one level up — what it failed
 * to keep about its own anchoring. It sits under the root rather than beside
 * it, because the root above it is unaffected: the day is still verifiable
 * against the message in the room. Only the window is gone.
 */
function AnchorRow({ anchor, room }: { anchor: Anchor; room: string }) {
  return (
    <li className="nanchor">
      <div className="nanchor__day">
        <span className="mono">{anchor.day}</span>
        <span className="nanchor__count">
          {anchor.recordCount == null ? '—' : plural(anchor.recordCount, 'record')}
        </span>
      </div>
      <div className="nanchor__proof">
        <p className="nanchor__root mono">{anchor.root ?? 'not built'}</p>
        <p className="nanchor__meta mono">
          {anchor.publishedAt
            ? `published to ${room}${anchor.publishedSeq ? ` at seq ${anchor.publishedSeq}` : ''} · ${stamp(anchor.publishedAt)}`
            : 'computed, not yet published — constrains nothing until it is'}
        </p>
        {anchor.windowLost && (
          <p className="nanchor__lost">
            Capture window lost. This row was overwritten by a rebuild after it had been published;
            the root and the record count were restored from the published message, and the first
            and last capture times could not be, because that message had rotated out of{' '}
            <span className="mono">{room}</span> by the time it was noticed. The root still
            verifies. Notary no longer knows when this day started or stopped.
          </p>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------

/** One format everywhere: UTC, to the minute, unambiguous. */
function stamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}
