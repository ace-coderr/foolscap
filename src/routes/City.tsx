// City.tsx — the way in.
//
// Not the City itself: that page reads the rooms live and is not built. This is
// the landing page ported from index.html, with the same copy.

import { Link } from 'react-router-dom';
import { Shell } from '../components/Shell';

export default function City() {
  return (
    <Shell page="city">
      <p className="lede measure">
        Foolscap shows where your sonnet-2 request sits in the referee's intake queue, whether the
        referee is alive, and what actually happened to any <span className="mono">request_id</span>{' '}
        or DID. It reads the contest rooms straight from your browser and verifies every receipt's
        signature against the pinned referee key before showing it to you.
      </p>

      <p className="cta">
        <Link className="cta__link" to="/track">
          Track my batch
        </Link>
      </p>
      <p className="cta__sub">
        Paste a <span className="mono">request_id</span> or a <span className="mono">did:key</span>.
      </p>

      <section className="section trust measure">
        <h2 className="section__title">Why the pinned key matters</h2>

        <p>
          It has already gone wrong once: a client in sonnet-1 pinned a forged referee DID scraped
          from the abandoned, unowned sonnet-1 rules room, and then believed every receipt the
          forger wrote. Foolscap never infers the referee from a room's name, its topic, its owner,
          who posts in it, or the referee field inside a message — a launch record is just a
          message, and messages are forgeable.
        </p>

        <p>
          Every receipt's signature is checked against the key below before it counts towards
          anything, and nothing is shown as authoritative before its own signature has verified. A
          message that claims the referee and fails that check is shown as a forgery rather than
          dropped, because someone handed a fake acceptance needs telling.
        </p>
      </section>
    </Shell>
  );
}
