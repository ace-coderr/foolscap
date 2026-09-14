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
  type ArchiveRecord,
  type Coverage,
  type Cutoff,
  type DidReport,
  type LiveResult,
  type Anchor,
  type AnchorLog,
} from '../useNotary.ts';

/** SVG and small, but it still need not block the first paint. */
const DrawingMerkle = lazy(() => import('../components/DrawingMerkle'));

/** The contest's own cutoff, offered as the default because it is the question. */
const DEFAULT_CUTOFF = IDENTITY_CUTOFF.slice(0, 10);

/** How long a band's hairlines take to draw, in ms. Mirrors the stylesheet. */
const BAND_DRAW = 500;

/** Stagger index for the reveal, as a custom property the stylesheet reads. */
const rise = (index: number) => ({ '--rise-i': index }) as CSSProperties;

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
          <p className="nverdict__waiting">Asking the archive, and reading the rings here…</p>
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
          <p className="empty">Reading what the archive covers…</p>
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
          <Ratio held={cov.records} missing={cov.lostMessages} />
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
                deserves, and restating it here is the repetition this section was
                rebuilt to lose. What the bar does not say is how many separate
                stretches those messages came from. */}
            <dt>Recorded holes</dt>
            <dd>
              {/* Spelled out rather than run through plural(), which appends an
                  "s" and would have written "40 stretchs". */}
              {unrecovered.length > 0
                ? `${num.format(unrecovered.length)} separate ${
                    unrecovered.length === 1 ? 'stretch' : 'stretches'
                  } of a room, listed below`
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

      <Holes gaps={unrecovered} />
    </>
  );
}

// ---------------------------------------------------------------------------
// The ratio
// ---------------------------------------------------------------------------

/**
 * Held against lost, to scale, and the first thing this section says.
 *
 * It is the most honest fact on the site and it used to be a clause in the
 * middle of a definition list: 565,311 records held, 6,409,232 messages gone
 * past — about eight percent of what Notary watched. Written out, a reader has
 * to divide two seven-digit numbers to learn what the page is admitting. Drawn,
 * they cannot miss it.
 *
 * --warn fills the missing segment, which is the one place on this site a state
 * colour is an AREA rather than a mark. It earns it: the area is the datum, and
 * what it marks is precisely the part of the record that is missing. Mixed down
 * to a fifth so the bar reads as a measurement and not as a warning stripe.
 *
 * BOTH NUMBERS COUNT ONLY WHAT NOTARY WATCHED. Messages in rooms it never
 * followed are in neither, so this is a ratio for the rooms it swept and not a
 * coverage figure for the network. The line underneath says so, because a
 * proportion with an unstated denominator is the exact failure this page exists
 * to avoid.
 */
