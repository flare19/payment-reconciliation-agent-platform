/**
 * The spend guard (ADR-094). `AGENT_MAX_COST_USD_PER_RUN` made real.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * BEFORE THIS FILE, THE COST CAP WAS PARSED AND ENFORCED NOWHERE.
 *
 * `env.ts` read `AGENT_MAX_COST_USD_PER_RUN`, `agent-design.md` §8 listed it as
 * a bound, and `grep` found no consumer. `LoopDeps.preflight` was written as
 * "the seam the spend guard plugs into" and nothing ever plugged into it. On a
 * free tier that was harmless — there was no bill. On a prepaid key with auto-
 * reload OFF it is the difference between a run that stops and a balance that
 * is gone mid-investigation, taking the run with it.
 *
 * ── IT REFUSES BEFORE THE CALL, NOT AFTER ──
 * A cap checked after the fact is a report. This computes the WORST CASE of the
 * turn about to be made — every token already in the conversation billed as
 * input, plus `maxOutputTokens` billed as output — and refuses if that would
 * cross the cap. Worst case, not expected case: an expected-case guard that is
 * wrong once has already spent the money.
 *
 * ── A REFUSAL IS NOT A CRASH ──
 * `preflight` returns a string, the loop treats it as a bound that binds, and
 * (see #64) the investigation gets ONE final turn to write a verdict from work
 * already paid for. So hitting the cap costs a verdict's worth of tokens and
 * yields a verdict, rather than costing everything and yielding nothing.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import type { AgentUsage, CostModel } from './agent-client.js';
import { usdFor } from './agent-client.js';

export interface SpendGuardOptions {
  /** Hard ceiling for the whole phase, in USD. */
  maxUsd: number;
  /** Published rates. `null` means nothing is billed and the guard is inert. */
  cost: CostModel | null;
  /** Worst-case output tokens for one turn — the loop's `maxOutputTokens`. */
  maxOutputTokensPerTurn: number;
}

export interface SpendGuard {
  /** Pass as `LoopDeps.preflight`. */
  preflight: (estimate: { step: number; usageSoFar: AgentUsage }) => string | null;
  /** Fold a finished investigation's usage into the running total. */
  record: (usage: AgentUsage) => void;
  spentUsd: () => number;
  remainingUsd: () => number;
}

export function createSpendGuard(opts: SpendGuardOptions): SpendGuard {
  const { maxUsd, cost, maxOutputTokensPerTurn } = opts;
  // Usage from investigations that have already FINISHED. The in-flight
  // investigation's own usage arrives on `usageSoFar`, so adding both is the
  // true running total and neither is double-counted.
  const settled: AgentUsage = { tokensIn: 0, tokensOut: 0 };

  const spentUsd = (): number =>
    cost === null ? 0 : usdFor(settled, cost);

  return {
    spentUsd,
    remainingUsd: () => Math.max(0, maxUsd - spentUsd()),

    record(usage: AgentUsage): void {
      settled.tokensIn += usage.tokensIn;
      settled.tokensOut += usage.tokensOut;
    },

    preflight({ usageSoFar }): string | null {
      // No rates means no bill to cap. NOT a silent pass-through of an unknown
      // model: `costModelFor` returns null only for the free tier or a model
      // whose price we do not know, and in the latter case the honest position
      // is that this guard cannot help — which the caller is told at startup.
      if (cost === null) return null;

      const spent = usdFor(
        { tokensIn: settled.tokensIn + usageSoFar.tokensIn,
          tokensOut: settled.tokensOut + usageSoFar.tokensOut },
        cost);

      // The worst case for the turn about to be made: the whole conversation
      // re-billed as input (every turn resends it), plus a full output cap.
      const worstCaseNext = usdFor(
        { tokensIn: usageSoFar.tokensIn, tokensOut: maxOutputTokensPerTurn },
        cost);

      if (spent + worstCaseNext > maxUsd) {
        return `refused before the call: $${spent.toFixed(4)} spent and this turn could `
          + `cost up to $${worstCaseNext.toFixed(4)}, which would cross the `
          + `$${maxUsd.toFixed(2)} run ceiling`;
      }
      return null;
    },
  };
}
