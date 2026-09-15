// ThemeSwitch.tsx — the two-state pill in the nav.
//
// A SEGMENTED CONTROL, NOT A TOGGLE. A toggle with a moon on it means "dark
// mode", and neither of these palettes is a light mode — one is black and one is
// navy. Both names are visible at all times and the one you are in is the one
// that is lit, so the control says what it does without a tooltip and without
// the reader having to click it to find out.
//
// TWO BUTTONS RATHER THAN A RADIO GROUP because there is no form here and
// nothing is submitted: `aria-pressed` on each is the accurate description of a
// pair of buttons where exactly one is on, and it survives a screen reader
// better than a fieldset with no legend would.
//
// CONTROLLED, and the state lives in useTheme — see the note there. The nav
// renders two of these at phone widths and shows one.

import type { Theme } from '../theme.ts';
import { THEMES } from '../theme.ts';

export function ThemeSwitch({
  theme,
  onChoose,
  className = '',
}: {
  theme: Theme;
  onChoose: (next: Theme) => void;
  className?: string;
}) {
  return (
    <div className={className ? `tswitch ${className}` : 'tswitch'} aria-label="Theme">
      {THEMES.map((option) => (
        <button
          key={option.id}
          className="tswitch__opt"
          type="button"
          aria-pressed={option.id === theme}
          onClick={() => onChoose(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
