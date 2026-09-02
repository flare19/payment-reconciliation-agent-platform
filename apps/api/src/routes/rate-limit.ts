/**
 * HTTP rate limiting, tiered by what an endpoint actually costs (ADR-096).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT THE SAME GUARD AS `services/agent/rate-limiter.ts`, AND THE TWO
 * MUST NOT BE MERGED.
 *
 * That one paces requests we SEND to the model provider, to stay inside a quota
 * we are a client of. This one meters requests we RECEIVE, from anyone on the
 * internet. They share a name and nothing else: different direction, different
 * threat, different consequence for being wrong.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS EXISTS AT ALL ──
 * Two meters bill for traffic this API accepts without authentication. ADR-093
 * put the Analyst on a prepaid Anthropic key with auto-reload OFF, and Railway
 * bills CPU, egress and Postgres storage by usage. ADR-095 bounded the MONEY on
 * the one endpoint that spends it — correctly, and that bound is untouched here
 * — but it bounds dollars, not requests, and only for Phase A. `POST /api/runs`
 * spends no LLM money at all and is the cheapest way to hurt this deployment:
 * measured on Railway at 2.4 s and ~1,700 rows written per call, in a loop, from
 * a URL that must stay open because judges have to click it (ARCHITECTURE §5).
 * The surface cannot be closed. It can only be metered.
 *
 * ── PER-IP, WITH A GLOBAL CAP ONLY WHERE IT EARNS ITS DENIAL-OF-SERVICE RISK ──
 * A single global limit protects the wallet and hands an attacker a DoS against
 * the demo: one script drains the shared bucket and every judge gets a 429. So
 * the primary bucket is per IP, and a global cap sits BEHIND it only for `run`,
 * where storage is cumulative and rotating IPs is cheap. It is sized so the
 * per-IP limit always binds first for an honest user.
 *
 * `investigate` deliberately gets NO new global cap. ADR-095's derived $2/hour
 * already is one, and a second would make the demo's failure mode a request
 * count nobody can reason about instead of a dollar figure everyone can.
 *
 * ── WHY IN MEMORY, WHEN ADR-095 REFUSED AN IN-MEMORY COUNTER ──
 * ADR-095 guards MONEY, where a counter cleared by crashing the process is a
 * ceiling an attacker can clear. This guards REQUEST VOLUME, where crashing the
 * process is itself the outage being defended against — clearing the counter
 * buys the attacker nothing they did not already have. And a database
 * round-trip on every request would make the limiter a load amplifier: a query
 * added to exactly the flood it exists to survive. The money ceiling stays
 * derived from rows already written and is unaffected by anything in this file.
 * That is the defence in depth, and it is why the weaker mechanism is
 * acceptable here and was not acceptable there.
 *
 * ── THE KEY TABLE IS BOUNDED, OR THE LIMITER IS THE ATTACK ──
 * Buckets are pruned when their window empties, and the table is capped at
 * `MAX_TRACKED_KEYS`. Without the cap, rotating the source IP turns this file
 * into the memory-exhaustion attack it was added to prevent.
 *
 * ── NO WALL CLOCK IN THE MECHANISM ──
 * `now` is injected, so the tests run a full hour instantly (CLAUDE.md §4 rule 8
 * is about the DECISION path; this is timing, but the injection is what makes a
 * one-hour window testable in a millisecond).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** The four cost classes. Named in `api-contract.md` §0 and in the 429 body. */
export type RateLimitTier = 'read' | 'write' | 'run' | 'investigate';

