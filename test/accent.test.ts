// npm test — vitest
//
// The accent is state-only. This test is what enforces it.
//
// #3FB3C4 means one thing on this site: something is live, held, verified, or
// current. It is never decoration. The rule was written into foolscap.css the
// day the palette was set, and it has been broken twice since — a teal glow on
// a byline, a teal edge on a pill — both times by someone who had read the rule
// and then wrote the CSS a week later. A rule that lives only in a comment is a
// rule that depends on memory, and memory is the thing that failed.
//
// So: every use of the accent has to be named below, with a reason. A new use
// fails this test until someone adds it to the list, and adding it to the list
// means writing down why that thing is state. That is the whole mechanism.
//
// WHAT IT LOOKS FOR, and why more than the hex. The second drift was
// `rgba(63, 179, 196, 0.5)` — no hex anywhere in it. A test matching only
// #3FB3C4 would have passed it without comment. It therefore matches the hex,
// the decimal triple, and the two custom properties that hold the colour.
//
// It does not parse colour: `hsl(188 52% 51%)` is the same teal and would slip
// through. That is a known limit rather than an oversight — those forms are not
// used here, and a test that tried to resolve every colour syntax would be a
// colour library with an assertion at the end of it.

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');

/** The custom properties that hold the accent. Defining one is not a use. */
const ACCENT_TOKENS = ['--accent', '--hero-live'];

const ACCENT =
  /#3fb3c4\b|(?<![\d.])63\s*[,\s]\s*179\s*[,\s]\s*196(?![\d.])|var\(\s*--(?:accent|hero-live)\b|0x3fb3c4\b/i;

// ---------------------------------------------------------------------------
// Who is allowed to be teal
// ---------------------------------------------------------------------------

/**
 * Exact selectors, not patterns.
 *
 * A pattern would have let `.byline:hover` through the moment it happened to
 * contain a permitted word, which is exactly the failure being guarded against.
 * Matching the whole selector means a rename is a deliberate edit here too —
 * mildly annoying, and the annoyance is the feature.
 */
const ALLOWED: Array<{ selector: string; why: string }> = [
  // --- liveness -----------------------------------------------------------
  { selector: '.state--live', why: 'the referee is answering' },
  { selector: '.hero__dot--live', why: 'the live feed is reading rooms' },
  {
    selector: '.chip--live .chip__dot, .rooms__dot--live, .legend__swatch--live',
    why: 'rooms the City reads directly and found active',
  },
  { selector: '.legend__key--live', why: 'the key for those rooms' },
  { selector: '.detail__state--live', why: 'one room, read directly, active' },

  // --- something needing an answer ----------------------------------------
  { selector: '.card--attention', why: 'a status the reader has to act on' },
  { selector: '.card--attention .card__status', why: 'the word of that status' },
  { selector: '.row__status--attention', why: 'the same, in a list' },

  // --- verified ------------------------------------------------------------
  // The one answer /notary gives in the affirmative, and it is only reached
  // when a signature verified — here in the browser, or in Notary's capture.
  // The qualifier line under it carries whether the TIMESTAMP is Notary's clock
  // or the room's claim, because that is a distinction words can make and a hue
  // cannot. "Nothing on record" and "No answer" stay white: an absence is not a
  // state, and colouring one would claim exactly what this page refuses to.
  {
    selector: '.nverdict__word--yes',
    why: 'a key whose signature verified before the cutoff asked about',
  },

  // --- in flight -----------------------------------------------------------
  // A read is happening right now. It is the narrowest kind of state there is —
  // it exists only while the request is open and is gone the instant it
  // resolves, either way — and it is the only thing on screen while /notary
  // waits on an archive it does not control. The sweep is what separates
  // "loading" from "gave up", which no amount of grey text can say.
  {
    selector: '.nloading__rule::after',
    why: 'a read is in flight, for as long as it is and no longer',
  },

  // --- verified, on the write lane ------------------------------------------
  // /bench checks a pasted signature against the DID above it and the exact
  // string on screen, here, in the reader's own browser, before it will build
  // the request. Same meaning as /notary's verdict: this verified. The word is
  // the only coloured thing on that page, and the URL beneath it does not exist
  // until the word says yes — absence is the other half of the signal.
  {
    selector: '.verdict__word--yes',
    why: 'a signature that verified against the string and the key on screen',
  },

  // --- current ------------------------------------------------------------
  // "Current" is in the token's own definition, and where you are is state.
  { selector: ".hero__nav-link[aria-current='page']", why: 'the page you are on' },
  { selector: 'a:focus-visible', why: 'the link keyboard focus is on' },
  { selector: '.lookup__input:focus-visible', why: 'the field keyboard focus is on' },
  { selector: '.rooms__row:focus-visible', why: 'the room keyboard focus is on' },
  { selector: '.hero__pill:focus-visible', why: 'the pill keyboard focus is on' },
  {
    selector: '.field__input:focus-visible, .field__area:focus-visible',
    why: 'the field keyboard focus is on, on the bench',
  },
  { selector: '.listbox__control:focus-visible', why: 'the picker keyboard focus is on' },
  { selector: '.rooms__search:focus-visible', why: 'the room search keyboard focus is on' },
  { selector: '.rooms__row:focus-visible', why: 'the room in the list keyboard focus is on' },
  { selector: '.lbutton:focus-visible', why: 'the filter keyboard focus is on' },
  {
    selector: ".listbox__option[aria-selected='true'] .listbox__name",
    why: 'the option currently chosen',
  },
  { selector: '.reading__verified', why: 'signatures that verified, counted live as they check' },
  { selector: '.bbutton:focus-visible', why: 'the button keyboard focus is on, on the bench' },
];

