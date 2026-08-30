import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import type { NormalizedTransaction, RunConfig } from '../../src/types/engine.js';
import {
  amountToleranceBand, expectedNetBand, dateWindowFor, evaluateAmount, evaluateDate, pairKind,
} from '../../src/services/matching/tolerance.js';
import {
  scorePair, trigramSimilarity, damerauLevenshteinWithin, round4, maxScoreForAnchor,
  anchorAgreement,
} from '../../src/services/matching/scoring.js';

const config: RunConfig = {
  ...ENGINE_DEFAULTS,
  referenceDate: '2026-08-31',
  aliasCountAtStart: 0,
};

let seq = 0;
function txn(over: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  seq += 1;
  return {
    id: `t${seq}`, runId: 'r', sourceSystem: 'gateway', sourceFile: 'f.csv', sourceRowNumber: seq,
    externalId: `x${seq}`, referenceIds: {}, anchorStrength: 'none',
    amountPaise: 100_000, feePaise: null, taxPaise: null, netAmountPaise: null,
    currency: 'INR', direction: 'credit',
    txnDate: '2026-08-14', txnTimestamp: null, postingDate: null,
    counterpartyRaw: null, counterpartyNorm: null, counterpartyKey: null,
    method: 'card', statusRaw: 'captured', statusNorm: 'reconcilable', txnType: null,
    descriptionRaw: null, duplicateOfTransactionId: null, duplicateKind: null,
    ingestWarnings: [], rawPayload: {},
    ...over,
  };
}

describe('amount tolerance band (ADR-008)', () => {
  test('proportional in the middle, clamped at both ends', () => {
    assert.equal(amountToleranceBand(100_000, config), 500);      // ₹1,000 -> ₹5.00
    assert.equal(amountToleranceBand(1_000_000, config), 5_000);  // ₹10,000 -> ₹50.00
  });

  test('the exact amounts where each clamp engages', () => {
    // Floor binds below ₹200: 0.5% of ₹200 is exactly ₹1.00.
    assert.equal(amountToleranceBand(20_000, config), 100);   // ₹200 -> exactly the floor
    assert.equal(amountToleranceBand(19_900, config), 100);   // just below -> floor holds
    assert.equal(amountToleranceBand(20_100, config), 101);   // just above -> proportional
    // Cap binds above ₹20,000: 0.5% of ₹20,000 is exactly ₹100.00.
    assert.equal(amountToleranceBand(2_000_000, config), 10_000);
    assert.equal(amountToleranceBand(1_999_000, config), 9_995);
    assert.equal(amountToleranceBand(2_001_000, config), 10_000); // capped
  });

  test('never below the floor, never above the cap, for any amount', () => {
    for (const amount of [1, 50, 12_345, 999_999, 50_000_000, 10_000_000_000]) {
      const band = amountToleranceBand(amount, config);
      assert.ok(band >= config.amountToleranceFloorPaise, `floor violated at ${amount}`);
      assert.ok(band <= config.amountToleranceCapPaise, `cap violated at ${amount}`);
      assert.ok(Number.isSafeInteger(band), `band not an integer at ${amount}`);
    }
  });

  test('the tolerance sits BELOW the fee band, which is the whole point', () => {
    // If tolerance ever exceeded the fee band, a fee-bearing pair would match on
    // gross and AMOUNT_MISMATCH would stop firing on real discrepancies (ADR-008).
    const gross = 1_000_000;
    const feeAtMin = gross * config.feeBandMinPct;
    assert.ok(amountToleranceBand(gross, config) < feeAtMin,
      'tolerance must not be wide enough to swallow a gateway fee');
  });

  test('is symmetric across sign', () => {
    assert.equal(amountToleranceBand(-100_000, config), amountToleranceBand(100_000, config));
  });
});

describe('expected net band (fee inference)', () => {
  test('brackets the gross by the documented fee range', () => {
    const band = expectedNetBand(1_000_000, config);
    assert.equal(band.lowPaise, 970_500);   // gross x (1 - 0.0295)
    assert.equal(band.highPaise, 976_400);  // gross x (1 - 0.0236)
    assert.ok(band.lowPaise < band.highPaise);
  });
});

