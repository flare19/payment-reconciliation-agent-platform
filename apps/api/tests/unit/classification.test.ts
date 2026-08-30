import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import { EXCEPTION_PRECEDENCE, type ExceptionCategory, type SourceSystem } from '../../src/types/domain.js';
import type { NormalizedTransaction, RunConfig } from '../../src/types/engine.js';
import { computeSeverity, baseSeverity } from '../../src/services/classification/severity.js';
import { applyPrecedence, outranks } from '../../src/services/classification/precedence.js';
import { classify, type ClassificationInput } from '../../src/services/classification/classify.js';
import { resolveIdentity } from '../../src/services/matching/identity-resolution.js';
import { dedupe } from '../../src/services/matching/dedupe.js';

const config: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-31', aliasCountAtStart: 0 };

function txn(
  id: string, source: SourceSystem, row: number,
  o: { refs?: Record<string, unknown>; amount?: number; net?: number | null;
       date?: string; cp?: string | null } = {},
): NormalizedTransaction {
  const refs = (o.refs ?? {}) as NormalizedTransaction['referenceIds'];
  const hasStrong = Boolean(refs.payment_id ?? refs.rrn ?? refs.utr ?? refs.entry_id ?? refs.invoice_no);
  return {
    id, runId: 'r', sourceSystem: source, sourceFile: `${source}.csv`, sourceRowNumber: row,
    externalId: id, referenceIds: refs, anchorStrength: hasStrong ? 'strong' : 'none',
    amountPaise: o.amount ?? 100_000, feePaise: null, taxPaise: null,
    netAmountPaise: o.net === undefined ? (o.amount ?? 100_000) : o.net,
    currency: 'INR', direction: 'credit', txnDate: o.date ?? '2026-08-14',
    txnTimestamp: null, postingDate: null, counterpartyRaw: null,
    counterpartyNorm: o.cp === undefined ? 'ACME' : o.cp, counterpartyKey: null,
    method: 'card', statusRaw: 'captured', statusNorm: 'reconcilable', txnType: null,
    descriptionRaw: null, duplicateOfTransactionId: null, duplicateKind: null,
    ingestWarnings: [], rawPayload: {},
  };
}

function input(over: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    pool: [], duplicates: [], identity: [], ambiguities: [], batches: [],
    matchedPairs: [], config, ...over,
  };
}

const PAY_A = 'pay_QK29fT10aXbZ81';

describe('severity is computed from category AND money (ADR-044)', () => {
  test('base severities per category', () => {
    assert.equal(baseSeverity('AMBIGUOUS_MATCH'), 'high');
    assert.equal(baseSeverity('MISSING_IN_BANK'), 'high');
    assert.equal(baseSeverity('AMOUNT_MISMATCH'), 'high');
    assert.equal(baseSeverity('MISSING_IN_LEDGER'), 'medium');
    assert.equal(baseSeverity('MISSING_IN_GATEWAY'), 'medium');
    assert.equal(baseSeverity('UNSPLITTABLE_BATCH'), 'medium');
    assert.equal(baseSeverity('TIMING_DRIFT'), 'low');
  });

  test('a proved duplicate outranks a suspected one', () => {
    // An EXACT duplicate is proved by a shared strong anchor; a SUSPECTED one is
    // circumstantial and both copies stay in the pool. Filing a guess at the same
    // severity as a proof would misrepresent what the engine knows (ADR-034).
    assert.equal(baseSeverity('DUPLICATE_RECORD', { duplicateKind: 'exact' }), 'high');
    assert.equal(baseSeverity('DUPLICATE_RECORD', { duplicateKind: 'suspected' }), 'medium');
  });

  test('THE POINT OF ADR-044: a Rs.5 mismatch and a Rs.5,00,000 one differ', () => {
    // A fixed per-category severity made both `high`, which makes the exception
    // list's default sort order useless.
    const small = computeSeverity('MISSING_IN_LEDGER', 500, config);
    const large = computeSeverity('MISSING_IN_LEDGER', 50_000_000, config);
    assert.equal(small.severity, 'medium');
    assert.equal(large.severity, 'high');
    assert.equal(large.basis.escalated, true);
    assert.equal(small.basis.escalated, false);
  });

  test('the exact escalation boundaries', () => {
    const at = (paise: number) => computeSeverity('MISSING_IN_LEDGER', paise, config).severity;
    assert.equal(at(4_999_999), 'medium');    // just under Rs.50,000
    assert.equal(at(5_000_000), 'high');      // Rs.50,000 -> one level up from medium
    assert.equal(at(19_999_999), 'high');
    assert.equal(at(20_000_000), 'high');     // Rs.2,00,000 -> high outright
    // From `low`, Rs.50,000 lifts one level only.
    assert.equal(computeSeverity('TIMING_DRIFT', 5_000_000, config).severity, 'medium');
  });

  test('TIMING_DRIFT is capped at medium however large the amount', () => {
    // A late settlement is a process artifact at any size; letting a large one
    // outrank a genuine value discrepancy would put the wrong row on top.
    const r = computeSeverity('TIMING_DRIFT', 500_000_000, config);
    assert.equal(r.severity, 'medium');
    assert.equal(r.basis.cappedBy, 'TIMING_DRIFT');
  });

  test('a null amount leaves the base untouched, and never throws', () => {
    const r = computeSeverity('UNSPLITTABLE_BATCH', null, config);
    assert.equal(r.severity, 'medium');
    assert.equal(r.basis.escalated, false);
  });

  test('magnitude is used, so a negative delta escalates identically', () => {
    assert.equal(computeSeverity('AMOUNT_MISMATCH', -50_000_000, config).severity,
                 computeSeverity('AMOUNT_MISMATCH', 50_000_000, config).severity);
  });

  test('the basis is always recorded, so the sort order is explainable', () => {
    const r = computeSeverity('MISSING_IN_LEDGER', 50_000_000, config);
    assert.deepEqual(r.basis,
      { base: 'medium', amountAtRiskPaise: 50_000_000, escalated: true, cappedBy: null });
  });
});

