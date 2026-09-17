// Sound.tsx — the one switch, drawn twice.
//
// The mark and the words live here rather than in either of the two places that
// show them, for the reason the nav's theme switch gives: two controls for one
// setting have to say the same thing about it, and the way to guarantee that is
// for there to be one of them. /city puts the speaker in the camera's pill
// group, every page including /city carries the labelled one in the footer, and
// both read the same state out of useAudio.
//
// WHAT THE LABEL SAYS IS WHAT IS TRUE. There are three states, not two: off,
// sounding, and asked-for-but-not-yet-started — which is what a stored choice
// looks like before the first gesture, because a browser will not start a
// context without one and this file will not ask it to. A control claiming
// "sound on" over silence would be the smallest possible version of the thing
// this whole site is against.

import type { AudioState } from '../audio';
import { useAudio } from '../audio';

/**
 * WORDED TO BE TRUE ON EVERY PAGE. The City is the only page that measures a
 * rate and the only one with a live view to take tones from, so it is the only
 * page that drives this — and the switch is in the footer everywhere. "From the
 * live readings" would be a claim about /lens or /vault that nothing there
 * makes; naming the City says where the sound comes from and, by omission, that
 * it comes from nowhere else.
 */
export function soundTitle(sound: AudioState): string {
  if (!sound.wanted) {
    return 'Ambient sound — off. A drone the City drives from what it is reading, generated here rather than played back.';
  }
  if (!sound.running) return 'Ambient sound — on, and waiting for a click before it can start.';
  return 'Ambient sound — on. Click to silence.';
}

/** A speaker, with the waves struck through when it is off. */
export function Speaker({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.6 7.6h2.4l3.2-2.6v10l-3.2-2.6H4.6z" />
      {on ? (
        <>
          <path d="M13 7.4a3.6 3.6 0 0 1 0 5.2" />
          <path d="M15.2 5.4a6.6 6.6 0 0 1 0 9.2" />
        </>
      ) : (
        <path d="M13.2 8.2l3.6 3.6M16.8 8.2l-3.6 3.6" />
      )}
    </svg>
  );
}

/**
 * The footer's copy of it, with the words on.
 *
 * In the footer because that is where the page already says what it does and
 * does not do — no key, nothing posted, no server — and a sound the page can
 * make belongs in that list rather than hidden behind an icon on one route.
 */
export function SoundControl() {
  const sound = useAudio();
  if (sound.unavailable) return null;

  return (
    <button
      type="button"
      className="fsound"
      aria-pressed={sound.wanted}
      onClick={sound.toggle}
      title={soundTitle(sound)}
    >
      <Speaker on={sound.wanted} />
      <span>
        Ambient sound
        <span className="fsound__state">
          {!sound.wanted ? 'off' : sound.running ? 'on' : 'on, at your next click'}
        </span>
      </span>
    </button>
  );
}
