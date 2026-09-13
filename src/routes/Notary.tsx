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

import { useState, type FormEvent } from 'react';
import { Shell } from '../components/Shell';
import { num, plural, formatAge } from '../format.ts';
import { IDENTITY_CUTOFF } from '../lib/contest.ts';
import {
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
} from '../useNotary.ts';

/** The contest's own cutoff, offered as the default because it is the question. */
const DEFAULT_CUTOFF = IDENTITY_CUTOFF.slice(0, 10);

export default function Notary() {
  const coverage = useCoverage();
  const archive = useArchive();
  const live = useLive();

  const [field, setField] = useState('');
  const [cutoffDay, setCutoffDay] = useState(DEFAULT_CUTOFF);
  const [asked, setAsked] = useState<{ did: string; before: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const did = field.trim();
    if (!looksLikeDid(did)) {
      setProblem('That is not a did:key Ed25519 identifier. They begin did:key:z6Mk and run about 56 characters.');
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
    <Shell page="notary">
      <CoverageBand state={coverage} />

      <section className="section measure" id="ask">
        <h2 className="section__title">Was this key active before a date?</h2>

        <form className="lookup" onSubmit={onSubmit} autoComplete="off">
          <label className="lookup__label" htmlFor="did">
            A did:key
          </label>
          <div className="lookup__row">
            <input
              className="lookup__input mono"
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
            <button className="lookup__submit" type="submit">
              Look up
            </button>
          </div>

          <div className="notary__cutoff">
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
            <p className="notary__cutoff-note">
              Midnight UTC on that day. The default is sonnet-2’s own identity cutoff.
            </p>
          </div>
        </form>

        {problem && <p className="notary__problem">{problem}</p>}

        {/* NO KEY INPUT ANYWHERE ON THIS PAGE. It reads only — a DID is a public
            identifier, and nothing here ever asks for, accepts or transmits a
            private key. */}
        <p className="notary__nokey">
          A DID is public. Nothing on this page asks for a key, and nothing is posted on your
          behalf.
        </p>
      </section>

      {asked && (
        <>
          <section className="section measure" id="answer" aria-live="polite">
            <h2 className="section__title">The answer</h2>
            <CutoffAnswer archive={archive.state} live={live.state} asked={asked} />
          </section>

          <section className="section measure" id="archive">
            <h2 className="section__title">
              Archive <span className="notary__source-tag">Notary’s capture</span>
            </h2>
            <ArchivePanel state={archive.state} />
          </section>

          <section className="section measure" id="live">
            <h2 className="section__title">
              Live <span className="notary__source-tag">the rings, read here</span>
            </h2>
            <LivePanel state={live.state} />
          </section>
        </>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Coverage — stated before anything is asked
// ---------------------------------------------------------------------------

type Async<T> = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; value: T } | { phase: 'failed'; error: string };

function CoverageBand({ state }: { state: Async<Coverage> }) {
  if (state.phase === 'loading') {
    return (
      <section className="section measure">
        <p className="empty">Reading what the archive covers…</p>
      </section>
    );
  }

  if (state.phase === 'failed') {
    return (
      <section className="section measure">
        <p className="coverage__problem">
          {archiveConfigured()
            ? `The archive did not answer: ${state.error}`
            : 'This build has no archive behind it.'}{' '}
          Nothing below can be read as archive evidence, and an empty archive result here would
          mean the archive is unreachable — not that a key was inactive.
        </p>
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

  return (
    <section className="section measure" id="coverage">
      <h2 className="section__title">What this archive covers</h2>

      <p className="notary__coverage-lede">
        Nothing before <span className="mono">{start ?? 'capture has not started'}</span> exists
        here, for any key. Notary began capturing then; the network’s own history from before that
        moment had already rotated away and cannot be recovered by anyone.
      </p>

      <dl className="facts">
          <dt>Swept</dt>
          <dd className="mono">
            {start ?? '—'} → {end ?? '—'}
          </dd>
          <dt>Held</dt>
          <dd>
            {num.format(cov.records)} records across {num.format(cov.dids)} DIDs and{' '}
            {plural(cov.rooms, 'room')}
          </dd>
          <dt>Known missing</dt>
          <dd>
            {cov.lostMessages > 0
              ? `${num.format(cov.lostMessages)} messages rotated past Notary and are gone`
              : 'no unrecovered gaps recorded'}
          </dd>
          <dt>Oldest message held</dt>
          <dd className="mono">{cov.earliestSourceTs ? stamp(cov.earliestSourceTs) : '—'}</dd>
          {cov.submitted > 0 && (
            <>
              <dt>Submitted</dt>
              <dd>
                {plural(cov.submitted, 'record')} handed to Notary directly rather than swept
              </dd>
            </>
          )}
      </dl>

      <p className="notary__note">
        The oldest message held is older than the capture window because the first sweep read
        whatever the rings still contained. Its timestamp is the room’s claim, not something
        Notary watched happen — the distinction is kept everywhere below.
      </p>

      {stale && (
        <p className="coverage__problem">
          Sweeping is not running. The mirror last captured a message{' '}
          {formatAge(cov.staleSeconds! * 1000)} ago, so everything since then is uncovered and is
          being lost as the rings turn. Anything submitted directly in the meantime is still held —
          it just does not mean the rooms are being watched.
        </p>
      )}

      {unrecovered.length > 0 && (
        <div className="notary__gaps">
          <p className="notary__gaps-title">Recorded holes</p>
          {unrecovered.map((gap) => (
            <p className="coverage__problem" key={gap.id}>
              <span className="mono">{gap.room}</span>: {num.format(gap.lost)} messages rotated out
              before Notary could recover them
              {gap.recovered > 0 && ` (${num.format(gap.recovered)} of ${num.format(gap.missing ?? 0)} were recovered)`}
              , noticed {stamp(gap.noticedAt)}.
            </p>
          ))}
          <p className="notary__note">
            These are holes Notary noticed and wrote down. A hole means an absence inside it proves
            nothing at all.
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

function CutoffAnswer({
  archive,
  live,
  asked,
}: {
  archive: Async<DidReport>;
  live: Async<LiveResult>;
  asked: { did: string; before: string };
}) {
  if (archive.phase === 'loading') return <p className="empty">Asking the archive…</p>;

  const cutoff: Cutoff | null = archive.phase === 'ready' ? archive.value.cutoff : null;
  const liveHits = live.phase === 'ready' ? live.value.hits : [];
  const liveBefore = liveHits.filter((hit) => hit.tsMs < Date.parse(asked.before));

  // The live rings can answer the question outright when the DID posted before
  // the cutoff and the message is still in the ring. Rare — rings are minutes
  // deep — but when it happens it is the strongest evidence on the page, because
  // this browser checked the signature itself.
  if (liveBefore.length > 0) {
    return (
      <div className="card card--attention">
        <h3 className="card__status">Yes — verified here</h3>
        <p className="card__copy">
          A message from this key, dated <span className="mono">{stamp(liveBefore[0].ts ?? '')}</span> in{' '}
          <span className="mono">{liveBefore[0].room}</span>, is still in the ring and its signature
          verified in this browser just now.
        </p>
      </div>
    );
  }

  if (archive.phase === 'failed') {
    return (
      <div className="card">
        <h3 className="card__status">No answer</h3>
        <p className="card__copy">
          The archive could not be reached: {archive.error}. That is a fault here, not a finding
          about this key.
        </p>
      </div>
    );
  }

  // Narrowing for the branches below, which read the report itself.
  if (archive.phase !== 'ready') return null;
  if (!cutoff) return <p className="empty">No cutoff was asked for.</p>;

  if (cutoff.answer === 'witnessed') {
    return (
      <div className="card card--attention">
        <h3 className="card__status">Yes — Notary witnessed it</h3>
        <p className="card__copy">
          Notary held a signed message from this key at{' '}
          <span className="mono">{stamp(cutoff.witnessedBefore!)}</span>, before{' '}
          <span className="mono">{stamp(cutoff.before)}</span>. That timestamp is Notary’s own
          clock, which is the one thing in this record only Notary can provide.
        </p>
        <Evidence id={cutoff.evidenceRecordId} />
      </div>
    );
  }

  if (cutoff.answer === 'claimed') {
    return (
      <div className="card card--attention">
        <h3 className="card__status">Yes — on the room’s timestamp</h3>
        <p className="card__copy">
          The archive holds a signed message from this key that{' '}
          <span className="mono">{roomOf(archive.value, cutoff.evidenceRecordId)}</span> dates{' '}
          <span className="mono">{stamp(cutoff.claimedBefore!)}</span>, before{' '}
          <span className="mono">{stamp(cutoff.before)}</span>.
        </p>
        <p className="card__note">
          The signature is real and you can re-verify it yourself. The <em>time</em> is the room’s
          claim: Notary read this message out of ring history after the fact rather than watching it
          arrive, so it vouches for the key, not the clock.
        </p>
        <Evidence id={cutoff.evidenceRecordId} />
      </div>
    );
  }

  // The important one, and the one every version of this product gets wrong.
  return (
    <div className="card">
      <h3 className="card__status">Nothing on record</h3>
      <p className="card__copy">
        Notary holds no message from this key from before{' '}
        <span className="mono">{stamp(cutoff.before)}</span>.
      </p>
      <p className="card__note">
        <strong>This is not evidence the key was inactive.</strong> It is a fact about the archive:
        Notary captured nothing before its coverage start, it has recorded holes where messages
        rotated past it, and busy rooms are sampled rather than kept whole. A key can have been
        posting continuously and still appear nowhere above.
      </p>
      {archive.value.totalRecords > 0 && (
        <p className="card__note">
          The archive does hold {plural(archive.value.totalRecords, 'record')} from this key, the
          earliest dated <span className="mono">{stamp(archive.value.firstSourceTs ?? '')}</span> —
          after the cutoff asked about.
        </p>
      )}
    </div>
  );
}

function Evidence({ id }: { id: string | null }) {
  if (!id) return null;
  return (
    <p className="card__note">
      Evidence: record <span className="mono">{id}</span>. Fetch it from the API to get the original
      signature, the canonical string it covers, and its Merkle proof, and check all three without
      trusting Notary.
    </p>
  );
}

function roomOf(report: DidReport, id: string | null): string {
  return report.earliest.find((record) => record.id === id)?.room ?? 'the room';
}

// ---------------------------------------------------------------------------
// Archive detail
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Live detail
// ---------------------------------------------------------------------------

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
        <span className="mono">{oldest ? stamp(oldest) : '—'}</span>, so this source cannot see past
        that and an absence here means only that.
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

/** One format everywhere: UTC, to the minute, unambiguous. */
function stamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}
