/**
 * The Q&A quota (agent-design.md §9, U15 unit 2).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS ENDPOINT IS THE ONLY FREE-TEXT BOX ON A PUBLIC, UNAUTHENTICATED DEMO.
 *
 * `agent-design.md` §9 says so plainly, and corrects a claim `deployment.md`
 * used to make — *"there is no user-facing 'ask the AI' box, so there is no
 * path for an anonymous visitor to burn quota"* — which this endpoint makes
 * false. Every other spending surface in the product needs a human to open a
 * specific exception and confirm a specific price. This one takes a sentence
 * from a stranger.
 *
 * So the quota is not ceremony, and it is not one number. It is four checks in
 * increasing order of cost to evaluate, and the FIRST one that binds is the one
 * reported — a refusal that names the wrong bound sends someone to fix the
 * wrong thing.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── COUNTS BOUND VOLUME. ONLY DOLLARS BOUND SPEND. ──
 * §9 specifies question counts (50/run, 100/hour) and those are real bounds —
 * against hammering, against a script, against one visitor monopolising the
 * demo. They are NOT a spend bound, and treating them as one would repeat a
 * mistake this project has already made once: a count cap cannot bound a bill
 * when per-question cost varies by an order of magnitude with how many tools
 * the model reaches for. ADR-095 learned that on endpoint 25 and answered it by
 * denominating the public ceiling in DOLLARS, derived from rows already
 * written. This guard does both, because each is blind to what the other
 * catches.
 *
 * ── THE DOLLAR CEILING IS SHARED WITH INVESTIGATIONS, ON PURPOSE ──
 * `agentSpendUsdSince` now sums questions alongside investigations and
 * corroborations (U15 unit 2), and this guard reads that same total against
 * that same `AGENT_MAX_COST_USD_PER_HOUR`. Two separate hourly budgets would
 * make the real exposure their SUM while letting each report itself as within
 * bounds — and there is only one prepaid key behind both. One wallet, one
 * ceiling.
 *
 * ── A REFUSAL IS A 429 WITH A REASON, NEVER A SILENT NO-OP ──
 * Every refusal below states which bound bound, what the current figure is and
 * what the ceiling is. `AGENT_QUOTA_EXCEEDED` is the contract's code
 * (api-contract §28) and the message is what a judge reads when the demo says
 * no — it should read as a system working, not as a system broken.
 */

import type { CostModel } from './agent-client.js';
import type { ErrorCode } from '../../types/dto.js';

/** Everything the guard needs, read by the caller so this stays pure and testable. */
export interface QaQuotaInput {
  /** `AGENT_QA_ENABLED`. False is an explicit operator decision, not an error. */
  enabled: boolean;
  /** Questions already asked against THIS run. */
  questionsThisRun: number;
  /** Questions asked across the deployment in the trailing hour. */
  questionsThisHour: number;
  /** Dollars billed across ALL agent surfaces in the trailing hour. */
  spentThisHourUsd: number;
  limits: {
    maxQuestionsPerRun: number;
    maxQuestionsPerHour: number;
    maxCostUsdPerHour: number;
  };
  /**
   * Published rates, or `null` on a key that bills nothing.
   *
   * When null the DOLLAR check is skipped and the count checks still apply —
   * the same posture endpoint 25 takes. A free tier has no bill to bound, but
   * it still has a demo that one visitor can monopolise.
   */
  cost: CostModel | null;
}

export type QaQuotaDecision =
  | { allowed: true; remainingUsd: number }
  // `ErrorCode`, not `string`: `ERROR_CODES` is locked by api-contract.md, so a
  // refusal that invented a code would be a silent contract break. The compiler
  // is the check.
  | { allowed: false; status: 429 | 503; code: ErrorCode; reason: string };

export function checkQaQuota(input: QaQuotaInput): QaQuotaDecision {
  const { limits } = input;

  // 1 · The kill switch, first because it is an operator's deliberate answer
  //     and no other check's outcome changes it. 503, not 429: the feature is
  //     switched off, not rate-limited, and telling a caller to retry later
  //     would be a lie (api-contract §28).
  if (!input.enabled) {
    return {
      allowed: false, status: 503, code: 'AGENT_DISABLED',
      reason: 'The Q&A agent is switched off on this deployment. Everything else on this '
        + 'page was produced without it.',
    };
  }

  // 2 · Per-run volume. Cheapest count, and the one a single curious visitor
  //     is most likely to meet.
  if (input.questionsThisRun >= limits.maxQuestionsPerRun) {
    return {
      allowed: false, status: 429, code: 'AGENT_QUOTA_EXCEEDED',
      reason: `This run has already been asked ${input.questionsThisRun} questions, at its `
        + `ceiling of ${limits.maxQuestionsPerRun}. Start a new run to ask more — the answers `
        + 'already given are still on the page.',
    };
  }

  // 3 · Deployment-wide volume. Bounds a script, not a person.
  if (input.questionsThisHour >= limits.maxQuestionsPerHour) {
    return {
      allowed: false, status: 429, code: 'AGENT_QUOTA_EXCEEDED',
      reason: `The Q&A agent has answered ${input.questionsThisHour} questions in the last `
        + `hour, at its ceiling of ${limits.maxQuestionsPerHour}. It accepts questions again `
        + 'as older ones leave the window.',
    };
  }

  // 4 · Money. Last because it is the only check that needs a sum over three
  //     tables, and first in importance — the other three bound how often this
  //     can happen, this one bounds what it can cost.
  const remainingUsd = limits.maxCostUsdPerHour - input.spentThisHourUsd;
  if (input.cost !== null && remainingUsd <= 0) {
    return {
      allowed: false, status: 429, code: 'AGENT_QUOTA_EXCEEDED',
      reason: `The Analyst has spent $${input.spentThisHourUsd.toFixed(2)} in the last hour, `
        + `at or above the $${limits.maxCostUsdPerHour.toFixed(2)} ceiling. It answers `
        + 'questions again as older spend leaves the window.',
    };
  }

  return { allowed: true, remainingUsd };
}
