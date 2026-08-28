/**
 * Source C — Merchant Ledger parser (schema.md §2.3).
 *
 * An internal accounting export: structured, but written to a different
 * system's conventions. Date format is `MM/DD/YYYY` (US order, the third
 * distinct format) and the parser is TOLD that — it never infers, because
 * ~40% of ledger dates are ambiguous with `DD/MM/YYYY` and a guessing parser is
 * silently wrong on roughly a fifth of rows (schema.md §2.3, ADR-070).
 *
 * Amount basis (ADR-037): the field that equals gateway `amount` is ledger
 * `net_amount` (`gross - discount + tax`), NOT gross. `net_amount_paise` is what
 * the matching engine compares; `discount` has no column and is carried only in
 * `raw_payload`.
 *
 * Exclusion (schema.md §2.3): only `posted` is reconcilable. `draft` / `void`
 * are excluded at ingestion — including them would inflate the exception count.
 */

import { randomUUID } from 'node:crypto';

import type { StatusNorm } from '../../types/domain.js';
import type { NormalizedTransaction, ParsedSourceResult, ReferenceIds, RejectedRow } from '../../types/engine.js';
import { readCsv } from './csv.js';
import { normalizeCounterparty } from './normalize.js';
import { anchorStrengthOf } from './anchor-extraction.js';
import { fieldReader, isBlank, rawPayloadOf, rejectedRow, RowContext, RowReject } from './parse-helpers.js';

const SOURCE = 'ledger' as const;
const DEFAULT_FILE = 'merchant_ledger.csv';

export interface LedgerParseInput {
  runId: string;
  text: string;
  sourceFile?: string;
}

export function parseLedgerFile(input: LedgerParseInput): ParsedSourceResult {
  const sourceFile = input.sourceFile ?? DEFAULT_FILE;
  const doc = readCsv(input.text);
  const transactions: NormalizedTransaction[] = [];
  const rejectedRows: RejectedRow[] = [];

  for (const row of doc.rows) {
    const ctx = new RowContext();
    try {
      if (row.fields.length !== doc.header.length) {
        throw ctx.reject(`expected ${doc.header.length} columns, got ${row.fields.length}`);
      }
      const f = fieldReader(doc.header, row);

      const entryId = f('entry_id').trim();
      const invoiceNo = f('invoice_no').trim();
      const gatewayRef = f('gateway_ref').trim();

      const refs: ReferenceIds = {};
      if (entryId !== '') refs.entry_id = entryId;
      if (invoiceNo !== '') refs.invoice_no = invoiceNo;
      // `gateway_ref` is meant to be the gateway `payment_id`. It is blank on
      // ~12% and transposed on ~4% (schema.md §2.3) — ingestion records what the
      // source stated; only matching can tell a transposition from the truth.
      if (gatewayRef !== '') refs.payment_id = gatewayRef;

      const statusRaw = f('status').trim();
      let statusNorm: StatusNorm;
      switch (statusRaw) {
        case 'posted':
          statusNorm = 'reconcilable';
          break;
        case 'draft':
          statusNorm = 'excluded_draft';
          break;
        case 'void':
          statusNorm = 'excluded_void';
          break;
        default:
          statusNorm = 'excluded_non_reconcilable';
          ctx.warn('STATUS_UNRECOGNISED');
      }

      const amountPaise = ctx.requireMoney('gross_amount', f('gross_amount'));
      const taxPaise = ctx.optionalMoney('tax_amount', f('tax_amount'));
      const netAmountPaise = ctx.requireMoney('net_amount', f('net_amount'));

      const entryDate = ctx.requireDate('entry_date', f('entry_date'), 'MM/DD/YYYY');

      const customer = f('customer_name');
      const counterpartyRaw = isBlank(customer) ? null : customer;

      transactions.push({
        id: randomUUID(),
        runId: input.runId,
        sourceSystem: SOURCE,
        sourceFile,
        sourceRowNumber: row.sourceRowNumber,

        externalId: entryId !== '' ? entryId : `${sourceFile}#${row.sourceRowNumber}`,
        referenceIds: refs,
        anchorStrength: anchorStrengthOf(refs),

        amountPaise, // gross as the source states it (schema.md §3)
        feePaise: null,
        taxPaise,
        netAmountPaise, // ADR-037: this is what equals gateway `amount`
        currency: 'INR',
        direction: 'credit', // a posted sale entry

        txnDate: entryDate.businessDate,
        txnTimestamp: null,
        postingDate: null,

        counterpartyRaw,
        counterpartyNorm: normalizeCounterparty(counterpartyRaw),
        counterpartyKey: null,

        method: null,
        statusRaw,
        statusNorm,
        txnType: null,

        descriptionRaw: isBlank(f('memo')) ? null : f('memo'),

        duplicateOfTransactionId: null,
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
