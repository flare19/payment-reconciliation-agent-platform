/**
 * Shipped engine defaults. Every number here has a reason recorded in an ADR —
 * do not change one without appending a new ADR (CLAUDE.md §9.2).
 *
 * These are overridable per run via `configOverrides` (api-contract §2), and
 * whatever is finally used is written verbatim into `runs.config_snapshot`.
 */

import type { RunConfig, ScoreWeights } from '../types/engine.js';

/**
 * ADR-080's explain model, in ONE place.
 *
 * It is hashed into every `signature_hash` (ADR-018), so it must be the same
 * string whether it arrives from `GEMINI_EXPLAIN_MODEL` or from a default. Two
 * spellings of the default would be two cache namespaces that look like one.
 */
export const DEFAULT_EXPLAIN_MODEL = 'gemini-3.5-flash';

/**
 * `prompt_version` (schema.md §10.2), in ONE place, for the same reason as the
 * model above: it is hashed into every `signature_hash`, so two spellings would
 * be two cache namespaces that look like one. `services/explain/templates.ts`
 * re-exports this as `PROMPT_VERSION` and owns the prose it versions — bump it
 * HERE whenever that prompt changes, and every signature re-resolves.
 */
export const DEFAULT_PROMPT_VERSION = 'v1';

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
  // ADR-065: a BANK record's own fallback wait for a missing gateway
  // counterpart. Deliberately much tighter than dateWindowCardDays (which
  // runs the other way, gateway -> bank) — a real gateway record should
  // already be ingested by the time its bank credit lands, so this exists
  // only for the same IST/UTC midnight slack every other window carries, not
  // for a settlement SLA.
  dateWindowGatewayLookbackDays: [-1, 1],

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
  // ADR-060, amended by ADR-063: the deterministic primary bound. A wall-clock
  // bound would make exhaustiveness a property of the machine rather than of
  // the data.
  //
  // This is a PROOF, not a measurement: the declared space is subsets of size
  // 0..batchMaxSubsetSize (8) drawn from a pool of up to batchPoolCap (24)
  // candidates, so the combinatorial ceiling is Sum(C(24,k), k=0..8) =
  // 1,271,626 nodes. The budget below provably dominates every input the caps
  // permit — it is not sized from a hard case that happened to be measured.
  // The true worst case (24 equal-amount candidates with an unreachable
  // target, so pruning barely bites) visits ~1.08M nodes and measures well
  // under 50 ms locally — the ceiling is provable, the timing is illustrative.
  batchNodeBudget: 1_300_000,
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
