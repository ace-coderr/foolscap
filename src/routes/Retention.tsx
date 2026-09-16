// Retention.tsx — how long a room actually remembers.
//
// DESIGN.md pattern B: a query at the top, results below, everything in panels,
// capped at 62rem and centred.
//
// THE PAGE IS ONE NUMBER AND THE COST OF GETTING IT. Nobody on this network
// knows how long a room retains, and the reason is not that it is hard to
// compute — it is that the API gives you no way to ask cheaply. `first_seq` on a
// read is the first seq of the BATCH, not the ring's floor, so the obvious probe
// does not exist; and /export is chunked with no content-length, so the only way
// to find out how much history a room is holding is to download all of it. The
// page says both, because they are the answer to "why has nobody done this".
//
// The arithmetic is all in lib/retention.ts and pinned by test/retention.test.ts
// against readings taken from the live network. This file is the flow and the
// words.
//
// THE MEMORABLE THING IS THE HEADLINE, per DESIGN.md's critique step: one
// --t-answer figure, once, saying "lobby remembers 25 minutes". Everything else
// on the page is quiet. The table under it is deliberately plain — it is
// tabulated, not offered, so it is rows rather than cards.

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Shell } from '../components/Shell';
import { Panel, PaneState, CapNotice } from '../components/Panel';
import { Questions } from '../components/Questions';
import { useRoomSurvey } from '../useRoomSurvey.ts';
import { useCountdown, useRetention, type Phase } from '../useRetention.ts';
import {
  PROBE_MS,
  bandWorthShowing,
  humanRate,
  humanSpan,
  rowsFrom,
  type Measurement,
  type Rate,
  type Row,
} from '../lib/retention.ts';
import { ROOM_RE } from '../lib/technocore.ts';
import { formatBytes } from '../lib/lens.ts';
import { num, plural, formatAge, formatUtc } from '../format.ts';

/**
 * Where "this is a big download" starts.
 *
 * Not a guess: the fifty rooms the survey lists run from 333 bytes to 10.4 MiB,
 * and the busy ones cluster between five and ten. A megabyte is where the wait
 * stops being instant on a normal connection, which is the point at which
 * somebody deserves to be asked first.
 */
const LARGE_EXPORT = 1024 * 1024;

/** Rooms offered in the picker. Any name may be typed instead. */
const SUGGEST_CAP = 12;

const QUESTIONS = [
  {
    q: 'Why has nobody measured this before?',
    a: (
      <p>
        Because the API gives you no cheap way to ask. The obvious probe would be to read one
        message and take <span className="mono">first_seq</span> off the reply — but that field is
        the first sequence number of the <em>batch</em> that came back, not the oldest the ring
        still holds, so asking for one message returns{' '}
        <span className="mono">first_seq == last_seq</span> and tells you nothing. The only
        endpoint that reveals the floor is <span className="mono">/export</span>, which sends the
        whole retained history, chunked, with no <span className="mono">content-length</span>. So
        the answer is exact and it costs several megabytes a room, and nothing in the API hints at
        either.
      </p>
    ),
  },
  {
    q: 'Is the number a constant?',
    a: (
      <p>
        No, and this is the one thing on the page worth being careful about. What a ring holds
        depends on how fast messages arrive, and that changes through the day — a room at twenty
        messages a second keeps half as much history as the same room at ten. Every figure here is
        stamped with the moment it was taken and none of them is a property of the room. Measure
        the same room twice an hour apart and the table will show you both, which is the only
        proof of this you can actually see.
      </p>
    ),
  },
  {
    q: 'Why does the export warning quote a number it then says is stale?',
    a: (
      <p>
        Because the two things are stale in different ways. On a quiet room the survey&rsquo;s{' '}
        <span className="mono">bytes</span> figure matched a real export to the byte — 187,004
        against 187,004 — which is why it is worth quoting at all. On{' '}
        <span className="mono">lobby</span>, taking twenty-six messages a second, the same figure
        came in about a fifth under and its <span className="mono">last_seq</span> was tens of
        thousands of messages behind. A ring that is not moving has a size the cache can keep up
        with; one that is does not. So the estimate is given as an estimate, and the page says how
        far behind the survey was on the room in front of you.
      </p>
    ),
  },
  {
    q: 'Sixteen days and twenty-five minutes on the same network?',
    a: (
      <p>
        Yes, and they do not mean the same thing.{' '}
        <span className="mono">d-technocore-radar</span> still holds its own first message — it has
        never dropped anything, so sixteen days is how old it is and says nothing about what it
        would keep under load. <span className="mono">lobby</span> has dropped tens of millions of
        messages and is holding about twenty-five minutes, which is a real horizon. The page marks
        which of the two you are looking at, because reading the first as a retention window is the
        worst mistake it could invite.
      </p>
    ),
  },
  {
    q: 'What can this page get wrong?',
    a: (
      <p>
        The export is a snapshot of a ring that kept moving while it was being read, so on a busy
        room the oldest message may already have been dropped by the time the download finishes —
        the figure is a few seconds old the moment it appears. Messages are dated by the
        server&rsquo;s own timestamp, which Foolscap repeats and does not vouch for. And a room
        whose traffic arrives in bursts has no single rate at all, so the projection beside the
        measurement is arithmetic on one ten-second window and is labelled as such.
      </p>
    ),
  },
  {
    q: 'Does measuring cost the network anything?',
    a: (
      <p>
        The probe is two reads of one message each, about a kilobyte. The export is the whole
        retained ring, which on a busy room is several megabytes and is why nothing is downloaded
        until you say so. Nothing is cached and nothing is stored: measure the same room twice and
        it is fetched twice, because a cached answer to this question would be exactly the kind of
        stale figure the page spends its time warning about.
      </p>
    ),
  },
];

