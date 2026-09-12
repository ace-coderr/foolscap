// ui.js — track.html: the batch tracker and the referee panel.
//
// Two passes, so the page is useful in about a second instead of after every
// signature in the ring has been checked:
//
//   pass 1  the newest ~200 messages from the pinned DID. That is where the
//           frontier, the recent receipts and the status post live, so it is
//           everything the referee panel needs.
//   pass 2  the rest of the backfill, in chunks, yielding to the renderer
//           between each one. Counts climb as it clears.
//
// Nothing is rendered as authoritative before its own signature has verified.
// ContestTracker enforces that at the data layer — only verified receipts enter
// the index — and this file never reaches around it to read a raw message.
//
// This page holds no key and posts nothing.

import { exportRoom, RoomWatcher } from './technocore.js';
import { ContestTracker, WATCHED_ROOMS, REFEREE_DID, STATUS } from './contest.js';

/** How many of the newest referee messages to verify before the first paint. */
const HEAD_SIZE = 200;
/** Messages per chunk in pass 2. Small enough to keep frames cheap. */
const CHUNK = 120;
/** Ages are relative, so repaint occasionally even when no data arrives. */
const TICK_MS = 10_000;

const tracker = new ContestTracker();

const ui = {
  ready: false,
  phase: 'reading',
  query: '',
  pendingTotal: 0,
  pendingDone: 0,
  problems: [],
  gaps: [],
};

// ---------------------------------------------------------------------------
// DOM helpers — everything is built with textContent, never innerHTML, because
// reasons, DIDs and room names all arrive from the network.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function facts(pairs) {
  const dl = el('dl', 'facts');
  for (const [label, value, className] of pairs) {
    if (value == null || value === '') continue;
    dl.append(el('dt', null, label));
    dl.append(el('dd', className || null, value));
  }
  return dl;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const num = new Intl.NumberFormat('en');

function plural(n, word) {
  return `${num.format(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** A duration in words. Used for ages, so it rounds towards readability. */
function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return plural(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${plural(hours, 'hour')} ${plural(rest, 'minute')}` : plural(hours, 'hour');
}

/** UTC, because every timestamp in this contest is UTC and mixing them misleads. */
function formatUtc(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

function formatRate(throughput) {
  if (!throughput || throughput.p25 == null) return null;
  const lo = throughput.p25.toFixed(1);
  const hi = throughput.p75.toFixed(1);
  const mid = throughput.median.toFixed(1);
  return `${lo}–${hi} per minute (median ${mid})`;
}

function formatEta(eta) {
  if (!eta || eta.fastestMinutes == null || eta.slowestMinutes == null) return null;
  const lo = Math.max(1, Math.round(eta.fastestMinutes));
  const hi = Math.max(1, Math.round(eta.slowestMinutes));
  return lo === hi ? `about ${plural(lo, 'minute')}` : `${num.format(lo)}–${num.format(hi)} minutes`;
}

const STATUS_WORD = {
  [STATUS.NOT_SEEN]: 'Not seen yet',
  [STATUS.QUEUED]: 'Queued',
  [STATUS.ACCEPTED]: 'Accepted',
  [STATUS.REJECTED]: 'Rejected',
  [STATUS.UNANSWERED]: 'Unanswered',
};

/** Accent is reserved for the states that want something from the reader. */
const WANTS_ATTENTION = new Set([STATUS.REJECTED, STATUS.UNANSWERED]);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const yieldToPaint = () =>
  typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function'
    ? scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));

