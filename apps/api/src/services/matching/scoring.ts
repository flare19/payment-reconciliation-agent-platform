/**
 * The Tier 2 confidence scorer (schema.md §5.4, ADR-030).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS IS THE ONLY SCORING IMPLEMENTATION IN THE SYSTEM.
 *
 * `scorePair` below is called by the engine at S9 AND by the Analyst's
 * `score_pair` tool (ADR-049). That is not a convention — it is the mechanism by
 * which the agent is prevented from doing its own arithmetic. If a second scorer
 * ever appears, the agent can reason over numbers the engine never computed, and
 * "a number in a reasoning chain the engine didn't produce is a bug" stops being
 * enforceable. `tests/unit/single-scorer-guard.test.ts` fails if one appears.
 *
 * The same rule covers `trigramSimilarity` and `damerauLevenshteinWithin`: one
 * definition each, here. Two similarity functions disagreeing by 0.01 would be a
 * silent accuracy bug visible only as an unexplained difference between an audit
 * entry and a reasoning chain.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import type { ScoreBreakdown, NormalizedTransaction, RunConfig } from '../../types/engine.js';
import { STRONG_ANCHOR_KEYS } from '../../types/engine.js';
// Anchor semantics live in one module so S4, S6, S7, S8 and S9 cannot disagree
// about what counts as identity (see anchors.ts).
import {
  WEAK_ANCHOR_KEYS, isWellFormedAnchor as isWellFormed, structuredValue,
} from './anchors.js';
import {
  directionAgrees, evaluateAmount, evaluateDate,
  type AmountEvaluation, type DateEvaluation,
} from './tolerance.js';

/**
 * Round to 4dp BEFORE any comparison (ADR-032).
 *
 * Comparing raw doubles makes threshold behaviour depend on the order the
 * components were added. The ambiguity guard's 0.05 band in particular must not
 * hinge on the fifteenth decimal place — two runs that add the same numbers in a
 * different order would otherwise disagree about whether a match was ambiguous.
 */
export function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

// ─── Similarity primitives ───────────────────────────────────────────────────

/**
 * Trigram similarity, following PostgreSQL's pg_trgm definition so the score is
 * the same whether it is computed here or (for search only) in the database:
 * lowercase, non-alphanumerics to spaces, each word padded with two leading and
 * one trailing space, then Jaccard over the resulting 3-gram sets.
 */
export function trigramSimilarity(a: string | null, b: string | null): number {
  if (a === null || b === null) return 0;
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 && setB.size === 0) return a === b ? 1 : 0;
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

function trigrams(value: string): Set<string> {
  const out = new Set<string>();
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * Damerau-Levenshtein distance, bounded: returns the true distance when it is
 * `<= max`, otherwise `max + 1`. Bounding keeps this cheap enough to run over a
 * whole anchor-prefix block.
 *
 * This is the OSA (optimal string alignment) variant, which does not allow a
 * substring to be edited twice. OSA and true Damerau-Levenshtein can only differ
 * where the distance is at least 3, and the only caller uses max = 1, so the
 * distinction cannot affect any decision this system makes. Stated rather than
 * glossed, because "Damerau-Levenshtein" names two slightly different algorithms.
 */
export function damerauLevenshteinWithin(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: cols }, (_, j) => j);
  let curr: number[] = new Array(cols).fill(0);

  for (let i = 1; i < rows; i += 1) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        prev[j]! + 1,        // deletion
        curr[j - 1]! + 1,    // insertion
        prev[j - 1]! + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2[j - 2]! + 1); // adjacent transposition
      }
      curr[j] = best;
      if (best < rowMin) rowMin = best;
    }
    // Every subsequent row is monotonically non-decreasing in its minimum, so once
    // a whole row exceeds the ceiling the answer can only be larger.
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = curr; curr = new Array(cols).fill(0);
  }
  const distance = prev[cols - 1]!;
  return distance > max ? max + 1 : distance;
}

// ─── Anchor comparison ───────────────────────────────────────────────────────

export type AnchorAgreement =
  | { kind: 'exact'; key: string; strength: 'strong_strong' | 'strong_weak' | 'weak_weak' }
  | { kind: 'near'; key: string; distance: number }
  | { kind: 'contradiction'; key: string; aValue: string; bValue: string }
  | { kind: 'none' };

const WEAK_KEYS = new Set<string>(WEAK_ANCHOR_KEYS);

/**
 * Compare two records' anchors.
 *
 * Order matters and is deliberate: exact agreement, then near-anchor, then
 * contradiction. A REF_TYPO (one transposed character in an 18-char payment id)
 * is byte-unequal, so checking contradiction first would discard the very
 * candidates the near-anchor rule exists to rescue.
 */
