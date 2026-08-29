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
import {
  runTier2, generateCandidates, pairKeyOf, NEAR_MISS_FLOOR,
} from '../../src/services/matching/tier2-fuzzy.js';
import {
  assembleGroups, fromTier1, fromTier2, type GroupPair,
} from '../../src/services/matching/group-assembly.js';
import {
  runClassification, buildClassificationInput, matchedPairsOf, candidateEvidenceOf,
  type PipelineOutput,
} from '../../src/services/classification/collect.js';

// ─────────────────────────────────────────────────────────────────────────────
// The adapter, in isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('matchedPairsOf', () => {
  const group = (ids: string[]): ProposedMatch => ({
    tier: 'exact', status: 'auto_confirmed', confidence: 1, ruleId: 'R',
    cardinality: 'one_to_one',
    members: ids.map((id, i) => ({
      transactionId: id, role: (['gateway', 'bank', 'ledger'] as const)[i]!, isAnchor: i === 0,
    })),
    amountDeltaPaise: 0, dateDeltaDays: 0, aliasIds: [], scoreBreakdown: null,
  });

  test('a 3-way group yields all three internal pairs, including the implied bank↔ledger leg', () => {
    // No tier proposes bank↔ledger directly — it is implied by both legs meeting
    // at the gateway. Omitting it would make each of those records look like it
    // was missing a counterpart it demonstrably has.
    const pairs = matchedPairsOf([group(['g', 'b', 'l'])]);
    assert.equal(pairs.length, 3);
    const flat = pairs.map((p) => [p.aId, p.bId].sort().join('-')).sort();
    assert.deepEqual(flat, ['b-g', 'b-l', 'g-l']);
  });

  test('a 2-way group yields exactly one pair', () => {
    assert.equal(matchedPairsOf([group(['g', 'b'])]).length, 1);
  });

  test('a pending_review group still counts as PRESENCE', () => {
    // ADR-040 says a proposal is not a reconciliation — that governs the match
    // RATE. It does not make the counterpart absent, and reporting
    // MISSING_IN_BANK for a record whose bank leg sits in the review queue
    // would be false.
    const proposal = { ...group(['g', 'b']), status: 'pending_review' as const };
    assert.equal(matchedPairsOf([proposal]).length, 1);
  });

  test('a refused pair is absent, because it is absent from the groups', () => {
    // Derived from S11 output rather than from the tier outputs: reading the
    // tiers would reinstate exactly the pairs S11 declined.
    assert.deepEqual(matchedPairsOf([]), []);
  });
});