async function boot() {
  $('pinned-did').textContent = REFEREE_DID;
  render();

  // --- read ---------------------------------------------------------------
  // In parallel: the registration ring is an order of magnitude bigger than the
  // rest put together, so reading in sequence means waiting out every small room
  // before the one that carries the frontier even starts. A room that fails is
  // reported and skipped rather than taking the page down with it.
  let read = 0;
  const tick = () => {
    read++;
    setProgress(
      `Reading the rooms — ${read} of ${WATCHED_ROOMS.length}`,
      read / WATCHED_ROOMS.length
    );
  };
  setProgress(`Reading ${plural(WATCHED_ROOMS.length, 'room')}…`, 0);

  const dumps = (
    await Promise.all(
      WATCHED_ROOMS.map(async (room) => {
        try {
          return await exportRoom(room);
        } catch (err) {
          ui.problems.push(`${room}: ${err.message}`);
          return null;
        } finally {
          tick();
        }
      })
    )
  ).filter(Boolean);
  render();

  if (dumps.length === 0) {
    ui.phase = 'failed';
    render();
    return;
  }

  // --- split -------------------------------------------------------------
  // Anything carrying the pinned DID is what the panel is built from, so it is
  // verified first. Everything else is only ever counted.
  const refereeClaims = [];
  const rest = [];
  for (const dump of dumps) {
    for (const message of dump.messages) {
      (message.from === REFEREE_DID ? refereeClaims : rest).push(message);
    }
  }
  refereeClaims.sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));

  const head = refereeClaims.slice(-HEAD_SIZE);
  const tail = refereeClaims.slice(0, -HEAD_SIZE);

  // --- pass 1 -------------------------------------------------------------
  ui.phase = 'verifying-head';
  setProgress(`Verifying the newest ${num.format(head.length)} signatures…`, 0);
  await tracker.ingest(head);
  ui.ready = true;
  render();
  await yieldToPaint();

  // --- pass 2 -------------------------------------------------------------
  ui.phase = 'verifying-tail';
  ui.pendingTotal = tail.length + rest.length;
  ui.pendingDone = 0;

  // The older referee messages first: they are the ones that can still change a
  // count. The participant backfill only deepens the queue estimate.
  await ingestChunked(tail);
  await ingestChunked(rest);

  ui.phase = 'following';
  render();

  // --- follow -------------------------------------------------------------
  for (const dump of dumps) {
    const watcher = new RoomWatcher(dump.room, {
      since: dump.lastSeq,
      backfill: false,
      onMessages: async ({ messages }) => {
        await tracker.ingest(messages, dump.room);
        render();
      },
      onGap: (gap) => {
        if (gap.kind === 'rotated') return;
        ui.gaps.push(
          gap.kind === 'regenerated'
            ? `${dump.room} was recreated; Foolscap restarted from the top of the new ring.`
            : `${dump.room}: ${plural(gap.missing, 'message')} rotated past before Foolscap read them.`
        );
        render();
      },
      onError: (err) => {
        ui.problems.push(`${dump.room}: ${err.message}`);
        render();
      },
    });
    watcher.start();
  }

  setInterval(render, TICK_MS);
}

async function ingestChunked(messages) {
  let sinceRender = 0;
  for (let i = 0; i < messages.length; i += CHUNK) {
    await tracker.ingest(messages.slice(i, i + CHUNK));
    ui.pendingDone = Math.min(ui.pendingTotal, ui.pendingDone + CHUNK);
    sinceRender += CHUNK;

    setProgress(
      `Verifying the rest of the backfill — ${num.format(ui.pendingDone)} of ${num.format(
        ui.pendingTotal
      )}`,
      ui.pendingDone / Math.max(1, ui.pendingTotal)
    );

    if (sinceRender >= CHUNK * 6) {
      sinceRender = 0;
      render();
    }
    await yieldToPaint();
  }
  render();
}

// ---------------------------------------------------------------------------
// Progress — quiet by design: a line of text and a hairline.
// ---------------------------------------------------------------------------

function setProgress(text, fraction) {
  const box = $('progress');
  box.hidden = false;
  box.querySelector('.progress__text').textContent = text;
  const fill = box.querySelector('.progress__fill');
  fill.style.width = fraction == null ? '0%' : `${Math.round(fraction * 100)}%`;
}

function renderProgress() {
  if (ui.phase === 'following' || ui.phase === 'failed') $('progress').hidden = true;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  renderProgress();
  renderReferee();
  renderLookup();
}

/** True while counts can still climb, which every answer has to admit to. */
const settling = () => ui.phase !== 'following';

// ---------------------------------------------------------------------------
// The referee panel
// ---------------------------------------------------------------------------

