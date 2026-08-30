/**
 * S11 — pair-to-group assembly (matching-engine.md §10).
 *
 * `schema.md` §7 models a match as a GROUP; every tier above produces PAIRS.
 * This module is the bridge, and §10 exists because that bridge was unspecified
 * until Day 3's review noticed nothing built it.
 *
 * The five rules, and where each lives below:
 *
 *   1. The gateway anchors wherever present; else the bank; else the ledger.
 *   2. Pairs sharing a member merge, one member per role.
 *   3. Conflicting merges are REFUSED, not resolved. The stronger pair forms the
 *      group; the loser becomes an AMBIGUOUS_MATCH naming what displaced it.
 *      `many_to_one` / `one_to_many` are the sole exception — multiple members
 *      of one role are legitimate there, and only there.
 *   4. Group confidence is the MINIMUM of its pairs, never the mean.
 *   5. Group tier is the WEAKEST tier used.
 *
 * Rules 4 and 5 both cost match-quality-on-paper and are the correct trade for a
 * project graded on honesty: averaging lets one exact pair launder a marginal
 * one, and calling a group `exact` because half of it was overstates the
 * evidence to the exact reader most likely to check.
 *
 * ── Why strongest-first, and why refusal rather than resolution ──
 * Pairs are merged in descending strength, so which group forms is a function of
 * the evidence rather than of arrival order — the same property `assignment.ts`
 * exists to give S9, applied one level up. When a merge would put two records of
 * the same role into a 1:1 group the engine does NOT pick one and does not
 * silently drop the other: it keeps the stronger group intact and hands the
 * loser to S12 as an AMBIGUOUS_MATCH that names its displacer. "I could not
 * decide, and here is what I was deciding between" is a better answer than a
 * coin flip wearing a confidence score.
 */

import {
  compareCanonical,
  type Cardinality, type MatchStatus, type MatchTier, type MemberRole, type Paise,
} from '../../types/domain.js';
import type {
  NormalizedTransaction, ProposedMatch, ScoreBreakdown, Tier1PairMatch,
} from '../../types/engine.js';
import type { AssignedPair } from './assignment.js';

/** Strongest first. A group takes the WEAKEST (highest) rank among its pairs (rule 5). */
const TIER_RANK: Record<MatchTier, number> = {
  exact: 0, alias: 1, batch: 2, fuzzy: 3, manual: 4,
};

/** Rule 1's preference order. Lower wins the anchor slot. */
const ANCHOR_PREFERENCE: Record<MemberRole, number> = { gateway: 0, bank: 1, ledger: 2 };

/**
 * One tier's claim that two records are the same economic event, in the single
 * shape S11 consumes. S6/S7 and S9 produce different structures; normalising
 * them here keeps the merge logic from growing a branch per source tier.
 */
export interface GroupPair {
  a: NormalizedTransaction;
  b: NormalizedTransaction;
  tier: MatchTier;
  status: MatchStatus;
  confidence: number;
  ruleId: string;
  amountDeltaPaise: Paise;
  dateDeltaDays: number;
  aliasIds: string[];
  scoreBreakdown: ScoreBreakdown | null;
  /**
   * Rule 3's exception, declared by the rule that produced the pair (#45).
   *
   * §10 rule 3 refuses same-role merges — *"`many_to_one` and `one_to_many`
   * groups are the sole exception: multiple members of one role are legitimate
   * there, and only there."* That exception was never implemented, so the
   * cardinalities `cardinalityOf` can return were unreachable from pairwise
   * assembly and S10's split settlements had nowhere to go.
   *
   * It is DECLARED rather than inferred, and that is the whole safety of it. If
   * the assembler admitted any merge that happened to produce N:1, rule 3 would
   * be toothless — every ambiguous second candidate would quietly become a
   * "many_to_one group" instead of an `AMBIGUOUS_MATCH`. Only a rule that
   * ASSERTS a cardinality may set this (today: `SPLIT_SETTLEMENT_V1`), and it
   * names the single role it is entitled to duplicate.
   */
  mayDuplicateRole?: MemberRole;
}

