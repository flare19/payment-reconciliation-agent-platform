/**
 * S9 assignment — deciding who actually gets whom (ADR-032).
 *
 * Scoring says how good a pair is. Assignment decides which pairs survive, and
 * the naive approach is ORDER-DEPENDENT:
 *
 *   Walk records, give each its best available candidate. If gateway A scores
 *   0.88 against bank credit X and gateway B scores 0.95 against the same X,
 *   then processing A first hands X to the weaker claim and pushes the stronger
 *   one into an exception. Match rate, exception list and measured precision all
 *   become a function of iteration order.
 *
 * A result that is not reproducible is not a measurement, which is the entire
 * thesis of this project. So assignment is GLOBAL: score every candidate pair,
 * sort by strength, and walk once, accepting a pair only when both sides are
 * still free.
 *
 * This is a greedy approximation to maximum-weight bipartite matching. Not
 * globally optimal in the way the Hungarian algorithm would be, and that is the
 * deliberate trade: O(p log p), explainable in one sentence ("strongest evidence
 * is assigned first"), and every rejection produces a human-readable reason. An
 * optimal assignment would occasionally trade one strong pair for two medium
 * ones — arithmetically better, much harder to defend in an audit trail.
 */

import { compareCanonical, type SourceSystem } from '../../types/domain.js';
import type { NormalizedTransaction, RunConfig, ScoreBreakdown } from '../../types/engine.js';

/** A scored, non-discarded candidate pair. Produced by blocking + `scorePair`. */
export interface CandidatePair {
  a: NormalizedTransaction;
  b: NormalizedTransaction;
  score: number;
  breakdown: ScoreBreakdown;
  ruleId: string;
}

export interface AssignedPair extends CandidatePair {
  status: 'auto_confirmed' | 'pending_review';
}

export interface DisplacedPair extends CandidatePair {
  /** Which side lost, and to what. This is one of the most useful things an
   *  exception can say, and it is invisible in any per-record greedy design. */
  rejectedBecause: string;
}

/** A record that had rival candidates too close to choose between. */
export interface AmbiguityFinding {
  transactionId: string;
  /** Ambiguity is always WITHIN one target source — see `findAmbiguities`. */
  targetSource: SourceSystem;
  rivals: { transactionId: string; score: number }[];
  delta: number;
}

export interface AssignmentResult {
  accepted: AssignedPair[];
  displaced: DisplacedPair[];
  ambiguous: AmbiguityFinding[];
  /** Scored but below the review threshold. Counted for `evidence.candidatesConsidered`. */
  belowThresholdCount: number;
}

/**
 * Total order over candidate pairs: score descending, then canonical position.
 *
 * A TOTAL order, not a partial one plus sort stability. `Array.prototype.sort` is
 * stable in modern engines, but relying on that makes correctness depend on the
 * order pairs happened to be generated in — which is the exact property this
 * module exists to eliminate. Comparing both members makes every comparison
 * decisive, so the input order cannot leak into the output.
 */
export function comparePairs(p: CandidatePair, q: CandidatePair): number {
  if (p.score !== q.score) return q.score - p.score;   // strongest first
  const [pLow, pHigh] = canonicalEnds(p);
  const [qLow, qHigh] = canonicalEnds(q);
  const low = compareCanonical(pLow, qLow);
  if (low !== 0) return low;
  return compareCanonical(pHigh, qHigh);
}

function canonicalEnds(p: CandidatePair): [NormalizedTransaction, NormalizedTransaction] {
  return compareCanonical(p.a, p.b) <= 0 ? [p.a, p.b] : [p.b, p.a];
}

/** Slot key: a record may hold at most one counterpart per OTHER source system. */
function slotKey(transactionId: string, otherSource: SourceSystem): string {
  return `${transactionId}::${otherSource}`;
}

/**
 * Find records whose top two rivals are too close to choose between (ADR-010).
 *
 * ── The subtlety the spec leaves open, decided here ──
 * Ambiguity is evaluated PER TARGET SOURCE, not across a record's whole candidate
 * list. A gateway record legitimately has both a bank counterpart and a ledger
 * counterpart — that is an ordinary three-way match, not a conflict. Comparing
 * its best bank candidate against its best ledger candidate would flag every
 * clean 3-way reconciliation in the dataset as AMBIGUOUS_MATCH and collapse the
 * match rate for a reason that has nothing to do with the data.
 *
 * Rivalry means "these two records both claim to be the SAME leg of this event",
 * and only candidates from the same source can make that claim.
 *
 * Evaluated against the candidate list AS SCORED, never as assigned: the guard
 * asks "was this decidable?", which is a question about the evidence, not about
 * who won a race.
 */