describe('date windows (ADR-009)', () => {
  test('are asymmetric and per-method', () => {
    assert.deepEqual(dateWindowFor('gateway_bank', 'card', config), [-1, 3]);
    assert.deepEqual(dateWindowFor('gateway_bank', 'netbanking', config), [-1, 3]);
    assert.deepEqual(dateWindowFor('gateway_bank', 'upi', config), [-1, 2]);
    assert.deepEqual(dateWindowFor('gateway_bank', 'wallet', config), [-1, 2]);
    assert.deepEqual(dateWindowFor('gateway_ledger', null, config), [-1, 1]);
    assert.deepEqual(dateWindowFor('bank_ledger', null, config), [-2, 4]);
  });

  test('every window allows -1, because midnight drift is real', () => {
    for (const kind of ['gateway_bank', 'gateway_ledger', 'bank_ledger'] as const) {
      assert.ok(dateWindowFor(kind, 'card', config)[0] <= -1,
        `${kind} must tolerate a one-day backward gap (ADR-009)`);
    }
  });

  test('orientation is relative to the gateway date regardless of argument order', () => {
    // Measuring backwards would turn a normal T+2 settlement into a -2 outlier.
    const g = txn({ sourceSystem: 'gateway', txnDate: '2026-08-14' });
    const b = txn({ sourceSystem: 'bank', txnDate: '2026-08-16' });
    assert.equal(evaluateDate(g, b, config)!.deltaDays, 2);
    assert.equal(evaluateDate(b, g, config)!.deltaDays, 2);
  });

  test('window membership is inclusive at both edges', () => {
    const g = txn({ sourceSystem: 'gateway', txnDate: '2026-08-14', method: 'card' });
    const at3 = txn({ sourceSystem: 'bank', txnDate: '2026-08-17' });
    const at4 = txn({ sourceSystem: 'bank', txnDate: '2026-08-18' });
    const atMinus1 = txn({ sourceSystem: 'bank', txnDate: '2026-08-13' });
    const atMinus2 = txn({ sourceSystem: 'bank', txnDate: '2026-08-12' });
    assert.equal(evaluateDate(g, at3, config)!.within, true);
    assert.equal(evaluateDate(g, at4, config)!.within, false);
    assert.equal(evaluateDate(g, atMinus1, config)!.within, true);
    assert.equal(evaluateDate(g, atMinus2, config)!.within, false);
  });
});

describe('comparison basis (ADR-037)', () => {
  test('gateway<->bank compares gateway NET to the bank credit', () => {
    const g = txn({ sourceSystem: 'gateway', amountPaise: 1_000_000, netAmountPaise: 970_000 });
    const b = txn({ sourceSystem: 'bank', amountPaise: 970_000 });
    const e = evaluateAmount(g, b, config)!;
    assert.equal(e.basis, 'gateway_net_vs_bank_credit');
    assert.equal(e.deltaPaise, 0);
    assert.equal(e.within, true);
  });

  test('gateway<->ledger compares gateway GROSS to ledger NET, not ledger gross', () => {
    // The correction that matters: comparing ledger gross would make every
    // discounted or taxed sale a false AMOUNT_MISMATCH.
    const g = txn({ sourceSystem: 'gateway', amountPaise: 1_000_000 });
    const l = txn({ sourceSystem: 'ledger', amountPaise: 1_200_000, netAmountPaise: 1_000_000 });
    const e = evaluateAmount(g, l, config)!;
    assert.equal(e.basis, 'gateway_gross_vs_ledger_net');
    assert.equal(e.deltaPaise, 0);
    assert.equal(e.within, true);
  });

  test('bank<->ledger amounts are UNAVAILABLE, not merely disagreeing', () => {
    const b = txn({ sourceSystem: 'bank', amountPaise: 970_000 });
    const l = txn({ sourceSystem: 'ledger', amountPaise: 1_000_000, netAmountPaise: 1_000_000 });
    const e = evaluateAmount(b, l, config)!;
    assert.equal(e.basis, 'anchor_only');
    assert.equal(e.unavailable, true);
  });

  test('a blank gateway fee falls back to the inferred band, and says so', () => {
    const g = txn({ sourceSystem: 'gateway', amountPaise: 1_000_000, netAmountPaise: null });
    const inside = txn({ sourceSystem: 'bank', amountPaise: 973_000 });
    const e = evaluateAmount(g, inside, config)!;
    assert.equal(e.basis, 'gateway_net_inferred_vs_bank_credit');
    assert.equal(e.inferred, true);
    assert.equal(e.deltaPaise, 0, 'inside the band is exactly as expected');
    assert.equal(e.within, true);

    const outside = txn({ sourceSystem: 'bank', amountPaise: 900_000 });
    const far = evaluateAmount(g, outside, config)!;
    assert.ok(far.deltaPaise < 0 && !far.within, 'outside the band is measured from the nearer edge');
  });

  test('same-source pairs are not comparable', () => {
    assert.equal(pairKind('gateway', 'gateway'), null);
    assert.equal(evaluateAmount(txn({ sourceSystem: 'bank' }), txn({ sourceSystem: 'bank' }), config), null);
  });
});

