import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matchSummary } from '../../src/routes/serialize.js';
import type { Match } from '../../src/repositories/matches.js';
import type { NormalizedTransaction } from '../../src/types/engine.js';

/**
 * THE DEFECT THIS PINS, and it is the second instance of one shape in one day.
 *
 * `matches` stores `reviewed_by`, `reviewed_at` and `review_note`. Endpoints 10
 * and 11 write all three. The repository loads all three. `matchSummary`
 * DROPPED all three — so approving or rejecting a proposal removed it from
 * `/review` and it then existed nowhere but the audit chain (ADR-124).
 * `exceptionDetail` had exactly the same hole for closures (ADR-122).
 *
 * A serializer that omits a field is invisible to `tsc`, because the return
 * type is `Record<string, unknown>`. Only an assertion about the WIRE SHAPE
 * can see it.
 */

const NO_TXNS = new Map<string, NormalizedTransaction>();

function match(over: Partial<Match> = {}): Match {
  return {
    id: 'm1', runId: 'r1', tier: 'fuzzy', status: 'pending_review',
    confidence: 0.7, ruleId: 'R', ruleVersion: '1.0.0', cardinality: 'one_to_one',
    amountDeltaPaise: 0, dateDeltaDays: 0, aliasIds: [], scoreBreakdown: null,
    matchedAt: new Date('2026-08-31T00:00:00Z'),
    reviewedBy: null, reviewedAt: null, reviewNote: null,
    members: [{ transactionId: 't1', role: 'gateway', isAnchor: true }],
    ...over,
  } as Match;
}

const ser = (m: Match) => matchSummary(m, NO_TXNS)['review'];

describe('matchSummary serves the review decision (ADR-124)', () => {
  test('a REJECTION carries who, when and the reason endpoint 11 required', () => {
    assert.deepEqual(ser(match({
      status: 'human_rejected',
      reviewedBy: 'Tejas Lokhande',
      reviewedAt: new Date('2026-09-02T06:01:28.023Z'),
      reviewNote: 'Not same payment',
    })), {
      decision: 'human_rejected',
      reviewedBy: 'Tejas Lokhande',
      reviewedAt: '2026-09-02T06:01:28.023Z',
      note: 'Not same payment',
    });
  });

  test('AN APPROVAL WITH NO NOTE IS VALID, and keeps note null rather than inventing one', () => {
    // Endpoint 10 takes an OPTIONAL note; 22 of the 22 approvals recorded so
    // far have none. Substituting a word here would manufacture a
    // justification nobody gave.
    const out = ser(match({
      status: 'human_confirmed',
      reviewedBy: 'unattributed reviewer',
      reviewedAt: new Date('2026-09-01T17:47:52.318Z'),
      reviewNote: null,
    })) as { decision: string; note: string | null };
    assert.equal(out.decision, 'human_confirmed');
    assert.equal(out.note, null);
  });

  test('an undecided proposal has no review — null, not a half-filled object', () => {
    assert.equal(ser(match({ status: 'pending_review' })), null);
    assert.equal(ser(match({ status: 'auto_confirmed' })), null);
  });

  test('the key is always PRESENT, so absent and undecided stay distinguishable', () => {
    assert.ok('review' in matchSummary(match(), NO_TXNS));
  });

  test('a reviewed status with unpaired columns yields null, not a partial object', () => {
    // `match_review_fields_paired` forbids this. If it ever arrives anyway,
    // half a decision on the wire is worse than none.
    assert.equal(ser(match({ status: 'human_confirmed', reviewedBy: 'x' })), null);
  });

  test('an auto_confirmed match never reports a decision even if columns are set', () => {
    // The engine confirmed it; nobody decided anything.
    assert.equal(ser(match({
      status: 'auto_confirmed', reviewedBy: 'x', reviewedAt: new Date(0), reviewNote: 'n',
    })), null);
  });
});
