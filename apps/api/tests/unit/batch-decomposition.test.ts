import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import type { NormalizedTransaction, RunConfig } from '../../src/types/engine.js';
import type { SourceSystem } from '../../src/types/domain.js';
import {
  decomposeBatch, findSplitSettlement, buildBatchPool, contributionOf, searchSubsets,
} from '../../src/services/matching/batch-decomposition.js';
import { runBatchStage } from '../../src/services/matching/batch-stage.js';

const config: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-31', aliasCountAtStart: 0 };

function txn(
  id: string, source: SourceSystem, row: number,
  o: { amount?: number; net?: number | null; date?: string; cp?: string | null;
       direction?: 'credit' | 'debit'; method?: 'card' | 'upi';
       refs?: NormalizedTransaction['referenceIds'] } = {},
): NormalizedTransaction {
  return {
    id, runId: 'r', sourceSystem: source, sourceFile: `${source}.csv`, sourceRowNumber: row,
    externalId: id, referenceIds: o.refs ?? {}, anchorStrength: 'none',
    amountPaise: o.amount ?? 100_000, feePaise: null, taxPaise: null,
    netAmountPaise: o.net === undefined ? (o.amount ?? 100_000) : o.net,
    currency: 'INR', direction: o.direction ?? 'credit',
    txnDate: o.date ?? '2026-08-14', txnTimestamp: null, postingDate: null,
    counterpartyRaw: null, counterpartyNorm: o.cp === undefined ? 'ACME' : o.cp,
    counterpartyKey: null, method: o.method ?? 'card', statusRaw: 'captured',
    statusNorm: 'reconcilable', txnType: null, descriptionRaw: null,
    duplicateOfTransactionId: null, duplicateKind: null, ingestWarnings: [], rawPayload: {},
  };
}

const gw = (id: string, row: number, net: number, date = '2026-08-14') =>
  txn(id, 'gateway', row, { amount: net, net, date });

