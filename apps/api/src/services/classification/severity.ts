/**
 * Exception severity (ADR-044) — computed from category AND money at risk.
 *
 * A fixed per-category severity made a Rs.5 rounding mismatch and a Rs.5,00,000
 * partial capture both `high`, which makes the exception list's default sort
 * order useless. A finance controller triages by money at risk, and the exception
 * list is the product — so its default ordering is a product decision, not a
 * cosmetic one.
 *
 * Every input is recorded in `evidence.severityBasis`, so the sort order on the
 * primary screen is always explainable rather than merely asserted.
 */

import type { ExceptionCategory, Paise, Severity } from '../../types/domain.js';
import type { RunConfig } from '../../types/engine.js';

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };
const BY_RANK: Severity[] = ['low', 'medium', 'high'];

/**
 * Base severity per category (schema.md §8.1).
 *
 * `DUPLICATE_RECORD` is passed a sub-kind because ADR-034 gives the two kinds
 * different weight: an EXACT duplicate is proved by a shared strong anchor, while
 * a SUSPECTED one is circumstantial and both copies stay in the matching pool.
 * Filing an unproven guess at the same severity as a proof would misrepresent how
 * much the engine actually knows.
 */
export function baseSeverity(
  category: ExceptionCategory,
  options: { duplicateKind?: 'exact' | 'suspected' } = {},
): Severity {
  switch (category) {
    case 'DUPLICATE_RECORD':
      return options.duplicateKind === 'suspected' ? 'medium' : 'high';
    case 'AMBIGUOUS_MATCH':  return 'high';
    case 'MISSING_IN_BANK':  return 'high';
    case 'AMOUNT_MISMATCH':  return 'high';
    case 'MISSING_IN_LEDGER':   return 'medium';
    case 'MISSING_IN_GATEWAY':  return 'medium';
    case 'UNSPLITTABLE_BATCH':  return 'medium';
    case 'TIMING_DRIFT':     return 'low';
  }
}

export interface SeverityBasis {
  base: Severity;
  amountAtRiskPaise: Paise | null;
  escalated: boolean;
  /** Set when a cap held the result below what the amount alone would give. */
  cappedBy: ExceptionCategory | null;
}

export interface SeverityResult {
  severity: Severity;
  basis: SeverityBasis;
}

/**
 * Escalate a base severity by money at risk.
 *
 *   >= Rs.2,00,000  -> high
 *   >= Rs.50,000    -> one level up from base
 *   otherwise       -> base
 *
 * `TIMING_DRIFT` is capped at `medium` regardless of amount: a late settlement is
 * a process artifact at any size, and letting a large one outrank a genuine value
 * discrepancy would put the wrong row at the top of the screen.
 */
export function computeSeverity(
  category: ExceptionCategory,
  amountAtRiskPaise: Paise | null,
  config: RunConfig,
  options: { duplicateKind?: 'exact' | 'suspected' } = {},
): SeverityResult {
  const base = baseSeverity(category, options);
  let rank = RANK[base];
  let escalated = false;

  if (amountAtRiskPaise !== null) {
    const magnitude = Math.abs(amountAtRiskPaise);
    if (magnitude >= config.severityEscalateHighPaise) {
      if (RANK.high > rank) { rank = RANK.high; escalated = true; }
    } else if (magnitude >= config.severityEscalateOneLevelPaise) {
      if (rank < RANK.high) { rank += 1; escalated = true; }
    }
  }

  let cappedBy: ExceptionCategory | null = null;
  if (category === 'TIMING_DRIFT' && rank > RANK.medium) {
    rank = RANK.medium;
    cappedBy = 'TIMING_DRIFT';
  }

  return {
    severity: BY_RANK[rank]!,
    basis: { base, amountAtRiskPaise, escalated, cappedBy },
  };
}
