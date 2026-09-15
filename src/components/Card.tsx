// Card.tsx — a thing being offered.
//
// DESIGN.md's amendment: cards go "on the landing tools grid, the Lens room
// list, the Vault namespace list, the Notary anchor entries, and anywhere else a
// thing is being offered rather than tabulated."
//
// THE LAST FOUR WORDS ARE THE RULE. A card is for something the reader might
// choose; a row is for something they are reading down a column of. A list of
// sixty rooms you are scanning is tabulated, and turning it into sixty cards
// would put three of them on screen at once. Offer with cards, tabulate with
// rows, and when the two disagree the question to ask is which one the reader
// is doing.
//
// THE VISUAL BLOCK IS REQUIRED, which is the other half of the same rule: "a
// card without one is a row, and should be a row instead." It is a required
// prop rather than an optional one so that the choice is made at the call site
// rather than discovered on screen.
//
// NEVER A STOCK ICON. Every visual on this site is derived from its own data —
// a glyph from a key, a column of bars from a room's own verification mix, a
// field of marks from the keys in a namespace. An icon font would be a picture
// of the category rather than a picture of the thing.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface CardProps {
  /**
   * The visual block. Required — see above. Anything that draws from the card's
   * own data: a Glyph, a bar column, a field of marks.
   */
  visual: ReactNode;
  title: ReactNode;
  /** One line on what it is. */
  detail?: ReactNode;
  /** Small facts. Each gets a mark; none of them gets an icon. */
  meta?: ReactNode[];
  /** A route. Renders the pill as a link. */
  to?: string;
  /** ...or a handler, which renders it as a button. `to` wins if both are given. */
  onClick?: () => void;
  actionLabel?: string;
  /** Renders the pill as disabled text — for a tool that does not exist yet. */
  disabled?: boolean;
  className?: string;
}

// THERE IS NO `current` PROP, and there was one for about an hour. A card is a
// thing being offered; the thing you are currently looking at is a row in a
// list, and a list you navigate with is tabulated. Marking a card as current
// would be the first step in turning the card back into a row, which is the
// distinction this component exists to hold. If a page turns out to need it,
// the honest fix is probably that the page wanted rows.

export function Card({
  visual,
  title,
  detail,
  meta,
  to,
  onClick,
  actionLabel = 'Open',
  disabled = false,
  className = '',
}: CardProps) {
  const classes = className ? `card2 ${className}` : 'card2';

  return (
    <article className={classes}>
      {/* aria-hidden: every visual here is a redrawing of something already
          written in the card's own text. A screen reader that announced it
          would be announcing the title twice. */}
      <div className="card2__visual" aria-hidden="true">
        {visual}
      </div>

      <div className="card2__text">
        <h3 className="card2__title">{title}</h3>
        {detail != null && <p className="card2__detail">{detail}</p>}
      </div>

      {meta != null && meta.length > 0 && (
        <ul className="card2__meta">
          {meta.map((item, i) => (
            // The marks are decorative and the text beside each one is not, so
            // the mark is a pseudo-element in CSS rather than a character here.
            <li className="card2__fact" key={i}>
              {item}
            </li>
          ))}
        </ul>
      )}

      {disabled ? (
        <span className="card2__open card2__open--off" aria-disabled="true">
          {actionLabel}
        </span>
      ) : to ? (
        <Link className="card2__open" to={to}>
          {actionLabel}
        </Link>
      ) : onClick ? (
        <button className="card2__open" type="button" onClick={onClick}>
          {actionLabel}
        </button>
      ) : null}
    </article>
  );
}

/**
 * A bar column: a small distribution, drawn from the thing's own numbers.
 *
 * The Lens room card's visual. Twelve bars of the room's recent
 * verified/unsigned/failed mix, in the order they arrived, so the shape says
 * something a count cannot — three red bars together is a burst, three spread
 * out is background noise.
 *
 * Heights are relative to the tallest bar and floored, because a bar of zero
 * height is indistinguishable from a bar that is not there.
 */
export function BarColumn({
  values,
  tone,
  height = 88,
}: {
  values: number[];
  /** Per-bar tone class suffix: 'ok' | 'warn' | 'bad'. Defaults to 'ok'. */
  tone?: Array<'ok' | 'warn' | 'bad'>;
  height?: number;
}) {
  const peak = Math.max(1, ...values);
  return (
    <div className="bars" style={{ height }} aria-hidden="true">
      {values.map((value, i) => (
        <span
          key={i}
          className={`bars__bar bars__bar--${tone?.[i] ?? 'ok'}`}
          style={{ height: `${Math.max(6, Math.round((value / peak) * 100))}%` }}
        />
      ))}
    </div>
  );
}

/**
 * A 5x5 field of marks, set where a thing is present.
 *
 * The Vault namespace card's visual: one cell per sampled key, set where that
 * key is still there. It takes which ones rather than how many, because a count
 * drawn as a filled bar in a grid would be a bar chart pretending to be a
 * sample — and the thing worth seeing here is that the gaps move.
 *
 * Deliberately the same geometry as a Glyph so the two read as one family, and
 * deliberately NOT mirrored, so a sample is never mistaken for an identity.
 */
export function MarkField({ present }: { present: boolean[] }) {
  return (
    <div className="mfield" aria-hidden="true">
      {Array.from({ length: 25 }, (_, i) => (
        <span key={i} className="mfield__cell" data-on={present[i] ? 'true' : 'false'} />
      ))}
    </div>
  );
}
