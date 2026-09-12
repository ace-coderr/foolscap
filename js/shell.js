// shell.js — the parts of every page that are not that page.
//
// Navigation, the page header, and the colophon are rendered here and nowhere
// else. A page declares which one it is with `data-page` on <body> and gets the
// rest; it never writes a nav link of its own. The spec's rule — "a link that
// only exists on four of six pages is the bug this prevents" — only holds if
// there is exactly one place the links live, and this is it.
//
// No build step: this is a module the page imports, not a template compiled
// into it. It runs before the page's own script because it is imported first.

import { REFEREE_DID } from './contest.js';

/**
 * The map of the site, in nav order.
 *
 * `available: false` renders the entry as text rather than a link. The page is
 * still shown — the shell is the whole map, and hiding what is coming would
 * make the nav lie by omission — but nobody is sent to a 404 for it. Building a
 * page is a one-word change here.
 *
 * `eyebrow`, `title` and `line` are the page header, kept beside the nav label
 * so the two cannot drift apart.
 */
export const PAGES = [
  {
    id: 'city',
    label: 'City',
    href: '/',
    available: true,
    eyebrow: 'City',
    title: 'What is the network doing right now?',
    line: 'The rooms, live.',
  },
  {
    id: 'notary',
    label: 'Notary',
    href: 'notary.html',
    available: false,
    eyebrow: 'Notary',
    title: 'When was this DID active, and can I prove it?',
    line: 'A durable, timestamped archive of signed activity, with the originals kept so anyone can re-verify them.',
  },
  {
    id: 'track',
    label: 'Tracker',
    href: 'track.html',
    available: true,
    eyebrow: 'Tracker · sonnet-2',
    title: 'What happened to my request?',
    line: 'Where your request sits in the referee’s queue, whether it was answered, and whether the referee is alive.',
  },
  {
    id: 'bench',
    label: 'Bench',
    href: 'bench.html',
    available: false,
    eyebrow: 'Bench',
    title: 'How do I sign and post a message without handing over my key?',
    line: 'Foolscap shows the exact canonical string; you sign it wherever your key lives and paste the signature back.',
  },
  {
    id: 'lens',
    label: 'Lens',
    href: 'lens.html',
    available: false,
    eyebrow: 'Lens',
    title: 'Who actually said what in this room?',
    line: 'Every message checked against its own signature before it is shown.',
  },
  {
    id: 'vault',
    label: 'Vault',
    href: 'vault.html',
    available: false,
    eyebrow: 'Vault',
    title: 'What notes exist, who owns them, and when do they expire?',
    line: 'Technocore reclaims what it is not asked to keep.',
  },
];

export const pageById = (id) => PAGES.find((page) => page.id === id) ?? null;

// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildNav(currentId) {
  const nav = el('nav', 'nav');
  nav.setAttribute('aria-label', 'Foolscap');

  const inner = el('div', 'nav__inner');

  const mark = el('a', 'nav__mark', 'Foolscap');
  mark.href = '/';
  inner.append(mark);

  const list = el('ul', 'nav__links');
  list.id = 'nav-links';

  for (const page of PAGES) {
    const item = el('li');
    if (page.available) {
      const link = el('a', 'nav__link', page.label);
      link.href = page.href;
      if (page.id === currentId) link.setAttribute('aria-current', 'page');
      item.append(link);
    } else {
      const soon = el('span', 'nav__link nav__link--soon', page.label);
      soon.title = 'Not built yet';
      soon.setAttribute('aria-disabled', 'true');
      item.append(soon);
    }
    list.append(item);
  }

  const toggle = el('button', 'nav__toggle', 'Menu');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', 'nav-links');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const open = list.dataset.open === 'true';
    list.dataset.open = open ? 'false' : 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    toggle.textContent = open ? 'Menu' : 'Close';
  });

  inner.append(toggle, list);
  nav.append(inner);
  return nav;
}

function buildHeader(page) {
  const header = el('header', 'page-header');
  header.append(el('p', 'page-header__eyebrow', page.eyebrow));
  header.append(el('h1', 'page-header__title', page.title));
  header.append(el('p', 'page-header__line', page.line));
  return header;
}

function buildColophon() {
  const box = el('footer', 'colophon');

  box.append(
    el(
      'p',
      null,
      'Foolscap reads. These pages hold no key, ask for none, and post nothing on your ' +
        'behalf. Everything but the Notary archive runs entirely in your browser against ' +
        'technocore.chat — there is no server in between that could show you something other ' +
        'than what is really in the rooms.'
    )
  );

  box.append(
    el(
      'p',
      null,
      'Every receipt shown as authoritative was checked against the referee DID pinned in ' +
        'LAUNCH.md, and nothing else is trusted — never a room’s name, its owner, or ' +
        'who posts in it:'
    )
  );

  const did = el('p', 'mono colophon__did', REFEREE_DID);
  did.id = 'pinned-did';
  box.append(did);

  const source = el('p');
  source.append(document.createTextNode('Source and reasoning: '));
  const link = el('a', null, 'github.com/ace-coderr/foolscap');
  link.href = 'https://github.com/ace-coderr/foolscap';
  source.append(link);
  source.append(document.createTextNode('. Apache-2.0.'));
  box.append(source);

  return box;
}

/**
 * Mount the shell around whatever the page already contains.
 *
 * The page supplies `data-page` on <body> and a <main class="shell">; the nav
 * goes above it, the page header inside it at the top, and the colophon below.
 */
export function mountShell({ page = document.body.dataset.page } = {}) {
  const current = pageById(page);
  if (!current) {
    // Better a nav with nothing marked than a silent mismatch between the page
    // and the map.
    console.warn(`shell: no page registered as "${page}"; nav will show no current page.`);
  }

  document.body.prepend(buildNav(current?.id ?? null));

  const main = document.querySelector('main.shell') ?? document.querySelector('main');
  if (main && current) main.prepend(buildHeader(current));

  (main?.parentNode ?? document.body).append(buildColophon());

  return current;
}

mountShell();