export interface TierRule {
  /** Requests admitted per window, per client IP. */
  perIp: number;
  /** Requests admitted per window across ALL clients. `null` = no global cap. */
  global: number | null;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Every number here is derived from a measurement, not chosen for feeling safe
 * (ADR-086's rule: measure a bound before adopting it).
 *
 *  read        the busiest legitimate screen issues ~12 requests, and §5's
 *              750 ms poll loop is 80/min against this 240 — so a run that
 *              takes ~3 s costs ~4 polls and never approaches the limit.
 *              WIDENED 120 -> 240 (Tejas, 2026-09-03): a single real judge
 *              never approached 120 either, by this same math -- the 120
 *              instances that actually fired that day were `score:watch`'s
 *              own polling, this session's testing traffic, and a handful
 *              of impatient reloads, all sharing ONE bucket on localhost
 *              (one IP for everything hitting the API on one machine). 240
 *              is still a small fraction of what a scripted abuser would
 *              need to matter -- reads cost no money and this tier's job is
 *              shielding request VOLUME, not the wallet (that is `run` and
 *              `investigate`, both untouched) -- and it buys real headroom
 *              for concurrent local tooling without changing what this tier
 *              is actually for.
 *  write       one human click each.
 *  run         measured on Railway today: 2.4 s and ~1,700 rows per run. 10/h
 *              per IP is ~24 s of engine time; the 40/h global bounds Postgres
 *              growth at ~68k rows/hour, which is days of headroom, not minutes.
 *  investigate measured $0.10-0.12 per investigation (ADR-093), so 12 is ~$1.32
 *              against ADR-095's $2.00/hour ceiling. DELIBERATELY BELOW IT: one
 *              IP must not be able to exhaust the wallet alone, or ADR-095's
 *              refusal stops being a wallet protection and becomes a race
 *              between visitors. The gap is the demo's headroom.
 */
export const RATE_LIMIT_TIERS: Readonly<Record<RateLimitTier, TierRule>> = {
  read: { perIp: 240, global: null, windowMs: MINUTE },
  write: { perIp: 60, global: null, windowMs: HOUR },
  run: { perIp: 10, global: 40, windowMs: HOUR },
  investigate: { perIp: 12, global: null, windowMs: HOUR },
};

/** Above this many tracked IPs, the least-recently-seen is evicted. */
export const MAX_TRACKED_KEYS = 10_000;

/**
 * Classify a request into a tier.
 *
 * Exported because the test suite asserts the classification directly: a
 * limiter that silently files `POST /api/runs` under `read` would pass every
 * behavioural test of the buckets themselves and protect nothing.
 */
export function tierFor(method: string, path: string): RateLimitTier {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'read';
  // `/api/exceptions/:id/investigate` — the only path that reaches the model.
  if (method === 'POST' && /^\/api\/exceptions\/[^/]+\/investigate\/?$/.test(path)) {
    return 'investigate';
  }
  // `/api/runs` exactly — NOT `/api/runs/:id/...`, which are ordinary writes.
  // Anchored on purpose: `startsWith('/api/runs')` would file the manual-match
  // and score-report endpoints under the tightest tier in the table.
  if (method === 'POST' && /^\/api\/runs\/?$/.test(path)) return 'run';
  return 'write';
}

interface Bucket {
  /** Timestamps of admitted requests, ascending. Pruned to the window. */
  hits: number[];
  lastSeen: number;
}

export interface RateLimitOptions {
  tiers?: Partial<Record<RateLimitTier, TierRule>>;
  now?: () => number;
  maxTrackedKeys?: number;
  /** Skip entirely — used by the integration suite, never in production. */
  enabled?: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  tier: RateLimitTier;
  limit: number;
  remaining: number;
  /** Seconds until the oldest hit leaves the window. At least 1. */
  retryAfterSec: number;
  resetAtMs: number;
  /** Which bucket refused: the caller's own, or the deployment-wide one. */
  scope: 'ip' | 'global';
}

/**
 * The bucket store. Separated from the middleware so tests can drive decisions
 * without an Express request, and so `stats()` can be asserted on.
 */
export function createRateLimiter(options: RateLimitOptions = {}) {
  const tiers: Record<RateLimitTier, TierRule> = {
    ...RATE_LIMIT_TIERS,
    ...(options.tiers ?? {}),
  };
  const now = options.now ?? (() => Date.now());
  const maxKeys = options.maxTrackedKeys ?? MAX_TRACKED_KEYS;

  // One map per tier: a read and a run must not share a window, and keeping
  // them separate means a burst of reads cannot evict a run's bucket.
  const perIp = new Map<RateLimitTier, Map<string, Bucket>>();
  const global = new Map<RateLimitTier, Bucket>();
  for (const tier of Object.keys(tiers) as RateLimitTier[]) {
    perIp.set(tier, new Map());
    global.set(tier, { hits: [], lastSeen: 0 });
  }

  function prune(bucket: Bucket, at: number, windowMs: number): void {
    // `<=` so a hit exactly one window old has left it — the same boundary the
    // agent limiter uses, kept identical so the two cannot drift apart.
    let i = 0;
    while (i < bucket.hits.length && bucket.hits[i]! <= at - windowMs) i += 1;
    if (i > 0) bucket.hits.splice(0, i);
  }

  /**
   * Evict the least-recently-seen keys once the table is over its cap.
   *
   * Empty buckets go first — they cost nothing to rebuild. Only if that is not
   * enough does an active bucket get dropped, and dropping one FORGIVES its
   * holder rather than punishing them, which is the safe direction to be wrong
   * in: a limiter that evicts under pressure lets a few extra requests through,
   * where one that grows without bound takes the process down.
   */
  function evictIfNeeded(table: Map<string, Bucket>, at: number, windowMs: number): void {
    if (table.size <= maxKeys) return;
    for (const [key, bucket] of table) {
      prune(bucket, at, windowMs);
      if (bucket.hits.length === 0) table.delete(key);
      if (table.size <= maxKeys) return;
    }
    const byAge = [...table.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key] of byAge) {
      table.delete(key);
      if (table.size <= maxKeys) return;
    }
  }

  function decide(tier: RateLimitTier, ip: string): RateLimitDecision {
    const rule = tiers[tier];
    const at = now();
    const table = perIp.get(tier)!;

    let bucket = table.get(ip);
    if (bucket === undefined) {
      bucket = { hits: [], lastSeen: at };
      table.set(ip, bucket);
    }
    bucket.lastSeen = at;
    prune(bucket, at, rule.windowMs);

    const globalBucket = global.get(tier)!;
    prune(globalBucket, at, rule.windowMs);

    // The per-IP bucket is checked FIRST so an honest client is told about its
    // own budget rather than about a deployment-wide one it cannot influence.
    const overIp = bucket.hits.length >= rule.perIp;
    const overGlobal = rule.global !== null && globalBucket.hits.length >= rule.global;

    if (overIp || overGlobal) {
      const refusing = overIp ? bucket : globalBucket;
      const oldest = refusing.hits[0] ?? at;
      const resetAtMs = oldest + rule.windowMs;
      evictIfNeeded(table, at, rule.windowMs);
      return {
        allowed: false,
        tier,
        limit: overIp ? rule.perIp : rule.global!,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((resetAtMs - at) / 1000)),
        resetAtMs,
        scope: overIp ? 'ip' : 'global',
      };
    }

    // Recorded only on admission. Counting refusals would let a client that
    // ignores its 429s hold its own window open forever.
    bucket.hits.push(at);
    globalBucket.hits.push(at);
    globalBucket.lastSeen = at;
    evictIfNeeded(table, at, rule.windowMs);

    return {
      allowed: true,
      tier,
      limit: rule.perIp,
      remaining: Math.max(0, rule.perIp - bucket.hits.length),
      retryAfterSec: 0,
      resetAtMs: (bucket.hits[0] ?? at) + rule.windowMs,
      scope: 'ip',
    };
  }