describe('S10 — the two failure claims are genuinely different (ADR-038)', () => {
  test('EXHAUSTED: the whole bounded space was searched and nothing sums', () => {
    const credit = txn('c', 'bank', 1, { amount: 999_999, date: '2026-08-16' });
    const pool = [gw('g1', 1, 10_000), gw('g2', 2, 20_000), gw('g3', 3, 30_000)];
    const r = decomposeBatch(credit, pool, config);
    assert.equal(r.kind, 'unsplittable');
    assert.equal(r.stats.exhaustive, true, 'this is a PROOF, not a timeout');
    assert.equal(r.stats.boundHit, null);
    assert.match(r.reason, /no decomposition of that shape exists in the available data/);
  });

  test('BOUND EXCEEDED: the pool cap truncated the candidates', () => {
    // 30 candidates against a cap of 24: whatever the search concludes, it did
    // not look at everything, and must not claim it did.
    const credit = txn('c', 'bank', 1, { amount: 999_999_999, date: '2026-08-16' });
    const pool = Array.from({ length: 30 }, (_, i) => gw(`g${i}`, i, 1_000 + i));
    const r = decomposeBatch(credit, pool, config);
    assert.equal(r.kind, 'unsplittable');
    assert.equal(r.stats.exhaustive, false);
    assert.equal(r.stats.boundHit?.bound, 'pool');
    assert.equal(r.stats.poolSize, config.batchPoolCap);
    assert.match(r.reason, /may exist but was not proved/);
  });

  test('the two outcomes never share wording', () => {
    // A UI or a reader must be able to tell them apart without reading a flag.
    const exhausted = decomposeBatch(
      txn('c', 'bank', 1, { amount: 999_999, date: '2026-08-16' }),
      [gw('g1', 1, 10_000)], config);
    const bounded = decomposeBatch(
      txn('c', 'bank', 1, { amount: 999_999_999, date: '2026-08-16' }),
      Array.from({ length: 30 }, (_, i) => gw(`g${i}`, i, 1_000 + i)), config);
    assert.notEqual(exhausted.reason, bounded.reason);
    assert.match(exhausted.reason, /none sums\s+to this credit/);
    assert.doesNotMatch(exhausted.reason, /may exist/);
  });

  test('the node budget is the primary bound and is deterministic (ADR-060)', () => {
    // A genuinely large space with no solution: amounts all end in 00, the target
    // ends in 50, tolerance 0 — so the search explores rather than pruning at the
    // root, and finds nothing. A tiny budget then truncates it.
    const credit = txn('c', 'bank', 1, { amount: 1_250_050, date: '2026-08-16' });
    const pool = Array.from({ length: 24 }, (_, i) => gw(`g${i}`, i, 100_000 + i * 100));
    const tiny = { ...config, batchNodeBudget: 5_000, amountToleranceFloorPaise: 0,
      amountToleranceCapPaise: 0, amountTolerancePct: 0 };

    const first = decomposeBatch(credit, pool, tiny);
    assert.equal(first.kind, 'unsplittable');
    assert.equal(first.stats.exhaustive, false);
    assert.equal(first.stats.boundHit?.bound, 'nodes');

    // The point of a node budget over a wall clock: the SAME input gives the SAME
    // verdict and the SAME node count every time. A time bound would make
    // exhaustiveness a property of the machine.
    for (let i = 0; i < 20; i += 1) {
      const again = decomposeBatch(credit, pool, tiny);
      assert.equal(again.kind, first.kind);
      assert.equal(again.stats.nodesVisited, first.stats.nodesVisited,
        'node counts must be identical run to run');
      assert.deepEqual(again.stats.boundHit, first.stats.boundHit);
    }
  });

  test('a large space with no solution is PROVED, not truncated, at the real budget', () => {
    // The same case at the shipped budget: the whole declared space is searched.
    // If this ever starts reporting a bound, the budget is too small or the
    // pruning has regressed — both are bugs, not tuning opportunities.
    const zeroTol = { ...config, amountToleranceFloorPaise: 0, amountToleranceCapPaise: 0,
      amountTolerancePct: 0 };
    const r = decomposeBatch(
      txn('c', 'bank', 1, { amount: 1_250_050, date: '2026-08-16' }),
      Array.from({ length: 24 }, (_, i) => gw(`g${i}`, i, 100_000 + i * 100)), zeroTol);
    assert.equal(r.kind, 'unsplittable');
    assert.equal(r.stats.exhaustive, true, 'this is a proof about the data');
    assert.equal(r.stats.boundHit, null);
    assert.ok(r.stats.nodesVisited < zeroTol.batchNodeBudget);
  });

  test('the node budget dominates the true combinatorial ceiling the caps permit (issue #1)', () => {
    // Sum C(24,k) for k=0..8 = 1,271,626 — the real worst case, not the ~200k
    // figure the docs used to assert. 24 equal-amount contributions with a
    // target that no subset of them can reach means almost nothing prunes, so
    // the search visits close to the full declared space.
    const zeroTol = { ...config, amountToleranceFloorPaise: 0, amountToleranceCapPaise: 0,
      amountTolerancePct: 0 };
    const r = decomposeBatch(
      txn('c', 'bank', 1, { amount: 8_000_001, date: '2026-08-16' }),
      Array.from({ length: 24 }, (_, i) => gw(`g${i}`, i, 1_000_000)), zeroTol);
    assert.equal(r.kind, 'unsplittable');
    assert.equal(r.stats.exhaustive, true,
      `budget must dominate the declared space; got boundHit=${JSON.stringify(r.stats.boundHit)}`);
    assert.equal(r.stats.boundHit, null);
  });
});