/**
 * Files allowed to name the colour outside CSS, and the one thing in each that
 * is state.
 */
const ALLOWED_FILES: Array<{ file: string; why: string }> = [
  { file: 'city/CityCanvas.tsx', why: "a room's roof, where the City read it and found it live" },
  { file: 'components/DrawingAgent.tsx', why: "the agent's sensor, the live thing in that figure" },
];

// ---------------------------------------------------------------------------
// A small CSS reader
// ---------------------------------------------------------------------------

interface Rule {
  selector: string;
  declarations: string[];
}

/**
 * Selectors and their declarations. Comments are stripped first, so the rule
 * can be discussed in prose without tripping its own test — this file's header
 * would otherwise fail it.
 *
 * At-rules are unwrapped rather than reported: a rule inside `@media` is still
 * that rule, and its selector is what matters here.
 */
function readRules(css: string): Rule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const open: string[] = [];
  let buffer = '';

  for (const ch of clean) {
    if (ch === '{') {
      open.push(buffer.trim());
      buffer = '';
    } else if (ch === '}') {
      const selector = open.pop() ?? '';
      if (selector && !selector.startsWith('@')) {
        rules.push({
          selector: selector.replace(/\s+/g, ' '),
          declarations: buffer
            .split(';')
            .map((d) => d.trim())
            .filter(Boolean),
        });
      }
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return rules;
}

/** Every stylesheet, found rather than listed, so a new one cannot dodge this. */
function stylesheets(): string[] {
  const dir = join(src, 'styles');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => join(dir, name));
}

/** Every TypeScript source, likewise. */
function sources(dir = src): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const isDefinition = (declaration: string): boolean => {
  const property = declaration.slice(0, declaration.indexOf(':')).trim();
  return ACCENT_TOKENS.includes(property);
};

// ---------------------------------------------------------------------------

