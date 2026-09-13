// Shell.tsx — the parts of every page that are not that page.
//
// Nav, page header and footer. A route says which page it is and gets the
// rest; it never writes a nav link of its own. Ported from js/shell.js, with
// PAGES still the single source of truth.
//
// The hero at `/` does not use the Shell — it is a full-bleed page with its own
// layout — but it does use this nav, exported below as HeroNav. That is the
// point of the rule in SHELL.md: a second nav written by hand is how a link ends
// up on four of six pages. Different chrome, same map.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useInView, useParallax } from '../motion';
import { Link, NavLink } from 'react-router-dom';
import { PAGES, pageById } from '../pages';
import { Lockup } from './Mark';

/**
 * The author's own key, published as authorship.
 *
 * Not the referee's. The referee DID is pinned in contest.ts and belongs on the
 * Tracker, which is the only page that verifies anything against it; carrying it
 * in a footer on every page would put a sonnet-2 key in front of people reading
 * about something else, and a key shown where it is not doing a job is a key
 * someone can mistake for one that is.
 */
const AUTHOR_DID = 'did:key:z6Mko5gbL5nHyfofMpxdVPFWChStScejMzJ3HtPRUzKdkEnd';

/** Links, from PAGES, in whatever chrome the page wraps them in. */
function NavItems({
  currentId,
  className,
  onNavigate,
}: {
  currentId: string;
  className: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      {PAGES.map((page) => (
        <li key={page.id}>
          {page.available ? (
            <NavLink
              className={className}
              to={page.path}
              aria-current={page.id === currentId ? 'page' : undefined}
              onClick={onNavigate}
            >
              {page.label}
            </NavLink>
          ) : (
            <span className={`${className} ${className}--soon`} aria-disabled="true" title="Not built yet">
              {page.label}
            </span>
          )}
        </li>
      ))}
    </>
  );
}

/** Where the nav stops sitting on the page and starts floating over it. */
const FLOAT_AT = 80;
/** ...and where it settles back. The gap is what stops it flickering on the
 *  threshold, which would be a worse jump than the one being avoided. */
const SETTLE_AT = 48;

/**
 * The hero's nav: wordmark left, links centred, one action right.
 *
 * `currentId` is empty because the hero is not one of the six pages: it is the
 * way in, reached from the wordmark that every other page already carries.
 *
 * IT IS FIXED IN BOTH STATES, which is the whole trick. Going from in-flow to
 * fixed at the scroll threshold would be a discontinuity no transition can
 * cover — the element would leave the layout and land somewhere else in the
 * same frame. Fixed from the start means the two states differ only in
 * properties that interpolate, so the morph is genuinely a morph.
 *
 * At the top it is transparent, full width and sitting exactly where the hero's
 * first row used to put it, so nothing appears to have moved.
 */
export function HeroNav({ action }: { action: { label: string; to: string } }) {
  const [floating, setFloating] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () =>
      setFloating((was) => window.scrollY > (was ? SETTLE_AT : FLOAT_AT));
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // The menu belongs to the floating state; coming back to the top takes the
  // button away, and a panel with no button to close it is a trap.
  useEffect(() => {
    if (!floating) setOpen(false);
  }, [floating]);

  return (
    <nav className="hero__nav" data-floating={floating} aria-label="Foolscap">
      <Link className="hero__mark" to="/" onClick={() => setOpen(false)}>
        <Lockup />
      </Link>

      {/* Only ever shown in the floating state on a narrow screen, where the
          six links do not fit in a pill. */}
      <button
        className="hero__nav-toggle"
        type="button"
        aria-controls="hero-nav-links"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {open ? 'Close' : 'Menu'}
      </button>

      <ul className="hero__nav-links" id="hero-nav-links" data-open={open ? 'true' : 'false'}>
        <NavItems currentId="" className="hero__nav-link" onNavigate={() => setOpen(false)} />
      </ul>

      <Link className="hero__pill hero__pill--solid hero__nav-action" to={action.to} data-magnetic>
        {action.label}
      </Link>
    </nav>
  );
}

