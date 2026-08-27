/**
 * S8 — the identity-established short-circuit (ADR-029).
 *
 * ===========================================================================
 * WHY THIS STAGE EXISTS. Without it, two of the eight exception categories are
 * STRUCTURALLY UNREACHABLE — not rare, not hard to hit: impossible.
 *
 * A gateway and a bank record sharing an identical payment_id, amounts off by
 * Rs.412 — the textbook AMOUNT_MISMATCH — scored under Tier 2 as:
 *     anchor 0.45 + amount 0.00 + date 0.15 + counterparty 0.10 = 0.70
 * which lands in the 0.65-0.849 review band. It became a PROPOSED MATCH and never
 * reached classification, so AMOUNT_MISMATCH could not fire.
 *
 * The mirror case was worse. Same anchor, amount exact, nine days late:
 *     anchor 0.45 + amount 0.30 + date 0.00 + counterparty 0.10 = 0.85
 * exactly the auto-confirm threshold. The engine would have SILENTLY MATCHED a
 * settlement three times past its SLA and reported it as clean.
 *
 * The root cause is a category error. A similarity score answers "are these the
 * same thing?" When a strong anchor already proves they are, scoring them asks a
 * question that has been answered — and blending that proof with unrelated
 * evidence lets a date disagreement cancel out an identity proof.
 *
 * So: identity established => NEVER SCORED. Resolved deterministically on value
 * and time instead.
 * ===========================================================================
 */

import { compareCanonical, type ExceptionCategory, type Paise } from '../../types/domain.js';
import type { NormalizedTransaction, RunConfig } from '../../types/engine.js';
import { contradictingStrongAnchor, sharedStrongAnchor, strongAnchors } from './anchors.js';
import {
  directionAgrees, evaluateAmount, evaluateDate,
  type AmountEvaluation, type DateEvaluation,
} from './tolerance.js';

export type IdentityOutcome =
  /** Amount and date both agree. S6 already claimed this pair; listed for completeness. */
  | 'match'
  | 'amount_mismatch'
  | 'timing_drift'
  | 'amount_mismatch_with_drift';

export type IdentityVerdict =
  /** No strong anchor agrees on both sides. The pair belongs to Tier 2. */
  | { kind: 'not_established' }
  /** Strong anchors of the same type disagree. Discarded, never scored (ADR-010). */
  | { kind: 'contradicted'; anchorKey: string; aValue: string; bValue: string; reason: string }
  /**
   * Anchors agree but one is a credit and the other a debit. NOT a match and NOT
   * an amount mismatch — it is a refund or reversal pairing (matching-engine §9),
   * and calling it a value discrepancy would misfile a normal business event as
   * a money problem.
   */
  | { kind: 'direction_conflict'; anchorKey: string; reason: string }
  | {
      kind: 'established';
      anchorKey: string;
      anchorValue: string;
      outcome: IdentityOutcome;
      category: ExceptionCategory | null;
      secondaryFlags: ExceptionCategory[];
      amountAtRiskPaise: Paise | null;
      amount: AmountEvaluation;
      date: DateEvaluation;
      ruleId: string;
      reason: string;
    };

/**
 * Resolve one cross-source pair on identity grounds.
 *
 * Returns `not_established` for anything Tier 2 should score. Crucially, identity
 * requires a strong anchor STRUCTURED ON BOTH SIDES: a value recovered from a
 * bank description blob is weak by definition (schema.md §3.1), and identity may
 * not rest on a regex hit. Those pairs are exactly what Tier 2 is for.
 */
