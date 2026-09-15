// Bench.tsx — sign and post anything, without handing over a key.
//
// BUILD.md's hard constraint, and it shapes the whole page: "Never take a
// private key by default. Foolscap shows the exact canonical string, the user
// signs it wherever their key lives, pastes back 86 base64url characters, and
// Foolscap assembles the URL." Key-in-browser exists, behind a deliberate
// toggle, with the page origin on screen, and it is off.
//
// ---------------------------------------------------------------------------
// THE CANONICAL STRING IS THE HERO. It sits above every input and updates live
// as they change, so a user watches the thing they are about to sign being
// assembled. The alternative — a five-step wizard that reveals it at step three
// — hides the one object on the page that actually matters, and this page's job
// is as much teaching what gets signed as producing it.
//
// The string is built over the SWEPT text, never what was typed. The server
// sweeps on the way in and stores the swept form; a signature over the unswept
// text verifies against nothing the room holds, which is a message that looks
// posted and reads as forged to everybody else. When the sweep changes
// something the page shows both, and when it changes nothing it says nothing —
// a permanent "swept text" row would train people to ignore the one time it
// mattered.
//
// FOOLSCAP NEVER POSTS. It assembles the GET and the POST body and hands them
// over. There is no code path in this file that writes to the network.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { Listbox, type Choice } from '../components/Listbox';
import {
  canonicalize,
  didFromSeed,
  looksLikeDid,
  nextNonce,
  parseSeed,
  signWithSeed,
  sweepChanges,
  validateSignature,
  verify,
} from '../lib/did.ts';
import { readRoom, ROOM_RE, saySignedUrl, BASE } from '../lib/technocore.ts';
import { ROOMS, WATCHED_ROOMS } from '../lib/contest.ts';
import {
  SHAPES,
  checkNonce,
  highestNonce,
  isReceiptedType,
  readText,
  requestId,
  shapeFor,
  templateText,
} from '../lib/bench.ts';

/** Rooms offered in the picker. Any name may be typed instead. */
const SUGGESTED = [...new Set([...WATCHED_ROOMS, ROOMS.campaign, 'lobby', 'technocore'])];

/**
 * The shape picker's rows: the type in mono, what it is for beside it.
 *
 * Freeform leads and is the default, because Technocore takes any text in any
 * room and the shapes are the contest's convention rather than a requirement.
 */
const SHAPE_CHOICES: Choice[] = [
  { value: '', name: 'freeform', description: 'Any text. No shape assumed.' },
  ...SHAPES.map((entry) => ({
    value: entry.type,
    name: entry.type,
    description: entry.label.split(' — ')[1] ?? entry.summary,
  })),
];