export default function Retention() {
  const survey = useRoomSurvey();
  const [field, setField] = useState('');

  const byRoom = useMemo(() => {
    const map = new Map<string, { bytes: number; lastSeq: number }>();
    for (const entry of survey.rooms) map.set(entry.room, entry);
    return map;
  }, [survey.rooms]);

  const surveyFor = useCallback((room: string) => byRoom.get(room) ?? null, [byRoom]);
  const { phase, measurements, probe, confirm, cancel } = useRetention(surveyFor);

  const room = field.trim();
  const roomOk = ROOM_RE.test(room);
  const rows = useMemo(() => rowsFrom(measurements), [measurements]);
  const busy = phase.kind === 'probing' || phase.kind === 'exporting';

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (roomOk && !busy) probe(room);
  }

  return (
    <Shell page="retention" variant="console">
      <div className="console">
        <Panel title="Measure a room">
          <form className="rmeasure" onSubmit={onSubmit} autoComplete="off">
            <label className="rmeasure__label" htmlFor="room">
              A room name
            </label>
            <div className="rmeasure__row">
              <input
                className="rmeasure__input mono"
                id="room"
                name="room"
                type="text"
                inputMode="text"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="lobby"
                value={field}
                onChange={(event) => setField(event.target.value)}
              />
              <button className="rmeasure__submit" type="submit" disabled={!roomOk || busy}>
                {busy ? 'Measuring…' : 'Measure the rate'}
              </button>
            </div>
            <p className="rmeasure__hint">
              Two reads of the room&rsquo;s head, {PROBE_MS / 1000} seconds apart, about a kilobyte
              in total. That gives the rate. Nothing large is downloaded until you agree to it.
            </p>
          </form>

          <Suggestions
            survey={survey}
            onPick={(name) => {
              setField(name);
              if (!busy) probe(name);
            }}
            disabled={busy}
          />
        </Panel>

        <div className="rresult" aria-live="polite">
          <Result phase={phase} confirm={confirm} cancel={cancel} surveyFor={surveyFor} />
        </div>

        <Panel
          title="Rooms measured this session"
          flush
          action={rows.length > 0 ? <span className="rtable__count">{plural(rows.length, 'room')}</span> : null}
        >
          <Table rows={rows} />
        </Panel>

        <Panel title="Why this is not already known">
          <p className="rwhy">
            Two facts about the API, and between them they are the whole reason this number is not
            on anybody&rsquo;s dashboard.
          </p>
          <ol className="rwhy__list">
            <li>
              <strong>
                <span className="mono">first_seq</span> on a read is batch-scoped.
              </strong>{' '}
              It is the first sequence number of the batch that came back, not the oldest the ring
              still holds. Ask for one message and it equals{' '}
              <span className="mono">last_seq</span>; ask for two hundred and it equals{' '}
              <span className="mono">last_seq - 199</span>. There is no endpoint that reports the
              floor, so no cheap probe can tell you how far back a room goes.
            </li>
            <li>
              <strong>
                <span className="mono">/export</span> sends no{' '}
                <span className="mono">content-length</span>.
              </strong>{' '}
              It is chunked, so the size of a room&rsquo;s retained history cannot be known until
              all of it has arrived. On the busiest rooms that is eight to ten megabytes for one
              answer.
            </li>
          </ol>
          <p className="rwhy">
            The survey at <span className="mono">/rooms</span> gets you close — its{' '}
            <span className="mono">bytes</span> figure matched an export exactly when this was
            checked — but it is a snapshot the edge holds for up to a day, so it can be hours
            behind on everything that moves. It is used here for the estimate in the warning and
            for nothing else.
          </p>
        </Panel>

        <Questions title="How long does a room actually remember?" items={QUESTIONS} />
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Picking a room
// ---------------------------------------------------------------------------

/**
 * The survey's busiest rooms, as a shortcut.
 *
 * Both extremes are pinned to the front when the survey has them, because the
 * page's whole argument is the spread and a visitor who measures two busy rooms
 * in a row will not see it. The rest are the survey's own order.
 */
function Suggestions({
  survey,
  onPick,
  disabled,
}: {
  survey: ReturnType<typeof useRoomSurvey>;
  onPick: (room: string) => void;
  disabled: boolean;
}) {
  if (survey.loading) {
    return <p className="rsuggest__note">Reading the room survey…</p>;
  }
  if (survey.error) {
    return (
      <p className="rsuggest__note rsuggest__note--warn">
        The room survey could not be read, so there is nothing to suggest — {survey.error}. Typing
        a room name still works; the only thing lost is the size estimate before an export.
      </p>
    );
  }
  if (survey.rooms.length === 0) {
    return <p className="rsuggest__note">The survey listed no rooms.</p>;
  }

  const bySize = [...survey.rooms].sort((a, b) => a.bytes - b.bytes);
  const smallest = bySize[0];
  const largest = bySize[bySize.length - 1];
  const rest = survey.rooms.filter((entry) => entry !== smallest && entry !== largest);
  const shown = [largest, smallest, ...rest].slice(0, SUGGEST_CAP);

  return (
    <div className="rsuggest">
      <p className="rsuggest__label">
        From the survey, largest and smallest first — the spread is the point
      </p>
      <ul className="rsuggest__list">
        {shown.map((entry) => (
          <li key={entry.room}>
            <button
              className="rsuggest__item"
              type="button"
              disabled={disabled}
              onClick={() => onPick(entry.room)}
            >
              <span className="mono">{entry.room}</span>
              <span className="rsuggest__size">{formatBytes(entry.bytes)}</span>
            </button>
          </li>
        ))}
      </ul>
      <CapNotice
        shown={shown.length}
        total={survey.total ?? survey.rooms.length}
        noun="rooms"
        how="The survey lists only the busiest fifty; any room name can be typed into the field above."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The result, in all six states
// ---------------------------------------------------------------------------

function Result({
  phase,
  confirm,
  cancel,
  surveyFor,
}: {
  phase: Phase;
  confirm: () => void;
  cancel: () => void;
  surveyFor: (room: string) => { bytes: number; lastSeq: number } | null;
}) {
  if (phase.kind === 'idle') {
    return (
      <Panel title="The answer">
        <PaneState
          state="empty"
          title="Nothing measured yet."
          detail={
            <>
              Pick a room above, or type one. The first step reads its head twice and costs about a
              kilobyte; you will be told what the second step costs before it runs.
            </>
          }
        />
      </Panel>
    );
  }

  if (phase.kind === 'probing') {
    return (
      <Panel title="The answer">
        <Probing phase={phase} cancel={cancel} />
      </Panel>
    );
  }

  if (phase.kind === 'probed') {
    return (
      <Panel title="The answer">
        <Probed phase={phase} confirm={confirm} cancel={cancel} estimate={surveyFor(phase.room)} />
      </Panel>
    );
  }

  if (phase.kind === 'exporting') {
    const estimate = surveyFor(phase.room);
    return (
      <Panel title="The answer">
        <PaneState
          state="loading"
          title={
            estimate && phase.bytes <= estimate.bytes
              ? `Downloading ${phase.room} — ${formatBytes(phase.bytes)} of about ${formatBytes(
                  estimate.bytes
                )}`
              : `Downloading ${phase.room} — ${formatBytes(phase.bytes)} so far`
          }
        />
        <p className="rprogress__note">
          {!estimate ? (
            'This room is not in the survey’s fifty, so there is no estimate at all and no content-length to fall back on. It is done when it stops.'
          ) : phase.bytes > estimate.bytes ? (
            <>
              Past the survey&rsquo;s estimate of {formatBytes(estimate.bytes)}, which is the
              survey being stale rather than anything going wrong — the ring has taken messages
              since that snapshot was cached. There is no{' '}
              <span className="mono">content-length</span> to count down from, so it is done when
              it stops.
            </>
          ) : (
            <>
              The total is the survey&rsquo;s figure and not a{' '}
              <span className="mono">content-length</span> — there is not one. It is a cached
              snapshot, so it can run under on a room that has been busy since.
            </>
          )}
        </p>
        <p className="rprogress__cancel">
          <button className="rbutton rbutton--quiet" type="button" onClick={cancel}>
            Stop the download
          </button>
        </p>
      </Panel>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <Panel title="The answer">
        <PaneState
          state="failed"
          title={
            phase.at === 'probe'
              ? `${phase.room} could not be read.`
              : `The export of ${phase.room} did not finish.`
          }
          detail={
            <>
              {phase.error} Nothing is reported from a partial read — a span measured over half a
              dump would be a number that looks exactly like a real one.
            </>
          }
          action={
            <button className="rbutton" type="button" onClick={cancel}>
              Start again
            </button>
          }
        />
      </Panel>
    );
  }

  return <Answer measurement={phase.measurement} />;
}

function Probing({
  phase,
  cancel,
}: {
  phase: Extract<Phase, { kind: 'probing' }>;
  cancel: () => void;
}) {
  const left = useCountdown(phase.first ? phase.endsAt : null);

  return (
    <>
      <PaneState
        state="loading"
        title={
          phase.first
            ? `Reading ${phase.room} again in ${Math.ceil(left / 1000)}s`
            : `Reading ${phase.room}…`
        }
      />
      {phase.first && (
        <p className="rprogress__note">
          First reading: <span className="mono">last_seq {num.format(phase.first.lastSeq)}</span>.
          The rate is the difference between that and the next one, over the time between them —
          which is why it has to wait rather than ask.
        </p>
      )}
      <p className="rprogress__cancel">
        <button className="rbutton rbutton--quiet" type="button" onClick={cancel}>
          Stop
        </button>
      </p>
    </>
  );
}

/** The stop in the middle: the rate is in, the download has not started. */
function Probed({
  phase,
  confirm,
  cancel,
  estimate,
}: {
  phase: Extract<Phase, { kind: 'probed' }>;
  confirm: () => void;
  cancel: () => void;
  estimate: { bytes: number; lastSeq: number } | null;
}) {
  const behind = estimate ? Math.max(0, phase.lastSeq - estimate.lastSeq) : null;
  const large = estimate != null && estimate.bytes >= LARGE_EXPORT;

  return (
    <div className="rprobed">
      <p className="rprobed__eyebrow">Step one of two · {phase.room}</p>

      {phase.rate ? (
        <RateReading rate={phase.rate} />
      ) : (
        <p className="rprobed__problem">
          No rate: {phase.problem?.detail ?? 'the two readings could not be compared.'} The export
          below will still measure what the room is holding — only the forward-looking projection
          is lost.
        </p>
      )}

      <p className="rprobed__seq">
        The room&rsquo;s true <span className="mono">last_seq</span> is{' '}
        <span className="mono">{num.format(phase.lastSeq)}</span> — every message it has ever
        carried.
        {behind != null && behind > 0 && (
          <>
            {' '}
            The survey says <span className="mono">{num.format(estimate!.lastSeq)}</span>, so it is{' '}
            <strong>{plural(behind, 'message')} behind</strong> right now. That is the same survey
            the size estimate below comes from.
          </>
        )}
      </p>

      <div className={large ? 'rwarn rwarn--large' : 'rwarn'}>
        <p className="rwarn__title">
          {estimate
            ? `The next step downloads about ${formatBytes(estimate.bytes)}.`
            : 'The next step downloads an unknown amount.'}
        </p>
        <p className="rwarn__body">
          {estimate ? (
            <>
              That is the survey&rsquo;s <span className="mono">bytes</span> figure for this ring,
              and it is an estimate rather than a promise: on a quiet room it has matched an
              export to the byte, and on a busy one it has come in around a fifth under, because
              the survey is a cached snapshot and the ring has grown since. There is no{' '}
              <span className="mono">content-length</span> on <span className="mono">/export</span>{' '}
              to confirm it against, so the true size is not known until the last chunk lands.
            </>
          ) : (
            <>
              This room is not among the fifty the survey lists, so there is no estimate to give
              you, and <span className="mono">/export</span> sends no{' '}
              <span className="mono">content-length</span>. It could be a few hundred bytes or ten
              megabytes.
            </>
          )}{' '}
          Downloading it is the only way to learn the span — there is no endpoint that will tell
          you where the ring starts.
        </p>
        <div className="rwarn__act">
          <button className="rbutton" type="button" onClick={confirm}>
            {estimate ? `Export ${formatBytes(estimate.bytes)} and measure` : 'Export and measure'}
          </button>
          <button className="rbutton rbutton--quiet" type="button" onClick={cancel}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

function RateReading({ rate }: { rate: Rate }) {
  if (rate.belowOne) {
    return (
      <p className="rprobed__rate">
        <span className="rprobed__figure">Under {humanRate(rate.hi)}</span>
        <span className="rprobed__detail">
          Nothing arrived in {(rate.elapsedMs / 1000).toFixed(1)} seconds. That is a ceiling, not a
          reading — a room this quiet needs a longer window before anyone says a number about it.
        </span>
      </p>
    );
  }

  return (
    <p className="rprobed__rate">
      <span className="rprobed__figure">{humanRate(rate.perSecond)}</span>
      <span className="rprobed__detail">
        {plural(rate.delta, 'message')} in {(rate.elapsedMs / 1000).toFixed(1)} seconds
        {bandWorthShowing(rate) && (
          <>
            , which at this count is {humanRate(rate.lo)} to {humanRate(rate.hi)} once you allow
            for where the window&rsquo;s edges fell
          </>
        )}
        .
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

function Answer({ measurement }: { measurement: Measurement }) {
  const { span, verdict } = measurement;
  const headline = humanSpan(measurement.seconds);

  return (
    <Panel title="The answer">
      <div className="ranswer">
        {verdict === 'empty' ? (
          <p className="ranswer__unreadable">
            <span className="mono">{measurement.room}</span> is holding nothing at all. Either
            nothing has ever been posted to it, or everything that was has already gone —
            Technocore deletes a room left on a single message after twelve hours, and an
            unwritten name reads exactly the same as a reclaimed one. Nothing here can tell those
            two apart, and a room with no messages has no span to measure.
          </p>
        ) : verdict === 'unreadable' ? (
          <p className="ranswer__unreadable">
            It is holding {plural(span.count, 'message')} and {formatBytes(span.bytes)}, and not one
            of them carries a timestamp this browser can read — so there is no span to report. That
            is a fact about what is in <span className="mono">{measurement.room}</span> rather than
            about how long it keeps things.
          </p>
        ) : (
          <>
            {/* The one --t-answer on the page. */}
            <p className="ranswer__headline">
              <span className="mono ranswer__room">{measurement.room}</span>
              <span className="ranswer__verb">
                {verdict === 'horizon' ? 'remembers' : 'holds'}
              </span>
              <span className="ranswer__span">{headline}</span>
            </p>

            {verdict === 'horizon' && barelyTrimmed(span) ? (
              /* IT HAS DROPPED SOMETHING, AND HARDLY ANYTHING. A room that has
                 lost one message of 1,822 has technically reached its horizon
                 and is nowhere near settled at it — calling that "what it holds
                 is what it keeps" would be true of the mechanism and wrong about
                 the room. The verdict stays what it is; the sentence does not
                 overclaim on top of it. */
              <p className="ranswer__basis">
                It has dropped <strong>{plural(span.forgotten ?? 0, 'message')}</strong> of the{' '}
                {num.format(span.lastSeq)} it has carried — it has only just begun to forget, so{' '}
                {headline} is still very nearly its whole life rather than a horizon it has
                settled at. Watch this figure stop growing to know it has found its limit.
              </p>
            ) : verdict === 'horizon' ? (
              <p className="ranswer__basis">
                It has dropped <strong>{plural(span.forgotten ?? 0, 'message')}</strong>, so this is
                a real horizon: what it holds now is what it keeps, and the oldest thing in it is{' '}
                {headline} old.
              </p>
            ) : (
              <p className="ranswer__basis ranswer__basis--caveat">
                <strong>This is not a retention window.</strong> The room still holds its own first
                message — <span className="mono">first_seq 1</span> — so it has never dropped
                anything, and {headline} is how old it is rather than how much it would keep. Its
                horizon has not been reached and cannot be measured until it is.
              </p>
            )}
          </>
        )}

        {/* THE HEADLINE AND THE SPAN ARE DIFFERENT NUMBERS and on a room that
            has gone quiet they visibly disagree, which reads as a bug unless
            the page says why. The headline is how far back the room can see —
            now minus the oldest thing in it. The span is the window of traffic
            it holds — newest minus oldest. The gap between them is exactly how
            long nothing has arrived. */}
        {idleGap(span) && (
          <p className="ranswer__idle">
            Nothing has arrived for {idleGap(span)}, which is the whole of the difference between
            the {headline} it reaches back and the {humanSpan(span.spanSeconds)} of traffic it is
            holding.
          </p>
        )}

        <ul className="rfacts">
          <Fact label="Reaches back" value={headline ?? '—'} note="now minus the oldest message held" />
          <Fact label="Retained span" value={humanSpan(span.spanSeconds) ?? '—'} note="newest held minus oldest held" />
          <Fact label="Messages held" value={num.format(span.count)} note={span.forgotten ? `of ${num.format(span.lastSeq)} ever carried` : 'every one it has carried'} />
          <Fact label="Bytes" value={formatBytes(span.bytes) ?? '—'} note={`${num.format(span.bytes)} exactly, counted as they landed`} />
          <Fact
            label="Bytes per message"
            value={span.bytesPerMessage != null ? `${Math.round(span.bytesPerMessage)} B` : '—'}
            note="the dump divided by what parsed out of it"
          />
          <Fact
            label="Rate, measured"
            value={measurement.rate && !measurement.rate.belowOne ? humanRate(measurement.rate.perSecond)! : '—'}
            note={measurement.rate?.belowOne ? 'nothing arrived in the window' : 'two head reads, just now'}
          />
          <Fact
            label="Rate, historical"
            value={humanRate(span.historicalPerSecond) ?? '—'}
            note="averaged over everything it is holding"
          />
        </ul>

        {measurement.projectedSeconds != null && (
          <p className="rproject">
            <strong>At the rate measured just now</strong>, {num.format(span.count)} messages is{' '}
            {humanSpan(measurement.projectedSeconds)} of traffic — against the{' '}
            {humanSpan(span.spanSeconds)} it is actually holding.{' '}
            {describeDrift(measurement.projectedSeconds, span.spanSeconds)}
          </p>
        )}

        {span.malformed > 0 && (
          <p className="ranswer__note">
            {plural(span.malformed, 'line')} in the dump did not parse and {span.malformed === 1 ? 'was' : 'were'} left out of the count.
          </p>
        )}
        {span.undated > 0 && (
          <p className="ranswer__note">
            {plural(span.undated, 'message')} carried no readable timestamp. {span.undated === 1 ? 'It is' : 'They are'} counted, but {span.undated === 1 ? 'it' : 'they'} cannot date anything.
          </p>
        )}
        {span.truncated && (
          <p className="ranswer__note">
            The dump was cut mid-record. That line was dropped rather than half-parsed, so the
            count is one short of what the ring holds.
          </p>
        )}

        <p className="ranswer__stamp">
          Measured {formatUtc(measurement.at)} · {formatAge(Date.now() - measurement.at)} ago. A
          snapshot of a ring that kept moving while it was being read, and a reading of a rate that
          changes through the day. Not a property of the room.
        </p>
      </div>
    </Panel>
  );
}

/**
 * Dropped something, but barely.
 *
 * One message in eighteen hundred is a ring that has only just started to spill,
 * not one sitting at its limit. The distinction is a matter of degree rather
 * than of kind, so it changes the sentence rather than the verdict.
 */
function barelyTrimmed(span: Measurement['span']): boolean {
  if (!span.forgotten || !span.lastSeq) return false;
  return span.forgotten / span.lastSeq < 0.01;
}

/**
 * How long nothing has arrived, where that is long enough to explain a gap.
 *
 * Under a twentieth of the span it is the read's own latency and not worth a
 * sentence; above that it is the reason the two headline-adjacent figures do not
 * match, and an unexplained mismatch between two numbers on the same screen is
 * how a reader decides a page is broken.
 */
function idleGap(span: Measurement['span']): string | null {
  if (span.reachSeconds == null || span.spanSeconds == null) return null;
  const idle = span.reachSeconds - span.spanSeconds;
  if (idle <= 0 || idle < span.spanSeconds * 0.05) return null;
  return humanSpan(idle);
}

/** Whether the room is forgetting faster or slower than it has been. */
function describeDrift(projected: number, observed: number | null): string {
  if (observed == null || observed <= 0) return '';
  const ratio = projected / observed;
  if (ratio < 0.8) {
    return 'It is taking messages faster than the average across what it holds, so its memory is shrinking.';
  }
  if (ratio > 1.25) {
    return 'It is quieter now than the average across what it holds, so its memory is lengthening.';
  }
  return 'Close enough to agree: the room is taking messages at about the rate it has been.';
}

function Fact({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <li className="rfact">
      <span className="rfact__label">{label}</span>
      <span className="rfact__value">{value}</span>
      <span className="rfact__note">{note}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

function Table({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return (
      <PaneState
        state="empty"
        title="No rooms measured yet."
        detail="Every room you measure lands here, ranked by how far back it can still see. Two rooms is enough to show the spread; the interesting part is how far apart they are."
      />
    );
  }

  return (
    <>
      {rows.length === 1 && (
        <p className="rtable__lede">
          One room is a reading, not a comparison. Measure a second — a quiet one, if the first was
          busy — and the range on this network is four orders of magnitude wide.
        </p>
      )}
      <div className="rtable__scroll">
        <table className="rtable">
          <thead>
            <tr>
              <th scope="col">Room</th>
              <th scope="col">Remembers</th>
              <th scope="col" className="rtable__n">Messages</th>
              <th scope="col" className="rtable__n">Rate</th>
              <th scope="col" className="rtable__n">B/msg</th>
              <th scope="col">Measured</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <TableRow key={row.latest.room} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="rtable__foot">
        Ranked by how far back each room can still see. A row is a reading taken at the moment in
        its last column and nothing more — the rate that produced it changes through the day, so
        none of these is a property of the room it names.
      </p>
    </>
  );
}

function TableRow({ row }: { row: Row }) {
  const m = row.latest;
  const { span } = m;

  return (
    <>
      <tr className="rtable__row">
        <th scope="row" className="mono rtable__room">
          {m.room}
          {m.verdict === 'whole-life' && (
            <span className="rtable__tag" title="first_seq 1 — this room has never dropped a message, so its span is its age">
              never trimmed
            </span>
          )}
        </th>
        <td className="rtable__span">{humanSpan(m.seconds) ?? '—'}</td>
        <td className="rtable__n">{num.format(span.count)}</td>
        <td className="rtable__n">
          {m.rate && !m.rate.belowOne ? humanRate(m.rate.perSecond) : m.rate ? 'under 1' : '—'}
        </td>
        <td className="rtable__n">
          {span.bytesPerMessage != null ? Math.round(span.bytesPerMessage) : '—'}
        </td>
        <td className="rtable__when">
          <time dateTime={new Date(m.at).toISOString()}>{formatUtc(m.at)}</time>
        </td>
      </tr>
      {row.earlier.length > 0 && (
        <tr className="rtable__history">
          <td colSpan={6}>
            Measured {row.earlier.length + 1} times this visit:{' '}
            {[...row.earlier]
              .reverse()
              .map((earlier) => humanSpan(earlier.seconds) ?? '—')
              .concat(humanSpan(m.seconds) ?? '—')
              .join(' → ')}
            . The room did not change; what it is holding did.
          </td>
        </tr>
      )}
    </>
  );
}
