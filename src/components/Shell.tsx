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

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useInView, useParallax, usePrefersReducedMotion } from '../motion';
import { startPointerField } from '../pointer';
import { Link, NavLink } from 'react-router-dom';
import { PAGES, pageById } from '../pages';
import { Lockup } from './Mark';
import { ThemeSwitch } from './ThemeSwitch';
import { useTheme } from '../theme';

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
 * THE SITE'S NAV — every page, including the hero.
 *
 * It was the hero's alone, which is why it is still exported as HeroNav. When
 * the tools joined the landing's design system they took its nav with them:
 * a second nav with its own scroll behaviour would have been the same two-sites
 * problem in a different place.
 *
 * Wordmark left, links centred, one action right.
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
export function HeroNav({
  action,
  currentId = '',
}: {
  action: { label: string; to: string };
  currentId?: string;
}) {
  const [floating, setFloating] = useState(false);
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const { theme, choose } = useTheme();

  useEffect(() => {
    const onScroll = () =>
      setFloating((was) => window.scrollY > (was ? SETTLE_AT : FLOAT_AT));
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /**
   * What the nav occupies at the top of the window, published as --nav-height
   * for every page that has to begin below it.
   *
   * MEASURED, NOT DESCRIBED. It was a constant, and a constant cannot know
   * this nav: its padding is a clamp, the row is as tall as the action pill,
   * under 56rem the six links drop to a second row, and by 320 they wrap to a
   * third. Every attempt to write that as arithmetic is the nav's own CSS
   * restated in a second place, and it was wrong by 29px at 320 — where /city
   * puts its floating header at exactly this value, so the header sat on top
   * of the links.
   *
   * The TOP-state height, and held while the nav is floating. As a pill it is
   * meant to have content scroll under it, and a value that shrank on scroll
   * would pull the first line of every page upward as the reader moved. The
   * property is never removed, for the same reason: releasing it mid-session
   * would drop the page back to the stylesheet's estimate in one frame.
   */
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || floating || typeof ResizeObserver === 'undefined') return;
    // The rect, not offsetHeight: that rounds to whole pixels, and /city sets
    // its floating header at exactly this value, so rounding down is the
    // header starting a fraction inside the nav.
    const write = () =>
      document.documentElement.style.setProperty(
        '--nav-height',
        `${nav.getBoundingClientRect().height}px`
      );
    write();
    const observer = new ResizeObserver(write);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [floating]);

  // The menu belongs to the floating state; coming back to the top takes the
  // button away, and a panel with no button to close it is a trap.
  useEffect(() => {
    if (!floating) setOpen(false);
  }, [floating]);

  return (
    <nav className="hero__nav" data-floating={floating} aria-label="Foolscap" ref={navRef}>
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
        <NavItems currentId={currentId} className="hero__nav-link" onNavigate={() => setOpen(false)} />
        {/* Shown only inside the open menu panel, which is only a thing at phone
            widths in the floating state — the one arrangement where the switch
            has nowhere else to be. See the note in useTheme. */}
        <li className="hero__nav-themeitem">
          <ThemeSwitch theme={theme} onChoose={choose} />
        </li>
      </ul>

      {/* One grid cell holding both, rather than a fifth column: the nav is a
          three-column grid with named areas at narrow, and a new top-level child
          would have landed in the links column and pushed the action onto a row
          of its own.

          The switch comes first, so the action stays the last thing in the row
          on every page and at every width — it is the one thing the nav is
          asking you to do. */}
      <div className="hero__nav-right">
        <ThemeSwitch theme={theme} onChoose={choose} />
        <Link className="hero__pill hero__pill--solid hero__nav-action" to={action.to} data-magnetic>
          {action.label}
        </Link>
      </div>
    </nav>
  );
}

/**
 * The nav's one action.
 *
 * Every page offers the same way in — the tracker is the tool with an answer a
 * stranger can use immediately — except the tracker itself, which would
 * otherwise carry a button to where you already are.
 */
function navAction(currentId: string): { label: string; to: string } {
  return currentId === 'track'
    ? { label: 'Open the city', to: '/city' }
    : { label: 'Open the tracker', to: '/track' };
}

