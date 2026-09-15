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

  return (
    <Shell page="vault">
      <div className="vault">
        {/* First thing under the header. Not a footnote. */}
        <div className="cannot">
          <strong>Foolscap cannot tell you when a note will expire.</strong>
          A note untouched for seven days is reclaimed, but the server publishes nothing that
          exposes that clock — there is no written-at, no expires-at and no age, on the listing,
          on a read or in a header. The <span className="mono">last-modified</span> you get back
          is the time of your own request. So there is no countdown on this page and there will
          not be one. What it can do is remember: watch a namespace, and Foolscap records which
          keys were there and when it looked, so that next time it can tell you{' '}
          <em>a note it saw last week is gone now</em>. That is an observation about the past,
          not a forecast.
        </div>

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
          {canRemember && (
            <button
              className="vbutton"
              type="button"
              disabled={watching != null || listing || listed.ns !== ns || keys.length === 0}
              onClick={startWatching}
            >
              {watching ? 'Watching this one' : 'Watch this namespace'}
            </button>
          )}
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

        {listError && <p className="vproblem">{listError}</p>}

        {gone.length > 0 && (
          <div className="cannot">
            <strong>
              {plural(gone.length, 'key')} Foolscap saw here last time {gone.length === 1 ? 'is' : 'are'}{' '}
              gone.
            </strong>
            {describeGap(sinceMs)}
          </div>
        )}

        <div className="vpanes">
          <div className="vkeys">
            <p className="vkeys__head">
              <span>
                {listing
                  ? 'listing…'
                  : shown.matched === keys.length
                    ? `${num.format(keys.length)} keys`
                    : `${num.format(shown.matched)} of ${num.format(keys.length)}`}
              </span>
              <span>{ns}</span>
            </p>
            <input
              className="vpick__input"
              type="search"
              value={filter}
              placeholder="Filter keys"
              aria-label="Filter keys"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
            <ul className="vkeys__list">
              {shown.missing.map((key) => (
                <li key={`gone-${key}`}>
                  <span className="vkeys__row" data-gone="true" title="Seen at the last look; not in this listing">
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
              {shown.matched > shown.live.length && (
                <li>
                  <p className="vnote-quiet">
                    Showing {num.format(shown.live.length)} of {num.format(shown.matched)}.
                    Filtering searches all {num.format(keys.length)}.
                  </p>
                </li>
              )}
              {!listing && shown.live.length === 0 && shown.missing.length === 0 && (
                <li>
                  <p className="vnote-quiet">
                    {keys.length === 0
                      ? `Nothing in ${ns}. Either nobody has written to it, or everything in it has been reclaimed — those look identical from out here.`
                      : 'No key matches that filter.'}
                  </p>
                </li>
              )}
            </ul>
            <p className="vnote-quiet">
              Keys beginning <span className="mono">p-</span> are never listed by the server.
              They are reachable by name and this page cannot show you they exist.
            </p>
          </div>

          <div className="vnote">
            {openKey ? (
              <Note ns={ns} noteKey={openKey} />
            ) : (
              <p className="vempty">
                Pick a key to read its note. Every namespace here is world-writable — the server
                checks signatures on writes to <span className="mono">room-owners</span> and{' '}
                <span className="mono">room-allow</span> and nowhere else.
              </p>
            )}
          </div>
        </div>

        <section className="vwatch">
          <h2 className="vwatch__title">What Foolscap has looked at</h2>
          {!canRemember ? (
            <p className="vnote-quiet">
              This browser will not let the page remember anything — private mode, or site data
              switched off. Watching needs somewhere to keep the last listing, so it is
              unavailable here. Nothing else on the page depends on it.
            </p>
          ) : Object.keys(watch.watching).length === 0 ? (
            <p className="vnote-quiet">
              Nothing watched yet. Watching a namespace stores its key list and the time of the
              look in this browser, and nothing else — no note contents, no identifiers, nothing
              from any other page. It is the only thing on this site that is kept between visits.
            </p>
          ) : (
            <>
              <ul className="vwatch__list">
                {Object.entries(watch.watching).map(([name, sighting]) => (
                  <li
                    className="vwatch__row"
                    key={name}
                    data-changed={name === ns && gone.length > 0 ? 'true' : 'false'}
                  >
                    <span className="vwatch__ns">{name}</span>
                    <span className="vwatch__when">
                      {plural(sighting.keys.length, 'key')} at the last look ·{' '}
                      {formatUtc(sighting.lastLookedMs)} ·{' '}
                      {formatAge(Date.now() - sighting.lastLookedMs)} ago
                    </span>
                    {name === ns && gone.length > 0 && (
                      <span className="vwatch__gone">gone since: {gone.join(', ')}</span>
                    )}
                    <span>
                      <button
                        className="vbutton vbutton--quiet"
                        type="button"
                        onClick={() => stopWatching(name)}
                      >
                        Stop watching
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="vnote-quiet">
                These times are this browser&rsquo;s clock, recording when <em>Foolscap</em>{' '}
                looked — not when anything was written. Nothing here came from the server.{' '}
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
            </>
          )}
        </section>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

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
      <h2 className="vnote__key">
        {ns}/{noteKey}
      </h2>
      <p className="vnote__url">
        <a href={noteUrl(ns, noteKey)} target="_blank" rel="noreferrer noopener">
          {noteUrl(ns, noteKey)}
        </a>
      </p>

      {loading && <p className="vempty">Reading…</p>}
      {error && <p className="vproblem">{error}</p>}

      {!loading && !error && (
        <>
          <section className="vsection">
            <p className="vsection__label">The note, exactly as stored</p>
            <p className="vraw">
              {raw === null
                ? '(nothing here — the key is not in the store)'
                : raw === ''
                  ? '(empty)'
                  : raw}
            </p>
          </section>

          {reading.shape !== 'text' && reading.shape !== 'empty' && (
            <section className="vsection">
              <p className="vsection__label">
                Read as {reading.shape === 'did' ? 'a did:key' : reading.shape}
                {' — a convention, not something the server enforces'}
              </p>
              <Parsed reading={reading} />
            </section>
          )}

          {reading.delegates.length > 0 && reading.did && (
            <section className="vsection">
              <p className="vsection__label">
                {plural(reading.delegates.length, 'delegate record')}, checked here
              </p>
              {reading.delegates.map((record, i) => (
                <Delegate record={record} rootDid={reading.did!} key={`${record.nonce}-${i}`} />
              ))}
            </section>
          )}

          <p className="vauth" data-signed={authority.signedLane ? 'true' : 'false'}>
            {authority.note}
          </p>
        </>
      )}
    </>
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
        <dd>{reading.did}</dd>
      </dl>
    );
  }
  return (
    <dl className="vfields">
      {reading.fields.map((field, i) => (
        <div style={{ display: 'contents' }} key={`${field.name}-${i}`}>
          <dt>{field.name}</dt>
          <dd>{field.value}</dd>
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
      <span className="vdel__line">
        {record.agent} · {record.scope} · expires {formatUtc(record.expires * 1000)}
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
      {state && !state.ok && state.reason && <span>{state.reason}</span>}
    </div>
  );
}
