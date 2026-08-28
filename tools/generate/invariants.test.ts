import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkProjectionInvariants, assertProjectionInvariants } from './invariants.js';
import type { BankRow, EventProjection, GatewayRow, LedgerRow, ProjectedRow, ProjectionResult } from './projection.js';
import type { EconomicEvent } from './events.js';
import type { Scenario } from './scenarios.js';

/**
 * Every invariant gets a case that VIOLATES it. An invariant with only a passing
 * test is a comment: it would keep passing if the check were deleted, and these
 * checks exist precisely because nothing downstream can detect their failure.
 */

const ID = 'evt_000042';
// 123450 - 2911 - 524 = 120015; and 130000 - 10000 + 3450 = 123450 (ADR-037 holds).
const GROSS = 123_450, FEE = 2_911, TAX = 524, NET = 120_015;

const event = (scenario: Scenario, over: Partial<EconomicEvent['canonical']> = {}): EconomicEvent => ({
  eventId: ID, scenario,
  canonical: {
    amountPaise: GROSS, date: '2026-08-14', merchant: 'AMAZON RETAIL',
    method: 'card', direction: scenario === 'REFUND_REVERSAL' ? 'debit' : 'credit', ...over,
  },
});

const gw = (over: Partial<GatewayRow> = {}): GatewayRow => ({
  sourceSystem: 'gateway', eventId: ID, defects: [], blankedColumns: [],
  paymentId: 'pay_QK29fT10aXbZ81', orderId: 'order_88121xxAB19', method: 'card',
  status: 'captured', amountPaise: GROSS, currency: 'INR', feePaise: FEE, taxPaise: TAX,
  netAmountPaise: NET, createdAt: '2026-08-14 18:42:11', capturedAt: '2026-08-14 18:42:14',
  merchantName: 'AMZN', customerEmail: null, rrn: '234567890123',
  settlementId: 'setl_KA12bR90zzQW31', notes: null, ...over,
});

const bk = (over: Partial<BankRow> = {}): BankRow => ({
  sourceSystem: 'bank', eventId: ID, defects: [], blankedColumns: [],
  utr: 'SBIN0R52026081412345', valueDate: '2026-08-16', postingDate: '2026-08-16',
  description: 'NEFT-SETL-AMZN RETAIL-234567890123-BATCH12',
  creditAmountPaise: NET, debitAmountPaise: null, closingBalancePaise: 9_900_000,
  bankRefNo: '234567890123', transactionType: 'SETTLEMENT', ...over,
});

const lg = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  sourceSystem: 'ledger', eventId: ID, defects: [], blankedColumns: [],
  entryId: 'JE-004412', invoiceNo: 'INV/2026/00123', gatewayRef: 'pay_QK29fT10aXbZ81',
  customerName: 'Amazon Retail India Pvt Ltd', grossAmountPaise: 130_000, discountPaise: 10_000,
  taxAmountPaise: 3_450, netAmountPaise: GROSS, entryDate: '2026-08-14',
  accountCode: '4100', postedBy: 'sysuser', memo: null, status: 'posted', ...over,
});

const projection = (scenario: Scenario, rows: ProjectedRow[]): EventProjection =>
  ({ event: event(scenario), rows });

const result = (events: EventProjection[], noise: ProjectedRow[] = []): ProjectionResult =>
  ({ events, noise: { rows: noise } });

const clean = (): ProjectionResult => result([projection('CLEAN_3WAY', [gw(), bk(), lg()])]);

/** The invariant names that fired. */
const fired = (r: ProjectionResult): string[] =>
  [...new Set(checkProjectionInvariants(r).map((v) => v.invariant))];

