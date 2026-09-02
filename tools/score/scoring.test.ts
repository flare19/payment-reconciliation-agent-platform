import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreMatching, scoreClassification, scoreResolvability, scoreByDifficulty,
  tierDiagnostic, pairsFromMatches, pairKey, rowKey, ENGINE_ALONE, WITH_REVIEW,
  type AnswerKey, type EngineSnapshot, type KeyEvent, type EngineMatch,
} from './scoring.js';
import { assertSameDataset, buildReport } from './index.js';

/**
 * A scorer is the one module in this repo where a passing test proves least.
 * These are therefore built around a single discipline: for every honesty gate,
 * assert BOTH that it passes on correct engine output AND that it fires on
 * output that is genuinely wrong. A gate that has never been seen to fail is
 * indistinguishable from a gate that cannot.
 */

// ── A tiny synthetic key, so every expectation is visible in the test ─────────

const G = (n: number) => ({ sourceSystem: 'gateway', sourceRowNumber: n });
const B = (n: number) => ({ sourceSystem: 'bank', sourceRowNumber: n });
const L = (n: number) => ({ sourceSystem: 'ledger', sourceRowNumber: n });

function ev(o: Partial<KeyEvent> & { eventId: string; projections: KeyEvent['projections'] }): KeyEvent {
  return {
    scenario: 'CLEAN_3WAY', expectedOutcome: 'MATCH_3WAY', expectedCategory: null,
    expectedSecondaryFlags: [], resolvability: 'RESOLVABLE', difficulty: 'EASY',
    requiresAlias: false, ...o,
  };
}

const KEY: AnswerKey = {
  manifest: {
    seed: 1, fileHashes: { gateway: 'aa', bank: 'bb', ledger: 'cc' },
    theoreticalMaxMatchRatePct: 93, unresolvableEventCount: 1,
  },
  events: [
    // A clean 3-way that should fully match.
    ev({ eventId: 'e1', projections: [G(1), B(1), L(1)] }),
    // An AMOUNT_TRUE_MISMATCH: pairs say shouldMatch, the EVENT says exception.
    ev({
      eventId: 'e2', scenario: 'AMOUNT_TRUE_MISMATCH', projections: [G(2), B(2), L(2)],
      expectedOutcome: 'EXCEPTION', expectedCategory: 'AMOUNT_MISMATCH',
      expectedSecondaryFlags: ['TIMING_DRIFT'], difficulty: 'HARD',
    }),
    // An unresolvable net batch: unresolvable in the BANK leg only.
    ev({
      eventId: 'e3', scenario: 'UNSPLITTABLE_NET_BATCH', projections: [G(3), B(3), L(3)],
      expectedOutcome: 'EXCEPTION', expectedCategory: 'UNSPLITTABLE_BATCH',
      resolvability: 'UNRESOLVABLE', difficulty: 'HARD',
    }),
  ],
  expectedPairs: [
    { eventId: 'e1', a: G(1), b: B(1), shouldMatch: true, viaTier: 'exact' },
    { eventId: 'e1', a: G(1), b: L(1), shouldMatch: true, viaTier: 'exact' },
    { eventId: 'e1', a: B(1), b: L(1), shouldMatch: true, viaTier: 'fuzzy' },
    { eventId: 'e2', a: G(2), b: L(2), shouldMatch: true, viaTier: 'exact' },
    { eventId: 'e3', a: G(3), b: L(3), shouldMatch: true, viaTier: 'batch' },
    { eventId: 'e3', a: G(3), b: B(3), shouldMatch: true, viaTier: 'batch' },
    // The only pair the key DENIES.
    { eventId: 'e1', a: G(1), b: B(3), shouldMatch: false, viaTier: 'fuzzy' },
  ],
  aliasKey: [],
};

const ROWS = [
  ['t-g1', 'gateway', 1], ['t-b1', 'bank', 1], ['t-l1', 'ledger', 1],
  ['t-g2', 'gateway', 2], ['t-b2', 'bank', 2], ['t-l2', 'ledger', 2],
  ['t-g3', 'gateway', 3], ['t-b3', 'bank', 3], ['t-l3', 'ledger', 3],
] as const;

