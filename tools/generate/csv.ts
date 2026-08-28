/**
 * Phase 3, file half — projected rows to the three CSV files (schema.md §2).
 *
 * Also assigns `source_row_number`: schema.md §3 requires it be "the physical
 * file position, header = row 0", so it can only be decided HERE, at the moment
 * a row's position in the file is fixed — everything upstream works with rows
 * that do not have one yet.
 */

import type { Rng } from './prng.js';
import { formatMessyRupees, formatPlainRupees, formatGatewayTimestamp, formatDDMMYYYY, formatMMDDYYYY } from './format.js';
import { SOURCE_COLUMNS, type BankRow, type GatewayRow, type LedgerRow, type ProjectedRow, type ProjectionResult } from './projection.js';
import type { EmittedRow } from './answer-key.js';

export interface EmittedFiles {
  gateway: string;
  bank: string;
  ledger: string;
  /** Every emitted row across all three files, with the position it landed at — `buildAnswerKey`'s input. */
  emitted: readonly EmittedRow[];
}

/** RFC 4180 quoting: only when the field actually needs it, so most output stays readable. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function row(columns: readonly string[], values: Readonly<Record<string, string>>): string {
  return columns.map((c) => csvField(values[c] ?? '')).join(',');
}

const blank = (r: ProjectedRow, column: string): boolean => r.blankedColumns.includes(column);
const emit = (r: ProjectedRow, column: string, value: string): string => (blank(r, column) ? '' : value);

function gatewayRow(g: GatewayRow, rng: Rng): Record<string, string> {
  return {
    payment_id: emit(g, 'payment_id', g.paymentId),
    order_id: g.orderId === null || blank(g, 'order_id') ? '' : g.orderId,
    method: g.method,
    status: g.status,
    amount: formatMessyRupees(rng, g.amountPaise),
    currency: g.currency,
    fee: emit(g, 'fee', formatMessyRupees(rng, g.feePaise)),
    tax: emit(g, 'tax', formatMessyRupees(rng, g.taxPaise)),
    net_amount: emit(g, 'net_amount', formatMessyRupees(rng, g.netAmountPaise)),
    created_at: g.createdAt,
    captured_at: g.capturedAt === null || blank(g, 'captured_at') ? '' : g.capturedAt,
    merchant_name: g.merchantName,
    customer_email: g.customerEmail ?? '',
    rrn: g.rrn === null || blank(g, 'rrn') ? '' : g.rrn,
    settlement_id: g.settlementId === null || blank(g, 'settlement_id') ? '' : g.settlementId,
    notes: g.notes ?? '',
  };
}

function bankRow(b: BankRow): Record<string, string> {
  return {
    utr: b.utr,
    value_date: formatDDMMYYYY(b.valueDate),
    posting_date: formatDDMMYYYY(b.postingDate),
    description: b.description,
    credit_amount: b.creditAmountPaise === null ? '' : formatPlainRupees(b.creditAmountPaise),
    debit_amount: b.debitAmountPaise === null ? '' : formatPlainRupees(b.debitAmountPaise),
    closing_balance: formatPlainRupees(b.closingBalancePaise),
    bank_ref_no: b.bankRefNo ?? '',
    transaction_type: b.transactionType,
  };
}

function ledgerRow(l: LedgerRow): Record<string, string> {
  return {
    entry_id: l.entryId,
    invoice_no: l.invoiceNo,
    gateway_ref: l.gatewayRef === null || blank(l, 'gateway_ref') ? '' : l.gatewayRef,
    customer_name: l.customerName,
    gross_amount: formatPlainRupees(l.grossAmountPaise),
    discount: formatPlainRupees(l.discountPaise),
    tax_amount: formatPlainRupees(l.taxAmountPaise),
    net_amount: formatPlainRupees(l.netAmountPaise),
    entry_date: formatMMDDYYYY(l.entryDate),
    account_code: l.accountCode,
    posted_by: l.postedBy,
    memo: l.memo ?? '',
    status: l.status,
  };
}

/**
 * Every row from `result`, real events and noise together, serialized into the
 * three files.
 *
 * Row ORDER within each file is shuffled by a dedicated sub-stream rather than
 * left in event-generation order — a real export is not sorted by anything the
 * generator's own internal event index would produce, and leaving it in that
 * order would be an artifact a careful reader could notice (every noise row
 * trailing at the end, or rows for one scenario clustering together).
 */
export function serializeToCsv(rng: Rng, result: ProjectionResult): EmittedFiles {
  const moneyStyle = rng.derive('emission.money-style');
  const order = rng.derive('emission.order');

  const bySource: Record<'gateway' | 'bank' | 'ledger', ProjectedRow[]> = { gateway: [], bank: [], ledger: [] };
  for (const projection of result.events) for (const r of projection.rows) bySource[r.sourceSystem].push(r);
  for (const r of result.noise.rows) bySource[r.sourceSystem].push(r);

  const emitted: EmittedRow[] = [];
  const files: Record<'gateway' | 'bank' | 'ledger', string> = { gateway: '', bank: '', ledger: '' };

  for (const source of ['gateway', 'bank', 'ledger'] as const) {
    const shuffled = order.shuffle(bySource[source]);
    const columns = SOURCE_COLUMNS[source];
    const lines = [columns.join(',')];
    shuffled.forEach((r, i) => {
      const sourceRowNumber = i + 1; // header occupies row 0 (schema.md §3)
      emitted.push({ row: r, sourceRowNumber });
      const values = source === 'gateway' ? gatewayRow(r as GatewayRow, moneyStyle)
        : source === 'bank' ? bankRow(r as BankRow) : ledgerRow(r as LedgerRow);
      lines.push(row(columns, values));
    });
    files[source] = `${lines.join('\n')}\n`;
  }

  return { ...files, emitted };
}