export function anchorAgreement(
  a: NormalizedTransaction, b: NormalizedTransaction, config: RunConfig, corroborated: boolean,
): AnchorAgreement {
  // 1. Exact agreement on a shared key, scored by the WEAKER of the two sides.
  for (const key of STRONG_ANCHOR_KEYS) {
    const av = structuredValue(a.referenceIds, key);
    const bv = structuredValue(b.referenceIds, key);
    if (av !== undefined && bv !== undefined && av === bv
        && isWellFormed(key, av) && isWellFormed(key, bv)) {
      return { kind: 'exact', key, strength: 'strong_strong' };
    }
  }

  // A structured anchor on one side matching a description-extracted value on the
  // other is strong↔weak: one side proved it, the other only suggested it.
  const aExtracted = a.referenceIds.extracted_from_description ?? [];
  const bExtracted = b.referenceIds.extracted_from_description ?? [];
  for (const key of STRONG_ANCHOR_KEYS) {
    const av = structuredValue(a.referenceIds, key);
    if (av !== undefined && isWellFormed(key, av) && bExtracted.includes(av)) {
      return { kind: 'exact', key, strength: 'strong_weak' };
    }
    const bv = structuredValue(b.referenceIds, key);
    if (bv !== undefined && isWellFormed(key, bv) && aExtracted.includes(bv)) {
      return { kind: 'exact', key, strength: 'strong_weak' };
    }
  }

  for (const key of WEAK_KEYS) {
    const av = structuredValue(a.referenceIds, key);
    const bv = structuredValue(b.referenceIds, key);
    if (av !== undefined && bv !== undefined && av === bv && av.trim() !== '') {
      return { kind: 'exact', key, strength: 'weak_weak' };
    }
  }
  for (const value of aExtracted) {
    if (value.trim() !== '' && bExtracted.includes(value)) {
      return { kind: 'exact', key: 'extracted_from_description', strength: 'weak_weak' };
    }
  }

  // 2. Near-anchor (ADR-031). Corroboration is REQUIRED: without amount and date
  //    agreement a one-character difference is not evidence, it is a guess.
  if (corroborated) {
    for (const key of STRONG_ANCHOR_KEYS) {
      const av = structuredValue(a.referenceIds, key);
      const bv = structuredValue(b.referenceIds, key);
      if (av === undefined || bv === undefined) continue;
      if (av.length < config.nearAnchorMinLength || bv.length < config.nearAnchorMinLength) continue;
      const distance = damerauLevenshteinWithin(av, bv, config.nearAnchorMaxDistance);
      if (distance >= 1 && distance <= config.nearAnchorMaxDistance) {
        return { kind: 'near', key, distance };
      }
    }
  }

  // 3. Contradiction: both sides carry the same STRONG structured key and they
  //    disagree beyond a typo. Disqualifying, not merely unhelpful — a
  //    contradicted anchor is positive evidence that these are different things.
  for (const key of STRONG_ANCHOR_KEYS) {
    const av = structuredValue(a.referenceIds, key);
    const bv = structuredValue(b.referenceIds, key);
    if (av !== undefined && bv !== undefined && av !== bv
        && isWellFormed(key, av) && isWellFormed(key, bv)) {
      return { kind: 'contradiction', key, aValue: av, bValue: bv };
    }
  }

  return { kind: 'none' };
}

// ─── The scorer ──────────────────────────────────────────────────────────────

export type PairScore =
  | { discarded: true; reason: string; ruleId: string }
  | {
      discarded: false;
      score: number;
      breakdown: ScoreBreakdown;
      ruleId: string;
      anchor: AnchorAgreement;
      amount: AmountEvaluation;
      date: DateEvaluation;
    };

/**
 * Score a candidate pair. THE single entry point (see the header).
 *
 * Hard gates run before scoring: a pair that fails one is DISCARDED, not scored
 * low. Scoring a disqualified pair invites a strong anchor to outvote a
 * contradiction elsewhere, which is how a reconciliation engine produces a
 * confident wrong match.
 */
