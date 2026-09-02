import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SEED, DEMO_SEED, HOLDOUT_SEED, SEED_DATASETS, UnknownDatasetError,
  availableSeeds, findSeedDataset, readSeedDataset,
} from '../../src/config/datasets.js';

/**
 * THE MISSING TEST IN ALL THREE INSTANCES OF THIS DEFECT WAS THE SAME ONE:
 * ASSERT THE FIELD CHANGES SOMETHING.
 *
 * `AGENT_MAX_COST_USD_PER_RUN` (ADR-094), `STALE_RUN_TIMEOUT_MINUTES`
 * (ADR-097) and `datasetSeed` (ADR-103) were each parsed, persisted,
 * documented and published — and enforced nowhere. Every one of them had tests
 * proving it was READ correctly. None had a test proving it had an EFFECT.
 *
 * So the load-bearing assertion in this file is not that a seed resolves. It is
 * that two seeds produce different bytes.
 */

describe('the seed dataset registry', () => {
  test('TWO SEEDS PRODUCE DIFFERENT BYTES — the assertion ADR-103 was missing', () => {
    const holdout = readSeedDataset(HOLDOUT_SEED);
    const demo = readSeedDataset(DEMO_SEED);

    for (const source of ['gateway', 'bank', 'ledger'] as const) {
      assert.notEqual(holdout[source], demo[source],
        `${source} is byte-identical across two seeds — datasetSeed is inert again`);
    }
  });

  test('every registered dataset loads three non-empty, correctly-headed CSVs', () => {
    const header = {
      gateway: 'payment_id', bank: 'bank_ref_no', ledger: 'entry_id',
    } as const;

    for (const { seed, label } of SEED_DATASETS) {
      const sources = readSeedDataset(seed);
      for (const source of ['gateway', 'bank', 'ledger'] as const) {
        const text = sources[source];
        assert.ok(text.length > 0, `${label}/${source} is empty`);
        assert.ok(text.split('\n').length > 2, `${label}/${source} has no data rows`);
        assert.ok(text.split('\n')[0]?.includes(header[source]),
          `${label}/${source} does not look like a ${source} export`);
      }
    }
  });

  test('no datasetSeed means the holdout, explicitly and not by accident', () => {
    assert.equal(DEFAULT_SEED, HOLDOUT_SEED);
    assert.deepEqual(readSeedDataset(null), readSeedDataset(HOLDOUT_SEED));
  });

  test('an unregistered seed throws rather than falling back to the holdout', () => {
    // Silently substituting the default is precisely the old behaviour: the run
    // would be LABELLED 12345 and would RECONCILE 90210.
    assert.throws(() => readSeedDataset(12_345), UnknownDatasetError);
    assert.throws(() => readSeedDataset(0), UnknownDatasetError);
    assert.throws(() => readSeedDataset(-1), UnknownDatasetError);
  });

  test('DEV_SEED is deliberately NOT offerable', () => {
    // `data/fixtures/dev/` is gitignored, so it does not exist in a deployed
    // environment. A seed that works only on a developer's laptop is worse than
    // one that is not offered (ADR-117).
    assert.equal(findSeedDataset(1_337), undefined);
    assert.throws(() => readSeedDataset(1_337), UnknownDatasetError);
  });

  test('the registry has no duplicate seeds or labels', () => {
    assert.equal(new Set(SEED_DATASETS.map((d) => d.seed)).size, SEED_DATASETS.length);
    assert.equal(new Set(SEED_DATASETS.map((d) => d.label)).size, SEED_DATASETS.length);
    assert.deepEqual(availableSeeds(), SEED_DATASETS.map((d) => d.seed));
  });

  test('at least two datasets are offerable, or the dashboard compares a run with itself', () => {
    assert.ok(SEED_DATASETS.length >= 2);
  });
});
