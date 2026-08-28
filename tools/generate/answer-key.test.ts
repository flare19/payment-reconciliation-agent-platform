import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnswerKey, serializeAnswerKey, sha256, weakestSufficientTier, GENERATOR_VERSION,
  type AnswerKeyInput, type EmittedRow,
} from './answer-key.js';
import type { BankRow, GatewayRow, LedgerRow, ProjectedRow } from './projection.js';
import type { EconomicEvent } from './events.js';
import type { Scenario } from './scenarios.js';
import { SCENARIOS } from './scenarios.js';

const GROSS = 123_450, NET = 120_015;

const evt = (id: string, scenario: Scenario): EconomicEvent => ({
  eventId: id, scenario,
  canonical: { amountPaise: GROSS, date: '2026-08-14', merchant: 'AMAZON RETAIL',
    method: 'card', direction: scenario === 'REFUND_REVERSAL' ? 'debit' : 'credit' },
});

const gw = (o: Partial<GatewayRow> = {}): GatewayRow => ({
  sourceSystem: 'gateway', eventId: 'evt_000000', defects: [], blankedColumns: [],
  paymentId: 'pay_QK29fT10aXbZ81', orderId: null, method: 'card', status: 'captured',
  amountPaise: GROSS, currency: 'INR', feePaise: 2_911, taxPaise: 524, netAmountPaise: NET,
  createdAt: '2026-08-14 18:42:11', capturedAt: null, merchantName: 'AMZN',
  customerEmail: null, rrn: '234567890123', settlementId: null, notes: null, ...o });

const bk = (o: Partial<BankRow> = {}): BankRow => ({
  sourceSystem: 'bank', eventId: 'evt_000000', defects: [], blankedColumns: [],
  utr: 'SBIN0R52026081412345', valueDate: '2026-08-16', postingDate: '2026-08-16',
  description: 'NEFT-SETL-AMZN-234567890123', creditAmountPaise: NET, debitAmountPaise: null,
  closingBalancePaise: 1_000_000, bankRefNo: null, transactionType: 'SETTLEMENT', ...o });

const lg = (o: Partial<LedgerRow> = {}): LedgerRow => ({
  sourceSystem: 'ledger', eventId: 'evt_000000', defects: [], blankedColumns: [],
  entryId: 'JE-004412', invoiceNo: 'INV/2026/00123', gatewayRef: 'pay_QK29fT10aXbZ81',
  customerName: 'Amazon Retail India Pvt Ltd', grossAmountPaise: 130_000, discountPaise: 10_000,
  taxAmountPaise: 3_450, netAmountPaise: GROSS, entryDate: '2026-08-14', accountCode: '4100',
  postedBy: 'sysuser', memo: null, status: 'posted', ...o });

let seq = 0;
const emit = (row: ProjectedRow): EmittedRow => ({ row, sourceRowNumber: (seq += 1) });

const input = (over: Partial<AnswerKeyInput> = {}): AnswerKeyInput => {
  seq = 0;
  return {
    seed: 90_210,
    events: [evt('evt_000000', 'CLEAN_3WAY')],
    realizedDistribution: Object.fromEntries(SCENARIOS.map((s) => [s, 0])) as never,
    emitted: [emit(gw()), emit(bk()), emit(lg())],
    identityClusters: [],
    files: { gateway: 'g\n', bank: 'b\n', ledger: 'l\n' },
    ...over,
  };
};

