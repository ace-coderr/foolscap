// ratelimit.ts — a token bucket, per client, for /capture.
//
// NOTARY.md: "Rate limiting on /capture, or the first bored agent turns the
// archive into a landfill." The archive's value is that every row is something
// somebody signed and somebody else might come asking about; a million rows of
// noise costs disk, costs anchor time, and dilutes nothing else — but it does
// eventually stop capture everywhere, which is the failure mode policy.ts is
// already built around.
//
// A bucket rather than a fixed window: an agent that legitimately has a hundred
// messages to submit should be able to, once, and then settle to the drip rate.
// A fixed window would refuse the burst and then allow another full window a
// second later, which is both stricter and looser than intended.
//
// Pure aside from the clock, which is injected, so the whole thing is testable
// without waiting for real seconds to pass.

export interface Verdict {
  allowed: boolean;
  /** Tokens left after this request. */
  remaining: number;
  /** Seconds until one more token exists. Sent as Retry-After on a refusal. */
  retryAfter: number;
}

export interface BucketOptions {
  /** Burst size. */
  capacity?: number;
  /** Tokens added per second, once the burst is spent. */
  refillPerSecond?: number;
  /** Buckets untouched for this long are forgotten. */
  idleMs?: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

/**
 * IN-PROCESS, AND THAT IS A REAL LIMIT. Two instances behind a load balancer
 * each allow the full rate, so the effective ceiling is per instance rather than
 * global. Notary runs as one process today — the mirror holds a Postgres
 * connection and there is nothing to gain from a second copy — so this is
 * correct now and is the first thing to replace if it is ever scaled out.
 * Recording it here rather than discovering it later.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly idleMs: number;

  constructor({ capacity = 60, refillPerSecond = 1, idleMs = 600_000 }: BucketOptions = {}) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.idleMs = idleMs;
  }

  take(key: string, now: number = Date.now()): Verdict {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };

    // Refill for the time that has passed, capped at the burst size.
    const elapsed = Math.max(0, now - bucket.updated) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    bucket.updated = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: 0,
        // Always at least a second: a Retry-After of 0 invites an immediate
        // retry, which is the behaviour being limited.
        retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerSecond)),
      };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfter: 0 };
  }

  /** Drop idle buckets so a long-running process does not grow a map forever. */
  sweep(now: number = Date.now()): number {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated > this.idleMs) this.buckets.delete(key);
    }
    return this.buckets.size;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * The client, as well as it can be known behind a proxy.
 *
 * Railway and Fly both terminate TLS and forward, so the socket address is the
 * proxy for every request and x-forwarded-for is the only thing that
 * distinguishes callers. It is also client-controlled, so the LEFTMOST entry is
 * taken only as a hint: a determined abuser can rotate it freely. That is
 * acceptable for a limiter whose job is stopping accidents and bored agents,
 * and it is not a security control.
 */
export function clientKey(headers: Record<string, string | string[] | undefined>, fallback: string): string {
  const forwarded = headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = first?.split(',')[0]?.trim();
  return candidate && candidate.length > 0 ? candidate : fallback;
}