function snapshot(matches: EngineMatch[], exceptions: EngineSnapshot['exceptions'] = []): EngineSnapshot {
  return {
    records: ROWS.map(([transactionId, sourceSystem, sourceRowNumber]) => ({
      transactionId, sourceSystem, sourceRowNumber,
    })),
    matches, exceptions,
    metrics: { tierAttribution: { exact: 2, fuzzy: 1 }, matchRate: { matchRatePct: 60 } },
  };
}

const group = (id: string, status: string, ids: string[], tier = 'fuzzy'): EngineMatch => ({
  matchId: id, tier, status, members: ids.map((transactionId) => ({ transactionId })),
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the group→pair mapping', () => {
  test('a 3-way group asserts all three internal pairs, implied leg included', () => {
    // If the engine puts three records in one group it has asserted the
    // bank↔ledger relationship whether or not any rule looked at it. A scorer
    // that ignored implied pairs would let a wrong 3-way group hide two of its
    // three claims.
    const byId = new Map(snapshot([]).records.map((r) => [r.transactionId, r]));
    const pairs = pairsFromMatches([group('m', 'auto_confirmed', ['t-g1', 't-b1', 't-l1'])], byId);
    assert.equal(pairs.size, 3);
    assert.ok(pairs.has(pairKey(rowKey(G(1)), rowKey(L(1)))));
    assert.ok(pairs.has(pairKey(rowKey(B(1)), rowKey(L(1)))), 'the implied leg must be scored');
  });
});

describe('§5.1.1a — engine-alone vs with-review (ADR-119)', () => {
  /**
   * THE DEFECT THIS PREVENTS. Run `verify` was scored at recall 0.6075, then a
   * human approved 22 matches, and a re-score of the SAME RUN with a
   * BYTE-IDENTICAL SCORER returned 0.6941. Eight and a half points of "measured
   * accuracy" arrived because somebody clicked Approve, and nothing said so.
   *
   * Every check in this project watches a guard fail before trusting it. The
   * guard here is subtler than usual: what must be demonstrated is that one
   * number MOVES under review and the other DOES NOT. A test that only asserted
   * the two figures exist would pass on the broken scorer.
   */
  const engineFound = ['t-g1', 't-b1', 't-l1'];

  test('review moves the with-review figure and CANNOT move engine-alone', () => {
    const deferred = snapshot([group('m', 'pending_review', engineFound)]);
    const approved = snapshot([group('m', 'human_confirmed', engineFound)]);

    const beforeEngine = scoreMatching(KEY, deferred, ENGINE_ALONE);
    const afterEngine = scoreMatching(KEY, approved, ENGINE_ALONE);
    const beforeReview = scoreMatching(KEY, deferred, WITH_REVIEW);
    const afterReview = scoreMatching(KEY, approved, WITH_REVIEW);

    // The engine did the same work in both worlds. Its figure must not notice.
    assert.deepEqual(afterEngine, beforeEngine,
      'ENGINE_ALONE changed when a human clicked Approve — the whole point of §5.1.1a');
    assert.equal(afterEngine.truePositives, 0);
    assert.equal(afterEngine.pendingPairs, 3, 'a human-confirmed pair is still DEFERRED work');

    // And the system's figure must notice, or the split says nothing.
    assert.equal(beforeReview.truePositives, 0);
    assert.equal(afterReview.truePositives, 3);
    assert.ok(afterReview.recall > beforeReview.recall);
  });

  test('a rejection is deferred work engine-alone, and withdrawn with review', () => {
    const rejected = snapshot([group('m', 'human_rejected', engineFound)]);
    assert.equal(scoreMatching(KEY, rejected, ENGINE_ALONE).pendingPairs, 3);
    // With review the engine withdrew the claim: neither confirmed nor pending.
    assert.equal(scoreMatching(KEY, rejected, WITH_REVIEW).pendingPairs, 0);
    assert.equal(scoreMatching(KEY, rejected, WITH_REVIEW).truePositives, 0);
  });

  test('with no review at all the two are identical — by coincidence, not by rule', () => {
    const untouched = snapshot([group('m', 'auto_confirmed', engineFound)]);
    assert.deepEqual(
      scoreMatching(KEY, untouched, ENGINE_ALONE),
      scoreMatching(KEY, untouched, WITH_REVIEW));
  });

  test('the default policy is WITH_REVIEW, so no existing caller changed meaning', () => {
    const mixed = snapshot([group('m', 'human_confirmed', engineFound)]);
    assert.deepEqual(scoreMatching(KEY, mixed), scoreMatching(KEY, mixed, WITH_REVIEW));
  });

  test('review-queue precision is answered over the queue AS HANDED OVER', () => {
    // It drifts under WITH_REVIEW because clearing the queue shrinks the
    // denominator: the question "is the engine asking about the right things?"
    // was being answered over a human-selected subset of its own asks.
    const half = snapshot([
      group('m1', 'human_confirmed', engineFound),
      group('m2', 'pending_review', ['t-g2', 't-b2', 't-l2']),
    ]);
    assert.equal(scoreMatching(KEY, half, ENGINE_ALONE).pendingPairs, 6);
    assert.equal(scoreMatching(KEY, half, WITH_REVIEW).pendingPairs, 3);
  });
});

