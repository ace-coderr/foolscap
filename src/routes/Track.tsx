// Track.tsx — the batch tracker and the referee panel.
//
// Ported from the render half of js/ui.js. Same copy, same structure, same
// rules about what may be shown as an answer.

import { useState, type FormEvent } from 'react';
import { Shell } from '../components/Shell';
import { useTracker, type Hole } from '../useTracker.ts';
import {
  REFEREE_DID,
  STATUS,
  WATCHED_ROOMS,
  type LookupEntry,
  type LookupResult,
  type Liveness,
} from '../lib/contest.ts';
import {
  num,
  plural,
  formatAge,
  formatUtc,
  formatRate,
  formatEta,
  STATUS_WORD,
  WANTS_ATTENTION,
  AT_RISK_FROM_HOLES,
} from '../format.ts';

export default function Track() {
  const { tracker, state, version, lostHoles, lostCount } = useTracker();
  const [field, setField] = useState('');
  const [query, setQuery] = useState('');

  // `version` is read so the page repaints when the tracker's contents change.
  void version;

  const settling = state.phase !== 'following' || state.recovering > 0;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setQuery(field.trim());
  }

  const result: LookupResult | null =
    state.ready && query ? tracker.lookup(query, { nowMs: Date.now() }) : null;

  return (
    <Shell page="track">
      {state.phase !== 'following' && state.phase !== 'failed' && (
        <Progress text={state.progressText} fraction={state.progressFraction} />
      )}

      <section className="section measure" id="lookup">
        <h2 className="section__title">Track my batch</h2>

        <form className="lookup" onSubmit={onSubmit} autoComplete="off">
          <label className="lookup__label" htmlFor="q">
            A request_id, or a did:key
          </label>
          <div className="lookup__row">
            <input
              className="lookup__input mono"
              id="q"
              name="q"
              type="text"
              inputMode="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="ace-reg-writer-1"
              value={field}
              onChange={(event) => setField(event.target.value)}
            />
            <button className="lookup__submit" type="submit">
              Look up
            </button>
          </div>
        </form>

        <div className="result" aria-live="polite">
          {query && !state.ready && (
            <p className="empty">Reading the rooms. Your answer lands as soon as they are in.</p>
          )}
          {result && (
            <>
              <StatusCard
                result={result}
                entry={result.entry}
                settling={settling}
                recovering={state.recovering > 0}
                lostCount={lostCount}
                lostHoles={lostHoles}
              />
              {result.entries.length > 1 && (
                <section className="others">
                  <p className="others__title">
                    {plural(result.entries.length - 1, 'other request')} from this DID
                  </p>
                  {result.entries.slice(1).map((entry, i) => (
                    <OtherRow key={`${entry.requestId ?? i}`} entry={entry} />
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </section>

      <section className="section measure" id="referee">
        <h2 className="section__title">The referee</h2>
        <div aria-live="polite">
          {state.phase === 'failed' ? (
            <>
              <p className="empty">
                Could not read any room. Nothing here can be shown as verified.
              </p>
              <Problems problems={state.problems} />
            </>
          ) : !state.ready ? (
            // No state until something has actually verified — a light rendered
            // off nothing is worse than no light.
            <p className="empty">Reading the rooms and checking signatures…</p>
          ) : (
            <RefereePanel
              live={tracker.liveness(Date.now())}
              holes={state.holes}
              gaps={state.gaps}
              problems={state.problems}
            />
          )}
        </div>
      </section>

      {/* The key itself, on the one page that uses it. Every receipt this page
          calls authoritative was checked against exactly this string, so it is
          written out in full and in mono, to be compared against LAUNCH.md by
          eye. It used to live in the footer of every page, which put a
          sonnet-2 key in front of people reading about something else. */}
      <section className="section measure" id="pinned">
        <h2 className="section__title">The pinned key</h2>
        <p className="pinned__copy">
          Receipts count here only if their Ed25519 signature verifies against this DID, pinned
          from LAUNCH.md in <span className="mono">flop-labs/technocore-sonnet-challenge</span> and
          hardcoded. Foolscap never infers the referee from a room&rsquo;s name, its topic, its
          owner, who posts in it, or the <span className="mono">referee</span> field inside a
          message — a launch record is just a message, and messages are forgeable.
        </p>
        <p className="mono pinned__did">{REFEREE_DID}</p>
        <p className="pinned__note">
          A message that claims the referee and fails that check is shown as a forgery rather than
          dropped, because someone handed a fake acceptance needs telling.
        </p>
      </section>
    </Shell>
  );
}

/** Deliberately quiet: a line of text and a hairline, never a blocking spinner. */
function Progress({ text, fraction }: { text: string; fraction: number | null }) {
  return (
    <div className="progress measure" aria-live="polite">
      <p className="progress__text">{text}</p>
      <div className="progress__track">
        <div
          className="progress__fill"
          style={{ width: fraction == null ? '0%' : `${Math.round(fraction * 100)}%` }}
        />
      </div>
    </div>
  );
}

function StatusCard({
  result,
  entry,
  settling,
  recovering,
  lostCount,
  lostHoles,
}: {
  result: LookupResult;
  entry: LookupEntry | undefined;
  settling: boolean;
  recovering: boolean;
  lostCount: number;
  lostHoles: Hole[];
}) {
  const status = result.status;
  const attention = WANTS_ATTENTION.has(status);
  const rooms = [...new Set(lostHoles.map((h) => h.room))].join(', ');

  return (
    <article className={`card${attention ? ' card--attention' : ''}`}>
      <h3 className="card__status">{STATUS_WORD[status] ?? status}</h3>

      {/* The subject is what was asked about, never what was found. */}
      <p className="card__subject">
        {result.queryKind === 'did' ? 'DID ' : 'request_id '}
        <span className="mono">{result.query}</span>
      </p>

      <p className="card__copy">{result.copy}</p>

      {recovering ? (
        <p className="card__note">
          A burst of messages went past faster than Foolscap could read them. It is re-reading the
          room to recover them before this answer can be relied on.
        </p>
      ) : settling ? (
        <p className="card__note">
          Foolscap is still verifying the backfill, so this answer can still change.
        </p>
      ) : null}

      {/* Louder than a note, because it is the one thing here that could be wrong. */}
      {AT_RISK_FROM_HOLES.has(status) && lostCount > 0 && (
        <div className="verbatim">
          <span className="verbatim__label">This status may be wrong</span>
          <span>
            {plural(lostCount, 'message')} in {rooms} rotated out before Foolscap could re-read
            them, and a receipt for this request could have been among them. Reload to read the
            rooms again — and until then, do not treat this as an answer.
          </span>
        </div>
      )}

      {entry?.reason && (
        <div className="verbatim">
          <span className="verbatim__label">The referee’s reason, verbatim</span>
          <span className="verbatim__text">{entry.reason}</span>
        </div>
      )}

      {entry && <Facts result={result} entry={entry} />}
    </article>
  );
}

function Facts({ result, entry }: { result: LookupResult; entry: LookupEntry }) {
  const rows: Array<[string, string | null | undefined, string?]> = [];

  // For a DID query the headline is one of several requests, so name which.
  if (result.queryKind === 'did' && entry.requestId) {
    rows.push(['Newest request', entry.requestId, 'mono']);
  }

  if (entry.request) {
    rows.push([
      'Posted',
      `${formatUtc(entry.tsMs)} · ${formatAge(Date.now() - (entry.tsMs ?? 0))} ago`,
    ]);
    rows.push(['Room', entry.room, 'mono']);
    rows.push(['Type', entry.type, 'mono']);
    if (result.queryKind !== 'did' && entry.request.from) {
      rows.push(['Signed by', entry.request.from, 'mono']);
    }
  }

  if (entry.receipt) {
    rows.push(['Intake', `#${num.format(entry.receipt.intakeSeq)}`]);
    rows.push([
      'Taken in',
      `${formatUtc(entry.receipt.receivedAtMs)} · ${formatAge(Date.now() - entry.receipt.receivedAtMs)} ago`,
    ]);
    if (entry.receipt.role) rows.push(['Role', entry.receipt.role]);
    if (!entry.request) {
      rows.push(['The request itself', 'has rotated out of the ring — the receipt is what remains']);
    }
  }

  if (entry.status === STATUS.QUEUED && entry.eta) {
    rows.push(['Ahead of you', plural(entry.eta.ahead, 'message')]);
    const eta = formatEta(entry.eta);
    if (eta) rows.push(['Estimate', `${eta} — an estimate; the referee bursts and stalls`]);
    const rate = formatRate(entry.eta.throughput);
    if (rate) rows.push(['At', rate]);
  }

  if (entry.status === STATUS.QUEUED && entry.frontierKnown === false) {
    rows.push(['Estimate', 'none — no verified receipt has been seen, so there is no frontier']);
  }

  if (entry.status === STATUS.UNANSWERED && entry.behindFrontierMs != null) {
    rows.push(['Behind the frontier', formatAge(entry.behindFrontierMs)]);
  }

  return (
    <dl className="facts">
      {rows
        .filter(([, value]) => value != null && value !== '')
        .map(([label, value, className]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd className={className}>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function OtherRow({ entry }: { entry: LookupEntry }) {
  const attention = WANTS_ATTENTION.has(entry.status);
  const when = entry.tsMs ?? entry.receipt?.receivedAtMs;
  return (
    <div className="row">
      <span className={`row__status${attention ? ' row__status--attention' : ''}`}>
        {STATUS_WORD[entry.status] ?? entry.status}
      </span>
      <span className="row__id mono">{entry.requestId ?? '—'}</span>
      {when && <span className="row__when">{formatAge(Date.now() - when)} ago</span>}
    </div>
  );
}

function RefereePanel({
  live,
  holes,
  gaps,
  problems,
}: {
  live: Liveness;
  holes: Hole[];
  gaps: string[];
  problems: string[];
}) {
  const lastAge = live.lastRefereeMessage ? formatAge(live.lastRefereeMessage.ageMs) : null;
  const statusAge = live.status ? formatAge(live.status.ageMs) : null;

  const facts: Array<[string, string | null]> = [
    ['Last message', lastAge ? `${lastAge} ago` : 'none verified yet'],
    [
      'Frontier',
      live.frontier
        ? `intake ${num.format(live.frontier.intakeSeq)} · received ${formatUtc(live.frontier.receivedAtMs)}`
        : 'no verified receipt yet',
    ],
    ['Intake rate', formatRate(live.throughput) ?? 'not enough receipts yet'],
    [
      '4-hourly status',
      live.status ? `${statusAge} ago${live.status.overdue ? ' — overdue' : ''}` : 'not seen in what Foolscap has read',
    ],
    ['Verified', `${num.format(live.verified)} messages from the pinned DID`],
  ];

  return (
    <>
      <div className={`state state--${live.state}`}>
        <span className="state__dot" />
        <span className="state__word">{live.state}</span>
      </div>

      {live.reasons.length > 0 && <p className="state__reasons">{live.reasons.join(' ')}</p>}

      <p className="frontier">{live.frontierSummary}</p>

      <div className="counts">
        {(
          [
            [live.receipts5, 'in 5 min'],
            [live.receipts15, 'in 15 min'],
            [live.receipts60, 'in 60 min'],
          ] as Array<[number, string]>
        ).map(([value, label]) => (
          <div className="count" key={label}>
            <span className="count__value">{num.format(value)}</span>
            <span className="count__label">{label}</span>
          </div>
        ))}
      </div>

      <p className="card__note">
        Receipts issued by the referee, counted from when it posted them.
      </p>

      <dl className="facts">
        {facts
          .filter(([, value]) => value != null && value !== '')
          .map(([label, value]) => (
            <div key={label} style={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>

      {live.forgeries.length > 0 && <Forgeries live={live} />}

      <div className="coverage">
        <p>
          Read from {plural(WATCHED_ROOMS.length, 'room')}. Rooms are rings, so anything old
          enough to have rotated out is not here.
        </p>
        {gaps.slice(-3).map((gap) => (
          <p className="coverage__problem" key={gap}>
            {gap}
          </p>
        ))}
        {holes.slice(-4).map((hole, i) => (
          <HoleLine hole={hole} key={`${hole.room}-${hole.from}-${i}`} />
        ))}
        <Problems problems={problems} />
      </div>
    </>
  );
}

function HoleLine({ hole }: { hole: Hole }) {
  if (hole.state === 'recovering') {
    return (
      <p>
        Re-reading {hole.room} to recover {plural(hole.missing ?? 0, 'message')} polling skipped.
      </p>
    );
  }
  if (hole.state === 'lost') {
    return (
      <p className="coverage__problem">
        {hole.room}: {plural(hole.missing ?? 0, 'message')} (seq {hole.from}–{hole.to}) rotated out
        before Foolscap could recover them. That part of the room is missing here.
      </p>
    );
  }
  if (hole.recovered) {
    return (
      <p>
        {hole.room}: recovered {plural(hole.recovered, 'message')} polling skipped.
      </p>
    );
  }
  return null;
}

function Forgeries({ live }: { live: Liveness }) {
  const count = live.forgeries.length;
  return (
    <section className="forgeries">
      <h3 className="forgeries__title">
        {num.format(count)} {count === 1 ? 'forgery' : 'forgeries'} found
      </h3>
      <p className="forgeries__lede">
        These messages claim the referee. None of them counted towards anything above.
      </p>
      {live.forgeries.map((forged) => (
        <article className="forgery" key={`${forged.room}-${forged.seq}`}>
          <span className="forgery__tag">{forgeryTag(forged.forgery)}</span>
          <p className="forgery__detail">{forged.forgery?.detail}</p>
          <p className="forgery__where">
            {/* seq is an identifier, not a quantity — no thousands separators. */}
            {forged.room} · seq {forged.seq} · <span className="mono">{forged.from ?? 'unknown sender'}</span>
          </p>
        </article>
      ))}
    </section>
  );
}

function forgeryTag(forgery: { reason: string; selfSignatureValid: boolean } | null): string {
  if (!forgery) return 'unverified';
  if (forgery.reason === 'wrong-signer') {
    return forgery.selfSignatureValid
      ? 'correctly signed, by the wrong key'
      : 'wrong key, and not signed by that key either';
  }
  return 'carries the referee DID; signature does not verify';
}

function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <>
      {problems.slice(-3).map((problem) => (
        <p className="coverage__problem" key={problem}>
          {problem}
        </p>
      ))}
    </>
  );
}
