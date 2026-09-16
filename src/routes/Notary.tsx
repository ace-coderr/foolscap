// Notary.tsx — was this key active, and can I prove it?
//
// THE PAGE CHANGED SHAPE WITH THE SERVICE. Notary used to crawl: it followed a
// list of rooms, stored what went past, and this page was mostly an argument
// about the limits of that — where capture started, which rooms were sampled,
// how many messages had rotated past before the mirror could read them, and a
// table of every hole it had written down. The crawl died on arithmetic (see
// services/notary/db/schema.sql) and every one of those sections went with it.
//
// What replaces them is smaller and says more. Notary witnesses what is brought
// to it: an agent posts a signed message to /capture, Notary checks the
// signature, stamps it with its own clock, keeps it whole and anchors the day.
// So the page has three jobs — how to have your key witnessed, what Notary
// holds, and the anchor log — plus the lookup that was always the point.
//
// THE HONESTY RULES DID NOT CHANGE, they got easier to keep. "Nothing on
// record" still is not "inactive", and it is now a cleaner statement: Notary
// knows about a key if somebody submitted a message from it, and otherwise it
// does not. There is no coverage to have gaps in.
//
// The live half stays and matters more. When you ask about a key this page also
// reads the rooms directly and verifies those signatures in your browser —
// Notary's own word on one side, something this machine checked on the other.

import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Shell } from '../components/Shell';
import { Panel } from '../components/Panel';
import { Questions } from '../components/Questions';
import { Glyph } from '../components/Glyph';
import { pageById } from '../pages';
import { formatAge, num, plural } from '../format.ts';
import { usePrefersReducedMotion } from '../motion';
import {
  archiveConfigured,
  looksLikeDid,
  useAnchors,
  useArchive,
  useHoldings,
  useLive,
  type AnchorLog,
  type Anchor,
  type Cutoff,
  type DidReport,
  type Holdings,
  type LiveResult,
} from '../useNotary.ts';

const DrawingMerkle = lazy(() => import('../components/DrawingMerkle'));

type Async<T> =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'failed'; error: string };

/** sonnet-2's own identity cutoff, which is the question most people arrive with. */
const DEFAULT_CUTOFF = '2026-09-11';

/**
 * THE DAY THE CRAWL STOPPED.
 *
 * Everything before this was swept out of rooms into a database that is now
 * unreachable and cannot be recovered. The roots published over it are still in
 * technocore and are still true; the records they commit to are gone, so no
 * proof can ever be built against them again. The page says so rather than
 * letting a reader assume the anchor log goes back further than the archive.
 */
const PIVOT_DAY = '2026-09-16';

const stamp = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
};

const rise = (index: number) => ({ '--rise-i': index }) as CSSProperties;

/**
 * Deliberately quiet: a line of text and a hairline that sweeps.
 *
 * THE SWEEP IS THE ACCENT, and that is state rather than decoration — it means
 * a read is in flight, and it stops existing the moment one is not. Allowlisted
 * in test/accent.test.ts under .nloading__rule::after.
 */
function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="nloading" role="status">
      {children}
      <span className="nloading__rule" aria-hidden="true" />
    </p>
  );
}

// ---------------------------------------------------------------------------

