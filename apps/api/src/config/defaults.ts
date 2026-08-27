/**
 * Shipped engine defaults. Every number here has a reason recorded in an ADR —
 * do not change one without appending a new ADR (CLAUDE.md §9.2).
 *
 * These are overridable per run via `configOverrides` (api-contract §2), and
 * whatever is finally used is written verbatim into `runs.config_snapshot`.
 */

import type { RunConfig, ScoreWeights } from '../types/engine.js';

/** ADR-030. Sum = 1.00. See the ceiling guarantee documented on `ScoreWeights`. */
export const SCORE_WEIGHTS: ScoreWeights = {
  anchor: 0.30,
  amount: 0.35,
  date: 0.20,
  counterparty: 0.15,
  anchorStrongWeak: 0.30,
  anchorNear: 0.24,
  anchorWeakWeak: 0.20,
};

export const ENGINE_DEFAULTS: Omit<RunConfig, 'referenceDate' | 'aliasCountAtStart'> = {
  // ADR-008: clamp(0.5% × amount, ₹1.00, ₹100.00).
  // Deliberately BELOW the gateway fee band — fees are handled by an explicit
  // net-amount rule, not absorbed by a loose tolerance.
  amountTolerancePct: 0.005,
  amountToleranceFloorPaise: 100,
  amountToleranceCapPaise: 10_000,

  // ADR-009: asymmetric, because settlement flows forward in time.
  // The -1 on every window is required by real IST/UTC midnight drift.
  dateWindowCardDays: [-1, 3],
  dateWindowUpiDays: [-1, 2],
  dateWindowLedgerDays: [-1, 1],
  dateWindowBankLedgerDays: [-2, 4],

  // schema.md §5.3: 2.0–2.5% fee + 18% GST on the fee.
  feeBandMinPct: 0.0236,
  feeBandMaxPct: 0.0295,

  fuzzyAutoConfirmThreshold: 0.85,
  fuzzyReviewThreshold: 0.65,
  ambiguityDeltaThreshold: 0.05,

  scoreWeights: SCORE_WEIGHTS,

  candidateCap: 200,          // ADR-033
  batchPoolCap: 24,           // ADR-038
  batchMaxSubsetSize: 8,
  // ADR-060: the deterministic primary bound. A wall-clock bound would make
  // exhaustiveness a property of the machine rather than of the data.
  //
  // Sized from measurement, not taste: a full 24-candidate pool with no solution
  // and zero tolerance — the worst case the caps allow — visits ~200k nodes in
  // ~5 ms. 1M nodes is therefore ~25 ms locally and stays inside the safety valve
  // even on a machine 80x slower. A realistic batch settles in ~1.4k nodes.
  batchNodeBudget: 1_000_000,
  // Safety valve only. The node budget already guarantees termination, so this
  // exists solely for a pathological case where individual nodes are expensive.
  // If it ever fires, that is a bug report, not a tuning opportunity.
  batchSubsetBudgetMs: 2_000,

  nearAnchorMinLength: 12,    // ADR-031
  nearAnchorMaxDistance: 1,

  severityEscalateHighPaise: 20_000_000,      // ₹2,00,000 → high (ADR-044)
  severityEscalateOneLevelPaise: 5_000_000,   // ₹50,000 → one level up

  aliasLearningEnabled: true,
  llmExplainEnabled: true,
  llmMaxCallsPerRun: 8,

  ruleVersion: '1.0.0',
};

/** ADR-054. Ceilings the agent cannot exceed even when it asks to. */
export const AGENT_DEFAULTS = {
  maxInvestigationsPerRun: 20,
  budget: { maxSteps: 10, maxToolCalls: 16, maxWallMs: 60_000, maxTokens: 40_000 },
  rerunSubsetCeilings: { poolSize: 64, maxSubsetSize: 10, budgetMs: 2_000 },
  qa: { maxSteps: 6, maxToolCalls: 8, maxOutputTokens: 1024 },
  /** A1 triage: which categories are worth an investigation (agent-design §3). */
  eligibleCategories: [
    'AMBIGUOUS_MATCH', 'UNSPLITTABLE_BATCH', 'MISSING_IN_BANK',
    'MISSING_IN_LEDGER', 'MISSING_IN_GATEWAY', 'AMOUNT_MISMATCH',
  ] as const,
} as const;
