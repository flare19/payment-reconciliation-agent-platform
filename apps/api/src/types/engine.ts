/**
 * Internal engine types — what flows between stages S0–S14.
 * These are NOT wire shapes; see `dto.ts` for those.
 */

import type {
  AnchorStrength, BusinessDate, Cardinality, DateWindow, Direction, ExceptionCategory,
  MatchStatus, MatchTier, MemberRole, PaymentMethod, Paise, Severity, SourceSystem, StatusNorm,
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

  feeBandMinPct: number;
  feeBandMaxPct: number;

  fuzzyAutoConfirmThreshold: number;
  fuzzyReviewThreshold: number;
  ambiguityDeltaThreshold: number;

  scoreWeights: ScoreWeights;

  candidateCap: number;
  batchPoolCap: number;
  batchMaxSubsetSize: number;
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
  /** S10 (ADR-038): searched the whole bounded space, no decomposition exists. */
  searchExhausted?: boolean | null;
  /** S10 (ADR-038): hit a bound. A DIFFERENT CLAIM from searchExhausted — never conflate. */
  searchBoundExceeded?: { bound: 'pool' | 'subset_size' | 'time'; value: number } | null;
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