describe('scoreMatching', () => {
  test('a fully correct 3-way group scores 3 TP and no FP', () => {
    const r = scoreMatching(KEY, snapshot([group('m', 'auto_confirmed', ['t-g1', 't-b1', 't-l1'])]));
    assert.equal(r.truePositives, 3);
    assert.equal(r.falsePositives, 0);
    assert.equal(r.precision, 1);
  });

  test('a pair the key DENIES is a false positive, and is named', () => {
    // The single most damning failure available here, so it is reported as a
    // list of pairs rather than only as a count.
    const r = scoreMatching(KEY, snapshot([group('m', 'auto_confirmed', ['t-g1', 't-b3'])]));
    assert.equal(r.falsePositives, 1);
    assert.deepEqual(r.falsePositivePairs, [{ a: 'bank:3', b: 'gateway:1' }]);
    assert.equal(r.precision, 0);
  });

  test('pending_review is in NEITHER bucket, and is scored separately (ADR-040)', () => {
    const r = scoreMatching(KEY, snapshot([group('m', 'pending_review', ['t-g1', 't-b1'])]));
    assert.equal(r.truePositives, 0, 'a proposal is not a reconciliation');
    assert.equal(r.falsePositives, 0, 'nor is it a wrong match');
    assert.equal(r.pendingPairs, 1);
    assert.equal(r.reviewQueuePrecision, 1, 'it asked about a pair that really matches');
  });

  test('review-queue precision falls when the engine asks about a wrong pair', () => {
    const r = scoreMatching(KEY, snapshot([group('m', 'pending_review', ['t-g1', 't-b3'])]));
    assert.equal(r.reviewQueuePrecision, 0);
  });

  test('a pair whose EVENT is an EXCEPTION is excluded from both sides (ADR-072)', () => {
    // e2 is AMOUNT_TRUE_MISMATCH: the pair key says shouldMatch, the event key
    // says the correct output is an exception. Counting it as a miss understates
    // recall; counting it as a match overstates it. It is excluded and COUNTED,
    // so the adjustment is visible rather than a silent denominator change.
    const none = scoreMatching(KEY, snapshot([]));
    assert.equal(none.excludedExceptionEventPairs, 3, 'e2 has 1 pair, e3 has 2');
    assert.equal(none.falseNegatives, 3, "only e1's three affirmed pairs count against recall");

    // Matching it is NOT a false positive — the key affirms the pair.
    const matched = scoreMatching(KEY, snapshot([group('m', 'auto_confirmed', ['t-g2', 't-l2'])]));
    assert.equal(matched.falsePositives, 0);
    assert.equal(matched.truePositives, 0, 'and it is not credited either');
  });

  test('human_rejected counts for nothing at all', () => {
    const r = scoreMatching(KEY, snapshot([group('m', 'human_rejected', ['t-g1', 't-b1'])]));
    assert.equal(r.truePositives, 0);
    assert.equal(r.falsePositives, 0);
    assert.equal(r.pendingPairs, 0);
  });
});

