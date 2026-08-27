import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import type { NormalizedTransaction, ReferenceIds, RunConfig } from '../../src/types/engine.js';
import type { SourceSystem, StatusNorm, Direction } from '../../src/types/domain.js';
import { dedupe } from '../../src/services/matching/dedupe.js';
import { resolveIdentity, resolveIdentities } from '../../src/services/matching/identity-resolution.js';
import { scorePair } from '../../src/services/matching/scoring.js';

const config: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-31', aliasCountAtStart: 0 };

interface Over {
  refs?: ReferenceIds; amount?: number; net?: number | null; date?: string;
  cp?: string | null; status?: StatusNorm; direction?: Direction; method?: 'card' | 'upi';
}
function txn(id: string, source: SourceSystem, row: number, o: Over = {}): NormalizedTransaction {
  const refs = o.refs ?? {};
  const hasStrong = Boolean(refs.payment_id ?? refs.settlement_id ?? refs.rrn ?? refs.utr
    ?? refs.entry_id ?? refs.invoice_no);
  return {
    id, runId: 'r', sourceSystem: source, sourceFile: `${source}.csv`, sourceRowNumber: row,
    externalId: id, referenceIds: refs, anchorStrength: hasStrong ? 'strong' : 'none',
    amountPaise: o.amount ?? 100_000, feePaise: null, taxPaise: null,
    net: undefined as never, netAmountPaise: o.net === undefined ? (o.amount ?? 100_000) : o.net,
    currency: 'INR', direction: o.direction ?? 'credit',
    txnDate: o.date ?? '2026-08-14', txnTimestamp: null, postingDate: null,
    counterpartyRaw: o.cp ?? null, counterpartyNorm: o.cp === undefined ? 'ACME' : o.cp,
    counterpartyKey: null,
    method: o.method ?? 'card', statusRaw: 'captured',
    statusNorm: o.status ?? 'reconcilable', txnType: null,
    descriptionRaw: null, duplicateOfTransactionId: null, duplicateKind: null,
    ingestWarnings: [], rawPayload: {},
  } as NormalizedTransaction;
}

const PAY_A = 'pay_QK29fT10aXbZ81';
const PAY_B = 'pay_ZZ99zZ99zZ99zZ';

describe('S4 dedupe — exact duplicates require anchor evidence', () => {
  test('two gateway rows sharing a payment_id: first survives, second is excluded', () => {
    const r = dedupe([
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('g2', 'gateway', 5, { refs: { payment_id: PAY_A } }),
      txn('b1', 'bank', 1, { refs: {} }),
    ]);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0]!;
    assert.equal(f.transactionId, 'g2');
    assert.equal(f.primaryTransactionId, 'g1', 'lowest source_row_number survives');
    assert.equal(f.kind, 'exact');
    assert.equal(f.anchorKey, 'payment_id');
    assert.deepEqual(r.pool.map((t) => t.id), ['g1', 'b1'], 'the copy leaves the matching pool');
  });

  test('the reason names the rows and the anchor, readably', () => {
    const r = dedupe([
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('g2', 'gateway', 5, { refs: { payment_id: PAY_A } }),
    ]);
    const reason = r.findings[0]!.reason;
    assert.match(reason, /row 5 of the gateway file repeats payment_id/);
    assert.match(reason, /row 1/);
    assert.doesNotMatch(reason, /undefined|null|\[object/);
  });

  test('a three-row cluster keeps one primary and excludes two copies', () => {
    const r = dedupe([
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('g2', 'gateway', 2, { refs: { payment_id: PAY_A } }),
      txn('g3', 'gateway', 3, { refs: { payment_id: PAY_A } }),
    ]);
    assert.equal(r.findings.length, 2);
    assert.deepEqual(r.pool.map((t) => t.id), ['g1']);
    for (const f of r.findings) assert.equal(f.primaryTransactionId, 'g1');
  });

  test('transitive clusters: shared payment_id and shared rrn merge into one', () => {
    // g1~g2 share a payment_id, g2~g3 share an rrn. All three are one payment,
    // and treating them as two overlapping pairs would elect two primaries.
    const r = dedupe([
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('g2', 'gateway', 2, { refs: { payment_id: PAY_A, rrn: '234567890123' } }),
      txn('g3', 'gateway', 3, { refs: { rrn: '234567890123' } }),
    ]);
    assert.equal(r.findings.length, 2);
    assert.deepEqual(r.pool.map((t) => t.id), ['g1']);
  });

  test('duplication is SAME-SOURCE only — a gateway/bank pair is a match, not a duplicate', () => {
    const r = dedupe([
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('b1', 'bank', 1, { refs: { payment_id: PAY_A } }),
    ]);
    assert.deepEqual(r.findings, []);
    assert.equal(r.pool.length, 2);
  });

  test('a malformed RRN is not identity, so it cannot prove duplication', () => {
    // A truncated 7-digit fragment looks like a reference and is not one.
    const r = dedupe([
      txn('b1', 'bank', 1, { refs: { rrn: '2345678' } }),
      txn('b2', 'bank', 2, { refs: { rrn: '2345678' } }),
    ]);
    assert.deepEqual(r.findings, []);
  });

  test('excluded rows are never deduplicated', () => {
    const r = dedupe([
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, status: 'excluded_failed' }),
      txn('g2', 'gateway', 2, { refs: { payment_id: PAY_A }, status: 'excluded_failed' }),
    ]);
    assert.deepEqual(r.findings, []);
    assert.equal(r.pool.length, 2, 'excluded rows pass through untouched');
  });
});

