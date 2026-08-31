import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { ExceptionCategory, SourceSystem } from '../../src/types/domain.js';
import type { ClassifiedException, ExceptionEvidence } from '../../src/types/engine.js';
import {
  amountDeltaBucket, candidateCountBucket, dateDeltaBucket,
  computeSignature, computeSignatureComponents, hashComponents,
  type TxForSignature,
} from '../../src/services/explain/signature.js';
import {
  templateFor, EXPLANATION_FALLBACK_TEMPLATE, PROMPT_VERSION, SYSTEM_PROMPT,
} from '../../src/services/explain/templates.js';
import { EXCEPTION_PRECEDENCE } from '../../src/types/domain.js';

const OPTS = { promptVersion: 'v1', model: 'gemini-3.5-flash' };

function tx(id: string, source: SourceSystem, amountPaise: number, txnDate: string): TxForSignature {
  return { sourceSystem: source, amountPaise, txnDate };
}

function evidence(o: Partial<ExceptionEvidence> = {}): ExceptionEvidence {
  return {
    candidatesConsidered: 0, candidates: [], anchorStrength: 'none', aliasesAttempted: [],
    windowUsed: { amountBandPaise: 0, dateWindow: [-1, 3] }, candidateCapHit: false,
    severityBasis: { base: 'medium', amountAtRiskPaise: null, escalated: false }, ...o,
  };
}

function exc(o: Partial<ClassifiedException> = {}): ClassifiedException {
  return {
    transactionId: 'self', relatedTransactionIds: [], category: 'MISSING_IN_BANK',
    secondaryFlags: [], severity: 'high', amountAtRiskPaise: null,
    requiresHumanConfirmation: false, bestCandidateScore: null,
    evidence: evidence(), detectedByRule: 'R', ruleVersion: '1.0.0', ...o,
  };
}

describe('bucket helpers', () => {
  test('candidate count bands', () => {
    assert.equal(candidateCountBucket(0), '0');
    assert.equal(candidateCountBucket(1), '1');
    assert.equal(candidateCountBucket(2), '2_3');
    assert.equal(candidateCountBucket(3), '2_3');
    assert.equal(candidateCountBucket(4), 'gt_3');
    assert.equal(candidateCountBucket(99), 'gt_3');
  });

  test('amount delta is proportional, not absolute', () => {
    assert.equal(amountDeltaBucket(100_000, 100_000), 'none');
    assert.equal(amountDeltaBucket(100_000, 100_500), 'lt_1pct');
    assert.equal(amountDeltaBucket(100_000, 102_000), '1_to_3pct');
    assert.equal(amountDeltaBucket(100_000, 105_000), '3_to_10pct');
    assert.equal(amountDeltaBucket(100_000, 200_000), 'gt_10pct');
    // A ₹5 delta is large on a ₹10 payment and negligible on a ₹5,00,000 one.
    assert.equal(amountDeltaBucket(1_000, 1_500), 'gt_10pct');
    assert.equal(amountDeltaBucket(50_000_000, 50_000_500), 'lt_1pct');
  });

  test('date delta bands, signed', () => {
    assert.equal(dateDeltaBucket(-1), 'negative');
    assert.equal(dateDeltaBucket(0), 'same_day');
    assert.equal(dateDeltaBucket(2), 'plus_1_3d');
    assert.equal(dateDeltaBucket(3), 'plus_1_3d');
    assert.equal(dateDeltaBucket(4), 'plus_4_7d');
    assert.equal(dateDeltaBucket(7), 'plus_4_7d');
    assert.equal(dateDeltaBucket(8), 'gt_7d');
  });
});

