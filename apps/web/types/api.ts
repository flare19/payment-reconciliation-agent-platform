/**
 * Wire types for the endpoints the frontend consumes.
 *
 * These are transcribed from REAL responses off a running API, not from
 * api-contract.md prose — the contract is binding on the shape, but the field
 * names below have to match the bytes that actually arrive or the page renders
 * `undefined`. Where the two disagree, that disagreement is recorded in a
 * comment rather than silently resolved in either direction.
 *
 * Money never appears here as anything a component may do arithmetic on: the
 * API sends `amountPaise` alongside a pre-formatted `amountDisplay`, and the
 * frontend renders the second (api-contract §0, ui-spec §9).
 */

export type RunStage =
  | 'pending' | 'ingesting' | 'matching' | 'classifying' | 'explaining'
  | 'completed' | 'failed';

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface RunHeadline {
  matchRatePct: number;
  /** `null` until a score report exists. NEVER substitute an engine figure. */
  falsePositiveMatches: number | null;
  /** `null` on a WARM run: the aliases-disabled counterfactual is not computed
   *  there, and a warm number under a cold label is the failure ADR-020 exists
   *  to prevent (ADR-130). */
  coldStartMatchRatePct: number | null;
  /** The API's own answer. Never re-derive it by comparing two rates. */
  isCold: boolean | null;
  exceptionCount: number;
  pendingReviewCount: number | null;
}

export interface RunSummary {
  runId: string;
  label: string;
  status: RunStage;
  datasetSeed: number | null;
  startedAt: string;
  finishedAt: string | null;
  progress: { stage: RunStage; pct: number };
  /**
   * NULL UNTIL S1 HAS INGESTED. It is derived from the data (ADR-039), so it
   * does not exist while `status` is `pending` or `ingesting`. `day()` throws
   * `RangeError: Invalid time value` on null, not a placeholder string.
   */
  referenceDate: string | null;
  recordCounts: {
    gateway: number; bank: number; ledger: number;
    excluded: number; rejectedRows: number; nonPrimaryDuplicates: number;
    reconcilable: number;
  };
  /**
   * NULL UNTIL THE RUN COMPLETES. `runs.metrics` is written by S14, so every
   * field under it is absent for a run still in flight — and a run in flight is
   * exactly what the run list shows while one is going.
   */
  headline: RunHeadline | null;
}

export interface RunListResponse {
  runs: RunSummary[];
  pagination: Pagination;
}

// ── endpoint 5 · engine (runs.metrics, schema.md §11.1) ──────────────────────

/**
 * The engine's account of itself. Every number here is self-reported: it says
 * what the engine did, never how right it was. Anything ground-truth-derived
 * lives in `MeasuredMetrics` below and is rendered differently on purpose
 * (ADR-041).
 */
export interface EngineMetrics {
  schemaVersion: number;
  matchRate: {
    matchRatePct: number;
    matchedRecords: number;
    reconcilableRecords: number;
    pendingReviewExcluded: number;
    /** Shown on hover. A percentage whose denominator is not inspectable is not a measurement. */
    denominatorNote: string;
  };
  coldStart: { isCold: boolean; matchRatePct: number | null; aliasesActiveAtStart: number };
  exceptions: {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    candidateCapHits: number;
    batchSearchExhausted: number;
    batchSearchBoundExceeded: number;
  };
  population: {
    gateway: number; bank: number; ledger: number;
    ingested: number; excluded: number; rejectedRows: number;
    nonPrimaryDuplicates: number; reconcilable: number;
    ingestedNote: string;
  };
  throughput: {
    recordsPerSecEngine: number;
    recordsPerSecWallClock: number;
    stageMs: Record<string, number>;
    note: string;
  };
  tierAttribution: Record<string, number>;
  reviewBurden: {
    pendingReviewCount: number;
    pendingReviewRecords: number;
    per100Records: number;
  };
  aliasLearning: {
    aliasesActive: number;
    aliasesRevoked: number;
    aliasesSuperseded: number;
    humanCorrectionsToDate: number;
    recordsAutoResolvedByAliases: number;
    /** Records that matched ONLY because of an alias — the causal figure, from
     *  a real second pass. `null` on a cold run (ADR-132). */
    recordsDecidedByAliases: number | null;
    leverageRatio: number | null;
  };
  /** `null`, never `0`, when S13 did not run — a stage that did not run reports no figure. */
  llmCost: {
    model: string;
    apiCalls: number;
    tokensIn: number;
    tokensOut: number;
    estimatedCostUsd: number | null;
    signaturesTotal: number;
    signaturesGenerated: number;
    signaturesFromCache: number;
    signaturesTemplated: number;
    exceptionsExplained: number;
    collapseRatio: number;
    callCapPerRun: number;
    callCapReached: boolean;
    promptVersion: string;
    failures: { reason: string; detail: string }[];
  } | null;
  stagesNotRun: string[];
}

