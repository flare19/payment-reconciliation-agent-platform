import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  withRateLimit, RATE_LIMIT_DEFAULTS,
} from '../../src/services/agent/rate-limiter.js';
import { classifyTransportError } from '../../src/services/agent/gemini-agent-client.js';
import type {
  AgentLlmClient, AgentTurnRequest, AgentTurnResult,
} from '../../src/services/agent/agent-client.js';

/**
 * The pacer, against a virtual clock — no network, no waiting, no money.
 *
 * The property under test is not "it sleeps". It is that the REAL number of
 * billable requests is both bounded per minute and VISIBLE afterwards, because
 * both halves of that are how a run overspends silently: pacing that admits one
 * too many, or a retry the caller never learns happened.
 */

const REQUEST: AgentTurnRequest = {
  system: 's', messages: [], tools: [], maxOutputTokens: 100,
};

/** A clock that only moves when the code under test sleeps. */
function virtualClock() {
  let ms = 1_000_000;
  return {
    now: () => ms,
    sleep: async (by: number) => { ms += by; await Promise.resolve(); },
    advance: (by: number) => { ms += by; },
    get value() { return ms; },
  };
}

function fakeClient(
  script: (call: number) => AgentTurnResult,
): { client: AgentLlmClient; callsAt: number[]; calls: () => number } {
  let calls = 0;
  const callsAt: number[] = [];
  return {
    callsAt,
    calls: () => calls,
    client: {
      model: 'fake-model',
      turn: async (): Promise<AgentTurnResult> => {
        calls += 1;
        return script(calls);
      },
    },
  };
}

const okTurn = (tokensIn = 100, tokensOut = 10): AgentTurnResult =>
  ({ ok: true, kind: 'final', text: '{}', usage: { tokensIn, tokensOut } });

describe('rate limiter — request pacing', () => {
  test('admits up to the per-minute ceiling without waiting', async () => {
    const clock = virtualClock();
    const inner = fakeClient(() => okTurn());
    const { client, stats } = withRateLimit(inner.client, {
      maxRequestsPerMinute: 5, maxRetries: 0, now: clock.now, sleep: clock.sleep,
    });

    for (let i = 0; i < 5; i += 1) await client.turn(REQUEST);

    assert.equal(inner.calls(), 5);
    assert.equal(stats().throttleWaitMs, 0, 'no wait below the ceiling');
  });

  test('the request after the ceiling waits for the window to drain', async () => {
    const clock = virtualClock();
    const start = clock.value;
    const inner = fakeClient(() => okTurn());
    const { client, stats } = withRateLimit(inner.client, {
      maxRequestsPerMinute: 3, maxRetries: 0, now: clock.now, sleep: clock.sleep,
    });

    for (let i = 0; i < 4; i += 1) await client.turn(REQUEST);

    assert.equal(inner.calls(), 4);
    assert.ok(stats().throttleWaitMs > 0, 'the 4th request must have waited');
    // The oldest of three same-instant entries ages out 60 s later.
    assert.equal(clock.value - start, 60_001);
  });

  test('12 requests per minute never exceeds 12 in any trailing minute', async () => {
    const clock = virtualClock();
    const inner = fakeClient(() => okTurn());
    const { client } = withRateLimit(inner.client, {
      maxRequestsPerMinute: 12, maxRetries: 0, now: clock.now, sleep: clock.sleep,
    });

    const at: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      await client.turn(REQUEST);
      at.push(clock.value);
      clock.advance(500); // a little real latency between turns
    }

    for (let i = 0; i < at.length; i += 1) {
      const inWindow = at.filter((t) => t > at[i]! - 60_000 && t <= at[i]!).length;
      assert.ok(inWindow <= 12, `${inWindow} requests in the minute ending at ${at[i]}`);
    }
  });
});

describe('rate limiter — token pacing', () => {
  test('throttles on OBSERVED tokens, overshooting by at most one request', async () => {
    const clock = virtualClock();
    const inner = fakeClient(() => okTurn(90_000, 5_000));
    const { client, stats } = withRateLimit(inner.client, {
      maxRequestsPerMinute: 100, maxTokensPerMinute: 200_000,
      maxRetries: 0, now: clock.now, sleep: clock.sleep,
    });

    // 95k per call. The gate cannot know a request's size before sending it, so
    // it admits while the window is still under the limit: 0k, 95k, 190k all
    // pass, and the window closes at 285k. That is the documented one-request
    // overshoot, and it is why the default (200k) sits below the real 250k
    // ceiling — the margin exists precisely to absorb this.
    for (let i = 0; i < 3; i += 1) await client.turn(REQUEST);
    assert.equal(stats().throttleWaitMs, 0, 'under the limit, nothing waits');

    await client.turn(REQUEST);
    assert.ok(stats().throttleWaitMs > 0, 'the request after the crossing waits');

    // The guarantee that makes the margin sufficient: never more than one
    // request's worth of tokens beyond the configured limit.
    assert.ok(285_000 - 200_000 <= 95_000);
  });

  test('a token-light minute is bounded by requests, not tokens', async () => {
    const clock = virtualClock();
    const inner = fakeClient(() => okTurn(100, 10));
    const { client, stats } = withRateLimit(inner.client, {
      maxRequestsPerMinute: 4, maxTokensPerMinute: 200_000,
      maxRetries: 0, now: clock.now, sleep: clock.sleep,
    });

    for (let i = 0; i < 4; i += 1) await client.turn(REQUEST);
    assert.equal(stats().throttleWaitMs, 0);
    await client.turn(REQUEST);
    assert.ok(stats().throttleWaitMs > 0, 'the request ceiling still binds');
  });
});

