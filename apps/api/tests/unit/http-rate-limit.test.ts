/**
 * ADR-096 — the HTTP rate limiter.
 *
 * ── EVERY ASSERTION HERE IS THAT THE GUARD REFUSES ──
 * This repo has shipped, five times, a test whose name claimed more than its
 * assertion, and Day 13's rule is that a guard nobody has watched FAIL is
 * indistinguishable from one that cannot. So the tests below check the refusal
 * itself: the exact request that must be rejected, the tier it was filed under,
 * and the boundary it was rejected at. A test that only asserted "the first
 * request is allowed" would pass against a middleware that does nothing at all.
 *
 * The clock is injected, so a one-hour window is exercised in microseconds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRateLimiter, tierFor, RATE_LIMIT_TIERS,
  type RateLimitTier,
} from '../../src/routes/rate-limit.js';

/** A clock the test moves by hand. Nothing here reads `Date.now()`. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('tierFor files each endpoint under the tier that matches its real cost', () => {
  // The classification is the whole guard: a limiter that silently files
  // `POST /api/runs` under `read` passes every bucket test and protects nothing.
  assert.equal(tierFor('GET', '/api/runs'), 'read');
  assert.equal(tierFor('GET', '/api/runs/abc/exceptions'), 'read');
  assert.equal(tierFor('POST', '/api/runs'), 'run');
  assert.equal(tierFor('POST', '/api/runs/'), 'run');
  assert.equal(tierFor('POST', '/api/exceptions/abc-123/investigate'), 'investigate');

  // NOT the `run` tier: these are ordinary writes that happen to sit under
  // /api/runs. A `startsWith` implementation would file them at 10/hour and
  // break manual matching mid-demo.
  assert.equal(tierFor('POST', '/api/runs/abc/matches'), 'write');
  assert.equal(tierFor('POST', '/api/runs/abc/score-report'), 'write');
  assert.equal(tierFor('POST', '/api/runs/abc/ask'), 'write');
  assert.equal(tierFor('POST', '/api/matches/abc/approve'), 'write');
  assert.equal(tierFor('PATCH', '/api/aliases/abc'), 'write');
});

test('each tier REFUSES at exactly its documented per-IP limit', () => {
  for (const tier of Object.keys(RATE_LIMIT_TIERS) as RateLimitTier[]) {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    const rule = RATE_LIMIT_TIERS[tier];

    for (let i = 0; i < rule.perIp; i += 1) {
      const d = limiter.decide(tier, '203.0.113.9');
      assert.equal(d.allowed, true, `${tier} refused early at request ${i + 1}`);
    }
    // The (limit + 1)th is the one that must be refused.
    const refused = limiter.decide(tier, '203.0.113.9');
    assert.equal(refused.allowed, false, `${tier} admitted request ${rule.perIp + 1}`);
    assert.equal(refused.scope, 'ip');
    assert.equal(refused.limit, rule.perIp);
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterSec >= 1, 'Retry-After must never be 0');
  }
});

test('the window is trailing: the bucket reopens as the oldest hit ages out', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });
  const rule = RATE_LIMIT_TIERS['run'];

  for (let i = 0; i < rule.perIp; i += 1) {
    assert.equal(limiter.decide('run', '198.51.100.4').allowed, true);
  }
  assert.equal(limiter.decide('run', '198.51.100.4').allowed, false);

  // One millisecond short of the window: still refused. This is the assertion
  // that would catch an off-by-one that quietly halves the window.
  clock.advance(rule.windowMs - 1);
  assert.equal(limiter.decide('run', '198.51.100.4').allowed, false,
    'the window expired early');

  clock.advance(2);
  assert.equal(limiter.decide('run', '198.51.100.4').allowed, true,
    'the window never reopened');
});

test('one IP exhausting its budget does not refuse a different IP', () => {
  // The demo requirement: a script must not be able to lock judges out. If this
  // fails, the limiter has become the denial-of-service it was added to prevent.
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });

  for (let i = 0; i < RATE_LIMIT_TIERS['read'].perIp; i += 1) {
    limiter.decide('read', '203.0.113.1');
  }
  assert.equal(limiter.decide('read', '203.0.113.1').allowed, false);
  assert.equal(limiter.decide('read', '203.0.113.2').allowed, true,
    'a second visitor was refused because of the first');
});

test('the global cap on `run` refuses IPs that are individually under budget', () => {
  // Storage is cumulative and rotating IPs is cheap, so `run` is the one tier
  // with a cap behind the per-IP one. Each IP here stays well under 10/hour.
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });
  const globalCap = RATE_LIMIT_TIERS['run'].global!;

  let admitted = 0;
  for (let i = 0; i < globalCap + 10; i += 1) {
    const d = limiter.decide('run', `10.0.0.${i}`); // a fresh IP every time
    if (d.allowed) admitted += 1;
    else {
      assert.equal(d.scope, 'global',
        'refused by the per-IP bucket, but every IP here is unique');
      assert.equal(d.limit, globalCap);
    }
  }
  assert.equal(admitted, globalCap,
    `global cap admitted ${admitted}, expected exactly ${globalCap}`);
});

test('`investigate` per-IP budget stays BELOW ADR-095 hourly spend ceiling', () => {
  // The sizing argument, asserted rather than left in prose: at the measured
  // $0.10-0.12 per investigation, one IP must not be able to drain the $2.00
  // wallet ceiling alone -- or ADR-095's refusal stops protecting the wallet
  // and becomes a race between visitors.
  const COST_PER_INVESTIGATION_USD = 0.12; // the measured upper bound (ADR-093)
  const HOURLY_CEILING_USD = 2.0;          // AGENT_MAX_COST_USD_PER_HOUR default
  const worstCase = RATE_LIMIT_TIERS['investigate'].perIp * COST_PER_INVESTIGATION_USD;
  assert.ok(worstCase < HOURLY_CEILING_USD,
    `one IP can spend $${worstCase.toFixed(2)} of a $${HOURLY_CEILING_USD} hourly ceiling`);
});

test('refusals are not counted, so a client ignoring its 429s cannot self-extend', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });
  const rule = RATE_LIMIT_TIERS['run'];

  // All `perIp` admissions land at t0, so the window is due to reopen at
  // exactly t0 + windowMs and nowhere else.
  for (let i = 0; i < rule.perIp; i += 1) limiter.decide('run', '192.0.2.7');

  const HAMMER_MS = 50_000;
  for (let i = 0; i < 50; i += 1) {
    clock.advance(HAMMER_MS / 50);
    assert.equal(limiter.decide('run', '192.0.2.7').allowed, false);
  }

  // ── THE ARITHMETIC IS THE TEST, AND IT IS EASY TO GET WRONG ──
  // Advance to just past t0 + windowMs -- measured from the ADMISSIONS, not
  // from the last refusal. Advancing a whole window from the last refusal
  // instead would age out the refusals too, and the assertion would pass
  // against a limiter that records them. (It did, on the first draft of this
  // test; the mutation run is what caught it.)
  clock.advance(rule.windowMs - HAMMER_MS + 1);
  assert.equal(limiter.decide('run', '192.0.2.7').allowed, true,
    'refused requests extended the window');
});

test('the key table stays bounded under IP rotation', () => {
  // Without eviction, rotating the source IP turns the limiter itself into a
  // memory-exhaustion attack.
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now, maxTrackedKeys: 100 });
  for (let i = 0; i < 5_000; i += 1) limiter.decide('read', `10.1.${i >> 8}.${i & 255}`);
  assert.ok(limiter.stats().trackedKeys <= 101,
    `tracked ${limiter.stats().trackedKeys} keys against a cap of 100`);
});
