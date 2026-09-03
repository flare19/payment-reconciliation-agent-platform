import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReconciliationReport, type PublishedHeadline,
} from '../../src/services/metrics/reconciliation.js';
import type { ReconciliationCounts } from '../../src/repositories/reconciliation.js';

/**
 * A CHECK THAT CANNOT FAIL IS NOT A CHECK (CLAUDE.md §9, ADR-162).
 *
 * The balance panel's whole value is that it is able to say no. That property
 * is worth exactly as much as the evidence that it has been watched saying it —
 * so every identity below is broken deliberately, one at a time, and asserted
 * to fail alone. A suite that only fed this function balanced books would pass
 * just as happily against `holds: () => true`.
 */

/** The real holdout run's figures. Balanced, and verified against the database. */
const BALANCED: ReconciliationCounts = {
  ingested: 920,
  excluded: 37,
  nonPrimaryDuplicates: 9,
  reconcilable: 874,

  matched: 573,
  matchedByEngine: 573,
  matchedByHuman: 0,
  inReviewQueue: 216,
  neither: 85,
  neitherCovered: 85,

  exceptionRecords: 212,
  exceptionsInConfirmedMatch: 99,
  exceptionsInReviewQueue: 19,
  exceptionsPure: 85,
  exceptionsOutsideDenominator: 9,

  exceptionRows: 212,
};

const PUBLISHED: PublishedHeadline = { reconcilable: 874, matched: 573, exceptions: 212 };

const idsOf = (r: ReturnType<typeof buildReconciliationReport>) =>
  r.checks.filter((c) => !c.holds).map((c) => c.id);

describe('the balance proof, on books that do balance', () => {
  test('all five identities hold on the real holdout population', () => {
    const r = buildReconciliationReport(BALANCED, PUBLISHED);
    assert.equal(r.balanced, true, idsOf(r).join(', '));
    assert.deepEqual(r.checks.map((c) => c.id),
      ['DENOMINATOR', 'DISPOSITION', 'NO_ORPHANS', 'EXCEPTIONS', 'HEADLINE']);
    assert.ok(r.checks.every((c) => c.delta === 0));
  });

  test('both sides of every identity are published, so a reader can check it', () => {
    // The panel's argument is "here is the arithmetic", not "here is a tick".
    for (const c of buildReconciliationReport(BALANCED, PUBLISHED).checks) {
      assert.equal(typeof c.left, 'number');
      assert.equal(typeof c.right, 'number');
      assert.ok(c.expression.length > 0, `${c.id} must state its identity`);
      assert.ok(c.note.length > 0, `${c.id} must say what to conclude`);
    }
  });
});

describe('each identity breaks ALONE — watched failing, not assumed capable', () => {
  test('C1 DENOMINATOR: a miscounted exclusion', () => {
    // One row goes missing between ingest and the denominator.
    const r = buildReconciliationReport({ ...BALANCED, excluded: 36 }, PUBLISHED);
    assert.equal(r.balanced, false);
    assert.deepEqual(idsOf(r), ['DENOMINATOR']);
    assert.equal(r.checks[0]!.delta, 1, 'the delta must size the problem');
  });

  test('C2 DISPOSITION: a record in no state at all', () => {
    // 874 reconcilable, but only 873 accounted for across the three states.
    const r = buildReconciliationReport(
      { ...BALANCED, neither: 84, neitherCovered: 84 }, PUBLISHED);
    assert.equal(r.balanced, false);
    assert.deepEqual(idsOf(r), ['DISPOSITION'],
      'a miscounted state must not also masquerade as a dropped record');
  });

  test('C3 NO_ORPHANS: a record dropped silently — the one that matters', () => {
    // The engine gave up on 85 records and named only 84. The missing one is
    // invisible in every other figure on the page, and its absence makes the
    // match rate look BETTER. This is the failure the panel exists to catch.
    // This is the real dev-seed defect, reproduced: 85 records the engine gave
    // up on, 84 of them named. The 85th is bank row 64 — Rs 4,75,201.95 — in no
    // match and on no list, and invisible in every other figure on the page.
    const r = buildReconciliationReport({ ...BALANCED, neitherCovered: 84 }, PUBLISHED);
    assert.equal(r.balanced, false);
    assert.deepEqual(idsOf(r), ['NO_ORPHANS'], 'it must fire ALONE — nothing else is wrong');
    const orphan = r.checks.find((c) => c.id === 'NO_ORPHANS')!;
    assert.equal(orphan.left, 85, 'unresolved');
    assert.equal(orphan.right, 84, 'named on the list');
    assert.equal(orphan.delta, 1, 'one record went missing');
  });

  test('C4 EXCEPTIONS: the classes stop covering the list', () => {
    const r = buildReconciliationReport(
      { ...BALANCED, exceptionsInConfirmedMatch: 98 }, PUBLISHED);
    assert.equal(r.balanced, false);
    assert.deepEqual(idsOf(r), ['EXCEPTIONS']);
  });

  test('C5 HEADLINE: the stored summary disagrees with the rows beneath it', () => {
    // The books balance internally and the published headline is still wrong.
    // Without C5 this run would render five ticks and a false match rate.
    const r = buildReconciliationReport(BALANCED, { ...PUBLISHED, matched: 999 });
    assert.equal(r.balanced, false);
    assert.deepEqual(idsOf(r), ['HEADLINE']);
    assert.match(r.checks.at(-1)!.expression, /999/);
  });
});