describe('similarity primitives', () => {
  test('trigram similarity is 1 for identical, 0 for disjoint, in between otherwise', () => {
    assert.equal(trigramSimilarity('AMAZON RETAIL', 'AMAZON RETAIL'), 1);
    assert.equal(trigramSimilarity('AMAZON', 'ZZZZZZ'), 0);
    const partial = trigramSimilarity('AMAZON RETAIL', 'AMAZON RETAIL INDIA');
    assert.ok(partial > 0 && partial < 1);
    assert.equal(trigramSimilarity(null, 'X'), 0);
    assert.equal(trigramSimilarity('AMZN', 'AMAZON RETAIL') < 0.5, true);
  });

  test('trigram similarity is symmetric and case-insensitive', () => {
    assert.equal(trigramSimilarity('Amazon', 'AMAZON'), 1);
    assert.equal(trigramSimilarity('foo bar', 'bar foo'), trigramSimilarity('bar foo', 'foo bar'));
  });

  test('bounded edit distance detects exactly the REF_TYPO shapes', () => {
    const id = 'pay_QK29fT10aXbZ81';
    assert.equal(damerauLevenshteinWithin(id, id, 1), 0);
    assert.equal(damerauLevenshteinWithin(id, 'pay_QK29fT10aXbZ18', 1), 1); // transposition
    assert.equal(damerauLevenshteinWithin(id, 'pay_QK29fT10aXbZ8', 1), 1);  // deletion
    assert.equal(damerauLevenshteinWithin(id, 'pay_QK29fT10aXbZ812', 1), 1); // insertion
    assert.equal(damerauLevenshteinWithin(id, 'pay_QK29fT10aXbZ82', 1), 1);  // substitution
    // Two edits must exceed the ceiling, not be reported as 2.
    assert.equal(damerauLevenshteinWithin(id, 'pay_QK29fT10aXbZ99', 1), 2);
    assert.equal(damerauLevenshteinWithin('abc', 'xyz', 1), 2);
  });
});

describe('scorePair — hard gates discard rather than score low', () => {
  const base = { referenceIds: { payment_id: 'pay_AAAAAAAAAAAA01' }, counterpartyNorm: 'ACME' };

  test('a credit never matches a debit (ADR-035)', () => {
    const g = txn({ ...base, sourceSystem: 'gateway', direction: 'credit', netAmountPaise: 100_000 });
    const b = txn({ ...base, sourceSystem: 'bank', direction: 'debit', amountPaise: 100_000 });
    const r = scorePair(g, b, config);
    assert.ok(r.discarded && /direction mismatch/.test(r.reason));
  });

  test('a contradicted anchor is disqualifying, not merely unhelpful (ADR-010)', () => {
    const g = txn({ sourceSystem: 'gateway', referenceIds: { payment_id: 'pay_AAAAAAAAAAAA01' }, netAmountPaise: 100_000 });
    const b = txn({ sourceSystem: 'bank', referenceIds: { payment_id: 'pay_ZZZZZZZZZZZZ99' }, amountPaise: 100_000 });
    const r = scorePair(g, b, config);
    assert.ok(r.discarded && /contradicts/.test(r.reason),
      'everything else agreeing must not outvote a contradicted reference');
  });

  test('same source and self-comparison are refused', () => {
    const a = txn({ sourceSystem: 'bank' });
    assert.ok(scorePair(a, a, config).discarded);
    assert.ok(scorePair(txn({ sourceSystem: 'bank' }), txn({ sourceSystem: 'bank' }), config).discarded);
  });
});

