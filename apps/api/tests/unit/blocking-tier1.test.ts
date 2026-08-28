import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import type { ActiveAlias, NormalizedTransaction, ReferenceIds, RunConfig } from '../../src/types/engine.js';
import type { Direction, SourceSystem, StatusNorm } from '../../src/types/domain.js';
import {
  buildBlockIndexes, strongAnchorPairs, amountBucket, rebuildCounterpartyIndex,
} from '../../src/services/matching/blocking.js';
import { tier1Match, runTier1 } from '../../src/services/matching/tier1-exact.js';
import { directionAgrees } from '../../src/services/matching/tolerance.js';
import { runTier15 } from '../../src/services/matching/tier1_5-alias.js';
import { ingestSources } from '../../src/services/ingestion/index.js';
import { dedupe } from '../../src/services/matching/dedupe.js';

const config: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-31', aliasCountAtStart: 0 };

interface Over {
  refs?: ReferenceIds; amount?: number; net?: number | null; date?: string;
  cp?: string | null; status?: StatusNorm; direction?: Direction;
  method?: 'card' | 'upi'; currency?: string;
}
function txn(id: string, source: SourceSystem, row: number, o: Over = {}): NormalizedTransaction {
  const refs = o.refs ?? {};
  const hasStrong = Boolean(refs.payment_id ?? refs.settlement_id ?? refs.rrn ?? refs.utr
    ?? refs.entry_id ?? refs.invoice_no);
  return {
    id, runId: 'r', sourceSystem: source, sourceFile: `${source}.csv`, sourceRowNumber: row,
    externalId: id, referenceIds: refs, anchorStrength: hasStrong ? 'strong' : 'none',
    amountPaise: o.amount ?? 100_000, feePaise: null, taxPaise: null,
    netAmountPaise: o.net === undefined ? (o.amount ?? 100_000) : o.net,
    currency: o.currency ?? 'INR', direction: o.direction ?? 'credit',
    txnDate: o.date ?? '2026-08-14', txnTimestamp: null, postingDate: null,
    counterpartyRaw: o.cp ?? null, counterpartyNorm: o.cp === undefined ? 'ACME' : o.cp,
    counterpartyKey: null,
    method: o.method ?? 'card', statusRaw: 'captured',
    statusNorm: o.status ?? 'reconcilable', txnType: null,
    descriptionRaw: null, duplicateOfTransactionId: null, duplicateKind: null,
    ingestWarnings: [], rawPayload: {},
  };
}

const PAY_A = 'pay_QK29fT10aXbZ81';
const PAY_B = 'pay_ZZ99zZ99zZ99zZ';

// ─────────────────────────────────────────────────────────────────────────────
// S5 — blocking
// ─────────────────────────────────────────────────────────────────────────────

