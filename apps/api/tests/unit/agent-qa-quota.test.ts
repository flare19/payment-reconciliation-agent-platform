import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkQaQuota, type QaQuotaInput } from '../../src/services/agent/qa-quota.js';
import { tierFor, RATE_LIMIT_TIERS } from '../../src/routes/rate-limit.js';
import type { CostModel } from '../../src/services/agent/agent-client.js';

/**
 * The Q&A quota (agent-design.md §9, U15 unit 2).
 *
 * This is the guard on the only free-text box in the product, on a public
 * unauthenticated demo. The tests that matter are the ones that watch each
 * bound REFUSE — a quota nobody has seen say no is indistinguishable from a
 * quota that cannot.
 */

const COST: CostModel = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };

function input(over: Partial<QaQuotaInput> = {}): QaQuotaInput {
  return {
    enabled: true,
    questionsThisRun: 0,
    questionsThisHour: 0,
    spentThisHourUsd: 0,
    limits: { maxQuestionsPerRun: 50, maxQuestionsPerHour: 100, maxCostUsdPerHour: 2 },
    cost: COST,
    ...over,
  };
}

describe('every bound refuses, and says which one it was', () => {
  test('a fresh request is allowed', () => {
    const d = checkQaQuota(input());
    assert.equal(d.allowed, true);
  });

  test('the kill switch refuses with 503, not 429', () => {
    // 503 because the feature is OFF, not rate-limited. Telling a caller to
    // retry later would be a lie.
    const d = checkQaQuota(input({ enabled: false }));
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.status, 503);
    assert.equal(d.allowed === false && d.code, 'AGENT_DISABLED');
  });

  test('the per-run count refuses at its ceiling', () => {
    const d = checkQaQuota(input({ questionsThisRun: 50 }));
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.status, 429);
    assert.match(d.allowed === false ? d.reason : '', /this run/i);
    assert.match(d.allowed === false ? d.reason : '', /50/);
  });

  test('the per-hour count refuses at its ceiling', () => {
    const d = checkQaQuota(input({ questionsThisHour: 100 }));
    assert.equal(d.allowed, false);
    assert.match(d.allowed === false ? d.reason : '', /last hour/i);
  });

  test('THE DOLLAR CEILING REFUSES EVEN WHEN BOTH COUNTS ARE FINE', () => {
    // The whole reason counts are not enough. Two expensive questions can cost
    // more than fifty cheap ones, and only this check can see that.
    const d = checkQaQuota(input({
      questionsThisRun: 2, questionsThisHour: 2, spentThisHourUsd: 2.4,
    }));
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.code, 'AGENT_QUOTA_EXCEEDED');
    assert.match(d.allowed === false ? d.reason : '', /\$2\.40/);
  });

  test('spend exactly AT the ceiling refuses — the boundary is closed', () => {
    assert.equal(checkQaQuota(input({ spentThisHourUsd: 2 })).allowed, false);
  });
});

describe('a key that bills nothing still bounds volume', () => {
  test('with no cost model the dollar check is skipped', () => {
    // A free tier has no bill to bound. It still has a demo one visitor can
    // monopolise, so the counts must keep applying.
    assert.equal(checkQaQuota(input({ cost: null, spentThisHourUsd: 999 })).allowed, true);
  });

  test('but the counts still refuse on a free tier', () => {
    assert.equal(
      checkQaQuota(input({ cost: null, questionsThisRun: 50 })).allowed, false);
  });
});

describe('the first bound that binds is the one reported', () => {
  test('the kill switch outranks every quota', () => {
    // A refusal naming the wrong bound sends someone to fix the wrong thing.
    const d = checkQaQuota(input({
      enabled: false, questionsThisRun: 99, questionsThisHour: 999, spentThisHourUsd: 99,
    }));
    assert.equal(d.allowed === false && d.code, 'AGENT_DISABLED');
  });

  test('a per-run breach is reported before a spend breach', () => {
    const d = checkQaQuota(input({ questionsThisRun: 50, spentThisHourUsd: 99 }));
    assert.match(d.allowed === false ? d.reason : '', /this run/i);
  });
});

describe('the transport tier is its own, and below the wallet', () => {
  test('POST /api/runs/:id/ask classifies as `qa`, not `write`', () => {
    // Without its own arm it falls to `write` at 60/hour — six times the
    // ceiling a model-calling endpoint should carry.
    assert.equal(tierFor('POST', '/api/runs/8f3e-abc/ask'), 'qa');
    assert.equal(tierFor('POST', '/api/runs/8f3e-abc/ask/'), 'qa');
  });

  test('it does not swallow the neighbouring run routes', () => {
    assert.equal(tierFor('POST', '/api/runs'), 'run');
    assert.equal(tierFor('POST', '/api/runs/8f3e-abc/score-report'), 'write');
    assert.equal(tierFor('GET', '/api/runs/8f3e-abc/ask'), 'read');
  });

  test('the qa tier sits below the deployment dollar ceiling, like investigate', () => {
    // 15 questions/hour/IP, each bounded at 6 steps and 1024 output tokens —
    // deliberately not enough for one IP to exhaust the wallet alone, or the
    // dollar ceiling stops being a wallet protection and becomes a race.
    assert.equal(RATE_LIMIT_TIERS.qa.perIp, 15);
    assert.equal(RATE_LIMIT_TIERS.qa.windowMs, 3_600_000);
  });
});
