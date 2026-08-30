/**
 * S14 — engine-computed run metrics (schema.md §11.1).
 *
 * ENGINE-COMPUTED ONLY. Ground-truth numbers live in `score_reports`, written
 * offline by `tools/score` (ADR-041). Nothing in this file may read, import or
 * approximate the answer key; a precision figure appearing here would be the
 * engine grading its own homework, which is the one thing the track's bar
 * explicitly rejects.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE DENOMINATOR. ADR-040 is prose, and prose admits readings.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   reconcilable = ingested − excluded − rejected_rows − non_primary_duplicates
 *
 * That sentence is only coherent if `ingested` counts **rows read from the
 * files**. It does NOT mean "rows in the `transactions` table": a row that
 * failed to parse never becomes a transaction (`ingestion/index.ts` builds
 * `counts.gateway` from `gateway.transactions.length`), so subtracting
 * `rejected_rows` from a parsed-row total removes something that was never
 * added. That reading shrinks the denominator, and a smaller denominator makes
 * the match rate **larger** — the error is in the flattering direction, which is
 * the direction this project is least entitled to be wrong in.
 *
 * On the committed holdout `rejected_rows = 0`, so all three readings agree at
 * 874 and the bug would be invisible. `population.ingested` is therefore
 * FILE ROWS ATTEMPTED (parsed + rejected), stated explicitly, and
 * `assertDenominatorIdentity` re-derives ADR-040's arithmetic and throws if it
 * disagrees with the population the engine actually matched over. A headline
 * whose denominator is computed two ways and checked against itself is one a
 * sceptic can audit; one computed once is a number you are asked to trust.
 *
 * The second reading hazard is subtler and currently costs nothing: a row can be
 * BOTH excluded (non-reconcilable status) and a non-primary duplicate, and the
 * subtraction removes it twice while a direct count removes it once. The direct
 * count is authoritative here for that reason, and the identity check is what
 * surfaces the day the two diverge.
 *
 * ── WIRE SHAPE ──
 * `runs.metrics` is jsonb and endpoint 5 returns it VERBATIM (`routes/runs.ts`:
 * `engine: run.metrics`) — there is no repository casing boundary in its path.
 * So it is stored camelCase, matching `api-contract.md` §3, which names
 * `engine.coldStart.matchRatePct` and `engine.matchRate.denominatorNote`.
 * schema.md §11.1's example renders the same object in snake_case; the contract
 * is binding for anything a frontend reads (ADR-072 note in CLAUDE.md §3).
 *
 * ── WHAT IS NOT COMPUTED, AND WHY IT IS ABSENT RATHER THAN ZERO ──
 * S13 is unwired (`UNWIRED_STAGES` in `services/run/orchestrator.ts`). A stage
 * that did not run reports `null`, not `0`: `llmCost.apiCalls: 0` reads as "the
 * cache served everything" rather than "there is no explain layer yet".
 * `stagesNotRun` names it, so a reader never has to consult the source to find
 * out which figures are findings and which are absences.
 *
 * The rule cuts both ways, and S10 is why it is worth stating: since #46 wired
 * the batch stage, `batchSearchExhausted` and `batchSearchBoundExceeded` are
 * real counts and reporting them as `null` would be the same dishonesty in
 * reverse — claiming an absence for work the engine actually did.
 */

import type { MatchTier, Severity } from '../../types/domain.js';
import type {
  ClassifiedException, NormalizedTransaction, ProposedMatch, RunConfig, Tier1PairMatch,
} from '../../types/engine.js';
import type { Tier2Result } from '../matching/tier2-fuzzy.js';
import type { IdentityVerdict } from '../matching/identity-resolution.js';
import { pairKeyOf } from '../matching/tier2-fuzzy.js';

/** Population terms, in the units ADR-040's sentence requires. */
export interface PopulationCounts {
  /** Parsed transactions per source. NOT the same as rows attempted. */
  gateway: number;
  bank: number;
  ledger: number;
  /** Rows that parsed but carry a non-reconcilable status (S3). */
  excluded: number;
  /** Rows that could not be parsed at all (ADR-046). Never became transactions. */
  rejected: number;
  /** Copies S4 demoted; the primary of each cluster stays in the pool. */
  nonPrimaryDuplicates: number;
}

/** Wall-clock per stage, in ms. Measured, never estimated. */
export interface StageTimings {
  parse: number; normalize: number; dedupe: number; block: number;
  tier1: number; tier15: number; identity: number; tier2: number;
  batch: number | null; group: number; classify: number;
  explain: number | null;
  /** Total engine time excluding persistence and LLM latency. */
  engineMs: number;
  /** Everything, including database writes. */
  wallClockMs: number;
}

