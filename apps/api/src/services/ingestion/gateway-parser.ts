/**
 * Source A — Payment Gateway Export parser (schema.md §2.1).
 *
 * The most structured source and the anchor for identity. One physical data row
 * in, one `NormalizedTransaction` OR one `RejectedRow` out (ADR-046). Ingestion
 * is lossless and opinion-free (ADR-003): every judgement is deferred to the
 * matching engine, `raw_payload` keeps the original bytes.
 *
 * Exclusion (schema.md §2.1): only `captured` and `refunded` are reconcilable.
 * `failed` / `authorized` rows are EXCLUDED — kept, counted, visible, but out of
 * the matching population — not matched-and-failed. `refunded` normalises to
 * `direction = 'debit'` (ADR-035).
 */

import { randomUUID } from 'node:crypto';

import type { Direction, PaymentMethod, StatusNorm } from '../../types/domain.js';
import type { NormalizedTransaction, ParsedSourceResult, ReferenceIds, RejectedRow } from '../../types/engine.js';
import { readCsv } from './csv.js';
import { normalizeCounterparty } from './normalize.js';
import { anchorStrengthOf } from './anchor-extraction.js';
import { fieldReader, isBlank, rawPayloadOf, rejectedRow, RowContext, RowReject } from './parse-helpers.js';

const SOURCE = 'gateway' as const;
const DEFAULT_FILE = 'gateway_export.csv';
const METHODS = new Set<PaymentMethod>(['card', 'upi', 'netbanking', 'wallet']);

export interface GatewayParseInput {
  runId: string;
  text: string;
  /** For `transactions.source_file` and the synthetic `external_id` fallback. */
  sourceFile?: string;
}

export function parseGatewayFile(input: GatewayParseInput): ParsedSourceResult {
  const sourceFile = input.sourceFile ?? DEFAULT_FILE;
  const doc = readCsv(input.text); // throws CsvParseError on a whole-file failure
  const transactions: NormalizedTransaction[] = [];
  const rejectedRows: RejectedRow[] = [];

  for (const row of doc.rows) {
    const ctx = new RowContext();
    try {
      if (row.fields.length !== doc.header.length) {
        throw ctx.reject(`expected ${doc.header.length} columns, got ${row.fields.length}`);
      }
      const f = fieldReader(doc.header, row);

      const paymentId = f('payment_id').trim();
      const orderId = f('order_id').trim();
      const rrn = f('rrn').trim();
      const settlementId = f('settlement_id').trim();

      const refs: ReferenceIds = {};
      if (paymentId !== '') refs.payment_id = paymentId;
      if (orderId !== '') refs.order_id = orderId;
      if (rrn !== '') refs.rrn = rrn;
      if (settlementId !== '') refs.settlement_id = settlementId;

      const statusRaw = f('status').trim();
      let statusNorm: StatusNorm;
      let direction: Direction = 'credit';
      switch (statusRaw) {
        case 'captured':
          statusNorm = 'reconcilable';
          break;
        case 'refunded':
          statusNorm = 'reconcilable';
          direction = 'debit'; // ADR-035: reconciles against a bank debit / CHARGEBACK
          break;
        case 'failed':
          statusNorm = 'excluded_failed';
          break;
        case 'authorized':
          statusNorm = 'excluded_authorized';
          break;
        default:
          statusNorm = 'excluded_non_reconcilable';
          ctx.warn('STATUS_UNRECOGNISED');
      }

      const currency = (f('currency').trim() || 'INR').toUpperCase();
      if (currency !== 'INR') ctx.warn('CURRENCY_NOT_INR');

      const amountPaise = ctx.requireMoney('amount', f('amount'));
      const feePaise = ctx.optionalMoney('fee', f('fee'));
      const taxPaise = ctx.optionalMoney('tax', f('tax'));
      let netAmountPaise = ctx.optionalMoney('net_amount', f('net_amount'));
      // schema.md §3: net is NULL only when "not reported AND not derivable".
      // With fee and tax both stated it is derivable, and the audit trail must
      // say the engine computed it.
      if (netAmountPaise === null && feePaise !== null && taxPaise !== null) {
        netAmountPaise = amountPaise - feePaise - taxPaise;
        ctx.warn('NET_AMOUNT_DERIVED');
      }

      const created = ctx.requireDate('created_at', f('created_at'), 'YYYY-MM-DD HH:MM:SS');
      const captured = ctx.optionalDate('captured_at', f('captured_at'), 'YYYY-MM-DD HH:MM:SS');
      // schema.md §2.1: captured_at is the preferred date anchor when present.
      const preferred = captured ?? created;

      const methodRaw = f('method').trim().toLowerCase();
      const method: PaymentMethod | null = METHODS.has(methodRaw as PaymentMethod)
        ? (methodRaw as PaymentMethod)
        : null;
      if (method === null && methodRaw !== '') ctx.warn('METHOD_UNRECOGNISED');

      const merchant = f('merchant_name');
      const counterpartyRaw = isBlank(merchant) ? null : merchant;

      transactions.push({
        id: randomUUID(),
        runId: input.runId,
        sourceSystem: SOURCE,
        sourceFile,
        sourceRowNumber: row.sourceRowNumber,

        externalId: paymentId !== '' ? paymentId : `${sourceFile}#${row.sourceRowNumber}`,
        referenceIds: refs,
        anchorStrength: anchorStrengthOf(refs),

        amountPaise,
        feePaise,
        taxPaise,
        netAmountPaise,
        currency,
        direction,

        txnDate: preferred.businessDate,
        txnTimestamp: preferred.timestampUtc,
        postingDate: null,

        counterpartyRaw,
        counterpartyNorm: normalizeCounterparty(counterpartyRaw),
        counterpartyKey: null, // set at S7 (Tier 1.5)

        method,
        statusRaw,
        statusNorm,
        txnType: null,

        descriptionRaw: isBlank(f('notes')) ? null : f('notes'),

        duplicateOfTransactionId: null, // set at S4
        duplicateKind: null,

        ingestWarnings: ctx.warnings,
        rawPayload: rawPayloadOf(doc.header, row),
      });
    } catch (err) {
      if (err instanceof RowReject) rejectedRows.push(rejectedRow(SOURCE, row, err.error));
      else throw err;
    }
  }

  return { transactions, rejectedRows };
}
