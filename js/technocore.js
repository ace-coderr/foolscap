// technocore.js — reading rooms: export backfill, long-poll, ring-gap detection.
//
// technocore.chat sends access-control-allow-origin: *, so every read here runs
// straight from the browser. Nothing in this module signs or verifies; it hands
// raw records to did.js and contest.js and keeps its opinions to itself.
//
// Wire shapes this module was written against:
//
//   GET /r/<room>?format=json&since=<seq>&wait=<seconds>
//     { room, count, first_seq, last_seq, generation,
//       messages: [ { seq, ts, from, text, nonce, sig } ] }
//
//   GET /r/<room>/export   ->  application/x-ndjson, one record per line,
//                              plus an x-room-generation header.

export const BASE = 'https://technocore.chat';

/** Room names are lowercase, digits and hyphens. */
export const ROOM_RE = /^[a-z0-9][a-z0-9-]*$/;

export function assertRoom(room) {
  const value = String(room ?? '').trim();
  if (!ROOM_RE.test(value)) {
    throw new Error(`"${room}" is not a room name. Rooms are lowercase letters, digits and hyphens.`);
  }
  return value;
}

export function roomUrl(room) {
  return `${BASE}/r/${assertRoom(room)}`;
}

/** An HTTP-level failure, carrying enough to decide whether to retry. */
export class TechnocoreError extends Error {
  constructor(message, { status = 0, room = null, body = '', retryAfter = null } = {}) {
    super(message);
    this.name = 'TechnocoreError';
    this.status = status;
    this.room = room;
    this.body = body;
    this.retryAfter = retryAfter;
  }

  /** Worth trying again: transport failures, rate limits, 5xx. */
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

// ---------------------------------------------------------------------------
// JSON that survives large nonces
// ---------------------------------------------------------------------------

/**
 * JSON.parse, except that integers which cannot round-trip through a double are
 * returned as their raw decimal string, as are values under any key listed in
 * `stringKeys`.
 *
 * Nonces may exceed 2^53. A nonce that arrives as 1789166780447123456 and leaves
 * as 1789166780447123500 rebuilds a canonical string that no signature matches,
 * so every nonce Foolscap touches stays a string from the moment it is parsed.
 */
export function parseJson(text, { stringKeys = [] } = {}) {
  const keep = stringKeys instanceof Set ? stringKeys : new Set(stringKeys);
  const src = String(text);
  const n = src.length;
  let i = 0;

  const fail = (msg) => {
    throw new SyntaxError(`${msg} at position ${i}`);
  };

  const ws = () => {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };

  const string = () => {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      i++;
      if (c === '"') break;
    }
    // Hand the slice to JSON.parse so escape handling stays exactly the spec's.
    return JSON.parse(src.slice(start, i));
  };

  const number = (key) => {
    const start = i;
    if (src[i] === '-') i++;
    while (i < n && src[i] >= '0' && src[i] <= '9') i++;
    let isInt = true;
    if (src[i] === '.') {
      isInt = false;
      i++;
      while (i < n && src[i] >= '0' && src[i] <= '9') i++;
    }
    if (src[i] === 'e' || src[i] === 'E') {
      isInt = false;
      i++;
      if (src[i] === '+' || src[i] === '-') i++;
      while (i < n && src[i] >= '0' && src[i] <= '9') i++;
    }
    const raw = src.slice(start, i);
    if (raw === '' || raw === '-') fail('malformed number');
    const value = Number(raw);
    if (isInt && (keep.has(key) || !Number.isSafeInteger(value))) return raw;
    return value;
  };

  const array = () => {
    i++; // [
    const out = [];
    ws();
    if (src[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      out.push(value(null));
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === ']') {
        i++;
        return out;
      }
      fail('expected "," or "]"');
    }
  };

  const object = () => {
    i++; // {
    const out = {};
    ws();
    if (src[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      ws();
      if (src[i] !== '"') fail('expected an object key');
      const key = string();
      ws();
      if (src[i] !== ':') fail('expected ":"');
      i++;
      out[key] = value(key);
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === '}') {
        i++;
        return out;
      }
      fail('expected "," or "}"');
    }
  };

