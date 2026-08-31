import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildInvestigationPrompt } from '../../src/services/agent/investigation-prompt.js';
import type { ExceptionRecord } from '../../src/repositories/exceptions.js';
import type { ExceptionEvidence, NormalizedTransaction } from '../../src/types/engine.js';
import type { ExceptionCategory } from '../../src/types/domain.js';
import { AGENT_DEFAULTS } from '../../src/config/defaults.js';
import { systemPrompt } from '../../src/services/agent/investigation-loop.js';
import {
  ACTION_REQUIRED_FIELDS, ACTION_TYPES, ALIAS_TYPES, validateVerdict,
} from '../../src/services/agent/grounding-gate.js';
import type { ToolCallRecord } from '../../src/types/agent.js';

function evidence(o: Partial<ExceptionEvidence> = {}): ExceptionEvidence {
  return {
    candidatesConsidered: 0, candidates: [], anchorStrength: 'none', aliasesAttempted: [],
    windowUsed: { amountBandPaise: 10000, dateWindow: [-1, 3] }, candidateCapHit: false,
    severityBasis: { base: 'high', amountAtRiskPaise: null, escalated: false }, ...o,
  };
}

function exception(o: Partial<ExceptionRecord> = {}): ExceptionRecord {
  return {
    id: 'exc-1', runId: 'run-1', transactionId: 'txn-1', relatedTransactionIds: [],
    category: 'MISSING_IN_BANK', secondaryFlags: [], severity: 'high',
    bestCandidateScore: null, amountAtRiskPaise: 500_000, requiresHumanConfirmation: false,
    evidence: evidence(), detectedByRule: 'R_V1', ruleVersion: '1.0.0',
    explanationText: null, explanationSource: null, signatureHash: null,
    suggestedAction: null, status: 'explained', resolvedBy: null, resolvedAt: null,
    resolutionNote: null, createdAt: new Date(), ...o,
  };
}

const subject = {
  id: 'txn-1', sourceSystem: 'gateway', sourceRowNumber: 42, amountPaise: 500_000,
  direction: 'credit', txnDate: '2026-08-14', counterpartyNorm: 'ACME',
  referenceIds: { payment_id: 'pay_X' }, anchorStrength: 'strong',
} as unknown as NormalizedTransaction;

describe('the prompt carries THE ENGINE\'S OWN REASONING', () => {
  test('rejected candidates appear with the engine\'s verbatim reason', () => {
    // The mechanism that stops the Analyst spending three steps rediscovering
    // what `rejectedBecause` already says.
    const p = buildInvestigationPrompt({
      exception: exception({
        evidence: evidence({
          candidatesConsidered: 3,
          candidates: [{
            transactionId: 'bank-9', sourceSystem: 'bank', score: 0.61,
            rejectedBecause: 'amount delta exceeds band',
          }],
        }),
      }),
      subject, engineTrail: [],
    });
    assert.match(p, /candidates considered: 3/);
    assert.match(p, /bank-9/);
    assert.match(p, /amount delta exceeds band/);
  });

  test('the two batch claims are stated DIFFERENTLY, never conflated', () => {
    // searchExhausted is a proof about the data; searchBoundExceeded is an
    // admission about the engine's own room (ADR-038). The agent's whole
    // self-correction story depends on telling them apart.
    const exhausted = buildInvestigationPrompt({
      exception: exception({ category: 'UNSPLITTABLE_BATCH',
        evidence: evidence({ searchExhausted: true }) }),
      subject, engineTrail: [],
    });
    assert.match(exhausted, /EXHAUSTIVE/);
    assert.doesNotMatch(exhausted, /ran out of room/);

    const bounded = buildInvestigationPrompt({
      exception: exception({ category: 'UNSPLITTABLE_BATCH',
        evidence: evidence({ searchBoundExceeded: { bound: 'pool', value: 24 } }) }),
      subject, engineTrail: [],
    });
    assert.match(bounded, /pool bound at 24/);
    assert.match(bounded, /NOT a proof/);
    assert.match(bounded, /rerun_subset_search/);
  });

  test('the engine\'s audit trail is quoted', () => {
    const p = buildInvestigationPrompt({
      exception: exception(), subject,
      engineTrail: [{ eventType: 'EXCEPTION_RAISED', reason: 'MISSING_IN_BANK raised at high' }],
    });
    assert.match(p, /EXCEPTION_RAISED/);
    assert.match(p, /raised at high/);
  });

  test('a group-level exception with no record says so instead of omitting it', () => {
    const p = buildInvestigationPrompt({
      exception: exception({ transactionId: null }), subject: null, engineTrail: [],
    });
    assert.match(p, /GROUP-LEVEL EXCEPTION with no single record/);
  });
});

