// Vault.tsx — what notes exist, who owns them, and when do they expire?
//
// The third question is the one the page is for, and the honest answer to it is
// "nobody can tell you, including this page". A note untouched for seven days
// is reclaimed; the clock is real and running; and the server publishes nothing
// that exposes it — no written-at, no expires-at, no age. The only
// `last-modified` on offer is the time of your own request, which moves every
// time you ask.
//
// SO THERE IS NO COUNTDOWN HERE, and building one would have been the easy,
// obvious, wrong thing. A ring or a bar would be wrong in both directions: a
// note rewritten an hour ago has a full week left and would show as expiring; a
// note nobody has touched in six days would show as fresh because Foolscap
// first saw it this morning.
//
// What the page does instead is remember its own looks. Watch a namespace and
// Foolscap records which keys were present and when it looked; come back and it
// compares. "This key was here on Monday and is not here now" is something it
// actually knows. That is an observation about the past, it is worded as one
// everywhere it appears, and it is the only thing on this page that touches the
// expiry question at all.
//
// A READING IS NEVER A REPLACEMENT. Notes follow conventions — field lists, bare
// DIDs, JSON, delegate records — and where one matches, the parsed view sits
// BESIDE the raw line, never instead of it. The bytes are the only thing that is
// actually true; everything else is this page's guess at what somebody meant.
//
// Vault reads. No writing, no key input: Bench signs.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shell } from '../components/Shell';
import { Panel, PaneState, CapNotice } from '../components/Panel';
import { Questions } from '../components/Questions';
import { Card, MarkField } from '../components/Card';
import { Glyph } from '../components/Glyph';
import { looksLikeDid } from '../lib/did.ts';
import { formatAge, formatUtc, num, plural } from '../format.ts';
import { listNamespace, readNote as fetchNote, noteUrl } from '../lib/kv.ts';
import {
  authorityOf,
  checkDelegate,
  describeGap,
  diffSighting,
  readNote,
  type DelegateRecord,
  type NoteReading,
  type Sighting,
} from '../lib/vault.ts';
import { forgetAll, loadWatch, saveWatch, storageAvailable } from '../vaultStore.ts';

/**
 * Namespaces worth offering, because namespaces are never enumerable.
 *
 * There is no "list all namespaces" on this server and there is not going to
 * be — a namespace exists because somebody wrote to it. So a starting set has
 * to be declared, and anything else is typed.
 */
/**
 * How many keys the list draws at once.
 *
 * A namespace holds up to 250,000 notes and /kv/topic already carries 3,226.
 * Drawing all of them is 3,226 buttons, and a filter keystroke then re-renders
 * every one — measured on the live namespace, that was slow enough to stall the
 * tab. The cap is on what is DRAWN, never on what was read: the count above the
 * list is the whole namespace, the filter searches the whole namespace, and the
 * page says when it is showing a slice.
 */
const DRAW = 300;

const SUGGESTED = [
  'topic',
  'room-owners',
  'room-allow',
  'agent',
  'status',
  'presence',
  'did-00',
  'did-a1',
];