// ── endpoint 5 · measured (score_reports.report, tools/score) ────────────────

/** Every field here was produced offline against an answer key that existed first. */
export interface MeasuredMetrics {
  scorerVersion: string;
  /**
   * THE SYSTEM INCLUDING ITS HUMAN REVIEW LOOP. Moves as reviewers work, so it
   * must never be rendered without `humanReview.confirmedGroups` beside it
   * (validation-strategy §5.1.1a, ADR-119).
   */
  matching: {
    precision: number; recall: number; f1: number;
    truePositives: number; falsePositives: number; falseNegatives: number;
    pendingPairs: number;
    reviewQueuePrecision: number | null;
    excludedExceptionEventPairs: number;
    excludedSameSourceLegs: number;
    pendingExcludedFromQueuePrecision: number;
    falsePositivePairs: { a: string; b: string }[];
  };
  /**
   * THE ENGINE AS IT LEFT THE RUN. Invariant afterwards, and the headline for
   * any claim about the engine rather than the system.
   *
   * `null` on a report written by scorer < 1.4.0 — two such reports exist and
   * are deliberately left in place, so this is a real absence to render, not a
   * theoretical one (ADR-119).
   */
  matchingEngineOnly: MeasuredMetrics['matching'] | null;
  humanReview: {
    confirmedGroups: number;
    rejectedGroups: number;
    stillPendingGroups: number;
    recallDelta: number;
    precisionDelta: number;
  } | null;
  classification: {
    macroPrecision: number;
    macroRecall: number;
    perCategory: Record<string, { precision: number; recall: number; support: number }>;
    secondaryFlagJaccard: number | null;
    multiCategoryEvents: number;
    s8RegressionCells: {
      amountMismatchScoredAsPendingMatch: number;
      timingDriftAutoConfirmed: number;
    };
    multiLabel: {
      anyCategoryRecall: number;
      perCategory: Record<string, { precision: number; recall: number }>;
    };
  };
  /** Recall only — precision is not sliceable by difficulty (a false positive
   *  belongs to no event, so it carries no difficulty label). Scorer 1.5.0
   *  removed the `precision` key rather than keep it aliased onto recall. */
  byDifficulty: Record<string, { pairs: number; recall: number }>;
  resolvability: {
    unresolvableDesigned: number;
    unresolvableRecall: number;
    inventedMatchesOnUnresolvable: string[];
    falseDespairRate: number;
    falseDespairEvents: number;
    gaveUpOn: number;
    boundHonesty: { searchExhausted: number; searchBoundExceeded: number };
  };
  ceiling: {
    theoreticalMaxMatchRatePct: number;
    achievedPct: number | null;
    headroomPct: number | null;
  };
  buildBlockers: string[];
}

export interface MetricsResponse {
  engine: EngineMetrics;
  /** `null` for uploaded files, or before the offline scorer has run. */
  measured: MeasuredMetrics | null;
  measuredAt: string | null;
  measuredAgainst: string | null;
  scorerVersion: string | null;
}

