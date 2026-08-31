/**
 * S13 — discrepancy signatures (schema.md §10.2, ADR-018).
 *
 * A signature is the STRUCTURAL SHAPE of an exception with every specific
 * stripped out: no amounts, no ids, no merchant names. It is the cache key, and
 * the reason S13 costs O(distinct discrepancy shapes) rather than O(exceptions)
 * — ~75 exceptions on a 300-record batch collapse to 15–30 signatures, and a
 * re-run of the same dataset shape is a 100% cache hit.
 *
 * `prompt_version` and `model` are hashed IN (ADR-018): a change to either must
 * invalidate every cached row, or a run would serve prose written by a model it
 * no longer uses. That is a feature, not a cost — do not try to make the cache
 * survive a model switch (ADR-080 consequence 1).
 *
 * ── Where the bucket inputs come from ──
 * Six of the ten components are on the exception and its evidence directly
 * (category, anchor strength, alias involvement, candidate count,
 * secondary flags). The other two — the amount and date delta buckets — and
 * `sources_present` need the actual records, so the caller passes a
 * `Map<transactionId, tx>` covering the run's pool. Bucketing a known delta into
 * a coarse band is DESCRIPTION, not decision: the category is already final
 * (ADR-017), and nothing here can change it.
 *
 * For a presence exception (`MISSING_IN_*`) there is by definition no
 * counterpart, so there is no delta to bucket. Those get `amount_delta: 'none'`
 * and `date_delta: 'within_window'` — the honest reading of "this is not a
 * dated-value discrepancy", chosen over `'same_day'`, which would assert a
 * comparison that never happened. It only affects cache-key granularity.
 */

import { createHash } from 'node:crypto';

import type { AnchorStrength, ExceptionCategory, SourceSystem } from '../../types/domain.js';
import type { ExceptionEvidence } from '../../types/engine.js';
import { dayDelta } from '../ingestion/dates.js';

/** The minimum a record must expose for signature bucketing. */
export interface TxForSignature {
  sourceSystem: SourceSystem;
  amountPaise: number;
  txnDate: string;
}

/**
 * The minimum an exception must expose to be signed.
 *
 * Structural rather than nominal so that BOTH `ClassifiedException` (S12's
 * in-memory output) and `ExceptionRecord` (the persisted row) satisfy it. S13
 * runs over the persisted rows — §10.1 requires the explain layer to run after
 * `exceptions` is already committed — but the signature is the same computation
 * either way, and a second copy of it would be a second cache namespace.
 */
export interface ExceptionForSignature {
  transactionId: string | null;
  relatedTransactionIds: string[];
  category: ExceptionCategory;
  secondaryFlags: ExceptionCategory[];
  evidence: ExceptionEvidence;
}

export type AmountDeltaBucket =
  | 'none' | 'lt_1pct' | '1_to_3pct' | '3_to_10pct' | 'gt_10pct' | 'sign_flip';
export type DateDeltaBucket =
  | 'same_day' | 'within_window' | 'plus_1_3d' | 'plus_4_7d' | 'gt_7d' | 'negative';
export type CandidateCountBucket = '0' | '1' | '2_3' | 'gt_3';

/** The pre-hash components — stored verbatim in `explanation_cache.signature_input`. */
export interface SignatureComponents {
  promptVersion: string;
  model: string;
  category: ExceptionCategory;
  amountDeltaBucket: AmountDeltaBucket;
  dateDeltaBucket: DateDeltaBucket;
  sourcesPresent: string;
  anchorStrength: AnchorStrength;
  aliasInvolved: 'yes' | 'no';
  candidateCountBucket: CandidateCountBucket;
  /** Secondary categories in a stable order, comma-joined; `''` when there are none. */
  secondaryFlagsSorted: string;
}

export interface Signature {
  hash: string;
  components: SignatureComponents;
}

/** Categories whose primary claim is a value disagreement between two known records. */
const VALUE_CATEGORIES: ReadonlySet<ExceptionCategory> = new Set<ExceptionCategory>([
  'AMOUNT_MISMATCH',
]);

/** Canonical source order, so `sources_present` is permutation-stable. */
const SOURCE_ORDER: Record<SourceSystem, number> = { gateway: 0, bank: 1, ledger: 2 };

export function candidateCountBucket(n: number): CandidateCountBucket {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 3) return '2_3';
  return 'gt_3';
}

/**
 * Bucket a proportional amount delta.
 *
 * `sign_flip` is intentionally unreachable here: `direction` is a hard gate at
 * every tier (schema.md §0), so a credit is never compared against a debit and
 * two records that reach an amount-mismatch verdict already agree on sign. It
 * stays in the type because the signature spec lists it.
 */
