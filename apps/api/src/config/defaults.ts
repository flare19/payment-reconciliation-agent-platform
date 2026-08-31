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

/**
 * Phase A's model (ADR-080, amended by ADR-086).
 *
 * ADR-080 named `gemini-3.7-flash`, chosen from Google's DESCRIPTION of it
 * ("built for complex coding, agentic workflows") rather than from any
 * measurement. On this key it answers "reply with the single word: ok" in
 * **53 seconds** — 63 s with thinking disabled, so the latency is not thinking.
 * `gemini-3.6-flash` answers the same prompt in **2.4 s**.
 *
 * That is not a preference, it is a contradiction: `agent-design.md` §8 bounds an
 * ENTIRE investigation at 60 s, and one turn on 3.7 exceeds the budget for the
 * whole investigation. The model ADR-080 picked cannot satisfy the spec ADR-080
 * sits beside.
 */
export const DEFAULT_AGENT_MODEL = 'gemini-3.6-flash';

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
  // ADR-085. The agent widens the NODE budget, never a time budget: a
  // wall-clock bound would make `searchExhausted` vs `searchBoundExceeded` a
  // property of the hardware, inside the evidence a reasoning chain cites.
  //
  // 5,200,000 is NOT a dominance proof (unlike the engine's figure, ADR-063 —
  // at pool 64 / subset 10 the declared space is ~1.5e11 and no budget covers
  // it). It is derived from the opposite constraint: the node budget must stay
  // small enough that the 2 s safety valve NEVER fires, or the valve silently
  // becomes the bound and the machine-dependence returns. ~1.08M nodes measures
  // well under 50 ms locally, so ~5.2M is ~250 ms — an 8x margin.
  rerunSubsetCeilings: { poolSize: 64, maxSubsetSize: 10, nodeBudget: 5_200_000 },
  /**
   * A2 CORROBORATE (agent-design §3, ADR-081) — "half an investigation".
   *
   * Numerically equal to `qa` below and deliberately NOT the same constant:
   * they bound different loops for different reasons, and collapsing them would
   * mean a future change to the Q&A budget silently re-tuned review-queue
   * corroboration.
   */
  corroborate: { maxSteps: 6, maxToolCalls: 8 },
  qa: { maxSteps: 6, maxToolCalls: 8, maxOutputTokens: 1024 },
  /** ADR-081. Cut FIRST when the request budget binds — the pre-agreed degradation. */
  maxQueueTriagesPerRun: 15,
  /**
   * The bound that actually binds on a free tier (ADR-080 consequence 2):
   * requests per day, not dollars. Lives here rather than only in `env.ts` so
   * the default has one home — the same reason `DEFAULT_EXPLAIN_MODEL` does.
   */
  maxLlmRequestsPerRun: 220,
  /** A1 triage: which categories are worth an investigation (agent-design §3). */
  eligibleCategories: [
    'AMBIGUOUS_MATCH', 'UNSPLITTABLE_BATCH', 'MISSING_IN_BANK',
    'MISSING_IN_LEDGER', 'MISSING_IN_GATEWAY', 'AMOUNT_MISMATCH',
  ] as const,
} as const;