/**
 * Reveal every section as it arrives, without each page having to say so.
 *
 * One observer in the shell rather than a wrapper component per section: the
 * pages already mark their sections with `.section`, so the markup that would
 * have been added carries no information the class does not. Sections already on
 * screen at load are revealed immediately by the observer's first callback,
 * which is what stops the top of a page fading in under the reader.
 */
function useSectionReveals(deps: unknown): void {
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>('main .section'));
    if (reduced) {
      sections.forEach((section) => section.setAttribute('data-in', 'true'));
      return;
    }

    sections.forEach((section, i) => {
      section.setAttribute('data-in', 'false');
      section.style.setProperty('--rise-i', String(Math.min(i, 3)));
    });

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute('data-in', 'true');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px' }
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [reduced, deps]);
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
 * THE CLAIM GOT SHORTER AND STRONGER when the archive came out. It used to read
 * "no backend except Notary's archive", and an exception in a trust statement is
 * the part a sceptical reader stops at. There is no exception now: nothing here
 * has a server behind it, and that is worth saying plainly because it is the
 * kind of thing that is easy to say and hard to go back on.
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
          <p className="footer__headline rise">Read it while it is still there.</p>
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
            Foolscap reads and nothing else: it holds no key, asks for none, posts nothing on your
            behalf, and runs no server. The whole site is static files; every request goes from
            your browser to technocore.chat with nothing of ours in between, and every signature
            that decides what you are shown is checked on your own machine.
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
 * `column` is the default: a measure-wide column under the header. `bleed` is
 * the City and, so far, only the City — a canvas under everything with the
 * header floating over it and the content in a panel. `console` is DESIGN.md's
 * pattern B: the page capped at 62rem and centred, header included.
 *
 * There was a fourth, `bands` — full-width sections each with their own inner
 * measure, the landing's composition applied to a tool. It went with the only
 * page that used it. The frame is in the history if a page wants it again.
 *
 * The variant changes the frame the page sits in and nothing else; the nav and
 * the footer are the same parts from the same source in all of them.
 */
export type ShellVariant = 'column' | 'bleed' | 'console';

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
  // Pattern B caps its content at 62rem and centres it, and the page header has
  // to be capped and centred with it or the page has two left edges.
  const console_ = variant === 'console';

  // The same pointer field the landing runs: one listener, one rAF loop, the
  // glow following the cursor and the grid brightening under it. Queried rather
  // than passed by ref because the field re-reads its targets, and the grid
  // comes and goes with `bleed`.
  useEffect(
    () =>
      startPointerField({
        glow: () => document.querySelector<HTMLElement>('.cursor-glow'),
        grids: () => Array.from(document.querySelectorAll<HTMLElement>('[data-grid]')),
        magnets: () => Array.from(document.querySelectorAll<HTMLElement>('[data-magnetic]')),
      }),
    []
  );

  useSectionReveals(current.id);

  return (
    <div className="page">
      {/* Wallpaper, then the light over it. Both fixed and both inert: they
          follow the pointer, never the scroll, so a long page does not drag a
          grid up past its own content. */}
      {!bleed && <div className="page__grid" aria-hidden="true" data-grid />}
      <div className="cursor-glow" aria-hidden="true" />

      <HeroNav action={navAction(current.id)} currentId={current.id} />

      <main className={`shell${bleed ? ' shell--bleed' : ''}${console_ ? ' shell--console' : ''}`}>
        {/* Straight off PAGES, so the nav label and the page title cannot drift
            apart — the rule that one link cannot exist on four of six pages
            holds because nothing is written twice, not because this component
            is the only thing allowed to render it.

            A BLEED PAGE PLACES ITS OWN, and PAGES is still where it comes
            from. The City is a canvas with panels floating on it, and its
            title belongs inside the first panel, above the figures — a header
            floating separately over the drawing was a second panel with no
            edges, and the canvas had to measure it and shift the whole city
            out from underneath. The rule this is under is that the words come
            from PAGES, not that this component is the only thing allowed to
            print them; see City.tsx, which reads the same entry. */}
        {!bleed && (
          <header className="page-header">
            <p className="page-header__eyebrow">{current.eyebrow}</p>
            <h1 className="page-header__title">{current.title}</h1>
            <p className="page-header__line">{current.line}</p>
          </header>
        )}
        {children}
      </main>
      <Footer />
    </div>
  );
}
