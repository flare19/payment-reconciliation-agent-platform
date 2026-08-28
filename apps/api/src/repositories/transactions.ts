/**
 * ALL SQL for `transactions` lives here and nowhere else (CLAUDE.md §4.1).
 *
 * One row per SOURCE ROW, never one per economic event (schema.md §3). That is
 * the single most important modelling decision in the project: normalising into
 * events at ingest would mean the matching decision had already been made by the
 * parser, and you could no longer show a panelist the three raw rows beside the
 * reason the engine believes they are one payment.
 *
 * Two things this file must respect:
 *
 *  1. `UNIQUE (run_id, source_system, source_row_number)` — `source_row_number`
 *     is the answer key's join key (validation-strategy §2.1) AND the canonical
 *     tie-break (ADR-032). It is assigned by the parser from physical file
 *     position and is never renumbered here.
 *  2. Money is BIGINT paise (ADR-006) and `pg` returns BIGINT as a STRING by
 *     default. `db/pool.ts` installs the int8 parser that makes `amount_paise` a
 *     safe integer; without it `a + b` silently concatenates.
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { getPool, type TxClient } from '../db/pool.js';
import { compareCanonical } from '../types/domain.js';
import type {
  AnchorStrength, Direction, PaymentMethod, SourceSystem, StatusNorm,
} from '../types/domain.js';
import type { NormalizedTransaction, ReferenceIds } from '../types/engine.js';

const COLUMNS = `
  id, run_id, source_system, source_file, source_row_number, external_id,
  reference_ids, anchor_strength, amount_paise, fee_paise, tax_paise,
  net_amount_paise, currency, direction, txn_date, txn_timestamp, posting_date,
  counterparty_raw, counterparty_norm, counterparty_key, method, status_raw,
  status_norm, txn_type, description_raw, duplicate_of_transaction_id,
  duplicate_kind, ingest_warnings, raw_payload`;

interface TxnRow {
  id: string;
  run_id: string;
  source_system: SourceSystem;
  source_file: string;
  source_row_number: number;
  external_id: string;
  reference_ids: ReferenceIds;
  anchor_strength: AnchorStrength;
  amount_paise: number;
  fee_paise: number | null;
  tax_paise: number | null;
  net_amount_paise: number | null;
  currency: string;
  direction: Direction;
  txn_date: string;
  txn_timestamp: Date | null;
  posting_date: string | null;
  counterparty_raw: string | null;
  counterparty_norm: string | null;
  counterparty_key: string | null;
  method: PaymentMethod | null;
  status_raw: string;
  status_norm: StatusNorm;
  txn_type: string | null;
  description_raw: string | null;
  duplicate_of_transaction_id: string | null;
  duplicate_kind: 'exact' | 'suspected' | null;
  ingest_warnings: string[];
  raw_payload: Record<string, string>;
}

function toTransaction(r: TxnRow): NormalizedTransaction {
  return {
    id: r.id,
    runId: r.run_id,
    sourceSystem: r.source_system,
    sourceFile: r.source_file,
    sourceRowNumber: r.source_row_number,
    externalId: r.external_id,
    referenceIds: r.reference_ids,
    anchorStrength: r.anchor_strength,
    amountPaise: r.amount_paise,
    feePaise: r.fee_paise,
    taxPaise: r.tax_paise,
    netAmountPaise: r.net_amount_paise,
    currency: r.currency,
    direction: r.direction,
    txnDate: r.txn_date,
    // TIMESTAMPTZ round-trips as a Date; the engine holds it as an ISO string.
    txnTimestamp: r.txn_timestamp === null ? null : r.txn_timestamp.toISOString(),
    postingDate: r.posting_date,
    counterpartyRaw: r.counterparty_raw,
    counterpartyNorm: r.counterparty_norm,
    counterpartyKey: r.counterparty_key,
    method: r.method,
    statusRaw: r.status_raw,
    statusNorm: r.status_norm,
    txnType: r.txn_type,
    descriptionRaw: r.description_raw,
    duplicateOfTransactionId: r.duplicate_of_transaction_id,
    duplicateKind: r.duplicate_kind,
    ingestWarnings: r.ingest_warnings,
    rawPayload: r.raw_payload,
  };
}

/**
 * Bulk-insert a run's transactions.
 *
 * One multi-row INSERT per chunk rather than one statement per row: at 920 rows
 * the per-statement round trip dominates, and at ADR-045's 100k-record benchmark
 * it is the difference between seconds and minutes. The chunk exists because
 * Postgres caps a statement at 65535 bind parameters and this row is 29 columns
 * wide — 2000 rows is ~58k parameters, comfortably inside it.
 */
const COLUMNS_PER_ROW = 29;
const CHUNK = 2000;

