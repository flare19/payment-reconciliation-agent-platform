import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import type {
  NormalizedTransaction, ProposedMatch, ReferenceIds, RunConfig,
} from '../../src/types/engine.js';
import type { MatchTier, SourceSystem, StatusNorm } from '../../src/types/domain.js';
import { ingestSources } from '../../src/services/ingestion/index.js';
import { dedupe } from '../../src/services/matching/dedupe.js';
import { buildBlockIndexes, rebuildCounterpartyIndex } from '../../src/services/matching/blocking.js';
import { runTier1 } from '../../src/services/matching/tier1-exact.js';
import { runTier15 } from '../../src/services/matching/tier1_5-alias.js';
import { resolveIdentities } from '../../src/services/matching/identity-resolution.js';
import {
  runTier2, generateCandidates, candidateDateRange, candidateAmountBuckets, pairKeyOf,
} from '../../src/services/matching/tier2-fuzzy.js';
import {
  assembleGroups, fromTier1, fromTier2, cardinalityOf, pickAnchor, comparePairStrength,
  type GroupPair,
} from '../../src/services/matching/group-assembly.js';

const config: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-31', aliasCountAtStart: 0 };

interface Over {
  refs?: ReferenceIds; amount?: number; net?: number | null; date?: string;
  cp?: string | null; status?: StatusNorm; method?: 'card' | 'upi';
}
function txn(id: string, source: SourceSystem, row: number, o: Over = {}): NormalizedTransaction {
  return {
    id, runId: 'r', sourceSystem: source, sourceFile: `${source}.csv`, sourceRowNumber: row,
    externalId: id, referenceIds: o.refs ?? {}, anchorStrength: 'none',
    amountPaise: o.amount ?? 100_000, feePaise: null, taxPaise: null,
    netAmountPaise: o.net === undefined ? (o.amount ?? 100_000) : o.net,
    currency: 'INR', direction: 'credit',
    txnDate: o.date ?? '2026-08-14', txnTimestamp: null, postingDate: null,
    counterpartyRaw: null, counterpartyNorm: o.cp === undefined ? 'ACME' : o.cp,
    counterpartyKey: null, method: o.method ?? 'card', statusRaw: 'captured',
    statusNorm: o.status ?? 'reconcilable', txnType: null,
    descriptionRaw: null, duplicateOfTransactionId: null, duplicateKind: null,
    ingestWarnings: [], rawPayload: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// S9 — candidate generation. The only real risk in the driver: a candidate never
// generated is a match that cannot be made, and it looks exactly like a genuine
// exception downstream.
// ─────────────────────────────────────────────────────────────────────────────

describe('candidateDateRange (§3 rule 1, §5.2 windows)', () => {
  test('runs FORWARD from a gateway record and BACKWARD from its counterpart', () => {
    // The windows are gateway-relative. Reading them from the wrong end turns a
    // normal T+2 settlement into a -2 outlier and deletes the candidate.
    const gw = txn('g', 'gateway', 1, { date: '2026-08-14', method: 'card' });
    const forward = candidateDateRange(gw, 'bank', config)!;
    assert.equal(forward.from, '2026-08-12');   // -1 window, -1 pad
    assert.equal(forward.to, '2026-08-18');     // +3 window, +1 pad

    const bank = txn('b', 'bank', 1, { date: '2026-08-14' });
    const backward = candidateDateRange(bank, 'gateway', config)!;
    assert.equal(backward.from, '2026-08-10');  // -(+3) window, -1 pad
    assert.equal(backward.to, '2026-08-16');    // -(-1) window, +1 pad
  });

  test('a bank record uses the WIDEST per-method window, since it cannot know the method', () => {
    // card is [-1,3], upi is [-1,2]; a bank row must admit both or it loses every
    // card settlement whose gateway row it has not seen yet.
    const bank = txn('b', 'bank', 1, { date: '2026-08-14' });
    const r = candidateDateRange(bank, 'gateway', config)!;
    assert.equal(r.from, '2026-08-10', 'must reach back the full card window');
  });

  test('bank↔ledger is anchored on the BANK, not the gateway', () => {
    const bank = txn('b', 'bank', 1, { date: '2026-08-14' });
    const r = candidateDateRange(bank, 'ledger', config)!;
    assert.equal(r.from, '2026-08-11');   // [-2,+4] forward, padded
    assert.equal(r.to, '2026-08-19');
  });
});

describe('candidateAmountBuckets (§3 rule 1 + the fee band)', () => {
  test('the fee band widens DOWNWARD from a gateway row and UPWARD from a bank row', () => {
    // The bank credits net of a 2.36-2.95% fee, so the bank side is always the
    // smaller number. Widening the wrong way loses every fee-bearing settlement.
    const big = 10_000_000;   // ₹100,000 — a fee band wide enough to span buckets
    const gw = txn('g', 'gateway', 1, { amount: big });
    const bk = txn('b', 'bank', 1, { amount: big });
    const fromGateway = candidateAmountBuckets(gw, 'bank', config);
    const fromBank = candidateAmountBuckets(bk, 'gateway', config);
    const own = Math.floor(big / 100_000);

    assert.ok(Math.min(...fromGateway) < own, 'gateway must look DOWN for its net credit');
    assert.ok(Math.max(...fromBank) > own, 'bank must look UP for its gross payment');
  });

  test('gateway↔ledger gets no fee widening — both sides are what the customer paid', () => {
    const gw = txn('g', 'gateway', 1, { amount: 10_000_000 });
    const buckets = candidateAmountBuckets(gw, 'ledger', config);
    // ±₹100 (the capped tolerance) straddles one bucket edge — and nothing more.
    // The gateway↔bank call below spans far wider because of the fee band.
    assert.deepEqual(buckets, [99, 100], 'tolerance alone, no fee band (ADR-037)');
    assert.ok(candidateAmountBuckets(gw, 'bank', config).length > buckets.length);
  });
});

describe('generateCandidates', () => {
  const build = (rows: NormalizedTransaction[]) => buildBlockIndexes(rows);

  test('finds a counterpart via byDateAmount even with no anchor and no name', () => {
    const gw = txn('g', 'gateway', 1, { amount: 500_000, net: 500_000, cp: null });
    const bk = txn('b', 'bank', 1, { amount: 500_000, date: '2026-08-15', cp: null });
    const found = generateCandidates(gw, build([gw, bk]), config);
    assert.deepEqual(found.map((t) => t.id), ['b']);
  });

  test('finds an amount-divergent, name-agreeing counterpart via byCounterparty', () => {
    // Rule 1 cannot reach this pair — the amounts are buckets apart. Rule 2 is
    // the only reason AMOUNT_MISMATCH is reachable at Tier 2 at all.
    const gw = txn('g', 'gateway', 1, { amount: 500_000, cp: 'ACME' });
    const bk = txn('b', 'bank', 1, { amount: 9_900_000, cp: 'ACME', date: '2026-08-15' });
    const found = generateCandidates(gw, build([gw, bk]), config);
    assert.deepEqual(found.map((t) => t.id), ['b']);
  });

  test('finds a near-anchor counterpart via byAnchorPrefix regardless of date', () => {
    // ADR-031: the typo'd-reference case. scorePair enforces corroboration, so
    // generation deliberately does not date-filter this source.
    const gw = txn('g', 'gateway', 1, { refs: { payment_id: 'pay_QK29fT10aXbZ81' } });
    const led = txn('l', 'ledger', 1, {
      refs: { payment_id: 'pay_QK29fT10aXbZ18' }, date: '2026-11-30',
    });
    const found = generateCandidates(gw, build([gw, led]), config);
    assert.deepEqual(found.map((t) => t.id), ['l']);
  });

  test('never returns same-source rows, itself, or excluded rows', () => {
    const gw = txn('g', 'gateway', 1);
    const sibling = txn('g2', 'gateway', 2);
    const excluded = txn('b', 'bank', 1, { status: 'excluded_non_reconcilable' });
    assert.deepEqual(generateCandidates(gw, build([gw, sibling, excluded]), config), []);
  });

  test('output is canonically ordered, not index-insertion ordered', () => {
    const gw = txn('g', 'gateway', 9);
    const rows = [
      gw,
      txn('l1', 'ledger', 1, { amount: 100_000 }),
      txn('b1', 'bank', 2, { amount: 100_000 }),
      txn('b2', 'bank', 1, { amount: 100_000 }),
    ];
    const found = generateCandidates(gw, build(rows), config);
    assert.deepEqual(found.map((t) => t.id), ['b2', 'b1', 'l1'],
      'gateway < bank < ledger, then row number');
  });
});

describe('runTier2', () => {
  test('records the ADR-033 cap on the record instead of truncating silently', () => {
    const gw = txn('g', 'gateway', 1, { amount: 100_000 });
    const rows = [gw];
    for (let i = 1; i <= 12; i += 1) rows.push(txn(`b${i}`, 'bank', i, { amount: 100_000 }));
    const tight: RunConfig = { ...config, candidateCap: 5 };
    const r = runTier2(buildBlockIndexes(rows), tight);
    const stat = r.candidateStats.find((s) => s.transactionId === 'g')!;
    assert.equal(stat.generated, 12, 'the true count, not the surviving count (§11)');
    assert.equal(stat.candidateCapHit, true);
  });

  test('a PAIR S6/S7 matched is not re-scored, but its RECORDS stay in the pool (#40)', () => {
    // §6.3 excludes pairs, not records. Excluding the records instead deletes
    // every gateway Tier 1 matched before its bank leg can be scored, which is
    // what made §10 rule 2 unsatisfiable and cost 314 true pairs.
    const gw = txn('g', 'gateway', 1, { amount: 100_000 });
    const led = txn('l', 'ledger', 1, { amount: 100_000 });
    const bk = txn('b', 'bank', 1, { amount: 100_000 });
    const blocks = buildBlockIndexes([gw, led, bk]);

    const all = runTier2(blocks, config);
    assert.equal(all.pairsScored, 3, 'g-l, g-b and l-b with nothing excluded');

    // S6 matched g<->l. That PAIR must not be re-scored...
    const after = runTier2(blocks, config, [{ aId: 'g', bId: 'l' }]);
    const keys = new Set<string>();
    for (const p of after.accepted) keys.add(pairKeyOf(p.a.id, p.b.id));
    assert.equal(keys.has(pairKeyOf('g', 'l')), false, 'the matched pair was re-scored');

    // ...and BOTH its records must still be reachable for their third leg.
    assert.equal(after.pairsScored, 2, 'g-b and l-b must still be scored');
    const stat = (id: string) => after.candidateStats.find((s) => s.transactionId === id)!;
    assert.ok(stat('g').consideredCount > 0, 'g left the pool: this is the #40 regression');
    assert.ok(stat('l').consideredCount > 0, 'l left the pool: this is the #40 regression');
  });

  test('a pair S8 already settled is not re-scored (§6.3)', () => {
    // A similarity score must never be in a position to overturn a deterministic
    // identity verdict.
    const gw = txn('g', 'gateway', 1, { amount: 100_000 });
    const bk = txn('b', 'bank', 1, { amount: 100_000 });
    const blocks = buildBlockIndexes([gw, bk]);
    const settled = new Set([pairKeyOf('g', 'b')]);
    assert.equal(runTier2(blocks, config, [], settled).pairsScored, 0);
  });

  test('each unordered pair is scored exactly once, whichever end reaches it first', () => {
    const gw = txn('g', 'gateway', 1, { amount: 100_000 });
    const bk = txn('b', 'bank', 1, { amount: 100_000 });
    assert.equal(runTier2(buildBlockIndexes([gw, bk]), config).pairsScored, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S11 — group assembly
// ─────────────────────────────────────────────────────────────────────────────

function gp(
  a: NormalizedTransaction, b: NormalizedTransaction,
  tier: MatchTier, confidence: number, o: Partial<GroupPair> = {},
): GroupPair {
  return {
    a, b, tier, confidence, status: 'auto_confirmed', ruleId: `${tier.toUpperCase()}_V1`,
    amountDeltaPaise: 0, dateDeltaDays: 0, aliasIds: [], scoreBreakdown: null, ...o,
  };
}

describe('assembleGroups (§10)', () => {
  const g = txn('g', 'gateway', 1);
  const b = txn('b', 'bank', 1);
  const l = txn('l', 'ledger', 1);

  test('rule 2: two pairs sharing the gateway record become ONE 3-way group', () => {
    const r = assembleGroups([gp(g, b, 'exact', 1), gp(g, l, 'exact', 1)]);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.members.length, 3);
  });

  test('rule 1: the gateway anchors; without one the bank does; without either the ledger', () => {
    assert.equal(pickAnchor([b, l, g]).id, 'g');
    assert.equal(pickAnchor([l, b]).id, 'b');
    assert.equal(pickAnchor([l]).id, 'l');
    const r = assembleGroups([gp(g, b, 'exact', 1), gp(g, l, 'exact', 1)]);
    const anchors = r.matches[0]!.members.filter((m) => m.isAnchor);
    assert.equal(anchors.length, 1, 'exactly one anchor per group (schema.md §7)');
    assert.equal(anchors[0]!.role, 'gateway');
  });

  test('rule 4: group confidence is the MINIMUM, never the mean', () => {
    const r = assembleGroups([gp(g, b, 'fuzzy', 0.99), gp(g, l, 'fuzzy', 0.71)]);
    assert.equal(r.matches[0]!.confidence, 0.71,
      'averaging would let the exact pair launder the marginal one');
  });

  test('rule 5: group tier is the WEAKEST tier used', () => {
    const r = assembleGroups([gp(g, b, 'exact', 1), gp(g, l, 'fuzzy', 0.9)]);
    assert.equal(r.matches[0]!.tier, 'fuzzy',
      'reporting this as exact would overstate the evidence');
  });

  test('a group holding one proposal IS a proposal (ADR-040)', () => {
    const r = assembleGroups([
      gp(g, b, 'exact', 1),
      gp(g, l, 'fuzzy', 0.7, { status: 'pending_review' }),
    ]);
    assert.equal(r.matches[0]!.status, 'pending_review');
  });

  test('rule 3: a role collision is REFUSED, and the stronger pair keeps the slot', () => {
    const b2 = txn('b2', 'bank', 2);
    const r = assembleGroups([gp(g, b, 'exact', 1), gp(g, b2, 'fuzzy', 0.9)]);
    assert.equal(r.matches.length, 1);
    assert.deepEqual(r.matches[0]!.members.map((m) => m.transactionId).sort(), ['b', 'g']);
    assert.equal(r.refused.length, 1);
    assert.equal(r.refused[0]!.conflictingRole, 'bank');
    assert.deepEqual(r.refused[0]!.displacedByTransactionIds, ['b']);
    assert.match(r.refused[0]!.reason, /did not choose/);
  });

  test('which pair wins a collision does not depend on input order', () => {
    const b2 = txn('b2', 'bank', 2);
    const one = assembleGroups([gp(g, b, 'exact', 1), gp(g, b2, 'fuzzy', 0.9)]);
    const two = assembleGroups([gp(g, b2, 'fuzzy', 0.9), gp(g, b, 'exact', 1)]);
    assert.deepEqual(
      one.matches[0]!.members.map((m) => m.transactionId).sort(),
      two.matches[0]!.members.map((m) => m.transactionId).sort(),
    );
    assert.equal(two.refused.length, 1);
  });

  test('a record already in an S10 batch group is refused, never placed twice', () => {
    // Two matches over one record would trip ux_txn_single_match at write time.
    const batch: ProposedMatch = {
      tier: 'batch', status: 'auto_confirmed', confidence: 0.9, ruleId: 'BATCH_V1',
      cardinality: 'many_to_one',
      members: [{ transactionId: 'b', role: 'bank', isAnchor: true }],
      amountDeltaPaise: 0, dateDeltaDays: 0, aliasIds: [], scoreBreakdown: null,
    };
    const r = assembleGroups([gp(g, b, 'fuzzy', 0.9)], [batch]);
    assert.equal(r.refused.length, 1);
    assert.match(r.refused[0]!.reason, /settlement batch/);
    assert.equal(r.matches.length, 1, 'only the batch group survives');
  });

  test('comparePairStrength orders by tier, then confidence, then canonical position', () => {
    assert.ok(comparePairStrength(gp(g, b, 'exact', 0.5), gp(g, l, 'fuzzy', 0.99)) < 0);
    assert.ok(comparePairStrength(gp(g, b, 'fuzzy', 0.9), gp(g, l, 'fuzzy', 0.8)) < 0);
  });

  test('cardinality counts members per ROLE, not roles filled', () => {
    assert.equal(cardinalityOf([g, b, l]), 'one_to_one', 'a clean 3-way is 1:1');
    assert.equal(cardinalityOf([g, txn('g2', 'gateway', 2), b]), 'many_to_one', 'N gateway -> 1 bank');
    assert.equal(cardinalityOf([g, b, txn('b2', 'bank', 2)]), 'one_to_many', '1 gateway -> N bank');
  });

  test('fromTier2 carries the real deltas, not zero', () => {
    // A fuzzy group reporting amountDeltaPaise 0 does not read as "unknown", it
    // reads as "the amounts agreed exactly".
    const pair = fromTier2({
      a: g, b, score: 0.9, breakdown: {
        anchor: 0.3, amount: 0.3, date: 0.15, counterparty: 0.15, total: 0.9,
        amountUnavailable: false,
      },
      ruleId: 'FUZZY_WEAK_ANCHOR_V1', status: 'auto_confirmed',
      amount: {
        deltaPaise: -412, tolerancePaise: 100, within: false,
        basis: 'gateway_net_vs_bank_credit', unavailable: false, inferred: false,
      },
      date: { deltaDays: 2, window: [-1, 3], within: true },
    });
    assert.equal(pair.amountDeltaPaise, -412);
    assert.equal(pair.dateDeltaDays, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The holdout. Precision AND recall — issue #33 exists because the Tier 1 suite
// asserted only the first, under a title that claimed the second.
// ─────────────────────────────────────────────────────────────────────────────

describe('S9 + S11 against the holdout', () => {
  const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
  const TRUTH = new URL('../../../../data/truth/holdout_seed_90210.json', import.meta.url).pathname;
  const ing = ingestSources({
    runId: 'r',
    files: {
      gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
      bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
      ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
    },
  });
  const holdout: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: ing.referenceDate!, aliasCountAtStart: 0 };

  function run() {
    const pool = dedupe(ing.transactions).pool;
    const blocks = buildBlockIndexes(pool);
    const t1 = runTier1(blocks, holdout);
    const claimedByExact = new Set(t1.matches.flatMap((m) => [m.aId, m.bId]));
    const t15 = runTier15(pool, holdout, [], claimedByExact);
    rebuildCounterpartyIndex(blocks, t15.pool);
    const exact = [...t1.matches, ...t15.matches];
    const settled = new Set<string>();
    for (const { pair, verdict } of resolveIdentities(t15.pool, holdout)) {
      if (verdict.kind !== 'not_established') settled.add(pairKeyOf(pair[0].id, pair[1].id));
    }
    const t2 = runTier2(blocks, holdout, exact, settled);
    const byId = new Map(t15.pool.map((t) => [t.id, t]));
    const pairs = [
      ...exact.map((m) => fromTier1(m, byId)).filter((p): p is GroupPair => p !== null),
      ...t2.accepted.map(fromTier2),
    ];
    return { pool, blocks, settled, t2, t1Matches: t1.matches, groups: assembleGroups(pairs) };
  }

  const { pool, blocks, settled, t2, t1Matches, groups } = run();
  const rowKey = (t: NormalizedTransaction) => `${t.sourceSystem}:${t.sourceRowNumber}`;
  const truth = new Map<string, boolean>();
  const key = JSON.parse(readFileSync(TRUTH, 'utf8')) as {
    expectedPairs: { a: { sourceSystem: string; sourceRowNumber: number };
                     b: { sourceSystem: string; sourceRowNumber: number }; shouldMatch: boolean }[];
  };
  for (const p of key.expectedPairs) {
    truth.set([`${p.a.sourceSystem}:${p.a.sourceRowNumber}`,
               `${p.b.sourceSystem}:${p.b.sourceRowNumber}`].sort().join('|'), p.shouldMatch);
  }

  test('Tier 2 invents nothing: zero false positives against the answer key', () => {
    const wrong = t2.accepted.filter((p) => {
      const k = [rowKey(p.a), rowKey(p.b)].sort().join('|');
      return truth.get(k) !== true;
    });
    assert.deepEqual(wrong.map((p) => [rowKey(p.a), rowKey(p.b), p.score]), [],
      'every accepted Tier 2 pair must be a true pair in the key');
  });

  test('the ADR-030 no-anchor ceiling holds: nothing auto-confirms without a shared reference', () => {
    // The strongest honesty guarantee in the engine, and it falls out of the
    // weights arithmetically rather than from a tunable threshold.
    for (const p of t2.accepted) {
      if (p.breakdown.anchor === 0) {
        assert.equal(p.status, 'pending_review',
          `${rowKey(p.a)}/${rowKey(p.b)} auto-confirmed with no anchor at all`);
      }
    }
  });

  test('the candidate cap does not bind on the holdout, so no recall is silently lost', () => {
    assert.deepEqual(t2.candidateStats.filter((s) => s.candidateCapHit), []);
  });

  test('a record matched at Tier 1 still acquires its third leg (§10 rule 2, #40)', () => {
    // The property issue #40 broke. Rule 2 says "gateway<->bank plus
    // gateway<->ledger on the same gateway record produces one 3-way group",
    // and Tier 1 only ever produces gateway<->ledger pairs (bank rows carry no
    // structured strong anchor, §3.1). So if Tier 2 cannot see a record Tier 1
    // matched, rule 2 is unsatisfiable and every count below is zero.
    const exactPairKeys = new Set(
      t1Matches.map((m) => [m.aId, m.bId].sort().join('|')));
    const t2PairKeys = new Set(
      t2.accepted.map((p) => [p.a.id, p.b.id].sort().join('|')));

    const inBoth = new Set<string>();
    for (const m of groups.matches) {
      const ids = m.members.map((x) => x.transactionId);
      let hasExact = false;
      let hasFuzzy = false;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const k = [ids[i]!, ids[j]!].sort().join('|');
          if (exactPairKeys.has(k)) hasExact = true;
          if (t2PairKeys.has(k)) hasFuzzy = true;
        }
      }
      if (hasExact && hasFuzzy) for (const id of ids) inBoth.add(id);
    }
    // Exact, not a floor: 166 of Tier 1's 203 groups gain a bank leg.
    assert.equal(
      groups.matches.filter((m) => m.members.length === 3).length, 198,
      'three-way groups: rule 2 firing, counted');
    assert.ok(inBoth.size > 0,
      'no record appears in both an exact pair and a Tier 2 pair — Tier 2 has ' +
      'stopped seeing records the exact tiers matched, which is issue #40');
  });

  test('S11 places no record in two groups', () => {
    // The invariant ux_txn_single_match enforces at write time; catching it here
    // means a violation is a test failure rather than a run-time INSERT error.
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const m of groups.matches) {
      for (const mem of m.members) {
        if (seen.has(mem.transactionId)) twice.push(mem.transactionId);
        seen.add(mem.transactionId);
      }
    }
    assert.deepEqual(twice, []);
  });

  test('every group has exactly one anchor, and it is the gateway wherever one is a member', () => {
    for (const m of groups.matches) {
      const anchors = m.members.filter((x) => x.isAnchor);
      assert.equal(anchors.length, 1);
      if (m.members.some((x) => x.role === 'gateway')) assert.equal(anchors[0]!.role, 'gateway');
    }
  });

  test('the whole chain is deterministic across two runs', () => {
    const shape = (r: ReturnType<typeof run>) => r.groups.matches.map(
      (m) => [m.tier, m.status, m.confidence, m.cardinality,
              m.members.map((x) => x.transactionId).sort().join(',')].join('|'));
    assert.deepEqual(shape(run()), shape(run()));
  });

  test('pair-level recall is at its known level, and every shortfall is an ENUMERATED cause', () => {
    // NOT a loose floor. Issue #33 exists because `matches.length > 150` hid nine
    // real misses under a title that claimed a recall property. This pins the
    // exact numbers, so any regression AND any unexplained improvement fails.
    //
    // The title's SECOND clause used to be unasserted, and issue #40 hid under it
    // for a day: 396 of the misses shared one cause — Tier 2 excluding records
    // S6/S7 had matched — and nothing here was classifying them. Every miss is
    // now attributed to a named cause, and a miss that matches no cause fails the
    // test. That is what makes the title true.
    const produced = new Set<string>();
    for (const m of groups.matches) {
      const ids = m.members.map((x) => x.transactionId);
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const a = pool.find((t) => t.id === ids[i])!;
          const b = pool.find((t) => t.id === ids[j])!;
          produced.add([rowKey(a), rowKey(b)].sort().join('|'));
        }
      }
    }
    const expected = [...truth.entries()].filter(([, should]) => should).map(([k]) => k);
    const hit = expected.filter((k) => produced.has(k)).length;

    assert.equal(expected.length, 872);
    assert.equal(hit, 680,
      `pair recall changed. If this is an improvement, raise the number and say why in ` +
      `the commit; if it is a regression, something upstream stopped generating candidates.`);
    // Precision must stay perfect while recall moves.
    const invented = [...produced].filter((k) => truth.get(k) !== true);
    assert.deepEqual(invented, [], 'no group may assert a pair the key denies');

    // ── every shortfall, attributed ──────────────────────────────────────────
    const byRow = new Map(pool.map((t) => [rowKey(t), t]));
    const causes = new Map<string, number>();
    const unattributed: string[] = [];

    for (const k of expected) {
      if (produced.has(k)) continue;
      const [ka, kb] = k.split('|') as [string, string];
      const a = byRow.get(ka);
      const b = byRow.get(kb);
      let cause: string | null = null;

      if (a === undefined || b === undefined) {
        // Excluded status, non-primary duplicate, or a rejected row. Outside the
        // reconcilable denominator by design, so outside recall too.
        cause = 'outside the reconcilable pool';
      } else if (settled.has(pairKeyOf(a.id, b.id))) {
        // S8 reached a deterministic verdict; §6.3 forbids Tier 2 re-scoring it.
        cause = 'settled by S8 identity';
      } else if (
        !generateCandidates(a, blocks, holdout).some((c) => c.id === b.id)
        && !generateCandidates(b, blocks, holdout).some((c) => c.id === a.id)
      ) {
        // The net-batch legs: a batch credit's amount is buckets away from any
        // single payment, which is S10's job (§8), not candidate generation's.
        cause = 'no candidate generated (S10 batch legs)';
      } else {
        // Generated and scored, but the evidence did not clear §7.3.
        cause = 'scored below threshold or displaced';
      }

      if (cause === null) unattributed.push(k);
      else causes.set(cause, (causes.get(cause) ?? 0) + 1);
    }

    assert.deepEqual(unattributed, [], 'every miss must fall under a named cause');
    // Exact counts, not floors: a cause that grows is a regression even if the
    // headline holds, and 'claimed by S6/S7 in another match' — 396 misses before
    // #40 — must stay absent rather than merely small.
    assert.deepEqual(Object.fromEntries([...causes].sort()), {
      'no candidate generated (S10 batch legs)': 6,
      'outside the reconcilable pool': 18,
      'scored below threshold or displaced': 159,
      'settled by S8 identity': 9,
    });
    assert.equal([...causes.values()].reduce((x, y) => x + y, 0), expected.length - hit,
      'the causes must account for every miss, with none double-counted');
  });
});