describe('scorePair — the ADR-030 ceiling guarantee', () => {
  test('a NO-ANCHOR pair can never auto-confirm, however perfect everything else is', () => {
    // The single most load-bearing property in the engine. It falls out of the
    // weights arithmetically rather than from a tunable threshold: amount + date
    // + counterparty = 0.70 < 0.85. Amount-and-date agreement is a coincidence
    // generator; a reference number is evidence.
    const g = txn({
      sourceSystem: 'gateway', amountPaise: 100_000, netAmountPaise: 100_000,
      txnDate: '2026-08-14', counterpartyNorm: 'ACME RETAIL', referenceIds: {},
    });
    const b = txn({
      sourceSystem: 'bank', amountPaise: 100_000,
      txnDate: '2026-08-14', counterpartyNorm: 'ACME RETAIL', referenceIds: {},
    });
    const r = scorePair(g, b, config);
    assert.ok(!r.discarded);
    assert.equal(r.breakdown.anchor, 0);
    assert.equal(r.score, 0.70, 'perfect on everything except a shared reference');
    assert.ok(r.score < config.fuzzyAutoConfirmThreshold);
    assert.ok(r.score >= config.fuzzyReviewThreshold, 'it may still ask a human, and that is all');
  });

  test('the ceiling is a property of the weights, not of this one example', () => {
    assert.equal(maxScoreForAnchor('none', config), 0.70);
    assert.ok(maxScoreForAnchor('none', config) < config.fuzzyAutoConfirmThreshold);
    // ...while anchored pairs CAN reach auto-confirm, which is the other half of
    // ADR-030: with the old 0.45/0.30/0.15/0.10 weights nothing at Tier 2 could.
    assert.equal(maxScoreForAnchor('weak_weak', config), 0.90);
    assert.equal(maxScoreForAnchor('strong_weak', config), 1.00);
    assert.ok(maxScoreForAnchor('weak_weak', config) >= config.fuzzyAutoConfirmThreshold);
    assert.equal(maxScoreForAnchor('near', config), 0.94);
  });

  test('the weights sum to exactly 1.00', () => {
    const w = config.scoreWeights;
    assert.equal(round4(w.anchor + w.amount + w.date + w.counterparty), 1);
    assert.equal(w.anchorStrongWeak, w.anchor, 'the strongest anchor earns the full weight');
    assert.ok(w.anchorNear < w.anchorStrongWeak && w.anchorNear > w.anchorWeakWeak);
  });
});

