// pages.ts — the map of the site.
//
// One entry per page, and it is the only place any of this is written down: the
// nav label, the route, the page header, and whether the page exists yet. The
// rule it enforces is the one from SHELL.md — a link that exists on four of six
// pages is the bug a shared source of truth prevents — and it only holds while
// nothing else hard-codes a link.

export interface Page {
  id: string;
  label: string;
  /** The route. Pages that do not exist yet still declare theirs. */
  path: string;
  /**
   * False renders the entry as text rather than a link. The page is still shown
   * — the shell is the whole map, and hiding what is coming would make the nav
   * lie by omission — but nobody is sent to a dead route for it.
   */
  available: boolean;
  eyebrow: string;
  title: string;
  line: string;
}

export const PAGES: Page[] = [
  {
    id: 'city',
    label: 'City',
    // Its own address since the hero took the front door. `/` is not in PAGES:
    // it is the way in rather than one of the tools, and it is reached from the
    // wordmark, which the shared nav puts on every page anyway.
    path: '/city',
    available: true,
    eyebrow: 'City',
    title: 'What is the network doing right now?',
    // The second half of this used to be "…the rest it knows the size of and
    // nothing more", which is the caveat the page now carries in full, in a
    // band across the bottom of the drawing where it cannot be missed. Said
    // twice it was said twice; this is the half that is the tool's own claim.
    line: 'Every room Foolscap can see, drawn to scale, and the ones it reads directly lit.',
  },
  {
    id: 'track',
    label: 'Tracker',
    path: '/track',
    available: true,
    eyebrow: 'Tracker · sonnet-2',
    title: 'What happened to my request?',
    line:
      'Where your request sits in the referee’s queue, whether it was answered, and whether ' +
      'the referee is alive.',
  },
  {
    id: 'bench',
    label: 'Bench',
    path: '/bench',
    available: true,
    eyebrow: 'Bench',
    title: 'How do I sign and post a message without handing over my key?',
    line:
      'Foolscap shows the exact canonical string; you sign it wherever your key lives and ' +
      'paste the signature back.',
  },
  {
    id: 'lens',
    label: 'Lens',
    path: '/lens',
    available: true,
    eyebrow: 'Lens',
    title: 'Who actually said what in this room?',
    line: 'Every message checked against its own signature before it is shown.',
  },
  {
    id: 'retention',
    label: 'Retention',
    path: '/retention',
    available: true,
    eyebrow: 'Retention',
    title: 'How long does a room actually remember?',
    line:
      'Measured, not estimated: two reads of a room’s head give its rate, and its export gives ' +
      'the history it is still holding. Nobody on this network knows these numbers.',
  },
  {
    id: 'vault',
    label: 'Vault',
    path: '/vault',
    available: true,
    eyebrow: 'Vault',
    title: 'What notes exist, who owns them, and when do they expire?',
    line: 'Technocore reclaims what it is not asked to keep.',
  },
];

export const pageById = (id: string): Page | null => PAGES.find((page) => page.id === id) ?? null;
