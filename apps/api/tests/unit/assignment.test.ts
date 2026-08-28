import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import type { NormalizedTransaction, RunConfig, ScoreBreakdown } from '../../src/types/engine.js';
import type { SourceSystem } from '../../src/types/domain.js';
import {
  assign, findAmbiguities, comparePairs, type CandidatePair,
} from '../../src/services/matching/assignment.js';

const config: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-31', aliasCountAtStart: 0 };

function txn(id: string, sourceSystem: SourceSystem, row: number): NormalizedTransaction {
  return {
    id, runId: 'r', sourceSystem, sourceFile: 'f.csv', sourceRowNumber: row,
    externalId: id, referenceIds: {}, anchorStrength: 'weak',
    amountPaise: 100_000, feePaise: null, taxPaise: null, netAmountPaise: 100_000,
    currency: 'INR', direction: 'credit',
    txnDate: '2026-08-14', txnTimestamp: null, postingDate: null,
    counterpartyRaw: null, counterpartyNorm: null, counterpartyKey: null,
    method: 'card', statusRaw: 'captured', statusNorm: 'reconcilable', txnType: null,
    descriptionRaw: null, duplicateOfTransactionId: null, duplicateKind: null,
    ingestWarnings: [], rawPayload: {},
  };
}

const breakdown: ScoreBreakdown = {
  anchor: 0.2, amount: 0.35, date: 0.2, counterparty: 0.1, total: 0.85, amountUnavailable: false,
};

function pair(a: NormalizedTransaction, b: NormalizedTransaction, score: number): CandidatePair {
  return {
    a, b, score, breakdown: { ...breakdown, total: score }, ruleId: 'FUZZY_WEAK_ANCHOR_V1',
    amount: {
      deltaPaise: 0, tolerancePaise: 100, within: true,
      basis: 'gateway_net_vs_bank_credit', unavailable: false, inferred: false,
    },
    date: { deltaDays: 0, window: [-1, 3], within: true },
  };
}

