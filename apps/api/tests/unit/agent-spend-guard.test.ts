import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSpendGuard } from '../../src/services/agent/spend-guard.js';

const RATES = { inputUsdPerMillion: 2, outputUsdPerMillion: 10 };

/**
 * ADR-094 + #61. The cost cap was parsed in env.ts, listed in agent-design.md §8
 * and enforced NOWHERE; `LoopDeps.preflight` was documented as "the seam the
 * spend guard plugs into" and nothing had ever plugged in.
 */
describe('the spend guard refuses BEFORE the call (ADR-094)', () => {
  test('it prices the WORST case of the next turn, not the expected case', () => {
    // An expected-case guard that is wrong once has already spent the money.
    const g = createSpendGuard({ maxUsd: 0.05, cost: RATES, maxOutputTokensPerTurn: 4096 });
    // 4096 output at $10/M = $0.041. Add 1M input tokens of history and the
    // worst case alone blows the ceiling.
    assert.notEqual(g.preflight({ step: 2, usageSoFar: { tokensIn: 1_000_000, tokensOut: 0 } }), null);
  });

  test('a turn that comfortably fits is allowed', () => {
    const g = createSpendGuard({ maxUsd: 5, cost: RATES, maxOutputTokensPerTurn: 1024 });
    assert.equal(g.preflight({ step: 1, usageSoFar: { tokensIn: 1000, tokensOut: 0 } }), null);
  });

  test('no rates means no bill to cap, and the guard says so by allowing', () => {
    const g = createSpendGuard({ maxUsd: 0, cost: null, maxOutputTokensPerTurn: 4096 });
    assert.equal(g.preflight({ step: 1, usageSoFar: { tokensIn: 9_000_000, tokensOut: 0 } }), null);
  });

  test('#61: spend from BEFORE this guard existed still counts', () => {
    // The public endpoint's defect in one assertion. Each HTTP request builds a
    // fresh guard, so a guard that starts at zero enforces "per request" — a
    // ceiling the caller resets by calling again. Seeded from the persisted
    // ledger, it enforces the window instead.
    const fresh = createSpendGuard({ maxUsd: 1.0, cost: RATES, maxOutputTokensPerTurn: 1024 });
    assert.equal(fresh.preflight({ step: 1, usageSoFar: { tokensIn: 1000, tokensOut: 0 } }), null,
      'with nothing carried, this turn is affordable');

    const seeded = createSpendGuard({
      maxUsd: 1.0, cost: RATES, maxOutputTokensPerTurn: 1024, alreadySpentUsd: 0.995,
    });
    assert.notEqual(seeded.preflight({ step: 1, usageSoFar: { tokensIn: 1000, tokensOut: 0 } }), null,
      'the same turn must be refused once the window\'s spend is carried in');
    assert.ok(seeded.spentUsd() >= 0.995);
    assert.ok(seeded.remainingUsd() < 0.0051, `got ${seeded.remainingUsd()}`);
  });

  test('record() accumulates across investigations, not per investigation', () => {
    const g = createSpendGuard({ maxUsd: 1.0, cost: RATES, maxOutputTokensPerTurn: 1024 });
    for (let i = 0; i < 5; i += 1) g.record({ tokensIn: 50_000, tokensOut: 5_000 });
    // 5 x (50k in + 5k out) = $0.50 + $0.25
    assert.ok(Math.abs(g.spentUsd() - 0.75) < 1e-9, `got ${g.spentUsd()}`);
    assert.ok(Math.abs(g.remainingUsd() - 0.25) < 1e-9);
  });
});
