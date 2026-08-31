/**
 * A1 — triage (agent-design.md §3, §3.1b; ADR-081). U13.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * SELECTION IS DETERMINISTIC EVEN THOUGH THE INVESTIGATIONS ARE NOT.
 *
 * This is the property that makes Phase A auditable at all. An investigation's
 * *conclusion* comes from a language model and is not reproducible; its
 * *subject* is chosen by an explicit ORDER BY over committed rows and is. So
 * "why did the Analyst look at those twenty?" always has an answer, and a
 * changed work list is a code change rather than a mood.
 *
 * Both ORDER BYs live in SQL (`listExceptionTriageCandidates`,
 * `listQueueTriageCandidates`) because they are decision-feeding queries and
 * ADR-032 rule 9 requires it. This file owns what SQL cannot express: which
 * categories are eligible, how the two work lists share one request budget, and
 * which one gets cut when it binds.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── EXCEPTIONS RUN FIRST, AND THAT IS A PRE-AGREED DEGRADATION ──
 * Both lists draw on `AGENT_MAX_LLM_REQUESTS_PER_RUN` (§8). When it binds, queue
 * corroboration is what gets cut — the exception list is what the track grades,
 * and ADR-081 decided this in advance precisely so it is not decided under
 * pressure on submission day. The cut is COUNTED and REPORTED, never silent:
 * `queueTriagesSkipped` is the honest form of "we ran out of budget".
 *
 * ── TWO CATEGORIES ARE DELIBERATELY INELIGIBLE ──
 * `DUPLICATE_RECORD` and `TIMING_DRIFT`. The engine's verdict on both is already
 * complete — a proved duplicate has a shared strong anchor and a timing drift has
 * identity and amount agreeing with only the calendar off — so an agent adds
 * nothing but tokens. This is a scope decision, not an oversight, and
 * `AGENT_DEFAULTS.eligibleCategories` is its single source.
 */

import { AGENT_DEFAULTS } from '../../config/defaults.js';
import type { ExceptionCategory } from '../../types/domain.js';
import type { TxClient } from '../../db/pool.js';
import {
  listExceptionTriageCandidates, type TriageCandidate,
} from '../../repositories/exceptions.js';
import {
  listQueueTriageCandidates, type QueueTriageCandidate,
} from '../../repositories/matches.js';

export type { TriageCandidate, QueueTriageCandidate };

/** The categories §3 names. Re-exported so callers cannot invent their own list. */
export const ELIGIBLE_CATEGORIES: readonly ExceptionCategory[] =
  AGENT_DEFAULTS.eligibleCategories;

export function isEligibleCategory(category: ExceptionCategory): boolean {
  return (ELIGIBLE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * The two per-list caps. That is ALL triage bounds.
 *
 * ── WHY THE SHARED REQUEST BUDGET IS NOT ENFORCED HERE ──
 * §3 says both work lists draw on `AGENT_MAX_LLM_REQUESTS_PER_RUN` and that
 * queue corroboration is cut when it binds. My first version enforced that at
 * PLAN time by reserving each investigation's worst case — §8's 10-step ceiling
 * — against the budget up front. With the shipped numbers that reserves
 * 20 × 10 = 200 of 220 and leaves room for **three** corroborations of a
 * permitted fifteen, so ADR-081's second work list would be almost inert on
 * every run, starved by a worst case that rarely happens.
 *
 * The ceiling is a MAXIMUM, not an average, and reserving against it is a guess
 * wearing a bound's clothes — the same mistake as the 20 s explain timeout,
 * which was also a plausible number with nothing measured behind it.
 *
 * So the shared budget is enforced where the requests are actually SPENT: the
 * A2 loop counts real requests, works exceptions first, and stops corroborating
 * when the real bound binds. One enforcement point, no estimate, and it matches
 * what §3 actually says — "if the request budget binds" is a statement about
 * runtime, not about planning.
 */
export interface TriageBudget {
  /** `AGENT_MAX_INVESTIGATIONS_PER_RUN` (default 20). */
  maxInvestigations: number;
  /** `AGENT_MAX_QUEUE_TRIAGES_PER_RUN` (default 15). */
  maxQueueTriages: number;
}

export const DEFAULT_TRIAGE_BUDGET: TriageBudget = {
  maxInvestigations: AGENT_DEFAULTS.maxInvestigationsPerRun,
  maxQueueTriages: AGENT_DEFAULTS.maxQueueTriagesPerRun,
};

export interface TriagePlan {
  /** Exceptions to investigate, in §3's order. */
  investigate: TriageCandidate[];
  /** Pending matches to corroborate, in §3.1b's order. */
  corroborate: QueueTriageCandidate[];
  /** Eligible exceptions the investigation cap left out. Counted, never hidden. */
  investigationsSkipped: number;
  /** Pending matches the queue cap left out. The LOOP reports budget-driven cuts. */
  queueTriagesSkipped: number;
  eligibleExceptionCount: number;
  pendingMatchCount: number;
}

export interface TriageCounts {
  eligibleExceptions: number;
  pendingMatches: number;
}

/**
 * Build the run's two work lists.
 *
 * `counts` are the TOTALS the caller measured (how many eligible exceptions and
 * pending matches exist at all), so the plan can report what it left out rather
 * than only what it took. A plan that says "20 investigations" without saying
 * "of 96 eligible" is a number with no denominator, which is the thing this
 * project spends most of its comments refusing to ship.
 */
export function planTriage(
  candidates: { exceptions: TriageCandidate[]; queue: QueueTriageCandidate[] },
  counts: TriageCounts,
  budget: TriageBudget = DEFAULT_TRIAGE_BUDGET,
): TriagePlan {
  const investigate = candidates.exceptions.slice(0, Math.max(0, budget.maxInvestigations));
  const corroborate = candidates.queue.slice(0, Math.max(0, budget.maxQueueTriages));

  return {
    investigate,
    corroborate,
    investigationsSkipped: Math.max(0, counts.eligibleExceptions - investigate.length),
    queueTriagesSkipped: Math.max(0, counts.pendingMatches - corroborate.length),
    eligibleExceptionCount: counts.eligibleExceptions,
    pendingMatchCount: counts.pendingMatches,
  };
}

/**
 * Read both work lists and plan.
 *
 * Fetches ONE MORE than each cap so `planTriage` can distinguish "that is all
 * there is" from "there was more and we stopped" without a second COUNT query
 * — the same trick a paginator uses, and cheaper than counting a table twice.
 */
export async function triageRun(
  runId: string,
  budget: TriageBudget = DEFAULT_TRIAGE_BUDGET,
  client?: TxClient,
): Promise<TriagePlan> {
  const [exceptions, queue] = await Promise.all([
    listExceptionTriageCandidates(
      runId, ELIGIBLE_CATEGORIES, budget.maxInvestigations + 1, client),
    listQueueTriageCandidates(runId, budget.maxQueueTriages + 1, client),
  ]);
  return planTriage(
    { exceptions, queue },
    { eligibleExceptions: exceptions.length, pendingMatches: queue.length },
    budget);
}
