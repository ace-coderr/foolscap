// Listbox.tsx — a select that Foolscap actually draws.
//
// WHY THIS EXISTS. A native <select> renders its popup as operating-system
// chrome, and the page has no reliable say over the ground that popup sits on.
// On /bench the shape picker inherited `background: var(--paper-sunk)` —
// rgba(255,255,255,0.03), glass rather than a colour. Over the page's black
// that reads white-on-dark; inside the OS popup it resolved against a white
// surface and every option went invisible. The control looked correct and its
// contents could not be read.
//
// The general rule that came out of it, and it is the reason this is a
// component rather than a patch: NEVER HAND A COLOUR TO SYSTEM CHROME AND
// ASSUME THE GROUND UNDER IT. Either give the chrome an opaque ground of its
// own, or stop using chrome. This does the second.
//
// ACCESSIBILITY IS NOT A LAYER ON TOP. A native select is keyboard-operable,
// screen-reader-announced and focus-managed for free, and every one of those has
// to be rebuilt here or this is a downgrade wearing better colours:
//
//   role="listbox" on the panel, role="option" on each row, aria-selected on
//   the current one, aria-expanded and aria-activedescendant on the control, so
//   a screen reader is told what this is and where it is.
//
//   Enter, Space and ArrowDown open it. Arrows move the active option without
//   committing, Home and End jump, Enter and Space commit, Escape closes and
//   changes nothing. Focus returns to the control on every exit, because focus
//   that vanishes into a closed panel is a keyboard trap.
//
//   Tab closes it and moves on, which is what a native select does.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export interface Choice {
  value: string;
  /** Shown in mono: the thing being chosen. */
  name: string;
  /** Shown beside it, quieter. Optional. */
  description?: string;
}

export function Listbox({
  id,
  label,
  choices,
  value,
  onChange,
}: {
  id: string;
  /** Names the control for a screen reader; the visible label is the caller's. */
  label: string;
  choices: Choice[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpenState] = useState(false);
  /**
   * Open, readable synchronously — the same fix as activeRef below and for the
   * same reason. The key handler closed over `open` from the last render, so
   * Enter-then-ArrowDown inside one frame saw the picker as still shut, took
   * the "open it" branch a second time, and never moved the highlight. Both
   * flags are mirrored rather than one, because a handler that reads half its
   * state from a ref and half from a closure is worse than either.
   */
  const openRef = useRef(false);
  const setOpen = useCallback((next: boolean) => {
    openRef.current = next;
    setOpenState(next);
  }, []);
  const [active, setActiveState] = useState(0);
  /**
   * The active index, readable synchronously.
   *
   * THE RACE THIS FIXES: the key handler closes over `active` from the last
   * render, so ArrowDown followed by Enter inside one frame — which is an
   * ordinary fast keypress, not a stress test — read the index from before the
   * arrow moved and committed the option above the one highlighted. Caught by
   * driving the keyboard rather than by reading the code.
   */
  const activeRef = useRef(0);
  const setActive = useCallback((next: number) => {
    activeRef.current = next;
    setActiveState(next);
  }, []);
  const controlRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const selectedIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === value)
  );
  const selected = choices[selectedIndex] ?? choices[0];

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      if (refocus) controlRef.current?.focus();
    },
    [setOpen]
  );

  const commit = useCallback(
    (index: number) => {
      const choice = choices[index];
      if (choice) onChange(choice.value);
      close();
    },
    [choices, onChange, close]
  );

  /** Whatever is highlighted right now, not whatever was at the last render. */
  const commitActive = useCallback(() => commit(activeRef.current), [commit]);

  // Opening lands on what is already chosen, not at the top: a picker that
  // forgot where you were would make changing a nearby option a scroll.
  useEffect(() => {
    if (open) setActive(selectedIndex);
  }, [open, selectedIndex]);

  /**
   * Outside click and scroll both close it.
   *
   * The scroll listener is capturing and passive so it sees scrolls in any
   * container, not only the window — an absolutely positioned panel does not
   * follow its control, so a panel left open through a scroll ends up detached
   * from the thing it belongs to.
   */
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (controlRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  // Keep the active option in view when the arrows walk past the panel's edge.
  useLayoutEffect(() => {
    if (!open) return;
    const node = panelRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!openRef.current) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
        // ArrowDown opens AND moves, as a native select does. Without this the
        // first arrow is swallowed by the opening and the highlight sits where
        // it started.
        if (event.key === 'ArrowDown') setActive(Math.min(choices.length - 1, selectedIndex));
      }
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close();
        break;
      case 'Tab':
        // No preventDefault: Tab should move on, as it does from a native one.
        setOpen(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActive(Math.min(choices.length - 1, activeRef.current + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(Math.max(0, activeRef.current - 1));
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(choices.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commitActive();
        break;
      default:
        break;
    }
  };

  return (
    <div className="listbox">
      <button
        className="listbox__control"
        type="button"
        id={id}
        ref={controlRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => setOpen(!openRef.current)}
        onKeyDown={onKeyDown}
      >
        <span className="listbox__value">
          <span className="listbox__name">{selected?.name}</span>
          {selected?.description && (
            <span className="listbox__desc">{selected.description}</span>
          )}
        </span>
        <span className="listbox__caret" aria-hidden="true" />
      </button>

      {open && (
        <ul
          className="listbox__panel"
          id={listId}
          role="listbox"
          aria-label={label}
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {choices.map((choice, index) => (
            <li
              className="listbox__option"
              key={choice.value}
              id={`${listId}-${index}`}
              data-index={index}
              data-active={index === active ? 'true' : 'false'}
              role="option"
              aria-selected={choice.value === value}
              // mousedown, not click: the outside-click handler runs on
              // mousedown, and a click handler would fire after the panel had
              // already been told to close.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(index);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span className="listbox__name">{choice.name}</span>
              {choice.description && <span className="listbox__desc">{choice.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
