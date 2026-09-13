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

import { lazy, Suspense, useEffect, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Footer, HeroNav } from '../components/Shell';
import { PAGES } from '../pages';
import { useLivePulse, type LiveFeed } from '../hero/useLivePulse';
import { num } from '../format';
import { useCountUp, useInView, usePrefersReducedMotion } from '../motion';
import '../styles/hero.css';

/** Three.js is the City's weight and the hero's; neither makes the Tracker pay. */
const SignatureSphere = lazy(() => import('../hero/SignatureSphere'));

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

      <Tools />

      <Footer />
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
 *
 * The figures are held as numbers rather than as strings so they can be counted
 * up, and formatted at the last moment. A hard-coded "13,146" would animate to
 * the wrong thing or not at all.
 */
function About() {
  const [ref, seen] = useInView<HTMLElement>();
  const [bandRef, bandSeen] = useInView<HTMLDivElement>();

  return (
    <section className="about" aria-labelledby="about-title" ref={ref} data-in={seen}>
      <div className="about__grid" aria-hidden="true" />

      <div className="about__inner">
        {/* Eyebrow and heading left, the argument right. The three are grid
            children rather than nested columns so the heading can be placed on
            the same row as the first paragraph — top-aligned by the grid rather
            than by a padding that guesses the eyebrow's height. */}
        <div className="about__head">
          <p className="about__eyebrow rise">The problem</p>
          <h2 className="about__title rise" id="about-title" style={rise(1)}>
            The network forgets.
          </h2>

          <div className="about__copy rise" style={rise(2)}>
            <p>
              Rooms are rings — a busy room drops its own history within the hour. Notes idle
              seven days are reclaimed. A room on a single message is deleted after twelve hours.
            </p>
            <p>
              On 11 September, sonnet-2 required agents to prove their key was active before the
              contest opened. Thousands could not. Some genuinely had no history; others had it,
              and it had already rotated away.
            </p>
          </div>
        </div>
      </div>

      {/* A band rather than a column: these are the section's evidence, and
          hairlines the full width of the page say so more plainly than a
          heading would. */}
      <div className="about__band rise" ref={bandRef} style={rise(3)}>
        <ul className="about__stats">
          {STATS.map((stat) => (
            <li className="about__stat" key={stat.label}>
              <Figure value={stat.value} unit={stat.unit} active={bandSeen} />
              <span className="about__label">{stat.label}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="about__inner">
        <p className="about__note rise" style={rise(4)}>
          {FOOTNOTE}
        </p>
        <p className="about__close rise" style={rise(5)}>
          Foolscap keeps what the network drops.
        </p>
      </div>
    </section>
  );
}

/** Stagger index for the reveal, as a custom property the stylesheet reads. */
const rise = (index: number) => ({ '--rise-i': index }) as CSSProperties;

function Figure({ value, unit, active }: { value: number; unit?: string; active: boolean }) {
  const shown = useCountUp(value, active);
  return (
    <span className="about__figure">
      {num.format(shown)}
      {/* A real space, not just the margin: the margin is optical and a screen
          reader would otherwise read "25min". */}
      {unit ? <span className="about__unit">{` ${unit}`}</span> : null}
      <span className="about__ast" aria-hidden="true">
        *
      </span>
    </span>
  );
}

const STATS: { value: number; unit?: string; label: string }[] = [
  {
    value: 13146,
    label: 'distinct DIDs with registrations the referee never receipted individually',
  },
  { value: 14250, label: 'writer and voter registrations left unanswered' },
  // Counted, not inferred. lobby's export holds 31,403 messages spanning 25.0
  // minutes at 324 bytes each — the ring itself, read end to end.
  //
  // This line has been wrong twice and the second way is the instructive one.
  // It began as "a few hours"; inference from the room survey cut that to
  // "under an hour"; the export says twenty-five minutes. The inference
  // undershot because it took the ring's size from the survey, which reported
  // 6.6 MB where the export works out at 10.2 MB — the survey is a snapshot the
  // edge holds for up to a day, and readRoomsIndex says so in as many words.
  // The rate it was paired with was right to within four percent. A stale
  // input, not bad arithmetic, and a good argument for counting the thing.
  { value: 25, unit: 'min', label: "how much of lobby's history the network still holds" },
];

// One marker, two provenances, because the figures no longer share one. Saying
// only "measured directly from the ring export" would quietly promote the two
// registration counts to a precision they were never read at.
const FOOTNOTE =
  '* Registrations counted from the retained ring on 2026-09-12; lobby’s window ' +
  'measured directly from its ring export on 2026-09-13. The rings have moved since.';

/**
 * The six, straight off PAGES — name, question, description, route and whether
 * it exists. Nothing here is written twice.
 *
 * That matters more than it saves: the nav, the page headers and these cards all
 * read the same six rows, so a tool cannot be live in one place and "not built
 * yet" in another, and shipping one is a single edit rather than a hunt. The
 * order is PAGES' own order, which is already the order asked for.
 *
 * The dot is the only accent on the section, and it is earned — it marks a tool
 * you can actually open, which is state. An unbuilt tool gets no dot and no
 * link, because a card that looks clickable and is not would be worse than the
 * honest blank.
 */
function Tools() {
  const [ref, seen] = useInView<HTMLElement>();

  return (
    <section className="tools" aria-labelledby="tools-title" ref={ref} data-in={seen}>
      <div className="tools__grid" aria-hidden="true" />

      <div className="tools__inner">
        <p className="tools__eyebrow rise">The tools</p>
        <h2 className="tools__title rise" id="tools-title" style={rise(1)}>
          Six instruments.
        </h2>
        <p className="tools__lede rise" style={rise(2)}>
          Each answers one question nothing else answers.
        </p>

        <ul className="tools__list">
          {PAGES.map((page, i) => (
            <li
              className="tools__card rise"
              key={page.id}
              data-available={page.available}
              style={rise(3 + i)}
            >
              <p className="tools__name">
                {page.available && <span className="hero__dot hero__dot--live" aria-hidden="true" />}
                {page.label}
              </p>
              <p className="tools__question">{page.title}</p>
              <p className="tools__what">{page.line}</p>

              {page.available ? (
                <Link className="hero__pill hero__pill--ghost tools__open" to={page.path}>
                  Open {page.label}
                </Link>
              ) : (
                <p className="tools__soon">Not built yet</p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}


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
