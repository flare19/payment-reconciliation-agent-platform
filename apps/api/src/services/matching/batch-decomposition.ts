/**
 * S10 — net settlement batches and split settlements (ADR-038, ADR-060).
 *
 * A bank SETTLEMENT credit may be the net of many gateway payments minus fees,
 * with no breakup file. UNSPLITTABLE_BATCH is one of the three designed-
 * unresolvable classes — but the engine may only claim a batch is unsplittable
 * AFTER GENUINELY TRYING TO SPLIT IT. Declaring unsplittability without an
 * attempt is an assertion, not a finding, and a panelist is entitled to ask
 * which one it is.
 *
 * The two failure modes are DIFFERENT CLAIMS and the exception list says which:
 *
 *   searchExhausted     "I visited the entire bounded space; no combination works."
 *   searchBoundExceeded "I ran out of search budget. A decomposition may exist."
 *
 * Conflating them would overstate the first and hide the second.
 *
 * BOUNDS ARE DETERMINISTIC (ADR-060). The primary bound is a NODE BUDGET, not a
 * wall clock. A time-bounded search reports `searchExhausted` on a fast machine
 * and `searchBoundExceeded` on a slow one — two different claims about the data,
 * decided by hardware. That is ADR-039's date problem in another stage. The wall
 * clock survives only as a safety valve that should never fire.
 */

import { compareCanonical, type Paise } from '../../types/domain.js';
import type { NormalizedTransaction, RunConfig } from '../../types/engine.js';
import { addDays, dayDelta } from '../ingestion/dates.js';
import { amountToleranceBand, expectedNetBand } from './tolerance.js';

/** How much a gateway payment is expected to contribute to a bank credit. */
export interface Contribution {
  transaction: NormalizedTransaction;
  /** A point when the gateway stated its net; a band when the fee was inferred. */
  minPaise: Paise;
  maxPaise: Paise;
  inferred: boolean;
}

export interface SearchStats {
  poolSize: number;
  nodesVisited: number;
  solutionsFound: number;
  /**
   * True when every subset of the DECLARED space was visited.
   *
   * The declared space is "subsets of up to `batchMaxSubsetSize` drawn from the
   * eligible pool". Two limits sit at different levels and must not be conflated:
   *
   *   DECLARED (part of the question)  the subset-size cap. Announced up front,
   *     identical for every batch, and stated in the reason string. Searching all
   *     of it is a complete answer to the question actually asked.
   *   TRUNCATING (a failure to answer)  the pool cap discarded eligible
   *     candidates; the node or time budget cut the search short.
   *
   * Folding the size cap in with the other two would make `exhaustive` almost
   * unreachable on any pool of eight or more — the DFS reaches depth 8 constantly
   * — and an honesty flag that is almost never true tells a reader nothing.
   */
  exhaustive: boolean;
  /** Set only by a TRUNCATING limit. `subset_size` never appears here. */
  boundHit: { bound: 'pool' | 'nodes' | 'time'; value: number } | null;
  /** Qualifier: the declared shape limit was reached somewhere in the search. */
  subsetSizeCapReached: boolean;
}

export type BatchOutcome =
  | { kind: 'decomposed'; members: NormalizedTransaction[]; stats: SearchStats; reason: string }
  | { kind: 'ambiguous'; subsets: string[][]; stats: SearchStats; reason: string }
  | { kind: 'unsplittable'; stats: SearchStats; reason: string };

/** Expected contribution of one gateway payment (schema.md §5.3). */
export function contributionOf(
  gateway: NormalizedTransaction, config: RunConfig,
): Contribution {
  if (gateway.netAmountPaise !== null) {
    return {
      transaction: gateway,
      minPaise: gateway.netAmountPaise,
      maxPaise: gateway.netAmountPaise,
      inferred: false,
    };
  }
  const band = expectedNetBand(gateway.amountPaise, config);
  return {
    transaction: gateway,
    minPaise: band.lowPaise,
    maxPaise: band.highPaise,
    inferred: true,
  };
}

/**
 * Build the candidate pool for a bank settlement credit.
 *
 * Unmatched gateway credits, business date within [C.date − 4, C.date], sharing a
 * counterparty where both sides have one. Capped at `batchPoolCap`, choosing the
 * NEAREST BY DATE first and then the largest amounts — a settlement nets the
 * payments immediately preceding it, and a large payment is more likely to be a
 * member than a small one simply because fewer of them are needed to reach the total.
 */