describe('global assignment beats per-record greedy', () => {
  test('the strongest claim wins the contested counterpart, whatever the input order', () => {
    // The documented failure: gateway A scores 0.88 against bank X, gateway B
    // scores 0.95 against the same X. Per-record greedy processing A first hands
    // X to the weaker claim.
    const gA = txn('gA', 'gateway', 1);
    const gB = txn('gB', 'gateway', 2);
    const bX = txn('bX', 'bank', 1);

    const weakFirst = assign([pair(gA, bX, 0.88), pair(gB, bX, 0.95)], config);
    const strongFirst = assign([pair(gB, bX, 0.95), pair(gA, bX, 0.88)], config);

    for (const [label, result] of [['weak-first', weakFirst], ['strong-first', strongFirst]] as const) {
      assert.equal(result.accepted.length, 1, label);
      assert.equal(result.accepted[0]!.score, 0.95, `${label}: strongest evidence must win`);
      assert.equal(result.displaced.length, 1, label);
      assert.match(result.displaced[0]!.rejectedBecause, /stronger candidate \(score 0\.9500\)/);
    }
  });

  test('input order never changes the outcome, across many shuffles', () => {
    const pairs = [
      pair(txn('g1', 'gateway', 1), txn('b1', 'bank', 1), 0.91),
      pair(txn('g1', 'gateway', 1), txn('b2', 'bank', 2), 0.72),
      pair(txn('g2', 'gateway', 2), txn('b1', 'bank', 1), 0.88),
      pair(txn('g2', 'gateway', 2), txn('b2', 'bank', 2), 0.80),
      pair(txn('g3', 'gateway', 3), txn('b3', 'bank', 3), 0.99),
    ];
    const fingerprint = (cs: CandidatePair[]): string =>
      assign(cs, config).accepted
        .map((p) => `${p.a.id}~${p.b.id}@${p.score}`).sort().join('|');

    const expected = fingerprint(pairs);
    // Deterministic shuffles: no Math.random in a test that asserts determinism.
    for (let seed = 1; seed <= 40; seed += 1) {
      const shuffled = [...pairs].sort((x, y) =>
        ((x.score * seed * 7919) % 1) - ((y.score * seed * 6271) % 1));
      assert.equal(fingerprint(shuffled), expected, `order leaked at seed ${seed}`);
    }
  });

  test('a PERFECT TIE between rivals for one slot is maximally ambiguous, not a tie-break', () => {
    // Worth stating, because it is the one case where the canonical tie-break
    // must NOT decide the outcome. Two candidates at identical scores are the
    // least distinguishable evidence possible; breaking that tie by file position
    // would be picking a winner by row number, which is exactly the "confident
    // wrong match" the guard exists to prevent (ADR-010).
    const bX = txn('bX', 'bank', 1);
    const r = assign([
      pair(txn('gA', 'gateway', 1), bX, 0.90),
      pair(txn('gB', 'gateway', 2), bX, 0.90),
    ], config);
    assert.equal(r.ambiguous.length, 1);
    assert.equal(r.ambiguous[0]!.delta, 0);
    assert.equal(r.accepted.length, 0);
  });

  test('ties for DIFFERENT slots are ordered canonically and all survive', () => {
    // Here the tie-break does its real job: deciding processing order, not
    // deciding a winner.
    const forward = assign([
      pair(txn('gB', 'gateway', 2), txn('bB', 'bank', 2), 0.90),
      pair(txn('gA', 'gateway', 1), txn('bA', 'bank', 1), 0.90),
    ], config);
    const backward = assign([
      pair(txn('gA', 'gateway', 1), txn('bA', 'bank', 1), 0.90),
      pair(txn('gB', 'gateway', 2), txn('bB', 'bank', 2), 0.90),
    ], config);
    for (const r of [forward, backward]) {
      assert.equal(r.accepted.length, 2);
      assert.deepEqual(r.accepted.map((p) => p.a.id), ['gA', 'gB'],
        'lower canonical position is processed first, on every run');
    }
  });

  test('comparePairs is a total order — no reliance on sort stability', () => {
    const p = pair(txn('g1', 'gateway', 1), txn('b1', 'bank', 1), 0.9);
    const q = pair(txn('g2', 'gateway', 2), txn('b1', 'bank', 1), 0.9);
    assert.ok(comparePairs(p, q) < 0);
    assert.ok(comparePairs(q, p) > 0);
    assert.equal(comparePairs(p, p), 0);
  });
});

describe('slot occupancy', () => {
  test('a record may hold one counterpart PER other source — a 3-way match is normal', () => {
    const g = txn('g1', 'gateway', 1);
    const b = txn('b1', 'bank', 1);
    const l = txn('l1', 'ledger', 1);
    const r = assign([pair(g, b, 0.95), pair(g, l, 0.93)], config);
    assert.equal(r.accepted.length, 2, 'gateway↔bank and gateway↔ledger must both survive');
    assert.equal(r.displaced.length, 0);
  });

  test('but only one counterpart within a given source', () => {
    const g = txn('g1', 'gateway', 1);
    const r = assign([
      pair(g, txn('b1', 'bank', 1), 0.95),
      pair(g, txn('b2', 'bank', 2), 0.70),
    ], config);
    assert.equal(r.accepted.length, 1);
    assert.equal(r.accepted[0]!.b.id, 'b1');
  });
});

describe('thresholds', () => {
  test('below the review threshold never enters assignment, and is counted', () => {
    const r = assign([
      pair(txn('g1', 'gateway', 1), txn('b1', 'bank', 1), 0.64),
      pair(txn('g2', 'gateway', 2), txn('b2', 'bank', 2), 0.65),
    ], config);
    assert.equal(r.belowThresholdCount, 1);
    assert.equal(r.accepted.length, 1);
    assert.equal(r.accepted[0]!.score, 0.65, 'the threshold is inclusive');
  });

  test('auto_confirmed vs pending_review at the exact boundary', () => {
    const at = assign([pair(txn('g1', 'gateway', 1), txn('b1', 'bank', 1), 0.85)], config);
    const below = assign([pair(txn('g2', 'gateway', 2), txn('b2', 'bank', 2), 0.8499)], config);
    assert.equal(at.accepted[0]!.status, 'auto_confirmed');
    assert.equal(below.accepted[0]!.status, 'pending_review');
  });
});

