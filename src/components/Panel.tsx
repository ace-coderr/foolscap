// Panel.tsx — the container, once.
//
// DESIGN.md's diagnosis, in one line: "everything sits directly on the page
// ground, a hairline is the only device separating one region from another, so
// nothing feels grouped, contained, or deliberate." Six pages each invented
// their own boxes. This is the box.
//
// One component, four surface levels, and no shadows — on near-black a shadow
// reads as a smudge, so elevation is carried by surface value and border alone.
//
// THE HEADER IS OPTIONAL, THE BORDER IS NOT. A panel without an edge is not a
// panel; it is the thing this file exists to stop.
//
// Variants:
//   flush   no body padding, for a table or list that draws its own rows.
//   scroll  capped height with internal scroll and a header that stays put.
//
// If a page needs a container this cannot express, DESIGN.md says change the
// panel rather than write a different box beside it. That instruction is the
// whole point of the file and is repeated here because the next person to need
// a slightly different container will be reading this, not that.

import type { ReactNode } from 'react';

export function Panel({
  title,
  action,
  flush = false,
  scroll = false,
  maxHeight,
  children,
  className = '',
  labelledBy,
  ...rest
}: {
  /** Omit for a panel with no header. */
  title?: ReactNode;
  /** Sits at the right of the header: a control, a count, a filter. */
  action?: ReactNode;
  flush?: boolean;
  scroll?: boolean;
  /** Only meaningful with `scroll`. A CSS length. */
  maxHeight?: string;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  id?: string;
}) {
  const hasHeader = title != null || action != null;
  const classes = [
    'panel2',
    flush ? 'panel2--flush' : '',
    scroll ? 'panel2--scroll' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={classes} aria-labelledby={labelledBy} {...rest}>
      {hasHeader && (
        <header className="panel2__head">
          {title != null && <h2 className="panel2__title">{title}</h2>}
          {action != null && <div className="panel2__action">{action}</div>}
        </header>
      )}
      <div
        className="panel2__body"
        style={scroll && maxHeight ? { maxHeight } : undefined}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * The six states, as one component, so no page improvises them again.
 *
 * DESIGN.md: "Only the populated state was designed… which is why the loading
 * text was a whisper and the empty lobby was a sentence." Every list and pane
 * has to specify all six before it is built, and four of them look the same
 * wherever they appear — so they are drawn here rather than described six
 * times.
 *
 * `populated` and `sparse` are not here on purpose: they are content, and the
 * only thing a shared component could do for sparse is the thing that makes it
 * look broken, which is stretch one row to fill a pane.
 */
export function PaneState({
  state,
  title,
  detail,
  action,
}: {
  state: 'loading' | 'empty' | 'failed';
  /** One line. For `empty`, say WHY it is empty. */
  title: string;
  /** For `empty`, what to do about it. For `failed`, whether to retry. */
  detail?: ReactNode;
  action?: ReactNode;
}) {
  if (state === 'loading') {
    // A sweeping rule: the one loading treatment on this site that reads as
    // work happening rather than as a caption.
    return (
      <p className="pstate pstate--loading" role="status">
        {title}
        <span className="pstate__rule" aria-hidden="true" />
      </p>
    );
  }
  return (
    <div className={`pstate pstate--${state}`} role={state === 'failed' ? 'alert' : undefined}>
      <p className="pstate__title">{title}</p>
      {detail && <p className="pstate__detail">{detail}</p>}
      {action && <div className="pstate__action">{action}</div>}
    </div>
  );
}

/**
 * The cap notice, for the overflowing state.
 *
 * Every long list on this site is capped, because the stores behind them are
 * not: a namespace holds 250,000 notes and a busy room's export is tens of
 * thousands of lines. DESIGN.md requires the cap be stated with a way to see
 * more, and this is that sentence in one place so it is worded the same way
 * everywhere.
 */
export function CapNotice({
  shown,
  total,
  noun,
  how,
}: {
  shown: number;
  total: number;
  noun: string;
  /** How to reach the rest. "Filtering searches all of them." */
  how: string;
}) {
  if (shown >= total) return null;
  const fmt = new Intl.NumberFormat('en');
  return (
    <p className="pcap">
      Showing {fmt.format(shown)} of {fmt.format(total)} {noun}. {how}
    </p>
  );
}