describe('same-source cardinality legs (#46/#49)', () => {
  // A one_to_many group's two bank legs are members of one economic event, not
  // each other's counterpart. The key never enumerates that relationship, so
  // scoring it as invention would penalise the engine for the exact shape §8.1
  // exists to produce. But the key's nine IDENTITY_DESTROYED gateway<->gateway
  // DENIALS must stay fully scoreable — matching two of those is the single most
  // damning failure available here.
  const KEY_WITH_DENIAL: AnswerKey = {
    ...KEY,
    expectedPairs: [
      ...KEY.expectedPairs,
      { eventId: 'e1', a: G(1), b: G(2), shouldMatch: false, viaTier: 'fuzzy' },
    ],
  };

  test('a split group\'s bank legs are excluded and COUNTED, never silently dropped', () => {
    // A genuine one_to_many: gateway:1 settled across bank:1 and bank:2, both
    // affirmed cross-source. The bank:1 <-> bank:2 leg is the pair under test.
    const splitKey: AnswerKey = {
      ...KEY,
      expectedPairs: [
        ...KEY.expectedPairs,
        { eventId: 'e1', a: G(1), b: B(2), shouldMatch: true, viaTier: 'batch' },
      ],
    };
    const r = scoreMatching(splitKey, snapshot([
      group('m', 'auto_confirmed', ['t-g1', 't-b1', 't-b2'])]));
    assert.equal(r.excludedSameSourceLegs, 1, 'bank:1 <-> bank:2 is a leg, not a claim');
    assert.equal(r.falsePositives, 0, 'and it must not be scored as invention');
    assert.equal(r.truePositives, 2, 'both cross-source legs still count');
  });

  test('a same-source pair the key DENIES is still a false positive', () => {
    // The IDENTITY_DESTROYED guard. If this ever stops firing, the engine can
    // match two of three indistinguishable rows and the scorer will not say so.
    const r = scoreMatching(KEY_WITH_DENIAL, snapshot([
      group('m', 'auto_confirmed', ['t-g1', 't-g2'])]));
    assert.equal(r.falsePositives, 1);
    assert.equal(r.excludedSameSourceLegs, 0, 'a denial is judgeable, not a leg');
  });

  test('the exclusion does not leak into the unresolvable build blocker', () => {
    const r = scoreResolvability(KEY, snapshot([
      group('m', 'auto_confirmed', ['t-b3', 't-b1'])]));
    assert.equal(r.unresolvableRecall, 1, 'two bank legs are not an invented match');
  });
});

describe('scoreResolvability — the build blocker', () => {
  // This gate was WRONG on its first run and reported 5 invented matches on a
  // holdout where the engine had invented nothing. §4's sub-classes are
  // unresolvable in ONE LEG: a net-batch event's gateway↔ledger pair is an
  // ordinary payment and the key affirms it. Both directions are asserted below,
  // because a gate corrected until it stopped firing is worthless unless it can
  // still be made to fire.

  test('matching an affirmed pair inside an unresolvable event is NOT invention', () => {
    // e3 is UNSPLITTABLE_NET_BATCH; the key says gateway:3 <-> ledger:3 matches.
    const r = scoreResolvability(KEY, snapshot([group('m', 'auto_confirmed', ['t-g3', 't-l3'])]));
    assert.equal(r.unresolvableRecall, 1);
    assert.deepEqual(r.inventedMatchesOnUnresolvable, []);
  });

  test('it FIRES on a pair the key denies that touches an unresolvable event', () => {
    // bank:3 belongs to e3; the key denies gateway:1 <-> bank:3.
    const r = scoreResolvability(KEY, snapshot([group('m', 'auto_confirmed', ['t-g1', 't-b3'])]));
    assert.equal(r.unresolvableRecall, 0);
    assert.deepEqual(r.inventedMatchesOnUnresolvable, ['e3']);
  });

  test('it FIRES on a pair the key does not mention at all', () => {
    // A cross-event pairing the key never contemplated is still an invention.
    const r = scoreResolvability(KEY, snapshot([group('m', 'auto_confirmed', ['t-b3', 't-l2'])]));
    assert.equal(r.unresolvableRecall, 0);
    assert.deepEqual(r.inventedMatchesOnUnresolvable, ['e3']);
  });

  test('a pending proposal does not trip the blocker — only a CONFIRMED claim does', () => {
    const r = scoreResolvability(KEY, snapshot([group('m', 'pending_review', ['t-g1', 't-b3'])]));
    assert.equal(r.unresolvableRecall, 1, 'asking a human is not inventing a match');
  });

  test('buildReport promotes a violated gate to a build blocker with the event named', () => {
    const r = buildReport(KEY, snapshot([group('m', 'auto_confirmed', ['t-g1', 't-b3'])]));
    assert.equal(r.buildBlockers.length, 1);
    assert.match(r.buildBlockers[0]!, /INVENTED a match/);
    assert.match(r.buildBlockers[0]!, /evt|e3/);
  });

  test('a clean run produces NO build blockers', () => {
    const r = buildReport(KEY, snapshot([group('m', 'auto_confirmed', ['t-g1', 't-b1', 't-l1'])]));
    assert.deepEqual(r.buildBlockers, []);
  });
});

