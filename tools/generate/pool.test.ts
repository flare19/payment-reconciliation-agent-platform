import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bankMatcherView, buildProofPool } from './pool.js';
import { proveUnsplittableBatch } from './proofs.js';
import type { BankRow, GatewayRow } from './projection.js';

const gw = (over: Partial<GatewayRow> = {}): GatewayRow => ({
  sourceSystem: 'gateway', eventId: 'evt_x', defects: [], blankedColumns: [],
  paymentId: 'pay_QK29fT10aXbZ81', orderId: null, method: 'card', status: 'captured',
  amountPaise: 100_000, currency: 'INR', feePaise: 2_360, taxPaise: 425, netAmountPaise: 97_215,
  createdAt: '2026-08-14 12:00:00', capturedAt: null, merchantName: 'AMAZON RETAIL',
  customerEmail: null, rrn: '234567890123', settlementId: null, notes: null, ...over,
});

const bk = (over: Partial<BankRow> = {}): BankRow => ({
  sourceSystem: 'bank', eventId: 'evt_batch', defects: [], blankedColumns: [],
  utr: 'SBIN0R52026081412345', valueDate: '2026-08-16', postingDate: '2026-08-16',
  description: 'NEFT-SETL-AMAZON RETAIL-BATCH99', creditAmountPaise: 987_654,
  debitAmountPaise: null, closingBalancePaise: 5_000_000, bankRefNo: null,
  transactionType: 'SETTLEMENT', ...over,
});

describe('bankMatcherView', () => {
  test('a credit reads as a credit, a debit as a debit', () => {
    assert.equal(bankMatcherView(bk(), 1).direction, 'credit');
    assert.equal(bankMatcherView(bk({ creditAmountPaise: null, debitAmountPaise: 500 }), 1).direction, 'debit');
  });

  test('counterparty is normalized through the ENGINE bank-description normalizer', () => {
    const view = bankMatcherView(bk({ description: 'NEFT-SETL-AMAZON RETAIL-BATCH99' }), 1);
    assert.equal(view.counterpartyNorm, 'AMAZON RETAIL');
  });
});

describe('buildProofPool — filters through the real buildBatchPool', () => {
  const allGateway = [
    { row: gw({ createdAt: '2026-08-14 12:00:00' }), sourceRowNumber: 1 },           // in window, same merchant
    { row: gw({ createdAt: '2026-08-16 12:00:00' }), sourceRowNumber: 2 },           // in window (== credit date)
    { row: gw({ createdAt: '2026-08-01 12:00:00' }), sourceRowNumber: 3 },           // too early
    { row: gw({ createdAt: '2026-08-15 12:00:00', merchantName: 'FLIPKART' }), sourceRowNumber: 4 }, // wrong merchant
    { row: gw({ createdAt: '2026-08-17 12:00:00' }), sourceRowNumber: 5 },           // after credit date
  ];

  test('only the in-window, non-contradicting-merchant candidates survive', () => {
    const { poolRows, capped } = buildProofPool(bk(), 99, allGateway);
    assert.equal(capped, false);
    assert.deepEqual(poolRows.map((r) => r.createdAt).sort(),
      ['2026-08-14 12:00:00', '2026-08-16 12:00:00'].sort());
  });

  test('capped reports true once the pool exceeds batchPoolCap (24)', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      row: gw({ createdAt: '2026-08-16 12:00:00', paymentId: `pay_${String(i).padStart(14, '0')}` }),
      sourceRowNumber: i + 1,
    }));
    const { poolRows, capped } = buildProofPool(bk(), 99, many);
    assert.equal(capped, true);
    assert.ok(poolRows.length <= 24);
  });

  test('the assembled pool is usable directly by proveUnsplittableBatch', () => {
    // End-to-end: a credit no subset of the filtered pool can reach.
    const { poolRows } = buildProofPool(bk({ creditAmountPaise: 5_000_000 }), 99, allGateway);
    const failures = proveUnsplittableBatch(bk({ creditAmountPaise: 5_000_000 }), poolRows, 'evt_batch');
    assert.deepEqual(failures, []);
  });
});