describe('S10 — declared limits vs truncating limits (ADR-060)', () => {
  const zeroTol = { ...config, amountToleranceFloorPaise: 0, amountToleranceCapPaise: 0,
    amountTolerancePct: 0 };

  test('reaching the subset-size cap does NOT defeat exhaustiveness', () => {
    // The size cap is part of the QUESTION — announced up front, identical for
    // every batch, and named in the reason string. Searching all of it is a
    // complete answer to the question actually asked. Treating it as a truncation
    // would make `exhaustive` almost unreachable on any pool of eight or more,
    // and an honesty flag that is never true tells a reader nothing.
    const r = decomposeBatch(
      txn('c', 'bank', 1, { amount: 1_250_050, date: '2026-08-16' }),
      Array.from({ length: 24 }, (_, i) => gw(`g${i}`, i, 100_000 + i * 100)), zeroTol);
    assert.equal(r.stats.subsetSizeCapReached, true, 'depth 8 was reached');
    assert.equal(r.stats.exhaustive, true, 'yet the declared space was fully searched');
    assert.equal(r.stats.boundHit, null);
  });

  test('the reason string always names the cap, so the claim is never wider than the search', () => {
    const r = decomposeBatch(
      txn('c', 'bank', 1, { amount: 1_250_050, date: '2026-08-16' }),
      Array.from({ length: 24 }, (_, i) => gw(`g${i}`, i, 100_000 + i * 100)), zeroTol);
    assert.match(r.reason, new RegExp(`up to ${config.batchMaxSubsetSize} of the 24`));
    assert.match(r.reason, /no decomposition of that shape exists/);
  });

  test('a truncated pool DOES defeat it, because eligible candidates were discarded', () => {
    const r = decomposeBatch(
      txn('c', 'bank', 1, { amount: 999_999_999, date: '2026-08-16' }),
      Array.from({ length: 30 }, (_, i) => gw(`g${i}`, i, 1_000 + i)), config);
    assert.equal(r.stats.exhaustive, false);
    assert.equal(r.stats.boundHit?.bound, 'pool');
  });
});

describe('S10 — decomposition outcomes', () => {
  test('exactly one subset yields a decomposition, PROPOSED not confirmed', () => {
    const members = [gw('g1', 1, 30_000), gw('g2', 2, 20_000), gw('g3', 3, 10_000)];
    const credit = txn('c', 'bank', 1, { amount: 60_000, date: '2026-08-16' });
    const r = decomposeBatch(credit, [...members, gw('g9', 9, 777)], config);
    assert.equal(r.kind, 'decomposed');
    assert.ok(r.kind === 'decomposed');
    assert.deepEqual(r.members.map((m) => m.id), ['g1', 'g2', 'g3']);
    assert.match(r.reason, /proposed for review rather than confirmed/);
  });

  test('two distinct subsets yield AMBIGUOUS, because arithmetic cannot choose', () => {
    // 60,000 = 40k+20k = 35k+25k. Both are equally valid; picking one would be
    // exactly the confident wrong match the engine exists to refuse.
    const credit = txn('c', 'bank', 1, { amount: 60_000, date: '2026-08-16' });
    const pool = [gw('g1', 1, 40_000), gw('g2', 2, 20_000), gw('g3', 3, 35_000), gw('g4', 4, 25_000)];
    const r = decomposeBatch(credit, pool, config);
    assert.equal(r.kind, 'ambiguous');
    assert.ok(r.kind === 'ambiguous');
    assert.ok(r.subsets.length >= 2);
    assert.match(r.reason, /arithmetic cannot choose/);
  });

  test('an inferred fee band widens what can match, and is used as an interval', () => {
    const g = txn('g1', 'gateway', 1, { amount: 1_000_000, net: null });
    const c = contributionOf(g, config);
    assert.equal(c.inferred, true);
    assert.ok(c.minPaise < c.maxPaise, 'a blank fee is a band, not a point');
    assert.equal(c.minPaise, 970_500);
    assert.equal(c.maxPaise, 976_400);

    // A credit anywhere inside the SUMMED band decomposes to those payments.
    // Two payments, not one: a size-1 subset is an ordinary 1:1 match and no
    // longer a batch verdict (see the test below).
    const g2 = txn('g2', 'gateway', 2, { amount: 1_000_000, net: null });
    const credit = txn('c', 'bank', 1, { amount: 1_946_000, date: '2026-08-16' });
    const r = decomposeBatch(credit, [g, g2], config);
    assert.equal(r.kind, 'decomposed');
    assert.equal(r.kind === 'decomposed' ? r.members.length : 0, 2);
  });

  test('a size-1 subset is NOT a batch verdict — that is a 1:1 match, and S9 owns it', () => {
    // `searchSubsetsInBand`'s own docstring gives the reason for the split
    // search: "a size-1 solution is an ordinary 1:1 match that belongs to the
    // tiers, not to this stage." §8 is explicitly about a credit that nets MANY
    // payments. The batch path did not apply it until S10 was wired (#46), and
    // the consequence was S10 re-deciding pairs Tier 2 had already scored and
    // declined — on strictly weaker evidence, since the batch pool requires no
    // anchor at all.
    const g = txn('g1', 'gateway', 1, { amount: 1_000_000, net: 973_000 });
    const credit = txn('c', 'bank', 1, { amount: 973_000, date: '2026-08-16' });
    const alone = decomposeBatch(credit, [g], config);
    assert.equal(alone.kind, 'unsplittable',
      'one payment that exactly equals the credit is a 1:1 match, not a decomposition');

    // The same payment IS reported once it is genuinely part of a combination.
    const g2 = txn('g2', 'gateway', 2, { amount: 500_000, net: 400_000 });
    const bigger = txn('c2', 'bank', 2, { amount: 1_373_000, date: '2026-08-16' });
    const together = decomposeBatch(bigger, [g, g2], config);
    assert.equal(together.kind, 'decomposed');
    assert.equal(together.kind === 'decomposed' ? together.members.length : 0, 2);
  });

  test('the subset-size cap is recorded as a qualifier, never silently applied', () => {
    const capped = { ...config, batchMaxSubsetSize: 2 };
    const credit = txn('c', 'bank', 1, { amount: 60_000, date: '2026-08-16' });
    const pool = [gw('g1', 1, 20_000), gw('g2', 2, 20_000), gw('g3', 3, 20_000)];
    const r = decomposeBatch(credit, pool, capped);
    assert.equal(r.kind, 'unsplittable');
    assert.equal(r.stats.subsetSizeCapReached, true);
    assert.equal(r.stats.boundHit, null, 'a declared limit is not a truncation');
    assert.match(r.reason, /up to 2 of the 3/);
  });
});