describe('the S8 regression cells (§5.2)', () => {
  test('TIMING_DRIFT as a SECONDARY flag does not fire the cell', () => {
    // e2 carries TIMING_DRIFT as a secondary flag and its gateway↔ledger leg
    // legitimately matches. Reading the flags instead of `expectedCategory`
    // fired this blocker three times on a run where nothing was wrong.
    const r = scoreClassification(KEY, snapshot([group('m', 'auto_confirmed', ['t-g2', 't-l2'])]));
    assert.equal(r.s8RegressionCells.timingDriftAutoConfirmed, 0);
  });

  test('an AMOUNT_MISMATCH pair SCORED rather than decided fires its cell', () => {
    const r = scoreClassification(KEY, snapshot([group('m', 'pending_review', ['t-g2', 't-l2'])]));
    assert.equal(r.s8RegressionCells.amountMismatchScoredAsPendingMatch, 1);
  });
});

describe('the event-category choice (#50)', () => {
  // An event can raise several true categories. §5.2 names one, so one must be
  // chosen, and WHICH one is chosen must be a stated rule that does not consult
  // the answer key. These assert the rule is §8.2's precedence and that it
  // cannot be gamed.
  const batchEvent: AnswerKey = {
    ...KEY,
    events: KEY.events.map((e) => (e.eventId === 'e3'
      ? { ...e, expectedCategory: 'UNSPLITTABLE_BATCH' } : e)),
  };
  const exc = (id: string, category: string, tx: string, row: number, src: string) => ({
    exceptionId: id, category, secondaryFlags: [],
    primaryRecord: { transactionId: tx, sourceSystem: src, sourceRowNumber: row },
    evidence: {},
  });

  test('a higher-precedence category wins over a lower one on another row (§8.2)', () => {
    // The exact case §8.2 legislates: "Unsplittable batch before presence… its
    // member payments would each otherwise be reported as MISSING_IN_BANK,
    // turning one honest exception into five misleading ones."
    const r = scoreClassification(batchEvent, snapshot([], [
      exc('x1', 'MISSING_IN_BANK', 't-g3', 3, 'gateway'),
      exc('x2', 'UNSPLITTABLE_BATCH', 't-b3', 3, 'bank'),
    ]));
    assert.equal(r.confusionMatrix['UNSPLITTABLE_BATCH']?.['UNSPLITTABLE_BATCH'], 1,
      'the batch verdict must be the scored prediction, not the gateway presence one');
    assert.equal(r.multiCategoryEvents, 1);
  });

  test('the result does not depend on the order the rows are listed in', () => {
    // The property the old row-order rule only accidentally had.
    const reversed: AnswerKey = {
      ...batchEvent,
      events: batchEvent.events.map((e) => (e.eventId === 'e3'
        ? { ...e, projections: [...e.projections].reverse() } : e)),
    };
    const a = scoreClassification(batchEvent, snapshot([], [
      exc('x1', 'MISSING_IN_BANK', 't-g3', 3, 'gateway'),
      exc('x2', 'UNSPLITTABLE_BATCH', 't-b3', 3, 'bank'),
    ]));
    const b = scoreClassification(reversed, snapshot([], [
      exc('x1', 'MISSING_IN_BANK', 't-g3', 3, 'gateway'),
      exc('x2', 'UNSPLITTABLE_BATCH', 't-b3', 3, 'bank'),
    ]));
    assert.deepEqual(a.confusionMatrix, b.confusionMatrix);
  });

  test('the choice never consults the expected category', () => {
    // If it did, an engine that raised the right thing on ANY row would always
    // score a hit — unfalsifiable, and the flattering direction. Here the
    // engine's highest-precedence verdict is WRONG for the event and must be
    // scored as wrong even though a correct category sits on another row.
    const r = scoreClassification(batchEvent, snapshot([], [
      exc('x1', 'AMBIGUOUS_MATCH', 't-g3', 3, 'gateway'),
      exc('x2', 'UNSPLITTABLE_BATCH', 't-b3', 3, 'bank'),
    ]));
    assert.equal(r.confusionMatrix['UNSPLITTABLE_BATCH']?.['AMBIGUOUS_MATCH'], 1,
      'AMBIGUOUS_MATCH outranks UNSPLITTABLE_BATCH in §8.2, so it is the prediction');
    assert.equal(r.confusionMatrix['UNSPLITTABLE_BATCH']?.['UNSPLITTABLE_BATCH'], undefined);
  });

  test('multi-label catches the engine that raises everything everywhere', () => {
    // §5.2's stated purpose: "an engine that correctly declines to match but
    // files everything as MISSING_IN_BANK has a perfect match rate and a useless
    // exception list." Any-category recall alone would score that 1.0, so
    // per-category precision has to collapse — and it does.
    const all = ['DUPLICATE_RECORD', 'AMBIGUOUS_MATCH', 'UNSPLITTABLE_BATCH', 'AMOUNT_MISMATCH'];
    const r = scoreClassification(batchEvent, snapshot([], [
      ...all.map((c, i) => exc(`a${i}`, c, 't-b3', 3, 'bank')),
    ]));
    // Only one exception per row survives `raisedByRow`, so build the degenerate
    // case across the event's three rows instead.
    const spread = scoreClassification(batchEvent, snapshot([], [
      exc('a', 'AMBIGUOUS_MATCH', 't-g3', 3, 'gateway'),
      exc('b', 'UNSPLITTABLE_BATCH', 't-b3', 3, 'bank'),
      exc('c', 'AMOUNT_MISMATCH', 't-l3', 3, 'ledger'),
    ]));
    // 0.5, not 1: the key holds two exception events (e2 and e3) and only e3 is
    // given any exception here. The point is that e3 IS credited even though its
    // primary prediction was wrong.
    assert.equal(spread.multiLabel.anyCategoryRecall, 0.5,
      'e3 said the right thing somewhere; e2 said nothing at all');
    assert.equal(spread.multiLabel.perCategory['UNSPLITTABLE_BATCH']!.recall, 1,
      'the multi-label view credits the batch verdict the primary matrix discards');
    assert.ok(spread.multiLabel.perCategory['AMBIGUOUS_MATCH']!.precision < 1,
      'and saying three things about one event costs precision');
    void r;
  });
});