describe('buildBlockIndexes (S5)', () => {
  test('indexes reconcilable rows only; excluded rows never become candidates', () => {
    const blocks = buildBlockIndexes([
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('g2', 'gateway', 2, { refs: { payment_id: PAY_B }, status: 'excluded_failed' }),
    ]);
    assert.deepEqual([...blocks.byId.keys()], ['g1']);
    assert.ok(blocks.byStrongAnchor.has(`payment_id::${PAY_A}`));
    assert.ok(!blocks.byStrongAnchor.has(`payment_id::${PAY_B}`));
  });

  test('id lists come out in canonical order (gateway < bank < ledger, then row)', () => {
    const blocks = buildBlockIndexes([
      txn('L', 'ledger', 3, { refs: { payment_id: PAY_A } }),
      txn('B', 'bank', 9, { refs: { payment_id: PAY_A } }), // bank has no structured payment_id in real data; fine for ordering
      txn('G', 'gateway', 1, { refs: { payment_id: PAY_A } }),
    ]);
    assert.deepEqual(blocks.byStrongAnchor.get(`payment_id::${PAY_A}`), ['G', 'B', 'L']);
  });

  test('amount bucket is floor(amountPaise / 100000); byDateAmount keys on (date::bucket)', () => {
    assert.equal(amountBucket(0), 0);
    assert.equal(amountBucket(99_999), 0);
    assert.equal(amountBucket(100_000), 1);
    assert.equal(amountBucket(1_234_567), 12);
    const blocks = buildBlockIndexes([txn('g1', 'gateway', 1, { amount: 250_000, date: '2026-08-14' })]);
    assert.deepEqual(blocks.byDateAmount.get('2026-08-14::2'), ['g1']);
  });

  test('byAnchorPrefix buckets on the first 6 chars of each strong anchor value', () => {
    const blocks = buildBlockIndexes([txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } })]);
    assert.deepEqual(blocks.byAnchorPrefix.get(PAY_A.slice(0, 6)), ['g1']);
  });

  test('byCounterparty keys on counterpartyKey when set, else counterpartyNorm', () => {
    const a = txn('g1', 'gateway', 1, { cp: 'ACME' });
    const b = { ...txn('g2', 'gateway', 2, { cp: 'ignored' }), counterpartyKey: 'RESOLVED' };
    const blocks = buildBlockIndexes([a, b]);
    assert.deepEqual(blocks.byCounterparty.get('ACME'), ['g1']);
    assert.deepEqual(blocks.byCounterparty.get('RESOLVED'), ['g2']);

    rebuildCounterpartyIndex(blocks, [{ ...a, counterpartyKey: 'ACME2' }, b]);
    assert.deepEqual(blocks.byCounterparty.get('ACME2'), ['g1']);
    assert.equal(blocks.byCounterparty.get('ACME'), undefined);
  });
});