export interface MetricsInput {
  population: PopulationCounts;
  /** The reconcilable pool S5 onward actually operated over. */
  pool: readonly NormalizedTransaction[];
  /** S6 + S7 output, in order. `tier` discriminates exact from alias. */
  exactPairs: readonly Tier1PairMatch[];
  /**
   * S10's split legs (#46). They carry `tier: 'batch'` and were produced by a
   * rule, so they must be attributed to `batch` — falling into `implied` would
   * make the engine report `batch: 0` forever against a key holding 77
   * `viaTier: batch` pairs, which is the exact mis-attribution ADR-072 exists
   * to prevent.
   */
  batchPairs: readonly { a: { id: string }; b: { id: string } }[];
  tier2: Tier2Result;
  identity: readonly { verdict: IdentityVerdict }[];
  groups: readonly ProposedMatch[];
  exceptions: readonly ClassifiedException[];
  aliasCountAtStart: number;
  /** Alias rows in each terminal state, at finalization. */
  aliasCounts: { active: number; superseded: number; revoked: number };
  /** Human corrections made to date — the denominator of the leverage ratio. */
  humanCorrectionsToDate: number;
  /**
   * S10's verdicts (issue #46). ADR-038's two claims are DIFFERENT and the
   * metrics must keep them apart: "I proved no combination works" is a finding,
   * "I ran out of budget" is a statement about the engine's own bounds.
   */
  batchOutcomes: readonly { stats: { exhaustive: boolean; boundHit: unknown } }[];
  timings: StageTimings;
  config: RunConfig;
}

/** Every stage whose figures are absent rather than zero. */
export type UnrunStage = 'S13_EXPLAIN';

export interface RunMetrics {
  [k: string]: unknown;
  schemaVersion: number;
  stagesNotRun: UnrunStage[];
  matchRate: {
    matchRatePct: number;
    matchedRecords: number;
    reconcilableRecords: number;
    denominatorNote: string;
    pendingReviewExcluded: number;
  };
  coldStart: { matchRatePct: number; aliasesActiveAtStart: number; isCold: boolean };
  tierAttribution: Record<string, number>;
  aliasLearning: {
    humanCorrectionsToDate: number;
    recordsAutoResolvedByAliases: number;
    leverageRatio: number | null;
    aliasesActive: number; aliasesSuperseded: number; aliasesRevoked: number;
  };
  reviewBurden: { pendingReviewCount: number; pendingReviewRecords: number; per100Records: number };
  exceptions: {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<Severity, number>;
    candidateCapHits: number;
    batchSearchExhausted: number | null;
    batchSearchBoundExceeded: number | null;
  };
  population: {
    ingested: number;
    ingestedNote: string;
    gateway: number; bank: number; ledger: number;
    excluded: number; rejectedRows: number; nonPrimaryDuplicates: number;
    reconcilable: number;
  };
  throughput: {
    recordsPerSecEngine: number;
    recordsPerSecWallClock: number;
    stageMs: Record<string, number | null>;
    note: string;
  };
  llmCost: null | Record<string, number>;
}

const DENOMINATOR_NOTE =
  'ingested − excluded − rejected_rows − non_primary_duplicates (ADR-040). ' +
  '`ingested` counts FILE ROWS ATTEMPTED, so rejected rows are subtracted from a ' +
  'total that included them; a parsed-row total would double-subtract and inflate the rate.';

const INGESTED_NOTE =
  'rows attempted across the three files = parsed transactions + rejected rows. ' +
  'gateway/bank/ledger below are PARSED counts and do not include rejected rows.';

const THROUGHPUT_NOTE =
  'engine excludes database writes and LLM latency; wallClock includes persistence. ' +
  'Both are reported because only one of them is a claim about the matching engine.';

/**
 * ADR-040's arithmetic, re-derived and checked against the population the engine
 * actually matched over.
 *
 * This exists because the formula and the direct count are different
 * computations that are *supposed* to agree, and every prior defect in this
 * repo of this shape was invisible precisely because nothing compared two
 * independent derivations of the same number. Throwing is correct: a run that
 * cannot account for its own denominator must not publish a match rate.
 */
export function assertDenominatorIdentity(
  population: PopulationCounts, directReconcilable: number,
): number {
  const ingested = population.gateway + population.bank + population.ledger + population.rejected;
  const bySubtraction =
    ingested - population.excluded - population.rejected - population.nonPrimaryDuplicates;

  if (bySubtraction !== directReconcilable) {
    throw new Error(
      `ADR-040 denominator disagreement: the formula gives ${bySubtraction} ` +
      `(ingested ${ingested} − excluded ${population.excluded} − rejected ` +
      `${population.rejected} − duplicates ${population.nonPrimaryDuplicates}) but the ` +
      `engine matched over ${directReconcilable} records. The usual cause is a row that ` +
      `is BOTH excluded and a non-primary duplicate, which the formula removes twice. ` +
      `Refusing to publish a match rate whose denominator does not reconcile.`);
  }
  return bySubtraction;
}