describe('scorePair — components and breakdown', () => {
  test('a strong<->weak anchored, exact, same-day pair scores at the ceiling', () => {
    const g = txn({
      sourceSystem: 'gateway', netAmountPaise: 100_000, txnDate: '2026-08-14',
      counterpartyNorm: 'ACME', referenceIds: { payment_id: 'pay_AAAAAAAAAAAA01' },
    });
    const b = txn({
      sourceSystem: 'bank', amountPaise: 100_000, txnDate: '2026-08-14',
      counterpartyNorm: 'ACME',
      referenceIds: { extracted_from_description: ['pay_AAAAAAAAAAAA01'] },
    });
    const r = scorePair(g, b, config);
    assert.ok(!r.discarded);
    assert.equal(r.breakdown.anchor, 0.30);
    assert.equal(r.breakdown.amount, 0.35);
    assert.equal(r.breakdown.date, 0.20);
    assert.equal(r.breakdown.counterparty, 0.15);
    assert.equal(r.score, 1.0);
  });

  test('the breakdown always sums to the total a reviewer sees', () => {
    // A score breakdown that does not reconcile looks broken, which is a poor
    // property for a reconciliation product's UI.
    const g = txn({
      sourceSystem: 'gateway', amountPaise: 123_457, netAmountPaise: 123_457,
      txnDate: '2026-08-14', counterpartyNorm: 'AMAZON RETAIL INDIA',
      referenceIds: { order_id: 'order_X1' },
    });
    const b = txn({
      sourceSystem: 'bank', amountPaise: 123_100, txnDate: '2026-08-16',
      counterpartyNorm: 'AMZN RETAIL', referenceIds: { order_id: 'order_X1' },
    });
    const r = scorePair(g, b, config);
    assert.ok(!r.discarded);
    const sum = round4(
      r.breakdown.anchor + r.breakdown.amount + r.breakdown.date + r.breakdown.counterparty);
    assert.equal(r.breakdown.total, sum);
    assert.equal(r.score, r.breakdown.total);
  });

  test('every score is rounded to 4dp, so thresholds do not hinge on float noise', () => {
    const g = txn({ sourceSystem: 'gateway', netAmountPaise: 99_997, txnDate: '2026-08-14',
      counterpartyNorm: 'ACME RETAIL LIMITED', referenceIds: { order_id: 'o1' } });
    const b = txn({ sourceSystem: 'bank', amountPaise: 100_000, txnDate: '2026-08-15',
      counterpartyNorm: 'ACME RETAILING', referenceIds: { order_id: 'o1' } });
    const r = scorePair(g, b, config);
    assert.ok(!r.discarded);
    for (const v of [r.score, r.breakdown.anchor, r.breakdown.amount,
                     r.breakdown.date, r.breakdown.counterparty]) {
      assert.equal(v, round4(v), 'every emitted number must already be 4dp');
    }
  });

  test('an inferred fee costs only the AMOUNT component, not the whole score', () => {
    // Docking the anchor or date for an amount-side inference would be incoherent.
    const shared = { txnDate: '2026-08-14', counterpartyNorm: 'ACME' };
    const stated = txn({ ...shared, sourceSystem: 'gateway', amountPaise: 1_000_000,
      netAmountPaise: 973_000, referenceIds: { payment_id: 'pay_AAAAAAAAAAAA01' } });
    const inferred = txn({ ...shared, sourceSystem: 'gateway', amountPaise: 1_000_000,
      netAmountPaise: null, referenceIds: { payment_id: 'pay_AAAAAAAAAAAA01' } });
    const bank = txn({ ...shared, sourceSystem: 'bank', amountPaise: 973_000,
      referenceIds: { extracted_from_description: ['pay_AAAAAAAAAAAA01'] } });

    const a = scorePair(stated, bank, config);
    const b = scorePair(inferred, bank, config);
    assert.ok(!a.discarded && !b.discarded);
    assert.equal(b.breakdown.amount, round4(a.breakdown.amount * 0.85));
    assert.equal(b.breakdown.anchor, a.breakdown.anchor);
    assert.equal(b.breakdown.date, a.breakdown.date);
    assert.equal(b.ruleId, 'FUZZY_FEE_INFERRED_V1');
  });

  test('bank<->ledger scores without an amount component and is flagged', () => {
    // A structured invoice_no equal on BOTH sides is a strong-strong shared
    // anchor (anchors.ts sharedStrongAnchor) — S8's identity-established
    // short-circuit would claim this pair before it ever reached Tier 2, so a
    // fixture shaped that way exercises a path the real pipeline never takes
    // (issue #6). A strong<->weak anchor — one side structured, the other only
    // via extracted_from_description — is the reachable case: it's the shape
    // anchorAgreement() actually returns strong_weak for.
    const b = txn({ sourceSystem: 'bank', amountPaise: 970_000, txnDate: '2026-08-14',
      counterpartyNorm: 'ACME', referenceIds: { extracted_from_description: ['INV/2026/00123'] } });
    const l = txn({ sourceSystem: 'ledger', amountPaise: 1_000_000, netAmountPaise: 1_000_000,
      txnDate: '2026-08-14', counterpartyNorm: 'ACME',
      referenceIds: { invoice_no: 'INV/2026/00123' } });
    const r = scorePair(b, l, config);
    assert.ok(!r.discarded);
    assert.equal(r.breakdown.amountUnavailable, true);
    assert.equal(r.breakdown.amount, 0);
    assert.ok(r.score < config.fuzzyAutoConfirmThreshold,
      'without a comparable amount, a bank<->ledger pair should not auto-confirm');
  });

  test('a bank<->ledger pair caps at anchor + date + counterparty, per schema.md §5.3.1/§5.4 (issue #6)', () => {
    // Perfect agreement on everything scoreable: strong<->weak anchor, same day,
    // identical counterparty. The amount component is scored 0 (not
    // renormalized), so this is the ceiling for a bank<->ledger pair — and it
    // lands EXACTLY on the review floor, not above it.
    const w = config.scoreWeights;
    const b = txn({ sourceSystem: 'bank', amountPaise: 970_000, txnDate: '2026-08-14',
      counterpartyNorm: 'ACME', referenceIds: { extracted_from_description: ['INV/2026/00123'] } });
    const l = txn({ sourceSystem: 'ledger', amountPaise: 1_000_000, netAmountPaise: 1_000_000,
      txnDate: '2026-08-14', counterpartyNorm: 'ACME',
      referenceIds: { invoice_no: 'INV/2026/00123' } });
    const r = scorePair(b, l, config);
    assert.ok(!r.discarded);
    assert.equal(r.score, round4(w.anchorStrongWeak + w.date + w.counterparty));
    assert.equal(r.score, config.fuzzyReviewThreshold, 'this is the review floor exactly, per schema.md §5.4');

    // weak<->weak never even reaches the review floor.
    const weakCeiling = round4(w.anchorWeakWeak + w.date + w.counterparty);
    assert.ok(weakCeiling < config.fuzzyReviewThreshold,
      'a weak<->weak bank<->ledger pair can never become a review candidate');
  });
});

