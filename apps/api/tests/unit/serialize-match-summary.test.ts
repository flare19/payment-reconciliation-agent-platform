import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matchSummary } from '../../src/routes/serialize.js';
import { matchedRecordIds } from '../../src/services/metrics/run-metrics.js';
import type { Match } from '../../src/repositories/matches.js';
import type { NormalizedTransaction, ProposedMatch } from '../../src/types/engine.js';

/**
 * #43 / ADR-088: `countsTowardEngineMatchRate` (the wire field a browse list
 * sums) and `matchedRecordIds` (what S14's headline `matchRatePct` is built
 * from, ADR-040) must never disagree about which records the ENGINE matched.
 * No database is available in this environment (CLAUDE.md constraint 3), so
 * this asserts the two independently-implemented pure functions against one
 * shared fixture rather than against a persisted run's `GET /matches` and
 * `listMatchedTransactionIds` — that end-to-end comparison remains UNVERIFIED
 * here and needs a local run against a real database.
 */

const EMPTY_TXNS = new Map<string, NormalizedTransaction>();

let seq = 0;
function match(tier: Match['tier'], status: Match['status'], ids: string[]): Match {
  seq += 1;
  return {
    id: `m${seq}`,
    runId: 'r1',
    tier,
    status,
    confidence: 1,
    ruleId: 'R',
    ruleVersion: '1.0.0',
    cardinality: 'one_to_one',
    amountDeltaPaise: 0,
    dateDeltaDays: 0,
    aliasIds: [],
    scoreBreakdown: null,
    matchedAt: new Date('2026-08-31T00:00:00Z'),
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    members: ids.map((id, i) => ({ transactionId: id, role: 'gateway' as const, isAnchor: i === 0 })),
  };
}

// The same shape as a `ProposedMatch`, read off the `Match` fixture, so
// `matchedRecordIds` sees exactly the group the wire field was computed from.
function asProposedMatch(m: Match): ProposedMatch {
  return {
    tier: m.tier, status: m.status, confidence: m.confidence, ruleId: m.ruleId,
    cardinality: m.cardinality, members: m.members, amountDeltaPaise: m.amountDeltaPaise,
    dateDeltaDays: m.dateDeltaDays, aliasIds: m.aliasIds, scoreBreakdown: m.scoreBreakdown,
  };
}

describe('countsTowardEngineMatchRate agrees with matchedRecordIds (ADR-040, ADR-088)', () => {
  test('auto_confirmed and human_confirmed (non-manual) both count', () => {
    const m1 = match('exact', 'auto_confirmed', ['a', 'b']);
    const m2 = match('fuzzy', 'human_confirmed', ['c', 'd']);
    assert.equal(matchSummary(m1, EMPTY_TXNS)['countsTowardEngineMatchRate'], true);
    assert.equal(matchSummary(m2, EMPTY_TXNS)['countsTowardEngineMatchRate'], true);
  });

  test('pending_review does NOT count — the discriminating case #43 was filed for', () => {
    const m = match('fuzzy', 'pending_review', ['a', 'b']);
    assert.equal(matchSummary(m, EMPTY_TXNS)['countsTowardEngineMatchRate'], false);
  });

  test('human_rejected does not count', () => {
    const m = match('fuzzy', 'human_rejected', ['a', 'b']);
    assert.equal(matchSummary(m, EMPTY_TXNS)['countsTowardEngineMatchRate'], false);
  });

  test('a manual match never counts, however confirmed (ADR-043)', () => {
    const m = match('manual', 'human_confirmed', ['a', 'b']);
    assert.equal(matchSummary(m, EMPTY_TXNS)['countsTowardEngineMatchRate'], false);
  });

  test('summing the wire field over every match reproduces matchedRecordIds exactly', () => {
    // At least one pending_review match and one manual match, per #43's
    // acceptance criteria — both are the cases the old predicate got wrong.
    const matches = [
      match('exact', 'auto_confirmed', ['g1', 'g2']),
      match('fuzzy', 'pending_review', ['p1', 'p2']),
      match('fuzzy', 'human_rejected', ['r1']),
      match('manual', 'human_confirmed', ['h1', 'h2']),
      match('alias', 'human_confirmed', ['c1', 'c2']),
    ];

    const fromWireField = new Set<string>();
    for (const m of matches) {
      const dto = matchSummary(m, EMPTY_TXNS);
      if (dto['countsTowardEngineMatchRate'] === true) {
        for (const mem of m.members) fromWireField.add(mem.transactionId);
      }
    }

    const fromMetrics = matchedRecordIds(matches.map(asProposedMatch));

    assert.deepEqual([...fromWireField].sort(), [...fromMetrics].sort());
    assert.deepEqual([...fromWireField].sort(), ['c1', 'c2', 'g1', 'g2']);
  });
});
