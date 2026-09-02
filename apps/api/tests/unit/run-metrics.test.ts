import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import type { NormalizedTransaction, ProposedMatch, RunConfig } from '../../src/types/engine.js';
import { ingestSources } from '../../src/services/ingestion/index.js';
import { dedupe } from '../../src/services/matching/dedupe.js';
import { buildBlockIndexes, rebuildCounterpartyIndex } from '../../src/services/matching/blocking.js';
import { runTier1 } from '../../src/services/matching/tier1-exact.js';
import { runTier15 } from '../../src/services/matching/tier1_5-alias.js';
import { resolveIdentities } from '../../src/services/matching/identity-resolution.js';
import { runTier2, pairKeyOf } from '../../src/services/matching/tier2-fuzzy.js';
import {
  assembleGroups, fromTier1, fromTier2, type GroupPair,
} from '../../src/services/matching/group-assembly.js';
import { runClassification } from '../../src/services/classification/collect.js';
import {
  computeRunMetrics, assertDenominatorIdentity, matchedRecordIds, tierPairCounts,
  type ExplainMetricsInput, type MetricsInput, type PopulationCounts, type StageTimings,
} from '../../src/services/metrics/run-metrics.js';

const TIMINGS: StageTimings = {
  parse: 10, normalize: 0, dedupe: 1, block: 1, tier1: 1, tier15: 1,
  identity: 1, tier2: 20, batch: null, group: 1, classify: 2,
  explain: 4, engineMs: 38, wallClockMs: 100,
};

/**
 * S13's outcome, as a KEYLESS run produces it: every signature templated, no
 * model called. That is the primary path (schema.md §10.1) and the one this
 * project runs on, so it is what the default fixture asserts against.
 */