describe('precedence — one primary, the rest as flags (schema.md §8.2)', () => {
  test('the declared order is the array, not a switch statement', () => {
    assert.deepEqual([...EXCEPTION_PRECEDENCE], [
      'DUPLICATE_RECORD', 'AMBIGUOUS_MATCH', 'UNSPLITTABLE_BATCH',
      'AMOUNT_MISMATCH',
      'MISSING_IN_GATEWAY', 'MISSING_IN_BANK', 'MISSING_IN_LEDGER',
      'TIMING_DRIFT',
    ]);
  });

  test('money before calendar: AMOUNT_MISMATCH primary, TIMING_DRIFT flagged', () => {
    // Reversing this would let a real money problem be reported as a
    // low-severity scheduling quirk.
    const r = applyPrecedence(['TIMING_DRIFT', 'AMOUNT_MISMATCH']);
    assert.deepEqual(r, { primary: 'AMOUNT_MISMATCH', secondaryFlags: ['TIMING_DRIFT'] });
  });

  test('duplicates claim a record before anything else', () => {
    const r = applyPrecedence(['MISSING_IN_BANK', 'TIMING_DRIFT', 'DUPLICATE_RECORD']);
    assert.equal(r!.primary, 'DUPLICATE_RECORD');
  });

  test('ambiguity outranks presence: "found two" is not "found none"', () => {
    assert.ok(outranks('AMBIGUOUS_MATCH', 'MISSING_IN_BANK'));
    assert.ok(outranks('UNSPLITTABLE_BATCH', 'MISSING_IN_BANK'));
  });

  test('flags come back in precedence order regardless of input order', () => {
    const a = applyPrecedence(['TIMING_DRIFT', 'MISSING_IN_BANK', 'AMOUNT_MISMATCH']);
    const b = applyPrecedence(['AMOUNT_MISMATCH', 'TIMING_DRIFT', 'MISSING_IN_BANK']);
    assert.deepEqual(a, b);
    // AMOUNT_MISMATCH now leads (ADR-062); the presence gap and the drift follow,
    // in precedence order rather than input order.
    assert.equal(a!.primary, 'AMOUNT_MISMATCH');
    assert.deepEqual(a!.secondaryFlags, ['MISSING_IN_BANK', 'TIMING_DRIFT']);
  });

  test('duplicate signals collapse', () => {
    const r = applyPrecedence(['AMBIGUOUS_MATCH', 'AMBIGUOUS_MATCH']);
    assert.deepEqual(r, { primary: 'AMBIGUOUS_MATCH', secondaryFlags: [] });
  });

  test('nothing fired is null, not a fabricated category', () => {
    assert.equal(applyPrecedence([]), null);
  });

  test('every category has a rank', () => {
    for (const c of EXCEPTION_PRECEDENCE) {
      assert.equal(applyPrecedence([c as ExceptionCategory])!.primary, c);
    }
  });
});

