import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { generate } from './index.js';
import { SOURCE_COLUMNS } from './projection.js';

/**
 * SEEDS: develop against DEV_SEED (ADR-027, CLAUDE.md §9.3, validation-strategy §7).
 * HOLDOUT_SEED appears exactly once below, in a smoke test that asserts the seed
 * runs and records itself — never what the dataset contains.
 */
const SEED = 1_337;          // DEV_SEED
const HOLDOUT_SEED = 90_210; // reported numbers only; looked at once, when reporting

/**
 * END TO END. Everything else in this package tests one stage; this is the only
 * place that runs the whole pipeline — planning, planting, projection, the §4
 * proofs with regeneration, invariant checking, CSV emission and the answer key —
 * exactly the way `npm run generate` will.
 */

describe('generate — the full pipeline', () => {
  test('DEV_SEED (1337) produces a complete, internally consistent dataset', () => {
    const { files, answerKey } = generate({ seed: SEED });

    for (const [source, text] of [['gateway', files.gateway], ['bank', files.bank], ['ledger', files.ledger]] as const) {
      const records: string[][] = parse(text, { columns: false });
      assert.deepEqual(records[0], SOURCE_COLUMNS[source]);
      assert.ok(records.length > 1, `${source} has no data rows`);
    }

    assert.equal(answerKey.manifest.seed, SEED);
    assert.equal(answerKey.manifest.eventCount, 300);
    assert.equal(answerKey.events.length, 300);
  });

  test('THE ONE HOLDOUT TOUCH: the shipped seed generates — and nothing about what it contains', () => {
    // ADR-027 reserves HOLDOUT_SEED for the reported numbers, to be looked at once
    // when reporting. This asserts only that the seed the demo ships from runs to
    // completion and records itself; every property of the DATA is asserted at
    // DEV_SEED and at arbitrary seeds, so no test here can be turned green by
    // inspecting holdout output.
    const { answerKey } = generate({ seed: HOLDOUT_SEED });
    assert.equal(answerKey.manifest.seed, HOLDOUT_SEED);
  });

  test('is deterministic: the same seed run twice is byte-identical, files and key', () => {
    const a = generate({ seed: SEED });
    const b = generate({ seed: SEED });
    assert.equal(a.files.gateway, b.files.gateway);
    assert.equal(a.files.bank, b.files.bank);
    assert.equal(a.files.ledger, b.files.ledger);
    assert.equal(a.answerKeyJson, b.answerKeyJson);
  });

  test('A REAL CONSTRAINT, surfaced rather than papered over: 60 events is too few for IDENTITY_DESTROYED', () => {
    // testing-strategy §2 plans a 60-event DEV_SEED snapshot. At 60 events, §3's
    // 2.8% IDENTITY_DESTROYED share is 1.68 events — allocateScenarios' largest
    // remainder rounds that to 1 or 2, and plantIdentityClusters correctly
    // throws rather than emit a cluster too small to carry §4's claim (issue
    // MIN_AMBIGUOUS_CLUSTER = 3). This is the generator refusing to weaken an
    // unresolvability guarantee, not a bug — but it means the 60-event snapshot
    // needs EITHER a larger count or a config with IDENTITY_DESTROYED's weight
    // raised, decided when that snapshot is actually built (testing-strategy §2
    // is a later step, not this unit's).
    assert.throws(() => generate({ seed: SEED, eventPlan: { count: 60 } }),
      /cannot form a cluster of 3/);
  });

  test('a smaller run DOES complete cleanly once the count clears that floor', () => {
    // 150 events keeps every scenario's realized share comfortably above the
    // cluster-size floor while still being far smaller than the 300-event default.
    const { answerKey } = generate({ seed: SEED, eventPlan: { count: 150 } });
    assert.equal(answerKey.manifest.eventCount, 150);
  });
});

describe('the ~93% ceiling is computed, not asserted', () => {
  test('unresolvableEventCount and the ceiling agree with the realized distribution', () => {
    const { answerKey } = generate({ seed: SEED });
    const unresolvable = answerKey.events.filter((e) => e.resolvability === 'UNRESOLVABLE').length;
    assert.equal(unresolvable, answerKey.manifest.unresolvableEventCount);
    const expectedCeiling = Math.round((1 - unresolvable / answerKey.manifest.eventCount) * 1000) / 10;
    assert.equal(answerKey.manifest.theoreticalMaxMatchRatePct, expectedCeiling);
    assert.ok(answerKey.manifest.theoreticalMaxMatchRatePct > 85 && answerKey.manifest.theoreticalMaxMatchRatePct < 96,
      `ceiling ${answerKey.manifest.theoreticalMaxMatchRatePct}% is nowhere near the ~93% §4 targets`);
  });
});

describe('the answer key references only file positions, never engine ids', () => {
  test('no UUID shape anywhere in the serialized key', () => {
    const { answerKeyJson } = generate({ seed: SEED });
    assert.doesNotMatch(answerKeyJson, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe('file hashes in the manifest match the actual emitted bytes', () => {
  test('sha256 of each file equals the manifest entry', async () => {
    const { createHash } = await import('node:crypto');
    const { files, answerKey } = generate({ seed: SEED });
    for (const source of ['gateway', 'bank', 'ledger'] as const) {
      const expected = `sha256:${createHash('sha256').update(files[source], 'utf8').digest('hex')}`;
      assert.equal(answerKey.manifest.fileHashes[source], expected);
    }
  });
});

describe('regeneration actually exercises the proofs, not just the happy path', () => {
  test('an absurdly small maxProofAttempts still succeeds at a reasonable population (attempt 0 usually proves)', () => {
    // Not a test that regeneration fires (that would depend on the seed's luck),
    // but a test that the whole proof-and-splice path is wired correctly: even
    // with almost no retry budget, a normal run must not throw.
    assert.doesNotThrow(() => generate({ seed: SEED, maxProofAttempts: 1 }));
  });

  test('zero attempts is refused before any work happens', () => {
    assert.throws(() => generate({ seed: SEED, maxProofAttempts: 0 }), /attempts must be >= 1/);
  });
});

describe('seededVariants controls alias cold/warm status', () => {
  test('an empty set (default) marks every alias entry cold', () => {
    const { answerKey } = generate({ seed: SEED });
    assert.ok(answerKey.aliasKey.length > 0, 'expected at least one alias entry in a 300-event run');
    assert.ok(answerKey.aliasKey.every((a) => a.seededForEngine === false));
  });

  test('seeding every variant of one merchant marks it warm', () => {
    const cold = generate({ seed: SEED });
    const merchant = cold.answerKey.aliasKey[0]!;
    const { answerKey } = generate({ seed: SEED, seededVariants: new Set(merchant.variants) });
    const same = answerKey.aliasKey.find((a) => a.canonical === merchant.canonical)!;
    assert.equal(same.seededForEngine, true);
  });
});

describe('multiple seeds in the same process do not cross-contaminate sequence ids', () => {
  test('two different seeds run back to back both stay internally consistent', () => {
    const first = generate({ seed: 1 });
    const second = generate({ seed: 2 });
    // Each call resets its own sequence counters, so re-running the FIRST seed
    // again afterwards must reproduce the original bytes exactly.
    const firstAgain = generate({ seed: 1 });
    assert.equal(first.answerKeyJson, firstAgain.answerKeyJson);
    assert.notEqual(first.answerKeyJson, second.answerKeyJson);
  });
});