describe('a well-formed projection passes', () => {
  test('CLEAN_3WAY', () => assert.deepEqual(checkProjectionInvariants(clean()), []));

  test('every shape the scenario table declares', () => {
    const cases: [Scenario, ProjectedRow[]][] = [
      ['CLEAN_3WAY', [gw(), bk(), lg()]],
      ['TIMING_LAG_NORMAL', [gw(), bk({ valueDate: '2026-08-17' }), lg()]],
      ['FEE_NET_SETTLEMENT', [gw(), bk(), lg()]],
      ['MERCHANT_NAME_VARIANT', [gw({ merchantName: 'AMAZON RETAIL IN' }), bk(), lg()]],
      ['MISSING_IN_LEDGER', [gw(), bk()]],
      ['MISSING_IN_BANK', [gw(), lg()]],
      ['ORPHAN_NO_COUNTERPART', [bk({ transactionType: 'MISC_CREDIT', creditAmountPaise: 45_000 })]],
      ['DUPLICATE_ROW', [gw(), gw(), bk(), lg()]],
      ['SPLIT_SETTLEMENT', [gw(), bk({ creditAmountPaise: 60_000 }),
        bk({ creditAmountPaise: NET - 60_000, utr: 'SBIN0R52026081499999' }), lg()]],
      ['REFUND_REVERSAL', [gw({ status: 'refunded' }),
        bk({ transactionType: 'CHARGEBACK', creditAmountPaise: null, debitAmountPaise: NET }), lg()]],
    ];
    for (const [scenario, rows] of cases) {
      assert.deepEqual(checkProjectionInvariants(result([projection(scenario, rows)])), [],
        `${scenario} should be clean`);
    }
  });

  test('noise rows outside the event model', () => {
    assert.deepEqual(checkProjectionInvariants(result([], [
      gw({ eventId: null, status: 'failed', defects: ['NOISE_ROW'] }),
      lg({ eventId: null, status: 'void', defects: ['NOISE_ROW'] }),
      bk({ eventId: null, transactionType: 'FEE', creditAmountPaise: null,
        debitAmountPaise: 1_200, defects: ['NOISE_ROW'] }),
    ])), []);
  });
});

describe('ADR-037 — ledger net equals gateway gross, exactly', () => {
  test('a one-paise divergence is caught', () => {
    // Exact, not "within tolerance". A near-miss here is indistinguishable from a
    // rounding bug in the engine, which is the thing being measured.
    const r = result([projection('CLEAN_3WAY', [gw(), bk(), lg({ netAmountPaise: GROSS + 1 })])]);
    assert.ok(fired(r).includes('ADR-037/ledger-net-equals-gateway-gross'));
  });

  test('THE TEMPTING MISTAKE: ledger GROSS equals gateway amount', () => {
    // Emit gross-equals-gateway and every discounted sale becomes a false
    // AMOUNT_MISMATCH. The exception list fills with arithmetic artifacts and the
    // engine is scored as wrong for the generator's error.
    const bad = lg({ grossAmountPaise: GROSS, discountPaise: 10_000, taxAmountPaise: 3_450,
      netAmountPaise: GROSS - 10_000 + 3_450 });
    assert.ok(fired(result([projection('CLEAN_3WAY', [gw(), bk(), bad])]))
      .includes('ADR-037/ledger-net-equals-gateway-gross'));
  });

  test('AMOUNT_TRUE_MISMATCH is exempt, but must exceed the engine’s tolerance', () => {
    // gross must move with net, or the ledger's own arithmetic breaks instead.
    const genuine = lg({ grossAmountPaise: 180_000, netAmountPaise: 173_450 });
    assert.deepEqual(checkProjectionInvariants(
      result([projection('AMOUNT_TRUE_MISMATCH', [gw(), bk(), genuine])])), []);

    // 0.5% of ₹1234.50 is ₹6.17, so a ₹1 "mismatch" is inside the band: the
    // engine would match it correctly and the key would call that an error.
    const tooSmall = lg({ grossAmountPaise: 130_100, netAmountPaise: GROSS + 100 });
    assert.ok(fired(result([projection('AMOUNT_TRUE_MISMATCH', [gw(), bk(), tooSmall])]))
      .includes('AMOUNT_TRUE_MISMATCH-exceeds-tolerance'));
  });

  test('internal ledger arithmetic is checked too', () => {
    assert.ok(fired(result([projection('CLEAN_3WAY',
      [gw(), bk(), lg({ taxAmountPaise: 9_999 })])]))
      .includes('ledger-net-is-gross-minus-discount-plus-tax'));
  });
});