describe('classify — the worked overlaps from schema.md §8.2', () => {
  test('a non-primary duplicate gets DUPLICATE_RECORD and NO presence flag', () => {
    // The correction from ADR-034: the bank is not missing anything, because the
    // second copy never existed as an economic event.
    const rows = [
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, date: '2026-08-14' }),
      txn('g2', 'gateway', 5, { refs: { payment_id: PAY_A }, date: '2026-08-14' }),
    ];
    const d = dedupe(rows);
    // `pool` is exactly what the real pipeline passes — d.pool, not the
    // excluded copy concatenated back in (that was a workaround for the
    // ordering bug fixed in issue #2, not what ClassificationInput.pool
    // actually contains).
    const out = classify(input({ pool: d.pool, duplicates: d.findings }));
    const dup = out.find((e) => e.transactionId === 'g2')!;
    assert.equal(dup.category, 'DUPLICATE_RECORD');
    assert.deepEqual(dup.secondaryFlags, [], 'no MISSING_IN_* on a duplicate copy');
    assert.equal(dup.severity, 'high');
    assert.deepEqual(out.map((e) => e.transactionId), ['g1', 'g2'], 'canonical order (ADR-032)');
  });

  test('a suspected duplicate is medium and asks for a human', () => {
    const rows = [
      txn('b1', 'bank', 1, { refs: {}, amount: 49_900, cp: 'ACME' }),
      txn('b2', 'bank', 2, { refs: {}, amount: 49_900, cp: 'ACME' }),
    ];
    const d = dedupe(rows);
    const out = classify(input({ pool: rows, duplicates: d.findings }));
    const dup = out.find((e) => e.category === 'DUPLICATE_RECORD')!;
    assert.equal(dup.severity, 'medium');
    assert.equal(dup.requiresHumanConfirmation, true);
  });

  test('anchor agrees, amount off, date off => AMOUNT_MISMATCH + TIMING_DRIFT', () => {
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000, date: '2026-08-14' });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, amount: 141_200, date: '2026-08-23' });
    const l = txn('l1', 'ledger', 1, { refs: {}, date: '2026-08-14' });
    const verdict = resolveIdentity(g, b, config);
    // The ledger leg is matched, so this reproduces the doc's worked overlap
    // exactly: one counterpart, two things wrong with it.
    const out = classify(input({
      pool: [g, b, l], identity: [{ pair: [g, b], verdict }],
      matchedPairs: [{ aId: 'g1', bId: 'l1' }],
    }));
    const e = out.find((x) => x.transactionId === 'g1')!;
    assert.equal(e.category, 'AMOUNT_MISMATCH');
    assert.deepEqual(e.secondaryFlags, ['TIMING_DRIFT']);
    assert.equal(e.amountAtRiskPaise, 41_200);
    assert.equal(e.detectedByRule, 'IDENTITY_AMOUNT_MISMATCH_V1');
  });

  test('a pure timing drift records the delta so a human can confirm in one click', () => {
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000, date: '2026-08-14' });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, amount: 100_000, date: '2026-08-23' });
    const l = txn('l1', 'ledger', 1, { refs: {}, date: '2026-08-14' });
    const verdict = resolveIdentity(g, b, config);
    // A ledger counterpart, so the ONLY finding on g1 is the drift. Without it the
    // record is also missing from the ledger, which outranks a late settlement.
    const out = classify(input({
      pool: [g, b, l], identity: [{ pair: [g, b], verdict }],
      matchedPairs: [{ aId: 'g1', bId: 'l1' }],
    }));
    const e = out.find((x) => x.transactionId === 'g1')!;
    assert.equal(e.category, 'TIMING_DRIFT');
    assert.deepEqual(e.evidence.wouldMatchIfWindowWidened, { dateDeltaDays: 9 });
    // Rs.1,000 is far below the Rs.50,000 escalation floor, so nothing escalates
    // and the TIMING_DRIFT cap never has to do anything: base `low` stands.
    assert.equal(e.severity, 'low');
  });

  test('PRESENCE AND VALUE NEVER BOTH FIRE for the same leg', () => {
    // "You cannot have an amount disagreement with a record that isn't there."
    // The bank record exists and its anchor agrees, so this is a value question —
    // MISSING_IN_BANK must not also appear and inflate the exception count.
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000, date: '2026-08-14' });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, amount: 141_200, date: '2026-08-16' });
    const verdict = resolveIdentity(g, b, config);
    const out = classify(input({ pool: [g, b], identity: [{ pair: [g, b], verdict }] }));
    const e = out.find((x) => x.transactionId === 'g1')!;
    assert.equal(e.category, 'AMOUNT_MISMATCH');
    assert.ok(!e.secondaryFlags.includes('MISSING_IN_BANK'));
  });
});

