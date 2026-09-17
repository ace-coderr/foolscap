// audio.ts — the network, as a sound.
//
// GENERATED, NOT PLAYED BACK. There is no audio file on this site and there is
// no library here: three oscillators, a filter and an envelope, built out of the
// Web Audio API when someone asks for them. The reason is the same one that
// keeps every other figure on this site honest — a sample is a recording of
// something that happened once, and this is supposed to be what the network is
// doing now. The drone's filter opens as the measured message rate rises, and
// every verified message in the live view puts one soft tone into the room at a
// pitch taken from the key that signed it. Nothing else feeds it.
//
// OFF, ALWAYS, UNTIL ASKED. A page that makes a sound at a reader who did not
// ask for one has taken something from them. So: no context is constructed
// until a gesture, the stored choice is a preference and never a licence to
// start on its own, and the whole thing is capped at a gain of 0.08 — quiet
// enough to sit under a room with people in it, which is the volume atmosphere
// is supposed to have.
//
// IT STOPS WHEN THE TAB DOES. The City stops reading when the page is hidden;
// a drone that carried on in a background tab would be the page making a claim
// about traffic nobody was reading. Both halves stop together.

import { useCallback, useEffect, useState } from 'react';
import { publicKeyFromDid } from './lib/did.ts';

/**
 * THE THIRD LOCALSTORAGE EXCEPTION. SHELL.md says no localStorage; /vault was
 * the first and the theme the second. This is the smallest of the three: one
 * key holding one of two words, written only when the reader presses the
 * speaker. Nothing about them, nothing from the network, and a sound that had
 * to be switched on again on every navigation is a sound nobody switches on.
 */
export const STORAGE_KEY = 'foolscap.audio.v1';

/**
 * The ceiling on everything in this file.
 *
 * Every voice is mixed under this one gain, so nothing here can be louder than
 * it however many tones land at once. 0.08 is atmosphere: audible in a quiet
 * room, gone under a conversation, and never the loudest thing on a desk.
 */
export const MASTER_GAIN = 0.08;

// --- the two things the network decides ------------------------------------

/** Where the drone's filter sits when nothing is arriving. */
export const CUTOFF_QUIET = 130;
/** ...and where it tops out. Above this the room is as open as it gets. */
export const CUTOFF_BUSY = 900;
/** The rate at which the filter is fully open. Lobby alone runs at about half. */
export const RATE_CEILING = 3000;

/**
 * The drone's cutoff for a measured rate, in messages a minute.
 *
 * Logarithmic, for the same reason the city's heights are: the rooms Foolscap
 * reads run from nothing to fifteen hundred a minute, and a linear map would
 * leave every quiet room at the same closed thud. A room going from silent to
 * ten a minute is a bigger change than one going from a thousand to a thousand
 * and ten, and the ear agrees with the arithmetic.
 */
export function cutoffFor(perMin: number | null | undefined): number {
  if (perMin == null || !Number.isFinite(perMin) || perMin <= 0) return CUTOFF_QUIET;
  const reach = Math.log10(1 + perMin) / Math.log10(1 + RATE_CEILING);
  return CUTOFF_QUIET + (CUTOFF_BUSY - CUTOFF_QUIET) * Math.min(1, reach);
}

/** A minor pentatonic, in semitones. Five notes that cannot land on a wrong one. */
const SCALE = [0, 3, 5, 7, 10];
/** A3. Low enough to sit under the drone rather than over it. */
const TONE_BASE = 220;
/** How many octaves the byte is spread across. */
const TONE_OCTAVES = 3;

/**
 * The note a key gets, in hertz.
 *
 * THE FIRST BYTE OF THE KEY, not of the string: every did:key on this network
 * starts `did:key:z6Mk`, so the first byte of the text is the letter "d" for
 * everybody. The byte here is the first of the thirty-two the DID actually
 * carries — the same byte the first cells of that sender's glyph come from, so
 * the mark and the note are derived from the same place.
 *
 * QUANTISED, so a room full of strangers is a chord rather than a car alarm.
 * Two hundred and fifty-six values fall on fifteen notes of a pentatonic scale
 * across three octaves, which means a sender always sounds the same and two
 * senders can sound the same as each other. That is the same collision a glyph
 * has and it is fine for the same reason: this is recognition, never proof.
 */