describe('S4 dedupe — the IDENTITY_DESTROYED collision (ADR-034)', () => {
  const anon = (id: string, row: number) =>
    txn(id, 'bank', row, { refs: {}, amount: 499_00, date: '2026-08-14', cp: 'ACME' });

  test('THREE anchorless same-amount/day/merchant rows are NOT duplicates', () => {
    // The dataset's hardest designed case. Under the Day 2 rule these classify as
    // duplicates of each other; the correct answer is AMBIGUOUS_MATCH, and the
    // classifier's very first rule must not resolve what the generator proved
    // unresolvable.
    const r = dedupe([anon('b1', 1), anon('b2', 2), anon('b3', 3)]);
    assert.deepEqual(r.findings, [], 'a crowd is ambiguity, not duplication');
    assert.equal(r.pool.length, 3, 'all three stay available to the matcher');
  });

  test('but exactly TWO are a SUSPECTED duplicate — and both stay in the pool', () => {
    const r = dedupe([anon('b1', 1), anon('b2', 2)]);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0]!;
    assert.equal(f.kind, 'suspected');
    assert.equal(f.anchorKey, null, 'there is no anchor — that is the point');
    assert.equal(r.pool.length, 2,
      'circumstantial evidence is not enough to remove a record from reconciliation');
    assert.match(f.reason, /cannot be proved without a human/);
  });

  test('four rows are not two suspected pairs', () => {
    const r = dedupe([anon('b1', 1), anon('b2', 2), anon('b3', 3), anon('b4', 4)]);
    assert.deepEqual(r.findings, []);
  });

  test('any distinguishing anchor removes a row from suspicion', () => {
    const r = dedupe([
      anon('b1', 1),
      txn('b2', 'bank', 2, { refs: { utr: 'SBIN0R52026081412345' }, amount: 499_00, cp: 'ACME' }),
    ]);
    assert.deepEqual(r.findings, [], 'one side has identity, so they are distinguishable');
  });

  test('rows with no counterparty at all are not bucketed together', () => {
    const r = dedupe([
      txn('b1', 'bank', 1, { refs: {}, cp: null }),
      txn('b2', 'bank', 2, { refs: {}, cp: null }),
    ]);
    assert.deepEqual(r.findings, [], 'absence of a name is not evidence of sameness');
  });

  test('a differing direction breaks the bucket', () => {
    const r = dedupe([
      txn('b1', 'bank', 1, { refs: {}, cp: 'ACME', direction: 'credit' }),
      txn('b2', 'bank', 2, { refs: {}, cp: 'ACME', direction: 'debit' }),
    ]);
    assert.deepEqual(r.findings, [], 'a credit and a debit are not copies of each other');
  });
});

describe('S4 dedupe — determinism', () => {
  test('input order does not change findings or pool', () => {
    const rows = [
      txn('g3', 'gateway', 3, { refs: { payment_id: PAY_A } }),
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('g2', 'gateway', 2, { refs: { payment_id: PAY_B } }),
      txn('b1', 'bank', 1, { refs: {}, cp: 'ACME' }),
      txn('b2', 'bank', 2, { refs: {}, cp: 'ACME' }),
    ];
    const fingerprint = (rs: NormalizedTransaction[]): string => {
      const r = dedupe(rs);
      return r.pool.map((t) => t.id).join(',') + '|' +
        r.findings.map((f) => `${f.transactionId}<-${f.primaryTransactionId}:${f.kind}`).join(',');
    };
    const expected = fingerprint(rows);
    assert.equal(fingerprint([...rows].reverse()), expected);
    assert.equal(fingerprint([rows[2]!, rows[4]!, rows[0]!, rows[3]!, rows[1]!]), expected);
  });
});