describe('ADR-034 — a duplicate carries the same strong anchor', () => {
  test('a duplicate with a DIFFERENT payment_id is caught', () => {
    // The failure that would make the dataset's hardest designed case
    // (IDENTITY_DESTROYED) indistinguishable from a retry artifact.
    const r = result([projection('DUPLICATE_ROW',
      [gw(), gw({ paymentId: 'pay_DIFFERENT0001' }), bk(), lg()])]);
    assert.ok(fired(r).includes('ADR-034/duplicate-shares-strong-anchor'));
  });

  test('a DUPLICATE_ROW event that duplicated nothing is caught', () => {
    assert.ok(fired(result([projection('DUPLICATE_ROW', [gw(), bk(), lg()])]))
      .includes('ADR-034/duplicate-appears-in-exactly-one-source'));
  });

  test('duplicating two sources at once is caught', () => {
    assert.ok(fired(result([projection('DUPLICATE_ROW', [gw(), gw(), bk(), lg(), lg()])]))
      .includes('ADR-034/duplicate-appears-in-exactly-one-source'));
  });

  test('a bank duplicate is refused — a statement does not re-emit a UTR', () => {
    assert.ok(fired(result([projection('DUPLICATE_ROW', [gw(), bk(), bk(), lg()])]))
      .includes('ADR-034/bank-does-not-duplicate'));
  });

  test('a ledger duplicate must share a non-null gateway_ref', () => {
    assert.ok(fired(result([projection('DUPLICATE_ROW',
      [gw(), bk(), lg(), lg({ gatewayRef: null })])]))
      .includes('ADR-034/duplicate-shares-strong-anchor'));
  });

  test('any OTHER scenario duplicating a row is caught', () => {
    assert.ok(fired(result([projection('CLEAN_3WAY', [gw(), gw(), bk(), lg()])]))
      .includes('only-DUPLICATE_ROW-duplicates'));
  });
});

describe('ADR-035 — direction', () => {
  test('a refund emitted as a bank CREDIT is caught', () => {
    const r = result([projection('REFUND_REVERSAL', [gw({ status: 'refunded' }), bk(), lg()])]);
    assert.ok(fired(r).includes('ADR-035/bank-leg-matches-direction'));
  });

  test('a refund whose gateway row still says captured is caught', () => {
    const r = result([projection('REFUND_REVERSAL', [gw(),
      bk({ transactionType: 'CHARGEBACK', creditAmountPaise: null, debitAmountPaise: NET }), lg()])]);
    assert.ok(fired(r).includes('ADR-035/gateway-status-matches-direction'));
  });

  test('a CHARGEBACK emitted as a credit is caught', () => {
    assert.ok(fired(result([projection('ORPHAN_NO_COUNTERPART',
      [bk({ transactionType: 'CHARGEBACK' })])]))
      .includes('bank-direction-matches-transaction-type'));
  });

  test('a bank row that is both, or neither, is caught', () => {
    assert.ok(fired(result([projection('CLEAN_3WAY',
      [gw(), bk({ debitAmountPaise: 10 }), lg()])])).includes('bank-row-is-a-credit-or-a-debit'));
    assert.ok(fired(result([projection('CLEAN_3WAY',
      [gw(), bk({ creditAmountPaise: null }), lg()])])).includes('bank-row-is-a-credit-or-a-debit'));
  });
});

