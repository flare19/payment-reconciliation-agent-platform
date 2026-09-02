import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runMatchingPipeline } from '../../src/services/run/orchestrator.js';
import { matchedRecordIds } from '../../src/services/metrics/run-metrics.js';
import { ingestSources } from '../../src/services/ingestion/index.js';
import { dedupe } from '../../src/services/matching/dedupe.js';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import { readFileSync } from 'node:fs';
import type { RunConfig, ActiveAlias } from '../../src/types/engine.js';

/**
 * THE COLD PASS IS AN INSTRUMENT, AND AN INSTRUMENT NOBODY HAS CHECKED AGAINST
 * A KNOWN-GOOD CASE IS NOT EVIDENCE (ADR-132, and the lesson of ADR-127).
 *
 * `coldStart.matchRatePct` is published on the dashboard as the engine's own
 * unaided rate. If the second pass silently saw different inputs from the
 * first, it would produce a plausible number that is simply wrong — the worst
 * available failure for this project. So the property asserted here is the one
 * that makes the two passes comparable at all: **with the same alias set they
 * must produce the identical matched set.**
 */

const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
const read = (f: string) => readFileSync(FIX + f, 'utf8');
const noTime = <T>(_n: string, f: () => T): T => f();

function setup() {
  const ingested = ingestSources({
    runId: 'cold-pass-probe',
    files: {
      gateway: read('gateway_export.csv'),
      bank: read('bank_settlement.csv'),
      ledger: read('merchant_ledger.csv'),
    },
  });
  const deduped = dedupe(ingested.transactions);
  const config: RunConfig = {
    ...ENGINE_DEFAULTS,
    referenceDate: ingested.referenceDate!,
    aliasCountAtStart: 0,
  } as RunConfig;
  return { pool: deduped.pool, config };
}

describe('the cold counterfactual is the same machine (ADR-132)', () => {
  test('TWO PASSES WITH THE SAME ALIAS SET PRODUCE THE IDENTICAL MATCHED SET', () => {
    const { pool, config } = setup();
    const a = runMatchingPipeline(pool, config, [], noTime);
    const b = runMatchingPipeline(pool, config, [], noTime);
    assert.deepEqual(
      [...matchedRecordIds(a.assembled.matches)].sort(),
      [...matchedRecordIds(b.assembled.matches)].sort(),
      'the second pass sees different inputs from the first — every cold figure is fiction');
  });

  test('the pipeline does not mutate the pool it is handed', () => {
    // The property the whole design rests on: `runTier15` copies records rather
    // than writing `counterpartyKey` in place. If it mutated, the cold pass
    // would inherit the warm pass's alias-resolved keys and report the WARM
    // rate under the cold label — the exact defect ADR-130 fixed, reintroduced
    // by the fix for it.
    const { pool, config } = setup();
    const before = pool.map((t) => `${t.id}:${t.counterpartyKey ?? ''}`).join('|');
    runMatchingPipeline(pool, config, [], noTime);
    assert.equal(pool.map((t) => `${t.id}:${t.counterpartyKey ?? ''}`).join('|'), before);
  });

  test('an alias can only ADD matched records, never remove them', () => {
    // Not a law of the engine — assignment is greedy and global, so in
    // principle a warm pass could lose a pair to a better competitor. It is
    // asserted on the shipped dataset because the cold/warm claim reads as a
    // floor, and a violation would mean the pairing must be stated differently.
    const { pool, config } = setup();
    const alias: ActiveAlias = {
      id: 'a1', aliasType: 'counterparty_name', scopeSource: 'any',
      normalizedValue: 'API HOLDINGS', canonicalValue: 'THREPSI SOLUTIONS',
    } as ActiveAlias;
    const cold = matchedRecordIds(runMatchingPipeline(pool, config, [], noTime).assembled.matches);
    const warm = matchedRecordIds(
      runMatchingPipeline(pool, config, [alias], noTime).assembled.matches);
    assert.ok(warm.size >= cold.size, `warm ${warm.size} < cold ${cold.size}`);
    for (const id of cold) assert.ok(warm.has(id), `alias LOST a cold match: ${id}`);
  });
});
