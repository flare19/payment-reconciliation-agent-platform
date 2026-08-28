/**
 * S9 — Tier 2, fuzzy (matching-engine.md §3 and §7).
 *
 * This module is a DRIVER, not a decision-maker. Every judgement it needs
 * already exists and is guard-tested elsewhere:
 *
 *   scoring.ts    `scorePair` — the single scorer (ADR-030 weights, hard gates,
 *                 near-anchor, contradiction discard). Guarded by
 *                 single-scorer-guard.test.ts.
 *   assignment.ts `assign`    — global score-ordered assignment, the ambiguity
 *                 guard, and displacement reasons (ADR-032).
 *   blocking.ts   the four indexes this draws candidates from (ADR-033).
 *
 * What is left, and all this file does: decide WHICH pairs get scored, and hand
 * the survivors to `assign`. So the whole of the risk here is candidate
 * generation, and it has exactly one dangerous failure mode —
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ A CANDIDATE NEVER GENERATED IS A MATCH THAT CANNOT BE MADE, AND NOTHING   ║
 * ║ DOWNSTREAM CAN TELL THE DIFFERENCE BETWEEN THAT AND A GENUINE EXCEPTION.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Over-generating costs a scorePair call, which is cheap and which the scorer
 * then rejects on the merits. Under-generating silently converts a true match
 * into a `MISSING_IN_*` exception with a confident explanation. The two errors
 * are not symmetric, so every bound below is deliberately loose in the
 * over-generating direction, and the one hard bound that CAN lose a true
 * candidate — ADR-033's 200-candidate cap — is recorded on the record rather
 * than applied silently (§3: "a bounded search that silently truncates is a
 * dishonest search").
 *
 * Tier 2's domain (§6.3): pairs where identity is NOT established. Anything S6,
 * S7 or S8 already spoke for is excluded before scoring — S8 in particular
 * returns verdicts for pairs that share a strong anchor, and re-scoring those
 * would let a similarity score second-guess an identity the engine already
 * settled deterministically.
 */

import { compareCanonical, type SourceSystem } from '../../types/domain.js';
import type { BlockIndexes, NormalizedTransaction, RunConfig } from '../../types/engine.js';
import { addDays, dayDelta } from '../ingestion/dates.js';
import { strongAnchors } from './anchors.js';
import { AMOUNT_BUCKET_PAISE, ANCHOR_PREFIX_LEN, amountBucket } from './blocking.js';
import { assign, type AssignmentResult, type CandidatePair } from './assignment.js';
import { scorePair } from './scoring.js';
import { amountToleranceBand, dateWindowFor, pairKind } from './tolerance.js';

const SEP = '::';
const ALL_SOURCES: readonly SourceSystem[] = ['gateway', 'bank', 'ledger'];

/** Per-record candidate-generation bookkeeping, surfaced in `exceptions.evidence`. */
export interface CandidateStats {
  transactionId: string;
  /** Distinct counterparts the blocking indexes offered, BEFORE the ADR-033 cap. */
  generated: number;
  /** True when the cap discarded eligible candidates. Never silent (§3). */
  candidateCapHit: boolean;
}

export interface Tier2Result extends AssignmentResult {
  /** One entry per record that entered Tier 2, in canonical order. */
  candidateStats: CandidateStats[];
  /** Distinct pairs handed to `scorePair`. The honest denominator for §3's complexity claim. */
  pairsScored: number;
  /** Pairs `scorePair` rejected on a hard gate (contradiction, direction, same source). */
  pairsDiscarded: number;
}

/**
 * The date range in which a counterpart from `other` could legitimately sit.
 *
 * The §5.2 windows are defined RELATIVE TO THE GATEWAY DATE (bank-relative for
 * the bank↔ledger pair), so reading them from the wrong end turns a normal T+2
 * settlement into a -2 outlier. When `r` is the window's anchor the range runs
 * forward; when `r` is the other side it must be INVERTED.
 *
 * Two deliberate widenings, both in the over-generating direction:
 *  - when `r` is not the gateway, the gateway's `method` is unknowable here, so
 *    the widest of the per-method windows is used;
 *  - the range is padded by one day on each side, because `evaluateDate` decides
 *    inclusion on the real values and an off-by-one here would delete a true
 *    candidate rather than merely admit a false one.
 */
export function candidateDateRange(
  r: NormalizedTransaction, other: SourceSystem, config: RunConfig,
): { from: string; to: string } | null {
  const kind = pairKind(r.sourceSystem, other);
  if (kind === null) return null;

  const anchorSource: SourceSystem = kind === 'bank_ledger' ? 'bank' : 'gateway';
  const rIsAnchor = r.sourceSystem === anchorSource;

  let window;
  if (kind === 'gateway_bank' && r.sourceSystem !== 'gateway') {
    // The counterpart's method decides the window and we do not have it yet.
    const [cardLo, cardHi] = config.dateWindowCardDays;
    const [upiLo, upiHi] = config.dateWindowUpiDays;
    window = [Math.min(cardLo, upiLo), Math.max(cardHi, upiHi)] as const;
  } else {
    window = dateWindowFor(kind, r.method, config);
  }

  const [lo, hi] = rIsAnchor
    ? [window[0], window[1]]
    : [-window[1], -window[0]];   // invert: r is the far end of the window

  return { from: addDays(r.txnDate, lo - 1), to: addDays(r.txnDate, hi + 1) };
}

/**
 * The amount buckets a counterpart could fall in (§3 rule 1).
 *
 * The fee band widens the span for gateway↔bank ONLY, and only downward: the
 * bank credits net of a 2.36–2.95% fee, so a bank counterpart is always at or
 * below the gateway gross, never above it. Widening upward as well would double
 * the bucket span to guard against an event the domain does not produce.
 */
