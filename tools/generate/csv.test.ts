import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { Rng } from './prng.js';
import { planEvents, DEFAULT_EVENT_PLAN } from './events.js';
import { plantIdentityClusters } from './planting.js';
import { projectEvent, projectUnsplittableEvent, projectNoise, resetSequentialIds } from './project.js';
import { serializeToCsv } from './csv.js';
import { SOURCE_COLUMNS, type ProjectedRow, type ProjectionResult } from './projection.js';
import { ENGINE_DEFAULTS } from '../../apps/api/src/config/defaults.js';
import type { RunConfig } from '../../apps/api/src/types/engine.js';

/**
 * SEEDS: develop against DEV_SEED (ADR-027, CLAUDE.md §9.3, validation-strategy §7).
 *
 * HOLDOUT_SEED (90210) is for the reported numbers and is to be looked at ONCE,
 * when reporting. A test suite pinned to it looks at it on every run, and every
 * fix made to turn one of those tests green is a change made by inspecting
 * holdout output — which is exactly the tuning ADR-027 forbids, arriving through
 * the test suite instead of through the engine. Property sweeps use arbitrary
 * non-reserved seeds; the single holdout smoke test lives in index.test.ts and
 * asserts only that the shipped seed generates, never what it contains.
 */
const SEED = 1_337;  // DEV_SEED

const CONFIG: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-20', aliasCountAtStart: 0 };

function buildResult(seed: number): ProjectionResult {
  resetSequentialIds();
  const rng = new Rng(seed);
  const { events: planned } = planEvents(rng, DEFAULT_EVENT_PLAN);
  const { events } = plantIdentityClusters(rng, planned);
  const eventProjections = events.map((event) => ({
    event,
    rows: event.scenario === 'UNSPLITTABLE_NET_BATCH'
      ? projectUnsplittableEvent(rng, event, CONFIG).rows
      : projectEvent(rng, event, CONFIG),
  }));
  const noise = projectNoise(rng, DEFAULT_EVENT_PLAN.windowEndDate, DEFAULT_EVENT_PLAN.windowDays, 25, 12);
  return { events: eventProjections, noise: { rows: noise } };
}

const totalRows = (result: ProjectionResult): number =>
  result.events.reduce((n, p) => n + p.rows.length, 0) + result.noise.rows.length;