function renderReferee() {
  const panel = $('referee-panel');

  if (ui.phase === 'failed') {
    panel.replaceChildren(
      el('p', 'empty', 'Could not read any room. Nothing here can be shown as verified.'),
      problemsBlock()
    );
    return;
  }

  if (!ui.ready) {
    // No state until something has actually verified — a light rendered off
    // nothing is worse than no light.
    panel.replaceChildren(el('p', 'empty', 'Reading the rooms and checking signatures…'));
    return;
  }

  const live = tracker.liveness(Date.now());
  const parts = [];

  const state = el('div', `state state--${live.state}`);
  state.append(el('span', 'state__dot'));
  state.append(el('span', 'state__word', live.state));
  parts.push(state);

  if (live.reasons.length) parts.push(el('p', 'state__reasons', live.reasons.join(' ')));

  parts.push(el('p', 'frontier', live.frontierSummary));

  const counts = el('div', 'counts');
  for (const [value, label] of [
    [live.receipts5, 'in 5 min'],
    [live.receipts15, 'in 15 min'],
    [live.receipts60, 'in 60 min'],
  ]) {
    const box = el('div', 'count');
    box.append(el('span', 'count__value', num.format(value)));
    box.append(el('span', 'count__label', label));
    counts.append(box);
  }
  parts.push(counts);
  parts.push(el('p', 'card__note', 'Receipts issued by the referee, counted from when it posted them.'));

  const lastAge = live.lastRefereeMessage ? formatAge(live.lastRefereeMessage.ageMs) : null;
  const statusAge = live.status ? formatAge(live.status.ageMs) : null;

  parts.push(
    facts([
      ['Last message', lastAge ? `${lastAge} ago` : 'none verified yet'],
      [
        'Frontier',
        live.frontier
          ? `intake ${num.format(live.frontier.intakeSeq)} · received ${formatUtc(
              live.frontier.receivedAtMs
            )}`
          : 'no verified receipt yet',
      ],
      ['Intake rate', formatRate(live.throughput) ?? 'not enough receipts yet'],
      [
        '4-hourly status',
        live.status
          ? `${statusAge} ago${live.status.overdue ? ' — overdue' : ''}`
          : 'not seen in what Foolscap has read',
      ],
      ['Verified', `${num.format(live.verified)} messages from the pinned DID`],
    ])
  );

  const forgeries = forgeriesBlock(live.forgeries);
  if (forgeries) parts.push(forgeries);

  parts.push(coverageBlock());
  panel.replaceChildren(...parts);
}

function forgeriesBlock(forgeries) {
  if (!forgeries || forgeries.length === 0) return null;

  const box = el('section', 'forgeries');
  const count = forgeries.length;
  box.append(
    el('h3', 'forgeries__title', `${num.format(count)} ${count === 1 ? 'forgery' : 'forgeries'} found`)
  );
  box.append(
    el(
      'p',
      'forgeries__lede',
      'These messages claim the referee. None of them counted towards anything above.'
    )
  );

  for (const forged of forgeries) {
    const item = el('article', 'forgery');
    item.append(el('span', 'forgery__tag', forgeryTag(forged)));
    item.append(el('p', 'forgery__detail', forged.forgery.detail));
    const where = el('p', 'forgery__where');
    // seq is an identifier, not a quantity — no thousands separators.
    where.append(document.createTextNode(`${forged.room} · seq ${forged.seq} · `));
    where.append(el('span', 'mono', forged.from ?? 'unknown sender'));
    item.append(where);
    box.append(item);
  }
  return box;
}

function forgeryTag(forged) {
  const { reason, selfSignatureValid } = forged.forgery;
  if (reason === 'wrong-signer') {
    return selfSignatureValid
      ? 'correctly signed, by the wrong key'
      : 'wrong key, and not signed by that key either';
  }
  return 'carries the referee DID; signature does not verify';
}

function coverageBlock() {
  const box = el('div', 'coverage');
  box.append(
    el(
      'p',
      null,
      `Read from ${plural(WATCHED_ROOMS.length, 'room')}. Rooms are rings, so anything old ` +
        'enough to have rotated out is not here.'
    )
  );
  for (const gap of ui.gaps.slice(-3)) box.append(el('p', 'coverage__problem', gap));
  const problems = problemsBlock();
  if (problems) box.append(problems);
  return box;
}