const EXPLAIN: ExplainMetricsInput = {
  model: 'gemini-3.5-flash', promptVersion: 'v1',
  signaturesTotal: 27, cacheHits: 0, generated: 0, templated: 27,
  apiCalls: 0, exceptionsExplained: 212, tokensIn: 0, tokensOut: 0,
  callCapPerRun: 8, callCapReached: false, failures: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// The denominator. ADR-040 is prose, and the wrong reading is the flattering one.
// ─────────────────────────────────────────────────────────────────────────────

describe('assertDenominatorIdentity (ADR-040)', () => {
  const pop = (o: Partial<PopulationCounts> = {}): PopulationCounts => ({
    gateway: 300, bank: 300, ledger: 300, excluded: 30, rejected: 0,
    nonPrimaryDuplicates: 10, ...o,
  });

  test('`ingested` is FILE ROWS ATTEMPTED, so rejected rows do not shrink the denominator', () => {
    // The whole trap, in one assertion. `counts.gateway` is a PARSED count —
    // rejected rows never became transactions — so a reader who sums the three
    // sources and then also subtracts `rejected` removes rows that were never
    // added. That shrinks the denominator and INFLATES the match rate.
    //
    // 900 parsed + 5 rejected = 905 attempted; 905 − 30 − 5 − 10 = 860.
    // The wrong reading gives 900 − 30 − 5 − 10 = 855, and 860 records over 855
    // would be a match rate above 100%.
    assert.equal(assertDenominatorIdentity(pop({ rejected: 5 }), 860), 860);
    assert.throws(() => assertDenominatorIdentity(pop({ rejected: 5 }), 855),
      /denominator disagreement/);
  });

  test('the identity is independent of how many rows were rejected', () => {
    // A property, not an example: rejected rows enter `ingested` and leave again
    // in the same expression, so the reconcilable count cannot move with them.
    // A fix that "handles rejected rows" by special-casing zero fails this.
    for (const rejected of [0, 1, 7, 42, 999]) {
      assert.equal(assertDenominatorIdentity(pop({ rejected }), 860), 860,
        `rejected=${rejected} moved the denominator`);
    }
  });

  test('it THROWS rather than publishing a denominator that does not reconcile', () => {
    // The double-subtraction hazard: a row that is BOTH excluded and a
    // non-primary duplicate is removed twice by the formula and once by a direct
    // count. Currently unreachable on the holdout, which is exactly why it needs
    // a test rather than a comment.
    assert.throws(() => assertDenominatorIdentity(pop(), 861), /removes twice/);
    assert.throws(() => assertDenominatorIdentity(pop(), 859), /Refusing to publish/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-040's numerator, and §11.5's five reporting rules.
// ─────────────────────────────────────────────────────────────────────────────

describe('matchedRecordIds (ADR-040, ADR-043)', () => {
  const g = (
    tier: ProposedMatch['tier'], status: ProposedMatch['status'], ids: string[],
  ): ProposedMatch => ({
    tier, status, confidence: 1, ruleId: 'R', cardinality: 'one_to_one',
    members: ids.map((id, i) => ({ transactionId: id, role: 'gateway', isAnchor: i === 0 })),
    amountDeltaPaise: 0, dateDeltaDays: 0, aliasIds: [], scoreBreakdown: null,
  });

  test('pending_review and human_rejected contribute to neither numerator', () => {
    assert.deepEqual([...matchedRecordIds([g('fuzzy', 'pending_review', ['a', 'b'])])], []);
    assert.deepEqual([...matchedRecordIds([g('fuzzy', 'human_rejected', ['a', 'b'])])], []);
  });

  test('auto_confirmed and human_confirmed both count', () => {
    assert.equal(matchedRecordIds([g('exact', 'auto_confirmed', ['a', 'b'])]).size, 2);
    assert.equal(matchedRecordIds([g('fuzzy', 'human_confirmed', ['c', 'd'])]).size, 2);
  });

  test('a MANUAL match never counts, however confirmed (ADR-043, §11.5 rule 4)', () => {
    // A human asserting two records are the same is not the engine matching
    // them. Without this the headline grows every time somebody uses the review
    // queue, which would make the number a measure of human effort.
    assert.deepEqual([...matchedRecordIds([g('manual', 'auto_confirmed', ['a', 'b'])])], []);
    assert.deepEqual([...matchedRecordIds([g('manual', 'human_confirmed', ['a', 'b'])])], []);
  });

  test('a record in two groups is counted once', () => {
    const both = matchedRecordIds([
      g('exact', 'auto_confirmed', ['a', 'b']),
      g('fuzzy', 'auto_confirmed', ['b', 'c']),
    ]);
    assert.equal(both.size, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole thing, against the committed holdout.
// ─────────────────────────────────────────────────────────────────────────────

describe('computeRunMetrics against the holdout', () => {
  const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
  const ing = ingestSources({
    runId: 'r',
    files: {
      gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
      bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
      ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
    },
  });
  const config: RunConfig = {
    ...ENGINE_DEFAULTS, referenceDate: ing.referenceDate!, aliasCountAtStart: 0,
  };

  const d = dedupe(ing.transactions);
  const blocks = buildBlockIndexes(d.pool);
  const t1 = runTier1(blocks, config);
  const t15 = runTier15(d.pool, config, [], new Set(t1.matches.flatMap((m) => [m.aId, m.bId])));
  rebuildCounterpartyIndex(blocks, t15.pool);
  const exactPairs = [...t1.matches, ...t15.matches];
  const identity = resolveIdentities(t15.pool, config);
  const settled = new Set<string>();
  for (const { pair, verdict } of identity) {
    if (verdict.kind !== 'not_established') settled.add(pairKeyOf(pair[0].id, pair[1].id));
  }
  const tier2 = runTier2(blocks, config, exactPairs, settled);
  const byId = new Map<string, NormalizedTransaction>(t15.pool.map((t) => [t.id, t]));
  const assembled = assembleGroups([
    ...exactPairs.map((m) => fromTier1(m, byId)).filter((p): p is GroupPair => p !== null),
    ...tier2.accepted.map(fromTier2),
  ]);
  const exceptions = runClassification({
    pool: t15.pool, duplicates: d.findings, identity, tier2,
    batches: [], groups: assembled.matches, refused: assembled.refused, config,
  });

  const input: MetricsInput = {
    population: {
      gateway: ing.counts.gateway, bank: ing.counts.bank, ledger: ing.counts.ledger,
      excluded: ing.counts.excluded, rejected: ing.counts.rejected,
      nonPrimaryDuplicates: ing.transactions.length - d.pool.length,
    },
    pool: t15.pool, exactPairs, tier2, identity, groups: assembled.matches, exceptions,
    counterpartyResolutions: t15.counterpartyResolutions,
    coldGroups: null,
    batchOutcomes: [],
    batchPairs: [],
    aliasCountAtStart: 0,
    aliasCounts: { active: 0, superseded: 0, revoked: 0 },
    humanCorrectionsToDate: 0,
    timings: TIMINGS, config, explain: EXPLAIN,
  };
  const m = computeRunMetrics(input);

  test('the headline is ADR-040 exactly, with every denominator term recorded', () => {
    assert.equal(m.matchRate.matchedRecords, 582);
    assert.equal(m.matchRate.reconcilableRecords, 874);
    assert.equal(m.matchRate.matchRatePct, 66.59);
    // The terms have to be inspectable or the percentage is not a measurement.
    assert.equal(m.population.ingested, 920);
    assert.equal(
      m.population.ingested - m.population.excluded - m.population.rejectedRows
        - m.population.nonPrimaryDuplicates,
      m.matchRate.reconcilableRecords,
      'the published terms must reproduce the published denominator');
    assert.match(m.matchRate.denominatorNote, /ADR-040/);
  });

  test('tierAttribution counts PAIRS, and they reconcile with the groups (ADR-072)', () => {
    // The quantity ADR-072 requires, and the reason it is not `matches.tier`:
    // Tier 1 produced 203 pairs, but only 37 GROUPS are labelled `exact`
    // because 166 of them also hold a fuzzy leg (§10 rule 5). A per-tier table
    // built from group tiers would understate Tier 1 by 166.
    assert.equal(m.tierAttribution['exact'], 203);
    assert.equal(m.tierAttribution['fuzzy'], 279);
    assert.equal(m.tierAttribution['alias'], 0);
    assert.equal(m.tierAttribution['implied'], 198);
    assert.equal(m.tierAttribution['unattributed'], 0,
      'a pair inside a group that no tier claims is a bug, not a rounding error');
    assert.equal(assembled.matches.filter((x) => x.tier === 'exact').length, 37,
      'the group-tier figure this metric deliberately is NOT');

    // Independent derivation: every internal pair of every group, counted from
    // the group shapes alone. If the two disagree the attribution is wrong.
    const fromShapes = assembled.matches.reduce(
      (sum, x) => sum + (x.members.length * (x.members.length - 1)) / 2, 0);
    const attributed = ['exact', 'alias', 'fuzzy', 'batch', 'manual', 'implied']
      .reduce((sum, k) => sum + (m.tierAttribution[k] ?? 0), 0);
    assert.equal(attributed, fromShapes);
    assert.equal(attributed, 680);
  });

  test('identityEstablished counts what S8 CONTRIBUTED, not what it re-derived', () => {
    // Day 8 removed this exact overstatement from the audit log: S8 re-derives
    // every pair S6 already claimed and reports `outcome: 'match'` "for
    // completeness". Counting those claims the identity stage found 212 things
    // when it found 9 — the amount/timing verdicts Tier 1 declined.
    assert.equal(m.tierAttribution['identityEstablished'], 9);
    const allEstablished = identity.filter((v) => v.verdict.kind === 'established').length;
    assert.equal(allEstablished, 212, 'the inflated number this must never report');
  });

  test('every stage runs now, so stagesNotRun is EMPTY and llmCost is a report (U11)', () => {
    // This assertion inverted when U11 wired S13, and the distinction the old
    // `null` carried had to survive the change rather than be lost with it.
    // `null` meant "there is no explain layer". An object with `apiCalls: 0`
    // and `signaturesTemplated: 27` means "the stage ran and called no model" —
    // which is what a keyless run actually did, and is a claim `null` could not
    // make.
    assert.deepEqual(m.stagesNotRun, []);
    assert.equal(m.throughput.stageMs['explain'], 4);
    assert.notEqual(m.llmCost, null);
    assert.equal(m.llmCost.apiCalls, 0);
    assert.equal(m.llmCost.signaturesTemplated, 27);
    assert.equal(m.llmCost.signaturesGenerated, 0);
    assert.equal(m.llmCost.exceptionsExplained, 212);
    // ADR-018's headline: 212 exceptions covered by 27 distinct shapes.
    assert.equal(m.llmCost.collapseRatio, 7.85);
    // A free tier has no bill. NULL, never 0 — a measured zero and an absent
    // figure are different claims, which is this file's whole discipline.
    assert.equal(m.llmCost.estimatedCostUsd, null);
    assert.equal(m.llmCost.model, 'gemini-3.5-flash',
      'the model is reported beside the counts because it is hashed into every signature');
  });

  test('llmCost distinguishes "the cap bound" from "no model was configured"', () => {
    // Both produce templates, and only one of them is a tuning question.
    const capped = computeRunMetrics({
      ...input,
      explain: { ...EXPLAIN, apiCalls: 8, generated: 30, templated: 12, callCapReached: true },
    });
    assert.equal(capped.llmCost.callCapReached, true);
    assert.equal(capped.llmCost.callCapPerRun, 8);
    assert.equal(m.llmCost.callCapReached, false, 'the keyless run did not hit a cap');
  });

  test('collapseRatio is NULL, not 0, when there are no signatures at all', () => {
    const empty = computeRunMetrics({
      ...input,
      explain: { ...EXPLAIN, signaturesTotal: 0, templated: 0, exceptionsExplained: 0 },
    });
    assert.equal(empty.llmCost.collapseRatio, null);
  });

  test('a stage that DID run reports counts, not null — the same rule in reverse (#46)', () => {
    // S10 is wired, so reporting its search figures as `null` would claim an
    // absence for work the engine actually did. ADR-038's two claims stay
    // separate: proving no combination works is a finding, running out of
    // budget is a statement about the engine's own bounds.
    const withBatches = computeRunMetrics({
      ...input,
      batchOutcomes: [
        { stats: { exhaustive: true, boundHit: null } },
        { stats: { exhaustive: true, boundHit: null } },
        { stats: { exhaustive: false, boundHit: { bound: 'nodes', value: 1 } } },
      ],
    });
    assert.equal(withBatches.exceptions.batchSearchExhausted, 2);
    assert.equal(withBatches.exceptions.batchSearchBoundExceeded, 1);
    assert.notEqual(withBatches.exceptions.batchSearchExhausted, null,
      'S10 ran; null would be an absence claimed for work that happened');
  });

  test('cold and warm are both labelled, and leverage is null rather than zero', () => {
    // §11.5 rule 1. A leverage ratio of "0.0" reads as "the feature did
    // nothing"; the truth on a cold run is that nobody has taught it anything.
    assert.equal(m.coldStart.isCold, true);
    assert.equal(m.coldStart.aliasesActiveAtStart, 0);
    assert.equal(m.aliasLearning.leverageRatio, null);
    assert.equal(m.aliasLearning.humanCorrectionsToDate, 0);
  });

  test('review burden is reported next to the rate, and is excluded from it', () => {
    assert.equal(m.reviewBurden.pendingReviewCount, 65);
    assert.equal(m.reviewBurden.pendingReviewRecords, 184);
    assert.equal(m.matchRate.pendingReviewExcluded, 184);
    // Not folded in: the two populations must not overlap.
    const matched = matchedRecordIds(assembled.matches);
    const pending = new Set(assembled.matches
      .filter((x) => x.status === 'pending_review')
      .flatMap((x) => x.members.map((y) => y.transactionId)));
    assert.deepEqual([...pending].filter((id) => matched.has(id)), [],
      'a pending record counted as matched would put unreviewed work in the headline');
  });

  test('the exception blocks agree with the exception list they describe', () => {
    assert.equal(m.exceptions.total, exceptions.length);
    const catSum = Object.values(m.exceptions.byCategory).reduce((a, b) => a + b, 0);
    const sevSum = Object.values(m.exceptions.bySeverity).reduce((a, b) => a + b, 0);
    assert.equal(catSum, m.exceptions.total);
    assert.equal(sevSum, m.exceptions.total);
    assert.equal(m.exceptions.total, 234);
  });

  test('no ground-truth-derived figure appears anywhere (ADR-041)', () => {
    // The structural guarantee. `runs.metrics` is the engine's account of its own
    // work; precision, recall and false positives are a MEASUREMENT and live in
    // score_reports. A key named for one of them here would mean the engine had
    // read the answer key.
    const flat = JSON.stringify(m).toLowerCase();
    for (const forbidden of ['precision', 'recall', '"f1"', 'falsepositive',
      'groundtruth', 'ground_truth', 'measuredagainst', 'confusion']) {
      assert.equal(flat.includes(forbidden), false,
        `metrics contains "${forbidden}" — that is a score_reports figure (ADR-041)`);
    }
  });

  test('throughput reports engine and wall clock separately, never one number', () => {
    // Only one of the two is a claim about the matching engine, and publishing a
    // single "records/sec" would let persistence cost read as engine cost.
    assert.equal(m.throughput.recordsPerSecEngine, Math.round((920 / 0.038) * 10) / 10);
    assert.equal(m.throughput.recordsPerSecWallClock, Math.round((920 / 0.1) * 10) / 10);
    assert.ok(m.throughput.recordsPerSecEngine > m.throughput.recordsPerSecWallClock);
  });

  test('it is a pure function: same input, byte-identical output', () => {
    assert.deepEqual(computeRunMetrics(input), computeRunMetrics(input));
  });
});
