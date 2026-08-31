/**
 * Provider-neutral request pacing for `AgentLlmClient`.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS FILE DELIBERATELY DOES NOT LIVE IN THE PROVIDER CLIENT.
 *
 * Rate limits are not a Gemini property. Every provider publishes requests- and
 * tokens-per-minute ceilings, so a limiter written inside
 * `gemini-agent-client.ts` would be thrown away and rewritten during the swap
 * ADR-080 already anticipates. It is a decorator over the interface instead, for
 * the same reason the interface exists at all.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── IT PACES AHEAD OF THE LIMIT, IT DOES NOT WAIT TO BE REFUSED ──
 * Reactive 429 handling alone is not good enough on a metered free tier: a
 * refused request still counts against the daily quota on most providers, so
 * "send until rejected, then back off" spends the budget on rejections. The
 * window below is checked BEFORE each call and the caller waits. The retry path
 * further down is a safety net for the limit we mispredicted, not the mechanism.
 *
 * ── THE TOKEN GATE IS ONE REQUEST LATE, ON PURPOSE ──
 * A request's token count is not knowable before it is sent — the history grows
 * every step and only the provider counts it authoritatively. So the gate admits
 * on OBSERVED tokens in the trailing window rather than a prediction. That can
 * overshoot by at most one request, which is why `maxTokensPerMinute` is meant
 * to be set below the provider's real ceiling: the margin absorbs the overshoot.
 * Inventing an estimate to close a one-request gap would put a made-up number
 * into the mechanism that guards real money, which is the trade this repo keeps
 * refusing to make.
 *
 * ── RETRIES ARE COUNTED AND VISIBLE ──
 * A retry is a second billable request that the investigation loop's step
 * counter cannot see, because the loop counts STEPS and this counts REQUESTS.
 * Left unreported that is the same defect shape as an uncounted failed
 * investigation: real spend that the budget believes did not happen. `stats()`
 * exposes the true request count so the caller can reconcile the two.
 *
 * ── NO WALL CLOCK IN A DECISION ──
 * `now` and `sleep` are injected. Tests run the whole window instantly and
 * deterministically, and nothing here reads `Date.now()` on its own (rule 8 —
 * this is timing, not a decision, but the injection is what makes it testable
 * without a 60-second test).
 */

import type {
  AgentLlmClient, AgentTurnRequest, AgentTurnResult, AgentUsage,
} from './agent-client.js';

const WINDOW_MS = 60_000;

export interface RateLimitOptions {
  /** Requests admitted per trailing 60 s. Set BELOW the provider's ceiling. */
  maxRequestsPerMinute: number;
  /** Observed tokens admitted per trailing 60 s. See the one-request note. */
  maxTokensPerMinute: number;
  /** Retries after a retryable failure. 0 disables the safety net. */
  maxRetries: number;
  /** First backoff step; doubles per attempt unless the provider states a delay. */
  baseBackoffMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const RATE_LIMIT_DEFAULTS: Omit<RateLimitOptions, 'now' | 'sleep'> = {
  // Shaped for the Gemini free tier this was written against (15 RPM / 250K TPM
  // observed on Flash Lite), with margin. Both are env-configurable because the
  // right values are a property of the key, not of the code — and the numbers a
  // provider publishes are exactly the kind of bound ADR-086 says to measure
  // rather than adopt.
  maxRequestsPerMinute: 12,
  maxTokensPerMinute: 200_000,
  maxRetries: 3,
  baseBackoffMs: 2_000,
};

export interface RateLimitStats {
  /** Every request actually issued, retries included. The billable count. */
  requestsIssued: number;
  /** How many of those were retries of a failed attempt. */
  retries: number;
  /** Total time spent waiting for the window, in ms. */
  throttleWaitMs: number;
  /** Total time spent in backoff after a retryable failure, in ms. */
  backoffWaitMs: number;
}

interface WindowEntry { at: number; tokens: number }

/**
 * Wrap a client so its calls are paced and transient failures retried.
 *
 * Returns the wrapped client alongside a `stats` reader rather than widening
 * `AgentLlmClient`: the loop must not grow a notion of retries, or the bound it
 * enforces stops being the one §8 describes.
 */
export function withRateLimit(
  inner: AgentLlmClient,
  options: Partial<RateLimitOptions> = {},
): { client: AgentLlmClient; stats: () => RateLimitStats } {
  const opts: RateLimitOptions = {
    ...RATE_LIMIT_DEFAULTS,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    ...options,
  };

  const window: WindowEntry[] = [];
  const stats: RateLimitStats = {
    requestsIssued: 0, retries: 0, throttleWaitMs: 0, backoffWaitMs: 0,
  };

  function prune(at: number): void {
    while (window.length > 0 && window[0]!.at <= at - WINDOW_MS) window.shift();
  }

  function tokensInWindow(): number {
    return window.reduce((sum, e) => sum + e.tokens, 0);
  }

  /** Block until both the request and token windows have room. */
  async function acquire(): Promise<void> {
    for (;;) {
      const at = opts.now();
      prune(at);
      const full = window.length >= opts.maxRequestsPerMinute
        || tokensInWindow() >= opts.maxTokensPerMinute;
      if (!full) return;
      // The window can only drain by the oldest entry ageing out; +1 ms so the
      // next prune strictly passes the `<=` boundary rather than spinning on it.
      const waitMs = Math.max(1, window[0]!.at + WINDOW_MS - at + 1);
      stats.throttleWaitMs += waitMs;
      await opts.sleep(waitMs);
    }
  }

  function record(usage: AgentUsage): void {
    window.push({ at: opts.now(), tokens: usage.tokensIn + usage.tokensOut });
    stats.requestsIssued += 1;
  }

  return {
    stats: () => ({ ...stats }),
    client: {
      model: inner.model,

      async turn(request: AgentTurnRequest): Promise<AgentTurnResult> {
        // Usage accumulates ACROSS attempts. A retried request that reached the
        // model was billed, and `agent-client.ts` requires usage on every arm
        // including failures — reporting only the last attempt's would
        // understate a run's real cost, and an understating guard is worse than
        // no guard because it reads as protection.
        const total: AgentUsage = { tokensIn: 0, tokensOut: 0 };

        for (let attempt = 0; ; attempt += 1) {
          await acquire();
          const result = await inner.turn(request);
          record(result.usage);
          total.tokensIn += result.usage.tokensIn;
          total.tokensOut += result.usage.tokensOut;

          const retryable = !result.ok
            && result.retryable === true
            && attempt < opts.maxRetries;
          if (!retryable) return { ...result, usage: { ...total } };

          stats.retries += 1;
          // The provider's own stated delay wins: it knows when the quota
          // refills and a guessed backoff that is too short spends another
          // request to be told the same thing again.
          const backoffMs = (!result.ok && result.retryAfterMs !== undefined)
            ? result.retryAfterMs
            : opts.baseBackoffMs * 2 ** attempt;
          stats.backoffWaitMs += backoffMs;
          await opts.sleep(backoffMs);
        }
      },
    },
  };
}
