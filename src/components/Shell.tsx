// Shell.tsx — the parts of every page that are not that page.
//
// Nav, page header and colophon. A route says which page it is and gets the
// rest; it never writes a nav link of its own. Ported from js/shell.js, with
// PAGES still the single source of truth.

import { useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { PAGES, pageById } from '../pages';
import { REFEREE_DID } from '../lib/contest.ts';

function Nav({ currentId }: { currentId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <nav className="nav" aria-label="Foolscap">
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
 * Wrap a route in the shell.
 *
 * `page` names an entry in PAGES; the header comes from there, so the nav label
 * and the page title cannot drift apart.
 */
export function Shell({ page, children }: { page: string; children: ReactNode }) {
  const current = pageById(page);

  if (!current) {
    // Better a nav with nothing marked than a silent mismatch with the map.
    throw new Error(`Shell: no page registered as "${page}".`);
  }

  return (
    <>
      <Nav currentId={current.id} />
      <main className="shell">
        <header className="page-header">
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
