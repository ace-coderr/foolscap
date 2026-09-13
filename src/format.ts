// format.ts — turning numbers into sentences.
//
// View logic, ported from js/ui.js. Nothing here decides anything; it only
// decides how a decided thing reads.

import { STATUS, type StatusCode, type Throughput, type Eta } from './lib/contest.ts';

export const num = new Intl.NumberFormat('en');

export function plural(n: number, word: string): string {
  return `${num.format(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** A duration in words. Used for ages, so it rounds towards readability. */
export function formatAge(ms: number | null | undefined): string | null {
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
export function formatUtc(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

export function formatRate(throughput: Throughput | null | undefined): string | null {
  if (!throughput || throughput.p25 == null || throughput.p75 == null || throughput.median == null) {
    return null;
  }
  return `${throughput.p25.toFixed(1)}–${throughput.p75.toFixed(1)} per minute (median ${throughput.median.toFixed(1)})`;
}

export function formatEta(eta: Eta | null | undefined): string | null {
  if (!eta || eta.fastestMinutes == null || eta.slowestMinutes == null) return null;
  const lo = Math.max(1, Math.round(eta.fastestMinutes));
  const hi = Math.max(1, Math.round(eta.slowestMinutes));
  return lo === hi ? `about ${plural(lo, 'minute')}` : `${num.format(lo)}–${num.format(hi)} minutes`;
}

export const STATUS_WORD: Record<StatusCode, string> = {
  [STATUS.NOT_SEEN]: 'Not seen yet',
  [STATUS.QUEUED]: 'Queued',
  [STATUS.ACCEPTED]: 'Accepted',
  [STATUS.REJECTED]: 'Rejected',
  [STATUS.UNANSWERED]: 'Unanswered',
  // Not "Unanswered": nothing was ever going to answer it.
  [STATUS.NO_RECEIPT_EXPECTED]: 'Posted',
};

/** Accent is reserved for the states that want something from the reader. */
export const WANTS_ATTENTION: ReadonlySet<StatusCode> = new Set<StatusCode>([
  STATUS.REJECTED,
  STATUS.UNANSWERED,
]);

/**
 * Statuses a lost message could have changed.
 *
 * A receipt in hand is evidence whatever else is missing, so Accepted and
 * Rejected stand. The others are conclusions drawn from absence, and absence is
 * exactly what a hole manufactures.
 */
export const AT_RISK_FROM_HOLES: ReadonlySet<StatusCode> = new Set<StatusCode>([
  STATUS.NOT_SEEN,
  STATUS.QUEUED,
  STATUS.UNANSWERED,
]);