describe('the key references file positions, never engine ids', () => {
  test('NO UUID APPEARS ANYWHERE IN THE KEY', () => {
    // §2.1: the key is written before the engine has seen the data, so it can
    // only reference file-position identity. A UUID here would mean the key had
    // been influenced by engine behaviour, and every accuracy number derived from
    // it would be meaningless.
    const serialized = serializeAnswerKey(buildAnswerKey(input()));
    assert.doesNotMatch(serialized, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  test('every projection is addressed by (sourceSystem, sourceRowNumber)', () => {
    const key = buildAnswerKey(input());
    const projections = key.events[0]!.projections;
    assert.deepEqual(projections.map((p) => p.sourceSystem), ['gateway', 'bank', 'ledger']);
    assert.deepEqual(projections.map((p) => p.sourceRowNumber), [1, 2, 3]);
  });
});

describe('determinism — the key is comparable to itself', () => {
  test('the same input serializes to identical bytes', () => {
    assert.equal(serializeAnswerKey(buildAnswerKey(input())),
      serializeAnswerKey(buildAnswerKey(input())));
  });

  test('THE MANIFEST CARRIES NO TIMESTAMP', () => {
    // §2.4 lists a generation timestamp, and it cannot have one: §1 requires
    // "same seed → byte-identical files and key", which a clock read breaks on
    // every regeneration — and it would change the key's own content hash, so the
    // artifact could never be compared against itself.
    const manifest = buildAnswerKey(input()).manifest as unknown as Record<string, unknown>;
    for (const field of Object.keys(manifest)) {
      assert.doesNotMatch(field, /time|date|at$/i, `manifest.${field} looks like a clock read`);
    }
    assert.equal(manifest['generatorVersion'], GENERATOR_VERSION);
    assert.equal(manifest['seed'], 90_210);
  });

  test('file hashes are of the emitted bytes', () => {
    const key = buildAnswerKey(input({ files: { gateway: 'A', bank: 'B', ledger: 'C' } }));
    assert.equal(key.manifest.fileHashes.gateway, sha256('A'));
    assert.notEqual(key.manifest.fileHashes.gateway, key.manifest.fileHashes.bank);
    assert.match(key.manifest.fileHashes.ledger, /^sha256:[0-9a-f]{64}$/);
  });
});

describe('viaTier — the weakest tier that should suffice (§2.2)', () => {
  test('an intact anchor means exact', () => {
    assert.equal(weakestSufficientTier(gw(), lg(), false), 'exact');
    assert.equal(weakestSufficientTier(gw(), bk(), false), 'exact');
  });

  test('a destroyed anchor drops the pair to fuzzy', () => {
    assert.equal(weakestSufficientTier(gw({ defects: ['REF_MISSING'] }), lg(), false), 'fuzzy');
    assert.equal(weakestSufficientTier(gw(), bk({ defects: ['DESC_TRUNCATED'] }), false), 'fuzzy');
    assert.equal(weakestSufficientTier(gw(), lg({ defects: ['REF_TYPO'] }), false), 'fuzzy');
  });

  test('BANK↔LEDGER IS NEVER EXACT — they share no anchor at all', () => {
    assert.equal(weakestSufficientTier(bk(), lg(), false), 'fuzzy');
  });

  test('an alias only does work once identity has to be re-established', () => {
    // With a payment_id in hand the engine never consults an alias, so a merchant
    // variant on an anchored pair does not make the pair alias-tier.
    assert.equal(weakestSufficientTier(gw(), lg(), true), 'exact');
    assert.equal(weakestSufficientTier(gw({ defects: ['REF_MISSING'] }), lg(), true), 'alias');
  });

  test('batch scenarios are reported as batch regardless of anchors', () => {
    for (const scenario of ['SPLIT_SETTLEMENT', 'UNSPLITTABLE_NET_BATCH'] as const) {
      const key = buildAnswerKey(input({ events: [evt('evt_000000', scenario)] }));
      assert.ok(key.expectedPairs.every((p) => p.viaTier === 'batch'), scenario);
    }
  });
});

describe('expectedPairs', () => {
  test('every distinct-source pair of an event is expected to match', () => {
    const key = buildAnswerKey(input());
    assert.equal(key.expectedPairs.length, 3);
    assert.ok(key.expectedPairs.every((p) => p.shouldMatch));
    assert.deepEqual(key.expectedPairs.map((p) => `${p.a.sourceSystem}-${p.b.sourceSystem}`),
      ['gateway-bank', 'gateway-ledger', 'bank-ledger']);
  });

  test('a two-source event produces exactly one pair', () => {
    seq = 0;
    const key = buildAnswerKey(input({
      events: [evt('evt_000000', 'MISSING_IN_LEDGER')],
      emitted: [emit(gw()), emit(bk())],
    }));
    assert.equal(key.expectedPairs.length, 1);
  });

  test('NEGATIVE PAIRS ARE EMITTED FOR THE IDENTITY CLUSTERS', () => {
    // Not for every non-matching pair — 850 rows is 360k of them, and the scorer
    // treats any matched pair absent from the key as a false positive anyway.
    // These are the handful the engine is most likely to guess at, and a match
    // between two cluster members is THE false positive the ceiling depends on
    // not happening.
    seq = 0;
    const ids = ['evt_a', 'evt_b', 'evt_c'];
    const key = buildAnswerKey(input({
      events: ids.map((id) => evt(id, 'IDENTITY_DESTROYED')),
      emitted: ids.map((id) => emit(gw({ eventId: id }))),
      identityClusters: [{ eventIds: ids }],
    }));
    const negative = key.expectedPairs.filter((p) => !p.shouldMatch);
    assert.equal(negative.length, 3, 'three members give three cross pairs');
    assert.ok(negative.every((p) => p.a.sourceRowNumber !== p.b.sourceRowNumber));
  });
});

describe('the key refuses to mislabel a scenario', () => {
  test('REF_MISSING_OR_TYPO with EVERY anchor destroyed throws', () => {
    // That is IDENTITY_DESTROYED by another name. Silently converting one
    // scenario into another makes the §3 weights — and the ceiling derived from
    // them — a description of something the dataset is not.
    seq = 0;
    assert.throws(() => buildAnswerKey(input({
      events: [evt('evt_000000', 'REF_MISSING_OR_TYPO')],
      emitted: [emit(gw({ defects: ['REF_MISSING'] })), emit(bk({ defects: ['DESC_TRUNCATED'] })),
        emit(lg({ defects: ['REF_TYPO'] }))],
    })), /IDENTITY_DESTROYED by another name/);
  });

  test('REF_MISSING_OR_TYPO keeping one anchor is fine, and reports mixed tiers', () => {
    seq = 0;
    const key = buildAnswerKey(input({
      events: [evt('evt_000000', 'REF_MISSING_OR_TYPO')],
      emitted: [emit(gw()), emit(bk({ defects: ['DESC_TRUNCATED'] })), emit(lg())],
    }));
    const tiers = Object.fromEntries(
      key.expectedPairs.map((p) => [`${p.a.sourceSystem}-${p.b.sourceSystem}`, p.viaTier]));
    assert.equal(tiers['gateway-ledger'], 'exact');
    assert.equal(tiers['gateway-bank'], 'fuzzy');
  });
});

describe('secondary flags', () => {
  test('a settlement outside the engine’s window is flagged TIMING_DRIFT', () => {
    seq = 0;
    const key = buildAnswerKey(input({
      emitted: [emit(gw()), emit(bk({ valueDate: '2026-08-30' })), emit(lg())],
    }));
    assert.deepEqual(key.events[0]!.expectedSecondaryFlags, ['TIMING_DRIFT']);
  });

  test('a settlement inside the window is not', () => {
    assert.deepEqual(buildAnswerKey(input()).events[0]!.expectedSecondaryFlags, []);
  });

  test('a damaged anchor suppresses the flag — identity is not established', () => {
    seq = 0;
    const key = buildAnswerKey(input({
      emitted: [emit(gw({ defects: ['REF_MISSING'] })), emit(bk({ valueDate: '2026-08-30' })), emit(lg())],
    }));
    assert.deepEqual(key.events[0]!.expectedSecondaryFlags, []);
  });
});

describe('alias key (§2.3)', () => {
  test('it lists only variants the dataset actually used', () => {
    const key = buildAnswerKey(input());
    assert.equal(key.aliasKey.length, 1);
    const entry = key.aliasKey[0]!;
    assert.equal(entry.canonical, 'AMAZON RETAIL');
    assert.deepEqual([...entry.variants].sort(), ['AMZN', 'Amazon Retail India Pvt Ltd']);
    assert.deepEqual(entry.affectedEventIds, ['evt_000000']);
  });

  test('an unseeded variant is marked held out, so cold learning is measurable', () => {
    assert.equal(buildAnswerKey(input()).aliasKey[0]!.seededForEngine, false);
    const warm = buildAnswerKey(input({
      seededVariants: new Set(['AMZN', 'Amazon Retail India Pvt Ltd']) }));
    assert.equal(warm.aliasKey[0]!.seededForEngine, true);
  });

  test('noise rows contribute no alias evidence', () => {
    seq = 0;
    const key = buildAnswerKey(input({
      emitted: [emit(gw()), emit(bk()), emit(lg()), emit(gw({ eventId: null, merchantName: 'FKRT' }))],
    }));
    assert.equal(key.aliasKey.length, 1, 'a row with no event must not create an alias expectation');
  });
});

describe('manifest', () => {
  test('the ceiling is COMPUTED from realized data', () => {
    const events = [
      ...Array.from({ length: 9 }, (_, i) => evt(`evt_r${i}`, 'CLEAN_3WAY')),
      evt('evt_u0', 'IDENTITY_DESTROYED'),
    ];
    const key = buildAnswerKey(input({ events, emitted: [] }));
    assert.equal(key.manifest.unresolvableEventCount, 1);
    assert.equal(key.manifest.theoreticalMaxMatchRatePct, 90);
    assert.equal(key.manifest.eventCount, 10);
  });

  test('record counts are per source', () => {
    const key = buildAnswerKey(input());
    assert.deepEqual(key.manifest.recordCounts, { gateway: 1, bank: 1, ledger: 1 });
  });

  test('an empty dataset does not divide by zero', () => {
    const key = buildAnswerKey(input({ events: [], emitted: [] }));
    assert.equal(key.manifest.theoreticalMaxMatchRatePct, 0);
  });
});