/** A pair that could not join a group without violating rule 2. Becomes AMBIGUOUS_MATCH at S12. */
export interface RefusedPair {
  pair: GroupPair;
  /** Names the group that held the slot, for the exception's evidence. */
  reason: string;
  conflictingRole: MemberRole;
  displacedByTransactionIds: string[];
}

export interface GroupAssemblyResult {
  matches: ProposedMatch[];
  refused: RefusedPair[];
}

/** Adapt an S6/S7 exact or alias pair. Confidence is fixed by schema.md §7. */
export function fromTier1(
  m: Tier1PairMatch, byId: ReadonlyMap<string, NormalizedTransaction>,
): GroupPair | null {
  const a = byId.get(m.aId);
  const b = byId.get(m.bId);
  if (a === undefined || b === undefined) return null;
  return {
    a, b, tier: m.tier,
    // Exact and alias are deterministic verdicts, not proposals — they never
    // enter the review queue (ADR-040 governs scored matches).
    status: 'auto_confirmed',
    confidence: m.confidence,
    ruleId: m.ruleId,
    amountDeltaPaise: m.amountDeltaPaise,
    dateDeltaDays: m.dateDeltaDays,
    aliasIds: m.aliasIds,
    scoreBreakdown: null,          // schema.md §7: NULL for exact/alias
  };
}

/**
 * Adapt an S9 assigned pair. `status` carries `assign`'s auto/review decision.
 *
 * The deltas come from the evaluations `scorePair` computed, NOT from zero: a
 * fuzzy group reporting `amountDeltaPaise: 0` does not read as "unknown", it
 * reads as "the amounts agreed exactly", which for a bank↔ledger pair scored on
 * anchor alone would be a confident false statement in the UI.
 */
export function fromTier2(p: AssignedPair): GroupPair {
  return {
    a: p.a, b: p.b, tier: 'fuzzy',
    status: p.status,
    confidence: p.score,
    ruleId: p.ruleId,
    // bank↔ledger has no comparable amount (§4.3); its delta is genuinely
    // absent rather than zero, and `amountUnavailable` on the breakdown is what
    // says so downstream.
    amountDeltaPaise: p.amount.unavailable ? 0 : p.amount.deltaPaise,
    dateDeltaDays: p.date.deltaDays,
    aliasIds: [],
    scoreBreakdown: p.breakdown,
  };
}

/**
 * Total order over pairs: strongest evidence first (rule 3's "stronger pair").
 * Tier, then confidence, then canonical position — decisive at every level, so
 * the input order cannot leak into which group forms.
 */
export function comparePairStrength(p: GroupPair, q: GroupPair): number {
  const tier = TIER_RANK[p.tier] - TIER_RANK[q.tier];
  if (tier !== 0) return tier;
  if (p.confidence !== q.confidence) return q.confidence - p.confidence;
  const [pLow, pHigh] = ends(p);
  const [qLow, qHigh] = ends(q);
  const low = compareCanonical(pLow, qLow);
  return low !== 0 ? low : compareCanonical(pHigh, qHigh);
}

function ends(p: GroupPair): [NormalizedTransaction, NormalizedTransaction] {
  return compareCanonical(p.a, p.b) <= 0 ? [p.a, p.b] : [p.b, p.a];
}

interface Cluster {
  members: Map<string, NormalizedTransaction>;
  pairs: GroupPair[];
}

/**
 * Assemble pairs into groups.
 *
 * `batchGroups` are S10's pre-formed N:1 decompositions. They are passed through
 * rather than re-derived — a subset-sum decomposition is already a group, and
 * splitting it back into pairs to reassemble it here would be a lossy round trip.
 */