describe('the ambiguity guard (ADR-010)', () => {
  test('two rivals within 0.05 stop the engine from choosing', () => {
    const g = txn('g1', 'gateway', 1);
    const r = assign([
      pair(g, txn('b1', 'bank', 1), 0.88),
      pair(g, txn('b2', 'bank', 2), 0.86),
    ], config);
    assert.equal(r.ambiguous.length, 1);
    assert.equal(r.ambiguous[0]!.transactionId, 'g1');
    assert.equal(r.ambiguous[0]!.delta, 0.02);
    assert.equal(r.accepted.length, 0,
      'refusing to choose means neither rival is confirmed — that is the whole point');
  });

  test('the boundary: exactly 0.05 is ambiguous, 0.0501 is not', () => {
    const decisive = assign([
      pair(txn('g1', 'gateway', 1), txn('b1', 'bank', 1), 0.9001),
      pair(txn('g1', 'gateway', 1), txn('b2', 'bank', 2), 0.8500),
    ], config);
    assert.equal(decisive.ambiguous.length, 0);
    assert.equal(decisive.accepted.length, 1);

    const tied = assign([
      pair(txn('g2', 'gateway', 2), txn('b3', 'bank', 3), 0.9000),
      pair(txn('g2', 'gateway', 2), txn('b4', 'bank', 4), 0.8500),
    ], config);
    assert.equal(tied.ambiguous.length, 1);
  });

  test('AMBIGUITY IS PER TARGET SOURCE — a clean 3-way match is not ambiguous', () => {
    // The subtlety that would otherwise flag every clean reconciliation in the
    // dataset: a gateway record legitimately has a bank counterpart AND a ledger
    // counterpart. Those are not rivals; they are two legs of one event.
    const g = txn('g1', 'gateway', 1);
    const r = assign([
      pair(g, txn('b1', 'bank', 1), 0.90),
      pair(g, txn('l1', 'ledger', 1), 0.88),   // within 0.05, but a DIFFERENT source
    ], config);
    assert.equal(r.ambiguous.length, 0, 'bank and ledger candidates are not rivals');
    assert.equal(r.accepted.length, 2);
  });

  test('rivals below the review threshold are not rivals at all', () => {
    const g = txn('g1', 'gateway', 1);
    const r = assign([
      pair(g, txn('b1', 'bank', 1), 0.66),
      pair(g, txn('b2', 'bank', 2), 0.63),   // close, but not a candidate
    ], config);
    assert.equal(r.ambiguous.length, 0);
    assert.equal(r.accepted.length, 1);
  });

  test('the guard reads the candidate list AS SCORED, not as assigned', () => {
    // b1 is contested by a stronger gateway record, so under assignment g1 would
    // "lose" b1 and be left with only b2 — apparently decisive. The guard must
    // still fire, because the question is whether the EVIDENCE distinguished them.
    const g1 = txn('g1', 'gateway', 1);
    const g2 = txn('g2', 'gateway', 2);
    const b1 = txn('b1', 'bank', 1);
    const b2 = txn('b2', 'bank', 2);
    const r = assign([
      pair(g1, b1, 0.88),
      pair(g1, b2, 0.87),
      pair(g2, b1, 0.99),
    ], config);
    assert.equal(r.ambiguous.length, 1);
    assert.equal(r.ambiguous[0]!.transactionId, 'g1');
    // g2 still gets b1: refusing to choose must not punish a third party.
    assert.deepEqual(r.accepted.map((p) => `${p.a.id}~${p.b.id}`), ['g2~b1']);
  });

  test('an ambiguous record frees its rivals for other records', () => {
    const g1 = txn('g1', 'gateway', 1);
    const g2 = txn('g2', 'gateway', 2);
    const b1 = txn('b1', 'bank', 1);
    const r = assign([
      pair(g1, b1, 0.90),
      pair(g1, txn('b2', 'bank', 2), 0.89),
      pair(g2, b1, 0.70),
    ], config);
    assert.equal(r.ambiguous.length, 1);
    assert.deepEqual(r.accepted.map((p) => `${p.a.id}~${p.b.id}`), ['g2~b1']);
  });

  test('findAmbiguities output order is independent of input order', () => {
    const build = (order: number[]): string => {
      const all = [
        pair(txn('g1', 'gateway', 1), txn('b1', 'bank', 1), 0.90),
        pair(txn('g1', 'gateway', 1), txn('b2', 'bank', 2), 0.89),
        pair(txn('g2', 'gateway', 2), txn('b3', 'bank', 3), 0.80),
        pair(txn('g2', 'gateway', 2), txn('b4', 'bank', 4), 0.79),
      ];
      return findAmbiguities(order.map((i) => all[i]!), config)
        .map((f) => `${f.transactionId}/${f.targetSource}/${f.delta}`).join(',');
    };
    assert.equal(build([0, 1, 2, 3]), build([3, 2, 1, 0]));
    assert.equal(build([0, 1, 2, 3]), build([2, 0, 3, 1]));
  });
});