export function resolveIdentity(
  a: NormalizedTransaction, b: NormalizedTransaction, config: RunConfig,
): IdentityVerdict {
  if (a.id === b.id || a.sourceSystem === b.sourceSystem) return { kind: 'not_established' };

  const shared = sharedStrongAnchor(a.referenceIds, b.referenceIds);
  if (shared === null) {
    const contradiction = contradictingStrongAnchor(a.referenceIds, b.referenceIds);
    if (contradiction !== null) {
      return {
        kind: 'contradicted',
        anchorKey: contradiction.key,
        aValue: contradiction.aValue,
        bValue: contradiction.bValue,
        reason:
          `${contradiction.key} differs (${contradiction.aValue} vs ${contradiction.bValue}); ` +
          `two records carrying different strong references are different payments`,
      };
    }
    return { kind: 'not_established' };
  }

  if (!directionAgrees(a.direction, b.direction)) {
    return {
      kind: 'direction_conflict',
      anchorKey: shared.key,
      reason:
        `${shared.key} ${shared.value} appears as a ${a.direction} and a ${b.direction}; ` +
        `this is a refund or reversal pairing, not an amount discrepancy`,
    };
  }

  const amount = evaluateAmount(a, b, config);
  const date = evaluateDate(a, b, config);
  if (amount === null || date === null) return { kind: 'not_established' };

  // bank<->ledger has no comparable amount (ADR-037), so "the amounts disagree"
  // is not a claim this engine can make about such a pair. Treat the amount as
  // agreeing and let the date decide; asserting AMOUNT_MISMATCH on two quantities
  // that were never comparable would be a fabricated finding.
  const amountAgrees = amount.unavailable ? true : amount.within;
  const dateAgrees = date.within;

  const outcome: IdentityOutcome =
    amountAgrees && dateAgrees ? 'match'
    : !amountAgrees && dateAgrees ? 'amount_mismatch'
    : amountAgrees && !dateAgrees ? 'timing_drift'
    : 'amount_mismatch_with_drift';

  // Precedence, exactly schema.md 8.2: money before calendar. A record can be
  // both off-amount and off-date; money discrepancy has financial consequence and
  // date drift is usually a process artifact, so reversing this would let a real
  // money problem be reported as a low-severity scheduling quirk.
  const category: ExceptionCategory | null =
    outcome === 'match' ? null
    : outcome === 'timing_drift' ? 'TIMING_DRIFT'
    : 'AMOUNT_MISMATCH';
  const secondaryFlags: ExceptionCategory[] =
    outcome === 'amount_mismatch_with_drift' ? ['TIMING_DRIFT'] : [];

  // Money at risk (ADR-044). For a value discrepancy it is the discrepancy
  // itself. For pure timing drift nothing is wrong with the amount — the money is
  // simply late — so the amount in question is what is exposed.
  const amountAtRiskPaise: Paise | null =
    outcome === 'match' ? null
    : outcome === 'timing_drift' ? Math.abs(a.amountPaise)
    : Math.abs(amount.deltaPaise);

  const ruleId =
    outcome === 'match' ? 'IDENTITY_CONFIRMED_V1'
    : outcome === 'timing_drift' ? 'IDENTITY_TIMING_DRIFT_V1'
    : 'IDENTITY_AMOUNT_MISMATCH_V1';

  return {
    kind: 'established',
    anchorKey: shared.key,
    anchorValue: shared.value,
    outcome, category, secondaryFlags, amountAtRiskPaise, amount, date, ruleId,
    reason: describe(shared.key, shared.value, outcome, amount, date),
  };
}

function describe(
  key: string, value: string, outcome: IdentityOutcome,
  amount: AmountEvaluation, date: DateEvaluation,
): string {
  const identity = `${key} ${value} matches on both sides, so these are the same payment`;
  switch (outcome) {
    case 'match':
      return `${identity}; amount and date both agree`;
    case 'amount_mismatch':
      return `${identity}, but the amounts differ by ${amount.deltaPaise} paise, ` +
        `beyond the ${amount.tolerancePaise} paise tolerance`;
    case 'timing_drift':
      return `${identity} and the amounts agree, but it is ${date.deltaDays} day(s) apart, ` +
        `outside the [${date.window[0]}, ${date.window[1]}] window`;
    case 'amount_mismatch_with_drift':
      return `${identity}, but the amounts differ by ${amount.deltaPaise} paise ` +
        `(tolerance ${amount.tolerancePaise}) and it is ${date.deltaDays} day(s) apart, ` +
        `outside the [${date.window[0]}, ${date.window[1]}] window`;
  }
}

/**
 * Group a population by strong anchor and resolve every cross-source pair that
 * shares one.
 *
 * This is the seam where S5 blocking will eventually feed pairs in. Until it
 * lands, S8 builds its own anchor index — an O(n) pass that is the same index
 * `byStrongAnchor` will be, so nothing here has to change when blocking arrives.
 */
export function resolveIdentities(
  pool: NormalizedTransaction[], config: RunConfig,
): { pair: [NormalizedTransaction, NormalizedTransaction]; verdict: IdentityVerdict }[] {
  const byAnchor = new Map<string, NormalizedTransaction[]>();
  for (const t of pool) {
    if (t.statusNorm !== 'reconcilable') continue;
    for (const anchor of strongAnchorsOf(t)) {
      const slot = anchor;
      const list = byAnchor.get(slot);
      if (list === undefined) byAnchor.set(slot, [t]); else list.push(t);
    }
  }

  const seen = new Set<string>();
  const out: { pair: [NormalizedTransaction, NormalizedTransaction]; verdict: IdentityVerdict }[] = [];

  // Sort slots so the emitted order does not depend on Map insertion order.
  for (const slot of [...byAnchor.keys()].sort()) {
    const rows = [...byAnchor.get(slot)!].sort(compareCanonical);
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i]!, b = rows[j]!;
        if (a.sourceSystem === b.sourceSystem) continue;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const verdict = resolveIdentity(a, b, config);
        if (verdict.kind !== 'not_established') out.push({ pair: [a, b], verdict });
      }
    }
  }
  return out;
}

/** Anchor slots a record occupies in the index. One vocabulary, from anchors.ts. */
function strongAnchorsOf(t: NormalizedTransaction): string[] {
  return strongAnchors(t.referenceIds).map((a) => `${a.key}::${a.value}`);
}