// ── endpoint 26 · the Analyst ────────────────────────────────────────────────

/**
 * OPERATIONAL ONLY, and the omission is the design (api-contract §3).
 *
 * NOTE — a doc/code divergence the dashboard has to be careful about:
 * `api-contract.md` describes `investigationsRun` / `verdictDistribution`; the
 * route actually returns the flat shape below. More importantly the route sets
 * `hallucinatedResolutions` to `groundingFailures` verbatim
 * (routes/investigations.ts), so it is the gate's REJECTION COUNT — an
 * operational figure — not the ground-truth measurement ADR-053 names. The
 * dashboard labels it as what it is and renders the measured tile as absent,
 * because `tools/score` does not score the Analyst yet.
 */
export interface AgentMetrics {
  total: number;
  concluded: number;
  failed: number;
  groundingFailures: number;
  budgetExhausted: number;
  proposals: number;
  accepted: number;
  declined: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  hallucinatedResolutions: number;
}

export type Verdict =
  | 'RESOLUTION_PROPOSED' | 'CONFIRMED_UNRESOLVABLE'
  | 'NEEDS_EXTERNAL_DATA' | 'INSUFFICIENT_EVIDENCE';

export interface InvestigationSummary {
  investigationId: string;
  runId: string;
  exceptionId: string;
  status: string;
  verdict: Verdict | null;
  confidence: 'high' | 'medium' | 'low' | null;
  groundingPassed?: boolean;
}

export interface InvestigationListResponse {
  /**
   * Endpoint 26 returns FULL investigation objects, reasoning chain included —
   * not the trimmed summary the contract's example implies. Typing it as the
   * detail shape is what lets the Analyst screen show which tools were actually
   * called without one request per investigation.
   */
  investigations: InvestigationDetail[];
  agentMetrics: AgentMetrics;
  pagination: Pagination;
}

// ── endpoint 28 · the Q&A agent (U15) ────────────────────────────────────────

/**
 * One question and its answer, as `agent_questions` stored it.
 *
 * `groundingPassed: false` is a REAL, RENDERABLE state and not an error: the A3
 * gate refused the answer, stripped its citations, and the row was persisted
 * anyway so the refusal is visible rather than silently retried. The UI must
 * never present such an answer as though it were grounded.
 */
export interface RunQuestion {
  questionId: string;
  runId: string;
  question: string;
  answer: string | null;
  citations: string[];
  steps: number;
  toolCalls: number;
  tokensIn: number | null;
  tokensOut: number | null;
  /** NULL on a free-tier key, never 0 — a zero reads as a measured figure. */
  costUsd: number | null;
  groundingPassed: boolean;
  askedAt: string;
}

export interface QuestionListResponse {
  questions: RunQuestion[];
}

// ─────────────────────────────────────────────────────────────────────────────
// U18 · the remaining screens
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'low';

export type Resolvability =
  | 'resolvable_by_human' | 'needs_external_data' | 'unresolvable_from_sources';

export type ExplanationSource = 'llm' | 'llm_cache' | 'template';

/** The shared preview shape every list and evidence block renders records with. */
export interface RecordPreview {
  transactionId: string;
  sourceSystem: 'gateway' | 'bank' | 'ledger';
  sourceRowNumber: number;
  externalId: string | null;
  amountPaise: number;
  amountDisplay: string;
  txnDate: string;
  counterpartyRaw: string | null;
  role?: string;
}

// ── endpoint 6 ───────────────────────────────────────────────────────────────