describe('rejection reasons are first-class', () => {
  test('every displaced pair carries a human-readable reason', () => {
    const g = txn('g1', 'gateway', 1);
    const r = assign([
      pair(g, txn('b1', 'bank', 1), 0.95),
      pair(g, txn('b2', 'bank', 2), 0.70),
    ], config);
    assert.equal(r.displaced.length, 1);
    const reason = r.displaced[0]!.rejectedBecause;
    assert.ok(reason.length > 0);
    assert.doesNotMatch(reason, /undefined|NaN|\[object/,
      'a reason a reviewer cannot read is not a reason');
  });

  test('an ambiguity-blocked pair says so, rather than blaming a stronger rival', () => {
    const g = txn('g1', 'gateway', 1);
    const r = assign([
      pair(g, txn('b1', 'bank', 1), 0.88),
      pair(g, txn('b2', 'bank', 2), 0.87),
    ], config);
    assert.equal(r.displaced.length, 2);
    for (const d of r.displaced) {
      assert.match(d.rejectedBecause, /did not choose/);
    }
  });
});

describe('scale and stability', () => {
  test('a few thousand candidates assign deterministically', () => {
    const candidates: CandidatePair[] = [];
    for (let i = 0; i < 600; i += 1) {
      const g = txn(`g${i}`, 'gateway', i);
      for (let k = 0; k < 3; k += 1) {
        const j = (i * 7 + k * 13) % 600;
        // Deterministic pseudo-scores, well clear of the ambiguity band.
        candidates.push(pair(g, txn(`b${j}`, 'bank', j), 0.65 + ((i * 37 + k * 11) % 34) / 100));
      }
    }
    const first = assign(candidates, config);
    const second = assign([...candidates].reverse(), config);
    assert.equal(
      first.accepted.map((p) => `${p.a.id}~${p.b.id}`).sort().join(','),
      second.accepted.map((p) => `${p.a.id}~${p.b.id}`).sort().join(','));
    assert.ok(first.accepted.length > 0);
    // Invariant: no record holds two counterparts in the same source.
    const slots = new Set<string>();
    for (const p of first.accepted) {
      for (const [x, y] of [[p.a, p.b], [p.b, p.a]] as const) {
        const key = `${x.id}::${y.sourceSystem}`;
        assert.ok(!slots.has(key), `slot ${key} assigned twice`);
        slots.add(key);
      }
    }
  });
});