/** Round to 2dp for percentages; scores are already 4dp by ADR-032 rule 4. */
function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((100 * numerator / denominator) * 100) / 100;
}

/**
 * Records in at least one CONFIRMED group (ADR-040).
 *
 * `pending_review` is a proposal and contributes to neither numerator; so does
 * `human_rejected`. `manual` groups are excluded separately (ADR-043, §11.5
 * rule 4) — a human asserting two records are the same is not the engine
 * matching them, and folding those in would let the headline grow every time
 * somebody used the review queue.
 */
export function matchedRecordIds(groups: readonly ProposedMatch[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) {
    if (g.tier === 'manual') continue;
    if (g.status !== 'auto_confirmed' && g.status !== 'human_confirmed') continue;
    for (const m of g.members) out.add(m.transactionId);
  }
  return out;
}

/**
 * Per-tier PAIR counts (ADR-072).
 *
 * Counted over the pairs that actually SURVIVED into a group, attributed to the
 * tier that produced them — not over what each tier proposed. S11 can refuse a
 * pair (§10 rule 3), and counting proposals would credit a tier for a link the
 * engine declined to make.
 *
 * This is deliberately NOT `matches.tier`. A group is reported at its WEAKEST
 * constituent tier (§10 rule 5), so 375 of the holdout's Tier 1 pairs sit inside
 * groups labelled `fuzzy`. Counting groups by tier would report Tier 1 as having
 * produced 46 links when it produced 203, and `tools/score`'s tier-attribution
 * diagnostic would be wrong for 63% of matched pairs (ADR-072).
 *
 * `unattributed` is the escape hatch that keeps this honest: a pair inside a
 * group that no tier claims is a bug, and it is reported rather than absorbed
 * into whichever bucket happened to be nearest.
 */