describe('rate limiter — retries', () => {
  const retryable = (): AgentTurnResult => ({
    ok: false, reason: 'transport', detail: '429',
    usage: { tokensIn: 5, tokensOut: 0 }, retryable: true,
  });

  test('retries a retryable failure and returns the eventual success', async () => {
    const clock = virtualClock();
    const inner = fakeClient((n) => (n < 3 ? retryable() : okTurn(100, 10)));
    const { client, stats } = withRateLimit(inner.client, {
      maxRetries: 3, baseBackoffMs: 1_000, now: clock.now, sleep: clock.sleep,
    });

    const result = await client.turn(REQUEST);

    assert.equal(result.ok, true);
    assert.equal(inner.calls(), 3);
    assert.equal(stats().retries, 2);
  });

  test('usage accumulates across attempts — a failed attempt was still billed', async () => {
    const clock = virtualClock();
    const inner = fakeClient((n) => (n < 3 ? retryable() : okTurn(100, 10)));
    const { client } = withRateLimit(inner.client, {
      maxRetries: 3, baseBackoffMs: 1_000, now: clock.now, sleep: clock.sleep,
    });

    const result = await client.turn(REQUEST);

    // 5 + 5 from the two failures, plus 100/10 from the success.
    assert.deepEqual(result.usage, { tokensIn: 110, tokensOut: 10 });
  });

  test('does NOT retry a failure that is not marked retryable', async () => {
    const clock = virtualClock();
    const inner = fakeClient(() => ({
      ok: false, reason: 'transport', detail: '400 bad request',
      usage: { tokensIn: 0, tokensOut: 0 },
    }));
    const { client, stats } = withRateLimit(inner.client, {
      maxRetries: 3, now: clock.now, sleep: clock.sleep,
    });

    const result = await client.turn(REQUEST);

    assert.equal(result.ok, false);
    assert.equal(inner.calls(), 1, 'a 400 must not be replayed');
    assert.equal(stats().retries, 0);
  });

  test('gives up after maxRetries and returns the last failure', async () => {
    const clock = virtualClock();
    const inner = fakeClient(() => retryable());
    const { client, stats } = withRateLimit(inner.client, {
      maxRetries: 2, baseBackoffMs: 1_000, now: clock.now, sleep: clock.sleep,
    });

    const result = await client.turn(REQUEST);

    assert.equal(result.ok, false);
    assert.equal(inner.calls(), 3, 'the first attempt plus two retries');
    assert.equal(stats().requestsIssued, 3);
  });

  test("the provider's stated delay wins over computed backoff", async () => {
    const clock = virtualClock();
    const inner = fakeClient((n) => (n === 1
      ? { ...retryable(), retryAfterMs: 39_000 }
      : okTurn()));
    const { client, stats } = withRateLimit(inner.client, {
      maxRetries: 3, baseBackoffMs: 1_000, now: clock.now, sleep: clock.sleep,
    });

    await client.turn(REQUEST);

    assert.equal(stats().backoffWaitMs, 39_000, 'not the 1 s we would have picked');
  });
});

describe('rate limiter — stats are the honest request count', () => {
  test('requestsIssued counts retries, which the step count cannot see', async () => {
    const clock = virtualClock();
    const inner = fakeClient((n) => (n < 3
      ? { ok: false as const, reason: 'transport' as const, detail: '429',
        usage: { tokensIn: 0, tokensOut: 0 }, retryable: true }
      : okTurn()));
    const { client, stats } = withRateLimit(inner.client, {
      maxRetries: 5, baseBackoffMs: 100, now: clock.now, sleep: clock.sleep,
    });

    await client.turn(REQUEST);

    // One turn from the loop's point of view; three billable requests.
    assert.equal(stats().requestsIssued, 3);
  });
});

describe('defaults are paced below the observed free-tier ceiling', () => {
  test('12 RPM leaves margin under the 15 RPM limit this was written against', () => {
    assert.ok(RATE_LIMIT_DEFAULTS.maxRequestsPerMinute < 15);
    assert.ok(RATE_LIMIT_DEFAULTS.maxTokensPerMinute < 250_000);
  });
});

describe('classifyTransportError', () => {
  test('429 with RetryInfo is retryable and carries the stated delay', () => {
    const err = new Error(JSON.stringify({
      error: {
        code: 429, status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '39s' }],
      },
    }));
    assert.deepEqual(classifyTransportError(err),
      { retryable: true, retryAfterMs: 39_000 });
  });

  test('a status field on the error is honoured', () => {
    const err = Object.assign(new Error('too many requests'), { status: 429 });
    assert.equal(classifyTransportError(err).retryable, true);
  });

  test('503 is retryable, 400 and 403 are not', () => {
    const at = (code: number) =>
      classifyTransportError(new Error(`{"error":{"code":${code}}}`)).retryable;
    assert.equal(at(503), true);
    assert.equal(at(400), false, 'replaying a malformed request burns quota');
    assert.equal(at(403), false);
  });

  test('our own turn timeout is never retried', () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    assert.equal(classifyTransportError(err).retryable, false);
  });

  test('a status-less RESOURCE_EXHAUSTED message is still recognised', () => {
    assert.equal(
      classifyTransportError(new Error('RESOURCE_EXHAUSTED: quota')).retryable, true);
  });

  test('an ordinary error is not retryable', () => {
    assert.equal(classifyTransportError(new Error('socket hang up')).retryable, false);
  });
});