describe('cross-key anchor agreement (#38)', () => {
  // A bank row states its reference in `bank_ref_no`; a gateway row states the
  // same 12 digits in `rrn`. No source but bank carries a `bank_ref_no`, so a
  // like-for-like weak-key comparison could never fire across sources and the
  // pair scored a literal zero anchor with a matching reference on both rows.
  const RRN = '587906399877';   // a real holdout value: bank#45 <-> gateway#268

  test('a gateway rrn equal to a bank bank_ref_no is strong_weak', () => {
    const r = anchorAgreement(
      txn({ sourceSystem: 'gateway', referenceIds: { rrn: RRN } }),
      txn({ sourceSystem: 'bank', referenceIds: { bank_ref_no: RRN } }),
      config, true);
    assert.equal(r.kind, 'exact');
    assert.equal(r.kind === 'exact' && r.strength, 'strong_weak');
    assert.equal(r.kind === 'exact' && r.key, 'rrn',
      'the STRONG key names the evidence, whichever side stated it');
  });

  test('it is symmetric: the bank row may be either argument', () => {
    const r = anchorAgreement(
      txn({ sourceSystem: 'bank', referenceIds: { bank_ref_no: RRN } }),
      txn({ sourceSystem: 'gateway', referenceIds: { rrn: RRN } }),
      config, true);
    assert.equal(r.kind === 'exact' && r.strength, 'strong_weak');
  });

  test('a DIFFERENT bank_ref_no is still no anchor at all', () => {
    // The half of the change that must not move. `bank_ref_no` is documented as
    // "sometimes equal to the RRN, sometimes not" (schema.md §2.2), so a
    // non-matching one carries no evidence in either direction.
    const r = anchorAgreement(
      txn({ sourceSystem: 'gateway', referenceIds: { rrn: RRN } }),
      txn({ sourceSystem: 'bank', referenceIds: { bank_ref_no: '999999999999' } }),
      config, false);
    assert.equal(r.kind, 'none');
  });

  test('a malformed rrn is not rescued by a weak key that copies it', () => {
    // `isWellFormedAnchor` still governs: the generator truncates ~10% of bank
    // descriptions mid-token, and a 7-digit fragment is not a reference.
    const r = anchorAgreement(
      txn({ sourceSystem: 'gateway', referenceIds: { rrn: '5879063' } }),
      txn({ sourceSystem: 'bank', referenceIds: { bank_ref_no: '5879063' } }),
      config, false);
    assert.equal(r.kind, 'none');
  });

  test('a contradicted strong anchor still discards, whatever bank_ref_no says', () => {
    // The guard rail on this change. A coincidental `bank_ref_no` agreement must
    // not outvote two `payment_id`s that positively disagree — otherwise the fix
    // would buy recall by disabling the engine's sharpest discard rule.
    const r = anchorAgreement(
      txn({ sourceSystem: 'gateway',
            referenceIds: { rrn: RRN, payment_id: 'pay_AAAAAAAAAAAA01' } }),
      txn({ sourceSystem: 'bank',
            referenceIds: { bank_ref_no: RRN, payment_id: 'pay_ZZZZZZZZZZZZ99' } }),
      config, false);
    assert.equal(r.kind, 'contradiction');
  });

  test('cross-key agreement outranks like-for-like weak agreement', () => {
    // Both fire; the cross-key block is checked first, so the pair is scored on
    // the stronger of the two pieces of evidence rather than on whichever loop
    // happens to come first in the file.
    const r = anchorAgreement(
      txn({ sourceSystem: 'gateway', referenceIds: { rrn: RRN, order_id: 'order_XYZ' } }),
      txn({ sourceSystem: 'bank', referenceIds: { bank_ref_no: RRN, order_id: 'order_XYZ' } }),
      config, false);
    assert.equal(r.kind === 'exact' && r.strength, 'strong_weak');
  });

  test('any strong-key disagreement suppresses the cross-key path, near-anchor included', () => {
    // A CONSEQUENCE of the contradiction guard, asserted rather than discovered
    // later: a near-anchor is by construction two values of the SAME strong key
    // that differ, which is also a contradiction candidate. So wherever a
    // near-anchor is available the cross-key block stands down and the pair is
    // scored `near` (0.24), not `strong_weak` (0.30).
    //
    // This costs nothing measurable — bank rows carry no structured strong anchor
    // (AUDIT-1), so a gateway<->bank pair has nothing to contradict with, and the
    // holdout has zero pairs where the two interact. It is the conservative
    // reading, and conservative is the right default for a new inference path.
    const r = anchorAgreement(
      txn({ sourceSystem: 'gateway',
            referenceIds: { rrn: RRN, settlement_id: 'setl_QK29fT10aXbZ81' } }),
      txn({ sourceSystem: 'bank',
            referenceIds: { bank_ref_no: RRN, settlement_id: 'setl_QK29fT10aXbZ18' } }),
      config, true);
    assert.equal(r.kind, 'near');

    // And without corroboration the same pair is discarded outright, which is the
    // property guard rail 2 of #38 asks for in as many words.
    const uncorroborated = anchorAgreement(
      txn({ sourceSystem: 'gateway',
            referenceIds: { rrn: RRN, settlement_id: 'setl_QK29fT10aXbZ81' } }),
      txn({ sourceSystem: 'bank',
            referenceIds: { bank_ref_no: RRN, settlement_id: 'setl_QK29fT10aXbZ18' } }),
      config, false);
    assert.equal(uncorroborated.kind, 'contradiction');
  });

  test('weak<->weak across DIFFERENT keys is deliberately NOT granted', () => {
    // Considered and declined on the evidence, not by symmetry: a gateway
    // `order_id` equal to a bank `bank_ref_no` occurs ZERO times among the
    // holdout's 26,908 candidate pairs, so granting it would add an inference
    // path nothing exercises. Like-for-like weak agreement is unaffected.
    const cross = anchorAgreement(
      txn({ sourceSystem: 'gateway', referenceIds: { order_id: 'order_XYZ123' } }),
      txn({ sourceSystem: 'bank', referenceIds: { bank_ref_no: 'order_XYZ123' } }),
      config, false);
    assert.equal(cross.kind, 'none');

    const likeForLike = anchorAgreement(
      txn({ sourceSystem: 'gateway', referenceIds: { order_id: 'order_XYZ123' } }),
      txn({ sourceSystem: 'ledger', referenceIds: { order_id: 'order_XYZ123' } }),
      config, false);
    assert.equal(likeForLike.kind === 'exact' && likeForLike.strength, 'weak_weak');
  });

  test('the ADR-030 ceiling is untouched: strong_weak still cannot reach 1.0 alone', () => {
    // The change moves pairs into an EXISTING bucket; it does not create a bucket
    // and it does not touch a weight.
    assert.equal(maxScoreForAnchor('strong_weak', config), 1);
    assert.ok(maxScoreForAnchor('none', config) < config.fuzzyAutoConfirmThreshold,
      'a pair with no shared reference of any kind still cannot auto-confirm');
  });
});