describe('classify — presence uses the reference date, never the wall clock', () => {
  test('an overdue gateway payment with no counterpart is MISSING_IN_BANK', () => {
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, date: '2026-08-14' });
    const out = classify(input({ pool: [g] }));
    const categories = out.filter((e) => e.transactionId === 'g1').map((e) => e.category);
    assert.ok(categories.includes('MISSING_IN_BANK') || out[0]!.secondaryFlags.includes('MISSING_IN_BANK'));
    const e = out.find((x) => x.transactionId === 'g1')!;
    assert.match(e.evidence.candidates.length === 0 ? 'ok' : '', /ok/);
  });

  test('A PAYMENT STILL IN FLIGHT IS NOT AN EXCEPTION (ADR-039)', () => {
    // Captured one day before the reference date: the T+3 window has not closed,
    // so it is in progress, not missing. Calling it an exception would put a
    // normal in-progress payment in front of a controller as a problem.
    const inFlight = { ...config, referenceDate: '2026-08-15' };
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, date: '2026-08-14' });
    const out = classify(input({ pool: [g], config: inFlight }));
    assert.deepEqual(out, []);
  });

  test('the same record IS an exception once the window closes', () => {
    const overdue = { ...config, referenceDate: '2026-08-20' };
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, date: '2026-08-14' });
    const out = classify(input({ pool: [g], config: overdue }));
    assert.ok(out.length > 0, 'the verdict flips on the reference date alone');
    // ClassifiedException has no top-level `reason` field (see #9) — the honest
    // properties this scenario proves are the primary category, the secondary
    // flag for the other missing counterpart, and that presence found nothing.
    assert.equal(out[0]!.transactionId, 'g1');
    assert.equal(out[0]!.category, 'MISSING_IN_BANK');
    assert.deepEqual(out[0]!.secondaryFlags, ['MISSING_IN_LEDGER']);
    assert.equal(out[0]!.evidence.candidatesConsidered, 0);
  });

  test('a matched leg is not reported missing', () => {
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, date: '2026-08-14' });
    const b = txn('b1', 'bank', 1, { refs: {}, date: '2026-08-16' });
    const out = classify(input({
      pool: [g, b], matchedPairs: [{ aId: 'g1', bId: 'b1' }],
    }));
    const g1 = out.find((e) => e.transactionId === 'g1');
    assert.ok(g1 === undefined || g1.category !== 'MISSING_IN_BANK');
  });

  test('a bank row with no gateway counterpart is MISSING_IN_GATEWAY', () => {
    const b = txn('b1', 'bank', 1, { refs: {}, date: '2026-08-14' });
    const out = classify(input({ pool: [b] }));
    assert.equal(out[0]!.category, 'MISSING_IN_GATEWAY');
    assert.equal(out[0]!.severity, 'medium');
  });

  test('an ambiguous record is never ALSO reported missing', () => {
    // It did not find zero candidates — it found too many. Reporting both would
    // count one problem twice.
    const g = txn('g1', 'gateway', 1, { refs: {}, date: '2026-08-14' });
    const out = classify(input({
      pool: [g],
      ambiguities: [{
        transactionId: 'g1', targetSource: 'bank', delta: 0.02,
        rivals: [{ transactionId: 'b1', score: 0.88 }, { transactionId: 'b2', score: 0.86 }],
      }],
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.category, 'AMBIGUOUS_MATCH');
    assert.ok(!out[0]!.secondaryFlags.some((f) => f.startsWith('MISSING')));
    assert.equal(out[0]!.bestCandidateScore, 0.88);
    assert.equal(out[0]!.evidence.candidatesConsidered, 2);
  });
});