  function value(key) {
    ws();
    if (i >= n) fail('unexpected end of JSON');
    const c = src[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) return number(key);
    if (src.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (src.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (src.startsWith('null', i)) {
      i += 4;
      return null;
    }
    return fail(`unexpected character ${JSON.stringify(c)}`);
  }

  const result = value(null);
  ws();
  if (i < n) fail('trailing characters after the JSON value');
  return result;
}

/** Parse one room record, keeping the nonce as a string. */
export function parseRecord(line) {
  return parseJson(line, { stringKeys: ['nonce'] });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Normalise a raw record into the shape the rest of Foolscap uses.
 *
 * `text` is left exactly as the server stored it — no trimming, no Unicode
 * normalisation — because it is half of the canonical string.
 */
export function normalizeMessage(raw, room) {
  const ts = typeof raw.ts === 'string' ? raw.ts : null;
  return {
    room: room ?? raw.room ?? null,
    seq: typeof raw.seq === 'number' ? raw.seq : Number(raw.seq),
    ts,
    tsMs: ts ? Date.parse(ts) : NaN,
    from: raw.from ?? raw.did ?? null,
    text: typeof raw.text === 'string' ? raw.text : '',
    nonce: raw.nonce == null ? null : String(raw.nonce),
    sig: raw.sig ?? null,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Ring gaps
// ---------------------------------------------------------------------------

/**
 * Rooms are rings. If a reply's first_seq is past since + 1, the lines in
 * between rotated out before we asked for them.
 *
 * Two different facts wear the same shape, so they are labelled:
 *   'rotated' — the first read of a room that has already dropped old lines.
 *               Expected and harmless; it just bounds what Foolscap can see.
 *   'missed'  — lines went past while we were following the room. Surface this;
 *               a receipt may have been among them.
 */
export function detectGap({ since, firstSeq, count }) {
  if (!count || firstSeq == null) return null;
  const expected = since + 1;
  if (firstSeq <= expected) return null;
  return {
    kind: since === 0 ? 'rotated' : 'missed',
    since,
    expected,
    firstSeq,
    missing: firstSeq - expected,
  };
}

// ---------------------------------------------------------------------------
// Read budget
// ---------------------------------------------------------------------------

const BUDGET_HEADERS = [
  'x-read-budget',
  'x-read-budget-remaining',
  'x-ratelimit-remaining',
  'ratelimit-remaining',
];
const BUDGET_LIMIT_HEADERS = ['x-read-budget-limit', 'x-ratelimit-limit', 'ratelimit-limit'];
const BUDGET_BODY_KEYS = ['budget', 'read_budget', 'reads_remaining', 'remaining'];

/**
 * Best-effort read-budget reading. The server only mentions the budget once you
 * drop below a quarter bucket, and it may say so in the body or in a header, so
 * this looks in both and returns null when nothing says anything.
 */
export function extractBudget(body, headers) {
  const out = { remaining: null, limit: null, resetSeconds: null, source: null, raw: null };

  if (body && typeof body === 'object') {
    for (const key of BUDGET_BODY_KEYS) {
      const value = body[key];
      if (value == null) continue;
      if (typeof value === 'number') {
        out.remaining = value;
        out.source = `body.${key}`;
        out.raw = value;
      } else if (typeof value === 'object') {
        out.remaining = numberOrNull(value.remaining ?? value.left ?? value.reads);
        out.limit = numberOrNull(value.limit ?? value.bucket ?? value.capacity);
        out.resetSeconds = numberOrNull(value.reset ?? value.reset_in ?? value.refill_in);
        out.source = `body.${key}`;
        out.raw = value;
      }
      if (out.source) break;
    }
  }

  if (out.remaining == null && headers && typeof headers.get === 'function') {
    for (const name of BUDGET_HEADERS) {
      const value = headers.get(name);
      if (value != null) {
        out.remaining = numberOrNull(value);
        out.source = name;
        out.raw = value;
        break;
      }
    }
    for (const name of BUDGET_LIMIT_HEADERS) {
      const value = headers.get(name);
      if (value != null) {
        out.limit = numberOrNull(value);
        break;
      }
    }
  }

  if (out.remaining == null && out.limit == null) return null;
  out.fraction = out.limit ? out.remaining / out.limit : null;
  // The server going quiet on the budget means we are above a quarter bucket;
  // being told about it at all is the warning.
  out.low = out.fraction != null ? out.fraction < 0.25 : out.remaining != null;
  return out;
}

function numberOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

let bustCounter = 0;

async function request(url, { signal, fetchImpl, room, accept } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch(url, {
      method: 'GET',
      signal,
      headers: accept ? { accept } : undefined,
      cache: 'no-store',
      redirect: 'follow',
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new TechnocoreError(
      `Could not reach ${BASE}. Check the connection and try again.`,
      { room, body: err instanceof Error ? err.message : String(err) }
    );
  }

  if (!res.ok) {
    const body = await safeText(res);
    const retryAfter = numberOrNull(res.headers.get('retry-after'));
    throw new TechnocoreError(describeStatus(res.status, room, body), {
      status: res.status,
      room,
      body,
      retryAfter,
    });
  }
  return res;
}

function describeStatus(status, room, body) {
  const detail = body ? ` — ${body.slice(0, 200).trim()}` : '';
  if (status === 404) return `Room ${room} does not exist, or it idled out and was deleted${detail}`;
  if (status === 429) return `Rate limited reading ${room}. Foolscap is backing off${detail}`;
  if (status >= 500) return `technocore.chat returned ${status} for ${room}. Retrying${detail}`;
  return `Reading ${room} failed with ${status}${detail}`;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * One read of a room.
 *
 * `wait` is the long-poll timeout in seconds; the reply returns as soon as a
 * message lands. `bust` appends a throwaway counter because the URL is otherwise
 * unchanged between idle polls and caches will happily answer from memory.
 */
export async function readRoom(room, { since = 0, wait = 0, signal, fetchImpl, bust = true } = {}) {
  const name = assertRoom(room);
  const params = new URLSearchParams({ format: 'json', since: String(since), wait: String(wait) });
  if (bust) params.set('n', String(++bustCounter));

  const res = await request(`${BASE}/r/${name}?${params}`, {
    signal,
    fetchImpl,
    room: name,
    accept: 'application/json',
  });

  const body = await res.text();
  let data;
  try {
    data = parseRecord(body);
  } catch (err) {
    throw new TechnocoreError(`Reading ${name} returned something that is not JSON.`, {
      room: name,
      body: body.slice(0, 500),
      status: res.status,
    });
  }

  const messages = Array.isArray(data.messages)
    ? data.messages.map((raw) => normalizeMessage(raw, name))
    : [];

  return {
    room: name,
    since,
    count: data.count ?? messages.length,
    firstSeq: data.first_seq ?? null,
    lastSeq: data.last_seq ?? (messages.length ? messages[messages.length - 1].seq : since),
    generation: data.generation ?? numberOrNull(res.headers.get('x-room-generation')),
    messages,
    gap: detectGap({ since, firstSeq: data.first_seq ?? null, count: messages.length }),
    budget: extractBudget(data, res.headers),
    data,
  };
}

/**
 * The whole retained ring as it stands, for the initial backfill.
 *
 * /export is a snapshot cut at the last complete line, so a record written
 * mid-dump can arrive truncated. That tail is dropped and reported rather than
 * parsed into something half-true; the poll that follows will pick it up.
 */
export async function exportRoom(room, { signal, fetchImpl } = {}) {
  const name = assertRoom(room);
  const res = await request(`${BASE}/r/${name}/export`, {
    signal,
    fetchImpl,
    room: name,
    accept: 'application/x-ndjson',
  });

  const body = await res.text();
  const lines = body.split('\n');
  let truncatedTail = null;
  if (body.length > 0 && !body.endsWith('\n')) {
    truncatedTail = lines.pop() ?? null;
  }

  const messages = [];
  const malformed = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      messages.push(normalizeMessage(parseRecord(line), name));
    } catch (err) {
      malformed.push({ line, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    room: name,
    messages,
    malformed,
    truncatedTail,
    generation: numberOrNull(res.headers.get('x-room-generation')),
    firstSeq: messages.length ? messages[0].seq : null,
    lastSeq: messages.length ? messages[messages.length - 1].seq : 0,
  };
}

// ---------------------------------------------------------------------------
// Following a room
// ---------------------------------------------------------------------------

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const isAbort = (err) => err && (err.name === 'AbortError' || err.code === 20);

/**
 * Backfill a room from /export, then follow it with long polls.
 *
 * Handlers, all optional:
 *   onMessages({ room, messages, source })  source is 'backfill' or 'poll'
 *   onGap(gap)          a ring gap, shaped by detectGap
 *   onBudget(budget)    read budget, only once the server starts reporting it
 *   onStatus(status)    { room, state, since, generation, error, retryIn }
 *   onError(error)      transport or HTTP failure; the watcher keeps going
 *
 * state is 'starting' | 'backfilling' | 'following' | 'retrying' | 'stopped'.
 */
export class RoomWatcher {
  constructor(room, options = {}) {
    this.room = assertRoom(room);
    this.wait = options.wait ?? 10;
    this.backfill = options.backfill !== false;
    this.since = options.since ?? 0;
    this.generation = null;
    this.state = 'stopped';

    this.minInterval = options.minInterval ?? 0;
    this.lowBudgetInterval = options.lowBudgetInterval ?? 15000;
    this.maxBackoff = options.maxBackoff ?? 30000;

    this.onMessages = options.onMessages ?? (() => {});
    this.onGap = options.onGap ?? (() => {});
    this.onBudget = options.onBudget ?? (() => {});
    this.onStatus = options.onStatus ?? (() => {});
    this.onError = options.onError ?? (() => {});
    this.fetchImpl = options.fetchImpl;

    this._controller = null;
    this._failures = 0;
    this._budget = null;
    this._loop = null;
  }

  start() {
    if (this._loop) return this._loop;
    this._controller = new AbortController();
    this._failures = 0;
    this._loop = this._run().finally(() => {
      this._loop = null;
    });
    return this._loop;
  }

  /** Stop following. In-flight long polls are aborted. */
  stop() {
    this._controller?.abort();
    this._controller = null;
    this._setState('stopped');
  }

  get running() {
    return this._loop != null;
  }

  _setState(state, extra = {}) {
    // Only on a real transition: 'following' fires once per poll otherwise, and
    // a status line that repaints every ten seconds reads as churn.
    const changed = this.state !== state;
    this.state = state;
    if (!changed && Object.keys(extra).length === 0) return;
    this.onStatus({
      room: this.room,
      state,
      since: this.since,
      generation: this.generation,
      budget: this._budget,
      ...extra,
    });
  }

  async _run() {
    const signal = this._controller.signal;
    this._setState('starting');

    if (this.backfill && this.since === 0) {
      try {
        this._setState('backfilling');
        const dump = await exportRoom(this.room, { signal, fetchImpl: this.fetchImpl });
        this.generation = dump.generation;
        if (dump.messages.length) {
          this.since = dump.lastSeq;
          this.onMessages({ room: this.room, messages: dump.messages, source: 'backfill' });
        }
        if (dump.truncatedTail != null) {
          // Expected: /export cuts at the last complete line. The next poll covers it.
          this.onStatus({
            room: this.room,
            state: 'backfilling',
            since: this.since,
            generation: this.generation,
            note: 'The export ended mid-record; the following poll picks that message up.',
          });
        }
        if (dump.malformed.length) {
          this.onError(
            new TechnocoreError(
              `${dump.malformed.length} record(s) in the ${this.room} export could not be parsed.`,
              { room: this.room, body: dump.malformed[0].error }
            )
          );
        }
      } catch (err) {
        if (isAbort(err)) return;
        // A failed backfill is not fatal — fall through to polling from 0, which
        // returns the retained ring anyway, just without the export's guarantees.
        this.onError(err);
      }
    }

    for (;;) {
      if (signal.aborted) return;
      try {
        this._setState('following');
        const result = await readRoom(this.room, {
          since: this.since,
          wait: this.wait,
          signal,
          fetchImpl: this.fetchImpl,
        });

        if (this._handleGeneration(result.generation)) continue;

        if (result.gap) this.onGap(result.gap);

        if (result.messages.length) {
          this.since = result.lastSeq ?? this.since;
          this.onMessages({ room: this.room, messages: result.messages, source: 'poll' });
        }

        if (result.budget) {
          this._budget = result.budget;
          this.onBudget(result.budget);
        }

        this._failures = 0;
        await sleep(this._pace(), signal);
      } catch (err) {
        if (isAbort(err)) return;
        this._failures++;
        this.onError(err);
        const retryIn = this._backoff(err);
        this._setState('retrying', { error: err, retryIn });
        try {
          await sleep(retryIn, signal);
        } catch {
          return;
        }
      }
    }
  }

  /**
   * A room that idles out and is recreated comes back as generation n+1 with
   * sequence numbers starting over. Following it with the old `since` would sit
   * silent forever, so reset and re-backfill.
   */
  _handleGeneration(generation) {
    if (generation == null) return false;
    if (this.generation == null) {
      this.generation = generation;
      return false;
    }
    if (generation === this.generation) return false;

    const previous = this.generation;
    this.generation = generation;
    this.since = 0;
    this.onGap({
      kind: 'regenerated',
      room: this.room,
      previousGeneration: previous,
      generation,
      missing: null,
    });
    return true;
  }

  /** Pause between polls. Normally none — the long poll is the wait. */
  _pace() {
    if (this._budget?.low) return this.lowBudgetInterval;
    return this.minInterval;
  }

  _backoff(err) {
    if (err instanceof TechnocoreError && err.retryAfter != null) {
      return Math.min(err.retryAfter * 1000, this.maxBackoff);
    }
    const base = Math.min(1000 * 2 ** (this._failures - 1), this.maxBackoff);
    return Math.round(base * (0.5 + Math.random() * 0.5)); // jitter
  }
}

/**
 * Follow several rooms at once. Returns { watchers, stop } — handlers are shared
 * and every callback carries its room.
 */
export function watchRooms(rooms, options = {}) {
  const watchers = rooms.map((room) => new RoomWatcher(room, options));
  watchers.forEach((w) => w.start());
  return {
    watchers,
    stop() {
      watchers.forEach((w) => w.stop());
    },
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * The GET form of a signed post. This is what Foolscap hands the user in default
 * mode: a URL they can inspect before opening.
 *
 * `text` must be the swept text that was signed, and `nonce` a string — not a
 * Number that has been through a JSON round trip.
 */
export function saySignedUrl({ room, did, sig, nonce, text }) {
  const name = assertRoom(room);
  return (
    `${BASE}/r/${name}/say-signed/` +
    `${encodeURIComponent(did)}/${encodeURIComponent(sig)}/` +
    `${encodeURIComponent(String(nonce))}/${encodeURIComponent(text)}`
  );
}

/**
 * The POST form. Prefer saySignedUrl in the browser: a JSON POST triggers a CORS
 * preflight, and the GET form does not.
 *
 * Returns the parsed reply. A 400 saying `nonce <n> is not greater than <n>`
 * means the earlier message already landed — that is not a failure to retry.
 */
export async function postSigned({ room, did, sig, nonce, text }, { signal, fetchImpl } = {}) {
  const name = assertRoom(room);
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(`${BASE}/r/${name}`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did, sig, nonce: String(nonce), text }),
  });
  const body = await safeText(res);
  if (!res.ok) {
    throw new TechnocoreError(describePostFailure(res.status, body), {
      status: res.status,
      room: name,
      body,
    });
  }
  try {
    return parseRecord(body);
  } catch {
    return { ok: true, body };
  }
}

function describePostFailure(status, body) {
  const text = (body || '').trim();
  const nonceClash = text.match(/nonce (\d+) is not greater than (\d+)/);
  if (nonceClash) {
    return (
      `Nonce ${nonceClash[1]} is not greater than ${nonceClash[2]}, the last one this key used ` +
      'in this room. The earlier message already landed — check the room before signing again.'
    );
  }
  if (status === 400) return `The server rejected the message: ${text || 'no reason given'}`;
  if (status === 429) return 'Rate limited posting. Wait, then post the same signed message again.';
  return `Posting failed with ${status}${text ? ` — ${text}` : ''}`;
}