describe('S8 identity short-circuit — THE TWO UNREACHABLE CATEGORIES (ADR-029)', () => {
  test('REGRESSION: same payment_id, amount off Rs.412 => AMOUNT_MISMATCH, NOT a review-queue match', () => {
    // Under the Day 2 design this scored 0.70 and became a pending_review MATCH,
    // so AMOUNT_MISMATCH could never fire. The negative assertion is the point.
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000 });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, amount: 141_200 });
    const v = resolveIdentity(g, b, config);
    assert.equal(v.kind, 'established');
    assert.ok(v.kind === 'established');
    assert.equal(v.outcome, 'amount_mismatch');
    assert.equal(v.category, 'AMOUNT_MISMATCH');
    assert.deepEqual(v.secondaryFlags, []);
    assert.equal(v.amountAtRiskPaise, 41_200);
    assert.notEqual(v.outcome as string, 'match', 'this must NOT become a match of any status');
  });

  test('REGRESSION: same payment_id, exact amount, +9 days => TIMING_DRIFT, NOT auto-confirmed', () => {
    // The worse original failure: this scored exactly 0.85 and silently
    // auto-matched a settlement three times past its SLA.
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000, date: '2026-08-14' });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, amount: 100_000, date: '2026-08-23' });
    const v = resolveIdentity(g, b, config);
    assert.ok(v.kind === 'established');
    assert.equal(v.outcome, 'timing_drift');
    assert.equal(v.category, 'TIMING_DRIFT');
    assert.equal(v.date.deltaDays, 9);
    assert.equal(v.date.within, false);
    assert.notEqual(v.outcome as string, 'match', 'nine days late must never auto-confirm');
  });

  test('the old scorer really would have produced those wrong answers', () => {
    // Proves the regression tests above are guarding something real rather than
    // asserting a property that was never at risk. With the OLD weights, the
    // amount-mismatch pair scores into the review band and the late pair scores
    // exactly at auto-confirm.
    const old = {
      ...config,
      scoreWeights: {
        anchor: 0.45, amount: 0.30, date: 0.15, counterparty: 0.10,
        anchorStrongWeak: 0.45, anchorNear: 0.35, anchorWeakWeak: 0.25,
      },
    };
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000, date: '2026-08-14' });
    const late = txn('b1', 'bank', 1, { refs: { extracted_from_description: [PAY_A] }, amount: 100_000, date: '2026-08-23' });
    const s = scorePair(g, late, old);
    assert.ok(!s.discarded);
    assert.equal(s.breakdown.date, 0, 'nine days out scores zero on date');
    assert.ok(s.score >= 0.85, `old weights auto-confirm a nine-day-late settlement (scored ${s.score})`);
  });

  test('both wrong => AMOUNT_MISMATCH primary with TIMING_DRIFT secondary', () => {
    // schema.md 8.2 precedence: money before calendar, now actually reachable.
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000, date: '2026-08-14' });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, amount: 141_200, date: '2026-08-23' });
    const v = resolveIdentity(g, b, config);
    assert.ok(v.kind === 'established');
    assert.equal(v.outcome, 'amount_mismatch_with_drift');
    assert.equal(v.category, 'AMOUNT_MISMATCH');
    assert.deepEqual(v.secondaryFlags, ['TIMING_DRIFT']);
  });

  test('everything agreeing yields a match with no exception', () => {
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000, date: '2026-08-14' });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, amount: 100_000, date: '2026-08-16' });
    const v = resolveIdentity(g, b, config);
    assert.ok(v.kind === 'established');
    assert.equal(v.outcome, 'match');
    assert.equal(v.category, null);
    assert.equal(v.amountAtRiskPaise, null);
  });
});