describe('serializeToCsv', () => {
  test('every emitted row is a genuine CSV that parses back to the right column count', () => {
    const rng = new Rng(SEED);
    const result = buildResult(SEED);
    const { gateway, bank, ledger } = serializeToCsv(rng, result);

    for (const [source, text] of [['gateway', gateway], ['bank', bank], ['ledger', ledger]] as const) {
      const records: string[][] = parse(text, { columns: false });
      assert.deepEqual(records[0], SOURCE_COLUMNS[source], `${source} header mismatch`);
      for (const record of records.slice(1)) {
        assert.equal(record.length, SOURCE_COLUMNS[source].length, `${source} row has the wrong column count`);
      }
    }
  });

  test('row numbering starts at 1 and is dense — header occupies row 0', () => {
    const rng = new Rng(SEED);
    const { emitted } = serializeToCsv(rng, buildResult(SEED));
    for (const source of ['gateway', 'bank', 'ledger'] as const) {
      const numbers = emitted.filter((e) => e.row.sourceSystem === source)
        .map((e) => e.sourceRowNumber).sort((a, b) => a - b);
      assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1));
    }
  });

  test('every projected row (events + noise) is emitted exactly once', () => {
    const rng = new Rng(SEED);
    const result = buildResult(SEED);
    const { emitted } = serializeToCsv(rng, result);
    assert.equal(emitted.length, totalRows(result));
  });

  test('a blanked column is emitted as an empty CSV field', () => {
    const rng = new Rng(SEED);
    const result = buildResult(SEED);
    // Find a gateway row that blanked 'fee' and confirm the CSV field is empty.
    const blanked = result.events.flatMap((p) => p.rows)
      .find((r): r is Extract<ProjectedRow, { sourceSystem: 'gateway' }> =>
        r.sourceSystem === 'gateway' && r.blankedColumns.includes('fee'));
    assert.ok(blanked, 'expected at least one gateway row with a blanked fee in this dataset');

    const { gateway, emitted } = serializeToCsv(rng, result);
    const sourceRowNumber = emitted.find((e) => e.row === blanked)!.sourceRowNumber;
    const records: Record<string, string>[] = parse(gateway, { columns: true });
    assert.equal(records[sourceRowNumber - 1]!['fee'], '');
  });

  test('a value containing a comma is quoted, and parses back exactly', () => {
    const rng = new Rng(SEED);
    const result = buildResult(SEED);
    // Descriptions never contain commas in this generator, but merchant/customer
    // names can via free text in principle — force one to prove the quoting path.
    const first = result.events[0]!.rows.find((r) => r.sourceSystem === 'gateway');
    if (first && first.sourceSystem === 'gateway') first.merchantName = 'AMAZON, RETAIL "PRIME"';
    const { gateway, emitted } = serializeToCsv(rng, result);
    const rowNum = emitted.find((e) => e.row === first)!.sourceRowNumber;
    const records: Record<string, string>[] = parse(gateway, { columns: true });
    assert.equal(records[rowNum - 1]!['merchant_name'], 'AMAZON, RETAIL "PRIME"');
  });

  test('determinism: the same seed produces byte-identical files', () => {
    const a = serializeToCsv(new Rng(SEED), buildResult(SEED));
    const b = serializeToCsv(new Rng(SEED), buildResult(SEED));
    assert.equal(a.gateway, b.gateway);
    assert.equal(a.bank, b.bank);
    assert.equal(a.ledger, b.ledger);
  });

  test('row order is NOT event-generation order — files are shuffled', () => {
    const rng = new Rng(SEED);
    const result = buildResult(SEED);
    const { emitted } = serializeToCsv(rng, result);
    const gatewayOrder = emitted.filter((e) => e.row.sourceSystem === 'gateway').map((e) => e.row.eventId);
    // The generation order interleaves scenarios in the SAME sequence planEvents
    // produced; a shuffled file should not reproduce that sequence verbatim.
    const generationOrder = result.events.flatMap((p) => p.rows)
      .filter((r) => r.sourceSystem === 'gateway').map((r) => r.eventId);
    assert.notDeepEqual(gatewayOrder, generationOrder.slice(0, gatewayOrder.length));
  });

  test('gateway amounts use varied messy formatting across the file', () => {
    const rng = new Rng(SEED);
    const { gateway } = serializeToCsv(rng, buildResult(SEED));
    assert.ok(gateway.includes('₹'), 'no currency-symbol style amount appeared');
    assert.ok(/\d,\d{2},\d{3}\.\d{2}|\d,\d{3}\.\d{2}/.test(gateway), 'no comma-grouped amount appeared');
  });

  test('ledger and bank amounts stay plain (no messiness variety asked for by §2.2/§2.3)', () => {
    const rng = new Rng(SEED);
    const { bank, ledger } = serializeToCsv(rng, buildResult(SEED));
    assert.ok(!bank.includes('₹'));
    assert.ok(!ledger.includes('₹'));
  });

  test('three distinct date formats appear across the three files for the SAME event', () => {
    const rng = new Rng(SEED);
    const result = buildResult(SEED);
    const clean = result.events.find((p) => p.event.scenario === 'CLEAN_3WAY')!;
    const { gateway, bank, ledger, emitted } = serializeToCsv(rng, result);
    const files: Record<string, string> = { gateway, bank, ledger };
    for (const r of clean.rows) {
      const num = emitted.find((e) => e.row === r)!.sourceRowNumber;
      const records: Record<string, string>[] = parse(files[r.sourceSystem]!, { columns: true });
      const dateField = r.sourceSystem === 'gateway' ? 'created_at' : r.sourceSystem === 'bank' ? 'value_date' : 'entry_date';
      const value = records[num - 1]![dateField]!;
      if (r.sourceSystem === 'gateway') assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      if (r.sourceSystem === 'bank') assert.match(value, /^\d{2}-\d{2}-\d{4}$/);
      if (r.sourceSystem === 'ledger') assert.match(value, /^\d{2}\/\d{2}\/\d{4}$/);
    }
  });
});
