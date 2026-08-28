/**
 * Phase 2's CONTRACT — what a projected source row is, before anything is
 * formatted (validation-strategy.md §1, schema.md §2.1–2.3).
 *
 * ===========================================================================
 * TYPED VALUES, NOT STRINGS. Every amount here is integer paise and every date
 * is `YYYY-MM-DD`, even though the emitted files carry `"₹1,234.50"` and three
 * different date formats. The messiness is a SERIALIZATION concern: §2.4 lists
 * `DATE_FORMAT_DIVERGENCE` as "baseline, not a defect per row", and amount
 * rendering is not in the defect catalogue at all. Keeping values typed here is
 * what lets ADR-037's invariant be an EXACT integer comparison; asserting it over
 * formatted strings would be asserting nothing.
 *
 * ROWS CARRY TRUTH; BLANKING IS RECORDED SEPARATELY. §2.1 blanks `fee` on ~15% of
 * gateway rows to force the fee-inference path, but the projection still holds
 * the true fee, with the column named in `blankedColumns`. Otherwise the
 * invariants could not check the arithmetic of the very rows most likely to be
 * wrong, and the answer key could not say what the true fee was.
 * ===========================================================================
 */

import type { BankTxnType, Direction, PaymentMethod } from '../../apps/api/src/types/domain.js';
import type { EconomicEvent } from './events.js';
import type { Scenario, SourceSlot } from './scenarios.js';

/** The §2.4 catalogue. One vocabulary for the classifier, the key and the generator. */
export const DEFECT_CODES = [
  'DATE_FORMAT_DIVERGENCE', 'TZ_MIDNIGHT_DRIFT', 'SETTLEMENT_LAG', 'AMOUNT_FEE_DELTA',
  'AMOUNT_TRUE_MISMATCH', 'MERCHANT_NAME_VARIANT', 'REF_MISSING', 'REF_TYPO',
  'DESC_TRUNCATED', 'DUPLICATE_ROW', 'MISSING_ROW', 'ORPHAN_ROW',
  'NET_SETTLEMENT_BATCH', 'SPLIT_SETTLEMENT', 'REFUND_REVERSAL', 'NOISE_ROW',
] as const;
export type DefectCode = (typeof DEFECT_CODES)[number];

export interface ProjectionBase {
  /**
   * `null` for a row with no economic event behind it — the §3 noise rows that
   * exist to verify the engine FILTERS rather than fails. `ORPHAN_NO_COUNTERPART`
   * is not one of these: it carries an event id, because the key needs a per-row
   * expectation for it (see `HAS_NO_ECONOMIC_COUNTERPART` in scenarios.ts).
   */
  eventId: string | null;
  defects: readonly DefectCode[];
  /**
   * Columns emitted blank despite the row holding a true value. Named, not
   * nulled, so the invariants still see the arithmetic.
   */
  blankedColumns: readonly string[];
}

export interface GatewayRow extends ProjectionBase {
  sourceSystem: 'gateway';
  paymentId: string;
  orderId: string | null;
  method: PaymentMethod;
  status: 'captured' | 'authorized' | 'failed' | 'refunded';
  /** Gross charged to the customer. The field ledger `net_amount` must equal (ADR-037). */
  amountPaise: number;
  currency: 'INR';
  feePaise: number;
  taxPaise: number;
  /** `amountPaise - feePaise - taxPaise`. What the bank actually credits. */
  netAmountPaise: number;
  /** `YYYY-MM-DD HH:MM:SS`, IST, no offset marker — ambiguous by design. */
  createdAt: string;
  capturedAt: string | null;
  merchantName: string;
  customerEmail: string | null;
  rrn: string | null;
  settlementId: string | null;
  notes: string | null;
}

export interface BankRow extends ProjectionBase {
  sourceSystem: 'bank';
  utr: string;
  /** ISO here; emitted `DD-MM-YYYY`. Authoritative for matching. */
  valueDate: string;
  postingDate: string;
  description: string;
  creditAmountPaise: number | null;
  debitAmountPaise: number | null;
  closingBalancePaise: number;
  bankRefNo: string | null;
  transactionType: BankTxnType;
}

export interface LedgerRow extends ProjectionBase {
  sourceSystem: 'ledger';
  entryId: string;
  invoiceNo: string;
  gatewayRef: string | null;
  customerName: string;
  grossAmountPaise: number;
  discountPaise: number;
  taxAmountPaise: number;
  /** `gross - discount + tax`, and equal to gateway `amountPaise` (ADR-037). */
  netAmountPaise: number;
  /** ISO here; emitted `MM/DD/YYYY`. */
  entryDate: string;
  accountCode: string;
  postedBy: string;
  memo: string | null;
  status: 'posted' | 'draft' | 'void';
}

export type ProjectedRow = GatewayRow | BankRow | LedgerRow;

/** One event and every row it produced. Duplicates mean two rows in one source. */
export interface EventProjection {
  event: EconomicEvent;
  rows: readonly ProjectedRow[];
}

/** Rows with no event behind them: §3's ~25 gateway and ~12 ledger noise rows. */
export interface NoiseProjection {
  rows: readonly ProjectedRow[];
}

export interface ProjectionResult {
  events: readonly EventProjection[];
  noise: NoiseProjection;
}

/** Column names per source, so `blankedColumns` cannot name a field that does not exist. */
export const SOURCE_COLUMNS: Readonly<Record<SourceSlot, readonly string[]>> = {
  gateway: ['payment_id', 'order_id', 'method', 'status', 'amount', 'currency', 'fee', 'tax',
    'net_amount', 'created_at', 'captured_at', 'merchant_name', 'customer_email', 'rrn',
    'settlement_id', 'notes'],
  bank: ['utr', 'value_date', 'posting_date', 'description', 'credit_amount', 'debit_amount',
    'closing_balance', 'bank_ref_no', 'transaction_type'],
  ledger: ['entry_id', 'invoice_no', 'gateway_ref', 'customer_name', 'gross_amount', 'discount',
    'tax_amount', 'net_amount', 'entry_date', 'account_code', 'posted_by', 'memo', 'status'],
};

/** Gateway statuses that are excluded at ingestion rather than matched and failed (§2.1). */
export const GATEWAY_NOISE_STATUSES = ['authorized', 'failed'] as const;
/** Ledger statuses excluded at ingestion (§2.3). Including them would inflate the exception count. */
export const LEDGER_NOISE_STATUSES = ['draft', 'void'] as const;