export function amountDeltaBucket(selfPaise: number, otherPaise: number): AmountDeltaBucket {
  const delta = Math.abs(selfPaise - otherPaise);
  if (delta === 0) return 'none';
  const basis = Math.max(Math.abs(selfPaise), Math.abs(otherPaise), 1);
  const pct = delta / basis;
  if (pct < 0.01) return 'lt_1pct';
  if (pct < 0.03) return '1_to_3pct';
  if (pct < 0.10) return '3_to_10pct';
  return 'gt_10pct';
}

/** `delta` is counterpart date − record date, in days (positive = counterpart later). */
export function dateDeltaBucket(delta: number): DateDeltaBucket {
  if (delta < 0) return 'negative';
  if (delta === 0) return 'same_day';
  if (delta <= 3) return 'plus_1_3d';
  if (delta <= 7) return 'plus_4_7d';
  return 'gt_7d';
}

function sourcesPresent(
  exception: ExceptionForSignature, txById: ReadonlyMap<string, TxForSignature>,
): string {
  const present = new Set<SourceSystem>();
  const ids = [
    ...(exception.transactionId === null ? [] : [exception.transactionId]),
    ...exception.relatedTransactionIds,
  ];
  for (const id of ids) {
    const tx = txById.get(id);
    if (tx !== undefined) present.add(tx.sourceSystem);
  }
  if (present.size === 0) return 'unknown';
  const sorted = [...present].sort((a, b) => SOURCE_ORDER[a] - SOURCE_ORDER[b]);
  return sorted.length === 1 ? `${sorted[0]}_only` : sorted.join('+');
}

/** The single related record a value/timing verdict was reached against, if any. */
function counterpartOf(
  exception: ExceptionForSignature, txById: ReadonlyMap<string, TxForSignature>,
): TxForSignature | null {
  for (const id of exception.relatedTransactionIds) {
    const tx = txById.get(id);
    if (tx !== undefined) return tx;
  }
  return null;
}

export function computeSignatureComponents(
  exception: ExceptionForSignature,
  txById: ReadonlyMap<string, TxForSignature>,
  opts: { promptVersion: string; model: string },
): SignatureComponents {
  const self = exception.transactionId === null ? null : txById.get(exception.transactionId) ?? null;
  const counterpart = counterpartOf(exception, txById);

  const isValueShaped =
    VALUE_CATEGORIES.has(exception.category)
    || exception.secondaryFlags.some((f) => VALUE_CATEGORIES.has(f));

  let amountBucket: AmountDeltaBucket = 'none';
  if (isValueShaped && self !== null && counterpart !== null) {
    amountBucket = amountDeltaBucket(self.amountPaise, counterpart.amountPaise);
  }

  // Prefer S8's recorded delta (it is exact and already on the evidence); fall
  // back to the two records' business dates; default to "not a dated
  // discrepancy" when there is no counterpart at all.
  let dateBucket: DateDeltaBucket = 'within_window';
  const recordedDrift = exception.evidence.wouldMatchIfWindowWidened?.dateDeltaDays;
  if (typeof recordedDrift === 'number') {
    dateBucket = dateDeltaBucket(recordedDrift);
  } else if (self !== null && counterpart !== null) {
    dateBucket = dateDeltaBucket(dayDelta(self.txnDate, counterpart.txnDate));
  }

  return {
    promptVersion: opts.promptVersion,
    model: opts.model,
    category: exception.category,
    amountDeltaBucket: amountBucket,
    dateDeltaBucket: dateBucket,
    sourcesPresent: sourcesPresent(exception, txById),
    anchorStrength: exception.evidence.anchorStrength,
    aliasInvolved: exception.evidence.aliasesAttempted.length > 0 ? 'yes' : 'no',
    candidateCountBucket: candidateCountBucket(exception.evidence.candidatesConsidered),
    secondaryFlagsSorted: [...exception.secondaryFlags].sort().join(','),
  };
}

/**
 * The hash is over a fixed-order `|`-join of the components — the exact list in
 * schema.md §10.2, in that order. A component added later must go on the END and
 * be paired with a `prompt_version` bump, or two different discrepancies could
 * hash alike.
 */
export function hashComponents(c: SignatureComponents): string {
  const parts = [
    c.promptVersion,
    c.model,
    c.category,
    c.amountDeltaBucket,
    c.dateDeltaBucket,
    c.sourcesPresent,
    c.anchorStrength,
    c.aliasInvolved,
    c.candidateCountBucket,
    c.secondaryFlagsSorted,
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

export function computeSignature(
  exception: ExceptionForSignature,
  txById: ReadonlyMap<string, TxForSignature>,
  opts: { promptVersion: string; model: string },
): Signature {
  const components = computeSignatureComponents(exception, txById, opts);
  return { hash: hashComponents(components), components };
}
