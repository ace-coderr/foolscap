// npm test — vitest
//
// The two new components, rendered.
//
// DESIGN.md's build process says a state you did not look at is not done, and
// these two shipped before any page used them — so there was nothing to look at
// except a hand-built probe in the browser. This is the other half of that
// check: the components are actually mounted, and the parts of their output
// that carry meaning are asserted rather than eyeballed.
//
// Static markup rather than a DOM: nothing here has behaviour. Card's pill is a
// router Link and a button, and neither is being clicked; Glyph is a pure
// function of a string. A jsdom environment for this would be a dependency
// bought to test rendering that has no interaction in it.

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// StaticRouter rather than MemoryRouter: MemoryRouter runs a useLayoutEffect,
// which React warns about on every server render and which would bury a real
// failure in this file under twenty lines of the same warning.
import { StaticRouter } from 'react-router-dom/server';
import { Glyph } from '../src/components/Glyph.tsx';
import { BarColumn, Card, MarkField } from '../src/components/Card.tsx';
import { glyphFor } from '../src/lib/glyph.ts';

const AUTHOR = 'did:key:z6Mko5gbL5nHyfofMpxdVPFWChStScejMzJ3HtPRUzKdkEnd';
const REFEREE = 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const routed = (node: React.ReactNode) =>
  renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, node));

describe('Glyph', () => {
  test('draws the same mark the derivation says it should', () => {
    const html = render(createElement(Glyph, { did: AUTHOR }));
    const { cells } = glyphFor(AUTHOR)!;

    // Runs, not cells: adjacent set cells in a row are one rect, so the bottom
    // row of the author's mark (#####) is a single width-5 rect rather than
    // five width-1 ones. That is the whole reason the seams do not show.
    assert.ok(html.includes('<rect x="1" y="5" width="5" height="1"'), html);
    // ..#.. at the top is one cell, in the middle column.
    assert.ok(html.includes('<rect x="3" y="1" width="1" height="1"'), html);
    // #.#.# splits into three.
    const rowThree = [...html.matchAll(/<rect x="(\d)" y="4" width="(\d)"/g)].map((m) => m.slice(1));
    assert.deepEqual(rowThree, [
      ['1', '1'],
      ['3', '1'],
      ['5', '1'],
    ]);

    const drawn = [...html.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1"/g)].reduce(
      (total, m) => total + Number(m[3]),
      0
    );
    assert.equal(drawn, cells.filter(Boolean).length);
  });

  test('is decorative unless it is given a title', () => {
    assert.ok(render(createElement(Glyph, { did: AUTHOR })).includes('aria-hidden="true"'));

    const named = render(createElement(Glyph, { did: AUTHOR, title: "The author's key" }));
    assert.ok(named.includes('role="img"'));
    assert.ok(named.includes("<title>The author&#x27;s key</title>"));
    assert.ok(!named.includes('aria-hidden'));
  });

  test('draws the ground and nothing else for something that is not a key', () => {
    const html = render(createElement(Glyph, { did: 'not-a-did' }));
    assert.ok(html.includes('glyph__ground'));
    assert.ok(!html.includes('glyph__cells'));
    // Still a square of the right size, so a row with no key lines up with the
    // rows that have one.
    assert.ok(html.includes('width="20" height="20"'));
  });

  test('takes its size from the caller and its geometry from nowhere else', () => {
    for (const size of [20, 32, 56]) {
      const html = render(createElement(Glyph, { did: REFEREE, size }));
      assert.ok(html.includes(`width="${size}" height="${size}"`));
      assert.ok(html.includes('viewBox="0 0 7 7"'));
    }
  });
});

describe('Card', () => {
  const visual = createElement(Glyph, { did: AUTHOR, size: 56 });

  test('renders the pill as a link, a button, or neither', () => {
    const asLink = routed(
      createElement(Card, { visual, title: 'lobby', to: '/lens', actionLabel: 'Open' })
    );
    assert.ok(asLink.includes('<a class="card2__open" href="/lens">Open</a>'), asLink);

    const asButton = routed(
      createElement(Card, { visual, title: 'lobby', onClick: () => {}, actionLabel: 'Read' })
    );
    assert.ok(asButton.includes('<button class="card2__open" type="button">Read</button>'));

    const inert = routed(createElement(Card, { visual, title: 'lobby' }));
    assert.ok(!inert.includes('card2__open'));

    // A tool that does not exist yet says so rather than linking nowhere.
    const off = routed(
      createElement(Card, { visual, title: 'lobby', to: '/lens', disabled: true, actionLabel: 'Soon' })
    );
    assert.ok(off.includes('aria-disabled="true"'));
    assert.ok(!off.includes('href'));
  });

  test('the visual block is always there, because a card without one is a row', () => {
    const html = routed(createElement(Card, { visual, title: 'lobby' }));
    assert.ok(html.includes('class="card2__visual" aria-hidden="true"'));
  });

  test('facts get marks from CSS rather than characters in the markup', () => {
    const html = routed(
      createElement(Card, { visual, title: 'lobby', meta: ['8.1 MiB', '1,204 msgs'] })
    );
    assert.ok(html.includes('<li class="card2__fact">8.1 MiB</li>'));
    assert.ok(!html.includes('◦'));
  });
});

describe('the card visuals', () => {
  test('a bar column floors every bar, so none of them disappears', () => {
    const html = render(createElement(BarColumn, { values: [0, 0, 100] }));
    const heights = [...html.matchAll(/height:\s*([\d.]+)%/g)].map((m) => Number(m[1]));
    assert.deepEqual(heights, [6, 6, 100]);
  });

  test('...and survives a column of nothing at all', () => {
    const html = render(createElement(BarColumn, { values: [0, 0, 0] }));
    assert.deepEqual(
      [...html.matchAll(/height:\s*([\d.]+)%/g)].map((m) => Number(m[1])),
      [6, 6, 6]
    );
  });

  test('a bar takes a state colour only where it is given one', () => {
    const html = render(
      createElement(BarColumn, { values: [1, 1, 1], tone: ['ok', 'bad', 'warn'] })
    );
    assert.ok(html.includes('bars__bar--ok'));
    assert.ok(html.includes('bars__bar--bad'));
    assert.ok(html.includes('bars__bar--warn'));
  });

  test('a mark field draws twenty-five cells and sets the ones it is told to', () => {
    const present = Array.from({ length: 25 }, (_, i) => i % 3 === 0);
    const html = render(createElement(MarkField, { present }));
    assert.equal([...html.matchAll(/mfield__cell/g)].length, 25);
    assert.equal([...html.matchAll(/data-on="true"/g)].length, 9);
  });

  test('...and a short list leaves the rest unset rather than throwing', () => {
    const html = render(createElement(MarkField, { present: [true, true] }));
    assert.equal([...html.matchAll(/mfield__cell/g)].length, 25);
    assert.equal([...html.matchAll(/data-on="true"/g)].length, 2);
  });
});
