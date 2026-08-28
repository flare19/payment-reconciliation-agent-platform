/**
 * Internal engine types — what flows between stages S0–S14.
 * These are NOT wire shapes; see `dto.ts` for those.
 */

import type {
  AliasScope, AliasType, AnchorStrength, BusinessDate, Cardinality, DateWindow, Direction,
  ExceptionCategory, MatchStatus, MatchTier, MemberRole, PaymentMethod, Paise, Severity,
  SourceSystem, StatusNorm,
} from './domain.js';

/** Keys are OMITTED when absent — never present-with-null (schema.md §3.1). */
export interface ReferenceIds {
  payment_id?: string;
  order_id?: string;
  rrn?: string;
  utr?: string;
  settlement_id?: string;
  invoice_no?: string;
  entry_id?: string;
  bank_ref_no?: string;
  /** Low-confidence regex hits from the bank description blob. ALWAYS treated as `weak`. */
  extracted_from_description?: string[];
}

/** Anchor types usable for identity, strongest first. */
export const STRONG_ANCHOR_KEYS = ['payment_id', 'settlement_id', 'rrn', 'utr', 'entry_id', 'invoice_no'] as const;
export type StrongAnchorKey = (typeof STRONG_ANCHOR_KEYS)[number];

export interface NormalizedTransaction {
  id: string;
  runId: string;
  sourceSystem: SourceSystem;
  sourceFile: string;
  /** 1-based physical file position, header = row 0. Stable across loads (schema.md §3). */
  sourceRowNumber: number;

  externalId: string;
  referenceIds: ReferenceIds;
  anchorStrength: AnchorStrength;

  amountPaise: Paise;
  feePaise: Paise | null;
  taxPaise: Paise | null;
  netAmountPaise: Paise | null;
  currency: string;
  direction: Direction;

  txnDate: BusinessDate;
  txnTimestamp: string | null;
  postingDate: BusinessDate | null;

  counterpartyRaw: string | null;
  counterpartyNorm: string | null;
  /** Post-alias-resolution key. NULL until Tier 1.5 runs. */
  counterpartyKey: string | null;

  method: PaymentMethod | null;
  statusRaw: string;
  statusNorm: StatusNorm;
  txnType: string | null;

  descriptionRaw: string | null;

  duplicateOfTransactionId: string | null;
  duplicateKind: 'exact' | 'suspected' | null;

  ingestWarnings: string[];
  rawPayload: Record<string, string>;
}

/** A row that could not be parsed. NOT an exception (ADR-046). */
export interface RejectedRow {
  sourceSystem: SourceSystem;
  rowNumber: number;
  rawLine: string;
  error: string;
}

/** S1–S3 output for one source file. */
export interface ParsedSourceResult {
  transactions: NormalizedTransaction[];
  rejectedRows: RejectedRow[];
}

/**
 * S1–S3 output for the whole run — the input S4 (dedupe) consumes.
 *
 * `transactions` are in canonical order already: gateway file-order, then bank,
 * then ledger, each numbered 1..N by physical position — which is exactly
 * `compareCanonical` order, so no stage downstream has to re-sort to be
 * deterministic about ingestion output.
 */
export interface IngestionResult {
  transactions: NormalizedTransaction[];
  rejectedRows: RejectedRow[];
  /**
   * MAX(txnDate) across every ingested transaction — EXCLUDED rows included
   * (ADR-039: "before exclusion"), rejected rows excluded because they have no
   * parseable date. Computed here because S1 is the first stage that has a
   * business date for every surviving row. `null` only when nothing parsed.
   */
  referenceDate: BusinessDate | null;
  counts: {
    /** Transactions produced per source. Rejected rows are NOT counted here. */
    gateway: number;
    bank: number;
    ledger: number;
    /** Transactions with `statusNorm !== 'reconcilable'` (ADR-036, schema §2.1/§2.3). */
    excluded: number;
    /** Rows that could not be parsed at all (ADR-046) — not transactions, not exceptions. */
    rejected: number;
  };
}

/**
 * Resolved run configuration. Written verbatim to `runs.config_snapshot`.
 * A run's output is a pure function of (input files, this object, active aliases).
 */
export interface RunConfig {
  amountTolerancePct: number;
  amountToleranceFloorPaise: Paise;
  amountToleranceCapPaise: Paise;

  dateWindowCardDays: DateWindow;
  dateWindowUpiDays: DateWindow;
  dateWindowLedgerDays: DateWindow;
  dateWindowBankLedgerDays: DateWindow;
  /**
   * Fallback for "has enough time passed that a gateway counterpart would have
   * been ingested" on a BANK record with no gateway match (ADR-065). Distinct
   * from `dateWindowCardDays`: that window is defined gateway -> bank and
   * measured from the gateway date; there is no ADR-009 window in this
   * direction to invert, because settlement flows forward FROM the gateway
   * capture, so a real gateway record for this economic event should already
   * be ingested by the time its bank credit lands.
   */
  dateWindowGatewayLookbackDays: DateWindow;