export function toneFor(did: string | null | undefined): number | null {
  if (!did) return null;
  let first: number;
  try {
    first = publicKeyFromDid(did)[0];
  } catch {
    // Not a did:key — a name somebody typed, usually. It gets no note rather
    // than a note derived from something that is not a key.
    return null;
  }
  const degree = SCALE[first % SCALE.length];
  const octave = Math.floor(first / SCALE.length) % TONE_OCTAVES;
  return TONE_BASE * 2 ** ((degree + octave * 12) / 12);
}

// --- what the reader has asked for ------------------------------------------

export interface AudioState {
  /** The reader's choice, as stored. Not the same as whether it is sounding. */
  wanted: boolean;
  /** Whether there is a context running right now. */
  running: boolean;
  /** Set once if this browser has no Web Audio at all. */
  unavailable: boolean;
}

const isOn = (value: unknown): value is 'on' | 'off' => value === 'on' || value === 'off';

export function storedWanted(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isOn(raw) ? raw === 'on' : false;
  } catch {
    // A locked-down browser is a browser that has not asked for a sound.
    return false;
  }
}

function store(wanted: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, wanted ? 'on' : 'off');
  } catch {
    // A private window that will not keep it is still allowed to play it.
  }
}

let state: AudioState = { wanted: false, running: false, unavailable: false };
const listeners = new Set<() => void>();

function publish(next: Partial<AudioState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

// --- the instrument ---------------------------------------------------------

let context: AudioContext | null = null;
let master: GainNode | null = null;
let filter: BiquadFilterNode | null = null;
let rate: number | null = null;

/**
 * The three voices, and why three.
 *
 * Two of them are the same note a few cents apart, which is the whole of the
 * trick: two detuned saws beat against each other slowly and the result moves
 * without anything having to modulate it. The third is a fifth above, quieter,
 * so the pair reads as a chord rather than as an out-of-tune unison. All of it
 * goes through one lowpass, which is the thing the network actually moves.
 */
const VOICES = [
  { hz: 55, detune: -7, type: 'sawtooth' as OscillatorType, gain: 0.15 },
  { hz: 55, detune: 6, type: 'sawtooth' as OscillatorType, gain: 0.15 },
  { hz: 82.5, detune: 2, type: 'triangle' as OscillatorType, gain: 0.09 },
];

/** How long the drone takes to arrive, and to go. Slow enough to be a fade. */
const FADE_IN = 2.5;
const FADE_OUT = 0.6;
/** How fast the filter follows the rate. A reading is minutes of traffic. */
const FOLLOW = 2;

/** The shortest gap between two tones, and how far ahead they may be queued. */
const PING_GAP = 0.09;
const PING_AHEAD = 0.75;
const PING_PEAK = 0.12;
const PING_LENGTH = 0.55;
/** When the last tone was scheduled for — not when it was asked for. */
let lastPing = 0;

function build(ctx: AudioContext): void {
  master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoffFor(rate);
  // Under 1: a resonant peak on a drone is a whistle, and a whistle is the one
  // thing a sound at the edge of hearing must not do.
  filter.Q.value = 0.6;
  filter.connect(master);

  for (const voice of VOICES) {
    const osc = ctx.createOscillator();
    osc.type = voice.type;
    osc.frequency.value = voice.hz;
    osc.detune.value = voice.detune;
    const level = ctx.createGain();
    level.gain.value = voice.gain;
    osc.connect(level);
    level.connect(filter);
    osc.start();
  }

  // One turn every twenty-two seconds, sixty hertz either side of wherever the
  // network has put the cutoff. Slower than anyone listening will follow, which
  // is the point: it stops the thing being a held chord and starts it being a
  // room. It rides on top of the rate rather than replacing it — the two sum at
  // the filter, so the breathing is always around the traffic.
  const drift = ctx.createOscillator();
  drift.type = 'sine';
  drift.frequency.value = 0.045;
  const depth = ctx.createGain();
  depth.gain.value = 60;
  drift.connect(depth);
  depth.connect(filter.frequency);
  drift.start();
}

function fade(to: number, seconds: number): void {
  if (!context || !master) return;
  const now = context.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  master.gain.linearRampToValueAtTime(to, now + seconds);
}

/**
 * Start sounding. Only ever called from inside a user gesture.
 *
 * A browser will construct a suspended context at any time and resume one only
 * from a gesture, which is a rule this file agrees with rather than works
 * around: the context is not built at all until the moment someone asks.
 */
async function start(): Promise<void> {
  const Ctor =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    publish({ unavailable: true, wanted: false, running: false });
    return;
  }
  if (!context) {
    context = new Ctor();
    build(context);
  }
  try {
    await context.resume();
  } catch {
    // Refused. The reader still wants it; the next gesture will try again.
    return;
  }
  fade(MASTER_GAIN, FADE_IN);
  publish({ running: true });
}