describe('computeSignature', () => {
  test('strips every specific — same shape, different amounts and ids, one hash', () => {
    const mkPair = (selfId: string, otherId: string, selfAmt: number, otherAmt: number) => {
      const map = new Map<string, TxForSignature>([
        [selfId, tx(selfId, 'gateway', selfAmt, '2026-08-10')],
        [otherId, tx(otherId, 'bank', otherAmt, '2026-08-12')],
      ]);
      const e = exc({
        transactionId: selfId, relatedTransactionIds: [otherId],
        category: 'AMOUNT_MISMATCH',
        evidence: evidence({ anchorStrength: 'strong', candidatesConsidered: 1 }),
      });
      return computeSignature(e, map, OPTS);
    };
    // Both are a ~5% gateway↔bank amount mismatch, strong anchor, 1 candidate,
    // counterpart +2d. Different rupee figures, different ids.
    const a = mkPair('g1', 'b1', 100_000, 105_000);
    const b = mkPair('g2', 'b2', 4_000_000, 4_180_000);
    assert.equal(a.hash, b.hash);
    assert.equal(a.components.amountDeltaBucket, '3_to_10pct');
    assert.equal(a.components.sourcesPresent, 'gateway+bank');
    assert.equal(a.components.dateDeltaBucket, 'plus_1_3d');
  });

  test('model and promptVersion are hashed in — a switch invalidates the cache (ADR-018)', () => {
    const map = new Map<string, TxForSignature>([['self', tx('self', 'bank', 5_000, '2026-08-10')]]);
    const e = exc({ transactionId: 'self', category: 'MISSING_IN_GATEWAY' });
    const base = computeSignature(e, map, OPTS);
    const otherModel = computeSignature(e, map, { ...OPTS, model: 'gemini-9.9-flash' });
    const otherPrompt = computeSignature(e, map, { ...OPTS, promptVersion: 'v2' });
    assert.notEqual(base.hash, otherModel.hash);
    assert.notEqual(base.hash, otherPrompt.hash);
  });

  test('presence exceptions have no counterpart, so no dated-value discrepancy is asserted', () => {
    const map = new Map<string, TxForSignature>([['self', tx('self', 'gateway', 250_000, '2026-08-01')]]);
    const c = computeSignatureComponents(
      exc({ transactionId: 'self', category: 'MISSING_IN_BANK' }), map, OPTS);
    assert.equal(c.amountDeltaBucket, 'none');
    assert.equal(c.dateDeltaBucket, 'within_window');
    assert.equal(c.sourcesPresent, 'gateway_only');
  });

  test('S8 recorded drift is preferred over re-deriving from dates', () => {
    const map = new Map<string, TxForSignature>([
      ['self', tx('self', 'gateway', 100_000, '2026-08-01')],
      ['other', tx('other', 'bank', 100_000, '2026-08-02')],
    ]);
    const c = computeSignatureComponents(exc({
      transactionId: 'self', relatedTransactionIds: ['other'], category: 'TIMING_DRIFT',
      evidence: evidence({ anchorStrength: 'strong', wouldMatchIfWindowWidened: { dateDeltaDays: 9 } }),
    }), map, OPTS);
    assert.equal(c.dateDeltaBucket, 'gt_7d', 'used the recorded +9d, not the +1d between the dates');
  });

  test('secondary flags enter the signature in a stable order', () => {
    const map = new Map<string, TxForSignature>([['self', tx('self', 'gateway', 100_000, '2026-08-01')]]);
    const forward = computeSignatureComponents(exc({
      category: 'AMOUNT_MISMATCH', secondaryFlags: ['TIMING_DRIFT', 'MISSING_IN_LEDGER'],
    }), map, OPTS);
    const reversed = computeSignatureComponents(exc({
      category: 'AMOUNT_MISMATCH', secondaryFlags: ['MISSING_IN_LEDGER', 'TIMING_DRIFT'],
    }), map, OPTS);
    assert.equal(forward.secondaryFlagsSorted, reversed.secondaryFlagsSorted);
    assert.equal(hashComponents(forward), hashComponents(reversed));
  });

  test('alias involvement flips the hash', () => {
    const map = new Map<string, TxForSignature>([['self', tx('self', 'bank', 5_000, '2026-08-10')]]);
    const without = computeSignature(exc({ category: 'MISSING_IN_GATEWAY' }), map, OPTS);
    const with_ = computeSignature(exc({
      category: 'MISSING_IN_GATEWAY',
      evidence: evidence({ aliasesAttempted: ['alias-uuid'] }),
    }), map, OPTS);
    assert.equal(without.components.aliasInvolved, 'no');
    assert.equal(with_.components.aliasInvolved, 'yes');
    assert.notEqual(without.hash, with_.hash);
  });
});

describe('templates — the floor', () => {
  test('every category has a hand-written template', () => {
    for (const category of EXCEPTION_PRECEDENCE as readonly ExceptionCategory[]) {
      const t = templateFor(category);
      assert.ok(t.explanationText.length > 40, category);
      assert.ok(t.suggestedAction.length > 20, category);
      assert.notEqual(t.explanationText, EXPLANATION_FALLBACK_TEMPLATE.explanationText,
        `${category} must not fall through to the generic floor`);
    }
  });

  test('templateFor is total — an unknown category yields the generic floor', () => {
    assert.equal(
      templateFor('NOT_A_CATEGORY' as ExceptionCategory).explanationText,
      EXPLANATION_FALLBACK_TEMPLATE.explanationText);
  });

  test('the system prompt states the hard boundary and carries every category', () => {
    assert.equal(PROMPT_VERSION, 'v1');
    assert.match(SYSTEM_PROMPT, /already final/);
    assert.match(SYSTEM_PROMPT, /Never invent amounts/);
    for (const category of EXCEPTION_PRECEDENCE as readonly ExceptionCategory[]) {
      assert.match(SYSTEM_PROMPT, new RegExp(category));
    }
  });
});