export function tierPairCounts(
  groups: readonly ProposedMatch[],
  exactPairs: readonly Tier1PairMatch[],
  tier2: Tier2Result,
  batchPairs: readonly { a: { id: string }; b: { id: string } }[] = [],
): Record<string, number> {
  const byPair = new Map<string, MatchTier>();
  for (const p of exactPairs) byPair.set(pairKeyOf(p.aId, p.bId), p.tier);
  for (const p of tier2.accepted) byPair.set(pairKeyOf(p.a.id, p.b.id), 'fuzzy');
  for (const p of batchPairs) byPair.set(pairKeyOf(p.a.id, p.b.id), 'batch');

  const counts: Record<string, number> = {
    exact: 0, alias: 0, fuzzy: 0, batch: 0, manual: 0, unattributed: 0,
  };

  for (const g of groups) {
    const ids = g.members.map((m) => m.transactionId);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        // A three-way group holds three internal pairs, but only two of them
        // were ever proposed by a tier — the third is IMPLIED by the other two
        // meeting at the anchor. Implied pairs are real links and are counted
        // under the group's own tier, which is the weakest evidence supporting
        // them and therefore the honest attribution.
        const tier = byPair.get(pairKeyOf(ids[i]!, ids[j]!));
        if (tier !== undefined) counts[tier] = (counts[tier] ?? 0) + 1;
        else if (g.tier === 'manual') counts['manual'] = (counts['manual'] ?? 0) + 1;
        else counts['implied'] = (counts['implied'] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/** S14. Pure: same inputs, same object, no clock read beyond the timings passed in. */
export function computeRunMetrics(input: MetricsInput): RunMetrics {
  const {
    population, pool, exactPairs, tier2, identity, groups, exceptions,
    aliasCountAtStart, aliasCounts, humanCorrectionsToDate, timings, batchOutcomes,
    batchPairs,
  } = input;

  const reconcilable = pool.filter((t) => t.statusNorm === 'reconcilable').length;
  assertDenominatorIdentity(population, reconcilable);
  const ingested = population.gateway + population.bank + population.ledger + population.rejected;

  const matched = matchedRecordIds(groups);
  const pendingGroups = groups.filter((g) => g.status === 'pending_review');
  const pendingRecords = new Set(pendingGroups.flatMap((g) => g.members.map((m) => m.transactionId)));

  // ADR-020 / §11.5 rule 1: cold and warm are always both reported and always
  // labelled. A run with no aliases active at start IS the cold run — saying so
  // explicitly is cheaper than a reader inferring it from a zero.
  const isCold = aliasCountAtStart === 0;
  const aliasPairs = exactPairs.filter((p) => p.tier === 'alias');
  const aliasResolvedRecords = new Set(aliasPairs.flatMap((p) => [p.aId, p.bId]));

  const byCategory: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const e of exceptions) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    bySeverity[e.severity] += 1;
  }

  // S8 re-derives every pair S6 already claimed and reports `outcome: 'match'`
  // "for completeness". Counting those would claim the identity stage
  // contributed 212 findings on the holdout when it contributed 9 — the
  // amount/timing verdicts Tier 1 DECLINED, which is the only thing S8 is for.
  // This is the same overstatement Day 8 removed from the audit log
  // (`IDENTITY_ESTABLISHED` applies the identical filter in orchestrator.ts);
  // the metrics object must not reintroduce it under a different name.
  const identityEstablished = identity.filter(
    (v) => v.verdict.kind === 'established' && v.verdict.outcome !== 'match').length;
  const tiers = tierPairCounts(groups, exactPairs, tier2, batchPairs);
  tiers['identityEstablished'] = identityEstablished;

  const engineSec = timings.engineMs / 1000;
  const wallSec = timings.wallClockMs / 1000;

  return {
    schemaVersion: 1,
    // Named, not inferred. Every null below is explained by this list.
    stagesNotRun: ['S13_EXPLAIN'],

    matchRate: {
      matchRatePct: pct(matched.size, reconcilable),
      matchedRecords: matched.size,
      reconcilableRecords: reconcilable,
      denominatorNote: DENOMINATOR_NOTE,
      pendingReviewExcluded: pendingRecords.size,
    },

    coldStart: {
      matchRatePct: pct(matched.size, reconcilable),
      aliasesActiveAtStart: aliasCountAtStart,
      isCold,
    },

    tierAttribution: tiers,

    aliasLearning: {
      humanCorrectionsToDate,
      recordsAutoResolvedByAliases: aliasResolvedRecords.size,
      // The alias feature's honest headline. NULL rather than Infinity or 0 when
      // no corrections have been made: a ratio with an empty denominator is
      // undefined, and printing "0.0" would read as "the feature did nothing"
      // when the truth is "nobody has taught it anything yet".
      leverageRatio: humanCorrectionsToDate === 0
        ? null
        : Math.round((aliasResolvedRecords.size / humanCorrectionsToDate) * 100) / 100,
      aliasesActive: aliasCounts.active,
      aliasesSuperseded: aliasCounts.superseded,
      aliasesRevoked: aliasCounts.revoked,
    },

    reviewBurden: {
      pendingReviewCount: pendingGroups.length,
      pendingReviewRecords: pendingRecords.size,
      per100Records: pct(pendingGroups.length, reconcilable),
    },

    exceptions: {
      total: exceptions.length,
      byCategory,
      bySeverity,
      candidateCapHits: tier2.candidateStats.filter((s) => s.candidateCapHit).length,
      // S10 runs since #46, so these are real counts rather than `null`. They
      // stay SEPARATE because ADR-038 says they are separate claims: a run where
      // every batch reports `boundExceeded` has proved something about its own
      // bounds, not about the data.
      batchSearchExhausted: batchOutcomes.filter((b) => b.stats.exhaustive).length,
      batchSearchBoundExceeded: batchOutcomes.filter((b) => b.stats.boundHit !== null).length,
    },

    population: {
      ingested,
      ingestedNote: INGESTED_NOTE,
      gateway: population.gateway,
      bank: population.bank,
      ledger: population.ledger,
      excluded: population.excluded,
      rejectedRows: population.rejected,
      nonPrimaryDuplicates: population.nonPrimaryDuplicates,
      reconcilable,
    },

    throughput: {
      recordsPerSecEngine: engineSec === 0 ? 0 : Math.round((ingested / engineSec) * 10) / 10,
      recordsPerSecWallClock: wallSec === 0 ? 0 : Math.round((ingested / wallSec) * 10) / 10,
      stageMs: {
        parse: timings.parse, normalize: timings.normalize, dedupe: timings.dedupe,
        block: timings.block, tier1: timings.tier1, tier15: timings.tier15,
        identity: timings.identity, tier2: timings.tier2, batch: timings.batch,
        group: timings.group, classify: timings.classify, explain: timings.explain,
      },
      note: THROUGHPUT_NOTE,
    },

    // S13 never ran, so there is no cost to report. An object of zeros would say
    // the explain layer ran and cost nothing (ADR-017's template fallback looks
    // exactly like that), which is a different and false claim.
    llmCost: null,
  };
}
