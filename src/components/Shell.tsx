// Shell.tsx — the parts of every page that are not that page.
//
// Nav, page header and colophon. A route says which page it is and gets the
// rest; it never writes a nav link of its own. Ported from js/shell.js, with
// PAGES still the single source of truth.

import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { PAGES, pageById } from '../pages';
import { REFEREE_DID } from '../lib/contest.ts';

function Nav({ currentId, over }: { currentId: string; over: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <nav className={over ? 'nav nav--over' : 'nav'} aria-label="Foolscap">
      <div className="nav__inner">
        <Link className="nav__mark" to="/">
          Foolscap
        </Link>

        <button
          className="nav__toggle"
          type="button"
          aria-controls="nav-links"
          aria-expanded={open}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
        >
          {open ? 'Close' : 'Menu'}
        </button>

        <ul className="nav__links" id="nav-links" data-open={open ? 'true' : 'false'}>
          {PAGES.map((page) => (
            <li key={page.id}>
              {page.available ? (
                <NavLink
                  className="nav__link"
                  to={page.path}
                  aria-current={page.id === currentId ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                >
                  {page.label}
                </NavLink>
              ) : (
                <span className="nav__link nav__link--soon" aria-disabled="true" title="Not built yet">
                  {page.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

/**
 * The same statement on every page. If it differed per page, one of them would
 * be the lie.
 */
function Colophon() {
  return (
    <footer className="colophon">
      <p>
        Foolscap reads. These pages hold no key, ask for none, and post nothing on your behalf.
        Apart from the Notary archive, everything runs in your browser against technocore.chat —
        the signature checking that decides what you are shown happens on your machine, not on a
        server you have to trust.
      </p>

      <p>
        Every receipt shown as authoritative was checked against the referee DID pinned in
        LAUNCH.md, and nothing else is trusted — never a room’s name, its owner, or who posts in
        it:
      </p>

      <p className="mono colophon__did">{REFEREE_DID}</p>

      <p>
        Source, and the reasoning behind every number:{' '}
        <a href="https://github.com/ace-coderr/foolscap">github.com/ace-coderr/foolscap</a>.
        Apache-2.0.
      </p>
    </footer>
  );
}

/**
 * How the page holds its content.
 *
 * `column` is every page: a measure-wide column under the header. `bleed` is the
 * City and, so far, only the City — a canvas under everything with the header
 * floating over it and the content in a panel. The variant changes the frame the
 * page sits in and nothing else; the nav, the header and the colophon are the
 * same parts from the same source either way.
 */
export type ShellVariant = 'column' | 'bleed';

/**
 * Wrap a route in the shell.
 *
 * `page` names an entry in PAGES; the header comes from there, so the nav label
 * and the page title cannot drift apart.
 */
export function Shell({
  page,
  variant = 'column',
  children,
}: {
  page: string;
  variant?: ShellVariant;
  children: ReactNode;
}) {
  const current = pageById(page);

  // Above the guard below, so the hook runs on every render this component has.
  // The tab title is part of the page header, so it comes from the same place —
  // routing between pages without it would leave every tab saying "City".
  useEffect(() => {
    if (current) document.title = `${current.label} · Foolscap`;
  }, [current]);

  if (!current) {
    // Better a nav with nothing marked than a silent mismatch with the map.
    throw new Error(`Shell: no page registered as "${page}".`);
  }

  const bleed = variant === 'bleed';

  return (
    <>
      <Nav currentId={current.id} over={bleed} />
      <main className={bleed ? 'shell shell--bleed' : 'shell'}>
        <header className={bleed ? 'page-header page-header--float' : 'page-header'}>
          <p className="page-header__eyebrow">{current.eyebrow}</p>
          <h1 className="page-header__title">{current.title}</h1>
          <p className="page-header__line">{current.line}</p>
        </header>
        {children}
      </main>
      <Colophon />
    </>
  );
}
