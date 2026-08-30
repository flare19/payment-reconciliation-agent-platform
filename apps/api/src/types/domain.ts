/**
 * Domain vocabulary — the closed sets the whole system agrees on.
 *
 * Most unions here mirror a Postgres CHECK constraint in `migrations/` — if you
 * add a value to one of those, add it in BOTH places, in the same commit. See
 * docs/schema.md §0 (why CHECK and not native enum types).
 *
 * Two are DELIBERATELY unconstrained at the database level (see #13):
 * `PaymentMethod` and `BankTxnType` back `transactions.method` / `.txn_type`,
 * both declared as plain TEXT with no CHECK in migrations/003 and in
 * schema.md §3 — the doc and the migration agree, so this file's header used
 * to be the only place claiming otherwise. `method` is load-bearing
 * (`tolerance.ts`'s `dateWindowFor` branches on it) and `txn_type` gates the
 * ADR-036 FEE exclusion, so a value outside the TS union is still a real risk;
 * it just is not one the database will catch.
 *
 * The reverse direction also has three exceptions with no TS union at all —
 * `exceptions.explanation_source`, `agent_investigations.status` and
 * `agent_investigations.human_disposition` — defensible omissions rather than
 * drift, since nothing outside their own repository reads those columns.
 */

export type SourceSystem = 'gateway' | 'bank' | 'ledger';

/**
 * Canonical source ordering for deterministic tie-breaks (ADR-032).
 * NOT alphabetical — gateway is the identity anchor and sorts first.
 * Always sort with `compareCanonical`, never with a bare string compare.
 */
export const SOURCE_ORDER: Record<SourceSystem, number> = {
  gateway: 0,
  bank: 1,
  ledger: 2,
};

export type Direction = 'credit' | 'debit';

/** `strong` can carry a match alone; `weak` narrows only; `none` means nothing to find. */
export type AnchorStrength = 'strong' | 'weak' | 'none';

export type StatusNorm =
  | 'reconcilable'
  | 'excluded_failed'
  | 'excluded_draft'
  | 'excluded_void'
  | 'excluded_authorized'
  /** Bank FEE rows — already accounted for inside net-amount comparisons (ADR-036). */
  | 'excluded_non_reconcilable';

export type MatchTier = 'exact' | 'alias' | 'fuzzy' | 'batch' | 'manual';
export type MatchStatus = 'auto_confirmed' | 'pending_review' | 'human_confirmed' | 'human_rejected';
export type Cardinality = 'one_to_one' | 'one_to_many' | 'many_to_one';
export type MemberRole = SourceSystem;

/** Precedence order is the DECLARATION order here — first firing rule wins (schema.md §8.2). */
export const EXCEPTION_PRECEDENCE = [
  'DUPLICATE_RECORD',
  'AMBIGUOUS_MATCH',
  'UNSPLITTABLE_BATCH',
  // ADR-062: above the presence class. Presence and value cannot compete within
  // one leg (classify.ts enforces that), so wherever both appear they concern
  // DIFFERENT counterparts — and since severity derives from the primary
  // category, ranking presence first filed a proved money discrepancy as
  // `medium` instead of `high`.
  'AMOUNT_MISMATCH',
  'MISSING_IN_GATEWAY',
  'MISSING_IN_BANK',
  'MISSING_IN_LEDGER',
  // Last: identity and amount both agree, only the calendar disagrees. A late
  // settlement is a process artifact; a wholly absent record is not.
  'TIMING_DRIFT',
] as const;

export type ExceptionCategory = (typeof EXCEPTION_PRECEDENCE)[number];

export type Severity = 'high' | 'medium' | 'low';
export type ExceptionStatus = 'open' | 'explained' | 'human_resolved' | 'wont_fix';

export type RunStatus =
  | 'pending' | 'ingesting' | 'matching' | 'classifying' | 'explaining' | 'completed' | 'failed';

/**
 * `agent` is Phase A (ADR-052). `llm` is the S13 explain layer only.
 * An `agent` or `llm` actor must NEVER appear on a MATCH_CONFIRMED_* event —
 * that separation is ADR-017 and ADR-048 made visible in the audit trail.
 */
export type ActorType = 'engine' | 'human' | 'llm' | 'agent';

export type SubjectType = 'transaction' | 'match' | 'exception' | 'alias' | 'run' | 'investigation';

export type AliasType = 'merchant_name' | 'counterparty_name' | 'reference_id' | 'description_token';
export type AliasScope = SourceSystem | 'any';
export type AliasStatus = 'active' | 'superseded' | 'revoked';

export type PaymentMethod = 'card' | 'upi' | 'netbanking' | 'wallet';

/** Bank `transaction_type`. FEE is excluded at ingestion (ADR-036). */
export type BankTxnType =
  | 'SETTLEMENT' | 'NEFT' | 'IMPS' | 'UPI' | 'CHARGEBACK' | 'FEE' | 'MISC_CREDIT';

/**
 * Money is ALWAYS integer paise (ADR-006). This alias exists to make a `number`
 * holding rupees obvious at review time. Never construct one from a float without
 * going through `services/ingestion/money.ts`.
 */
export type Paise = number;

/** An IST business date as `YYYY-MM-DD`. Never a Date object in the decision path. */
export type BusinessDate = string;

/** Inclusive day offsets relative to the anchor record's business date, e.g. [-1, 3]. */
export type DateWindow = readonly [number, number];

export function compareCanonical(
  a: { sourceSystem: SourceSystem; sourceRowNumber: number },
  b: { sourceSystem: SourceSystem; sourceRowNumber: number },
): number {
  const s = SOURCE_ORDER[a.sourceSystem] - SOURCE_ORDER[b.sourceSystem];
  return s !== 0 ? s : a.sourceRowNumber - b.sourceRowNumber;
}