describe('classify — settlementDue uses the correct window per source pair (issue #5)', () => {
  test('a ledger row missing its gateway counterpart uses the gateway<->ledger window, not the card window', () => {
    // dateWindowLedgerDays is [-1, 1]. dateWindowCardDays is [-1, 3] — the bug
    // applied the card window here because `method` is always null on a
    // non-gateway record, so the switch fell through to it.
    const l = txn('l1', 'ledger', 1, { refs: {}, date: '2026-08-14' });
    const out = classify(input({ pool: [l] }));
    const e = out.find((x) => x.transactionId === 'l1')!;
    assert.equal(e.category, 'MISSING_IN_GATEWAY');
    assert.deepEqual(e.evidence.windowUsed.dateWindow, config.dateWindowLedgerDays);
    assert.notDeepEqual(e.evidence.windowUsed.dateWindow, config.dateWindowCardDays);
  });

  test('a bank row missing its gateway counterpart uses its own stated fallback window (ADR-065), not the borrowed card window', () => {
    const b = txn('b1', 'bank', 1, { refs: {}, date: '2026-08-14' });
    const out = classify(input({ pool: [b] }));
    const e = out.find((x) => x.transactionId === 'b1')!;
    assert.equal(e.category, 'MISSING_IN_GATEWAY');
    assert.deepEqual(e.evidence.windowUsed.dateWindow, config.dateWindowGatewayLookbackDays);
    assert.notDeepEqual(e.evidence.windowUsed.dateWindow, config.dateWindowCardDays,
      'must not silently reuse the gateway->bank card window, which is defined in the OPPOSITE direction and measured from the wrong anchor date');
  });
});

describe('classify — MISSING_IN_LEDGER is reachable for bank records (issue #7)', () => {
  test('a bank row with no ledger counterpart gets MISSING_IN_LEDGER as a secondary flag alongside MISSING_IN_GATEWAY', () => {
    const b = txn('b1', 'bank', 1, { refs: {}, date: '2026-08-14' });
    const out = classify(input({ pool: [b] }));
    const e = out.find((x) => x.transactionId === 'b1')!;
    // MISSING_IN_GATEWAY outranks MISSING_IN_LEDGER in the precedence order
    // (schema.md §8.2), so it's the primary — but the ledger absence must not
    // be silently dropped just because it isn't the headline.
    assert.equal(e.category, 'MISSING_IN_GATEWAY');
    assert.ok(e.secondaryFlags.includes('MISSING_IN_LEDGER'),
      'half the category definition (schema.md §8.1: "gateway AND/OR bank") was unreachable before this fix');
  });

  test('a bank row whose gateway leg is matched, but has no ledger counterpart, gets MISSING_IN_LEDGER as primary, using the bank<->ledger window', () => {
    const g = txn('g1', 'gateway', 1, { refs: {}, date: '2026-08-14' });
    const b = txn('b1', 'bank', 1, { refs: {}, date: '2026-08-16' });
    const out = classify(input({
      pool: [g, b], matchedPairs: [{ aId: 'g1', bId: 'b1' }],
    }));
    const e = out.find((x) => x.transactionId === 'b1')!;
    assert.equal(e.category, 'MISSING_IN_LEDGER');
    assert.deepEqual(e.evidence.windowUsed.dateWindow, config.dateWindowBankLedgerDays,
      'the ledger leg must use the bank<->ledger window (ADR-009 [-2,+4]), not a borrowed gateway-facing one');
  });

  test('the comment no longer cites ADR-037 for a prohibition it does not make', async () => {
    // ADR-037 says bank<->ledger amounts aren't a comparable quantity, not
    // that a bank<->ledger presence relationship can never be reported.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../src/services/classification/classify.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /no arithmetic\s*\n?\s*\/\/ relates them without the gateway row in between \(ADR-037\)/);
  });
});

