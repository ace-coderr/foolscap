// Questions.tsx — the block at the bottom of every page.
//
// DESIGN.md: "a page that says what it does but never what it means leaves the
// reader to guess." Every page gets one of these, above the footer, titled with
// the page's own question.
//
// NATIVE <details>/<summary>, which is the whole implementation decision. It
// works with JavaScript off, it is keyboard-operable and screen-reader-
// announced without a line of ARIA, and the open/closed state is the browser's
// to manage rather than a piece of React state to get wrong. A hand-rolled
// disclosure here would be strictly worse in every one of those respects.
//
// EACH PAGE'S SET MUST INCLUDE AT LEAST ONE QUESTION WHOSE ANSWER IS A
// LIMITATION. That is DESIGN.md's rule and it is the one that separates this
// from a marketing FAQ: the questions worth answering are the ones a sceptical
// reader is already asking, and on this site several of those end in "it
// cannot".
//
// Answers are two or three sentences of prose at --measure. Never bullets: a
// bulleted answer is a list of assertions, and the reason these exist is to
// explain rather than to assert.

import { Panel } from './Panel.tsx';

export interface Question {
  q: string;
  a: React.ReactNode;
}

export function Questions({ title, items }: { title: string; items: Question[] }) {
  return (
    <Panel className="qa" flush title={title}>
      {items.map((item) => (
        <details className="qa__row" key={item.q}>
          <summary className="qa__q">
            <span>{item.q}</span>
            <span className="qa__mark" aria-hidden="true" />
          </summary>
          <div className="qa__a">{item.a}</div>
        </details>
      ))}
    </Panel>
  );
}
