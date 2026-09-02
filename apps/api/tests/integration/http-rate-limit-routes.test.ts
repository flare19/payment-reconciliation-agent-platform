/**
 * ADR-096 end to end, over real HTTP.
 *
 * ── THIS SUITE NEEDS NO DATABASE, AND THAT IS THE POINT ──
 * A refused request is refused BEFORE any router runs, so nothing here touches
 * Postgres. That makes it the one integration test that always runs, and it
 * pins the property that matters most: an attacker's flood is rejected without
 * reaching a handler, a query, or the model. If this ever starts needing a
 * database, the middleware has moved behind the routers and the guard is gone.
 *
 * `routes.test.ts` runs with `rateLimitEnabled: false` because it asserts
 * contract behaviour from a single IP. This file is where the limiter is
 * actually exercised through Express -- including the parts a unit test cannot
 * see: middleware ORDER, the `X-RateLimit-*` headers, `Retry-After`, and the
 * error envelope `app.ts` promises.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import type { RunSources } from '../../src/services/run/orchestrator.js';

const env = {
  databaseUrl: '', corsOrigins: ['https://recon-demo.vercel.app'],
  geminiApiKey: null, anthropicApiKey: null, llmProvider: 'anthropic',
  llmExplainEnabled: false, agentEnabled: false, agentQaEnabled: false,
  rateLimitEnabled: true, trustProxyHops: 1,
} as unknown as Env;

const noSources = (): RunSources => ({ gateway: '', bank: '', ledger: '' });

describe('rate limiting (over HTTP)', () => {
  let server: Server;
  let base: string;

  // Requests that PASS the meter reach a handler and fail for want of a
  // database -- that is the design, not a fault, but `app.ts` logs each one and
  // the noise buries the actual results. Silenced for this suite only.
  const realError = console.error;

  before(async () => {
    console.error = () => {};
    server = createApp(env, noSources).listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  after(async () => {
    console.error = realError;
    await new Promise<void>((r) => { server.close(() => { r(); }); });
  });

  /** Distinct forged client IPs, so each test gets its own buckets. */
  let seq = 0;
  const asClient = () => { seq += 1; return `198.51.100.${seq}`; };

  const get = (path: string, ip: string) =>
    fetch(`${base}${path}`, { headers: { 'X-Forwarded-For': ip } });

  test('every response advertises the budget, so a client can pace itself', async () => {
    const res = await get('/api/nope', asClient());
    assert.equal(res.headers.get('X-RateLimit-Limit'), '240');
    assert.ok(Number(res.headers.get('X-RateLimit-Remaining')) >= 0);
    assert.ok(res.headers.get('X-RateLimit-Reset') !== null);
  });

  test('`POST /api/runs` is REFUSED past 10/hour, with the contract envelope', async () => {
    // The endpoint this whole ADR exists for: no LLM money, ~1,700 rows and
    // 2.4 s of engine per call, from an unauthenticated URL.
    const ip = asClient();
    const post = () => fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ useSeedDataset: true }),
    });

    // The first 10 pass the METER. They then fail in the handler for want of a
    // database, which is fine and is exactly the distinction being drawn: the
    // limiter is upstream of everything, so "not 429" is the assertion.
    for (let i = 0; i < 10; i += 1) {
      assert.notEqual((await post()).status, 429, `refused early at request ${i + 1}`);
    }

    const refused = await post();
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('Retry-After')) >= 1);
    const body = await refused.json() as { error: { code: string; details: Record<string, unknown> } };
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(body.error.details['tier'], 'run');
    assert.equal(body.error.details['limit'], 10);
    assert.equal(body.error.details['scope'], 'ip');
  });

  test('X-Forwarded-For is honoured, so visitors do not share one bucket', async () => {
    // Without `trust proxy`, every request behind Railway's edge shares a single
    // key and the first judge to browse locks out the rest. If this fails, the
    // rate limiter has become the outage.
    const victim = asClient();
    const attacker = asClient();
    for (let i = 0; i < 12; i += 1) {
      await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': attacker },
        body: '{}',
      });
    }
    const attackerRes = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': attacker },
      body: '{}',
    });
    assert.equal(attackerRes.status, 429, 'the attacker was never limited');

    const victimRes = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': victim },
      body: '{}',
    });
    assert.notEqual(victimRes.status, 429,
      'a second visitor was locked out by the first — buckets are being shared');
  });

  test('a browser can READ the 429: CORS headers survive the refusal', async () => {
    // A 429 the frontend cannot read surfaces as an opaque network error, and
    // the demo shows "something went wrong" instead of "slow down". This is why
    // the limiter is mounted AFTER the CORS middleware.
    const ip = asClient();
    for (let i = 0; i < 11; i += 1) {
      await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip,
          Origin: 'https://recon-demo.vercel.app' },
        body: '{}',
      });
    }
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip,
        Origin: 'https://recon-demo.vercel.app' },
      body: '{}',
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'),
      'https://recon-demo.vercel.app');
  });

  test('reads are NOT metered at the write tier — judges browse freely', async () => {
    // The demo requirement, asserted: 30 GETs in a row is an ordinary session,
    // and must not consume a 10/hour or 60/hour budget.
    const ip = asClient();
    for (let i = 0; i < 30; i += 1) {
      assert.notEqual((await get(`/api/runs?page=${i}`, ip)).status, 429,
        `a read was refused after ${i} requests`);
    }
  });
});
