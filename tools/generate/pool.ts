/**
 * The candidate pool for the `UNSPLITTABLE_NET_BATCH` proof — assembled with the
 * ENGINE'S OWN `buildBatchPool`, for the same reason every other §4 proof runs
 * the engine's code: a pool the generator filtered itself would be proving a
 * property of the generator's filter, not of what S10 would actually see.
 *
 * ===========================================================================
 * WHY THE POOL IS THE WHOLE REALIZED GATEWAY POPULATION, not a hand-picked
 * subset. `buildBatchPool` expects "every gateway row not yet matched to
 * anything" — the true unmatched set at S10-time — and this generator does not
 * run S1-S9, so there is no real "matched" status to consult.
 *
 * Passing the FULL gateway population is the conservative direction: it is a
 * SUPERSET of whatever the real engine's unmatched pool would be (matching only
 * ever removes rows from consideration, never adds them). If no subset of the
 * full population sums into the credit, no subset of any smaller real pool can
 * either — subset-sum is monotonic in the candidate set. A proof against the
 * superset is a strictly STRONGER proof, not a weaker approximation.
 * ===========================================================================
 */

import { buildBatchPool } from '../../apps/api/src/services/matching/batch-decomposition.js';
import type { NormalizedTransaction, RunConfig } from '../../apps/api/src/types/engine.js';
import type { BankRow, GatewayRow } from './projection.js';
import { matcherView, DEFAULT_PROOF_CONFIG } from './proofs.js';
import { normalizeBankDescription } from '../../apps/api/src/services/ingestion/normalize.js';

/**
 * A bank credit as the matcher would see it — just enough of `NormalizedTransaction`
 * for `buildBatchPool`'s own filter (`txnDate`, `counterpartyKey`/`counterpartyNorm`)
 * to run. Not a parser, for the same reason `matcherView` in proofs.ts is not one.
 */
export function bankMatcherView(row: BankRow, sourceRowNumber: number): NormalizedTransaction {
  const counterparty = normalizeBankDescription(row.description);
  return {
    id: `bank:${row.eventId ?? 'noise'}:${sourceRowNumber}`,
    runId: 'generator-proof',
    sourceSystem: 'bank',
    sourceFile: 'bank_settlement.csv',
    sourceRowNumber,
    externalId: row.utr,
    referenceIds: {},
    anchorStrength: 'none',
    amountPaise: row.creditAmountPaise ?? row.debitAmountPaise ?? 0,
    feePaise: null,
    taxPaise: null,
    netAmountPaise: null,
    currency: 'INR',
    direction: row.creditAmountPaise !== null ? 'credit' : 'debit',
    txnDate: row.valueDate,
    txnTimestamp: null,
    postingDate: row.postingDate,
    counterpartyRaw: row.description,
    counterpartyNorm: counterparty,
    counterpartyKey: null,
    method: null,
    statusRaw: row.transactionType,
    statusNorm: 'reconcilable',
    txnType: row.transactionType,
    descriptionRaw: row.description,
    duplicateOfTransactionId: null,
    duplicateKind: null,
    ingestWarnings: [],
    rawPayload: {},
  };
}

/**
 * The pool `proveUnsplittableBatch` should be given: every gateway row in the
 * realized dataset, run through the engine's real `buildBatchPool` filter
 * (date window `[credit.date-4, credit.date]`, non-contradicting counterparty,
 * ranked nearest-date-then-largest-amount, capped at `batchPoolCap`).
 *
 * Returns `capped` alongside the pool: if the true eligible set exceeds the
 * engine's own pool cap, the caller must NOT claim `stats.exhaustive` proves
 * anything (`searchSubsets`' `poolCapped` argument exists for exactly this), and
 * `assembleUnsplittableBatch` widens the merchant/date choice rather than
 * silently accepting a truncated proof.
 */
export function buildProofPool(
  credit: BankRow, creditSourceRowNumber: number,
  allGateway: readonly { row: GatewayRow; sourceRowNumber: number }[],
  config: RunConfig = DEFAULT_PROOF_CONFIG,
): { poolRows: GatewayRow[]; capped: boolean } {
  const creditView = bankMatcherView(credit, creditSourceRowNumber);
  const views = allGateway.map((g) => matcherView(g.row, g.sourceRowNumber));
  const { pool, capped } = buildBatchPool(creditView, views, config);

  const bySourceRowNumber = new Map(allGateway.map((g) => [g.sourceRowNumber, g.row]));
  const poolRows = pool.map((v) => {
    const row = bySourceRowNumber.get(v.sourceRowNumber);
    if (row === undefined) {
      throw new Error(`buildProofPool: buildBatchPool returned a row (${v.id}) not in the input set`);
    }
    return row;
  });
  return { poolRows, capped };
}
