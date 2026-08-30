/**
 * S10 — the batch stage (matching-engine.md §8 and §8.1, ADR-038).
 *
 * `batch-decomposition.ts` has held the arithmetic since Day 4: the pool builder,
 * the bounded subset search, the split-settlement mirror. Nothing called it. This
 * module is the missing caller — it decides WHICH records the stage is offered,
 * in WHAT order, and how its verdicts become groups (issue #46).
 *
 * It is deliberately thin. Every decision that could be wrong in an interesting
 * way lives in `batch-decomposition.ts` and is already tested there; what was
 * missing was never arithmetic, it was the two questions U6 declined to answer
 * alone. Both are answered here, explicitly, because they are judgment rather
 * than transcription:
 *
 * ── QUESTION 1: which records does S10 see? ──
 * Records still unmatched after S9 — nothing else. A record already in a
 * confirmed or proposed pair has a claim on it, and S10 re-deciding that claim
 * would make the engine's output depend on which stage spoke last. Every other
 * stage in this pipeline operates on what its predecessors left; S10 is not
 * special. It also means S10 can never contradict S9, only extend it.
 *
 * That answer only became well-defined after #40: before that fix, "unmatched
 * after S9" included 406 records Tier 2 had been structurally forbidden to look
 * at, and a pool built from it would have been full of records the engine had
 * simply not searched.
 *
 * ── QUESTION 2: splits or batches first? ──
 * **Splits first (§8.1), then batches (§8) over what splits did not consume.**
 * The two rules are duals — one gateway to N bank credits, versus N gateway
 * payments to one credit — and they compete for the same unmatched records, so
 * the order is a real decision rather than a formality.
 *
 * Splits go first because their evidence is IDENTITY-BEARING: `findSplitSettlement`
 * admits a leg only when it shares a strong anchor with the gateway record, or
 * falls inside that record's own settlement window with a non-contradicting
 * counterparty — and then demands exactly one arithmetic solution. Batch
 * decomposition is pure arithmetic over a date-and-counterparty pool with no
 * anchor requirement at all. The whole engine is ordered identity-before-
 * similarity (S6 exact, S7 alias, S8 identity, S9 fuzzy); running arithmetic
 * inference ahead of anchor-backed evidence would invert that inside one stage.
 *
 * ── WHAT THIS STAGE MAY NOT DO ──
 * It may not extend a group that already exists. A gateway record matched 1:1 at
 * S9 to one of its bank legs is NOT re-opened here to have a second leg added:
 * that is a re-decision of a settled claim, and it would put two bank members in
 * a group S11 built as `one_to_one`, tripping the role-collision rule (§10 rule
 * 3) at assembly time. The consequence is stated rather than hidden — a split
 * whose first leg happened to match at Tier 2 is NOT recovered by this stage,
 * and shows up as the remaining legs sitting in the exception list. Recovering
 * those needs S9 and S10 to negotiate, which is a design change and not a wiring
 * one.
 */

import { compareCanonical, type MemberRole } from '../../types/domain.js';
import type { NormalizedTransaction, ProposedMatch, RunConfig } from '../../types/engine.js';
import { dayDelta } from '../ingestion/dates.js';
import { cardinalityOf } from './group-assembly.js';
import {
  contributionOf, decomposeBatch, findSplitSettlement,
  type BatchOutcome,
} from './batch-decomposition.js';

/**
 * §8's outcome table says `tier = fuzzy`; the `matches.tier` CHECK constraint,
 * `schema.md` §11.1's `tier_attribution` example and the answer key's `viaTier`
 * all say `batch`. Three against one, and the one is the odd reading — see
 * ADR-076. A batch group reported as `fuzzy` would also make the ADR-072 tier
 * diagnostic permanently wrong: the key carries 77 `viaTier: batch` pairs and
 * the engine would report `batch: 0` forever.
 */
const BATCH_TIER = 'batch' as const;

/**
 * ADR-038: a decomposition is a strong inference, not a certainty, so it always
 * asks a human. `findSplitSettlement` is the same class of claim — arithmetic
 * over a bounded pool — and carries the same confidence for the same reason.
 */
const BATCH_CONFIDENCE = 0.8;

/**
 * A pool this small is not a batch question.
 *
 * ADR-038's whole point is that the engine may claim a batch is unsplittable
 * only after GENUINELY trying to split it. A search over fewer than two
 * candidates is not a genuine attempt at a *batch* — it is the observation that
 * there was nothing to combine, which the presence categories already say
 * better. Reporting `UNSPLITTABLE_BATCH` there would dress an absence up as a
 * proof, and it is the same over-claim in the opposite direction from never
 * searching at all.
 *
 * Credits below this bar are still SEARCHED and still counted in
 * `creditsExamined`; they simply do not produce a batch verdict for S12.
 */
const MIN_BATCH_SHAPED_POOL = 2;

export interface BatchStageResult {
  /** Pre-formed groups for `assembleGroups`' `batchGroups` passthrough. */
  groups: ProposedMatch[];
  /**
   * Verdicts S12 should classify (§11 entry 3) — only credits whose pool was
   * batch-shaped. See `MIN_BATCH_SHAPED_POOL`.
   */
  batches: { credit: NormalizedTransaction; outcome: BatchOutcome }[];
  /** Split settlements found, for the audit trail. */
  splits: { gateway: NormalizedTransaction; legs: NormalizedTransaction[]; reason: string }[];
  /** Every SETTLEMENT credit S10 looked at, including the ones it declined to opine on. */
  creditsExamined: number;
  /** Credits whose candidate pool was too small to be a batch question. */
  creditsBelowPoolFloor: number;
}