describe('S10 — pool construction', () => {
  test('only unmatched gateway credits inside the four-day window', () => {
    const credit = txn('c', 'bank', 1, { date: '2026-08-16' });
    const { pool } = buildBatchPool(credit, [
      gw('inWindow', 1, 100, '2026-08-13'),
      gw('tooOld', 2, 100, '2026-08-11'),
      gw('after', 3, 100, '2026-08-17'),
      txn('debit', 'gateway', 4, { direction: 'debit', date: '2026-08-15' }),
      txn('notGateway', 'ledger', 5, { date: '2026-08-15' }),
    ], config);
    assert.deepEqual(pool.map((p) => p.id), ['inWindow']);
  });

  test('a differing counterparty excludes, but a MISSING one does not', () => {
    // Absence of a name is an absence of evidence, not evidence of a different
    // merchant — excluding on it would shrink the pool for the wrong reason.
    const credit = txn('c', 'bank', 1, { date: '2026-08-16', cp: 'ACME' });
    const { pool } = buildBatchPool(credit, [
      gw('same', 1, 100, '2026-08-15'),
      txn('other', 'gateway', 2, { cp: 'ZENITH', date: '2026-08-15' }),
      txn('unnamed', 'gateway', 3, { cp: null, date: '2026-08-15' }),
    ], config);
    assert.deepEqual(pool.map((p) => p.id).sort(), ['same', 'unnamed']);
  });

  test('the cap keeps the nearest by date, then the largest amounts', () => {
    const credit = txn('c', 'bank', 1, { date: '2026-08-16' });
    const many = [
      gw('far', 1, 900_000, '2026-08-12'),
      ...Array.from({ length: 30 }, (_, i) => gw(`near${i}`, i + 2, 1_000 + i, '2026-08-16')),
    ];
    const { pool, capped } = buildBatchPool(credit, many, config);
    assert.equal(capped, true);
    assert.equal(pool.length, 24);
    assert.ok(!pool.some((p) => p.id === 'far'), 'the distant payment is dropped first');
  });
});