describe('near-anchor (ADR-031)', () => {
  const typo = 'pay_QK29fT10aXbZ81';
  const typod = 'pay_QK29fT10aXbZ18';   // adjacent transposition

  test('fires only WITH corroboration from amount and date', () => {
    const corroborated = anchorAgreement(
      txn({ sourceSystem: 'gateway', referenceIds: { payment_id: typo } }),
      txn({ sourceSystem: 'ledger', referenceIds: { payment_id: typod } }),
      config, true);
    assert.equal(corroborated.kind, 'near');

    const uncorroborated = anchorAgreement(
      txn({ sourceSystem: 'gateway', referenceIds: { payment_id: typo } }),
      txn({ sourceSystem: 'ledger', referenceIds: { payment_id: typod } }),
      config, false);
    // Without corroboration a one-character difference is not evidence, and the
    // pair falls through to being a contradiction.
    assert.equal(uncorroborated.kind, 'contradiction');
  });

  test('a near-anchor alone cannot carry a match', () => {
    // 0.24 anchor + a degraded amount/date must stay under auto-confirm.
    const g = txn({ sourceSystem: 'gateway', amountPaise: 100_000, netAmountPaise: 100_000,
      txnDate: '2026-08-14', referenceIds: { payment_id: typo }, counterpartyNorm: null });
    const l = txn({ sourceSystem: 'ledger', amountPaise: 100_000, netAmountPaise: 100_000,
      txnDate: '2026-08-15', referenceIds: { payment_id: typod }, counterpartyNorm: null });
    const r = scorePair(g, l, config);
    assert.ok(!r.discarded);
    assert.equal(r.ruleId, 'NEAR_ANCHOR_V1');
    assert.ok(r.score < config.fuzzyAutoConfirmThreshold);
  });

  test('two genuinely different ids stay a contradiction', () => {
    const r = anchorAgreement(
      txn({ referenceIds: { payment_id: 'pay_AAAAAAAAAAAA01' } }),
      txn({ referenceIds: { payment_id: 'pay_ZZZZZZZZZZZZ99' } }),
      config, true);
    assert.equal(r.kind, 'contradiction');
  });

  test('short references are never near-matched', () => {
    // Below 12 characters, edit distance 1 is a plausible coincidence.
    const r = anchorAgreement(
      txn({ referenceIds: { rrn: '123456789012' } }),
      txn({ referenceIds: { rrn: '123456789021' } }),
      { ...config, nearAnchorMinLength: 20 }, true);
    assert.equal(r.kind, 'contradiction');
  });
});

