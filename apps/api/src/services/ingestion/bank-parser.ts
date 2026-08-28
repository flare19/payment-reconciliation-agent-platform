/**
 * Source B — Bank Settlement File parser (schema.md §2.2).
 *
 * The messiest source: identity lives inside a free-text `description` blob, the
 * date format is `DD-MM-YYYY` (different from both other sources on purpose), and
 * a credit row and a debit row are told apart only by which amount column is
 * populated.
 *
 * Exclusion (ADR-036): `FEE` rows are excluded at ingestion — gateway fees are
 * already inside every net-amount comparison, so reconciling a fee debit
 * separately would double-count it and manufacture a permanent block of
 * `MISSING_IN_GATEWAY` non-problems. `CHARGEBACK` and `MISC_CREDIT` stay in the
 * reconcilable population — an unmatched chargeback is exactly what a controller
 * needs surfaced.
 */

import { randomUUID } from 'node:crypto';

import type { Direction, StatusNorm } from '../../types/domain.js';
import type { NormalizedTransaction, ParsedSourceResult, ReferenceIds, RejectedRow } from '../../types/engine.js';
import { readCsv } from './csv.js';
import { normalizeBankDescription } from './normalize.js';
import { anchorStrengthOf, extractDescriptionAnchors } from './anchor-extraction.js';
import { fieldReader, isBlank, rawPayloadOf, rejectedRow, RowContext, RowReject } from './parse-helpers.js';

const SOURCE = 'bank' as const;
const DEFAULT_FILE = 'bank_settlement.csv';

/** schema.md §2.2. `FEE` is reconcilable-eligible only to be explicitly excluded. */
const KNOWN_TXN_TYPES = new Set(['SETTLEMENT', 'NEFT', 'IMPS', 'UPI', 'CHARGEBACK', 'FEE', 'MISC_CREDIT']);

export interface BankParseInput {
  runId: string;
  text: string;
  sourceFile?: string;
}

export function parseBankFile(input: BankParseInput): ParsedSourceResult {
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

      // Direction is decided by which amount column carries a value, and exactly
      // one must (schema.md §2.2). Neither, or both, is a malformed row.
      const creditRaw = f('credit_amount');
      const debitRaw = f('debit_amount');
      const hasCredit = !isBlank(creditRaw);
      const hasDebit = !isBlank(debitRaw);
      if (hasCredit && hasDebit) throw ctx.reject('both credit_amount and debit_amount are populated');
      if (!hasCredit && !hasDebit) throw ctx.reject('neither credit_amount nor debit_amount is populated');

      const direction: Direction = hasCredit ? 'credit' : 'debit';
      const amountPaise = ctx.requireMoney(hasCredit ? 'credit_amount' : 'debit_amount', hasCredit ? creditRaw : debitRaw);
      if (amountPaise < 0) ctx.warn('AMOUNT_NEGATIVE_MAGNITUDE');

      const value = ctx.requireDate('value_date', f('value_date'), 'DD-MM-YYYY');
      const posting = ctx.optionalDate('posting_date', f('posting_date'), 'DD-MM-YYYY');

      const txnType = f('transaction_type').trim();
      let statusNorm: StatusNorm;
      if (txnType === 'FEE') {
        statusNorm = 'excluded_non_reconcilable'; // ADR-036
      } else if (KNOWN_TXN_TYPES.has(txnType)) {
        statusNorm = 'reconcilable';
      } else {
        statusNorm = 'excluded_non_reconcilable';
        ctx.warn('TXN_TYPE_UNRECOGNISED');
      }

      const utr = f('utr').trim();
      const bankRefNo = f('bank_ref_no').trim();
      const description = f('description');
      const extracted = extractDescriptionAnchors(description);

      const refs: ReferenceIds = {};
      if (utr !== '') refs.utr = utr;
      if (bankRefNo !== '') refs.bank_ref_no = bankRefNo;
      // Description-recovered tokens are ALWAYS weak (schema.md §3.1) — they go
      // here, never into a structured key.
      if (extracted.length > 0) refs.extracted_from_description = extracted;

      const counterpartyRaw = isBlank(description) ? null : description;

      transactions.push({
        id: randomUUID(),
        runId: input.runId,
        sourceSystem: SOURCE,
        sourceFile,
        sourceRowNumber: row.sourceRowNumber,

        externalId: utr !== '' ? utr : `${sourceFile}#${row.sourceRowNumber}`,
        referenceIds: refs,
        anchorStrength: anchorStrengthOf(refs),

        amountPaise,
        feePaise: null,
        taxPaise: null,
        netAmountPaise: null, // the bank credit IS the net figure; matching reads amountPaise (schema.md §5.3.1)
        currency: 'INR',
        direction,

        txnDate: value.businessDate,
        txnTimestamp: null, // date-granularity source
        postingDate: posting?.businessDate ?? null,

        counterpartyRaw,
        counterpartyNorm: normalizeBankDescription(counterpartyRaw),
        counterpartyKey: null,

        method: null,
        statusRaw: txnType,
        statusNorm,
        txnType: txnType === '' ? null : txnType,

        descriptionRaw: counterpartyRaw,

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