describe('scoreClassification', () => {
  test('an exception event the engine raised nothing for is NONE, not a wrong category', () => {
    const r = scoreClassification(KEY, snapshot([]));
    assert.equal(r.confusionMatrix['AMOUNT_MISMATCH']?.['NONE'], 1);
    assert.equal(r.perCategory['AMOUNT_MISMATCH']?.recall, 0);
  });

  test('the right category on any of the event\'s rows counts', () => {
    const r = scoreClassification(KEY, snapshot([], [{
      exceptionId: 'x', category: 'AMOUNT_MISMATCH', secondaryFlags: ['TIMING_DRIFT'],
      primaryRecord: { transactionId: 't-b2', sourceSystem: 'bank', sourceRowNumber: 2 },
      evidence: {},
    }]));
    assert.equal(r.perCategory['AMOUNT_MISMATCH']?.recall, 1);
    assert.equal(r.secondaryFlagJaccard, 1, 'flags agreed exactly');
  });

  test('secondary flags are set overlap, reported separately from the category', () => {
    const r = scoreClassification(KEY, snapshot([], [{
      exceptionId: 'x', category: 'AMOUNT_MISMATCH', secondaryFlags: [],
      primaryRecord: { transactionId: 't-b2', sourceSystem: 'bank', sourceRowNumber: 2 },
      evidence: {},
    }]));
    assert.equal(r.perCategory['AMOUNT_MISMATCH']?.recall, 1, 'the category is still right');
    assert.equal(r.secondaryFlagJaccard, 0, 'and the flags are still scored as missed');
  });
});