/**
 * Run S10 over the records S6–S9 left unmatched.
 *
 * `claimed` is every record already in a pair from an earlier stage. Pure: the
 * same pool and config produce the same verdicts, in canonical order.
 */
export function runBatchStage(
  pool: readonly NormalizedTransaction[],
  claimed: ReadonlySet<string>,
  config: RunConfig,
): BatchStageResult {
  // `consumed` grows as S10 itself claims records, so a record cannot appear in
  // both a split and a batch. Seeded from the earlier stages' claims.
  const consumed = new Set<string>(claimed);

  const unmatched = (source: NormalizedTransaction['sourceSystem']): NormalizedTransaction[] =>
    pool
      .filter((t) => t.sourceSystem === source
        && t.statusNorm === 'reconcilable'
        && !consumed.has(t.id))
      .sort(compareCanonical);

  const groups: ProposedMatch[] = [];
  const splits: BatchStageResult['splits'] = [];

  // ── §8.1 SPLIT SETTLEMENTS — identity-bearing, so first ────────────────────
  for (const gateway of unmatched('gateway')) {
    const outcome = findSplitSettlement(gateway, unmatched('bank'), config);
    if (outcome.kind !== 'split') continue;

    consumed.add(gateway.id);
    for (const leg of outcome.legs) consumed.add(leg.id);
    splits.push({ gateway, legs: outcome.legs, reason: outcome.reason });
    groups.push(toGroup([gateway, ...outcome.legs], gateway, outcome.ruleId, config));
  }

  // ── §8 NET SETTLEMENT BATCHES ──────────────────────────────────────────────
  // Only `SETTLEMENT` credits. A CHARGEBACK is a debit and a MISC_CREDIT is not
  // a settlement of anything — decomposing either would be asking the wrong
  // question of the right machinery.
  const batches: BatchStageResult['batches'] = [];
  let creditsExamined = 0;
  let creditsBelowPoolFloor = 0;

  for (const credit of unmatched('bank')) {
    if (credit.txnType !== 'SETTLEMENT') continue;
    if (credit.direction !== 'credit') continue;
    creditsExamined += 1;

    // The pool is re-read per credit so a payment consumed by an earlier
    // decomposition is not offered to a later one. Order is canonical, so which
    // credit gets a contested payment is a function of file position, not of
    // Map iteration (ADR-032 rule 3).
    const outcome = decomposeBatch(credit, unmatched('gateway'), config);

    if (outcome.kind === 'decomposed') {
      consumed.add(credit.id);
      for (const member of outcome.members) consumed.add(member.id);
      batches.push({ credit, outcome });
      groups.push(toGroup([...outcome.members, credit], credit, 'BATCH_DECOMPOSED_V1', config));
      continue;
    }

    // Searched, but the question was not batch-shaped. The credit is an ordinary
    // unmatched settlement and the presence categories describe it correctly.
    if (outcome.stats.poolSize < MIN_BATCH_SHAPED_POOL) {
      creditsBelowPoolFloor += 1;
      continue;
    }
    batches.push({ credit, outcome });
  }

  return { groups, batches, splits, creditsExamined, creditsBelowPoolFloor };
}

/**
 * A batch verdict as a pre-formed group.
 *
 * Built here rather than handed to `assembleGroups` as pairs because a
 * decomposition IS a group — splitting an N-member finding into pairs so the
 * assembler can rebuild it is a lossy round trip, and `assembleGroups` takes
 * `batchGroups` as a passthrough for exactly this reason.
 *
 * `status` is always `pending_review` (ADR-038): arithmetic that lands inside a
 * tolerance band is a strong inference, and the engine does not confirm strong
 * inferences about money on its own.
 */
function toGroup(
  members: readonly NormalizedTransaction[],
  anchor: NormalizedTransaction,
  ruleId: string,
  config: RunConfig,
): ProposedMatch {
  const ordered = [...members].sort(compareCanonical);

  // The honest delta: what the legs sum to, against what the single side says.
  // Reported rather than zeroed — a batch group showing `amountDeltaPaise: 0`
  // would claim the arithmetic was exact when it landed inside a tolerance.
  const gateways = ordered.filter((m) => m.sourceSystem === 'gateway');
  const banks = ordered.filter((m) => m.sourceSystem === 'bank');
  const gatewayNet = gateways.reduce(
    (sum, g) => sum + midpoint(contributionOf(g, config)), 0);
  const bankTotal = banks.reduce((sum, b) => sum + b.amountPaise, 0);

  const dateDeltaDays = ordered.reduce(
    (worst, m) => {
      const d = dayDelta(anchor.txnDate, m.txnDate);
      return Math.abs(d) > Math.abs(worst) ? d : worst;
    }, 0);

  return {
    tier: BATCH_TIER,
    status: 'pending_review',
    confidence: BATCH_CONFIDENCE,
    ruleId,
    // The single definition (group-assembly.ts), not a local ternary: cardinality
    // describes how many records fill each ROLE, and two rules disagreeing about
    // that would be invisible until a UI rendered the wrong shape.
    cardinality: cardinalityOf(ordered),
    members: ordered.map((m) => ({
      transactionId: m.id,
      role: m.sourceSystem as MemberRole,
      isAnchor: m.id === anchor.id,
    })),
    amountDeltaPaise: Math.round(bankTotal - gatewayNet),
    dateDeltaDays,
    aliasIds: [],
    // Batch membership is decided by a bounded subset search, not by the Tier 2
    // scorer, so there is no component breakdown to show. NULL says "a different
    // rule decided this" rather than implying a score of zero.
    scoreBreakdown: null,
  };
}

/** A contribution is a band when the fee was inferred; its midpoint is the estimate. */
function midpoint(c: { minPaise: number; maxPaise: number }): number {
  return (c.minPaise + c.maxPaise) / 2;
}