export function buildBatchPool(
  credit: NormalizedTransaction,
  unmatchedGateway: NormalizedTransaction[],
  config: RunConfig,
): { pool: NormalizedTransaction[]; capped: boolean } {
  const earliest = addDays(credit.txnDate, -4);
  const creditParty = credit.counterpartyKey ?? credit.counterpartyNorm;

  const eligible = unmatchedGateway.filter((g) => {
    if (g.sourceSystem !== 'gateway') return false;
    if (g.direction !== 'credit') return false;
    if (g.statusNorm !== 'reconcilable') return false;
    if (dayDelta(earliest, g.txnDate) < 0) return false;
    if (dayDelta(g.txnDate, credit.txnDate) < 0) return false;
    const party = g.counterpartyKey ?? g.counterpartyNorm;
    // Only exclude on a POSITIVE disagreement. A missing name on either side is
    // an absence of evidence, not evidence of a different merchant.
    if (creditParty !== null && party !== null && creditParty !== party) return false;
    return true;
  });

  const ranked = [...eligible].sort((a, b) => {
    const da = dayDelta(a.txnDate, credit.txnDate);
    const db = dayDelta(b.txnDate, credit.txnDate);
    if (da !== db) return da - db;
    if (a.amountPaise !== b.amountPaise) return b.amountPaise - a.amountPaise;
    return compareCanonical(a, b);
  });

  return {
    pool: ranked.slice(0, config.batchPoolCap),
    capped: ranked.length > config.batchPoolCap,
  };
}

/**
 * Depth-first subset search with prefix pruning (ADR-060).
 *
 * Stops after TWO solutions: the outcome only distinguishes "exactly one" from
 * "two or more", so a third changes nothing. Early stop means the space was not
 * exhausted, and `exhaustive` records that honestly — but for the ambiguous
 * outcome exhaustiveness is irrelevant, because the answer is already "arithmetic
 * cannot choose".
 */
export function searchSubsets(
  contributions: Contribution[],
  targetPaise: Paise,
  tolerancePaise: Paise,
  config: RunConfig,
  poolCapped: boolean,
): { solutions: Contribution[][]; stats: SearchStats } {
  // Descending by maximum contribution: the largest amounts fail the "too big"
  // prune earliest, which is what makes the pruning effective.
  const items = [...contributions].sort((a, b) =>
    b.maxPaise !== a.maxPaise ? b.maxPaise - a.maxPaise : compareCanonical(a.transaction, b.transaction));

  const n = items.length;
  // suffixMax[i] = the most the remaining items could still add.
  const suffixMax = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) suffixMax[i] = suffixMax[i + 1]! + items[i]!.maxPaise;

  const lo = targetPaise - tolerancePaise;
  const hi = targetPaise + tolerancePaise;

  const solutions: Contribution[][] = [];
  const chosen: Contribution[] = [];
  let nodesVisited = 0;
  let boundHit: SearchStats['boundHit'] = poolCapped
    ? { bound: 'pool', value: config.batchPoolCap } : null;
  let subsetCapHit = false;
  let complete = true;

  const nodeBudget = config.batchNodeBudget;
  const deadline = Date.now() + config.batchSubsetBudgetMs;

  function dfs(index: number, minSum: number, maxSum: number): void {
    if (solutions.length >= 2) { complete = false; return; }

    nodesVisited += 1;
    if (nodesVisited > nodeBudget) {
      if (boundHit === null || boundHit.bound === 'pool') boundHit = { bound: 'nodes', value: nodeBudget };
      complete = false;
      return;
    }
    // Safety valve only. Checked rarely so it does not itself dominate the cost,
    // and expected never to fire — if it does, the node budget was too generous.
    if ((nodesVisited & 0x3ff) === 0 && Date.now() > deadline) {
      boundHit = { bound: 'time', value: config.batchSubsetBudgetMs };
      complete = false;
      return;
    }

    if (chosen.length > 0 && minSum <= hi && maxSum >= lo) {
      solutions.push([...chosen]);
      if (solutions.length >= 2) { complete = false; return; }
    }

    if (index >= n) return;
    // Every contribution is positive, so once the minimum already overshoots,
    // no extension can come back.
    if (minSum > hi) return;
    // Even taking everything left cannot reach the floor.
    if (maxSum + suffixMax[index]! < lo) return;

    // The DECLARED shape limit. Reaching it does not defeat exhaustiveness — it
    // is part of the question being asked — but it is recorded, and the reason
    // string always names the cap so the claim is never wider than the search.
    if (chosen.length >= config.batchMaxSubsetSize) { subsetCapHit = true; return; }

    for (let i = index; i < n; i += 1) {
      const item = items[i]!;
      chosen.push(item);
      dfs(i + 1, minSum + item.minPaise, maxSum + item.maxPaise);
      chosen.pop();
      if (solutions.length >= 2) return;
      if (boundHit !== null && boundHit.bound !== 'pool') return;
    }
  }

  dfs(0, 0, 0);

  if (poolCapped) complete = false;

  return {
    solutions,
    stats: {
      poolSize: n,
      nodesVisited,
      solutionsFound: solutions.length,
      exhaustive: complete,
      boundHit,
      subsetSizeCapReached: subsetCapHit,
    },
  };
}