describe('every eligible category gets its OWN question', () => {
  test('each of the six asks something different and specific', () => {
    const asks = new Set<string>();
    for (const category of AGENT_DEFAULTS.eligibleCategories) {
      const p = buildInvestigationPrompt({
        exception: exception({ category: category as ExceptionCategory }),
        subject, engineTrail: [],
      });
      const ask = p.slice(p.indexOf('YOUR JOB:'));
      assert.ok(ask.length > 80, `${category} has no substantive ask`);
      asks.add(ask);
    }
    assert.equal(asks.size, AGENT_DEFAULTS.eligibleCategories.length,
      'a single generic "investigate this" gets a single generic investigation');
  });

  test('the two must-ship categories name their specific tool (§11)', () => {
    const batch = buildInvestigationPrompt({
      exception: exception({ category: 'UNSPLITTABLE_BATCH' }), subject, engineTrail: [] });
    assert.match(batch, /rerun_subset_search/);

    const ambiguous = buildInvestigationPrompt({
      exception: exception({ category: 'AMBIGUOUS_MATCH' }), subject, engineTrail: [] });
    assert.match(ambiguous, /evidence the SCORER DOES NOT USE/);
  });

  test('an ineligible category still gets a usable default rather than nothing', () => {
    const p = buildInvestigationPrompt({
      exception: exception({ category: 'DUPLICATE_RECORD' }), subject, engineTrail: [] });
    assert.match(p, /YOUR JOB:/);
  });
});

describe('the citation rule is stated in the prompt itself', () => {
  test('it tells the agent that context ids are not evidence', () => {
    // A3 rejects a citation that came only from the prompt. Saying so up front
    // turns a grounding failure into a retrieval the agent chooses to make.
    const p = buildInvestigationPrompt({ exception: exception(), subject, engineTrail: [] });
    assert.match(p, /context, not evidence/);
    assert.match(p, /THIS investigation/);
  });

  test('agreeing with the engine is offered as a real answer', () => {
    // Without this an agent asked 20 times to investigate will start finding
    // things — the same reason NO_NEW_EVIDENCE and NEEDS_EXTERNAL_DATA exist.
    const p = buildInvestigationPrompt({
      exception: exception({ category: 'DUPLICATE_RECORD' }), subject, engineTrail: [] });
    assert.match(p, /Agreeing with the engine/);
  });

  test('money is formatted, never handed over as bare paise', () => {
    const p = buildInvestigationPrompt({ exception: exception(), subject, engineTrail: [] });
    assert.doesNotMatch(p, /amount at risk: 500000/);
    assert.match(p, /amount at risk: /);
  });
});

/**
 * ── THE PROMPT/GATE CONTRACT (issue #53) ──
 *
 * A3 validates four `proposedAction` variants meticulously. Until AUDIT-3 the
 * system prompt named none of them and showed the model exactly one example of
 * the field: `"proposedAction":null`. So `RESOLUTION_PROPOSED` — the verdict
 * agent-design.md §7 calls the agent's entire reason to exist, and the sole
 * input to false-despair-recovered, proposal precision and ADR-053's
 * hallucinated-resolutions build blocker — was unreachable. Twenty live
 * investigations produced zero proposals; the one attempt was rejected with
 * `schema: proposedAction must be an object`.
 *
 * The defect lived in the CONJUNCTION of two correct files, which is the shape
 * #40 had: `grounding-gate.ts` implemented §3's schema correctly,
 * `investigation-loop.ts` implemented §3's honesty rules correctly, and no file
 * owned the fact that the schema has to reach the model.
 *
 * These tests iterate the gate's own exported vocabulary, so a fifth action
 * type or a renamed field fails HERE rather than silently becoming unreachable.
 */