export function scorePair(
  a: NormalizedTransaction, b: NormalizedTransaction, config: RunConfig,
): PairScore {
  if (a.id === b.id) return { discarded: true, reason: 'same record', ruleId: 'GATE_SELF_V1' };

  if (a.sourceSystem === b.sourceSystem) {
    return {
      discarded: true,
      reason: `both records are from the ${a.sourceSystem} source; matching is cross-source`,
      ruleId: 'GATE_SAME_SOURCE_V1',
    };
  }

  if (!directionAgrees(a, b)) {
    return {
      discarded: true,
      reason: `direction mismatch (${a.direction} vs ${b.direction}); a credit never matches a debit`,
      ruleId: 'GATE_DIRECTION_V1',
    };
  }

  if (a.currency !== b.currency) {
    return {
      discarded: true,
      reason: `currency mismatch (${a.currency} vs ${b.currency})`,
      ruleId: 'GATE_CURRENCY_V1',
    };
  }

  const amount = evaluateAmount(a, b, config);
  const date = evaluateDate(a, b, config);
  if (amount === null || date === null) {
    return { discarded: true, reason: 'not a comparable source pair', ruleId: 'GATE_PAIR_V1' };
  }

  const corroborated = amount.within && date.within;
  const anchor = anchorAgreement(a, b, config, corroborated);

  if (anchor.kind === 'contradiction') {
    return {
      discarded: true,
      reason: `${anchor.key} contradicts (${anchor.aValue} vs ${anchor.bValue})`,
      ruleId: 'GATE_ANCHOR_CONTRADICTED_V1',
    };
  }

  const w = config.scoreWeights;

  // ── anchor component ──
  let anchorScore = 0;
  if (anchor.kind === 'exact') {
    anchorScore = anchor.strength === 'weak_weak' ? w.anchorWeakWeak : w.anchorStrongWeak;
  } else if (anchor.kind === 'near') {
    anchorScore = w.anchorNear;
  }

  // ── amount component ──
  // `unavailable` (bank↔ledger) scores 0 and is FLAGGED, not silently treated as
  // disagreement: there is no comparable quantity, which is different from two
  // quantities that differ.
  let amountScore = 0;
  if (!amount.unavailable && amount.tolerancePaise > 0) {
    const ratio = Math.abs(amount.deltaPaise) / amount.tolerancePaise;
    amountScore = w.amount * Math.max(0, 1 - ratio);
    // The 0.85 inference penalty applies to the AMOUNT component alone, not the
    // total: the engine inferred a fee, so the amount evidence is weaker. Docking
    // the anchor or the date for an amount-side inference would be incoherent.
    if (amount.inferred) amountScore *= 0.85;
  }

  // ── date component ──
  // Normalised against the bound IN THE DIRECTION OF THE DELTA, because the window
  // is asymmetric. A -1 day gap sits at the edge of what midnight drift explains,
  // while +1 is comfortably inside a T+3 settlement window; scoring both against
  // the same span would treat a marginal case as an ordinary one.
  const bound = date.deltaDays < 0 ? Math.abs(date.window[0]) : date.window[1];
  let dateScore = 0;
  if (bound > 0) {
    dateScore = w.date * Math.max(0, 1 - Math.abs(date.deltaDays) / bound);
  } else if (date.deltaDays === 0) {
    dateScore = w.date;
  }

  // ── counterparty component ──
  const counterpartyScore = w.counterparty * trigramSimilarity(
    a.counterpartyKey ?? a.counterpartyNorm,
    b.counterpartyKey ?? b.counterpartyNorm,
  );

  // Round each component, THEN sum, so the breakdown a reviewer sees adds up to
  // the total a reviewer sees. A score breakdown that does not reconcile looks
  // broken, which is a bad property for a reconciliation product's UI.
  const breakdown: ScoreBreakdown = {
    anchor: round4(anchorScore),
    amount: round4(amountScore),
    date: round4(dateScore),
    counterparty: round4(counterpartyScore),
    total: 0,
    amountUnavailable: amount.unavailable,
  };
  breakdown.total = round4(
    breakdown.anchor + breakdown.amount + breakdown.date + breakdown.counterparty,
  );

  return {
    discarded: false,
    score: breakdown.total,
    breakdown,
    ruleId: ruleIdFor(anchor, amount),
    anchor, amount, date,
  };
}

function ruleIdFor(anchor: AnchorAgreement, amount: AmountEvaluation): string {
  if (anchor.kind === 'near') return 'NEAR_ANCHOR_V1';
  if (amount.inferred) return 'FUZZY_FEE_INFERRED_V1';
  if (anchor.kind === 'none') return 'FUZZY_NO_ANCHOR_V1';
  if (anchor.kind === 'exact' && anchor.strength === 'weak_weak') return 'FUZZY_WEAK_ANCHOR_V1';
  return 'FUZZY_NET_EXACT_V1';
}

/**
 * The maximum score reachable with a given anchor strength, given perfect
 * agreement on everything else. Exported because the ADR-030 ceiling guarantee is
 * a property of the weights, and a property worth asserting in a test rather than
 * asserting in a comment.
 */
export function maxScoreForAnchor(
  anchorKind: 'strong_weak' | 'near' | 'weak_weak' | 'none', config: RunConfig,
): number {
  const w = config.scoreWeights;
  const anchorPart =
    anchorKind === 'strong_weak' ? w.anchorStrongWeak
    : anchorKind === 'near' ? w.anchorNear
    : anchorKind === 'weak_weak' ? w.anchorWeakWeak
    : 0;
  return round4(anchorPart + w.amount + w.date + w.counterparty);
}