describe('strongAnchorPairs', () => {
  test('emits each cross-source anchor-sharing pair once, oriented canonically', () => {
    const blocks = buildBlockIndexes([
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A, rrn: '234567890123' } }),
      txn('l1', 'ledger', 1, { refs: { payment_id: PAY_A } }),
    ]);
    const pairs = strongAnchorPairs(blocks);
    assert.equal(pairs.length, 1, 'shared on two anchors, still one pair');
    assert.equal(pairs[0]!.a.id, 'g1');
    assert.equal(pairs[0]!.b.id, 'l1');
  });

  test('same-source anchor collisions are not pairs (that is S4 dedupe territory)', () => {
    const blocks = buildBlockIndexes([
      txn('g1', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('g2', 'gateway', 2, { refs: { payment_id: PAY_A } }),
    ]);
    assert.deepEqual(strongAnchorPairs(blocks), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S6 — Tier 1 predicate
// ─────────────────────────────────────────────────────────────────────────────

describe('tier1Match (S6)', () => {
  const gw = (o: Over = {}) => txn('g', 'gateway', 1, { refs: { payment_id: PAY_A }, ...o });
  const led = (o: Over = {}) => txn('l', 'ledger', 1, { refs: { payment_id: PAY_A }, ...o });

  test('gateway↔ledger sharing payment_id, amount and date agreeing → EXACT_GATEWAY_REF_V1', () => {
    const m = tier1Match(gw(), led(), config);
    assert.ok(m);
    assert.equal(m!.ruleId, 'EXACT_GATEWAY_REF_V1');
    assert.equal(m!.anchorKey, 'payment_id');
    assert.equal(m!.amountDeltaPaise, 0);
    assert.equal(m!.dateDeltaDays, 0);
    assert.equal(m!.basis, 'gateway_gross_vs_ledger_net');
    assert.deepEqual(m!.window, config.dateWindowLedgerDays);
  });

  test('no shared structured strong anchor → null', () => {
    assert.equal(tier1Match(gw({ refs: { payment_id: PAY_A } }), led({ refs: { payment_id: PAY_B } }), config), null);
    assert.equal(tier1Match(gw({ refs: {} }), led({ refs: {} }), config), null);
  });

  test('a description-extracted anchor is NOT a Tier 1 anchor (gateway↔bank never matches at S6)', () => {
    // Bank rows carry rrn/settlement_id only inside extracted_from_description — weak,
    // and identity may not rest on a regex hit (schema.md §3.1). So even with the
    // same rrn value, this is a Tier 2 pair.
    const bank = txn('b', 'bank', 1, {
      refs: { utr: 'U1', extracted_from_description: ['234567890123'] },
    });
    const gwWithRrn = gw({ refs: { payment_id: PAY_A, rrn: '234567890123' } });
    assert.equal(tier1Match(gwWithRrn, bank, config), null);
  });

  test('direction gates only where BOTH sides state one (ADR-071)', () => {
    // The gateway states direction via `status` and the bank via which amount
    // column is populated. The ledger has no direction column at all (schema.md
    // §2.3) — its 'credit' is a modelling constant this codebase assigns, so
    // gating a gateway↔ledger pair on it compares a fact against an assumption.
    assert.equal(directionAgrees(txn('g', 'gateway', 1, { direction: 'debit' }),
                                 txn('b', 'bank', 1, { direction: 'credit' })), false);
    assert.equal(directionAgrees(txn('g', 'gateway', 1, { direction: 'debit' }),
                                 txn('l', 'ledger', 1, { direction: 'credit' })), true);
  });

  test('a refunded gateway row matches its ledger sale row (issue #30)', () => {
    // REFUND_REVERSAL: the gateway records the reversal as a debit, the ledger
    // records the original sale as a credit, and both legs are one economic
    // event. Under the old gate this pair failed at S6, S7, S8 AND S9, costing
    // all nine holdout refund events their ledger leg and manufacturing nine
    // presence exceptions that the answer key says should not exist.
    const m = tier1Match(gw({ direction: 'debit' }), led({ direction: 'credit' }), config);
    assert.ok(m, 'a refund must still reach its ledger entry');
    assert.equal(m!.ruleId, 'EXACT_GATEWAY_REF_V1');
  });

  test('currency mismatch → null (checked even though v1 is always INR)', () => {
    assert.equal(tier1Match(gw({ currency: 'USD' }), led(), config), null);
  });

  test('amount outside the banded tolerance → null', () => {
    assert.equal(tier1Match(gw({ amount: 100_000 }), led({ amount: 100_000, net: 200_000 }), config), null);
  });

  test('date outside the per-pair window → null; inside → match', () => {
    // gateway↔ledger window is [-1, +1].
    assert.equal(tier1Match(gw({ date: '2026-08-14' }), led({ date: '2026-08-16' }), config), null);
    assert.ok(tier1Match(gw({ date: '2026-08-14' }), led({ date: '2026-08-15' }), config));
  });

  test('same source, same id, or an excluded row → null', () => {
    assert.equal(tier1Match(gw(), gw(), config), null);
    assert.equal(tier1Match(gw(), led({ status: 'excluded_void' }), config), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S6 — driver against the holdout fixtures
// ─────────────────────────────────────────────────────────────────────────────

describe('runTier1 against the holdout', () => {
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
  const holdoutConfig: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: ing.referenceDate!, aliasCountAtStart: 0 };
  const pool = dedupe(ing.transactions).pool;
  const blocks = buildBlockIndexes(pool);
  const result = runTier1(blocks, holdoutConfig);

  test('every Tier 1 match is a true positive in the answer key (zero false matches)', () => {
    const key = JSON.parse(readFileSync(TRUTH, 'utf8')) as {
      expectedPairs: { a: RowRef; b: RowRef; shouldMatch: boolean }[];
    };
    type RowRef = { sourceSystem: string; sourceRowNumber: number };
    const rowKey = (r: RowRef) => `${r.sourceSystem}:${r.sourceRowNumber}`;
    const shouldMatch = new Set(
      key.expectedPairs.filter((p) => p.shouldMatch).map((p) => [rowKey(p.a), rowKey(p.b)].sort().join('|')),
    );
    const falsePositives = result.matches.filter((m) => {
      const a = blocks.byId.get(m.aId)!;
      const b = blocks.byId.get(m.bId)!;
      return !shouldMatch.has([`${a.sourceSystem}:${a.sourceRowNumber}`, `${b.sourceSystem}:${b.sourceRowNumber}`].sort().join('|'));
    });
    assert.deepEqual(falsePositives, [], 'Tier 1 must never invent a match');
  });

  test('the exact tier carries a meaningful share of the load, all gateway↔ledger on the ref', () => {
    assert.ok(result.matches.length > 150, `expected > 150 exact matches, got ${result.matches.length}`);
    for (const m of result.matches) {
      assert.equal(m.ruleId, 'EXACT_GATEWAY_REF_V1');
      assert.equal(m.tier, 'exact');
      assert.equal(m.confidence, 1);
      assert.deepEqual([m.aRole, m.bRole].sort(), ['gateway', 'ledger']);
    }
  });

  test('deterministic across two runs', () => {
    const again = runTier1(buildBlockIndexes(dedupe(ing.transactions).pool), holdoutConfig);
    assert.deepEqual(
      result.matches.map((m) => [m.aId, m.bId, m.ruleId]),
      again.matches.map((m) => [m.aId, m.bId, m.ruleId]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S7 — Tier 1.5
// ─────────────────────────────────────────────────────────────────────────────

describe('runTier15 (S7)', () => {
  const alias = (o: Partial<ActiveAlias> & Pick<ActiveAlias, 'aliasType' | 'normalizedValue' | 'canonicalValue'>): ActiveAlias => ({
    id: o.id ?? `al_${o.normalizedValue}`,
    scopeSource: o.scopeSource ?? 'any',
    eligibleForAliasTier: o.eligibleForAliasTier ?? true,
    ...o,
  });

  test('cold run: counterparty_key is just a copy of the norm, and nothing matches', () => {
    const pool = [
      txn('g', 'gateway', 1, { refs: { payment_id: PAY_A }, cp: 'AMZN' }),
      txn('l', 'ledger', 1, { refs: {}, cp: 'AMAZON RETAIL' }),
    ];
    const r = runTier15(pool, config, []);
    assert.deepEqual(r.matches, []);
    assert.deepEqual(r.counterpartyResolutions, []);
    assert.ok(r.pool.every((t) => t.counterpartyKey === t.counterpartyNorm));
  });

  test('a merchant_name alias resolves counterparty_key to the canonical value', () => {
    const pool = [txn('g', 'gateway', 1, { cp: 'AMZN' })];
    const r = runTier15(pool, config, [
      alias({ aliasType: 'merchant_name', normalizedValue: 'AMZN', canonicalValue: 'AMAZON RETAIL' }),
    ]);
    assert.equal(r.pool[0]!.counterpartyKey, 'AMAZON RETAIL');
    assert.deepEqual(r.counterpartyResolutions, [
      { transactionId: 'g', counterpartyKey: 'AMAZON RETAIL', appliedAliasId: 'al_AMZN' },
    ]);
  });

  test('an INELIGIBLE alias still sets counterparty_key (§6.3 "downgraded to a Tier 2 contribution")', () => {
    const pool = [txn('g', 'gateway', 1, { cp: 'AMZN' })];
    const r = runTier15(pool, config, [
      alias({ aliasType: 'merchant_name', normalizedValue: 'AMZN', canonicalValue: 'AMAZON RETAIL', eligibleForAliasTier: false }),
    ]);
    assert.equal(r.pool[0]!.counterpartyKey, 'AMAZON RETAIL');
  });

  test('scope is honoured — a bank-scoped alias does not touch a gateway row', () => {
    const pool = [txn('g', 'gateway', 1, { cp: 'AMZN' })];
    const r = runTier15(pool, config, [
      alias({ aliasType: 'merchant_name', normalizedValue: 'AMZN', canonicalValue: 'AMAZON RETAIL', scopeSource: 'bank' }),
    ]);
    assert.equal(r.pool[0]!.counterpartyKey, 'AMZN');
  });

  test('an eligible reference_id alias turns a non-match into ALIAS_RESOLVED_EXACT_V1', () => {
    // Raw: gateway payment_id PAY_A, ledger gateway_ref PAY_B — no shared anchor,
    // so S6 finds nothing. The alias asserts PAY_B ≡ PAY_A.
    const pool = [
      txn('g', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, date: '2026-08-14' }),
      txn('l', 'ledger', 1, { refs: { payment_id: PAY_B }, amount: 100_000, date: '2026-08-14' }),
    ];
    assert.equal(runTier1(buildBlockIndexes(pool), config).matches.length, 0, 'S6 finds nothing raw');

    const r = runTier15(pool, config, [
      alias({ id: 'al_ref', aliasType: 'reference_id', normalizedValue: PAY_B, canonicalValue: PAY_A }),
    ]);
    assert.equal(r.matches.length, 1);
    const m = r.matches[0]!;
    assert.equal(m.ruleId, 'ALIAS_RESOLVED_EXACT_V1');
    assert.equal(m.tier, 'alias');
    assert.equal(m.confidence, 0.95);
    assert.deepEqual(m.aliasIds, ['al_ref']);
    assert.deepEqual([m.aRole, m.bRole].sort(), ['gateway', 'ledger']);
  });

  test('an ineligible reference_id alias produces no Tier 1.5 match', () => {
    const pool = [
      txn('g', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('l', 'ledger', 1, { refs: { payment_id: PAY_B } }),
    ];
    const r = runTier15(pool, config, [
      alias({ aliasType: 'reference_id', normalizedValue: PAY_B, canonicalValue: PAY_A, eligibleForAliasTier: false }),
    ]);
    assert.deepEqual(r.matches, []);
  });

  test('the substituted pair still has to pass the real Tier 1 test (amount/date)', () => {
    const pool = [
      txn('g', 'gateway', 1, { refs: { payment_id: PAY_A }, amount: 100_000, date: '2026-08-14' }),
      txn('l', 'ledger', 1, { refs: { payment_id: PAY_B }, amount: 100_000, net: 500_000, date: '2026-08-14' }),
    ];
    const r = runTier15(pool, config, [
      alias({ aliasType: 'reference_id', normalizedValue: PAY_B, canonicalValue: PAY_A }),
    ]);
    assert.deepEqual(r.matches, [], 'alias widened the input but the amount still disagrees');
  });

  test('one hop only — A→B and B→C does not resolve A to C', () => {
    const pool = [
      txn('g', 'gateway', 1, { refs: { payment_id: 'pay_AAAAAAAAAAAAAA' } }),
      txn('l', 'ledger', 1, { refs: { payment_id: 'pay_CCCCCCCCCCCCCC' } }),
    ];
    const r = runTier15(pool, config, [
      alias({ id: 'ab', aliasType: 'reference_id', normalizedValue: 'pay_AAAAAAAAAAAAAA', canonicalValue: 'pay_BBBBBBBBBBBBBB' }),
      alias({ id: 'bc', aliasType: 'reference_id', normalizedValue: 'pay_BBBBBBBBBBBBBB', canonicalValue: 'pay_CCCCCCCCCCCCCC' }),
    ]);
    assert.deepEqual(r.matches, [], 'gateway resolves A→B and stops; it never reaches C');
  });

  test('alreadyMatchedIds excludes a pair from the exact re-run', () => {
    const pool = [
      txn('g', 'gateway', 1, { refs: { payment_id: PAY_A } }),
      txn('l', 'ledger', 1, { refs: { payment_id: PAY_B } }),
    ];
    const aliases = [alias({ aliasType: 'reference_id', normalizedValue: PAY_B, canonicalValue: PAY_A })];
    assert.equal(runTier15(pool, config, aliases).matches.length, 1);
    assert.equal(runTier15(pool, config, aliases, new Set(['g'])).matches.length, 0);
  });

  test('holdout cold run: 0 alias matches, counterparty_key populated everywhere', () => {
    const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
    const ing = ingestSources({
      runId: 'r',
      files: {
        gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
        bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
        ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
      },
    });
    const cfg: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: ing.referenceDate!, aliasCountAtStart: 0 };
    const r = runTier15(dedupe(ing.transactions).pool, cfg, []);
    assert.deepEqual(r.matches, []);
    for (const t of r.pool) {
      assert.equal(t.counterpartyKey, t.counterpartyNorm);
    }
  });
});