export function assembleGroups(
  pairs: GroupPair[],
  batchGroups: ProposedMatch[] = [],
): GroupAssemblyResult {
  const ranked = [...pairs].sort(comparePairStrength);

  const clusterOf = new Map<string, Cluster>();
  const clusters: Cluster[] = [];
  const refused: RefusedPair[] = [];

  // Records S10 already spoke for. A batch member must not be pulled into a
  // pairwise group as well — that would put one record in two matches and trip
  // the ux_txn_single_match trigger at write time (schema.md §7).
  const inBatch = new Set(batchGroups.flatMap((g) => g.members.map((m) => m.transactionId)));

  for (const pair of ranked) {
    if (inBatch.has(pair.a.id) || inBatch.has(pair.b.id)) {
      const which = inBatch.has(pair.a.id) ? pair.a : pair.b;
      refused.push({
        pair,
        reason: `${which.externalId} is already a member of a settlement batch group (S10)`,
        conflictingRole: which.sourceSystem,
        displacedByTransactionIds: [which.id],
      });
      continue;
    }

    const ca = clusterOf.get(pair.a.id);
    const cb = clusterOf.get(pair.b.id);

    // Both already in the same cluster: the pair adds provenance, not membership.
    if (ca !== undefined && ca === cb) { ca.pairs.push(pair); continue; }

    const conflict = roleConflict(ca, cb, pair);
    if (conflict !== null) { refused.push(conflict); continue; }

    if (ca === undefined && cb === undefined) {
      const cluster: Cluster = {
        members: new Map([[pair.a.id, pair.a], [pair.b.id, pair.b]]),
        pairs: [pair],
      };
      clusters.push(cluster);
      clusterOf.set(pair.a.id, cluster);
      clusterOf.set(pair.b.id, cluster);
    } else if (ca !== undefined && cb === undefined) {
      absorb(ca, [pair.b], pair, clusterOf);
    } else if (cb !== undefined && ca === undefined) {
      absorb(cb, [pair.a], pair, clusterOf);
    } else {
      // Two existing clusters joined by this pair. `ca` is the stronger one
      // (it was formed earlier in a strength-ordered walk), so it absorbs.
      //
      // `cb.pairs` travels with `cb.members` (#45). Dropping them would let the
      // merged group forget the evidence that formed `cb`, and rules 4 and 5 are
      // computed from `cluster.pairs` — so a weak pending pair absorbed into a
      // strong cluster would vanish from the group's confidence, its tier AND
      // its status. That is exactly the laundering those rules exist to prevent,
      // and it was unreachable until this commit made same-role merges legal.
      absorb(ca!, [...cb!.members.values()], pair, clusterOf);
      ca!.pairs.push(...cb!.pairs);
      cb!.members.clear();
      cb!.pairs = [];
    }
  }

  // Sort on the real transactions, before conversion: `ProposedMatch.members`
  // carries only ids and roles, so a canonical sort is not recoverable from it.
  const matches = clusters
    .filter((c) => c.members.size > 0)
    .map((c) => ({ c, anchor: pickAnchor([...c.members.values()]) }))
    .sort((x, y) => compareCanonical(x.anchor, y.anchor))
    .map(({ c }) => toProposedMatch(c));

  return { matches: [...batchGroups, ...matches], refused };
}

/**
 * Would merging violate rule 2 (one member per role)? Returns the refusal, or
 * null if the merge is legal.
 */
function roleConflict(
  ca: Cluster | undefined, cb: Cluster | undefined, pair: GroupPair,
): RefusedPair | null {
  const incoming = new Map<string, NormalizedTransaction>();
  const existing = new Map<string, NormalizedTransaction>();

  for (const [id, t] of ca?.members ?? []) existing.set(id, t);
  if (ca === undefined) incoming.set(pair.a.id, pair.a);
  for (const [id, t] of cb?.members ?? []) incoming.set(id, t);
  if (cb === undefined) incoming.set(pair.b.id, pair.b);

  const heldBy = new Map<MemberRole, NormalizedTransaction[]>();
  for (const t of existing.values()) {
    heldBy.set(t.sourceSystem, [...(heldBy.get(t.sourceSystem) ?? []), t]);
  }

  for (const t of incoming.values()) {
    if (existing.has(t.id)) continue;
    const held = heldBy.get(t.sourceSystem);
    if (held !== undefined && held.length > 0 && !held.some((h) => h.id === t.id)) {
      // Rule 3's sole exception (#45): the incoming pair's own rule asserted this
      // cardinality and named the role it may duplicate. Nothing else widens it —
      // a fuzzy pair cannot launder a second candidate into a legitimate group by
      // arriving when a slot is already full.
      if (pair.mayDuplicateRole === t.sourceSystem) {
        heldBy.set(t.sourceSystem, [...held, t]);
        continue;
      }
      return {
        pair,
        reason:
          `the ${t.sourceSystem} slot in this group is held by ${held[0]!.externalId}, ` +
          `matched on stronger evidence; the engine did not choose between them`,
        conflictingRole: t.sourceSystem,
        displacedByTransactionIds: held.map((h) => h.id),
      };
    }
    heldBy.set(t.sourceSystem, [...(heldBy.get(t.sourceSystem) ?? []), t]);
  }
  return null;
}