describe('S10 — determinism', () => {
  test('candidate order does not change the verdict', () => {
    const credit = txn('c', 'bank', 1, { amount: 60_000, date: '2026-08-16' });
    const pool = [gw('g1', 1, 30_000), gw('g2', 2, 20_000), gw('g3', 3, 10_000), gw('g4', 4, 7_000)];
    const fingerprint = (rows: NormalizedTransaction[]): string => {
      const r = decomposeBatch(credit, rows, config);
      const ids = r.kind === 'decomposed' ? r.members.map((m) => m.id).join('+') : '';
      return `${r.kind}|${ids}|${r.stats.exhaustive}|${r.stats.nodesVisited}`;
    };
    const expected = fingerprint(pool);
    assert.equal(fingerprint([...pool].reverse()), expected);
    assert.equal(fingerprint([pool[2]!, pool[0]!, pool[3]!, pool[1]!]), expected);
  });

  test('a realistic pool completes far inside the node budget', () => {
    // If pruning were ineffective this would exhaust the 1.3M-node budget and
    // report a bound — which ADR-060 says would mean the pruning is broken,
    // not the budget.
    const credit = txn('c', 'bank', 1, { amount: 1_234_567, date: '2026-08-16' });
    const pool = Array.from({ length: 24 }, (_, i) => gw(`g${i}`, i, 50_000 + i * 977));
    const r = decomposeBatch(credit, pool, config);
    assert.ok(r.stats.nodesVisited < config.batchNodeBudget,
      `pruning ineffective: visited ${r.stats.nodesVisited} nodes`);
    assert.notEqual(r.stats.boundHit?.bound, 'time', 'the safety valve must not be doing the work');
  });

  test('searchSubsets reports exhaustive only when it truly visited everything', () => {
    const contributions = [gw('a', 1, 10), gw('b', 2, 20)].map((g) => contributionOf(g, config));
    const full = searchSubsets(contributions, 999_999, 0, config, false);
    assert.equal(full.stats.exhaustive, true);
    assert.equal(full.stats.boundHit, null);
    const truncated = searchSubsets(contributions, 999_999, 0, config, true);
    assert.equal(truncated.stats.exhaustive, false, 'a capped pool is never exhaustive');
    assert.equal(truncated.stats.boundHit?.bound, 'pool');
  });
});