export interface ExceptionSummary {
  exceptionId: string;
  category: string;
  secondaryFlags: string[];
  severity: Severity;
  status: string;
  primaryRecord: RecordPreview;
  relatedRecordCount: number;
  bestCandidateScore: number | null;
  explanationText: string | null;
  explanationSource: ExplanationSource | null;
  suggestedAction: string | null;
  sharedExplanationCount: number | null;
  /**
   * NULL IS A REAL STATE, not a missing field. Exact `DUPLICATE_RECORD`
   * exceptions never enter the classifier's pool, so `classify.ts` cannot look
   * their amount up and emits null — 9 of 200 on the holdout. The UI renders
   * that absence explicitly and never substitutes a zero, for the same reason
   * an unmeasured accuracy figure is never filled in from the engine's own.
   */
  amountAtRiskPaise: number | null;
  amountAtRiskDisplay: string | null;
  requiresHumanConfirmation: boolean;
  resolvability: Resolvability;
}

export interface ExceptionFacets {
  category: Record<string, number>;
  severity: Record<string, number>;
  status: Record<string, number>;
}

export interface ExceptionListResponse {
  exceptions: ExceptionSummary[];
  facets: ExceptionFacets;
  pagination: Pagination;
}

// ── endpoint 7 ───────────────────────────────────────────────────────────────

export interface Candidate {
  transactionId: string;
  sourceSystem: string;
  score: number;
  /** Verbatim from the engine. Rendered as-is — paraphrasing it would be editing a finding. */
  rejectedBecause: string | null;
  preview: { externalId: string | null; amountDisplay: string; txnDate: string } | null;
  breakdown?: Record<string, number> | null;
}

/**
 * `searchExhausted` and `searchBoundExceeded` are DIFFERENT CLAIMS (ADR-038) and
 * the UI must say which one it is making. The first is a proof that no
 * decomposition exists inside the declared bounds; the second is "we ran out of
 * room and stopped". Collapsing them into one sentence would turn a proof into a
 * shrug, or a shrug into a proof.
 */
export interface ExceptionEvidence {
  candidates: Candidate[] | null;
  windowUsed: { dateWindow: [number, number]; amountBandPaise: number } | null;
  severityBasis: { base: Severity; escalated: boolean; amountAtRiskPaise: number } | null;
  anchorStrength: string | null;
  candidateCapHit: boolean | null;
  candidatesConsidered?: number | null;
  searchExhausted: boolean | null;
  searchBoundExceeded: { bound: string; value: number; poolSize?: number } | null;
  candidateSubsets: number | null;
  aliasesAttempted: string[] | null;
  counterpartStatus: string | null;
  displacedByMatchId?: string | null;
  [k: string]: unknown;
}

/**
 * Who closed an exception, when, and why — one object, never three parallel
 * fields. `null` unless the exception is closed; complete whenever it is,
 * because `exc_resolution_complete` requires all three columns together
 * (ADR-122).
 */
export interface ExceptionClosure {
  resolution: 'human_resolved' | 'wont_fix';
  resolvedBy: string;
  resolvedAt: string;
  note: string;
}

export interface ExceptionDetail extends ExceptionSummary {
  closure: ExceptionClosure | null;
  /**
   * The run this exception belongs to — ALWAYS use this rather than whatever
   * run the page happened to resolve from `?run=` or "most recent completed".
   * Deriving it from global state was correct only while exactly one run
   * existed; the second run made every older exception report that nobody had
   * investigated it.
   */
  runId: string;
  evidence: ExceptionEvidence;
  detectedByRule: string;
  ruleVersion: string;
  relatedRecords: RecordPreview[];
  auditEntryCount: number;
}

// ── endpoint 8 ───────────────────────────────────────────────────────────────

export interface MatchSummary {
  matchId: string;
  tier: string;
  cardinality: string;
  status: string;
  confidence: number;
  ruleId: string;
  ruleVersion: string;
  countsTowardEngineMatchRate: boolean;
  headlineAmountPaise: number;
  headlineAmountDisplay: string;
  headlineAmountSource: string;
  members: RecordPreview[];
  matchedAt: string;
  /**
   * Who decided this proposal, when, and what they said. `null` unless a human
   * has decided it.
   *
   * `note` is nullable while the other two are not, and that is the API's own
   * asymmetry rather than a modelling shortcut: rejecting REQUIRES a reason
   * (endpoint 11), approving takes an OPTIONAL note (endpoint 10). Render the
   * absence; never substitute the word "Approved" for a reason nobody gave
   * (ADR-124).
   */
  review: {
    decision: 'human_confirmed' | 'human_rejected';
    reviewedBy: string;
    reviewedAt: string;
    note: string | null;
  } | null;
}