describe('absence is not disagreement', () => {
  test('a run that published no headline SKIPS C5 rather than failing it', () => {
    // An in-flight or failed run has no metrics to compare against. Calling
    // that a broken identity would cry wolf on the one panel that must not.
    const r = buildReconciliationReport(BALANCED,
      { reconcilable: null, matched: null, exceptions: null });
    assert.equal(r.balanced, true);
    assert.equal(r.checks.length, 4);
    assert.ok(!r.checks.some((c) => c.id === 'HEADLINE'));
  });

  test('a partially written headline also skips, rather than half-comparing', () => {
    const r = buildReconciliationReport(BALANCED, { ...PUBLISHED, exceptions: null });
    assert.equal(r.checks.length, 4);
    assert.equal(r.balanced, true);
  });
});

describe('the decomposition the panel renders', () => {
  test('exception classes are disjoint and sum to the total', () => {
    const { exceptionBreakdown: e } = buildReconciliationReport(BALANCED, PUBLISHED);
    assert.equal(
      e.inConfirmedMatch + e.inReviewQueue + e.pure + e.outsideDenominator, e.total);
  });

  test('an empty run balances trivially rather than dividing by nothing', () => {
    const zero: ReconciliationCounts = {
      ingested: 0, excluded: 0, nonPrimaryDuplicates: 0, reconcilable: 0,
      matched: 0, matchedByEngine: 0, matchedByHuman: 0, inReviewQueue: 0,
      neither: 0, neitherCovered: 0,
      exceptionRecords: 0, exceptionsInConfirmedMatch: 0, exceptionsInReviewQueue: 0,
      exceptionsPure: 0, exceptionsOutsideDenominator: 0, exceptionRows: 0,
    };
    const r = buildReconciliationReport(zero, { reconcilable: 0, matched: 0, exceptions: 0 });
    assert.equal(r.balanced, true);
  });
});

describe('a reviewer doing their job does NOT unbalance the books', () => {
  /**
   * FOUND BY RUNNING THE PANEL OVER ALL 39 STORED RUNS, not by reasoning.
   *
   * `runs.metrics` is frozen at S14 and knows only what the engine confirmed
   * alone. The live recomputation moves as reviewers approve proposals. The
   * first version of C5 compared the two directly, so on a real run where 24
   * proposals had been approved it reported the correct published 570 as
   * "mismatched" against a recomputed 640 — a red failure banner earned by
   * using the product as intended. That is worse than no check: it teaches a
   * reader to ignore the one panel that must never be ignored.
   */
  const REVIEWED = {
    ...BALANCED,
    matched: 597,          // 573 the engine confirmed + 24 a human did
    matchedByEngine: 573,
    matchedByHuman: 24,
    inReviewQueue: 192,    // the 24 left the queue
    neither: 85,
  };

  test('C5 compares engine-alone to engine-alone, so approvals do not break it', () => {
    const r = buildReconciliationReport(REVIEWED, PUBLISHED);
    assert.equal(r.balanced, true, idsOf(r).join(', '));
  });

  test('and the human contribution is REPORTED rather than hidden or folded in', () => {
    const r = buildReconciliationReport(REVIEWED, PUBLISHED);
    assert.match(r.checks.at(-1)!.expression, /\+24 later confirmed by a human/);
    assert.equal(r.disposition.matchedByHuman, 24);
    assert.equal(r.disposition.matchedByEngine, 573);
  });

  test('C5 still fails when the ENGINE figure itself is wrong', () => {
    // The relaxation must not have removed the check's teeth.
    const r = buildReconciliationReport(REVIEWED, { ...PUBLISHED, matched: 571 });
    assert.equal(r.balanced, false);
    assert.deepEqual(idsOf(r), ['HEADLINE']);
  });
});