describe('S10.1 — split settlements (the mirror case)', () => {
  test('two bank credits summing to one payment are a split settlement', () => {
    const g = txn('g1', 'gateway', 1, { amount: 100_000, net: 100_000, date: '2026-08-14' });
    const r = findSplitSettlement(g, [
      txn('b1', 'bank', 1, { amount: 60_000, date: '2026-08-15' }),
      txn('b2', 'bank', 2, { amount: 40_000, date: '2026-08-16' }),
    ], config);
    assert.equal(r.kind, 'split');
    assert.ok(r.kind === 'split');
    assert.deepEqual(r.legs.map((l) => l.id), ['b1', 'b2']);
    assert.equal(r.ruleId, 'SPLIT_SETTLEMENT_V1');
    assert.match(r.reason, /proposed for review/);
  });

  test('a single leg is an ordinary 1:1 match, not a split', () => {
    const g = txn('g1', 'gateway', 1, { amount: 100_000, net: 100_000 });
    const r = findSplitSettlement(g, [txn('b1', 'bank', 1, { amount: 100_000, date: '2026-08-15' })], config);
    assert.equal(r.kind, 'none', 'the tiers own 1:1; this stage owns split shapes');
  });

  test('the subset-size cap is a search cap, not an eligible-pool ceiling (issue #4)', () => {
    // 5 eligible candidates — over the size-4 cap — but only 4 of them (b0-b3)
    // actually sum to the expected net; b4 is a same-window distractor that
    // does not belong to the split. A pool-size ceiling would give up outright
    // ("legs.length > 4 -> none"); a genuine subset search finds the real
    // 4-of-5 combination and ignores the distractor.
    const g = txn('g1', 'gateway', 1, { amount: 100_000, net: 100_000, date: '2026-08-14' });
    const legs = [
      ...Array.from({ length: 4 }, (_, i) => txn(`b${i}`, 'bank', i, { amount: 25_000, date: '2026-08-15' })),
      txn('b4', 'bank', 4, { amount: 999_00, date: '2026-08-15' }),
    ];
    const r = findSplitSettlement(g, legs, config);
    assert.equal(r.kind, 'split');
    assert.ok(r.kind === 'split');
    assert.deepEqual(r.legs.map((l) => l.id).sort(), ['b0', 'b1', 'b2', 'b3']);
  });

  test('more than four legs with no ≤4 combination summing to the target is not a split', () => {
    const g = txn('g1', 'gateway', 1, { amount: 100_000, net: 100_000 });
    const legs = Array.from({ length: 5 }, (_, i) =>
      txn(`b${i}`, 'bank', i, { amount: 20_000, date: '2026-08-15' }));
    // All 5 sum to the target, but no subset of ≤4 of them does — the cap is
    // genuinely enforced by the search, not sidestepped.
    assert.equal(findSplitSettlement(g, legs, config).kind, 'none');
  });

  test('a bank credit sharing a strong anchor is a candidate leg even outside the window', () => {
    const g = txn('g1', 'gateway', 1, {
      amount: 100_000, net: 100_000, date: '2026-08-14', refs: { payment_id: 'pay_shared_1' },
    });
    const near = txn('b1', 'bank', 1, { amount: 60_000, date: '2026-08-15' });
    const far = txn('b2', 'bank', 2, {
      amount: 40_000, date: '2026-09-20', refs: { payment_id: 'pay_shared_1' },
    });
    const r = findSplitSettlement(g, [near, far], config);
    assert.equal(r.kind, 'split');
    assert.ok(r.kind === 'split');
    assert.deepEqual(r.legs.map((l) => l.id).sort(), ['b1', 'b2']);
  });

  test('legs outside the settlement window are not legs', () => {
    const g = txn('g1', 'gateway', 1, { amount: 100_000, net: 100_000, date: '2026-08-14' });
    const r = findSplitSettlement(g, [
      txn('b1', 'bank', 1, { amount: 60_000, date: '2026-08-15' }),
      txn('b2', 'bank', 2, { amount: 40_000, date: '2026-08-30' }),
    ], config);
    assert.equal(r.kind, 'none');
  });

  test('a sum outside tolerance is not a split', () => {
    const g = txn('g1', 'gateway', 1, { amount: 100_000, net: 100_000 });
    const r = findSplitSettlement(g, [
      txn('b1', 'bank', 1, { amount: 60_000, date: '2026-08-15' }),
      txn('b2', 'bank', 2, { amount: 20_000, date: '2026-08-15' }),
    ], config);
    assert.equal(r.kind, 'none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #51 / ADR-079 — identity inside the split rule, and a role that is OPEN rather
// than merely EMPTY. Both halves are needed: either one alone leaves the two
// holdout splits partially assembled.
// ─────────────────────────────────────────────────────────────────────────────

describe('S10.1 — identity before arithmetic (#51, ADR-079)', () => {
  // The exact shape of holdout evt_000262: four legs, each carrying the
  // gateway's own reference, summing EXACTLY to its expected net — and a 2-paise
  // leg whose presence or absence both land inside the tolerance band.
  const SETL = 'setl_X6oDB8pVLveGk2';
  const RRN = '579481974116';
  const gateway = txn('g1', 'gateway', 1, {
    amount: 19_900, net: 19_386, date: '2026-07-30',
    refs: { payment_id: 'pay_pnREpHhavyd0Jf', rrn: RRN, settlement_id: SETL },
  });
  const leg = (id: string, row: number, amount: number) => txn(id, 'bank', row, {
    amount, date: '2026-07-31',
    refs: { bank_ref_no: RRN, extracted_from_description: [RRN, SETL] },
  });
  const legs = [leg('b1', 1, 4_076), leg('b2', 2, 5_485), leg('b3', 3, 9_823), leg('b4', 4, 2)];

  test('legs carrying the payment\'s own reference are the split, ambiguity notwithstanding', () => {
    // 4076+5485+9823+2 = 19386 exactly; 4076+5485+9823 = 19384 is ALSO inside the
    // +/-100 band. Arithmetic alone cannot choose, and before this it did not
    // try to — it returned `none` and three true legs became exceptions. The
    // reference numbers already named the members; the sum only has to check them.
    const r = findSplitSettlement(gateway, legs, config);
    assert.equal(r.kind, 'split');
    assert.ok(r.kind === 'split');
    assert.deepEqual(r.legs.map((l) => l.id), ['b1', 'b2', 'b3', 'b4']);
    assert.match(r.reason, /established by the shared reference/);
  });

  test('the arithmetic proof is NOT waived — anchored legs that do not sum are refused', () => {
    // The half that makes this safe. Shared references admit and ORDER the
    // evidence; they never excuse it. Drop a leg from the pool and the anchored
    // set no longer reaches the band, so the identity path declines.
    const short = [legs[0]!, legs[1]!];   // 9,561 against an expected net of 19,386
    const r = findSplitSettlement(gateway, short, config);
    assert.equal(r.kind, 'none');
  });

  test('window-admitted legs with no shared reference still face the subset search', () => {
    // Nothing about the old path changed for legs that carry no reference: the
    // ambiguity that identity resolves above is still fatal without it.
    const bare = (id: string, row: number, amount: number) =>
      txn(id, 'bank', row, { amount, date: '2026-07-31' });
    const r = findSplitSettlement(gateway, [
      bare('b1', 1, 4_076), bare('b2', 2, 5_485), bare('b3', 3, 9_823), bare('b4', 4, 2),
    ], config);
    assert.equal(r.kind, 'none', 'without references, two subsets in band is still undecidable');
  });

  test('a gateway whose bank role is PARTLY filled still gets its remaining legs', () => {
    // The regression this issue is named for. `b1` is already paired by S9, so
    // `!hasCounterpartIn(gateway, 'bank')` used to remove this payment from the
    // split pass entirely and b2/b3/b4 were never searched for.
    const pool = [gateway, ...legs];
    const r = runBatchStage(pool, [{ a: gateway, b: legs[0]! }], config);
    assert.equal(r.splits.length, 1, 'the split must still be found');
    assert.deepEqual(r.splits[0]!.legs.map((l) => l.id), ['b1', 'b2', 'b3', 'b4']);

    // EVERY leg is emitted, including the one S9 found, and that tier pair is
    // named as superseded. Rule 3 admits several members of one role only
    // through pairs that DECLARE the exception, so leaving the fuzzy pair beside
    // three declaring ones gets its leg refused out of the group.
    assert.deepEqual(r.splitPairs.map((p) => p.b.id), ['b1', 'b2', 'b3', 'b4']);
    assert.ok(r.splitPairs.every((p) => p.mayDuplicateRole === 'bank'));
    assert.deepEqual(r.supersededTierPairs, [{ aId: 'g1', bId: 'b1' }]);
  });

  test('a bank role already CLOSED by a 1:1 match is not reopened', () => {
    // The guard on the gate. An ordinary gateway<->bank match whose leg accounts
    // for the payment is complete, and this pass must not go looking for more —
    // otherwise every 1:1 in the run becomes a split candidate.
    const solo = txn('g2', 'gateway', 2, { amount: 19_900, net: 19_386, date: '2026-07-30' });
    const whole = txn('b9', 'bank', 9, { amount: 19_386, date: '2026-07-31' });
    const distractor = txn('b8', 'bank', 8, { amount: 5_000, date: '2026-07-31' });
    const r = runBatchStage([solo, whole, distractor], [{ a: solo, b: whole }], config);
    assert.deepEqual(r.splits, []);
    assert.deepEqual(r.splitPairs, []);
    assert.deepEqual(r.supersededTierPairs, []);
  });

  test('a solution that routes AROUND a leg S9 matched is refused, not preferred', () => {
    // S10 may extend the engine's output, never contradict it (ADR-076 point 3).
    // Here b9 is matched by S9 but is not in the anchored set, and the anchored
    // set sums on its own — accepting it would be S10 quietly dropping S9's leg.
    const stray = txn('b9', 'bank', 9, { amount: 7_000, date: '2026-07-31' });
    const r = runBatchStage([gateway, ...legs, stray], [{ a: gateway, b: stray }], config);
    assert.deepEqual(r.splits, [], 'a split that excludes an already-matched leg is not this payment\'s');
  });
});