describe('the accent is state-only', () => {
  test('no stylesheet uses it outside the allowlist', () => {
    const allowed = new Set(ALLOWED.map((entry) => entry.selector));
    const strays: string[] = [];

    for (const file of stylesheets()) {
      const name = relative(join(here, '..'), file).replace(/\\/g, '/');
      for (const rule of readRules(readFileSync(file, 'utf8'))) {
        for (const declaration of rule.declarations) {
          if (!ACCENT.test(declaration)) continue;
          // Defining the token is not spending it.
          if (isDefinition(declaration)) continue;
          if (allowed.has(rule.selector)) continue;
          strays.push(`${name}  ${rule.selector} { ${declaration} }`);
        }
      }
    }

    assert.deepEqual(
      strays,
      [],
      'The accent means state. These uses are not on the allowlist in ' +
        'test/accent.test.ts — either they are state, in which case add them ' +
        'there with a reason, or they are decoration and want a grey:\n  ' +
        strays.join('\n  ')
    );
  });

  test('nothing outside CSS names the colour except the files allowed to', () => {
    const allowed = new Map(ALLOWED_FILES.map((entry) => [entry.file, entry.why]));
    const strays: string[] = [];

    for (const file of sources()) {
      const name = relative(src, file).replace(/\\/g, '/');
      const text = readFileSync(file, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
      if (!ACCENT.test(text)) continue;
      if (allowed.has(name)) continue;
      strays.push(name);
    }

    assert.deepEqual(strays, [], `Accent outside CSS and outside the allowlist: ${strays.join(', ')}`);
  });

  test('the allowlist has no dead entries', () => {
    // A list that only ever grows stops being a decision and becomes a
    // formality. If a selector is gone, its permission should go with it.
    const live = new Set<string>();
    for (const file of stylesheets()) {
      for (const rule of readRules(readFileSync(file, 'utf8'))) live.add(rule.selector);
    }

    const dead = ALLOWED.filter((entry) => !live.has(entry.selector)).map((e) => e.selector);
    assert.deepEqual(dead, [], `Allowlisted selectors that no longer exist: ${dead.join(', ')}`);

    // The other way a permission goes stale: the selector is still there but no
    // longer teal. Nothing would have told me to drop the forgery entries when
    // they moved to --alarm; this does.
    const spends = new Set<string>();
    for (const file of stylesheets()) {
      for (const rule of readRules(readFileSync(file, 'utf8'))) {
        for (const declaration of rule.declarations) {
          if (ACCENT.test(declaration) && !isDefinition(declaration)) spends.add(rule.selector);
        }
      }
    }
    const unspent = ALLOWED.filter((entry) => !spends.has(entry.selector)).map((e) => e.selector);
    assert.deepEqual(
      unspent,
      [],
      `Allowlisted but no longer using the accent — drop them: ${unspent.join(', ')}`
    );

    const files = new Set(sources().map((f) => relative(src, f).replace(/\\/g, '/')));
    const deadFiles = ALLOWED_FILES.filter((entry) => !files.has(entry.file)).map((e) => e.file);
    assert.deepEqual(deadFiles, [], `Allowlisted files that no longer exist: ${deadFiles.join(', ')}`);
  });

  test('every allowlist entry says why', () => {
    for (const entry of [...ALLOWED, ...ALLOWED_FILES]) {
      const subject = 'selector' in entry ? entry.selector : entry.file;
      assert.ok(
        entry.why.trim().length > 8,
        `${subject} is allowed to be teal without saying why it is state.`
      );
    }
  });

  test('it catches the forms the rule was actually broken in', () => {
    // Both real drifts, plus the hex and the token, as a guard on the guard.
    for (const form of [
      'box-shadow: 0 0 16px rgba(63, 179, 196, 0.25)',
      'border-color: rgba(63,179,196,0.5)',
      'color: #3FB3C4',
      'color: #3fb3c4',
      'background: var(--accent)',
      'outline: 1px solid var(--hero-live)',
      'live: 0x3fb3c4',
    ]) {
      assert.ok(ACCENT.test(form), `should have been caught: ${form}`);
    }

    // And does not fire on greys, or on numbers that merely contain the digits.
    for (const form of [
      'color: rgba(255, 255, 255, 0.63)',
      'color: #8a8a8a',
      'z-index: 63',
      'width: 179px',
      'transition: color 196ms ease',
    ]) {
      assert.ok(!ACCENT.test(form), `should not have fired: ${form}`);
    }
  });
});