describe('classify — a presence exception reports real candidates when S5/S9 supply them (issue #8)', () => {
  test('candidatesConsidered/candidates/candidateCapHit/displacedByMatchId come from scoredCandidates, not a hardcoded 0/[]/false/null', () => {
    const g = txn('g1', 'gateway', 1, { refs: {}, date: '2026-08-14' });
    const out = classify(input({
      pool: [g],
      scoredCandidates: new Map([
        ['g1', {
          capHit: true,
          displacedByMatchId: 'b9',
          candidates: [
            { transactionId: 'b1', sourceSystem: 'bank', score: 0.61,
              breakdown: { anchor: 0.3, amount: 0, date: 0.2, counterparty: 0.11, total: 0.61, amountUnavailable: false },
              ruleId: 'FUZZY_NO_ANCHOR_V1', rejectedBecause: 'amount delta ₹412.00 exceeds band ₹100.00' },
            { transactionId: 'b2', sourceSystem: 'bank', score: 0.40,
              breakdown: { anchor: 0, amount: 0.2, date: 0.1, counterparty: 0.1, total: 0.40, amountUnavailable: false },
              ruleId: 'FUZZY_NO_ANCHOR_V1', rejectedBecause: null },
          ],
        }],
      ]),
    }));
    const e = out.find((x) => x.transactionId === 'g1')!;
    assert.equal(e.evidence.candidatesConsidered, 2, 'a true count, not the hardcoded 0');
    assert.equal(e.evidence.candidates.length, 2);
    assert.deepEqual(e.evidence.candidates.map((c) => c.transactionId), ['b1', 'b2']);
    assert.equal(e.evidence.candidates[0]!.rejectedBecause, 'amount delta ₹412.00 exceeds band ₹100.00');
    assert.match(e.evidence.candidates[1]!.rejectedBecause, /0\.4|threshold/,
      'a null rejectedBecause still gets an honest, derived reason, never a blank string');
    assert.equal(e.evidence.candidateCapHit, true);
    assert.equal(e.evidence.displacedByMatchId, 'b9');
  });

  test('a record with no scoredCandidates entry still gets the honest 0/[]/false/null default', () => {
    const g = txn('g1', 'gateway', 1, { refs: {}, date: '2026-08-14' });
    const out = classify(input({ pool: [g] }));
    const e = out.find((x) => x.transactionId === 'g1')!;
    assert.equal(e.evidence.candidatesConsidered, 0);
    assert.deepEqual(e.evidence.candidates, []);
    assert.equal(e.evidence.candidateCapHit, false);
    assert.equal(e.evidence.displacedByMatchId, null);
  });
});

describe('classify — batch evidence keeps the two claims distinct', () => {
  const credit = txn('c1', 'bank', 1, { amount: 500_000, date: '2026-08-16' });

  test('an exhaustive search records a proof, and no bound', () => {
    const out = classify(input({
      pool: [credit],
      batches: [{ credit, outcome: {
        kind: 'unsplittable', reason: 'searched everything',
        stats: { poolSize: 5, nodesVisited: 40, solutionsFound: 0, exhaustive: true,
                 boundHit: null, subsetSizeCapReached: false },
      } }],
    }));
    assert.equal(out[0]!.category, 'UNSPLITTABLE_BATCH');
    assert.equal(out[0]!.evidence.searchExhausted, true);
    assert.equal(out[0]!.evidence.searchBoundExceeded, null);
  });

  test('a truncated search records the bound, and no proof', () => {
    const out = classify(input({
      pool: [credit],
      batches: [{ credit, outcome: {
        kind: 'unsplittable', reason: 'ran out',
        stats: { poolSize: 24, nodesVisited: 1, solutionsFound: 0, exhaustive: false,
                 boundHit: { bound: 'pool', value: 24 }, subsetSizeCapReached: true },
      } }],
    }));
    assert.equal(out[0]!.evidence.searchExhausted, null);
    assert.deepEqual(out[0]!.evidence.searchBoundExceeded, { bound: 'pool', value: 24 });
  });

  test('classify is a faithful passthrough of stats.exhaustive/boundHit — it does not ' +
    'itself enforce their exclusivity (see #11)', () => {
    // The exclusivity ("exactly one of these is ever non-null") is real, but it
    // is a property of `searchSubsetsInBand` (batch-decomposition.ts — see its
    // "exhaustive === true implies boundHit === null" property test), not of
    // classify.ts. The old version of this test built its own fixture with
    // `boundHit: exhaustive ? null : {...}`, which already satisfied the
    // invariant before classify ever ran — it could not fail. Feeding classify
    // a genuinely contradictory stats object (as searchSubsets itself never
    // produces for an 'unsplittable' outcome) proves classify copies both
    // fields through rather than silently reconciling bad input.
    const out = classify(input({
      pool: [credit],
      batches: [{ credit, outcome: {
        kind: 'unsplittable', reason: 'contradictory fixture, on purpose',
        stats: { poolSize: 3, nodesVisited: 1, solutionsFound: 0, exhaustive: true,
                 boundHit: { bound: 'nodes', value: 10 }, subsetSizeCapReached: false },
      } }],
    }));
    const ev = out[0]!.evidence;
    assert.equal(ev.searchExhausted, true);
    assert.deepEqual(ev.searchBoundExceeded, { bound: 'nodes', value: 10 });
  });
});