  return {
    decide,
    stats: () => ({
      trackedKeys: (Object.keys(tiers) as RateLimitTier[])
        .reduce((sum, t) => sum + perIp.get(t)!.size, 0),
    }),
  };
}

/**
 * Express middleware.
 *
 * Writes `X-RateLimit-*` on EVERY response, not only on refusals, so a client
 * can pace itself rather than discover the limit by hitting it — which matters
 * for the §5 poll loop, the one caller most likely to meet a 429.
 *
 * Refuses with the standard envelope from `app.ts`, built inline rather than by
 * throwing `ApiError`, to keep this module free of a circular import back into
 * the app factory.
 */
export function rateLimit(options: RateLimitOptions = {}): RequestHandler {
  const limiter = createRateLimiter(options);
  const enabled = options.enabled ?? true;

  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) { next(); return; }

    // `req.ip` is only the real client because `trust proxy` is set in
    // `createApp`. Without it every visitor shares Railway's edge address and
    // one bucket — see ADR-096. The `??` is for a socket with no remote
    // address, which is a test harness, not a caller worth throttling apart.
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const decision = limiter.decide(tierFor(req.method, req.path), ip);

    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(decision.resetAtMs / 1000)));

    if (decision.allowed) { next(); return; }

    res.setHeader('Retry-After', String(decision.retryAfterSec));
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message:
          `Rate limit reached for ${decision.tier} requests `
          + `(${decision.limit} per ${Math.round(RATE_LIMIT_TIERS[decision.tier].windowMs / 1000)}s`
          + `${decision.scope === 'global' ? ', across all clients' : ''}). `
          + `Retry in ${decision.retryAfterSec}s.`,
        details: {
          tier: decision.tier,
          limit: decision.limit,
          windowSeconds: Math.round(RATE_LIMIT_TIERS[decision.tier].windowMs / 1000),
          scope: decision.scope,
        },
      },
    });
  };
}
