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
import { Panel, PaneState } from '../components/Panel';
import { Questions, type Question } from '../components/Questions';
import { Glyph } from '../components/Glyph';
import { shortDid } from '../lib/lens.ts';
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

/**
 * The questions, kept out of the render so the page's shape stays readable.
 *
 * Two of them are the caveat band this page used to carry above the footer, put
 * where a reader who has just been asked for a did:key actually wonders.
 */
const BENCH_QUESTIONS: Question[] = [
  {
    q: 'Does Foolscap ever see my private key?',
    a: (
      <p>
        No, and there is no field on this page that takes one unless you switch the local-key
        panel on yourself — it is off by default, it says which origin is about to hold the seed,
        and it exists for testing rather than for a key that matters. The ordinary path is the one
        above: Foolscap shows you the exact bytes, you sign them wherever your key already lives,
        and you paste back the signature. A signature is not a key and cannot be turned into one.
      </p>
    ),
  },
  {
    q: 'What leaves this browser?',
    a: (
      <p>
        One request, and only if you ask for it: the nonce lookup, which sends your{' '}
        <span className="mono">did:key</span> and the room name to technocore.chat to find the
        highest nonce you have used there. Nothing else — not the text, not the signature, not the
        request Foolscap builds. There is no server behind this page to send it to. Posting is
        yours to do, with the URL at the bottom.
      </p>
    ),
  },
  {
    q: 'Why does the string look like that?',
    a: (
      <p>
        Because that is what the server hashes. The canonical string is{' '}
        <span className="mono">room|nonce|text</span>, UTF-8, with the text already put through
        the server&rsquo;s own single-line sweep — control characters, format characters and line
        separators collapsed to spaces, then trimmed. Sign anything else and the server will
        compute a different digest and reject it, which is why the string is the largest thing on
        the page and why it updates as you type.
      </p>
    ),
  },
  {
    q: 'What is the nonce for, and why does mine get refused?',
    a: (
      <p>
        It stops a message being replayed: the server takes a message from a key only if its nonce
        is strictly greater than the last one that key used in that room. A{' '}
        <span className="mono">400 nonce … is not greater than …</span> nearly always means the
        earlier attempt actually landed. That is not a failure to retry — read the room first,
        because retrying will post the thing twice.
      </p>
    ),
  },
  {
    q: 'What does “verified” mean here, exactly?',
    a: (
      <p>
        That your signature folds to the DID above it over the exact bytes on screen, checked in
        this browser with WebCrypto. It proves the holder of that key signed that string; it
        proves nothing about whether the server will accept the message — a nonce that has already
        been used verifies perfectly and is still refused.
      </p>
    ),
  },
  {
    q: 'Will the message be answered?',
    a: (
      <p>
        Only some shapes are. A receipted type gets a receipt from the referee and can then be
        followed on the Tracker; everything else simply puts a message in a room, and nothing will
        answer it. The shape picker says which is which, and so does the hint under the text — but
        the server enforces none of this: the shapes are the contest&rsquo;s convention, and
        Technocore takes any text in any room.
      </p>
    ),
  },
];

export default function Bench() {
  // ?shape=<type> PRESELECTS, which is what makes /notary's "Open the Bench"
  // one click rather than one click and an instruction. Read once, on mount:
  // this is the arriving URL's job and not a thing to keep in step afterwards,
  // and a reader who then picks a different shape must not have it snap back.
  //
  // An unknown type is ignored rather than reported. The value comes from a URL
  // anyone can edit, the picker is right there, and an error message about a
  // query parameter would be the page blaming a stranger for a typo it can
  // simply not act on.
  const [shapeType, setShapeType] = useState<string>(() => {
    const wanted = new URLSearchParams(window.location.search).get('shape');
    return wanted && shapeFor(wanted) ? wanted : '';
  });
  const preset = shapeType ? shapeFor(shapeType) : null;
  const [room, setRoom] = useState<string>(preset?.room ?? ROOMS.registration);
  const [text, setText] = useState(() =>
    preset ? templateText(preset).replace('<a fresh id per attempt>', requestId()) : ''
  );
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
    <Shell page="bench" variant="console">
      <div className="console bench">
        {/* THE CANONICAL STRING IS STILL THE HERO and still above every input:
            a user watches the thing they are about to sign being assembled
            rather than meeting it at step three of a wizard. It is in a panel
            now, which gives it the one thing it did not have — a name. */}
        <Panel title="The exact string you are signing" flush>
          <Slab built={built} roomOk={roomOk} />
        </Panel>

        {/* --- 1. what to say, and where ------------------------------------ */}
        <Panel title="What to say, and where">
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
        </Panel>

        {/* --- 2. sign it -------------------------------------------------- */}
        <Panel title="Sign it wherever your key lives">
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
              {/* THE KEY, DRAWN, the moment it is a key at all. Nothing on this
                  page can tell you a DID is yours — the page has never seen it
                  before — but a reader who knows their own mark will notice
                  instantly that they have pasted somebody else's, or mistyped
                  their own, which is otherwise fifty-six characters of base58
                  to check by eye. */}
              {didOk && (
                <p className="field__mark">
                  <Glyph did={did.trim()} size={20} />
                  <span>
                    The mark for this key. It is the same every time; it is not proof the key is
                    yours.
                  </span>
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
        </Panel>

        {/* --- 3. post it -------------------------------------------------- */}
        <Panel title="Post it yourself">
          {!ready ? (
            <PaneState
              state="empty"
              title="No request yet."
              detail="It appears once the signature above verifies against the string at the top. Foolscap builds it and hands it over — it does not post anything on your behalf, here or anywhere else on this site."
            />
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
        </Panel>

        {/* CUT AT THE CRITIQUE STEP: a four-line band stood here saying Foolscap
            never holds a key, has no server, and sends nothing but the one
            nonce lookup. Every word of it is still on the page — the last two
            questions below say it, at the point where a reader has just been
            asked for a did:key and has started wondering — and the footer under
            them says the first half again on every page of the site. Three
            statements of one claim, and the loudest was the one nobody had a
            question about yet. */}

        <Questions
          title="How do I sign and post without handing over my key?"
          items={BENCH_QUESTIONS}
        />
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
        <Glyph did={did} size={20} />
        <span className="verdict__word verdict__word--yes">Verified</span> — here, in this
        browser, against {shortDid(did)}. The server will reach the same answer.
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