export async function insertTransactions(
  rows: readonly NormalizedTransaction[], client?: TxClient,
): Promise<number> {
  if (rows.length === 0) return 0;
  const q = client ?? getPool();
  let written = 0;

  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    chunk.forEach((t, i) => {
      const base = i * COLUMNS_PER_ROW;
      tuples.push(`(${Array.from({ length: COLUMNS_PER_ROW }, (_, k) => `$${base + k + 1}`).join(',')})`);
      values.push(
        t.id, t.runId, t.sourceSystem, t.sourceFile, t.sourceRowNumber, t.externalId,
        JSON.stringify(t.referenceIds), t.anchorStrength,
        t.amountPaise, t.feePaise, t.taxPaise, t.netAmountPaise, t.currency, t.direction,
        t.txnDate, t.txnTimestamp, t.postingDate,
        t.counterpartyRaw, t.counterpartyNorm, t.counterpartyKey,
        t.method, t.statusRaw, t.statusNorm, t.txnType, t.descriptionRaw,
        t.duplicateOfTransactionId, t.duplicateKind,
        JSON.stringify(t.ingestWarnings), JSON.stringify(t.rawPayload),
      );
    });

    const result = await q.query(
      `INSERT INTO transactions (${COLUMNS.replace(/\s+/g, ' ').trim()}) VALUES ${tuples.join(',')}`,
      values,
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

/**
 * Every transaction in a run, in CANONICAL order.
 *
 * `source_system` sorts gateway < bank < ledger by explicit CASE, not
 * alphabetically — alphabetical would give bank < gateway < ledger and silently
 * change every tie-break in the engine (ADR-032 rule 3). This ORDER BY is the
 * SQL twin of `compareCanonical`, and `listTransactions` is a decision-feeding
 * query: the orchestrator reloads the pool through it.
 */
export const CANONICAL_ORDER_SQL = `
  ORDER BY CASE source_system WHEN 'gateway' THEN 0 WHEN 'bank' THEN 1 ELSE 2 END,
           source_row_number`;

export async function listTransactions(runId: string): Promise<NormalizedTransaction[]> {
  const { rows } = await getPool().query<TxnRow>(
    `SELECT ${COLUMNS} FROM transactions WHERE run_id = $1 ${CANONICAL_ORDER_SQL}`, [runId]);
  return rows.map(toTransaction);
}

export async function findTransaction(id: string): Promise<NormalizedTransaction | null> {
  const { rows } = await getPool().query<TxnRow>(
    `SELECT ${COLUMNS} FROM transactions WHERE id = $1`, [id]);
  return rows.length === 0 ? null : toTransaction(rows[0]!);
}

/**
 * Rows outside the reconcilable denominator (endpoint 24).
 *
 * Excluded is not hidden (schema.md §2.2): these are counted, listed and
 * visible, with the reason attached. A denominator you cannot inspect is a
 * denominator nobody should believe.
 */
export async function listNonReconcilable(
  runId: string, kind: 'excluded' | 'duplicates', limit: number, offset: number,
): Promise<{ items: NormalizedTransaction[]; total: number }> {
  const predicate = kind === 'excluded'
    ? `status_norm <> 'reconcilable'`
    : `duplicate_of_transaction_id IS NOT NULL`;
  const pool = getPool();
  const [page, count] = await Promise.all([
    pool.query<TxnRow>(
      `SELECT ${COLUMNS} FROM transactions
        WHERE run_id = $1 AND ${predicate} ${CANONICAL_ORDER_SQL} LIMIT $2 OFFSET $3`,
      [runId, limit, offset]),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM transactions WHERE run_id = $1 AND ${predicate}`,
      [runId]),
  ]);
  return { items: page.rows.map(toTransaction), total: count.rows[0]!.count };
}

/** S4's verdict: mark non-primary copies. Both columns move together (`txn_dupe_fields_paired`). */
export async function markDuplicates(
  marks: readonly { transactionId: string; primaryId: string; kind: 'exact' | 'suspected' }[],
  client?: TxClient,
): Promise<void> {
  if (marks.length === 0) return;
  await (client ?? getPool()).query(
    `UPDATE transactions AS t
        SET duplicate_of_transaction_id = m.primary_id::uuid,
            duplicate_kind              = m.kind
       FROM unnest($1::uuid[], $2::uuid[], $3::text[]) AS m(txn_id, primary_id, kind)
      WHERE t.id = m.txn_id`,
    [marks.map((m) => m.transactionId), marks.map((m) => m.primaryId), marks.map((m) => m.kind)],
  );
}

/** S7 populates `counterparty_key` on every pooled record (NULL until Tier 1.5 runs). */
export async function setCounterpartyKeys(
  updates: readonly { transactionId: string; counterpartyKey: string | null }[],
  client?: TxClient,
): Promise<void> {
  if (updates.length === 0) return;
  await (client ?? getPool()).query(
    `UPDATE transactions AS t
        SET counterparty_key = u.key
       FROM unnest($1::uuid[], $2::text[]) AS u(txn_id, key)
      WHERE t.id = u.txn_id`,
    [updates.map((u) => u.transactionId), updates.map((u) => u.counterpartyKey)],
  );
}

/** Exported so a caller can assert the SQL order matches the TS comparator. */
export { compareCanonical };