export interface MatchListResponse { matches: MatchSummary[]; pagination: Pagination }

// ── endpoint 9 ───────────────────────────────────────────────────────────────

export interface AliasSuggestion {
  aliasType: string;
  rawValue: string;
  canonicalValue: string;
  /** The number that makes the learning loop legible in a five-minute demo. */
  wouldAlsoResolve: number;
}

export interface ReviewItem {
  matchId: string;
  tier: string;
  confidence: number;
  /**
   * NULL for `batch` matches — 7 of 49 in the review queue on the holdout.
   *
   * A batch decomposition is not produced by the pair scorer at all: it comes
   * out of the subset-sum search, so there are no amount/date/anchor components
   * to break down. The column is nullable and this is why.
   */
  scoreBreakdown: Record<string, number | boolean> | null;
  members: (RecordPreview | { transactionId: string; role: string; externalId: string | null;
    amountDisplay: string; txnDate: string; counterpartyRaw: string | null })[];
  whyFlagged: string;
  aliasSuggestions: AliasSuggestion[];
}

export interface ReviewQueueResponse { items: ReviewItem[]; pagination: Pagination }

// ── endpoints 13, 14 ─────────────────────────────────────────────────────────

export type ActorType = 'engine' | 'human' | 'llm' | 'agent';

export interface AuditEntry {
  sequenceNo: number;
  occurredAt: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  transactionId: string | null;
  actorType: ActorType;
  actorId: string;
  tier: string | null;
  ruleId: string | null;
  ruleVersion: string | null;
  decision: string | null;
  confidence: number | null;
  reason: string | null;
  beforeState: unknown;
  afterState: unknown;
  details: Record<string, unknown> | null;
}

export interface AuditListResponse { entries: AuditEntry[]; pagination: Pagination }

// ── endpoint 22 ──────────────────────────────────────────────────────────────

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  firstDivergenceSequenceNo: number | null;
  divergenceKind: string | null;
  chainHead: string;
  anchored: boolean;
  expectedEntryCount: number;
  expectedChainHead: string;
}

// ── endpoints 15–18 ──────────────────────────────────────────────────────────

/**
 * TRANSCRIBED FROM A REAL RESPONSE, NOT FROM MEMORY (ADR-128).
 *
 * The previous declaration invented three fields the API has never sent —
 * `createdAt`, `note` and `timesApplied` — and omitted eight it does. Reading
 * `a.createdAt` yielded `undefined`, `at(undefined)` threw
 * `RangeError: Invalid time value`, and the whole screen died. **`tsc` cannot
 * see this**: the field is declared `string`, so every use typechecks, and the
 * value is only missing at runtime.
 *
 * It went unnoticed because the screen had never rendered a row — zero aliases
 * had ever been taught, which is what F9 was investigating when it crashed.
 */
export interface Alias {
  aliasId: string;
  aliasType: string;
  scopeSource: string;
  rawValue: string;
  /** The §3.3-normalized lookup key Tier 1.5 matches on. */
  normalizedValue: string;
  canonicalValue: string;
  status: string;
  confirmationCount: number;
  conflictCount: number;
  appliedCount: number;
  /** `null` until the engine has actually resolved something with it. */
  lastAppliedAt: string | null;
  /** §6.3: a conflicted alias is held out of Tier 1.5 until re-confirmed. */
  eligibleForAliasTier: boolean;
  createdFromMatchId: string | null;
  createdBy: string;
  approvedAt: string;
  supersededBy: string | null;
  revokedReason: string | null;
}

