// Lens.tsx — who actually said what in this room.
//
// Two panes. Left, a way of getting to a room. Right, the room, with every
// signature in it recomputed in this browser against the key it names.
//
// ---------------------------------------------------------------------------
// THE THREE STATES ARE DRAWN AS ONE THING: a 2px rule down the left edge of
// each message. Quiet grey for verified, quieter for unsigned, --alarm for a
// proof that did not hold. A column of grey rules with one red one in it is
// readable at arm's length; a row of little coloured pills is not, and pills
// would make the common case look like a warning.
//
// MOST TRAFFIC IS UNSIGNED and that is not a finding. The page says so where a
// reader will meet it rather than in a footnote, because a tool that renders
// "unsigned" in the same register as "failed" teaches people to distrust the
// wrong thing. What unsigned means is only this: `from` is a name somebody
// typed, not a claim anyone can check.
//
// A DID IS TRUNCATED IN THE HEAD AND NEVER WHERE IT IS THE EVIDENCE. On a
// message that failed, the key and the signature are printed in full — a reader
// who has to hover to find out which key failed cannot check anything.
//
// Lens reads. It has no write path, takes no key, and posts nothing.

import { useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { formatAge, num, plural } from '../format.ts';
import { ROOMS, WATCHED_ROOMS } from '../lib/contest.ts';
import { formatBytes, matchRooms, type Reading } from '../lib/lens.ts';
import type { Message } from '../lib/technocore.ts';
import { useLens, useRoomSurvey, KEEP } from '../useLens.ts';

/** Rooms Foolscap already knows by name, offered before the survey lands. */
const KNOWN = [...new Set([...WATCHED_ROOMS, ROOMS.campaign, 'lobby', 'technocore', 'meta'])];

const clock = (ms: number) =>
  Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : '--:--:--';

export default function Lens() {
  const [room, setRoom] = useState<string>(ROOMS.registration);
  const [query, setQuery] = useState('');
  const [failuresOnly, setFailuresOnly] = useState(false);
  const survey = useRoomSurvey();
  const feed = useLens(room);

  // The survey's busiest, plus the rooms Foolscap knows by name that the survey
  // does not list — the contest rooms are not among the busiest fifty of forty
  // thousand, and a room list without them would be useless here.
  const rooms = useMemo(() => {
    const seen = new Map<string, { room: string; bytes: number | null }>();
    for (const name of KNOWN) seen.set(name, { room: name, bytes: null });
    for (const entry of survey.rooms) seen.set(entry.room, { room: entry.room, bytes: entry.bytes });
    return matchRooms(query, [...seen.values()]);
  }, [survey.rooms, query]);

  const shown = failuresOnly ? feed.failures : feed.messages;

  return (
    <Shell page="lens">
      <div className="lens">
        <aside className="rooms" aria-label="Rooms">
          <input
            className="rooms__search"
            type="search"
            value={query}
            placeholder="Search rooms, or type any name"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Search rooms"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // A room you can name is a room you can read, listed or not.
              if (e.key === 'Enter' && query.trim()) setRoom(query.trim());
            }}
          />

          <ul className="rooms__list">
            {rooms.map((entry) => (
              <li key={entry.room}>
                <button
                  className="rooms__row"
                  type="button"
                  aria-current={entry.room === room ? 'true' : undefined}
                  onClick={() => setRoom(entry.room)}
                >
                  <span className="rooms__name">{entry.room}</span>
                  <span className="rooms__size">{formatBytes(entry.bytes) ?? '—'}</span>
                </button>
              </li>
            ))}
            {rooms.length === 0 && (
              <li>
                <p className="rooms__caveat">
                  No listed room matches. Press Enter to read “{query.trim()}” anyway — any name
                  is readable whether or not the survey lists it.
                </p>
              </li>
            )}
          </ul>

          {/* The City's caveat, in the City's words. The survey is a map. */}
          <p className="rooms__caveat">
            The sizes come from one request that returns the busiest{' '}
            {survey.rooms.length ? num.format(survey.rooms.length) : 'few dozen'} rooms
            {survey.total ? ` of ${num.format(survey.total)}` : ''}. The server caches it hard —
            up to a day at the edge — and it carries no timestamp. It is a map of what exists and
            how big it is, never a live reading, and nothing about the messages themselves is
            derived from it.
          </p>
        </aside>

        <section className="reading" aria-label={`Messages in ${room}`}>
          <header className="reading__head">
            <h1 className="reading__room">{room}</h1>
            <p className="reading__facts">
              <span>
                <span className="reading__verified">{num.format(feed.counts.verified)}</span> of{' '}
                {num.format(feed.counts.read)} verified
              </span>
              <span>{num.format(feed.counts.unsigned)} unsigned</span>
              <span className={feed.counts.failed > 0 ? 'reading__failed' : undefined}>
                {num.format(feed.counts.failed)} failed
              </span>
              {feed.window.firstSeq != null && (
                <span>
                  seq {num.format(feed.window.firstSeq)}–{num.format(feed.window.lastSeq ?? 0)}
                </span>
              )}
              {feed.window.spanMs != null && feed.window.spanMs > 0 && (
                <span>{formatAge(feed.window.spanMs)} of ring</span>
              )}
              <span>{feed.status}</span>
            </p>

            <div className="reading__controls">
              <button
                className="lbutton"
                type="button"
                aria-pressed={failuresOnly}
                onClick={() => setFailuresOnly((v) => !v)}
              >
                {failuresOnly ? 'Showing failures only' : `Failures only (${feed.counts.failed})`}
              </button>
              {feed.messages.length >= KEEP && !failuresOnly && (
                <span className="rooms__caveat">
                  Showing the newest {num.format(KEEP)}. Every message read was checked and
                  counted above, and a failure is kept whatever happens to the list.
                </span>
              )}
            </div>
          </header>

          {feed.error && <p className="lgap">{feed.error}</p>}

          {feed.gaps.map((gap, i) => (
            <p className="lgap" key={`${gap.kind}-${i}`}>
              {gap.kind === 'rotated'
                ? `The ring had already dropped its oldest lines when Foolscap arrived: it starts at seq ${num.format(gap.firstSeq ?? 0)}. Nothing is wrong — it bounds what can be shown, and nothing can be said about what went before.`
                : `${plural(gap.missing ?? 0, 'message')} rotated out of this room while Foolscap was following it. They are absent, not unverified: nothing at all can be said about them.`}
            </p>
          ))}

          {shown.length === 0 ? (
            <p className="lempty">
              {failuresOnly
                ? 'No signature in what has been read failed to verify.'
                : feed.status === 'starting' || feed.status === 'backfilling'
                  ? 'Reading the room…'
                  : 'Nothing in the retained ring. The room may be empty, or everything in it may have rotated out.'}
            </p>
          ) : (
            <ul className="reading__list">
              {shown.map((message) => (
                <Row
                  key={message.seq}
                  message={message}
                  reading={feed.readings.get(message.seq) ?? null}
                />
              ))}
            </ul>
          )}

          <p className="lnote">
            Every signature above was checked here, in this browser, against the key the message
            names — nothing was taken from a server. Lens only reads: it has no write path and
            asks for no key. To sign and post something, use the Bench.
          </p>
        </section>
      </div>
    </Shell>
  );
}

function Row({ message, reading }: { message: Message; reading: Reading | null }) {
  const verdict = reading?.verdict ?? 'checking';
  const from = message.from ?? '(no name)';
  const failed = verdict === 'failed';

  return (
    <li className="msg" data-verdict={verdict}>
      <p className="msg__head">
        <span className="msg__seq">#{message.seq}</span>
        <span className="msg__time">{clock(message.tsMs)}</span>
        {/* Truncated here, whole value on hover — and printed in full below
            wherever it is the thing being checked. */}
        <span
          className={`msg__from${reading?.claimsKey ? ' msg__from--key' : ''}`}
          title={from}
        >
          {from}
        </span>
        <span className="msg__state">
          {verdict === 'checking' ? 'checking' : verdict === 'verified' ? 'verified' : verdict}
        </span>
      </p>

      <p className="msg__text">{message.text}</p>

      {reading?.note && <p className="msg__note">{reading.note}</p>}

      {failed && (
        <div className="msg__proof">
          <span>did: {from}</span>
          <span>nonce: {message.nonce ?? '(none)'}</span>
          <span>sig: {message.sig ?? '(none)'}</span>
        </div>
      )}
    </li>
  );
}