function Nav({ currentId, over }: { currentId: string; over: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <nav className={over ? 'nav nav--over' : 'nav'} aria-label="Foolscap">
      <div className="nav__inner">
        <Link className="nav__mark" to="/">
          <Lockup />
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
          <NavItems currentId={currentId} className="nav__link" onNavigate={() => setOpen(false)} />
        </ul>
      </div>
    </nav>
  );
}

/**
 * The footer, on every page.
 *
 * It replaces the colophon and carries what the colophon carried, because that
 * copy was never decoration: no key, nothing posted, and the referee DID this
 * whole product pins rather than infers. A footer that dropped it to make room
 * for a call to action would be trading the one claim Foolscap has to make for
 * the one it has to sell.
 *
 * The links are PAGES again — the same six rows as the nav, the page headers and
 * the landing's tool cards — so an unbuilt tool is grey and unlinked here for
 * exactly the reason it is there, and shipping one still changes a single line.
 *
 * No accent. Nothing in here is state.
 */
export function Footer() {
  const wordmark = useParallax<HTMLDivElement>(2);
  const [ref, seen] = useInView<HTMLElement>();

  return (
    <footer className="footer" ref={ref} data-in={seen}>
      {/* Behind everything, clipped by the footer's own edge. Decorative: the
          name is already in the nav and in the page's own heading. */}
      <div className="footer__wordmark" aria-hidden="true" ref={wordmark}>
        Foolscap
      </div>

      <div className="footer__inner">
        <div className="footer__call">
          <p className="footer__headline rise">Keep what the network drops.</p>
          <p className="footer__sub rise" style={{ '--rise-i': 1 } as CSSProperties}>
            Paste a <span className="footer__mono">request_id</span> or a{' '}
            <span className="footer__mono">did:key</span> and see where it actually stands —
            read live from technocore.chat, verified in your browser.
          </p>
          <Link
            className="footer__cta rise"
            to="/track"
            style={{ '--rise-i': 2 } as CSSProperties}
            data-magnetic
          >
            Track a request
          </Link>
        </div>

        <ul className="footer__nav rise" style={{ '--rise-i': 3 } as CSSProperties}>
          <NavItems currentId="" className="footer__link" />
        </ul>

        <div className="footer__meta rise" style={{ '--rise-i': 4 } as CSSProperties}>
          <div className="footer__who">
            <Lockup className="footer__lockup" />
            <p className="footer__by">
              <span>Built by</span>
              <a
                className="byline"
                href="https://x.com/_ace_won"
                target="_blank"
                rel="noopener noreferrer"
              >
                ace
              </a>
            </p>
            <p className="footer__did">
              <span className="footer__did-label">Author&rsquo;s DID</span>
              <span className="footer__did-value">{AUTHOR_DID}</span>
            </p>
          </div>

          <p className="footer__trust">
            Foolscap reads and nothing else: it holds no key, asks for none, and posts nothing on
            your behalf. Every signature that decides what you are shown is checked in your
            browser.
          </p>

          <div className="footer__refs">
            <p className="footer__links">
              <a
                href="https://github.com/ace-coderr/foolscap"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
              <span className="footer__sep" aria-hidden="true">
                ·
              </span>
              <a
                href="https://github.com/ace-coderr/foolscap/blob/main/LICENSE"
                target="_blank"
                rel="noopener noreferrer"
              >
                Apache-2.0
              </a>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}

/**
 * How the page holds its content.
 *
 * `column` is every page: a measure-wide column under the header. `bleed` is the
 * City and, so far, only the City — a canvas under everything with the header
 * floating over it and the content in a panel. The variant changes the frame the
 * page sits in and nothing else; the nav, the header and the footer are the same
 * parts from the same source either way.
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
      <Footer />
    </>
  );
}