describe('the prompt tells the model what the GATE will accept (#53)', () => {
  test('every action type A3 validates is named in the prompt', () => {
    const p = systemPrompt();
    for (const type of ACTION_TYPES) {
      assert.ok(p.includes(type),
        `SYSTEM_PROMPT never names ${type}, so the model cannot produce one and the gate `
        + 'will reject every attempt. Add it to the prompt, not to the gate.');
    }
  });

  test('every field A3 REQUIRES is named in the prompt', () => {
    const p = systemPrompt();
    for (const [type, fields] of Object.entries(ACTION_REQUIRED_FIELDS)) {
      for (const field of fields) {
        assert.ok(p.includes(field),
          `${type} requires "${field}" and the prompt never mentions it`);
      }
    }
    // Required on every variant, so it is not in the per-variant lists.
    assert.ok(p.includes('rationale'));
  });

  test('every alias type the gate accepts is offered to the model', () => {
    const p = systemPrompt();
    for (const t of ALIAS_TYPES) assert.ok(p.includes(t), `aliasType ${t} is not in the prompt`);
  });

  test('the bounds ceilings in the prompt are the ones the gate enforces', () => {
    // Interpolated, not retyped. A prompt that quotes a stale ceiling teaches the
    // model to propose something the gate refuses — which reads to a human as
    // the model being wrong, when the instruction was.
    const p = systemPrompt();
    for (const v of Object.values(AGENT_DEFAULTS.rerunSubsetCeilings)) {
      assert.ok(p.includes(String(v)), `ceiling ${v} is not stated in the prompt`);
    }
  });

  test('the prompt says a proposal is the ONLY verdict carrying an action', () => {
    // The gate rejects `${verdict} must not carry a proposedAction` for the other
    // three, so the model has to be told which one it belongs to.
    const p = systemPrompt();
    assert.match(p, /RESOLUTION_PROPOSED is the ONLY verdict that carries/);
    assert.match(p, /must set it to null/);
  });

  test('a proposal built to the prompt PASSES the real gate', () => {
    // The end-to-end property the four checks above only approximate: an action
    // shaped the way the prompt describes must survive A3. Without this, the
    // prompt could name every field and still describe an unusable shape.
    const txn = '9f1c4d7e-0000-4000-8000-00000000000a';
    const other = '9f1c4d7e-0000-4000-8000-00000000000b';
    const call: ToolCallRecord = {
      investigationId: 'inv-1', step: 1, tool: 'search_transactions', arguments: {},
      returnedIds: [txn, other], resultDigest: 'search_transactions: {"returned":2}',
      durationMs: 1,
    };
    const result = validateVerdict({
      verdict: 'RESOLUTION_PROPOSED', confidence: 'high',
      summary: 'the gateway payment and the bank credit are the same event',
      citations: [txn, other],
      reasoning: [{
        step: 1, tool: 'search_transactions',
        resultDigest: 'search_transactions: {"returned":2}',
        inference: 'both legs are unmatched and share the settlement reference',
      }],
      proposedAction: {
        type: 'MANUAL_MATCH',
        rationale: 'shared settlement_id, same direction, neither already matched',
        members: [
          { transactionId: txn, role: 'gateway' },
          { transactionId: other, role: 'bank' },
        ],
      },
    }, {
      investigationId: 'inv-1',
      toolCalls: [call],
      runId: 'run-1',
      records: new Map([
        [txn, { runId: 'run-1', sourceSystem: 'gateway', direction: 'credit', alreadyMatched: false }],
        [other, { runId: 'run-1', sourceSystem: 'bank', direction: 'credit', alreadyMatched: false }],
      ]),
      activeAliases: new Map(),
    });

    assert.equal(result.rejection, null,
      `a proposal built to the prompt's own spec was rejected: ${result.verdict.groundingFailure}`);
    assert.equal(result.verdict.verdict, 'RESOLUTION_PROPOSED');
    assert.equal(result.verdict.groundingPassed, true);
  });
});