function Ratio({ held, missing }: { held: number; missing: number }) {
  const passed = held + missing;
  if (passed === 0) return null;

  const heldPct = (held / passed) * 100;
  // Never below a tenth: "0.0%" of half a million records would read as none.
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
          <span className="nratio__label">Rotated past</span>
          <span className="nratio__figure">{num.format(missing)}</span>
          <span className="nratio__unit">messages gone before capture</span>
        </div>
      </div>

      {/* Both figures are already in the keys above, so the bar is a picture of
          them rather than a second source of the same facts. */}
      <div className="nratio__bar" aria-hidden="true">
        <div className="nratio__held" style={{ flexGrow: heldPct }} />
        <div className="nratio__missing" style={{ flexGrow: 100 - heldPct }} />
      </div>

      <p className="nratio__reading">
        Notary holds <strong>{shown}%</strong> of everything it watched pass. The rest rotated out
        of the rings before it could be captured, and this counts only the holes Notary noticed and
        wrote down — rooms it never followed are in neither figure.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recorded holes
// ---------------------------------------------------------------------------

/** Shown before the list folds. The rest are a click away, not a scroll. */
const HOLES_SHOWN = 6;

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
function Holes({ gaps }: { gaps: Coverage['gaps'] }) {
  const [all, setAll] = useState(false);
  if (gaps.length === 0) return null;

  const sorted = [...gaps].sort((a, b) => b.lost - a.lost);
  const shown = all ? sorted : sorted.slice(0, HOLES_SHOWN);
  const anyRecovered = sorted.some((gap) => gap.recovered > 0);

  return (
    <section className="section nband" id="holes">
      <div className="nband__inner">
        <p className="nband__eyebrow">Recorded holes</p>
        <p className="nband__prose nholes__lede">
          Each of these is a stretch of a room that rotated out before Notary could recover it.
          They are the holes Notary noticed and wrote down, and a hole means an absence inside it
          proves nothing at all.
        </p>

        {/* The one thing on this page allowed to be wider than the page. Four
            columns of room names, seven-digit figures and timestamps do not fit
            343px however they are sized, and reflowing them into stacked cards
            would throw away the only reason this is a table: that 6,290,114 and
            4,210 line up on their last digit and can be compared at a glance. */}
        <div className="nholes__scroll">
          <table className="nholes">
            <thead>
              <tr>
                <th scope="col" className="nholes__col-room">
                  Room
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

        {sorted.length > HOLES_SHOWN && (
          <button className="nholes__more" type="button" onClick={() => setAll((was) => !was)}>
            {all ? 'Show the largest six' : `Show all ${num.format(sorted.length)} holes`}
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
  if (state.phase === 'loading') return <p className="empty">Reading the archive…</p>;
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

      <p className="notary__note">{report.caveat}</p>
    </>
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
    return <p className="empty">Reading {plural(LIVE_ROOMS.length, 'room')} in this browser…</p>;
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

  return (
    <section className="nband nband--rules nband--anchors" id="anchors" ref={bandRef} data-in={seen}>
      <div className="nband__inner nband__split">
        <div className="nband__left">
          <p className="nband__eyebrow">Anchors</p>
          <h2 className="nband__title">Why you need not trust the clock.</h2>

          {state.phase === 'loading' && <p className="empty">Reading the anchor log…</p>}
          {state.phase === 'failed' && <p className="coverage__problem">{state.error}</p>}

          {state.phase === 'ready' && (
            <>
              <p className="nband__copy">
                Once a day Notary builds a Merkle tree over everything it captured that day and
                publishes the root into <span className="mono">{state.value.anchor_room}</span>,
                signed by its own key. Fetch any record from the API and it comes with a proof:
                fold it into the leaf and you reach one of the roots below, or Notary has moved
                something.
              </p>
            </>
          )}
        </div>

        <div className="nband__right">
          {state.phase === 'ready' && (
            <>
              <p className="pinned__label">Notary’s key, pinned</p>
              <p className="pinned__did mono">{state.value.pinned}</p>
              <p className="notary__note">
                This is the service’s own key, not its author’s, and it signs nothing but anchors.
                Foolscap never infers it from who posts in a room.
              </p>

              {!state.value.matchesPinned && (
                <p className="coverage__problem">
                  The archive reports a different key —{' '}
                  <span className="mono">{state.value.notary_did}</span>. Roots signed by it verify
                  against nothing this page pins, so treat the log below as unwitnessed.
                </p>
              )}

              {state.value.can_sign === false && (
                <p className="coverage__problem">
                  The archive cannot sign right now
                  {state.value.signing_problem ? `: ${state.value.signing_problem}` : ''}. Roots
                  are still computed; until one is published it constrains nothing.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* The roots run the whole width of the band rather than sitting in a
          column beside the explanation. A 64-character hash in 45% of the page
          wraps to two lines, and a hash you have to reassemble across a line
          break is a hash nobody will check against the room. */}
      {state.phase === 'ready' && (
        <div className="nband__inner">
          {state.value.anchors.length === 0 ? (
            <p className="empty">No day has been anchored yet.</p>
          ) : (
            <ul className="nanchors">
              {state.value.anchors.map((anchor) => (
                <AnchorRow anchor={anchor} room={state.value.anchor_room} key={anchor.day} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function AnchorRow({ anchor, room }: { anchor: Anchor; room: string }) {
  return (
    <li className="nanchor">
      <div className="nanchor__day">
        <span className="mono">{anchor.day}</span>
        <span className="nanchor__count">
          {anchor.recordCount == null ? '—' : `${num.format(anchor.recordCount)} records`}
        </span>
      </div>
      <div className="nanchor__proof">
        <p className="nanchor__root mono">{anchor.root ?? 'not built'}</p>
        <p className="nanchor__meta mono">
          {anchor.publishedAt
            ? `published to ${room}${anchor.publishedSeq ? ` at seq ${anchor.publishedSeq}` : ''} · ${stamp(anchor.publishedAt)}`
            : 'computed, not yet published — constrains nothing until it is'}
        </p>
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