/**
 * Attempt to decompose one bank settlement credit.
 *
 * A found decomposition is a STRONG INFERENCE, NOT A CERTAINTY, so it always asks
 * a human: the caller creates it as `pending_review` (ADR-038).
 */
export function decomposeBatch(
  credit: NormalizedTransaction,
  unmatchedGateway: NormalizedTransaction[],
  config: RunConfig,
): BatchOutcome {
  const { pool, capped } = buildBatchPool(credit, unmatchedGateway, config);
  const contributions = pool.map((g) => contributionOf(g, config));
  const tolerance = amountToleranceBand(credit.amountPaise, config);

  const { solutions, stats } = searchSubsets(
    contributions, credit.amountPaise, tolerance, config, capped);

  if (solutions.length === 1) {
    const members = solutions[0]!.map((c) => c.transaction).sort(compareCanonical);
    return {
      kind: 'decomposed',
      members,
      stats,
      reason:
        `${members.length} gateway payments net to this credit within ${tolerance} paise ` +
        `(searched ${stats.poolSize} candidates in ${stats.nodesVisited} steps); ` +
        `a decomposition is a strong inference, so it is proposed for review rather than confirmed`,
    };
  }

  if (solutions.length >= 2) {
    return {
      kind: 'ambiguous',
      subsets: solutions.map((s) => s.map((c) => c.transaction.id).sort()),
      stats,
      reason:
        `at least two different combinations of gateway payments sum to this credit; ` +
        `arithmetic cannot choose between them`,
    };
  }

  if (stats.exhaustive) {
    return {
      kind: 'unsplittable',
      stats,
      reason:
        `searched every combination of up to ${config.batchMaxSubsetSize} of the ` +
        `${stats.poolSize} candidate payments (${stats.nodesVisited} steps) and none sums ` +
        `to this credit; no decomposition of that shape exists in the available data`,
    };
  }

  const bound = stats.boundHit;
  return {
    kind: 'unsplittable',
    stats,
    reason:
      `the search stopped on its ${bound?.bound ?? 'unknown'} bound ` +
      `(${bound?.value ?? '?'}) after ${stats.nodesVisited} steps over ` +
      `${stats.poolSize} candidates; a decomposition may exist but was not proved`,
  };
}

// ── §8.1 Split settlements — the mirror case ──────────────────────────────────

export type SplitOutcome =
  | { kind: 'split'; legs: NormalizedTransaction[]; reason: string }
  | { kind: 'none' };

/**
 * One gateway payment settled across 2–4 bank credits (`one_to_many`).
 *
 * Far cheaper than the batch case and worth doing for its own sake: a dataset
 * containing only the unresolvable half of the split/batch pair would make the
 * engine look worse than it is.
 */
export function findSplitSettlement(
  gateway: NormalizedTransaction,
  unmatchedBank: NormalizedTransaction[],
  config: RunConfig,
): SplitOutcome {
  const expected = contributionOf(gateway, config);
  const tolerance = amountToleranceBand(gateway.amountPaise, config);
  const gatewayParty = gateway.counterpartyKey ?? gateway.counterpartyNorm;
  const window = gateway.method === 'upi' || gateway.method === 'wallet'
    ? config.dateWindowUpiDays : config.dateWindowCardDays;

  const legs = unmatchedBank.filter((b) => {
    if (b.sourceSystem !== 'bank' || b.direction !== 'credit') return false;
    if (b.statusNorm !== 'reconcilable') return false;
    const delta = dayDelta(gateway.txnDate, b.txnDate);
    if (delta < window[0] || delta > window[1]) return false;
    const party = b.counterpartyKey ?? b.counterpartyNorm;
    if (gatewayParty !== null && party !== null && gatewayParty !== party) return false;
    return true;
  }).sort(compareCanonical);

  // Only consider genuinely split shapes: a single leg is an ordinary 1:1 match
  // and belongs to the tiers, not here.
  if (legs.length < 2 || legs.length > 4) return { kind: 'none' };

  const sum = legs.reduce((acc, b) => acc + b.amountPaise, 0);
  if (sum >= expected.minPaise - tolerance && sum <= expected.maxPaise + tolerance) {
    return {
      kind: 'split',
      legs,
      reason:
        `${legs.length} bank credits sum to this payment's expected net within ` +
        `${tolerance} paise; proposed for review as a split settlement`,
    };
  }
  return { kind: 'none' };
}