describe('S8 identity short-circuit — what does and does not establish identity', () => {
  test('a description-extracted anchor does NOT establish identity', () => {
    // Weak by definition (schema.md 3.1). Identity may not rest on a regex hit;
    // that pair is exactly what Tier 2 exists to score.
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } });
    const b = txn('b1', 'bank', 1, { refs: { extracted_from_description: [PAY_A] } });
    assert.equal(resolveIdentity(g, b, config).kind, 'not_established');
  });

  test('contradicting strong anchors are discarded, not scored', () => {
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_B } });
    const v = resolveIdentity(g, b, config);
    assert.equal(v.kind, 'contradicted');
    assert.ok(v.kind === 'contradicted');
    assert.match(v.reason, /different strong references are different payments/);
  });

  test('agreeing anchors with opposite directions is a REVERSAL, not an amount mismatch', () => {
    // Misfiling a refund as a money discrepancy would put a normal business event
    // into the category a controller most needs to trust.
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, direction: 'debit' });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, direction: 'credit' });
    const v = resolveIdentity(g, b, config);
    assert.equal(v.kind, 'direction_conflict');
    assert.ok(v.kind === 'direction_conflict');
    assert.match(v.reason, /refund or reversal/);
  });

  test('same-source and self pairs are never identity-resolved', () => {
    const a = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } });
    const b = txn('g2', 'gateway', 2, { refs: { payment_id: PAY_A } });
    assert.equal(resolveIdentity(a, b, config).kind, 'not_established');
    assert.equal(resolveIdentity(a, a, config).kind, 'not_established');
  });

  test('bank<->ledger never claims AMOUNT_MISMATCH, because the amounts are incomparable', () => {
    // ADR-037: a fee-net bank credit and a sale-GST ledger amount are not related
    // by arithmetic. Asserting they disagree would be a fabricated finding.
    const bank = txn('b1', 'bank', 1, { refs: { invoice_no: 'INV/2026/00123' }, amount: 970_000, date: '2026-08-16' });
    const ledger = txn('l1', 'ledger', 1, { refs: { invoice_no: 'INV/2026/00123' }, amount: 1_000_000, net: 1_000_000, date: '2026-08-14' });
    const v = resolveIdentity(bank, ledger, config);
    assert.ok(v.kind === 'established');
    assert.equal(v.amount.unavailable, true);
    assert.notEqual(v.category, 'AMOUNT_MISMATCH');
    assert.equal(v.outcome, 'match');
  });

  test('anchor selection is deterministic when two anchors are shared', () => {
    const refs = { payment_id: PAY_A, rrn: '234567890123' };
    const g = txn('g1', 'gateway', 1, { refs });
    const b = txn('b1', 'bank', 1, { refs });
    const v = resolveIdentity(g, b, config);
    assert.ok(v.kind === 'established');
    assert.equal(v.anchorKey, 'payment_id', 'declaration order decides, not object key order');
  });

  test('argument order does not change the verdict', () => {
    const g = txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000 });
    const b = txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, amount: 141_200 });
    const forward = resolveIdentity(g, b, config);
    const backward = resolveIdentity(b, g, config);
    assert.ok(forward.kind === 'established' && backward.kind === 'established');
    assert.equal(forward.outcome, backward.outcome);
    assert.equal(forward.amountAtRiskPaise, backward.amountAtRiskPaise);
  });
});

describe('S8 driver over a population', () => {
  test('resolves every cross-source anchor pair, once each, deterministically', () => {
    const pool = [
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000 }),
      txn('b1', 'bank', 1, { refs: { payment_id: PAY_A }, amount: 141_200 }),
      txn('l1', 'ledger', 1, { refs: { payment_id: PAY_A }, amount: 100_000, net: 100_000 }),
      txn('g9', 'gateway', 9, { refs: { payment_id: PAY_B }, amount: 5_000, net: 5_000 }),
    ];
    const results = resolveIdentities(pool, config);
    const keys = results.map((r) => `${r.pair[0].id}~${r.pair[1].id}:${r.verdict.kind}`);
    // g1~b1, g1~l1, b1~l1 — each once. g9 has no cross-source partner.
    assert.equal(keys.length, 3, `expected three pairs, got ${keys.join(', ')}`);
    assert.equal(new Set(keys).size, 3, 'no pair emitted twice');
    const reversed = resolveIdentities([...pool].reverse(), config)
      .map((r) => `${r.pair[0].id}~${r.pair[1].id}:${r.verdict.kind}`);
    assert.deepEqual(reversed, keys, 'population order must not change the output');
  });

  test('excluded rows never take part', () => {
    const pool = [
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A }, status: 'excluded_failed' }),
      txn('b1', 'bank', 1, { refs: { payment_id: PAY_A } }),
    ];
    assert.deepEqual(resolveIdentities(pool, config), []);
  });
});