  feeBandMinPct: number;
  feeBandMaxPct: number;

  fuzzyAutoConfirmThreshold: number;
  fuzzyReviewThreshold: number;
  ambiguityDeltaThreshold: number;

  scoreWeights: ScoreWeights;

  candidateCap: number;
  batchPoolCap: number;
  batchMaxSubsetSize: number;
  /** ADR-060: the PRIMARY, deterministic bound. */
  batchNodeBudget: number;
  /** Safety valve only — expected never to fire. Non-deterministic by nature. */
  batchSubsetBudgetMs: number;

  nearAnchorMinLength: number;
  nearAnchorMaxDistance: number;

  severityEscalateHighPaise: Paise;
  severityEscalateOneLevelPaise: Paise;

  aliasLearningEnabled: boolean;
  llmExplainEnabled: boolean;
  llmMaxCallsPerRun: number;

  ruleVersion: string;
  /** ADR-039: dataset-derived, never the wall clock. Resolved at S0. */
  referenceDate: BusinessDate;
  aliasCountAtStart: number;
}

/**
 * Tier 2 component weights (ADR-030). Sum to 1.00.
 *
 * The load-bearing property: a pair with NO comparable anchor caps at
 * amount+date+counterparty = 0.70, below the 0.85 auto-confirm threshold.
 * A no-anchor pair can therefore never auto-confirm, at any amount, on any
 * date, with any name similarity. Changing these weights can silently break
 * that guarantee — `tests/unit/score-ceilings.test.ts` asserts it.
 */
export interface ScoreWeights {
  anchor: number;
  amount: number;
  date: number;
  counterparty: number;
  anchorStrongWeak: number;
  anchorNear: number;
  anchorWeakWeak: number;
}

export interface ScoreBreakdown {
  anchor: number;
  amount: number;
  date: number;
  counterparty: number;
  total: number;
  /** true for bank↔ledger, where amounts are not a comparable quantity (ADR-037). */
  amountUnavailable: boolean;
}

export interface ScoredCandidate {
  transactionId: string;
  sourceSystem: SourceSystem;
  score: number;
  breakdown: ScoreBreakdown;
  ruleId: string;
  /** Populated when the candidate was discarded before/after scoring. */
  rejectedBecause: string | null;
}

/** Which quantity is compared for a given source pair (ADR-037, matching-engine §4.3). */
export type ComparisonBasis =
  | 'gateway_net_vs_bank_credit'
  | 'gateway_net_inferred_vs_bank_credit'
  | 'gateway_gross_vs_ledger_net'
  | 'anchor_only';

export interface PairEvaluation {
  amountDeltaPaise: Paise;
  amountWithinTolerance: boolean;
  toleranceBandPaise: Paise;
  dateDeltaDays: number;
  dateWithinWindow: boolean;
  windowUsed: DateWindow;
  basis: ComparisonBasis;
  directionAgrees: boolean;
  anchorsAgree: boolean;
  anchorsContradict: boolean;
  sharedAnchorKey: string | null;
}

export interface ProposedMatch {
  tier: MatchTier;
  status: MatchStatus;
  confidence: number;
  ruleId: string;
  cardinality: Cardinality;
  members: { transactionId: string; role: MemberRole; isAnchor: boolean }[];
  amountDeltaPaise: Paise;
  dateDeltaDays: number;
  aliasIds: string[];
  scoreBreakdown: ScoreBreakdown | null;
}

/**
 * An active `learned_aliases` row, resolved for the engine (schema.md §6).
 *
 * `eligibleForAliasTier` is COMPUTED by the loader, never stored (matching-engine
 * §5): an alias with `conflict_count > 0 AND confirmation_count < 2` is barred
 * from Tier 1.5's exact re-run and may only contribute the resolved
 * `counterparty_key` to Tier 2 (schema.md §6.3). The engine consumes the boolean
 * and does no conflict-count bookkeeping of its own.
 */
export interface ActiveAlias {
  id: string;
  aliasType: AliasType;
  scopeSource: AliasScope;
  /** §3.3-normalised lookup key. */
  normalizedValue: string;
  /** The value it resolves to — already normalised, and never itself re-resolved (one hop, §6.3). */
  canonicalValue: string;
  eligibleForAliasTier: boolean;
}

/**
 * The four candidate-generation indexes, built once per run at S5
 * (matching-engine.md §3). Every id list is sorted by `compareCanonical`, and
 * only reconcilable rows are indexed.
 */
