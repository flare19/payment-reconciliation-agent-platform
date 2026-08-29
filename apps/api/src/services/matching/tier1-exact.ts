/**
 * S6 — Tier 1, exact (matching-engine.md §4).
 *
 * ===========================================================================
 * THIS FILE OWNS THE EXACT-MATCH PREDICATE. Tier 1.5 (`tier1_5-alias.ts`)
 * substitutes learned aliases and then calls `tier1Match` again — it never
 * carries its own copy of the test. `tier1-single-predicate-guard.test.ts`
 * fails if the seam disappears. Two copies of this predicate agree on the day
 * the second is written and drift silently afterwards, and the drift shows up
 * as wrong tier attribution — a number the submission publishes.
 * ===========================================================================
 *
 * "Exact" means IDENTITY IS CERTAIN AND EVERYTHING CORROBORATES, not "the bytes
 * are identical" (ADR-028). A T+2 card settlement with a byte-exact reference is
 * a Tier 1 match; its amounts are never byte-equal (the bank credit is net of a
 * fee) and its dates are two days apart. So the predicate is:
 *
 *   1. a shared STRUCTURED strong anchor (never a description-extracted value —
 *      identity may not rest on a regex hit, schema.md §3.1);
 *   2. direction agrees — a hard gate, never scored (ADR-035);
 *   3. currency agrees (always true in v1, checked anyway);
 *   4. amounts agree on the §5.3.1 basis for that source pair;
 *   5. dates agree within the §5.2 window for that source pair.
 *
 * A CONSEQUENCE worth stating: bank rows carry no structured strong anchor (their
 * rrn / settlement_id live inside the free-text description and are weak by
 * definition), so `sharedStrongAnchor` is always null for a gateway↔bank or
 * bank↔ledger pair. Tier 1 therefore only ever produces gateway↔ledger matches,
 * on the ledger's `gateway_ref` (`EXACT_GATEWAY_REF_V1`). All gateway↔bank
 * correlation happens at Tier 2, where the description-extracted anchor scores as
 * a weak reference. The answer key optimistically labels those pairs `exact`
 * (`viaTier` is "the weakest tier that should suffice"); the scorer's
 * tier-attribution reconciles the difference (validation-strategy §5.1.2).
 *
 * That is ONE of three reconciliation cases, not the whole of the gap — the
 * sentence above used to read as if it were exhaustive (issue #34). The others:
 * a gateway<->ledger AMOUNT_TRUE_MISMATCH pair carries a byte-identical
 * payment_id and is labelled `exact` + `shouldMatch: true`, yet Tier 1 CORRECTLY
 * refuses it on amount and S8 resolves it to an AMOUNT_MISMATCH exception; and
 * `matches.tier` is a GROUP's weakest tier, so it is not comparable to a PAIR's
 * `viaTier` at all. All three are settled by ADR-072.
 */

import type { MemberRole } from '../../types/domain.js';
import type {
  BlockIndexes, NormalizedTransaction, RunConfig, Tier1Match, Tier1PairMatch,
} from '../../types/engine.js';
import { sharedStrongAnchor } from './anchors.js';
import { strongAnchorPairs } from './blocking.js';
import { directionAgrees, evaluateAmount, evaluateDate } from './tolerance.js';

/** matching-engine.md §4.4 — the rule id names the anchor that carried the match. */
const RULE_BY_ANCHOR: Record<string, string> = {
  payment_id: 'EXACT_PAYMENT_ID_V1',
  settlement_id: 'EXACT_SETTLEMENT_ID_V1',
  rrn: 'EXACT_RRN_V1',
  utr: 'EXACT_UTR_V1',
  entry_id: 'EXACT_ENTRY_ID_V1',
  invoice_no: 'EXACT_INVOICE_NO_V1',
};

function ruleIdFor(anchorKey: string, a: NormalizedTransaction, b: NormalizedTransaction): string {
  // A gateway↔ledger match on `payment_id` was carried by the ledger's
  // `gateway_ref` column — §4.4 names that case separately.
  if (anchorKey === 'payment_id' && (a.sourceSystem === 'ledger' || b.sourceSystem === 'ledger')) {
    return 'EXACT_GATEWAY_REF_V1';
  }
  return RULE_BY_ANCHOR[anchorKey] ?? `EXACT_${anchorKey.toUpperCase()}_V1`;
}

/**
 * The exact-match predicate. `null` ⇒ not a Tier 1 match (the pair proceeds).
 *
 * Deterministic and order-independent: `sharedStrongAnchor` returns the first
 * shared anchor in canonical key order, so which anchor is reported never
 * depends on which blocking slot found the pair.
 */
export function tier1Match(
  a: NormalizedTransaction, b: NormalizedTransaction, config: RunConfig,
): Tier1Match | null {
  if (a.id === b.id || a.sourceSystem === b.sourceSystem) return null;
  if (a.statusNorm !== 'reconcilable' || b.statusNorm !== 'reconcilable') return null;

  const shared = sharedStrongAnchor(a.referenceIds, b.referenceIds);
  if (shared === null) return null;

  if (!directionAgrees(a, b)) return null;
  if (a.currency !== b.currency) return null;

  const amount = evaluateAmount(a, b, config);
  const date = evaluateDate(a, b, config);
  if (amount === null || date === null) return null;
  // `unavailable` is the bank↔ledger case — no comparable amount, so no exact
  // match. (Unreachable while bank carries no structured anchor, but the
  // predicate must not depend on that to be correct.)
  if (amount.unavailable || !amount.within) return null;
  if (!date.within) return null;

  const ruleId = ruleIdFor(shared.key, a, b);
  return {
    ruleId,
    anchorKey: shared.key,
    anchorValue: shared.value,
    amountDeltaPaise: amount.deltaPaise,
    dateDeltaDays: date.deltaDays,
    basis: amount.basis,
    window: date.window,
    reason:
      `${shared.key} ${shared.value} matches on both sides; amount within ` +
      `${amount.tolerancePaise} paise and date ${date.deltaDays}d inside ` +
      `[${date.window[0]}, ${date.window[1]}]`,
  };
}

/**
 * S6 driver — run the predicate over every anchor-sharing cross-source pair.
 *
 * Emits pairs, not groups: a gateway row matching both a bank row and a ledger
 * row on one anchor yields two pairs that S11 assembles into one 3-way group.
 */
export function runTier1(blocks: BlockIndexes, config: RunConfig): { matches: Tier1PairMatch[] } {
  const matches: Tier1PairMatch[] = [];
  for (const { a, b } of strongAnchorPairs(blocks)) {
    const m = tier1Match(a, b, config);
    if (m === null) continue;
    matches.push({
      ...m,
      aId: a.id,
      bId: b.id,
      aRole: a.sourceSystem as MemberRole,
      bRole: b.sourceSystem as MemberRole,
      tier: 'exact',
      confidence: 1,
      aliasIds: [],
    });
  }
  return { matches };
}