export interface AliasListResponse { aliases: Alias[]; pagination: Pagination }

// ── endpoint 24 ──────────────────────────────────────────────────────────────

export interface PopulationItem {
  kind: 'excluded' | 'rejected' | 'duplicates';
  transactionId: string | null;
  sourceSystem: string;
  sourceRowNumber: number;
  externalId: string | null;
  amountPaise: number | null;
  amountDisplay: string | null;
  txnDate: string | null;
  reason: string;
}

export interface PopulationResponse {
  items: PopulationItem[];
  counts: { excluded: number; rejected: number; duplicates: number; reconcilable: number };
  pagination: Pagination;
}

// ── endpoint 27 ──────────────────────────────────────────────────────────────

export interface ReasoningStep {
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  /** The model's own words. */
  inference: string;
  /** Recorded by the RUNTIME, not the model. The two are rendered apart on purpose. */
  resultDigest: string;
}

/**
 * MOST OF THIS IS UNPOPULATED WHILE `status === 'running'`, and the types say so.
 *
 * `startInvestigation` inserts only run/exception/model/promptVersion; everything
 * describing a RESULT is written by `concludeInvestigation`. So a running
 * investigation carries `costUsd: null`, `tokensIn/Out: null`, no verdict, and —
 * the dangerous one — `groundingPassed: false`, which is the column's DEFAULT
 * rather than a finding. Rendering that as "Rejected" asserts the gate refused a
 * verdict that does not exist yet.
 *
 * Read `status` FIRST. Nothing below it means anything until it is `concluded`.
 */
export interface InvestigationDetail {
  investigationId: string;
  runId: string;
  exceptionId: string;
  status: 'running' | 'concluded' | 'failed';
  verdict: Verdict | null;
  confidence: 'high' | 'medium' | 'low' | null;
  proposedAction: Record<string, unknown> | null;
  reasoning: ReasoningStep[];
  citations: string[];
  /** `false` while running is a DEFAULT, not a result. Gate on `status`. */
  groundingPassed: boolean;
  groundingFailure: string | null;
  budgetExhausted: boolean;
  steps: number;
  toolCalls: number;
  tokensIn: number | null;
  tokensOut: number | null;
  /** NULL while running, and NULL on a free-tier key — never 0 (ADR-093). */
  costUsd: number | null;
  model: string;
  promptVersion: string;
  humanDisposition: string | null;
  resultingMatchId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// ── endpoint 12 ──────────────────────────────────────────────────────────────

export interface TransactionDetail {
  transactionId: string;
  runId: string;
  sourceSystem: string;
  sourceFile: string;
  sourceRowNumber: number;
  externalId: string | null;
  referenceIds: Record<string, string>;
  anchorStrength: string;
  amountPaise: number;
  amountDisplay: string;
  feePaise: number | null;
  taxPaise: number | null;
  netAmountPaise: number | null;
  currency: string;
  direction: string | null;
  txnDate: string;
  txnTimestamp: string | null;
  postingDate: string | null;
  counterpartyRaw: string | null;
  counterpartyNorm: string | null;
  counterpartyKey: string | null;
  method: string | null;
  statusRaw: string | null;
  statusNorm: string;
  txnType: string | null;
  descriptionRaw: string | null;
  duplicateOfTransactionId: string | null;
  duplicateKind: string | null;
  ingestWarnings: string[] | null;
  membership: unknown;
  exceptionId: string | null;
  rawPayload: Record<string, unknown>;
}

// ── endpoint 1 ───────────────────────────────────────────────────────────────

export interface SeedDatasetOption { seed: number; label: string }

export interface Health {
  status: string;
  dbConnected: boolean;
  /** ONE boolean for both LLM surfaces (ADR-093). */
  llmConfigured: boolean;
  /** The datasets a run may be started against, served so the UI cannot offer
   *  a seed `POST /api/runs` would refuse (ADR-129). */
  datasets: SeedDatasetOption[];
  version: string;
}