function absorb(
  cluster: Cluster,
  incoming: NormalizedTransaction[],
  pair: GroupPair,
  clusterOf: Map<string, Cluster>,
): void {
  for (const t of incoming) {
    cluster.members.set(t.id, t);
    clusterOf.set(t.id, cluster);
  }
  cluster.pairs.push(pair);
}

function toProposedMatch(cluster: Cluster): ProposedMatch {
  const members = [...cluster.members.values()].sort(compareCanonical);
  const anchor = pickAnchor(members);

  // Rules 4 and 5: weakest link, both times.
  const tier = cluster.pairs.reduce<MatchTier>(
    (worst, p) => (TIER_RANK[p.tier] > TIER_RANK[worst] ? p.tier : worst), cluster.pairs[0]!.tier);
  const confidence = Math.min(...cluster.pairs.map((p) => p.confidence));
  // A group containing one proposal IS a proposal (ADR-040) — a pending_review
  // pair cannot be laundered into a confirmed group by an exact pair beside it.
  const status: MatchStatus =
    cluster.pairs.some((p) => p.status === 'pending_review') ? 'pending_review' : 'auto_confirmed';

  // The rule id and the score breakdown come from the pair that SET the group's
  // tier and confidence, so "which rule produced this?" names the weakest link
  // the reader is being warned about rather than the strongest one.
  const governing = [...cluster.pairs].sort(comparePairStrength).at(-1)!;

  return {
    tier,
    status,
    confidence,
    ruleId: governing.ruleId,
    cardinality: cardinalityOf(members),
    members: members.map((m) => ({
      transactionId: m.id,
      role: m.sourceSystem as MemberRole,
      isAnchor: m.id === anchor.id,
    })),
    // §10 does not say how to combine per-pair deltas. Largest ABSOLUTE
    // divergence, matching rules 4 and 5: the number a reader sees should be the
    // worst disagreement in the group, not one averaged into looking better.
    amountDeltaPaise: extremeBy(cluster.pairs.map((p) => p.amountDeltaPaise)),
    dateDeltaDays: extremeBy(cluster.pairs.map((p) => p.dateDeltaDays)),
    aliasIds: [...new Set(cluster.pairs.flatMap((p) => p.aliasIds))].sort(),
    scoreBreakdown: governing.scoreBreakdown,
  };
}

/** Rule 1: gateway anchors, else bank, else ledger; ties by canonical position. */
export function pickAnchor(members: NormalizedTransaction[]): NormalizedTransaction {
  return [...members].sort((x, y) => {
    const pref = ANCHOR_PREFERENCE[x.sourceSystem] - ANCHOR_PREFERENCE[y.sourceSystem];
    return pref !== 0 ? pref : compareCanonical(x, y);
  })[0]!;
}

/**
 * `many_to_one` is N gateway payments → 1 bank credit (ADR-038's net batch);
 * `one_to_many` is 1 gateway payment → N bank credits (the split settlement,
 * ADR-036's mirror). A 1:1:1 three-way group is `one_to_one` — the cardinality
 * describes how many records fill each ROLE, not how many roles are filled.
 */
export function cardinalityOf(members: NormalizedTransaction[]): Cardinality {
  const perRole = new Map<MemberRole, number>();
  for (const m of members) {
    perRole.set(m.sourceSystem, (perRole.get(m.sourceSystem) ?? 0) + 1);
  }
  if ((perRole.get('gateway') ?? 0) > 1) return 'many_to_one';
  if ((perRole.get('bank') ?? 0) > 1) return 'one_to_many';
  if ((perRole.get('ledger') ?? 0) > 1) return 'one_to_many';
  return 'one_to_one';
}

function extremeBy(values: number[]): number {
  let out = 0;
  for (const v of values) if (Math.abs(v) > Math.abs(out)) out = v;
  return out;
}