export default function Vault() {
  const [ns, setNs] = useState('topic');
  const [typed, setTyped] = useState('topic');
  /**
   * The key list AND the namespace it came from.
   *
   * Same fix as `selected` below, and it was the same bug with a much louder
   * failure: "Watch this namespace" snapshotted whatever was in `keys` at the
   * time, and a click landing while a new listing was still in flight recorded
   * the PREVIOUS namespace's keys under the new name. The next look then
   * compared two unrelated lists and announced that 7,365 notes had been
   * reclaimed. A page whose entire job is not crying wolf about expiry cannot
   * have that in it.
   */
  const [listed, setListed] = useState<{ ns: string; keys: string[] }>({ ns: '', keys: [] });
  const keys = listed.ns === ns ? listed.keys : [];
  const [filter, setFilter] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  /**
   * The chosen key AND the namespace it was chosen in.
   *
   * A bare key was wrong, and visibly so: clicking a row while a new namespace
   * was still listing left the old key selected, and the note pane then read
   * `did-a1/agent-rendezvous` — a topic key fetched from a DID shard — and
   * reported "nothing here — the key is not in the store". True of that pair,
   * and a completely misleading thing to say about either half of it.
   */
  const [selected, setSelected] = useState<{ ns: string; key: string } | null>(null);
  const openKey = selected && selected.ns === ns ? selected.key : null;

  const [watch, setWatch] = useState(() => loadWatch());
  /** Read by `load`, which must not be re-created every time a watch changes. */
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const [gone, setGone] = useState<string[]>([]);
  const [sinceMs, setSinceMs] = useState<number | null>(null);
  const canRemember = useMemo(() => storageAvailable(), []);

  const watching = watch.watching[ns] ?? null;

  /**
   * The listing currently wanted. Anything older that arrives late is dropped.
   *
   * WITHOUT THIS, A SLOW REQUEST OVERWRITES A FAST ONE. Switch namespace while
   * the first listing is still in flight and whichever finishes LAST wins —
   * which put `agent`'s keys into state while the header said `topic`. The
   * namespace guard on `listed` caught the mismatch and showed an empty list
   * instead of the wrong one, which is how the race became visible at all; this
   * is the actual fix.
   */
  const wanted = useRef(0);

  /**
   * List a namespace, and — if it is being watched — compare against the last
   * look before overwriting it.
   */
  const load = useCallback(async (name: string) => {
    const ticket = ++wanted.current;
    setListing(true);
    setListError(null);
    try {
      const found = await listNamespace(name);
      if (wanted.current !== ticket) return;
      setListed({ ns: name, keys: found });

      // The comparison, and the write that replaces the stored sighting. Done
      // outside the state updater rather than inside it: an updater that also
      // sets other state and writes to storage is a reducer with side effects,
      // and React is free to run it twice.
      const before = watchRef.current.watching[name];
      if (before) {
        const change = diffSighting(before, found, Date.now());
        setGone(change.gone);
        setSinceMs(change.sinceMs);
        const next = {
          watching: { ...watchRef.current.watching, [name]: change.sighting },
        };
        watchRef.current = next;
        setWatch(next);
        saveWatch(next);
      }
    } catch (err) {
      if (wanted.current !== ticket) return;
      setListError((err as Error).message);
      setListed({ ns: name, keys: [] });
    } finally {
      if (wanted.current === ticket) setListing(false);
    }
  }, []);

  useEffect(() => {
    setGone([]);
    setSinceMs(null);
    void load(ns);
  }, [ns, load]);

  const startWatching = () => {
    const next: Sighting = { lastLookedMs: Date.now(), keys: [...keys] };
    const state = { watching: { ...watch.watching, [ns]: next } };
    watchRef.current = state;
    setWatch(state);
    saveWatch(state);
  };

  const stopWatching = (name: string) => {
    const rest = { ...watch.watching };
    delete rest[name];
    const state = { watching: rest };
    watchRef.current = state;
    setWatch(state);
    saveWatch(state);
  };

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = needle ? keys.filter((key) => key.toLowerCase().includes(needle)) : keys;
    // Keys that went are listed alongside the live ones rather than dropped —
    // the whole point is that they are missing, and a list that silently
    // omitted them would hide the only thing this page can report. They are
    // never truncated either: there are only ever a handful.
    const missing = gone.filter((key) => !needle || key.toLowerCase().includes(needle));
    return { live: matched.slice(0, DRAW), matched: matched.length, missing };
  }, [keys, filter, gone]);

  /**
   * The mark field for a watched namespace's card.
   *
   * Twenty-five cells sampled from the keys that were there at the last look,
   * set where the key is still there. For the namespace currently open that is
   * a real before-and-after; for the others Foolscap has not looked since, so
   * every sampled cell is set and the card says so rather than implying a check
   * it did not make.
   */
  const sampleField = (sighting: Sighting, name: string): boolean[] => {
    const sample = sighting.keys.slice(0, 25);
    const here = name === ns && listed.ns === ns ? new Set(keys) : null;
    return Array.from({ length: 25 }, (_, i) =>
      i < sample.length ? (here ? here.has(sample[i]) : true) : false
    );
  };

  const watched = Object.entries(watch.watching);

  /**
   * How long ago, in words a person would use.
   *
   * formatAge is exact and says "0 seconds", which is what the watch line read
   * the instant after anyone clicked Watch. Under a minute the honest and
   * readable answer is the same one: just now.
   */
  const since = (ms: number): string => (ms < 60_000 ? 'just now' : `${formatAge(ms)} ago`);

  return (
    <Shell page="vault">
      {/* The query, above the split, because it decides what both panes show.
          A console header on a pattern A page, which is what a split whose
          contents are chosen by a text field actually needs. */}
      <div className="vquery">
        <div className="vpick">
          <div className="vpick__field">
            <label className="vpick__label" htmlFor="vault-ns">
              Namespace
            </label>
            <input
              className="vpick__input"
              id="vault-ns"
              value={typed}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="topic, room-owners, did-a1…"
              onChange={(e) => setTyped(e.target.value.trim())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typed) setNs(typed);
              }}
            />
          </div>
          <button className="vbutton" type="button" onClick={() => typed && setNs(typed)}>
            Read it
          </button>
        </div>

        <div className="vsuggest">
          {SUGGESTED.map((name) => (
            <button
              className="vsuggest__item"
              type="button"
              key={name}
              aria-current={name === ns ? 'true' : undefined}
              onClick={() => {
                setTyped(name);
                setNs(name);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="split">
        <aside className="split__aside">
          <Panel
            flush
            title="Keys"
            action={
              <span className="vkeys__count">
                {listing ? 'listing…' : num.format(keys.length)}
              </span>
            }
          >
            <div className="vkeys__tools">
              <input
                className="vpick__input vfilter"
                type="search"
                value={filter}
                placeholder="Filter keys"
                aria-label="Filter keys"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>

            {/* THE WATCH STATE, IN THE LIST PANEL, which is what DESIGN.md asks
                for: it was a section below both panes, where a reader had to
                already know it existed. It is the only thing on this page that
                bears on the expiry question at all, so it belongs against the
                list it is about. */}
            {canRemember && (
              <div className="vwatchline" data-changed={gone.length > 0 ? 'true' : 'false'}>
                {watching ? (
                  <>
                    <span className="vwatchline__state">
                      Watched. Last looked {since(Date.now() - watching.lastLookedMs)},{' '}
                      {plural(watching.keys.length, 'key')} then.
                    </span>
                    {gone.length > 0 && (
                      <span className="vwatchline__gone">
                        {plural(gone.length, 'key')} {gone.length === 1 ? 'is' : 'are'} gone since.{' '}
                        {describeGap(sinceMs)}
                      </span>
                    )}
                    <button
                      className="vbutton vbutton--quiet"
                      type="button"
                      onClick={() => stopWatching(ns)}
                    >
                      Stop watching
                    </button>
                  </>
                ) : (
                  <>
                    <span className="vwatchline__state">
                      Not watched. Foolscap can only tell you a note has gone if it looked before.
                    </span>
                    <button
                      className="vbutton vbutton--quiet"
                      type="button"
                      disabled={listing || listed.ns !== ns || keys.length === 0}
                      onClick={startWatching}
                    >
                      Watch this namespace
                    </button>
                  </>
                )}
              </div>
            )}

            {listing && keys.length === 0 ? (
              <PaneState state="loading" title={`Listing ${ns}…`} />
            ) : listError ? (
              <PaneState
                state="failed"
                title="That namespace could not be listed."
                detail={`${listError} Notes are still readable by name if you know one.`}
              />
            ) : shown.live.length === 0 && shown.missing.length === 0 ? (
              <PaneState
                state="empty"
                title={keys.length === 0 ? `Nothing in ${ns}.` : 'No key matches that filter.'}
                detail={
                  keys.length === 0
                    ? 'Either nobody has written to it, or everything in it has been reclaimed — those look identical from out here.'
                    : `Filtering searches all ${num.format(keys.length)}.`
                }
              />
            ) : (
              <>
                <ul className="vkeys__list">
                  {shown.missing.map((key) => (
                    <li key={`gone-${key}`}>
                      <span
                        className="vkeys__row"
                        data-gone="true"
                        title="Seen at the last look; not in this listing"
                      >
                        {key}
                      </span>
                    </li>
                  ))}
                  {shown.live.map((key) => (
                    <li key={key}>
                      <button
                        className="vkeys__row"
                        type="button"
                        aria-current={key === openKey ? 'true' : undefined}
                        onClick={() => setSelected({ ns, key })}
                      >
                        {key}
                      </button>
                    </li>
                  ))}
                </ul>
                <CapNotice
                  shown={shown.live.length}
                  total={shown.matched}
                  noun="keys"
                  how={`Filtering searches all ${num.format(keys.length)}.`}
                />
              </>
            )}
          </Panel>

          <p className="vnote-quiet">
            Keys beginning <span className="mono">p-</span> are never listed by the server. They
            are reachable by name and this page cannot show you they exist.
          </p>
        </aside>

        <div className="split__main">
          {openKey ? (
            <Note ns={ns} noteKey={openKey} />
          ) : (
            <Panel title="Note">
              <PaneState
                state="empty"
                title="Pick a key to read its note."
                detail={
                  <>
                    Every namespace here is world-writable — the server checks signatures on writes
                    to <span className="mono">room-owners</span> and{' '}
                    <span className="mono">room-allow</span> and nowhere else. Whatever comes back
                    is shown exactly as stored, and any reading of it sits beside the bytes rather
                    than in place of them.
                  </>
                }
              />
            </Panel>
          )}
        </div>
      </div>

      <div className="split__tail">
        {canRemember && watched.length > 0 && (
          <section className="vwatched">
            <h2 className="vwatched__title">Namespaces Foolscap has looked at</h2>
            <div className="vwatched__grid">
              {watched.map(([name, sighting]) => (
                <Card
                  key={name}
                  visual={<MarkField present={sampleField(sighting, name)} />}
                  title={name}
                  detail={
                    name === ns
                      ? gone.length > 0
                        ? `${plural(gone.length, 'key')} gone since the last look.`
                        : 'Nothing has gone since the last look.'
                      : 'Open it to compare against the last look.'
                  }
                  meta={[
                    `${plural(sighting.keys.length, 'key')} then`,
                    `looked ${since(Date.now() - sighting.lastLookedMs)}`,
                  ]}
                  actionLabel={name === ns ? 'Stop watching' : 'Open'}
                  onClick={() => {
                    if (name === ns) {
                      stopWatching(name);
                      return;
                    }
                    setTyped(name);
                    setNs(name);
                  }}
                />
              ))}
            </div>
            <p className="vnote-quiet">
              These times are this browser&rsquo;s clock, recording when <em>Foolscap</em> looked —
              not when anything was written. Nothing here came from the server.{' '}
              <button
                className="vbutton vbutton--quiet"
                type="button"
                onClick={() => {
                  forgetAll();
                  watchRef.current = { watching: {} };
                  setWatch({ watching: {} });
                  setGone([]);
                }}
              >
                Forget everything
              </button>
            </p>
          </section>
        )}

        <Questions
          title="What notes exist, who owns them, and when do they expire?"
          items={[
            {
              q: 'When does this note expire?',
              a: (
                <>
                  <p>
                    Nobody can tell you, including this page. A note untouched for seven days is
                    reclaimed and the clock is real, but the server publishes nothing that exposes
                    it — no written-at, no expires-at and no age, on the listing, on a read or in a
                    header. The <span className="mono">last-modified</span> you get back is the
                    time of your own request, and it moves every time you ask.
                  </p>
                  <p>
                    So there is no countdown here and there will not be one. A ring or a bar would
                    be wrong in both directions: a note rewritten an hour ago has a full week left
                    and would read as expiring, and a note nobody has touched in six days would
                    read as fresh because Foolscap first saw it this morning.
                  </p>
                </>
              ),
            },
            {
              q: 'Then what does “watching” actually do?',
              a: (
                <p>
                  It remembers. Watch a namespace and Foolscap stores which keys were listed and
                  when it looked; come back and it compares the two. “This key was here on Monday
                  and is not here now” is something it knows, and it is an observation about the
                  past rather than a forecast. It cannot tell you <em>why</em> a key went: a
                  reclaimed note and a deleted one look identical from out here.
                </p>
              ),
            },
            {
              q: 'Where is that stored, and what is in it?',
              a: (
                <p>
                  In this browser and nowhere else. It holds the namespaces you chose to watch, the
                  key names that were listed, and the time of the look — no note contents, no
                  identifiers, nothing from any other page and nothing about you. All of it was
                  public and on screen already, and “Forget everything” empties it. It is the only
                  thing on this site kept between visits.
                </p>
              ),
            },
            {
              q: 'Can I trust what a note says?',
              a: (
                <p>
                  Not from the fact that it is there. Every namespace on this server is
                  world-writable except two: the server checks signatures on writes to{' '}
                  <span className="mono">room-owners</span> and{' '}
                  <span className="mono">room-allow</span>, and nowhere else. Anywhere else, anyone
                  could have written anything. Where a note carries a signed delegate record,
                  Foolscap checks that signature here, in this browser, and says which way it went.
                </p>
              ),
            },
            {
              q: 'Why is the raw line always shown?',
              a: (
                <p>
                  Because it is the only part that is certainly true. Notes follow conventions —
                  field lists, bare DIDs, JSON, delegate records — and where one matches, this page
                  shows its reading of it. A reading is a guess at what somebody meant, so it sits
                  beside the bytes and never in place of them.
                </p>
              ),
            },
            {
              q: 'Are these all the keys?',
              a: (
                <p>
                  All the ones the server will list. Keys beginning <span className="mono">p-</span>{' '}
                  are excluded from every listing by design: they are reachable by name and this
                  page cannot show you they exist, so a namespace can hold notes nothing here will
                  ever display. The list also draws at most {num.format(DRAW)} at once — a
                  namespace holds up to 250,000 — and filtering searches the whole of it.
                </p>
              ),
            },
          ]}
        />
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

/**
 * The note, as two or three stacked panels.
 *
 * DESIGN.md: "The note pane gets the raw line and the parsed reading as two
 * panels stacked, not two headings in one column." They were two <section>s
 * with small grey labels, in one undifferentiated column, and the distinction
 * that matters most on this page — bytes against interpretation — was carried
 * by a label at --t-micro.
 *
 * A READING IS NEVER A REPLACEMENT, and the panels are how that gets said: the
 * first one is what is actually stored, and every panel under it is this page's
 * guess at what somebody meant, titled as a guess.
 */
function Note({ ns, noteKey }: { ns: string; noteKey: string }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  useEffect(() => {
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    setRaw(null);
    void fetchNote(ns, noteKey)
      .then((value) => {
        if (latest.current !== ticket) return;
        setRaw(value);
        setLoading(false);
      })
      .catch((err) => {
        if (latest.current !== ticket) return;
        setError((err as Error).message);
        setLoading(false);
      });
  }, [ns, noteKey]);

  const reading = useMemo(() => readNote(raw), [raw]);
  const authority = authorityOf(ns);

  return (
    <>
      <Panel
        title={
          <span className="vnote__key">
            {ns}/{noteKey}
          </span>
        }
        action={
          <a className="vnote__url" href={noteUrl(ns, noteKey)} target="_blank" rel="noreferrer noopener">
            Raw
          </a>
        }
      >
        {loading ? (
          <PaneState state="loading" title={`Reading ${noteKey}…`} />
        ) : error ? (
          <PaneState
            state="failed"
            title="That note could not be read."
            detail={`${error} The key is still listed; this was the read of it that failed.`}
          />
        ) : (
          <>
            <p className="vraw">
              {raw === null
                ? '(nothing here — the key is not in the store)'
                : raw === ''
                  ? '(empty)'
                  : raw}
            </p>
            <p className="vauth" data-signed={authority.signedLane ? 'true' : 'false'}>
              {authority.note}
            </p>
          </>
        )}
      </Panel>

      {!loading && !error && reading.shape !== 'text' && reading.shape !== 'empty' && (
        <Panel
          title={
            <>
              Read as {reading.shape === 'did' ? 'a did:key' : reading.shape}
              <span className="panel2__qualifier">
                {' '}
                — a convention, not something the server enforces
              </span>
            </>
          }
        >
          <Parsed reading={reading} />
        </Panel>
      )}

      {!loading && !error && reading.delegates.length > 0 && reading.did && (
        <Panel flush title={`${plural(reading.delegates.length, 'delegate record')}, checked here`}>
          {reading.delegates.map((record, i) => (
            <Delegate record={record} rootDid={reading.did!} key={`${record.nonce}-${i}`} />
          ))}
        </Panel>
      )}
    </>
  );
}

/**
 * A DID, with its mark.
 *
 * Wherever a did:key is the subject rather than a mention. Printed in full —
 * this is a page about who owns what, and a truncated owner is not an owner —
 * with the glyph beside it so two DIDs in a list are distinguishable before
 * either is read.
 */
function Did({ value }: { value: string }) {
  return (
    <span className="vdid">
      <Glyph did={value} size={20} />
      <span className="vdid__value">{value}</span>
    </span>
  );
}

function Parsed({ reading }: { reading: NoteReading }) {
  if (reading.shape === 'json') {
    return <pre className="vjson">{reading.json}</pre>;
  }
  if (reading.shape === 'did') {
    return (
      <dl className="vfields">
        <dt>did:key</dt>
        <dd>
          <Did value={reading.did!} />
        </dd>
      </dl>
    );
  }
  return (
    <dl className="vfields">
      {reading.fields.map((field, i) => (
        <div style={{ display: 'contents' }} key={`${field.name}-${i}`}>
          <dt>{field.name}</dt>
          <dd>{looksLikeDid(field.value) ? <Did value={field.value} /> : field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A delegate record, verified against the note it sits in.
 *
 * Three outcomes and they are not two. A signature that checks out on a record
 * whose expiry has passed is a TRUE record of a permission that has lapsed —
 * expiry is the only revocation this scheme has — and calling that "invalid"
 * would put it in the same bin as a forgery.
 */
function Delegate({ record, rootDid }: { record: DelegateRecord; rootDid: string }) {
  const [state, setState] = useState<{
    ok: boolean;
    reason: string | null;
    expired: boolean;
    expiresAt: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkDelegate(record, rootDid).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [record, rootDid]);

  const verdict = state == null ? 'checking' : !state.ok ? 'no' : state.expired ? 'expired' : 'yes';

  return (
    <div className="vdel" data-ok={state == null ? undefined : String(state.ok)}>
      <Did value={record.agent} />
      <span className="vdel__line">
        {record.scope} · expires {formatUtc(record.expires * 1000)}
      </span>
      <span className={`vdel__verdict vdel__verdict--${verdict}`}>
        {verdict === 'checking'
          ? 'checking…'
          : verdict === 'yes'
            ? 'signature verified here'
            : verdict === 'expired'
              ? 'signature verified — and this permission has expired'
              : 'signature does not verify'}
      </span>
      {state && !state.ok && state.reason && <span className="vdel__why">{state.reason}</span>}
    </div>
  );
}
