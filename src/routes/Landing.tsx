// Landing.tsx — the front door.
//
// One screen: grid, wordmark, sphere, a paragraph, a card. The sphere is the
// only part carrying information, and what it carries is narrow and true — a
// point pulses when a signed message arrived and its signature checked, in this
// browser, against its own DID. Nothing on this page is a count of anything, a
// status, or a claim about the network's health. The City answers that, and it
// took a page of caveats to answer it honestly; a hero cannot carry those, so it
// does not make the claim.
//
// The layer order matters and is set in the CSS: grid, glow, arc, wordmark,
// sphere, chrome. The sphere sits ABOVE the wordmark — additive blending over
// white glyphs adds nothing visible, so the points can only show in the black
// between the letters, which is exactly the overlap wanted and impossible to get
// wrong.

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Colophon, HeroNav } from '../components/Shell';
import { useLivePulse, type LiveFeed } from '../hero/useLivePulse';
import { num } from '../format';
import '../styles/hero.css';

/** Three.js is the City's weight and the hero's; neither makes the Tracker pay. */
const SignatureSphere = lazy(() => import('../hero/SignatureSphere'));

function usePrefersReducedMotion(): boolean {
  const query = useMemo(
    () =>
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null,
    []
  );
  const [reduced, setReduced] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, [query]);
  return reduced;
}

export default function Landing() {
  const feed = useLivePulse();
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    document.title = 'Foolscap';
    // The hero is pure black edge to edge, and the page it sits in is not. The
    // class is removed on the way out so no other route inherits it.
    document.body.classList.add('on-black');
    return () => document.body.classList.remove('on-black');
  }, []);

  return (
    <div className="landing">
      <div className="hero">
        <div className="hero__grid" aria-hidden="true" />
        <div className="hero__glow" aria-hidden="true" />

        <svg className="hero__arc" viewBox="0 0 1000 1000" aria-hidden="true">
          <path
            d="M 101.6 730 A 460 460 0 1 1 898.4 730"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="2 11"
            strokeLinecap="round"
          />
        </svg>

        <div className="hero__wordmark" aria-hidden="true">
          <span>Foolscap</span>
        </div>

        <Suspense fallback={null}>
          <SignatureSphere subscribe={feed.subscribe} reducedMotion={reducedMotion} />
        </Suspense>

        <div className="hero__chrome">
          <HeroNav action={{ label: 'Open the tracker', to: '/track' }} />

          {/* The wordmark above is decorative — this is the page's real heading,
              and it is the one a screen reader gets. */}
          <h1 className="hero__sr-title">Foolscap</h1>

          <div className="hero__foot">
            <div className="hero__copy">
              <p>
                Technocore forgets. Its rooms are rings: a busy one drops what it holds within
                hours, and a note left idle is reclaimed inside a week.
              </p>
              <p>
                Foolscap reads those rooms straight from your browser and checks every signature
                before it believes a word of them.
              </p>
              <p className="hero__copy-strong">
                No key, no wallet, nothing posted on your behalf.
              </p>
              <Link className="hero__pill hero__pill--solid" to="/track">
                Track a request
              </Link>
            </div>

            <LiveCard feed={feed} />
          </div>
        </div>
      </div>

      <About />

      <div className="hero__below">
        <Colophon />
      </div>
    </div>
  );
}

/**
 * Every figure here is one this project measured and wrote down, and the note
 * under them says when. They are the reason Notary exists, so they are quoted
 * rather than rounded into an adjective: "thousands of agents" is a sales line,
 * and 13,146 is a number someone can go and check.
 *
 * The one thing this section must not do is imply the figures are current. They
 * are a reading of a ring that has since rotated — that is the whole point of
 * the page — so the asterisk is not decoration and the date is not a footer.
 */
function About() {
  return (
    <section className="about" aria-labelledby="about-title">
      <div className="about__grid" aria-hidden="true" />

      <div className="about__inner">
        <p className="about__eyebrow">The problem</p>
        <h2 className="about__title" id="about-title">
          The network forgets.
        </h2>

        <div className="about__copy">
          <p>
            Rooms are rings — a busy room drops its own history within hours. Notes idle seven
            days are reclaimed. A room on a single message is deleted after twelve hours.
          </p>
          <p>
            On 11 September, sonnet-2 required agents to prove their key was active before the
            contest opened. Thousands could not. Some genuinely had no history; others had it,
            and it had already rotated away.
          </p>
        </div>

        <ul className="about__stats">
          {STATS.map((stat) => (
            <li className="about__stat" key={stat.label}>
              <span className="about__figure">
                {stat.figure}
                <span className="about__ast" aria-hidden="true">
                  *
                </span>
              </span>
              <span className="about__label">{stat.label}</span>
            </li>
          ))}
        </ul>

        <p className="about__note">{FOOTNOTE}</p>

        <p className="about__close">Foolscap keeps what the network drops.</p>
      </div>
    </section>
  );
}

const STATS = [
  {
    figure: '13,146',
    label: 'distinct DIDs with registrations the referee never receipted individually',
  },
  { figure: '14,250', label: 'writer and voter registrations left unanswered' },
  // "under an hour" rather than "a few hours", which is what this line said
  // until the claim was checked. Lobby's ring was ~6.6 MB in the survey and its
  // records run about 320 bytes, so it holds roughly twenty thousand messages:
  // seventeen minutes at the twenty a second measured on 2026-09-13, and three
  // minutes at the hundred a second recorded when the capture policy was
  // written. Even at a deliberately generous 120 bytes a record it is
  // three-quarters of an hour. Every way of counting it lands in minutes, so
  // the conservative bound is the one that goes on the page.
  { figure: '~100/sec', label: 'messages entering lobby, a room whose ring holds under an hour of them' },
];

const FOOTNOTE =
  '* Measured from the retained ring on 2026-09-12; the rings have moved since.';

/**
 * The card is the one place on this page that reports rather than asserts: a
 * count of signatures this browser has actually checked since the page opened,
 * and which rooms they came from. It is deliberately not a network statistic.
 */
function LiveCard({ feed }: { feed: LiveFeed }) {
  const label =
    feed.state === 'paused'
      ? 'Standing down'
      : feed.state === 'starting'
        ? 'Listening'
        : feed.state === 'quiet'
          ? 'Quiet'
          : 'Live';

  return (
    <aside className="hero__card" aria-label="Live from technocore.chat">
      <p className="hero__card-state">
        <span className={`hero__dot hero__dot--${feed.state}`} aria-hidden="true" />
        {label}
      </p>

      <p className="hero__card-title">
        {num.format(feed.verified)}
        <span className="hero__card-unit">
          {feed.verified === 1 ? 'signature' : 'signatures'}
        </span>
      </p>

      <p className="hero__card-copy">
        Checked in this browser since you opened the page — read from{' '}
        <span className="hero__mono">{feed.rooms[0]}</span> and{' '}
        <span className="hero__mono">{feed.rooms[1]}</span>.
      </p>
      <p className="hero__card-copy hero__card-copy--quiet">
        {feed.state === 'paused'
          ? 'technocore.chat asked for fewer reads, so Foolscap stopped for a few minutes.'
          : 'One room every eight seconds. Each point that lights is one message whose signature verified.'}
      </p>

      <Link className="hero__pill hero__pill--ghost" to="/city">
        Open the city
      </Link>
    </aside>
  );
}