export interface BlockIndexes {
  /** `"<anchorKey>::<anchorValue>"` → ids. Structured strong anchors only. Serves S6, S7, S8. */
  byStrongAnchor: Map<string, string[]>;
  /** First 6 chars of each structured strong anchor value → ids. Serves Tier 2 near-anchor (ADR-031). */
  byAnchorPrefix: Map<string, string[]>;
  /** `"<txnDate>::<amountBucket>"` (bucket = `floor(amountPaise / 100000)`) → ids. Serves Tier 2. */
  byDateAmount: Map<string, string[]>;
  /** `counterpartyKey ?? counterpartyNorm` → ids. Serves Tier 2; rebuild after S7 if aliases are active. */
  byCounterparty: Map<string, string[]>;
  /** id → transaction, for resolving the id lists above. */
  byId: Map<string, NormalizedTransaction>;
}

/**
 * The Tier 1 predicate's verdict for one ordered pair (matching-engine.md §4.1).
 * `null` from `tier1Match` means "not an exact match" — no reason enumeration,
 * because the pair simply proceeds to the next stage.
 */
export interface Tier1Match {
  /** Names the anchor that carried it (matching-engine.md §4.4). */
  ruleId: string;
  anchorKey: string;
  anchorValue: string;
  amountDeltaPaise: Paise;
  dateDeltaDays: number;
  basis: ComparisonBasis;
  window: DateWindow;
  reason: string;
}

/** A confirmed exact / alias-resolved pair from S6 or S7, before S11 groups it. */
export interface Tier1PairMatch extends Tier1Match {
  aId: string;
  bId: string;
  aRole: MemberRole;
  bRole: MemberRole;
  tier: 'exact' | 'alias';
  /** 1.0000 for exact; a fixed 0.9500 for alias (schema.md §7). */
  confidence: number;
  /** Aliases that contributed to an alias-resolved match; empty for exact. */
  aliasIds: string[];
}

/** S7 output: the pool with `counterpartyKey` populated, plus any alias-resolved matches. */
export interface Tier15Result {
  /** Same rows, each with `counterpartyKey` set (`counterpartyNorm` when no alias applied). */
  pool: NormalizedTransaction[];
  matches: Tier1PairMatch[];
  /**
   * One entry per record where an alias actually resolved the counterparty key
   * (`appliedAliasId` is always non-null here) — the `ALIAS_APPLIED` audit rows.
   * Records with no alias applied are absent; their key is still on `pool`.
   */
  counterpartyResolutions: {
    transactionId: string;
    counterpartyKey: string | null;
    appliedAliasId: string;
  }[];
}

/** The honest record of what the engine tried. Mandatory on every exception. */
export interface ExceptionEvidence {
  candidatesConsidered: number;
  candidates: {
    transactionId: string;
    sourceSystem: SourceSystem;
    score: number;
    scoreBreakdown?: ScoreBreakdown;
    rejectedBecause: string;
  }[];
  anchorStrength: AnchorStrength;
  aliasesAttempted: string[];
  windowUsed: { amountBandPaise: Paise; dateWindow: DateWindow };
  comparisonBasis?: ComparisonBasis;
  candidateCapHit: boolean;
  severityBasis: { base: Severity; amountAtRiskPaise: Paise | null; escalated: boolean };

  /** S8 (ADR-029): the real delta on a TIMING_DRIFT, so a human can confirm in one click. */
  wouldMatchIfWindowWidened?: { dateDeltaDays: number } | null;
  /**
   * S10 (ADR-038): the whole DECLARED space was searched and no decomposition
   * exists. A proof about the data.
   */
  searchExhausted?: boolean | null;
  /**
   * S10 (ADR-038, ADR-060): the search was TRUNCATED — eligible candidates were
   * discarded, or the budget cut it short. A DIFFERENT CLAIM from
   * `searchExhausted`, and the two are never conflated.
   *
   * `subset_size` is deliberately absent: the size cap is part of the declared
   * question rather than a truncation of it (ADR-060).
   */
  searchBoundExceeded?: { bound: 'pool' | 'nodes' | 'time'; value: number } | null;
  candidateSubsets?: string[][] | null;
  /** S9 (ADR-032): the counterpart went to a stronger claim. */
  displacedByMatchId?: string | null;
  counterpartStatus?: string | null;
}

export interface ClassifiedException {
  transactionId: string | null;
  relatedTransactionIds: string[];
  category: ExceptionCategory;
  secondaryFlags: ExceptionCategory[];
  severity: Severity;
  amountAtRiskPaise: Paise | null;
  requiresHumanConfirmation: boolean;
  bestCandidateScore: number | null;
  evidence: ExceptionEvidence;
  detectedByRule: string;
  ruleVersion: string;
}