describe('structure and arithmetic', () => {
  test('a scenario that kept a leg it declared missing is caught', () => {
    assert.ok(fired(result([projection('MISSING_IN_LEDGER', [gw(), bk(), lg()])]))
      .includes('sources-match-the-scenario'));
  });

  test('a scenario missing a leg it declared is caught', () => {
    assert.ok(fired(result([projection('CLEAN_3WAY', [gw(), bk()])]))
      .includes('sources-match-the-scenario'));
  });

  test('gateway net that is not amount minus fee and tax is caught', () => {
    assert.ok(fired(result([projection('CLEAN_3WAY', [gw({ netAmountPaise: NET + 1 }), bk(), lg()])]))
      .includes('gateway-net-is-amount-minus-fee-and-tax'));
  });

  test('blanking fee while emitting net is caught', () => {
    // §2.1: net_amount is blank WHENEVER fee is blank. Otherwise the row hands
    // the fee-inference path (§5.3) an answer it is meant to derive.
    assert.ok(fired(result([projection('CLEAN_3WAY',
      [gw({ blankedColumns: ['fee'] }), bk(), lg()])])).includes('blank-fee-implies-blank-net'));
    assert.deepEqual(checkProjectionInvariants(result([projection('CLEAN_3WAY',
      [gw({ blankedColumns: ['fee', 'net_amount'] }), bk(), lg()])])), []);
  });

  test('a blanked column that does not exist is caught', () => {
    assert.ok(fired(result([projection('CLEAN_3WAY',
      [gw({ blankedColumns: ['nonexistent_column'] }), bk(), lg()])]))
      .includes('blanked-columns-are-real-columns'));
  });

  test('fractional paise are caught', () => {
    assert.ok(fired(result([projection('CLEAN_3WAY',
      [gw({ amountPaise: 123_450.5, netAmountPaise: 120_015.5 }), bk(), lg()])]))
      .includes('amounts-are-whole-paise'));
  });

  test('a row claiming the wrong event is caught', () => {
    assert.ok(fired(result([projection('CLEAN_3WAY', [gw({ eventId: 'evt_999999' }), bk(), lg()])]))
      .includes('event-rows-carry-their-event-id'));
  });

  test('split legs that do not sum to the gateway net are caught', () => {
    const r = result([projection('SPLIT_SETTLEMENT', [gw(),
      bk({ creditAmountPaise: 60_000 }),
      bk({ creditAmountPaise: 60_000, utr: 'SBIN0R52026081499999' }), lg()])]);
    assert.ok(fired(r).includes('SPLIT_SETTLEMENT/legs-sum-to-net'));
  });

  test('a single settlement crediting something other than gateway net is caught', () => {
    assert.ok(fired(result([projection('CLEAN_3WAY', [gw(), bk({ creditAmountPaise: GROSS }), lg()])]))
      .includes('bank-credit-equals-gateway-net'));
  });

  test('several bank legs are legal only for SPLIT_SETTLEMENT', () => {
    // A payment settled across 2-4 credits is the one legitimate case. Anywhere
    // else a second bank row is a duplicate with no anchor evidence to find it by.
    assert.ok(fired(result([projection('CLEAN_3WAY',
      [gw(), bk({ creditAmountPaise: 60_000 }),
       bk({ creditAmountPaise: NET - 60_000, utr: 'SBIN0R52026081499999' }), lg()])]))
      .includes('only-SPLIT_SETTLEMENT-has-several-bank-legs'));
  });

  test('a batch member may carry no bank leg, but never two', () => {
    // One credit nets N payments, so at most one member event can carry it.
    assert.deepEqual(checkProjectionInvariants(result([projection('UNSPLITTABLE_NET_BATCH',
      [gw(), lg()])])), []);
    assert.ok(fired(result([projection('UNSPLITTABLE_NET_BATCH',
      [gw(), bk({ creditAmountPaise: 500_000 }),
       bk({ creditAmountPaise: 400_000, utr: 'SBIN0R52026081499999' }), lg()])]))
      .includes('only-SPLIT_SETTLEMENT-has-several-bank-legs'));
  });

  test('a batch credit is deliberately NOT checked against one event', () => {
    // It nets many events, so comparing it to this one's net would be wrong.
    assert.deepEqual(checkProjectionInvariants(result([projection('UNSPLITTABLE_NET_BATCH',
      [gw(), bk({ creditAmountPaise: 987_654 }), lg()])])), []);
  });
});

describe('noise', () => {
  test('a noise row carrying an event id is caught', () => {
    assert.ok(fired(result([], [gw({ status: 'failed', defects: ['NOISE_ROW'] })]))
      .includes('noise-rows-have-no-event'));
  });

  test('an unkeyed noise row is caught', () => {
    assert.ok(fired(result([], [gw({ eventId: null, status: 'failed' })]))
      .includes('noise-rows-are-keyed-NOISE_ROW'));
  });

  test('a reconcilable status on a noise row is caught', () => {
    assert.ok(fired(result([], [gw({ eventId: null, status: 'captured', defects: ['NOISE_ROW'] })]))
      .includes('noise-rows-carry-an-excluded-status'));
    assert.ok(fired(result([], [lg({ eventId: null, status: 'posted', defects: ['NOISE_ROW'] })]))
      .includes('noise-rows-carry-an-excluded-status'));
  });

  test('bank noise other than FEE is caught (ADR-036)', () => {
    // CHARGEBACK and MISC_CREDIT stay in the reconcilable population by design:
    // one is what a controller needs surfaced, the other IS the orphan class.
    assert.ok(fired(result([], [bk({ eventId: null, transactionType: 'MISC_CREDIT',
      defects: ['NOISE_ROW'] })])).includes('bank-noise-is-FEE-only'));
  });
});

describe('assertProjectionInvariants', () => {
  test('a clean projection does not throw', () => {
    assert.doesNotThrow(() => assertProjectionInvariants(clean()));
  });

  test('it throws, names the count, and lists every violation', () => {
    const broken = result([projection('CLEAN_3WAY',
      [gw({ netAmountPaise: 1 }), bk({ creditAmountPaise: 7 }), lg({ netAmountPaise: 9 })])]);
    assert.throws(() => assertProjectionInvariants(broken), (err: Error) => {
      assert.match(err.message, /violates 4 invariant\(s\)/);
      assert.match(err.message, /ADR-037/);
      assert.match(err.message, /gateway-net-is-amount-minus-fee-and-tax/);
      assert.match(err.message, /scored as wrong for the generator/);
      return true;
    });
  });
});
