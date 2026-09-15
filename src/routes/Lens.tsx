// Lens.tsx — who actually said what in this room.
//
// Pattern A, the split: a 320px list beside a detail pane, both in panels, both
// scrolling independently. DESIGN.md's note on the old version was that the
// room list "is the page's primary navigation and currently isn't treated as
// navigation at all" — it was a column of text above another column of text.
//
// ---------------------------------------------------------------------------
// THE THREE STATES ARE DRAWN AS ONE THING: a 2px rule down each message's left
// edge. Grey for verified, quieter for unsigned, --alarm for a proof that did
// not hold. A column of grey rules with one red one is readable at arm's
// length; a row of coloured pills is not, and pills would put the common case
// in the same register as the alarming one.
//
// MOST TRAFFIC IS UNSIGNED and that is not a finding. `from` is a name somebody
// typed, not a claim anyone can check, and the page says so where a reader
// meets it rather than in a footnote.
//
// NOTHING IS SELECTED ON ARRIVAL, which DESIGN.md asks for and which is also
// the honest opening: this page reads whatever room you name, so the first
// screen is the question plus a few ways in, not an arbitrary room chosen for
// you and quietly presented as the default view of the network.
//
// Lens reads. No write path, no key, nothing posted.

import { useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { Panel, PaneState, CapNotice } from '../components/Panel';
import { Questions } from '../components/Questions';
import { formatAge, num, plural } from '../format.ts';
import { ROOMS, WATCHED_ROOMS } from '../lib/contest.ts';
import { formatBytes, matchRooms, type Reading } from '../lib/lens.ts';
import type { Message } from '../lib/technocore.ts';
import { useLens, useRoomSurvey } from '../useLens.ts';

/** Rooms Foolscap knows by name, offered before the survey lands. */
const KNOWN = [...new Set([...WATCHED_ROOMS, ROOMS.campaign, 'lobby', 'technocore', 'meta'])];

/** Offered on the empty pane. Three, as DESIGN.md asks. */
const SUGGESTED = [ROOMS.registration, 'lobby', ROOMS.rules];

/** The room list is capped: the survey returns fifty and KNOWN adds a few. */
const ROOM_CAP = 60;

const clock = (ms: number) =>
  Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : '--:--:--';

export default function Lens() {
  const [room, setRoom] = useState<string | null>(null);
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

  const shownRooms = rooms.slice(0, ROOM_CAP);
  const shown = failuresOnly ? feed.failures : feed.messages;

  return (
    <Shell page="lens">
      <div className="split">
        <aside className="split__aside">
          <Panel
            flush
            scroll
            title="Rooms"
            action={
              <input
                className="rsearch"
                type="search"
                value={query}
                placeholder="Search, or type any name"
                aria-label="Search rooms"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // A room you can name is a room you can read, listed or not.
                  if (e.key === 'Enter' && query.trim()) setRoom(query.trim());
                }}
              />
            }
          >
            {survey.loading && rooms.length === 0 ? (
              <PaneState state="loading" title="Reading the room survey…" />
            ) : survey.error && rooms.length === 0 ? (
              <PaneState
                state="failed"
                title="The survey could not be read."
                detail={`${survey.error} The rooms Foolscap knows by name are still readable — type one above.`}
              />
            ) : shownRooms.length === 0 ? (
              <PaneState
                state="empty"
                title="No listed room matches."
                detail={
                  <>
                    Press Enter to read “{query.trim()}” anyway. Any room is readable whether or
                    not the survey lists it.
                  </>
                }
              />
            ) : (
              <>
                <ul className="rooms2">
                  {shownRooms.map((entry) => (
                    <li key={entry.room}>
                      <button
                        className="rooms2__row"
                        type="button"
                        aria-current={entry.room === room ? 'true' : undefined}
                        onClick={() => setRoom(entry.room)}
                      >
                        <span className="rooms2__name">{entry.room}</span>
                        <span className="rooms2__size">{formatBytes(entry.bytes) ?? '—'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <CapNotice
                  shown={shownRooms.length}
                  total={rooms.length}
                  noun="rooms"
                  how="Searching covers all of them."
                />
              </>
            )}
          </Panel>

          {/* CUT AT THE CRITIQUE STEP: this was the City's full survey caveat, five
              lines of grey prose directly under the list, competing with the one
              thing on this page worth looking at. The caveat itself is not
              optional — the sizes above are from a cached snapshot — so it moved
              into the questions below, which is what that block is for, and what
              stays here is the one line that stops the figures being misread. */}
          <p className="lnote">
            Sizes come from a cached survey: a map of what exists, never a live reading.
          </p>
        </aside>

        <div className="split__main">
          <Panel
            flush
            title={room ? <span className="rhead__room">{room}</span> : 'Messages'}
            action={
              room ? (
                <button
                  className="lbutton"
                  type="button"
                  aria-pressed={failuresOnly}
                  onClick={() => setFailuresOnly((v) => !v)}
                >
                  {failuresOnly ? 'Showing failures' : `Failures only (${feed.counts.failed})`}
                </button>
              ) : undefined
            }
          >
            {!room ? (
              // The first thing a visitor sees, so it is a real state: the
              // question the page answers, and three ways in.
              <PaneState
                state="empty"
                title="Every message in a room, checked against its own signature."
                detail="Pick a room on the left, search for one, or type any name — Foolscap reads whatever you name, listed or not. Nothing here is taken from a server's word for it: each signature is recomputed in this browser."
                action={SUGGESTED.map((name) => (
                  <button className="lbutton" type="button" key={name} onClick={() => setRoom(name)}>
                    {name}
                  </button>
                ))}
              />
            ) : (
              <>
                <RoomFacts feed={feed} />

                {feed.error && (
                  <PaneState
                    state="failed"
                    title="That room could not be read."
                    detail={`${feed.error} Foolscap keeps trying; anything already read is still below.`}
                  />
                )}

                {feed.gaps.map((gap, i) => (
                  <p className="lgap" key={`${gap.kind}-${i}`}>
                    {gap.kind === 'rotated'
                      ? `The ring had already dropped its oldest lines when Foolscap arrived: it starts at seq ${num.format(gap.firstSeq ?? 0)}. Nothing is wrong — it bounds what can be shown, and nothing can be said about what went before.`
                      : `${plural(gap.missing ?? 0, 'message')} rotated out while Foolscap was following this room. They are absent, not unverified: nothing at all can be said about them.`}
                  </p>
                ))}

                {shown.length === 0 ? (
                  failuresOnly ? (
                    <PaneState
                      state="empty"
                      title="No signature here failed to verify."
                      detail="Every proof in what has been read so far folded to the key that made it."
                      action={
                        <button className="lbutton" type="button" onClick={() => setFailuresOnly(false)}>
                          Show everything
                        </button>
                      }
                    />
                  ) : feed.status === 'starting' || feed.status === 'backfilling' ? (
                    <PaneState state="loading" title={`Reading ${room}…`} />
                  ) : (
                    <PaneState
                      state="empty"
                      title="Nothing in the retained ring."
                      detail="The room may be empty, or everything in it may have rotated out — those look identical from here."
                    />
                  )
                ) : (
                  <>
                    <ul className="msgs">
                      {shown.map((message) => (
                        <li key={message.seq}>
                          <Row
                            message={message}
                            reading={feed.readings.get(message.seq) ?? null}
                          />
                        </li>
                      ))}
                    </ul>
                    {!failuresOnly && (
                      <CapNotice
                        shown={feed.messages.length}
                        total={feed.seen}
                        noun="messages"
                        how="Every message read was checked and counted above, and a failure is kept whatever happens to the list."
                      />
                    )}
                  </>
                )}
              </>
            )}
          </Panel>
        </div>
      </div>

      <div className="lens__tail">
        <p className="lnote">
          Every signature above was checked here, in this browser, against the key the message
          names — nothing was taken from a server. Lens only reads: it has no write path and asks
          for no key. To sign and post something, use the Bench.
        </p>

        <Questions
          title="Who actually said what in this room?"
          items={[
            {
              q: 'What does “verified” actually mean here?',
              a: (
                <p>
                  That the signature on the message folds to the did:key in its{' '}
                  <span className="mono">from</span> field, over the exact string{' '}
                  <span className="mono">room|nonce|text</span> the room stores. Your browser did
                  that arithmetic, not a server. It proves that key wrote those bytes — and
                  nothing else: not who holds the key, not that they are honest.
                </p>
              ),
            },
            {
              q: 'Most messages say “unsigned”. Is something wrong?',
              a: (
                <p>
                  No. Technocore does not require a signature and most traffic carries none, so
                  unsigned is the ordinary case rather than a finding. It means only that{' '}
                  <span className="mono">from</span> is a name somebody typed. Anyone can type any
                  name, which is why a did:key sitting in an unsigned message gets a line saying
                  it proves nothing.
                </p>
              ),
            },
            {
              q: 'Where do the room sizes come from, and are they current?',
              a: (
                <p>
                  From one request that returns the busiest{' '}
                  {survey.rooms.length ? num.format(survey.rooms.length) : 'few dozen'} rooms
                  {survey.total ? ` of ${num.format(survey.total)}` : ''}. The server caches it
                  hard — up to a day at the edge — and it carries no timestamp, so it is a map of
                  what exists and roughly how big it is, never a reading of what is happening
                  now. Nothing about the messages is derived from it; those come from reading the
                  room directly.
                </p>
              ),
            },
            {
              q: 'What can Lens not tell me?',
              a: (
                <>
                  <p>
                    Anything about messages that have rotated out. Rooms are rings: past a size
                    limit the oldest lines are dropped, and they are then gone. Lens reports the
                    hole and stops there — a message it never saw is absent, not unverified, and
                    nothing at all follows about it.
                  </p>
                  <p>
                    It also cannot tell you a room is quiet. It shows what the ring still holds;
                    silence in it may be silence, or may be a ring that rotated.
                  </p>
                </>
              ),
            },
            {
              q: 'A proof failed. Does that mean someone forged a message?',
              a: (
                <p>
                  It means the signature does not match the key the message names, and the page
                  will not guess further. A broken client that signs the wrong string produces
                  exactly the same result as a forgery attempt. The full key, nonce and signature
                  are printed under the row so you can check the arithmetic yourself.
                </p>
              ),
            },
            {
              q: 'Is my key ever sent anywhere?',
              a: (
                <p>
                  Lens never asks for one. It reads public rooms and verifies with public keys;
                  there is no field on this page that takes a private key and no request it makes
                  on your behalf. Signing lives on the Bench, and that page does not hold a key
                  either.
                </p>
              ),
            },
          ]}
        />
      </div>
    </Shell>
  );
}

/** The counts, in the panel body rather than the header: there are five of them. */
function RoomFacts({ feed }: { feed: ReturnType<typeof useLens> }) {
  return (
    <p className="lgap rhead" style={{ borderLeftColor: 'transparent' }}>
      <span>
        <span className="rhead__verified">{num.format(feed.counts.verified)}</span> of{' '}
        {num.format(feed.counts.read)} verified
      </span>
      <span>{num.format(feed.counts.unsigned)} unsigned</span>
      <span className={feed.counts.failed > 0 ? 'rhead__failed' : undefined}>
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
  );
}

function Row({ message, reading }: { message: Message; reading: Reading | null }) {
  const verdict = reading?.verdict ?? 'checking';
  const from = message.from ?? '(no name)';
  const failed = verdict === 'failed';

  return (
    <article className="msg" data-verdict={verdict}>
      <p className="msg__head">
        <span
          className={`msg__from${reading?.claimsKey ? ' msg__from--key' : ''}`}
          title={from}
        >
          {from}
        </span>
        <span className="msg__state">{verdict === 'verified' ? 'verified' : verdict}</span>
        <span className="msg__time">
          #{message.seq} {clock(message.tsMs)}
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
    </article>
  );
}
