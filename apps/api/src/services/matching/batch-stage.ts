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
 * Records with no counterpart IN THE ROLE THIS STAGE IS ASKING ABOUT — not
 * records that are in no group at all (#49).
 *
 * The first wiring asked "is this gateway record in any group?", and that is the
 * #40 error again one stage later: a gateway payment matched to its LEDGER row
 * still has no bank leg, and a net settlement batch is precisely a set of
 * payments whose bank legs were netted into one credit. On the holdout that
 * predicate excluded 58 of 68 eligible payments and left every candidate pool at
 * size 1 — the stage ran, searched honestly, and searched an empty room.
 *
 * The role-scoped predicate is `hasCounterpartIn(record, role)`, read from the
 * groups S11 will build from S6-S9's pairs. S10 still never re-decides a claim
 * an earlier stage made: it only ever ADDS a leg in a role that was empty.
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
 * ── WHY SPLITS MERGE AND BATCHES DO NOT ──
 * A split settlement is ONE gateway payment across N bank credits, so its group
 * is one economic event and every pair it implies — gateway<->leg,
 * ledger<->leg — is a true pair. Its legs are emitted as PAIRS carrying
 * `mayDuplicateRole: 'bank'` (#45), so they merge into whatever group the
 * gateway already has and bring the ledger row with them.
 *
 * A net batch is the opposite shape and the difference is not cosmetic. N
 * gateway payments share one credit, and each of those payments has its OWN
 * ledger row, so merging a batch into the existing groups would fuse N economic
 * events into one — and every implied pair ACROSS those events (gateway_1 with
 * ledger_2, and so on) is a pair the answer key denies. That is a false-positive
 * factory, and precision is the number this project has that is worth most.
 *
 * So batch decompositions stay atomic pre-formed groups over records that are
 * wholly unclaimed, and the SEARCH still runs over the wide role-scoped pool so
 * that `UNSPLITTABLE_BATCH` remains a finding rather than an absence (ADR-038).
 * A decomposition whose members are already grouped is refused, counted, and
 * named — it needs the implied-pair problem solved, which is a design change
 * rather than a wiring one.
 */

import { compareCanonical, type MemberRole } from '../../types/domain.js';
import type { NormalizedTransaction, ProposedMatch, RunConfig } from '../../types/engine.js';
import { dayDelta } from '../ingestion/dates.js';
import { cardinalityOf, type GroupPair } from './group-assembly.js';
import {
  buildBatchPool, contributionOf, decomposeBatch, findSplitSettlement,
  type BatchOutcome,
} from './batch-decomposition.js';
import { amountToleranceBand } from './tolerance.js';

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
 * Is this credit a NET BATCH question at all?
 *
 * §8 defines the case precisely: *"A bank `SETTLEMENT` credit may be the net of
 * MANY gateway payments minus fees."* Two things follow, and both are needed —
 * the first alone is not, which cost a measurement to learn:
 *
 *  1. **At least one candidate to net.** With an empty pool there is nothing
 *     to combine and nothing was searched; that is `MISSING_IN_GATEWAY`, not
 *     a proof about a batch.
 *  2. **The credit must exceed the largest single candidate's contribution.** A
 *     credit that one available payment could account for on its own is not a
 *     netting of many — it is an ordinary 1:1 whose match failed for some other
 *     reason, and the presence categories describe that correctly.
 *
 * Requiring TWO present candidates was the first attempt, and it contradicts
 * the scenario's own definition: §4's `UNSPLITTABLE_NET_BATCH` is a credit
 * netting payments *"with no breakup file provided"*, and the generator proves
 * unresolvability over the payments that ARE available — which may be one. A
 * floor of two demands the very evidence whose absence defines the case.
 *
 * Rule 2 alone lets any unmatched settlement credit with payments nearby be
 * declared an unsplittable batch. Measured on the holdout that produced **17
 * `UNSPLITTABLE_BATCH` exceptions across 15 events of which one was a designed
 * batch — precision 0.067** — with fourteen `TIMING_LAG_NORMAL` credits
 * relabelled as batch failures. The category reading 0.000 because the stage
 * never ran is an honest absence; reading 0.067 because the stage answers a
 * question nobody asked is worse, and it would have looked like progress.
 *
 * Credits failing either test are still SEARCHED and counted in
 * `creditsExamined`; they simply produce no batch verdict for S12.
 */
const MIN_BATCH_SHAPED_POOL = 1;

export interface BatchStageResult {
  /**
   * Split legs, as PAIRS carrying `mayDuplicateRole: 'bank'` (#45), so they
   * merge into the group the gateway already has instead of competing with it.
   */
  splitPairs: GroupPair[];
  /** Batch decompositions: atomic pre-formed groups, for the passthrough. */
  groups: ProposedMatch[];
  /**
   * Verdicts S12 should classify (§11 entry 3) — only credits whose pool was
   * batch-shaped. See `MIN_BATCH_SHAPED_POOL`.
   */
  batches: { credit: NormalizedTransaction; outcome: BatchOutcome }[];
  /** Split settlements found, for the audit trail. */
  splits: { gateway: NormalizedTransaction; legs: NormalizedTransaction[]; reason: string }[];
  /**
   * Tier pairs a split ABSORBED — the same two records, re-asserted by
   * `SPLIT_SETTLEMENT_V1` as one leg of a proved settlement (#51, ADR-079).
   *
   * The caller must drop these from the pair list it assembles. Not a
   * re-decision: the relationship survives unchanged and only its rule id and
   * tier move. Keeping both would double-count the pair in `tierAttribution` and
   * would make §10 rule 5 report the group at the fuzzy tier of one leg rather
   * than at the batch tier of the proof that covers all of them.
   */
  supersededTierPairs: { aId: string; bId: string }[];
  /** Every SETTLEMENT credit S10 looked at, including the ones it declined to opine on. */
  creditsExamined: number;
  /** Credits whose candidate pool was too small to be a batch question. */
  creditsBelowPoolFloor: number;
  /** Decompositions found but refused because their members were already grouped. */
  decompositionsRefusedAsAlreadyGrouped: number;
}

/**
 * Run S10 over the records S6–S9 left unmatched.
 *
 * `claimed` is every record already in a pair from an earlier stage. Pure: the
 * same pool and config produce the same verdicts, in canonical order.
 */
export function runBatchStage(
  pool: readonly NormalizedTransaction[],
  /** Every pair S6-S9 produced, so counterparts can be read PER ROLE (#49). */
  priorPairs: readonly { a: NormalizedTransaction; b: NormalizedTransaction }[],
  config: RunConfig,
): BatchStageResult {
  // Role-scoped counterpart index. `hasCounterpartIn(x, 'bank')` is the question
  // this stage actually asks; "is x in any group at all" is the one that emptied
  // the pool (#49).
  // The RECORDS, not just the role names: #51 needs to ask whether the legs a
  // record already has ACCOUNT for it, which a set of role names cannot answer.
  const counterpartRoles = new Map<string, Map<string, NormalizedTransaction[]>>();
  const note = (x: NormalizedTransaction, y: NormalizedTransaction): void => {
    const roles = counterpartRoles.get(x.id) ?? new Map<string, NormalizedTransaction[]>();
    const list = roles.get(y.sourceSystem) ?? [];
    if (!list.some((z) => z.id === y.id)) list.push(y);
    roles.set(y.sourceSystem, list);
    counterpartRoles.set(x.id, roles);
  };
  for (const p of priorPairs) { note(p.a, p.b); note(p.b, p.a); }
  const counterpartsIn = (x: NormalizedTransaction, role: MemberRole): NormalizedTransaction[] =>
    [...(counterpartRoles.get(x.id)?.get(role) ?? [])].sort(compareCanonical);
  const hasCounterpartIn = (x: NormalizedTransaction, role: MemberRole): boolean =>
    (counterpartRoles.get(x.id)?.get(role)?.length ?? 0) > 0;

  // Records S10 itself has claimed. A record cannot appear in both a split and a
  // batch, and a payment consumed by one decomposition is not offered to another.
  const consumed = new Set<string>();

  /** Reconcilable records of `source` that have no counterpart in `role` yet. */
  const openIn = (
    source: NormalizedTransaction['sourceSystem'], role: MemberRole,
  ): NormalizedTransaction[] =>
    pool
      .filter((t) => t.sourceSystem === source
        && t.statusNorm === 'reconcilable'
        && !consumed.has(t.id)
        && !hasCounterpartIn(t, role))
      .sort(compareCanonical);

  /**
   * Is this gateway payment's BANK role still open (#51)?
   *
   * Empty is open. So is a role whose legs SUM SHORT of what the payment should
   * have settled for — that is a partially assembled split, and it is the case
   * `!hasCounterpartIn` silently excluded. A role whose legs already reach the
   * expected-net band is CLOSED: an ordinary 1:1 gateway<->bank match lands
   * there by definition, so this pass does not reopen settled work.
   *
   * Short, not merely different. If the legs OVERSHOOT the payment, adding more
   * cannot fix it and something else is wrong — that is an `AMOUNT_MISMATCH`
   * question, not a split one.
   */
  const bankRoleOpen = (gateway: NormalizedTransaction): boolean => {
    const legs = counterpartsIn(gateway, 'bank');
    if (legs.length === 0) return true;
    const expected = contributionOf(gateway, config);
    const tolerance = amountToleranceBand(gateway.amountPaise, config);
    const sum = legs.reduce((total, leg) => total + leg.amountPaise, 0);
    return sum < expected.minPaise - tolerance;
  };

  /** Gateway records the split pass may consider. Canonical order (ADR-032). */
  const openForSplit = (): NormalizedTransaction[] =>
    pool
      .filter((t) => t.sourceSystem === 'gateway'
        && t.statusNorm === 'reconcilable'
        && !consumed.has(t.id)
        && bankRoleOpen(t))
      .sort(compareCanonical);

  /** Records in no group at all — the conservative set batch GROUPS may use. */
  const whollyUnclaimed = (source: NormalizedTransaction['sourceSystem']): Set<string> =>
    new Set(pool
      .filter((t) => t.sourceSystem === source
        && t.statusNorm === 'reconcilable'
        && !consumed.has(t.id)
        && !counterpartRoles.has(t.id))
      .map((t) => t.id));

  const groups: ProposedMatch[] = [];
  const splitPairs: GroupPair[] = [];
  const splits: BatchStageResult['splits'] = [];
  const supersededTierPairs: BatchStageResult['supersededTierPairs'] = [];

  // ── §8.1 SPLIT SETTLEMENTS — identity-bearing, so first ────────────────────
  // Offered every gateway record whose BANK role is still OPEN — empty, or
  // filled by legs that fall short of the payment (#51, ADR-079). Presence in a
  // role is the wrong test for the one rule whose entire subject is having MORE
  // THAN ONE counterpart in that role: the moment S9 accepted any single leg of
  // a split, `!hasCounterpartIn(t, 'bank')` removed the payment from this pass
  // and the remaining legs were never searched for. Whether either side is
  // already matched to a LEDGER row remains irrelevant.
  for (const gateway of openForSplit()) {
    // The legs S9 already found are part of the settlement, so they are part of
    // the SUM the search has to reach — searching for the remainder alone would
    // assume the existing leg belongs to this split instead of proving it.
    const existing = counterpartsIn(gateway, 'bank').filter((l) => !consumed.has(l.id));
    const searchPool = [...openIn('bank', 'gateway'), ...existing];
    const outcome = findSplitSettlement(gateway, searchPool, config);
    if (outcome.kind !== 'split') continue;
    // ...and the one solution must ACCOUNT FOR every leg already matched. A
    // decomposition that routes around a leg S9 confirmed is not this payment's
    // settlement; it is a second, competing claim about the same record, which
    // is exactly what a stage that may only EXTEND the engine's output must not
    // make (ADR-076 point 3).
    if (!existing.every((l) => outcome.legs.some((x) => x.id === l.id))) continue;

    consumed.add(gateway.id);
    for (const leg of outcome.legs) consumed.add(leg.id);
    splits.push({ gateway, legs: outcome.legs, reason: outcome.reason });

    // Emitted as pairs, not a group: the gateway may already sit in a
    // [gateway+ledger] group, and these legs belong in THAT group rather than a
    // competing one. `mayDuplicateRole: 'bank'` is rule 3's declared exception.
    //
    // EVERY leg is emitted, including one a tier already matched, and the tier's
    // pair is superseded rather than left beside it. Rule 3 admits several
    // members of one role only through pairs that DECLARE the exception, so a
    // fuzzy gateway<->bank pair sitting next to three declaring ones is refused
    // as an `AMBIGUOUS_MATCH` and its leg is thrown out of the very group it
    // belongs to. Measured: that dropped `bank:290` and `bank:253` from the two
    // splits this stage had just proved.
    for (const leg of outcome.legs) {
      if (existing.some((l) => l.id === leg.id)) {
        supersededTierPairs.push({ aId: gateway.id, bId: leg.id });
      }
      splitPairs.push({
        a: gateway, b: leg, tier: BATCH_TIER, status: 'pending_review',
        confidence: BATCH_CONFIDENCE, ruleId: outcome.ruleId,
        amountDeltaPaise: leg.amountPaise, dateDeltaDays: dayDelta(gateway.txnDate, leg.txnDate),
        aliasIds: [], scoreBreakdown: null,
        mayDuplicateRole: 'bank',
      });
    }
  }

  // ── §8 NET SETTLEMENT BATCHES ──────────────────────────────────────────────
  // Only `SETTLEMENT` credits. A CHARGEBACK is a debit and a MISC_CREDIT is not
  // a settlement of anything — decomposing either would be asking the wrong
  // question of the right machinery.
  const batches: BatchStageResult['batches'] = [];
  let creditsExamined = 0;
  let creditsBelowPoolFloor = 0;
  let decompositionsRefusedAsAlreadyGrouped = 0;

  for (const credit of openIn('bank', 'gateway')) {
    if (credit.txnType !== 'SETTLEMENT') continue;
    if (credit.direction !== 'credit') continue;
    creditsExamined += 1;

    // The pool is re-read per credit so a payment consumed by an earlier
    // decomposition is not offered to a later one. Order is canonical, so which
    // credit gets a contested payment is a function of file position, not of
    // Map iteration (ADR-032 rule 3).
    // The SEARCH uses the wide role-scoped pool, so `UNSPLITTABLE_BATCH` stays a
    // finding about the data rather than an artefact of an empty pool (ADR-038).
    const outcome = decomposeBatch(credit, openIn('gateway', 'bank'), config);

    if (outcome.kind === 'decomposed') {
      // A GROUP, though, may only form over wholly unclaimed records — see the
      // header. Merging a many_to_one batch into existing groups would fuse N
      // economic events and imply pairs across them that the key denies.
      const free = whollyUnclaimed('gateway');
      if (!outcome.members.every((m) => free.has(m.id)) || counterpartRoles.has(credit.id)) {
        decompositionsRefusedAsAlreadyGrouped += 1;
        batches.push({ credit, outcome: { ...outcome, kind: 'unsplittable' } as BatchOutcome });
        continue;
      }
      consumed.add(credit.id);
      for (const member of outcome.members) consumed.add(member.id);
      batches.push({ credit, outcome });
      groups.push(toGroup([...outcome.members, credit], credit, 'BATCH_DECOMPOSED_V1', config));
      continue;
    }

    // Searched, but the question was not batch-shaped. The credit is an ordinary
    // unmatched settlement and the presence categories describe it correctly.
    if (!isBatchShaped(credit, openIn('gateway', 'bank'), config)) {
      creditsBelowPoolFloor += 1;
      continue;
    }
    batches.push({ credit, outcome });
  }

  return {
    splitPairs, groups, batches, splits, supersededTierPairs,
    creditsExamined, creditsBelowPoolFloor, decompositionsRefusedAsAlreadyGrouped,
  };
}

/** §8's two conditions for a credit to be a net-batch question at all. */
function isBatchShaped(
  credit: NormalizedTransaction,
  available: readonly NormalizedTransaction[],
  config: RunConfig,
): boolean {
  // THIS credit's own pool - date-windowed and counterparty-filtered by
  // `buildBatchPool` - not the global set of unmatched payments. Testing the
  // credit against every payment in the run compares it to the largest payment
  // anywhere, which is a different and useless question.
  const { pool } = buildBatchPool(credit, [...available], config);
  if (pool.length < MIN_BATCH_SHAPED_POOL) return false;
  // The largest expected CONTRIBUTION, not the largest gross amount: what a
  // payment contributes to a credit is its net after fees, which is the quantity
  // the decomposition actually sums (schema.md 5.3).
  const largest = pool.reduce(
    (max, g) => Math.max(max, contributionOf(g, config).maxPaise), 0);
  return Math.abs(credit.amountPaise) > largest;
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