describe('classify — determinism and completeness', () => {
  test('every exception carries evidence and a rule id', () => {
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, date: '2026-08-14' });
    const b = txn('b1', 'bank', 2, { refs: {}, date: '2026-08-14' });
    const out = classify(input({ pool: [g, b] }));
    assert.ok(out.length > 0);
    for (const e of out) {
      assert.ok(e.detectedByRule.length > 0, 'a rule must own every finding');
      assert.equal(e.ruleVersion, config.ruleVersion);
      assert.ok(e.evidence.severityBasis !== undefined);
      assert.ok(Array.isArray(e.evidence.candidates));
    }
  });

  test('input order does not change the output', () => {
    const rows = [
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, date: '2026-08-14' }),
      txn('b1', 'bank', 1, { refs: {}, date: '2026-08-14' }),
      txn('l1', 'ledger', 1, { refs: {}, date: '2026-08-14' }),
    ];
    const fingerprint = (pool: NormalizedTransaction[]): string =>
      classify(input({ pool })).map((e) => `${e.transactionId}:${e.category}:${e.severity}`).join('|');
    assert.equal(fingerprint([...rows].reverse()), fingerprint(rows));
  });

  test('excluded rows are never classified', () => {
    const excluded = { ...txn('g1', 'gateway', 1, { date: '2026-08-14' }),
      statusNorm: 'excluded_failed' as const };
    assert.deepEqual(classify(input({ pool: [excluded] })), []);
  });
});

describe('classify — output order is canonical even for excluded duplicates (ADR-032, issue #2)', () => {
  test('a DUPLICATE_RECORD exception sorts by the duplicate\'s OWN (source, row), not last', () => {
    // Reproduces the issue exactly: a ledger duplicate at row 2, a surviving
    // ledger row at row 1, and a gateway row at row 1 with no counterpart.
    // Canonical order is g1 (gateway,1) < l1 (ledger,1) < l2 (ledger,2).
    const g1 = txn('g1', 'gateway', 1, { refs: {}, date: '2026-08-14' });
    const l1 = txn('l1', 'ledger', 1, { refs: { invoice_no: 'INV1' }, date: '2026-08-14' });
    const l2 = txn('l2', 'ledger', 2, { refs: { invoice_no: 'INV1' }, date: '2026-08-14' });
    const d = dedupe([l1, l2]);
    assert.equal(d.pool.length, 1, 'l2 is the non-primary exact duplicate, excluded from the pool');

    const out = classify(input({ pool: [g1, ...d.pool], duplicates: d.findings }));
    const dup = out.find((e) => e.transactionId === 'l2');
    assert.ok(dup !== undefined && dup.category === 'DUPLICATE_RECORD');

    assert.deepEqual(out.map((e) => e.transactionId), ['g1', 'l1', 'l2'],
      'the excluded duplicate must sort by its own (source, row), not fall back to insertion order');
  });

  test('the comparator is transitive: reversing signal-discovery order does not change the result', () => {
    const g1 = txn('g1', 'gateway', 1, { refs: {}, date: '2026-08-14' });
    const l1 = txn('l1', 'ledger', 1, { refs: { invoice_no: 'INV2' }, date: '2026-08-14' });
    const l2 = txn('l2', 'ledger', 2, { refs: { invoice_no: 'INV2' }, date: '2026-08-14' });
    const l3 = txn('l3', 'ledger', 3, { refs: { invoice_no: 'INV2' }, date: '2026-08-14' });
    const d = dedupe([l1, l2, l3]);
    const forward = classify(input({ pool: [g1, ...d.pool], duplicates: d.findings }))
      .map((e) => e.transactionId);
    const reversed = classify(input({ pool: [g1, ...d.pool], duplicates: [...d.findings].reverse() }))
      .map((e) => e.transactionId);
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward, ['g1', 'l1', 'l2', 'l3']);
  });
});