describe('candidateEvidenceOf', () => {
  test('consideredCount and the logged list are DIFFERENT numbers (§11)', () => {
    const m = candidateEvidenceOf([{
      transactionId: 't1', generated: 90, consideredCount: 90, candidateCapHit: false,
      nearMisses: [{
        transactionId: 'x', sourceSystem: 'bank', score: 0.5,
        breakdown: { anchor: 0, amount: 0.35, date: 0.15, counterparty: 0, total: 0.5, amountUnavailable: false },
        ruleId: 'FUZZY_NO_ANCHOR_V1', rejectedBecause: null,
      }],
    }]);
    const e = m.get('t1')!;
    assert.equal(e.consideredCount, 90, 'the true count of what was scored');
    assert.equal(e.candidates.length, 1, 'the logged near-miss subset');
    assert.notEqual(e.consideredCount, e.candidates.length,
      'reporting the list length would say the engine tried 1 when it tried 90');
  });

  test('displacedByMatchId is null — match ids do not exist until persistence', () => {
    const m = candidateEvidenceOf([
      { transactionId: 't1', generated: 0, consideredCount: 0, candidateCapHit: false, nearMisses: [] },
    ]);
    assert.equal(m.get('t1')!.displacedByMatchId, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole chain, S1 → S12, against the holdout
// ─────────────────────────────────────────────────────────────────────────────

describe('S12 over the full pipeline (holdout)', () => {
  const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
  const ing = ingestSources({
    runId: 'r',
    files: {
      gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
      bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
      ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
    },
  });
  const config: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: ing.referenceDate!, aliasCountAtStart: 0 };

  function pipeline(): PipelineOutput {
    const d = dedupe(ing.transactions);
    const blocks = buildBlockIndexes(d.pool);
    const t1 = runTier1(blocks, config);
    const t15 = runTier15(d.pool, config, [], new Set(t1.matches.flatMap((m) => [m.aId, m.bId])));
    rebuildCounterpartyIndex(blocks, t15.pool);
    const exact = [...t1.matches, ...t15.matches];
    const identity = resolveIdentities(t15.pool, config);
    const settled = new Set<string>();
    for (const { pair, verdict } of identity) {
      if (verdict.kind !== 'not_established') settled.add(pairKeyOf(pair[0].id, pair[1].id));
    }
    const tier2 = runTier2(blocks, config, exact, settled);
    const byId = new Map<string, NormalizedTransaction>(t15.pool.map((t) => [t.id, t]));
    const g = assembleGroups([
      ...exact.map((m) => fromTier1(m, byId)).filter((p): p is GroupPair => p !== null),
      ...tier2.accepted.map(fromTier2),
    ]);
    return {
      pool: t15.pool, duplicates: d.findings, identity, tier2,
      batches: [], groups: g.matches, refused: g.refused, config,
      blocks,
    } as PipelineOutput & { blocks: ReturnType<typeof buildBlockIndexes> };
  }

  const out = pipeline();
  const exceptions = runClassification(out);

  test('every exception has exactly one primary category, one row each', () => {
    const ids = exceptions.map((e) => e.transactionId);
    assert.equal(new Set(ids).size, ids.length, 'no record may carry two primaries');
  });

  test('no record is both matched and reported missing', () => {
    // The failure this whole adapter exists to prevent: a pair dropped on the way
    // to the classifier fabricates a MISSING_IN_* for a match the engine made.
    const matched = new Set(out.groups.flatMap((g) => g.members.map((m) => m.transactionId)));
    for (const e of exceptions) {
      if (!e.category.startsWith('MISSING_IN_')) continue;
      const inGroup = matched.has(e.transactionId);
      if (!inGroup) continue;
      // Being in a group is fine — the record may still miss a THIRD leg. What
      // must never happen is claiming the leg it actually has is absent.
      const group = out.groups.find((g) => g.members.some((m) => m.transactionId === e.transactionId))!;
      const roles = new Set(group.members.map((m) => m.role));
      const missing = e.category.replace('MISSING_IN_', '').toLowerCase();
      assert.ok(!roles.has(missing as 'gateway' | 'bank' | 'ledger'),
        `${e.transactionId} is reported ${e.category} while its group holds a ${missing} member`);
    }
  });

  test('an exception may only report finding nothing if the engine actually looked (#40)', () => {
    // The honesty criterion, and the half of issue #40 that reached a reader.
    // 193 MISSING_IN_BANK exceptions used to report `candidatesConsidered: 0`
    // and serialise as resolvability "needs_external_data" — "the counterpart
    // may exist outside these three files" — for gateway records whose bank
    // counterpart was sitting in the file, unlooked-at, because Tier 2 had
    // dropped the record from its pool.
    //
    // A zero here is a claim about the world, so it has to be earned: it is only
    // honest when blocking genuinely offered no counterpart in that source.
    const byId = new Map(out.pool.map((t) => [t.id, t]));
    // Every record Tier 2 actually searched has a stats entry; a record dropped
    // from the pool has none. That is the crisp form of "did the engine look?".
    const searched = new Set(out.tier2.candidateStats.map((s) => s.transactionId));

    const neverSearched: string[] = [];
    const liars: string[] = [];
    let examined = 0;

    for (const e of exceptions) {
      if (!e.category.startsWith('MISSING_IN_')) continue;
      const record = byId.get(e.transactionId);
      if (record === undefined || record.statusNorm !== 'reconcilable') continue;
      if (record.duplicateOfTransactionId !== null) continue;
      examined += 1;

      const where = `${record.sourceSystem}:${record.sourceRowNumber}`;
      if (!searched.has(record.id)) {
        neverSearched.push(`${where} reports ${e.category} but never entered Tier 2`);
        continue;
      }
      if ((e.evidence.candidatesConsidered ?? 0) > 0) continue;

      // Considered nothing. Honest only if blocking offered nothing either.
      const missing = e.category.replace('MISSING_IN_', '').toLowerCase();
      const offered = generateCandidates(record, out.blocks, config)
        .filter((c) => c.sourceSystem === missing);
      if (offered.length > 0) {
        liars.push(
          `${where} reports ${e.category} having considered 0 candidates, but ` +
          `blocking offered ${offered.length} ${missing} counterpart(s)`);
      }
    }

    // Non-vacuous by construction: if this ever reaches 0 the assertions below
    // stop meaning anything, and the test would pass by examining nothing.
    assert.equal(examined, 207, 'every reconcilable MISSING_IN_* primary, counted');
    assert.deepEqual(neverSearched, [],
      'a record reported missing a counterpart that Tier 2 was never allowed to ' +
      'search for — this is issue #40, and it fabricates 200 such exceptions');
    assert.deepEqual(liars, [],
      'an exception claiming the engine found nothing, on a record it never searched');
  });

  test('candidatesConsidered exceeds the logged list wherever a floor was applied (§11)', () => {
    // The property matching-engine.md §11 states in as many words: "a true count
    // rather than the length of the logged list".
    const informative = exceptions.filter(
      (e) => e.evidence.candidatesConsidered > e.evidence.candidates.length);
    assert.ok(informative.length > 0,
      'if these were always equal, the true-count requirement is not implemented');
  });

  test('no accepted match is listed as a rejected candidate on its own record', () => {
    // A matched pair rendered as "scored 1.0000, below the review threshold" is
    // false twice over, and it appears on the record's own successful match.
    const acceptedPairs = new Set(
      out.tier2.accepted.flatMap((p) => [`${p.a.id}|${p.b.id}`, `${p.b.id}|${p.a.id}`]));
    for (const e of exceptions) {
      for (const c of e.evidence.candidates) {
        assert.ok(!acceptedPairs.has(`${e.transactionId}|${c.transactionId}`),
          `${e.transactionId} lists its own accepted match ${c.transactionId} as rejected`);
      }
    }
  });

  test('every logged candidate is at or above the near-miss floor', () => {
    for (const e of exceptions) {
      for (const c of e.evidence.candidates) {
        assert.ok(c.score >= NEAR_MISS_FLOOR,
          `logged a ${c.score} candidate below the ${NEAR_MISS_FLOOR} floor (schema.md §9.1)`);
      }
    }
  });

  test('every exception names the rule that made it, and carries a severity basis', () => {
    // ADR-044: severity is COMPUTED, so the basis has to travel with it or the
    // number is an assertion rather than a derivation.
    for (const e of exceptions) {
      assert.match(e.detectedByRule, /^[A-Z0-9_]+_V\d+$/,
        `${e.transactionId} rule: ${e.detectedByRule}`);
      assert.ok(e.ruleVersion.length > 0);
      assert.ok(['low', 'medium', 'high'].includes(e.severity));
      assert.ok(e.evidence.severityBasis !== undefined,
        `${e.transactionId} has a severity with no stated basis`);
    }
  });

  test('the classifier output is canonically ordered and deterministic', () => {
    const again = runClassification(pipeline());
    assert.deepEqual(
      exceptions.map((e) => [e.transactionId, e.category, e.severity]),
      again.map((e) => [e.transactionId, e.category, e.severity]),
    );
  });

  test('the exception population is at its known level, by category', () => {
    // Pinned exactly, not floored. S10 is deliberately NOT wired here (batches:
    // []), so the 12 UNSPLITTABLE_BATCH legs currently land in the presence
    // categories; U6 wires it and these numbers move. Any OTHER movement is a
    // regression and should fail this test.
    //
    // The presence categories fell by 299 when issue #40 was fixed, and that is
    // the whole point of the fix: 193 of the old MISSING_IN_BANK entries sat on
    // gateway records Tier 1 had already matched, each reporting
    // `candidatesConsidered: 0` because the record had been removed from the
    // Tier 2 pool before anything could look for its bank leg. They were not
    // findings; they were the engine failing to search and saying it had.
    // AMBIGUOUS_MATCH rose 20 -> 22 from the S9 guard seeing more of the pool.
    const byCategory: Record<string, number> = {};
    for (const e of exceptions) byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    assert.deepEqual(byCategory, {
      MISSING_IN_GATEWAY: 90,
      MISSING_IN_BANK: 54,
      MISSING_IN_LEDGER: 63,
      AMBIGUOUS_MATCH: 22,
      AMOUNT_MISMATCH: 18,
      DUPLICATE_RECORD: 9,
    });
    assert.equal(exceptions.length, 256);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 rule 3 — a refused pair becomes an AMBIGUOUS_MATCH naming its displacer
// ─────────────────────────────────────────────────────────────────────────────

describe('group refusals reach the classifier (§10 rule 3)', () => {
  const txn = (id: string, source: 'gateway' | 'bank' | 'ledger', row: number): NormalizedTransaction => ({
    id, runId: 'r', sourceSystem: source, sourceFile: 'f.csv', sourceRowNumber: row,
    externalId: id, referenceIds: {}, anchorStrength: 'none',
    amountPaise: 100_000, feePaise: null, taxPaise: null, netAmountPaise: 100_000,
    currency: 'INR', direction: 'credit', txnDate: '2026-08-14', txnTimestamp: null,
    postingDate: null, counterpartyRaw: null, counterpartyNorm: 'ACME', counterpartyKey: null,
    method: 'card', statusRaw: 'captured', statusNorm: 'reconcilable', txnType: null,
    descriptionRaw: null, duplicateOfTransactionId: null, duplicateKind: null,
    ingestWarnings: [], rawPayload: {},
  });

  test('the displaced record gets AMBIGUOUS_MATCH naming what took its slot', () => {
    const g = txn('g', 'gateway', 1);
    const b1 = txn('b1', 'bank', 1);
    const b2 = txn('b2', 'bank', 2);
    const pair = (a: NormalizedTransaction, b: NormalizedTransaction, conf: number): GroupPair => ({
      a, b, tier: 'fuzzy', status: 'auto_confirmed', confidence: conf, ruleId: 'FUZZY_V1',
      amountDeltaPaise: 0, dateDeltaDays: 0, aliasIds: [], scoreBreakdown: null,
    });
    const assembled = assembleGroups([pair(g, b1, 0.99), pair(g, b2, 0.9)]);
    assert.equal(assembled.refused.length, 1, 'precondition: S11 refused the weaker pair');

    const input = buildClassificationInput({
      pool: [g, b1, b2], duplicates: [], identity: [],
      tier2: {
        accepted: [], displaced: [], ambiguous: [], belowThresholdCount: 0,
        candidateStats: [], pairsScored: 0, pairsDiscarded: 0,
      },
      batches: [], groups: assembled.matches, refused: assembled.refused,
      config: { ...ENGINE_DEFAULTS, referenceDate: '2026-08-31', aliasCountAtStart: 0 },
    });
    assert.equal(input.groupRefusals?.length, 1, 'refusals must reach the classifier at all');

    const out = runClassification({
      pool: [g, b1, b2], duplicates: [], identity: [],
      tier2: {
        accepted: [], displaced: [], ambiguous: [], belowThresholdCount: 0,
        candidateStats: [], pairsScored: 0, pairsDiscarded: 0,
      },
      batches: [], groups: assembled.matches, refused: assembled.refused,
      config: { ...ENGINE_DEFAULTS, referenceDate: '2026-08-31', aliasCountAtStart: 0 },
    });
    const displaced = out.find((e) => e.transactionId === 'b2');
    assert.ok(displaced, 'the displaced record must be classified, not silently dropped');
    assert.equal(displaced!.category, 'AMBIGUOUS_MATCH');
    assert.equal(displaced!.detectedByRule, 'CLASSIFY_GROUP_ROLE_CONFLICT_V1');
    assert.deepEqual(displaced!.relatedTransactionIds, ['b1'], 'must name its displacer');
    assert.equal(displaced!.bestCandidateScore, 0.9, 'the refused pair\'s own confidence');
  });
});
