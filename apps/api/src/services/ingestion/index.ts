/**
 * Ingestion entry point — stages S1–S3 (matching-engine.md §1).
 *
 *   S1 PARSE      per-source parsers, rejected-row capture (ADR-046)
 *   S2 NORMALIZE  paise, IST business date, counterparty_norm, anchor extraction
 *   S3 EXCLUDE    non-reconcilable statuses marked (kept, counted, out of matching)
 *
 * The three parsers are independent and individually tested; this module only
 * runs them in canonical source order, concatenates, and computes the two
 * whole-run aggregates that need every row: the ADR-039 reference date and the
 * population counts S4 and the run record need.
 *
 * A whole-file parse failure propagates as `CsvParseError` — the orchestrator
 * turns that into a failed run with `PARSE_FAILED` (matching-engine.md §12).
 */

import type { IngestionResult, NormalizedTransaction, RejectedRow } from '../../types/engine.js';
import { parseGatewayFile } from './gateway-parser.js';
import { parseBankFile } from './bank-parser.js';
import { parseLedgerFile } from './ledger-parser.js';

export { CsvParseError } from './csv.js';
export { parseGatewayFile } from './gateway-parser.js';
export { parseBankFile } from './bank-parser.js';
export { parseLedgerFile } from './ledger-parser.js';

export interface IngestionInput {
  runId: string;
  files: {
    gateway: string;
    bank: string;
    ledger: string;
  };
  /** Overrides `transactions.source_file`; defaults per source. */
  fileNames?: {
    gateway?: string;
    bank?: string;
    ledger?: string;
  };
}

export function ingestSources(input: IngestionInput): IngestionResult {
  const { runId } = input;
  const gateway = parseGatewayFile({ runId, text: input.files.gateway, ...pick(input.fileNames?.gateway) });
  const bank = parseBankFile({ runId, text: input.files.bank, ...pick(input.fileNames?.bank) });
  const ledger = parseLedgerFile({ runId, text: input.files.ledger, ...pick(input.fileNames?.ledger) });

  // Canonical order: gateway, then bank, then ledger — and within each, row
  // order 1..N. That is exactly `compareCanonical` order, so nothing downstream
  // has to re-sort ingestion output to stay deterministic (ADR-032).
  const transactions: NormalizedTransaction[] = [
    ...gateway.transactions,
    ...bank.transactions,
    ...ledger.transactions,
  ];
  const rejectedRows: RejectedRow[] = [
    ...gateway.rejectedRows,
    ...bank.rejectedRows,
    ...ledger.rejectedRows,
  ];

  const excluded = transactions.filter((t) => t.statusNorm !== 'reconcilable').length;

  // ADR-039: MAX(txnDate) over every ingested transaction, excluded rows
  // included. `YYYY-MM-DD` strings sort lexicographically as dates.
  let referenceDate: string | null = null;
  for (const t of transactions) {
    if (referenceDate === null || t.txnDate > referenceDate) referenceDate = t.txnDate;
  }

  return {
    transactions,
    rejectedRows,
    referenceDate,
    counts: {
      gateway: gateway.transactions.length,
      bank: bank.transactions.length,
      ledger: ledger.transactions.length,
      excluded,
      rejected: rejectedRows.length,
    },
  };
}

/** `exactOptionalPropertyTypes` forbids passing `sourceFile: undefined` — omit the key instead. */
function pick(name: string | undefined): { sourceFile?: string } {
  return name === undefined ? {} : { sourceFile: name };
}
