import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { exceptionDetail } from '../../src/routes/serialize.js';
import type { ExceptionRecord } from '../../src/repositories/exceptions.js';
import type { ExceptionEvidence, NormalizedTransaction } from '../../src/types/engine.js';

/**
 * THE DEFECT THIS PINS. `resolved_by`, `resolved_at` and `resolution_note` were
 * loaded by the repository, required by endpoint 20, written verbatim to the
 * audit log — and DROPPED by the serializer. A closed exception could say only
 * that it was closed, on a product whose entire argument is that a decision
 * carries its reason (ADR-122).
 *
 * A serializer that silently omits a field is invisible to `tsc`, because the
 * return type is `Record<string, unknown>`. Only an assertion about the wire
 * shape can see it, which is why this file exists.
 */

const EMPTY_EVIDENCE = {
  candidates: [], windowUsed: null, severityBasis: null, anchorStrength: null,
  candidateCapHit: false, searchExhausted: null, searchBoundExceeded: null,
  candidateSubsets: null, aliasesAttempted: [], counterpartStatus: null,
} as unknown as ExceptionEvidence;

function exc(over: Partial<ExceptionRecord> = {}): ExceptionRecord {
  return {
    id: 'e1', runId: 'r1', transactionId: 't1', relatedTransactionIds: [],
    category: 'MISSING_IN_BANK', secondaryFlags: [], severity: 'high',
    bestCandidateScore: null, amountAtRiskPaise: null, requiresHumanConfirmation: false,
    evidence: EMPTY_EVIDENCE, detectedByRule: 'R', ruleVersion: '1.0.0',
    explanationText: null, explanationSource: null, signatureHash: null,
    suggestedAction: null, status: 'explained',
    resolvedBy: null, resolvedAt: null, resolutionNote: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

const NO_TXNS = new Map<string, NormalizedTransaction>();
const ser = (e: ExceptionRecord) => exceptionDetail(e, null, [], NO_TXNS, null, 0);

describe('exceptionDetail serves the closure (ADR-122)', () => {
  test('a closed exception carries WHO, WHEN and WHY — not merely that it is closed', () => {
    const out = ser(exc({
      status: 'human_resolved',
      resolvedBy: 'a.reviewer',
      resolvedAt: new Date('2026-09-02T02:10:56.000Z'),
      resolutionNote: 'Confirmed with the bank',
    }));
    assert.deepEqual(out['closure'], {
      resolution: 'human_resolved',
      resolvedBy: 'a.reviewer',
      resolvedAt: '2026-09-02T02:10:56.000Z',
      note: 'Confirmed with the bank',
    });
  });

  test("wont_fix is a closure too, and reports its own resolution", () => {
    const out = ser(exc({
      status: 'wont_fix', resolvedBy: 'x', resolvedAt: new Date(0), resolutionNote: 'immaterial',
    }));
    assert.equal((out['closure'] as { resolution: string }).resolution, 'wont_fix');
  });

  test('an OPEN exception has no closure — null, never a half-filled object', () => {
    assert.equal(ser(exc({ status: 'open' }))['closure'], null);
    assert.equal(ser(exc({ status: 'explained' }))['closure'], null);
  });

  test('the key is always PRESENT, so a consumer can distinguish absent from open', () => {
    // `closure === undefined` and `closure === null` mean different things to a
    // frontend, and only one of them is a state this API has.
    assert.ok('closure' in ser(exc({ status: 'open' })));
  });

  test('a status that is closed with missing columns yields null, not a partial object', () => {
    // `exc_resolution_complete` forbids this in the database. If it ever
    // arrives anyway, half a closure on the wire is worse than none.
    assert.equal(ser(exc({ status: 'human_resolved', resolvedBy: 'x' }))['closure'], null);
  });
});