export default function Bench() {
  const [room, setRoom] = useState<string>(ROOMS.registration);
  const [shapeType, setShapeType] = useState<string>('');
  const [text, setText] = useState('');
  const [nonce, setNonce] = useState(() => nextNonce(null));
  const [did, setDid] = useState('');
  const [sig, setSig] = useState('');
  const [verdict, setVerdict] = useState<'idle' | 'checking' | 'yes' | 'no'>('idle');
  const [lastNonce, setLastNonce] = useState<string | null>(null);
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  const built = useMemo(() => canonicalize({ room, nonce, text }), [room, nonce, text]);
  const reading = useMemo(() => readText(text), [text]);
  const shape = shapeType ? shapeFor(shapeType) : null;
  const roomOk = ROOM_RE.test(room);
  const nonceVerdict = checkNonce(nonce, lastNonce);
  const sigShape = validateSignature(sig);
  const didOk = looksLikeDid(did.trim());

  // Verified here, in this browser, against the DID above it — and the URL
  // below does not exist until it says yes. A bad paste is caught here rather
  // than by the server, which is BUILD.md's step 5 and the reason the paste box
  // is worth having at all.
  useEffect(() => {
    if (!didOk || !sigShape.ok) {
      setVerdict('idle');
      return;
    }
    let cancelled = false;
    setVerdict('checking');
    void verify(did.trim(), built.canonical, sig.trim())
      .then((ok) => !cancelled && setVerdict(ok ? 'yes' : 'no'))
      .catch(() => !cancelled && setVerdict('no'));
    return () => {
      cancelled = true;
    };
  }, [did, didOk, sig, sigShape.ok, built.canonical]);

  /**
   * What nonce has this key already used in this room?
   *
   * One read, on demand. It prevents the commonest 400 there is, and the answer
   * is bounded by what the ring still holds — so a miss is "nothing found in
   * what is retained", never "nothing was used". The page says which.
   */
  const lookUpNonce = useCallback(async () => {
    if (!didOk || !roomOk) return;
    setLooking(true);
    try {
      const reply = await readRoom(room, { limit: 200 });
      const highest = highestNonce(reply.messages, did.trim());
      setLastNonce(highest);
      setLookedUp(room);
      if (highest) setNonce((current) => nextNonce(highest, Number(current) || Date.now()));
    } catch {
      setLastNonce(null);
      setLookedUp(null);
    } finally {
      setLooking(false);
    }
  }, [did, didOk, room, roomOk]);

  // A room change invalidates what was looked up: nonces are per key PER ROOM.
  useEffect(() => {
    if (lookedUp !== null && lookedUp !== room) {
      setLastNonce(null);
      setLookedUp(null);
    }
  }, [room, lookedUp]);

  const ready = verdict === 'yes' && roomOk;
  const url = ready
    ? saySignedUrl({ room, did: did.trim(), sig: sig.trim(), nonce, text: built.text })
    : null;
  const body = ready
    ? JSON.stringify({ did: did.trim(), sig: sig.trim(), nonce, text: built.text }, null, 2)
    : null;

  return (
    <Shell page="bench">
      <div className="bench">
        <Slab built={built} roomOk={roomOk} />

        {/* --- 1. what to say, and where ------------------------------------ */}
        <div className="bench__grid">
          <div className="field">
            <label className="field__label" htmlFor="bench-room">
              Room
            </label>
            <input
              className="field__input"
              id="bench-room"
              list="bench-rooms"
              value={room}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setRoom(e.target.value.trim())}
            />
            <datalist id="bench-rooms">
              {SUGGESTED.map((name) => (
                <option value={name} key={name} />
              ))}
            </datalist>
            {!roomOk && (
              <p className="field__hint field__hint--warn">
                A room is lowercase letters, digits and hyphens, starting with a letter or digit.
              </p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="bench-nonce">
              Nonce
            </label>
            <div className="field__row">
              <input
                className="field__input"
                id="bench-nonce"
                inputMode="numeric"
                value={nonce}
                onChange={(e) => setNonce(e.target.value.trim())}
              />
              <button
                className="bbutton"
                type="button"
                onClick={() => setNonce(nextNonce(lastNonce))}
              >
                New nonce
              </button>
            </div>
            <NonceHint
              verdict={nonceVerdict}
              lastNonce={lastNonce}
              lookedUp={lookedUp === room}
              canLookUp={didOk && roomOk}
              looking={looking}
              onLookUp={() => void lookUpNonce()}
            />
          </div>

          <div className="field field--wide">
            <label className="field__label" htmlFor="bench-shape">
              Shape
            </label>
            {/* Not a <select>. Its popup is OS chrome, and this page's fields
                are glass — white at 3% — which reads white-on-black on the page
                and white-on-white inside the popup, where every option went
                invisible. See components/Listbox.tsx. */}
            <Listbox
              id="bench-shape"
              label="Message shape"
              value={shapeType}
              choices={SHAPE_CHOICES}
              onChange={(next) => {
                setShapeType(next);
                const picked = next ? shapeFor(next) : null;
                if (!picked) return;
                // The template is a starting point. The text area stays the
                // source of truth — what gets signed is what is in it.
                setText(templateText(picked).replace('<a fresh id per attempt>', requestId()));
                if (picked.room) setRoom(picked.room);
              }}
            />
            {shape && (
              <p className="field__hint">
                {shape.summary}
                {shape.note ? ` ${shape.note}` : ''}
              </p>
            )}
            {!shape && (
              <p className="field__hint">
                Technocore takes any text in any room. The shapes above are the contest&rsquo;s
                convention, not something the server enforces.
              </p>
            )}
          </div>

          <div className="field field--wide">
            <label className="field__label" htmlFor="bench-text">
              Message text
            </label>
            <textarea
              className="field__area"
              id="bench-text"
              value={text}
              spellCheck={false}
              placeholder="What you want to say, or a JSON packet."
              onChange={(e) => setText(e.target.value)}
            />
            {reading.problem && <p className="field__hint field__hint--warn">{reading.problem}</p>}
            {reading.type && (
              <p className="field__hint">
                {isReceiptedType(reading.type)
                  ? `${reading.type} is answered with a receipt, so it can be tracked on /track.`
                  : `${reading.type} is not receipted — posting it puts a message in a room and that is all. Nothing will answer.`}
              </p>
            )}
          </div>

          {/* Only when it changed. See the file header. */}
          {sweepChanges(text) && (
            <p className="sweep">
              The server collapses control characters, format characters and line separators to
              spaces, then trims the ends. <strong>This is what you are signing</strong>, and it
              is what the room will store:
              <span className="sweep__text">{built.text || '(nothing left after the sweep)'}</span>
            </p>
          )}
        </div>

        {/* --- 2. sign it -------------------------------------------------- */}
        <section className="bench__section">
          <h2 className="bench__legend">Sign it wherever your key lives</h2>
          <div className="bench__grid">
            <div className="field field--wide">
              <label className="field__label" htmlFor="bench-did">
                Your did:key
              </label>
              <input
                className="field__input"
                id="bench-did"
                value={did}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="did:key:z6Mk…"
                onChange={(e) => setDid(e.target.value.trim())}
              />
              {did !== '' && !didOk && (
                <p className="field__hint field__hint--warn">
                  That is not an Ed25519 did:key. They begin did:key:z6Mk and run about 56
                  characters.
                </p>
              )}
            </div>

            <div className="field field--wide">
              <label className="field__label" htmlFor="bench-sig">
                Signature over the string above
              </label>
              <input
                className="field__input"
                id="bench-sig"
                value={sig}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="86 characters of base64url"
                onChange={(e) => setSig(e.target.value.trim())}
              />
              {sig !== '' && !sigShape.ok && (
                <p className="field__hint field__hint--warn">{sigShape.reason}</p>
              )}
              <Verdict verdict={verdict} did={did.trim()} />
            </div>
          </div>

          <LocalKey canonical={built.canonical} onSigned={(s, d) => {
            setSig(s);
            setDid(d);
          }} />
        </section>

        {/* --- 3. post it -------------------------------------------------- */}
        <section className="bench__section">
          <h2 className="bench__legend">Post it yourself</h2>
          {!ready ? (
            <p className="bench__note">
              The request appears once the signature above verifies. Foolscap builds it and hands
              it over — it does not post anything on your behalf, here or anywhere else on this
              site.
            </p>
          ) : (
            <>
              <Emit label="GET — no preflight, so this is the one to use in a browser" value={url!} />
              <Emit label={`POST ${BASE}/r/${room} — for a client that would rather send JSON`} value={body!} />
              <p className="bench__note">
                A <span className="mono">400 nonce … is not greater than …</span> means the
                earlier message already landed. That is not a failure to retry: check the room
                before sending anything again.
              </p>
            </>
          )}
        </section>

        <div className="bcaveat">
          <strong>Foolscap never holds a key.</strong>
          This page builds a string, checks a signature you made elsewhere, and writes out a
          request for you to send. It has no server, and nothing you type here leaves the
          browser except the one read that looks up your last nonce — which sends your DID and
          the room name to technocore.chat and nothing else.
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

/**
 * The hero.
 *
 * The two pipes are dimmed so the three parts read as three parts — structure
 * carried by weight, because there is no colour to spare on this page and a
 * three-hue string would make the separators look like syntax highlighting
 * rather than the delimiters they are.
 */
function Slab({
  built,
  roomOk,
}: {
  built: ReturnType<typeof canonicalize>;
  roomOk: boolean;
}) {
  const bytes = new TextEncoder().encode(built.canonical).length;
  return (
    <div className="slab">
      <p className="slab__text">
        {roomOk ? built.room : <em className="slab__missing">{built.room || '(room)'}</em>}
        <span className="slab__pipe">|</span>
        {built.nonce}
        <span className="slab__pipe">|</span>
        {built.text || <em className="slab__missing">(no text yet)</em>}
      </p>
      <div className="slab__foot">
        <span className="slab__meta">
          {bytes} bytes · room | nonce | text · sign these exact bytes
        </span>
        <Copy value={built.canonical} label="Copy the string" />
      </div>
    </div>
  );
}

function Verdict({ verdict, did }: { verdict: string; did: string }) {
  if (verdict === 'idle') return null;
  if (verdict === 'checking') return <p className="verdict">Checking…</p>;
  if (verdict === 'yes') {
    return (
      <p className="verdict">
        <span className="verdict__word verdict__word--yes">Verified</span> — here, in this
        browser, against {did.slice(0, 20)}…. The server will reach the same answer.
      </p>
    );
  }
  return (
    <p className="verdict">
      <span className="verdict__word verdict__word--no">Does not verify</span> against that key
      and the string above. The commonest cause is that the string moved on between signing and
      pasting — a changed nonce, a changed character — so sign the one on screen now.
    </p>
  );
}

function NonceHint({
  verdict,
  lastNonce,
  lookedUp,
  canLookUp,
  looking,
  onLookUp,
}: {
  verdict: ReturnType<typeof checkNonce>;
  lastNonce: string | null;
  lookedUp: boolean;
  canLookUp: boolean;
  looking: boolean;
  onLookUp: () => void;
}) {
  if (!verdict.ok) {
    return <p className="field__hint field__hint--warn">{verdict.reason}</p>;
  }
  return (
    <p className="field__hint">
      It must be strictly greater than the last nonce this key used <em>in this room</em>. A
      clock reading normally is.{' '}
      {lookedUp ? (
        lastNonce ? (
          <>The highest found in what the ring still holds is {lastNonce}.</>
        ) : (
          <>
            Nothing found from this key in what the ring still holds — which is not the same as
            nothing used, because rings rotate.
          </>
        )
      ) : (
        canLookUp && (
          <button className="bbutton bbutton--quiet" type="button" disabled={looking} onClick={onLookUp}>
            {looking ? 'Reading…' : 'Check this room'}
          </button>
        )
      )}
    </p>
  );
}

function Emit({ label, value }: { label: string; value: string }) {
  return (
    <div className="emit">
      <span className="field__label">{label}</span>
      <p className="emit__value">{value}</p>
      <div className="emit__foot">
        <Copy value={value} label="Copy" />
      </div>
    </div>
  );
}

function Copy({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <button
      className="bbutton bbutton--quiet"
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => setDone(true),
          () => setDone(false)
        );
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

// ---------------------------------------------------------------------------

/**
 * Key-in-browser, behind a deliberate toggle, off.
 *
 * BUILD.md: "Offer key-in-browser only behind a deliberate toggle, with the
 * page origin shown, and never as the default on a hosted copy."
 *
 * THE ORIGIN IS THE POINT of showing it. Anyone can copy this page and serve it
 * from somewhere that keeps what you paste; the one fact that distinguishes a
 * safe copy from a hostile one is which address is in the bar, and it is put on
 * screen rather than left to be checked. The seed is held in component state
 * for as long as the panel is open and is never stored, sent, or put in a URL.
 */
function LocalKey({
  canonical,
  onSigned,
}: {
  canonical: string;
  onSigned: (sig: string, did: string) => void;
}) {
  const [on, setOn] = useState(false);
  const [seed, setSeed] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [derived, setDerived] = useState<string | null>(null);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  useEffect(() => {
    if (!on) {
      setSeed('');
      setDerived(null);
      setProblem(null);
    }
  }, [on]);

  useEffect(() => {
    if (!on || seed.trim() === '') {
      setDerived(null);
      setProblem(null);
      return;
    }
    let cancelled = false;
    try {
      const bytes = parseSeed(seed);
      void didFromSeed(bytes).then(
        (value) => !cancelled && (setDerived(value), setProblem(null)),
        (err) => !cancelled && (setDerived(null), setProblem((err as Error).message))
      );
    } catch (err) {
      setDerived(null);
      setProblem((err as Error).message);
    }
    return () => {
      cancelled = true;
    };
  }, [on, seed]);

  return (
    <div className="localkey" data-on={on ? 'true' : 'false'}>
      <label className="localkey__toggle">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>
          Use a key in this browser instead. Off by default, and it should stay off unless you
          are running this page from a local file or a copy you built yourself.
        </span>
      </label>

      {on && (
        <>
          <p className="localkey__origin">
            You are about to paste a private key into this page. It is served from:
            <strong>{origin}</strong>
            If that is not an address you control or trust, close this and go back to pasting a
            signature. The seed stays in this tab&rsquo;s memory, is never stored and never
            leaves the browser — but you only have this page&rsquo;s word for that, which is
            exactly why the default is the other way round.
          </p>

          <div className="localkey__body">
            <label className="field__label" htmlFor="bench-seed">
              32-byte Ed25519 seed — 64 hex characters, or 43 base64url
            </label>
            <input
              className="field__input"
              id="bench-seed"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
            />
            {problem && <p className="field__hint field__hint--warn">{problem}</p>}
            {derived && (
              <>
                <p className="field__hint">
                  This seed is <span className="mono">{derived}</span>. Check that is the key you
                  meant before signing with it.
                </p>
                <button
                  className="bbutton"
                  type="button"
                  onClick={() => {
                    void signWithSeed(parseSeed(seed), canonical).then(
                      (signature) => onSigned(signature, derived),
                      (err) => setProblem((err as Error).message)
                    );
                  }}
                >
                  Sign the string above with this key
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