describe('the tier diagnostic (ADR-072)', () => {
  test('it compares PAIR counts and never reads matches.tier', () => {
    const snap = snapshot([group('m', 'auto_confirmed', ['t-g1', 't-b1', 't-l1'], 'fuzzy')]);
    const d = tierDiagnostic(KEY, snap);
    assert.deepEqual(d.engineTierPairs, { exact: 2, fuzzy: 1 },
      'straight from runs.metrics.tierAttribution');
    assert.deepEqual(d.keyViaTier, { exact: 3, fuzzy: 1, batch: 2 });
    assert.match(d.note, /DIAGNOSTIC, not an accuracy term/);
  });

  test('a tier disagreement changes no accuracy figure', () => {
    // The whole point of ADR-072: the group above is `fuzzy` while the key calls
    // two of its pairs `exact`, and precision/recall must not notice.
    const r = scoreMatching(KEY, snapshot([group('m', 'auto_confirmed', ['t-g1', 't-b1', 't-l1'], 'fuzzy')]));
    assert.equal(r.precision, 1);
    assert.equal(r.truePositives, 3);
  });
});

describe('scoreByDifficulty', () => {
  test('slices recall by the key\'s label and excludes EXCEPTION events', () => {
    const r = scoreByDifficulty(KEY, snapshot([group('m', 'auto_confirmed', ['t-g1', 't-b1', 't-l1'])]));
    assert.equal(r['EASY']?.pairs, 3);
    assert.equal(r['EASY']?.recall, 1);
    assert.equal(r['HARD']?.pairs, 0, 'e2 and e3 are EXCEPTION events, excluded per ADR-072');
  });
});

describe('assertSameDataset', () => {
  test('it accepts the same digests whatever the prefix or key order', () => {
    assert.doesNotThrow(() => assertSameDataset(
      { gateway: 'AA', bank: 'bb', ledger: 'cc' },
      { ledger: 'sha256:CC', gateway: 'sha256:aa', bank: 'sha256:BB' }));
  });

  test('it REFUSES rather than warns when the bytes differ', () => {
    assert.throws(
      () => assertSameDataset({ gateway: 'aa' }, { gateway: 'sha256:ff' }),
      /TRUTH_KEY_MISMATCH/);
  });

  test('it refuses an empty manifest rather than vacuously passing', () => {
    // `[] === []` would make an absent manifest look like agreement, which is
    // the one failure this check exists to make impossible.
    assert.throws(() => assertSameDataset({}, { gateway: 'sha256:aa' }), /TRUTH_KEY_MISMATCH/);
    assert.throws(() => assertSameDataset({ gateway: 'aa' }, {}), /TRUTH_KEY_MISMATCH/);
  });
});

describe('the report as a whole', () => {
  test('the ceiling is compared against the KEY\'s computed max, not against 100', () => {
    const r = buildReport(KEY, snapshot([]));
    assert.equal(r.ceiling.theoreticalMaxMatchRatePct, 93);
    assert.equal(r.ceiling.achievedPct, 60);
    assert.equal(r.ceiling.headroomPct, 33);
  });

  test('it is deterministic', () => {
    const snap = snapshot([group('m', 'auto_confirmed', ['t-g1', 't-b1', 't-l1'])]);
    assert.deepEqual(buildReport(KEY, snap), buildReport(KEY, snap));
  });
});