function problemsBlock() {
  if (ui.problems.length === 0) return null;
  const box = el('div');
  for (const problem of ui.problems.slice(-3)) {
    box.append(el('p', 'coverage__problem', problem));
  }
  return box;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function renderLookup() {
  const box = $('lookup-result');

  if (ui.query === '') {
    box.replaceChildren();
    return;
  }

  if (!ui.ready) {
    box.replaceChildren(el('p', 'empty', 'Reading the rooms. Your answer lands as soon as they are in.'));
    return;
  }

  const result = tracker.lookup(ui.query, { nowMs: Date.now() });
  const parts = [statusCard(result, result.entry)];

  if (result.entries.length > 1) {
    const others = el('section', 'others');
    others.append(
      el('p', 'others__title', `${plural(result.entries.length - 1, 'other request')} from this DID`)
    );
    for (const entry of result.entries.slice(1)) others.append(otherRow(entry));
    parts.push(others);
  }

  box.replaceChildren(...parts);
}

function statusCard(result, entry) {
  const status = result.status;
  const card = el('article', `card${WANTS_ATTENTION.has(status) ? ' card--attention' : ''}`);

  card.append(el('h3', 'card__status', STATUS_WORD[status] ?? status));

  // The subject is what was asked about, never what was found — a DID query that
  // printed a request_id here would look like it had answered a different question.
  const subject = el('p', 'card__subject');
  subject.append(document.createTextNode(result.queryKind === 'did' ? 'DID ' : 'request_id '));
  subject.append(el('span', 'mono', result.query));
  card.append(subject);

  // Verbatim, exactly as contest.js wrote it.
  card.append(el('p', 'card__copy', result.copy));

  if (settling()) {
    card.append(
      el(
        'p',
        'card__note',
        'Foolscap is still verifying the backfill, so this answer can still change.'
      )
    );
  }

  if (!entry) return card;

  if (entry.reason) {
    const quote = el('div', 'verbatim');
    quote.append(el('span', 'verbatim__label', "The referee's reason, verbatim"));
    quote.append(el('span', 'verbatim__text', entry.reason));
    card.append(quote);
  }

  card.append(facts(factsFor(result, entry)));
  return card;
}

function factsFor(result, entry) {
  const rows = [];

  // For a DID query the headline is one of several requests, so name which.
  if (result.queryKind === 'did' && entry.requestId) {
    rows.push(['Newest request', entry.requestId, 'mono']);
  }

  if (entry.request) {
    rows.push(['Posted', `${formatUtc(entry.tsMs)} · ${formatAge(Date.now() - entry.tsMs)} ago`]);
    rows.push(['Room', entry.room, 'mono']);
    rows.push(['Type', entry.type, 'mono']);
    if (result.queryKind !== 'did' && entry.request.from) {
      rows.push(['Signed by', entry.request.from, 'mono']);
    }
  }

  if (entry.receipt) {
    rows.push(['Intake', `#${num.format(entry.receipt.intakeSeq)}`]);
    rows.push([
      'Taken in',
      `${formatUtc(entry.receipt.receivedAtMs)} · ${formatAge(
        Date.now() - entry.receipt.receivedAtMs
      )} ago`,
    ]);
    if (entry.receipt.role) rows.push(['Role', entry.receipt.role]);
    if (!entry.request) {
      rows.push([
        'The request itself',
        'has rotated out of the ring — the receipt is what remains',
      ]);
    }
  }

  if (entry.status === STATUS.QUEUED && entry.eta) {
    rows.push(['Ahead of you', plural(entry.eta.ahead, 'message')]);
    const eta = formatEta(entry.eta);
    if (eta) rows.push(['Estimate', `${eta} — an estimate; the referee bursts and stalls`]);
    const rate = formatRate(entry.eta.throughput);
    if (rate) rows.push(['At', rate]);
  }

  if (entry.status === STATUS.QUEUED && entry.frontierKnown === false) {
    rows.push(['Estimate', 'none — no verified receipt has been seen, so there is no frontier']);
  }

  if (entry.status === STATUS.UNANSWERED && entry.behindFrontierMs != null) {
    rows.push(['Behind the frontier', `${formatAge(entry.behindFrontierMs)}`]);
  }

  return rows;
}

function otherRow(entry) {
  const row = el('div', 'row');
  const attention = WANTS_ATTENTION.has(entry.status);
  row.append(el('span', `row__status${attention ? ' row__status--attention' : ''}`, STATUS_WORD[entry.status] ?? entry.status));
  row.append(el('span', 'row__id mono', entry.requestId ?? '—'));
  const when = entry.tsMs ?? entry.receipt?.receivedAtMs;
  if (when) row.append(el('span', 'row__when', `${formatAge(Date.now() - when)} ago`));
  return row;
}

// ---------------------------------------------------------------------------

$('lookup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  ui.query = $('q').value.trim();
  renderLookup();
});

boot().catch((err) => {
  ui.phase = 'failed';
  ui.problems.push(err instanceof Error ? err.message : String(err));
  render();
});