export function candidateAmountBuckets(
  r: NormalizedTransaction, other: SourceSystem, config: RunConfig,
): number[] {
  const tolerance = amountToleranceBand(r.amountPaise, config);
  const magnitude = Math.abs(r.amountPaise);

  let low = magnitude - tolerance;
  let high = magnitude + tolerance;

  if (pairKind(r.sourceSystem, other) === 'gateway_bank') {
    if (r.sourceSystem === 'gateway') {
      low = Math.min(low, magnitude * (1 - config.feeBandMaxPct) - tolerance);
    } else {
      // r is the bank credit: its gateway gross is LARGER by the fee.
      high = Math.max(high, magnitude / (1 - config.feeBandMinPct) + tolerance);
    }
  }

  const from = amountBucket(Math.max(0, low));
  const to = amountBucket(Math.max(0, high));
  const buckets: number[] = [];
  for (let b = from; b <= to; b += 1) buckets.push(b);
  return buckets;
}

/**
 * Every candidate `r` could match, from all three §3 sources, deduplicated and
 * canonically ordered.
 *
 * Returned BEFORE the cap is applied so the caller can report how many were
 * genuinely available — `candidatesConsidered` must be a true count, not the
 * length of the list that survived (§11).
 */
export function generateCandidates(
  r: NormalizedTransaction, blocks: BlockIndexes, config: RunConfig,
): NormalizedTransaction[] {
  const ids = new Set<string>();

  const admit = (id: string): void => {
    if (id === r.id) return;
    const t = blocks.byId.get(id);
    if (t === undefined || t.sourceSystem === r.sourceSystem) return;
    ids.add(id);
  };

  for (const other of ALL_SOURCES) {
    if (other === r.sourceSystem) continue;
    const range = candidateDateRange(r, other, config);
    if (range === null) continue;

    // 1. byDateAmount over the date span × the amount buckets.
    const buckets = candidateAmountBuckets(r, other, config);
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
      for (const bucket of buckets) {
        for (const id of blocks.byDateAmount.get(d + SEP + bucket) ?? []) admit(id);
      }
    }

    // 2. byCounterparty, intersected with the same date span. Catches the
    //    amount-divergent, name-agreeing pair that rule 1 cannot reach.
    const key = r.counterpartyKey ?? r.counterpartyNorm;
    if (key !== null) {
      for (const id of blocks.byCounterparty.get(key) ?? []) {
        const t = blocks.byId.get(id);
        if (t === undefined || t.sourceSystem !== other) continue;
        if (t.txnDate < range.from || t.txnDate > range.to) continue;
        admit(id);
      }
    }
  }

  // 3. byAnchorPrefix for every anchor r carries — the near-anchor (ADR-031)
  //    candidate source. NOT date-filtered: scorePair requires corroboration
  //    before a near-anchor scores at all, so the window is enforced there.
  for (const anchor of strongAnchors(r.referenceIds)) {
    if (anchor.value.length < ANCHOR_PREFIX_LEN) continue;
    for (const id of blocks.byAnchorPrefix.get(anchor.value.slice(0, ANCHOR_PREFIX_LEN)) ?? []) {
      admit(id);
    }
  }

  return [...ids]
    .map((id) => blocks.byId.get(id)!)
    .sort(compareCanonical);
}

/**
 * S9 driver.
 *
 * `claimedIds` are records S6/S7 already matched and `settledPairKeys` are pairs
 * S8 returned a verdict for. Both are excluded rather than re-scored: a
 * similarity score must never be in a position to overturn a deterministic
 * identity verdict (§6.3).
 */
export function runTier2(
  blocks: BlockIndexes,
  config: RunConfig,
  claimedIds: ReadonlySet<string> = new Set(),
  settledPairKeys: ReadonlySet<string> = new Set(),
): Tier2Result {
  // Canonical order in, canonical order out — nothing here may depend on Map
  // iteration order (ADR-032 rule 2).
  const pool = [...blocks.byId.values()]
    .filter((t) => t.statusNorm === 'reconcilable' && !claimedIds.has(t.id))
    .sort(compareCanonical);

  const candidateStats: CandidateStats[] = [];
  const candidates: CandidatePair[] = [];
  const scored = new Set<string>();
  let pairsDiscarded = 0;

  for (const r of pool) {
    const generated = generateCandidates(r, blocks, config).filter((c) => !claimedIds.has(c.id));
    const capped = generated.slice(0, config.candidateCap);

    candidateStats.push({
      transactionId: r.id,
      generated: generated.length,
      candidateCapHit: generated.length > config.candidateCap,
    });

    for (const c of capped) {
      const key = pairKeyOf(r.id, c.id);
      if (scored.has(key) || settledPairKeys.has(key)) continue;
      scored.add(key);

      // Orient canonically so `scorePair`'s output does not depend on which of
      // the two records the outer loop reached first.
      const [a, b] = compareCanonical(r, c) <= 0 ? [r, c] : [c, r];
      const result = scorePair(a, b, config);
      if (result.discarded) { pairsDiscarded += 1; continue; }

      candidates.push({
        a, b, score: result.score, breakdown: result.breakdown, ruleId: result.ruleId,
        amount: result.amount, date: result.date,
      });
    }
  }

  return {
    ...assign(candidates, config),
    candidateStats,
    pairsScored: scored.size,
    pairsDiscarded,
  };
}

/** Order-independent key for an unordered pair of transaction ids. */
export function pairKeyOf(x: string, y: string): string {
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/** Re-exported so a caller does not have to reach into blocking.ts for it. */
export { AMOUNT_BUCKET_PAISE, dayDelta };
