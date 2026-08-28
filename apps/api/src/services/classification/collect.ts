/**
 * S12 integration — turning stage output into `ClassificationInput`.
 *
 * `classify.ts` decides what an exception IS. This module decides what the
 * classifier gets to see, and those are different jobs: every rule in
 * `classify.ts` is only as honest as the evidence handed to it, and the failure
 * mode here is not a wrong category but a **thin** one — an exception that says
 * "nothing matched" when the engine scored ninety candidates and rejected them
 * all for stated reasons.
 *
 * matching-engine.md §11 fixes what arrives, and in this order:
 *
 *   1. Non-primary duplicates from S4        → DUPLICATE_RECORD
 *   2. S8 identity-established verdicts      → AMOUNT_MISMATCH / TIMING_DRIFT
 *   3. S10 batch verdicts                    → UNSPLITTABLE_BATCH / AMBIGUOUS_MATCH
 *   4. Ambiguity-guard raises from S9        → AMBIGUOUS_MATCH
 *   5. Everything left unmatched             → the presence categories
 *
 * The ordering is `classify.ts`'s business; this module's job is to make sure
 * none of the five arrives empty when it should not, and that `matchedPairs`
 * carries EVERY tier's confirmed pairs. That last point is the one with teeth:
 * a pair missing from `matchedPairs` makes both its records look unmatched, and
 * they are then classified as `MISSING_IN_*` — a fabricated exception for a
 * match the engine actually made, in the list the track grades hardest.
 */

import { compareCanonical } from '../../types/domain.js';
import type {
  ClassifiedException, NormalizedTransaction, ProposedMatch, RunConfig,
} from '../../types/engine.js';
import type { DuplicateFinding } from '../matching/dedupe.js';
import type { IdentityVerdict } from '../matching/identity-resolution.js';
import type { BatchOutcome } from '../matching/batch-decomposition.js';
import type { CandidateStats, Tier2Result } from '../matching/tier2-fuzzy.js';
import type { RefusedPair } from '../matching/group-assembly.js';
import { classify, type ClassificationInput, type RecordCandidateEvidence } from './classify.js';

/** Everything the stages upstream of S12 produced, in one place. */
export interface PipelineOutput {
  /** Post-dedupe reconcilable population. Re-sorted here; callers need not. */
  pool: NormalizedTransaction[];
  duplicates: DuplicateFinding[];
  identity: { pair: [NormalizedTransaction, NormalizedTransaction]; verdict: IdentityVerdict }[];
  tier2: Tier2Result;
  batches: { credit: NormalizedTransaction; outcome: BatchOutcome }[];
  /** S11 output. Groups supply matched pairs; refusals supply AMBIGUOUS_MATCH context. */
  groups: ProposedMatch[];
  refused: RefusedPair[];
  config: RunConfig;
}

/**
 * Every pair the engine confirmed, from every tier, as `classify` wants it.
 *
 * Derived from S11's GROUPS rather than from the tier outputs directly. The
 * group is the engine's final word — S11 can refuse a pair a tier proposed
 * (§10 rule 3), and a refused pair must not appear here or the record it
 * displaced would look matched and never receive its AMBIGUOUS_MATCH. Reading
 * the tiers instead would reinstate exactly the pairs S11 declined.
 *
 * A group of N members yields all N×(N−1)/2 internal pairs: `classify` asks
 * "does this record have a confirmed counterpart in source X", and in a 3-way
 * group the bank↔ledger leg is confirmed even though no tier proposed it
 * directly — it is implied by both legs meeting at the gateway.
 */
export function matchedPairsOf(groups: ProposedMatch[]): { aId: string; bId: string }[] {
  const out: { aId: string; bId: string }[] = [];
  for (const g of groups) {
    // A proposal is not a reconciliation (ADR-040). But it IS evidence that a
    // counterpart was found, and reporting MISSING_IN_BANK for a record whose
    // bank leg is sitting in the review queue would be false. Presence is
    // answered by the group; whether it COUNTS is answered by `status`, in S14.
    const ids = g.members.map((m) => m.transactionId);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        out.push({ aId: ids[i]!, bId: ids[j]! });
      }
    }
  }
  return out;
}

/**
 * Per-record candidate evidence, keyed by the record it was scored FOR.
 *
 * `consideredCount` and `candidates` are deliberately different numbers — see
 * `RecordCandidateEvidence`. `displacedByMatchId` stays null: match ids do not
 * exist until the repository layer assigns them (U5/U6), and inventing one here
 * would put an unresolvable identifier in front of a reviewer. The displacement
 * REASON is already on the near-miss entry, which is the part that informs.
 */
export function candidateEvidenceOf(
  stats: readonly CandidateStats[],
): Map<string, RecordCandidateEvidence> {
  const out = new Map<string, RecordCandidateEvidence>();
  for (const s of stats) {
    out.set(s.transactionId, {
      candidates: s.nearMisses,
      consideredCount: s.consideredCount,
      capHit: s.candidateCapHit,
      displacedByMatchId: null,
    });
  }
  return out;
}

/**
 * Build the classifier's input from the pipeline's output.
 *
 * Pure and total: it reads what the stages produced and reshapes it. No stage is
 * re-run, nothing is re-derived, and no decision is made here — a decision made
 * in an adapter is a decision made in a place nobody audits.
 */
export function buildClassificationInput(p: PipelineOutput): ClassificationInput {
  return {
    // ADR-032: canonical order in, so the classifier's output order is a
    // function of file position rather than of whichever stage happened to
    // emit a record last.
    pool: [...p.pool].sort(compareCanonical),
    duplicates: p.duplicates,
    identity: p.identity,
    ambiguities: p.tier2.ambiguous,
    batches: p.batches,
    matchedPairs: matchedPairsOf(p.groups),
    // §10 rule 3: a pair S11 refused becomes an AMBIGUOUS_MATCH naming its
    // displacer. Without this the rule is documented and inert.
    groupRefusals: p.refused,
    scoredCandidates: candidateEvidenceOf(p.tier2.candidateStats),
    config: p.config,
  };
}

/** S12: build the input and classify. The whole stage, in one call. */
export function runClassification(p: PipelineOutput): ClassifiedException[] {
  return classify(buildClassificationInput(p));
}