describe('scorePair determinism', () => {
  test('argument order does not change the score', () => {
    const g = txn({ sourceSystem: 'gateway', netAmountPaise: 99_000, txnDate: '2026-08-14',
      counterpartyNorm: 'ACME', referenceIds: { order_id: 'o1' } });
    const b = txn({ sourceSystem: 'bank', amountPaise: 99_100, txnDate: '2026-08-16',
      counterpartyNorm: 'ACME LTD', referenceIds: { order_id: 'o1' } });
    const forward = scorePair(g, b, config);
    const backward = scorePair(b, g, config);
    assert.ok(!forward.discarded && !backward.discarded);
    assert.equal(forward.score, backward.score);
    assert.deepEqual(forward.breakdown, backward.breakdown);
  });

  test('repeated scoring is bit-identical', () => {
    const g = txn({ sourceSystem: 'gateway', netAmountPaise: 12_345, txnDate: '2026-08-14',
      counterpartyNorm: 'AMAZON RETAIL', referenceIds: { order_id: 'o1' } });
    const b = txn({ sourceSystem: 'bank', amountPaise: 12_400, txnDate: '2026-08-15',
      counterpartyNorm: 'AMZN', referenceIds: { order_id: 'o1' } });
    const first = scorePair(g, b, config);
    for (let i = 0; i < 50; i += 1) {
      assert.deepEqual(scorePair(g, b, config), first);
    }
  });
});