/** Stop sounding, without tearing the instrument down. */
function stop(): void {
  if (!context || !master) {
    publish({ running: false });
    return;
  }
  fade(0, FADE_OUT);
  const ctx = context;
  window.setTimeout(() => {
    // Only if nobody has asked for it again in the meantime.
    if (!state.wanted && ctx.state === 'running') void ctx.suspend();
  }, FADE_OUT * 1000 + 100);
  publish({ running: false });
}

/**
 * Tell the drone what the network is doing.
 *
 * Takes the rate whether or not anything is sounding, because the page measures
 * it whether or not anything is sounding: turning the sound on halfway through
 * a visit should open the filter where the traffic already is, not walk it up
 * from silence as though the room had just started.
 */
export function drive(perMin: number | null): void {
  rate = perMin;
  if (!context || !filter) return;
  filter.frequency.setTargetAtTime(cutoffFor(perMin), context.currentTime, FOLLOW);
}

/**
 * One tone for one verified message.
 *
 * SPACED, NOT DROPPED — which is the difference between a busy room sounding
 * busy and a busy room sounding like a quiet one. Messages do not arrive evenly:
 * a watcher hands over a second's worth at a time, and the first version of this
 * refused anything within ninety milliseconds of the last tone, so a batch of
 * twenty-five became a single note and lobby sounded exactly like a room nobody
 * was posting in. Tones are queued ninety milliseconds apart instead, up to
 * three quarters of a second ahead, and only what will not fit in that window is
 * dropped. A busy room fills it; a quiet one never reaches it.
 *
 * It is still not a count, and nothing anywhere presents it as one. Twenty-five
 * a second is more than this window holds. The rate lives in the drone, which
 * carries it exactly; the tones say who, not how many.
 */
export function ping(did: string | null | undefined): void {
  if (!context || !master || !state.running) return;
  const now = context.currentTime;
  const at = Math.max(now, lastPing + PING_GAP);
  if (at - now > PING_AHEAD) return;
  const hz = toneFor(did);
  if (hz == null) return;
  lastPing = at;

  const osc = context.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = hz;

  const env = context.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(PING_PEAK, at + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, at + PING_LENGTH);

  osc.connect(env);
  env.connect(master);
  osc.start(at);
  osc.stop(at + PING_LENGTH + 0.05);
  osc.onended = () => {
    osc.disconnect();
    env.disconnect();
  };
}

// --- the switch -------------------------------------------------------------

let armed = false;

/**
 * A stored "on" is a preference, not a licence to start.
 *
 * It waits for the first gesture on the page — any gesture, since the reader
 * has already asked for this on a previous visit and a browser will not resume
 * a context without one. If they never touch the page, it never sounds.
 */
function arm(): void {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  const go = () => {
    window.removeEventListener('pointerdown', go);
    window.removeEventListener('keydown', go);
    armed = false;
    if (state.wanted) void start();
  };
  window.addEventListener('pointerdown', go, { once: true });
  window.addEventListener('keydown', go, { once: true });
}

let watching = false;

/** Silence in a background tab, and only in a background tab. */
function watchVisibility(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('visibilitychange', () => {
    if (!context) return;
    if (document.visibilityState === 'hidden') {
      if (state.running) {
        fade(0, 0.25);
        void context.suspend();
        publish({ running: false });
      }
    } else if (state.wanted && !state.running) {
      void start();
    }
  });
}

/**
 * The switch, shared by every control that draws it.
 *
 * Two of them are on screen at once on /city — one in the camera's pill group
 * and one in the footer — and a second copy holding its own state would be a
 * second answer to "is the sound on", stale the moment the other was pressed.
 */
export function useAudio(): AudioState & { toggle: () => void } {
  const [snapshot, setSnapshot] = useState(state);

  useEffect(() => {
    // The stored choice is read here rather than at import: a module that
    // touched localStorage on load would do it during a server render too.
    if (!state.wanted && storedWanted()) {
      publish({ wanted: true });
      arm();
    }
    watchVisibility();

    const listener = () => setSnapshot(state);
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const toggle = useCallback(() => {
    const wanted = !state.wanted;
    store(wanted);
    publish({ wanted });
    if (wanted) void start();
    else stop();
  }, []);

  return { ...snapshot, toggle };
}