export function findAmbiguities(
  candidates: CandidatePair[], config: RunConfig,
): AmbiguityFinding[] {
  // (record, targetSource) -> rival candidates
  const groups = new Map<string, { txn: NormalizedTransaction; target: SourceSystem; rivals: { transactionId: string; score: number }[] }>();

  const add = (owner: NormalizedTransaction, rival: NormalizedTransaction, score: number): void => {
    const key = slotKey(owner.id, rival.sourceSystem);
    let group = groups.get(key);
    if (group === undefined) {
      group = { txn: owner, target: rival.sourceSystem, rivals: [] };
      groups.set(key, group);
    }
    group.rivals.push({ transactionId: rival.id, score });
  };

  for (const pair of candidates) {
    if (pair.score < config.fuzzyReviewThreshold) continue;
    add(pair.a, pair.b, pair.score);
    add(pair.b, pair.a, pair.score);
  }

  const findings: AmbiguityFinding[] = [];
  // Map iteration order is insertion order, which depends on input order. Collect
  // first, then sort canonically, so the output is order-independent (ADR-032 §2).
  for (const group of groups.values()) {
    if (group.rivals.length < 2) continue;
    const ranked = [...group.rivals].sort((x, y) =>
      x.score !== y.score ? y.score - x.score : (x.transactionId < y.transactionId ? -1 : 1));
    const [best, second] = ranked as [{ transactionId: string; score: number }, { transactionId: string; score: number }];

    const delta = Math.round((best.score - second.score) * 10_000) / 10_000;
    if (delta <= config.ambiguityDeltaThreshold) {
      findings.push({
        transactionId: group.txn.id,
        targetSource: group.target,
        rivals: ranked,
        delta,
      });
    }
  }

  findings.sort((x, y) =>
    x.transactionId !== y.transactionId
      ? (x.transactionId < y.transactionId ? -1 : 1)
      : (x.targetSource < y.targetSource ? -1 : 1));
  return findings;
}

/**
 * Run the global assignment pass.
 *
 * Order of operations matters and is deliberate:
 *   1. Ambiguity is computed FIRST, from the scored candidate list.
 *   2. Ambiguous (record, targetSource) slots are then excluded from assignment.
 *
 * The alternative — assign first, then revoke ambiguous winners — frees slots
 * mid-walk and would need a second pass whose result depends on the order the
 * revocations happened in. Computing the guard up front keeps the whole stage a
 * pure function of the candidate set. It also means an ambiguous record never
 * consumes a slot, so its rivals stay available to other records, which is the
 * behaviour a reviewer expects: refusing to choose should not punish a third party.
 */
export function assign(candidates: CandidatePair[], config: RunConfig): AssignmentResult {
  const belowThresholdCount = candidates.filter(
    (c) => c.score < config.fuzzyReviewThreshold).length;

  const eligible = candidates.filter((c) => c.score >= config.fuzzyReviewThreshold);

  const ambiguous = findAmbiguities(candidates, config);
  const blocked = new Set(ambiguous.map((f) => slotKey(f.transactionId, f.targetSource)));

  const ranked = [...eligible].sort(comparePairs);

  const taken = new Map<string, { winner: string; score: number }>();
  const accepted: AssignedPair[] = [];
  const displaced: DisplacedPair[] = [];

  for (const pair of ranked) {
    const aSlot = slotKey(pair.a.id, pair.b.sourceSystem);
    const bSlot = slotKey(pair.b.id, pair.a.sourceSystem);

    if (blocked.has(aSlot) || blocked.has(bSlot)) {
      const which = blocked.has(aSlot) ? pair.a : pair.b;
      displaced.push({
        ...pair,
        rejectedBecause:
          `record ${which.externalId} had two candidates within ` +
          `${config.ambiguityDeltaThreshold} of each other; the engine did not choose`,
      });
      continue;
    }

    const aHeld = taken.get(aSlot);
    const bHeld = taken.get(bSlot);
    if (aHeld !== undefined || bHeld !== undefined) {
      const held = aHeld ?? bHeld!;
      displaced.push({
        ...pair,
        rejectedBecause:
          `counterpart already matched to a stronger candidate (score ${held.score.toFixed(4)})`,
      });
      continue;
    }

    taken.set(aSlot, { winner: pair.b.id, score: pair.score });
    taken.set(bSlot, { winner: pair.a.id, score: pair.score });
    accepted.push({
      ...pair,
      // A pending_review match is a PROPOSAL, not a reconciliation, and is
      // excluded from the headline match rate (ADR-040).
      status: pair.score >= config.fuzzyAutoConfirmThreshold ? 'auto_confirmed' : 'pending_review',
    });
  }

  return { accepted, displaced, ambiguous, belowThresholdCount };
}