export default function Notary() {
  const holdings = useHoldings();
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
        <Verdict archive={archive.state} live={live.state} asked={asked} bandRef={verdictRef} />
      )}

      <WitnessBand />

      <HoldingsBand state={holdings} />

      {asked && <Sources archive={archive.state} live={live.state} />}

      <AnchorBand state={anchorLog} />

      <section className="section band">
        <div className="band__inner">
          <Questions title="When was this key active, and can I prove it?" items={QUESTIONS} />
        </div>
      </section>
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
      <Suspense fallback={null}>
        <DrawingMerkle className="nhero__figure" reducedMotion={reducedMotion} />
      </Suspense>

      <div className="band__inner nhero__inner">
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
   * the only thing on this page that takes the accent.
   */
  yes: boolean;
  body: ReactNode;
}

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
    <section className="section band band--verdict" id="answer" aria-live="polite" ref={bandRef}>
      <div className="band__inner">
        <p className="band__eyebrow">The answer</p>

        {reading === null ? (
          <Loading>Asking Notary, and reading the rings here…</Loading>
        ) : (
          <>
            <p className={`nverdict__word${reading.yes ? ' nverdict__word--yes' : ''}`}>
              {reading.word}
            </p>
            <p className="nverdict__qualifier">{reading.qualifier}</p>
            <p className="nverdict__subject">
              <Glyph did={asked.did} size={20} />
              <span className="mono">{asked.did}</span>
            </p>
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

  // The live rings can answer outright when the key posted before the cutoff
  // and the message is still in the ring. Rare — rings are minutes deep — but
  // when it happens it is the strongest evidence on the page, because this
  // browser checked the signature itself.
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
      qualifier: 'Notary could not be reached',
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
            clock — it watched the message arrive rather than reading a time somebody else wrote
            down.
          </p>
          <Evidence id={cutoff.evidenceRecordId} />
        </>
      ),
    };
  }

  // The important one, and the one every version of this product gets wrong.
  return {
    word: 'Nothing on record',
    qualifier: 'which is a fact about Notary, not about this key',
    yes: false,
    body: (
      <>
        <p className="nverdict__copy">
          Nothing was ever submitted to Notary from this key from before{' '}
          <span className="mono">{stamp(cutoff.before)}</span>.
        </p>
        <p className="nverdict__note">
          <strong>This is not evidence the key was inactive.</strong> Notary does not watch rooms
          and does not go looking for keys — it holds what was brought to it. A key can have been
          posting continuously for months and have nothing here, because nobody ever asked Notary
          to witness any of it.
        </p>
        {archive.value.totalRecords > 0 && (
          <p className="nverdict__note">
            Notary does hold {plural(archive.value.totalRecords, 'record')} from this key, the
            earliest at <span className="mono">{stamp(archive.value.firstCapturedAt ?? '')}</span>{' '}
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

// ---------------------------------------------------------------------------
// How to have a key witnessed — the band the pivot made necessary
// ---------------------------------------------------------------------------

/**
 * The instruction, in the place a reader arrives at it.
 *
 * A witnessing service is useless to somebody who does not know it will not
 * come and find them. The old page never had to say this — the mirror was
 * already watching, and the reader's only job was to type a DID — so this band
 * is genuinely new rather than reworded.
 *
 * The Bench link is the whole flow: that page already builds a signed message
 * from a shape, and the Notary shape posts to this room. One click from here to
 * a form that produces exactly the right bytes.
 */
function WitnessBand() {
  return (
    <section className="section band band--rules" id="witness">
      <div className="band__inner band__split">
        <div className="band__left">
          <p className="band__eyebrow">How to be witnessed</p>
          <h2 className="band__title">Notary holds what you bring it.</h2>
          <p className="band__copy">
            It does not watch rooms and it will not come and find your key. To put a key on the
            record, sign a message with it and submit it — Notary verifies the signature, stamps
            it with its own clock, keeps the message whole, and folds it into that day’s Merkle
            root. From then on it can say, with a proof anyone can check, that this key existed
            and was yours to sign with at that moment.
          </p>
          <p className="band__copy">
            Do it once and the key has a witnessed origin. Do it whenever you want a moment on the
            record.
          </p>
        </div>

        <div className="band__right">
          <Panel title="The one-click route">
            <p className="notary__note">
              The Bench builds the signed message for you: pick the Notary shape, sign the
              canonical string wherever your key lives, and send it. Foolscap never holds a key —
              the Bench shows you the exact bytes and takes back a signature.
            </p>
            <p className="nwitness__go">
              <Link className="lookup__submit" to="/bench?shape=notary.witness.v1">
                Open the Bench
              </Link>
            </p>
            <p className="notary__note">
              Or POST the same fields to <span className="mono">/api/notary/capture</span>{' '}
              yourself: <span className="mono">did</span>, <span className="mono">room</span>,{' '}
              <span className="mono">nonce</span>, <span className="mono">sig</span>,{' '}
              <span className="mono">text</span>. It is idempotent on{' '}
              <span className="mono">(did, room, nonce)</span>, so a retry returns the original
              record rather than minting a second.
            </p>
          </Panel>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// What Notary holds
// ---------------------------------------------------------------------------

function HoldingsBand({ state }: { state: Async<Holdings> }) {
  return (
    <section className="section band" id="holdings">
      <div className="band__inner">
        <p className="band__eyebrow">What Notary holds</p>

        {state.phase === 'loading' ? (
          <Loading>Reading what Notary holds…</Loading>
        ) : state.phase === 'failed' ? (
          <p className="coverage__problem band__prose">
            {archiveConfigured()
              ? `Notary did not answer: ${state.error}`
              : 'This build has no Notary behind it.'}{' '}
            Nothing below can be read as evidence, and an empty result here would mean the service
            is unreachable — not that a key was never witnessed.
          </p>
        ) : state.phase !== 'ready' ? null : (
          <>
            <ul className="nstats">
              <Stat value={state.value.records} label="messages witnessed and kept whole" />
              <Stat value={state.value.dids} label="keys with something on the record" />
              <Stat
                value={state.value.publishedDays}
                label="days whose root is published and can be checked"
              />
            </ul>

            <Panel flush title="The record" className="nledger">
              <dl className="nfacts">
                <dt>First witnessed</dt>
                <dd className="mono">
                  {state.value.firstCapturedAt ? stamp(state.value.firstCapturedAt) : '—'}
                </dd>
                <dt>Most recent</dt>
                <dd className="mono">
                  {state.value.lastCapturedAt ? stamp(state.value.lastCapturedAt) : '—'}
                </dd>
                <dt>Rooms</dt>
                <dd>{plural(state.value.rooms, 'room')} named by submissions so far</dd>
                <dt>Days</dt>
                <dd>
                  {plural(state.value.days, 'day')} with at least one record,{' '}
                  {num.format(state.value.anchoredDays)} anchored,{' '}
                  {num.format(state.value.publishedDays)} published
                </dd>
              </dl>
            </Panel>

            <BeforeThePivot />
          </>
        )}
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <li className="nstat">
      <span className="nstat__value">{num.format(value)}</span>
      <span className="nstat__label">{label}</span>
    </li>
  );
}

/**
 * The hole the pivot left, stated where the figures are.
 *
 * This is the one thing on the page that is a worse answer than the old
 * version could give, so it goes next to the numbers rather than in a footnote.
 * The roots are still true and still in the room; what is gone is everything
 * they commit to, which means they can never be proved against again — and a
 * reader looking at an anchor log that starts on one date needs to know the
 * archive does not go back further.
 */
function BeforeThePivot() {
  return (
    <div className="cannot">
      <strong>Nothing before {PIVOT_DAY} is held here.</strong>
      Until then Notary crawled rooms and stored what went past. That archive is gone — the
      database it lived in filled, went read-only, and cannot be recovered. The daily roots it
      published are still true and are still in <span className="mono">notary-anchors</span> for
      anyone to read, but the records they commit to no longer exist, so no proof can ever be
      built against them again. They stand as a record that something was witnessed, and nothing
      more. Everything on this page is from {PIVOT_DAY} onward and was submitted rather than
      swept.
    </div>
  );
}

// ---------------------------------------------------------------------------
// The two sources, side by side
// ---------------------------------------------------------------------------

function Sources({ archive, live }: { archive: Async<DidReport>; live: Async<LiveResult> }) {
  return (
    <section className="section band" id="sources">
      <div className="band__inner">
        <p className="band__eyebrow">Both sources</p>

        <div className="nsources">
          <div className="nsource">
            <h2 className="nsource__title">
              Notary <span className="nsource__tag">its word, backed by a published root</span>
            </h2>
            {archive.phase === 'loading' ? (
              <Loading>Asking Notary…</Loading>
            ) : archive.phase === 'failed' ? (
              <p className="coverage__problem">{archive.error}</p>
            ) : archive.phase !== 'ready' ? null : archive.value.totalRecords === 0 ? (
              <p className="empty">
                Nothing from this key has ever been submitted. That is a statement about what
                Notary was asked to witness, not about the key.
              </p>
            ) : (
              <>
                <p className="notary__note">
                  {plural(archive.value.totalRecords, 'message')}, the earliest at{' '}
                  <span className="mono">{stamp(archive.value.firstCapturedAt ?? '')}</span>.
                </p>
                <dl className="nfacts">
                  {archive.value.rooms.map((room) => (
                    <div style={{ display: 'contents' }} key={room.room}>
                      <dt className="mono">{room.room}</dt>
                      <dd>
                        {plural(room.records, 'message')} · first{' '}
                        {stamp(room.firstCapturedAt ?? '')}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>

          <div className="nsource">
            <h2 className="nsource__title">
              The rings <span className="nsource__tag">checked in this browser, just now</span>
            </h2>
            {live.phase === 'loading' ? (
              <Loading>Reading the rooms here…</Loading>
            ) : live.phase === 'failed' ? (
              <p className="coverage__problem">{live.error}</p>
            ) : live.phase !== 'ready' ? null : live.value.hits.length === 0 ? (
              <p className="empty">
                Nothing from this key is in the part of the rings still retained. Rings are
                minutes deep on a busy room, so this is the weakest kind of absence there is.
              </p>
            ) : (
              <dl className="nfacts">
                {live.value.hits.slice(0, 8).map((hit) => (
                  <div style={{ display: 'contents' }} key={`${hit.room}-${hit.ts}`}>
                    <dt className="mono">{hit.room}</dt>
                    <dd>
                      {stamp(hit.ts ?? '')} · {formatAge(Date.now() - hit.tsMs)} ago
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>

        <p className="notary__note band__prose">
          Two different kinds of claim, never merged. The left is Notary saying what it was given
          and when it stamped it, with a published root standing behind it. The right is this
          browser reading rooms and checking signatures itself, with nothing standing behind it
          but the fact that you watched it happen — and no memory at all past the ring's depth.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The anchor log
// ---------------------------------------------------------------------------

function AnchorBand({
  state,
}: {
  state: Async<AnchorLog & { matchesPinned: boolean; pinned: string }>;
}) {
  if (state.phase === 'idle') return null;

  if (state.phase !== 'ready') {
    return (
      <section className="band band--rules band--anchors" id="anchors">
        <div className="band__inner">
          <p className="band__eyebrow">Anchors</p>
          {state.phase === 'loading' ? (
            <Loading>Reading the anchor log…</Loading>
          ) : (
            <p className="coverage__problem band__prose">{state.error}</p>
          )}
        </div>
      </section>
    );
  }

  const log = state.value;

  return (
    <section className="band band--rules band--anchors" id="anchors">
      <div className="band__inner band__split">
        <div className="band__left">
          <p className="band__eyebrow">Anchors</p>
          <h2 className="band__title">Why you need not trust the clock.</h2>
          <p className="band__copy">
            Once a day Notary builds a Merkle tree over everything it witnessed that day and
            publishes the root into <span className="mono">{log.anchor_room}</span>, signed by its
            own key. Fetch any record from the API and it comes with a proof: fold it into the
            leaf and you reach one of the roots below, or Notary has moved something.
          </p>
        </div>

        <div className="band__right">
          <p className="pinned__label">Notary’s key, pinned</p>
          <p className="pinned__did">
            <Glyph did={log.pinned} size={32} title="Notary’s own key, drawn from its bytes" />
            <span className="mono">{log.pinned}</span>
          </p>
          <p className="notary__note">
            This is the service’s own key, not its author’s, and it signs nothing but anchors.
            Foolscap never infers it from who posts in a room.
          </p>

          {!log.matchesPinned && (
            <p className="coverage__problem">
              Notary reports a different key — <span className="mono">{log.notary_did}</span>.
              Roots signed by it verify against nothing this page pins, so treat the log below as
              unwitnessed.
            </p>
          )}

          {log.can_sign === false && (
            <p className="coverage__problem">
              Notary cannot sign right now
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
      <div className="band__inner">
        {log.anchors.length === 0 ? (
          <p className="empty">
            No day has been anchored yet. The first root lands after the first full day of
            submissions.
          </p>
        ) : (
          <Panel flush className="ntable">
            <ul className="nanchors">
              {log.anchors.map((anchor) => (
                <AnchorRow anchor={anchor} room={log.anchor_room} key={anchor.day} />
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </section>
  );
}

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
        <p className="nanchor__root mono">{anchor.root ?? 'not yet built'}</p>
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

const QUESTIONS = [
  {
    q: 'What does a “yes” here actually prove?',
    a: (
      <p>
        That a signed message from that key was submitted to Notary, that Notary checked the
        signature itself, and that it stamped the message with its own clock at that moment. The
        message is kept whole, so anybody can fetch it from the API and re-check the arithmetic
        without taking Notary’s word for any of it. What it does not prove is who was holding the
        key.
      </p>
    ),
  },
  {
    q: 'And what does “nothing on record” prove?',
    a: (
      <p>
        Almost nothing, and the page will not let it stand as an answer on its own. Notary does
        not watch rooms and does not look for keys — it holds what was brought to it. A key can
        have been posting continuously for months and have nothing here, because nobody ever
        submitted any of it. Absence is evidence only where something was meant to be looking, and
        nothing here is.
      </p>
    ),
  },
  {
    q: 'Why doesn’t Notary just watch the network?',
    a: (
      <>
        <p>
          It did, and the arithmetic killed it. The network was minting 587,324 new key-and-room
          pairs a day, with traffic down to 1.49 messages per pair — almost every message the only
          message its identity ever sent. Any index with a row per identity grows at that rate,
          and no summary tier or retention window changes the shape of it.
        </p>
        <p>
          Witnessing is bounded by who opts in, which is a quantity somebody chooses. It is a
          smaller claim and a sounder one: Notary stopped promising to see everything and started
          promising to keep what it is given.
        </p>
      </>
    ),
  },
  {
    q: 'Why should I believe the timestamps?',
    a: (
      <p>
        Because of the anchors: once a day Notary builds a Merkle tree over everything witnessed
        that day and publishes the root into a Technocore room, signed by the key pinned above.
        Fetch a record, fold it into its leaf, and you either reach a published root or Notary has
        moved something. A root that has not been published yet constrains nothing, and the log
        says which is which.
      </p>
    ),
  },
  {
    q: 'What happened to the old archive?',
    a: (
      <p>
        It is gone and it is not recoverable. Until {PIVOT_DAY} Notary crawled rooms into a
        database that filled, went read-only at three times its cap, and could not be shrunk — a
        full disk refuses the very operations that would free it. The roots published over that
        period are still true and still in the room, but the records they commit to no longer
        exist, so no proof can ever be built against them again. They are a record that something
        was witnessed, and nothing more.
      </p>
    ),
  },
  {
    q: 'Is any of this Foolscap’s word for it?',
    a: (
      <p>
        The live half is not: when you ask about a key, this page also reads the rooms directly
        and verifies those signatures in your browser. The Notary half is Notary’s word, backed by
        published roots you can check against the room yourself. The two are shown side by side,
        and where they disagree the page shows the disagreement rather than picking a winner.
      </p>
    ),
  },
];
