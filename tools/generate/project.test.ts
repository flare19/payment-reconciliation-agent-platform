import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from './prng.js';
import { planEvents, DEFAULT_EVENT_PLAN, type EconomicEvent } from './events.js';
import { plantIdentityClusters } from './planting.js';
import { projectEvent, projectUnsplittableEvent, projectNoise, resetSequentialIds } from './project.js';
import { checkProjectionInvariants } from './invariants.js';
import { SCENARIOS, SCENARIO_SPECS, type Scenario } from './scenarios.js';
import { ENGINE_DEFAULTS } from '../../apps/api/src/config/defaults.js';
import type { RunConfig } from '../../apps/api/src/types/engine.js';
import type { BankRow, GatewayRow, LedgerRow, ProjectedRow, ProjectionResult } from './projection.js';
import { parseMoney } from '../../apps/api/src/services/ingestion/money.js';
import { parseSourceDate } from '../../apps/api/src/services/ingestion/dates.js';
import { amountToleranceBand } from '../../apps/api/src/services/matching/tolerance.js';
import { formatDDMMYYYY, formatMMDDYYYY } from './format.js';

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

/** Project the full HOLDOUT_SEED-shaped dataset (minus UNSPLITTABLE_NET_BATCH's cross-event proof). */
function projectAll(seed: number): { events: readonly EconomicEvent[]; result: ProjectionResult } {
  resetSequentialIds();
  const rng = new Rng(seed);
  const { events: planned } = planEvents(rng, DEFAULT_EVENT_PLAN);
  const { events } = plantIdentityClusters(rng, planned);

  const rows: { row: ProjectedRow; sourceRowNumber: number }[] = [];
  let n = 0;
  const eventProjections = events.map((event) => {
    const projected = event.scenario === 'UNSPLITTABLE_NET_BATCH'
      ? projectUnsplittableEvent(rng, event, CONFIG).rows
      : projectEvent(rng, event, CONFIG);
    for (const row of projected) rows.push({ row, sourceRowNumber: (n += 1) });
    return { event, rows: projected };
  });

  const noise = projectNoise(rng, DEFAULT_EVENT_PLAN.windowEndDate, DEFAULT_EVENT_PLAN.windowDays, 25, 12);
  return { events, result: { events: eventProjections, noise: { rows: noise } } };
}

describe('a full realized dataset satisfies every G3 invariant', () => {
  test('DEV_SEED (1337)', () => {
    const { result } = projectAll(SEED);
    const violations = checkProjectionInvariants(result, CONFIG);
    assert.deepEqual(violations, [],
      `${violations.length} invariant violation(s): ${JSON.stringify(violations.slice(0, 5), null, 2)}`);
  });

  test('six arbitrary seeds — the invariants are a property of the generator, not of one dataset', () => {
    for (const seed of [1, 42, 7_777, 55_555, 999_999, 31_415_926]) {
      const { result } = projectAll(seed);
      const violations = checkProjectionInvariants(result, CONFIG);
      assert.deepEqual(violations, [], `seed ${seed}: ${JSON.stringify(violations.slice(0, 3))}`);
    }
  });

  test('every scenario is actually represented', () => {
    const { events } = projectAll(SEED);
    const seen = new Set(events.map((e) => e.scenario));
    for (const s of SCENARIOS) assert.ok(seen.has(s), `${s} never appeared`);
  });
});

describe('determinism', () => {
  test('the same seed produces byte-identical rows', () => {
    const a = projectAll(SEED).result;
    const b = projectAll(SEED).result;
    assert.deepEqual(a, b);
  });
});

describe('per-scenario spot checks', () => {
  const { events, result } = projectAll(SEED);
  const rowsFor = (eventId: string): readonly ProjectedRow[] =>
    result.events.find((p) => p.event.eventId === eventId)!.rows;
  const gw = (rows: readonly ProjectedRow[]): GatewayRow[] => rows.filter((r): r is GatewayRow => r.sourceSystem === 'gateway');
  const bk = (rows: readonly ProjectedRow[]): BankRow[] => rows.filter((r): r is BankRow => r.sourceSystem === 'bank');
  const lg = (rows: readonly ProjectedRow[]): LedgerRow[] => rows.filter((r): r is LedgerRow => r.sourceSystem === 'ledger');

  const oneOfEach = new Map<Scenario, EconomicEvent>();
  for (const e of events) if (!oneOfEach.has(e.scenario)) oneOfEach.set(e.scenario, e);

  test('CLEAN_3WAY: payment_id and gateway_ref agree, description carries the rrn', () => {
    // buildThreeWay's own baseline ~12% blank / ~4% typo roll on gateway_ref
    // applies to every 3-way scenario, CLEAN_3WAY included — that is intentional
    // (§2.3's baseline messiness is a property of the FILE, not of the scenario),
    // so this checks the wiring on an event where that roll did not fire, not on
    // an arbitrary one.
    const clean = events.filter((e) => e.scenario === 'CLEAN_3WAY')
      .find((e) => {
        const [l] = lg(rowsFor(e.eventId));
        return l!.gatewayRef !== null;
      })!;
    const rows = rowsFor(clean.eventId);
    const [g] = gw(rows), [b] = bk(rows), [l] = lg(rows);
    assert.equal(l!.gatewayRef, g!.paymentId);
    if (g!.rrn !== null && !g!.blankedColumns.includes('rrn')) {
      assert.ok(b!.description.includes(g!.rrn), 'description should embed the rrn when the gateway kept it');
    }
  });

  test('MERCHANT_NAME_VARIANT: the sources genuinely disagree about the name', () => {
    // Per event each source draws its own variant independently, so one event can
    // legitimately draw the same string twice. The property that has to hold is
    // across the SCENARIO: if no event ever disagrees, the alias-learning surface
    // this scenario exists to create is not in the dataset at all.
    const variantEvents = events.filter((e) => e.scenario === 'MERCHANT_NAME_VARIANT');
    assert.ok(variantEvents.length > 0, 'no MERCHANT_NAME_VARIANT events were generated');

    const disagreeing = variantEvents.filter((e) => {
      const rows = rowsFor(e.eventId);
      const [g] = gw(rows), [l] = lg(rows);
      return g !== undefined && l !== undefined && g.merchantName !== l.customerName;
    });
    assert.ok(disagreeing.length > variantEvents.length / 2,
      `only ${disagreeing.length}/${variantEvents.length} MERCHANT_NAME_VARIANT events have a ` +
      `gateway/ledger name disagreement — there is nothing for an alias to resolve`);

    // And at least one must use a string that is not the canonical name, or the
    // aliasKey (§2.3) has no held-out variant to measure cold learning against.
    assert.ok(variantEvents.some((e) => {
      const [g] = gw(rowsFor(e.eventId));
      return g !== undefined && g.merchantName !== e.canonical.merchant;
    }), 'every gateway row used the canonical name; no variant was ever emitted');
  });

  test('AMOUNT_TRUE_MISMATCH: EVERY one is beyond the engine own tolerance band', () => {
    // "Beyond ANY tolerance" is §2.4's definition, and the only honest reading of
    // "any" is the band the engine actually applies. A mismatch inside the band is
    // not a mismatch: the engine would match it correctly and the key would score
    // that as an error. Checked with the engine's own amountToleranceBand, over
    // every such event rather than one sample.
    const mismatches = events.filter((e) => e.scenario === 'AMOUNT_TRUE_MISMATCH');
    assert.ok(mismatches.length > 0, 'no AMOUNT_TRUE_MISMATCH events were generated');
    for (const e of mismatches) {
      const rows = rowsFor(e.eventId);
      const [g] = gw(rows), [l] = lg(rows);
      const band = amountToleranceBand(g!.amountPaise, CONFIG);
      const delta = Math.abs(l!.netAmountPaise - g!.amountPaise);
      assert.ok(delta > band,
        `${e.eventId}: delta ${delta} is inside the ${band} paise band, so the engine would match it`);
    }
  });

  test('DUPLICATE_ROW: exactly one non-bank source has two rows sharing the anchor', () => {
    const e = oneOfEach.get('DUPLICATE_ROW')!;
    const rows = rowsFor(e.eventId);
    const g = gw(rows), l = lg(rows), b = bk(rows);
    assert.equal(b.length, 1);
    assert.ok((g.length === 2) !== (l.length === 2), 'exactly one of gateway/ledger duplicated');
    if (g.length === 2) assert.equal(g[0]!.paymentId, g[1]!.paymentId);
    if (l.length === 2) assert.equal(l[0]!.gatewayRef, l[1]!.gatewayRef);
  });

  test('SPLIT_SETTLEMENT: 2-4 bank legs summing exactly to gateway net', () => {
    const e = oneOfEach.get('SPLIT_SETTLEMENT')!;
    const rows = rowsFor(e.eventId);
    const [g] = gw(rows), b = bk(rows);
    assert.ok(b.length >= 2 && b.length <= 4);
    assert.equal(b.reduce((s, x) => s + x.creditAmountPaise!, 0), g!.netAmountPaise);
    assert.ok(b.every((x) => x.creditAmountPaise! > 0), 'every leg must be a positive amount');
  });

  test('REFUND_REVERSAL: gateway refunded, bank leg a debit', () => {
    const e = oneOfEach.get('REFUND_REVERSAL')!;
    const rows = rowsFor(e.eventId);
    const [g] = gw(rows), [b] = bk(rows);
    assert.equal(g!.status, 'refunded');
    assert.equal(b!.creditAmountPaise, null);
    assert.ok(b!.debitAmountPaise! > 0);
  });

  test('MISSING_IN_LEDGER / MISSING_IN_BANK: exactly two sources projected', () => {
    for (const [scenario, missing] of [['MISSING_IN_LEDGER', 'ledger'], ['MISSING_IN_BANK', 'bank']] as const) {
      const e = oneOfEach.get(scenario)!;
      const rows = rowsFor(e.eventId);
      assert.ok(!rows.some((r) => r.sourceSystem === missing), `${scenario} still emitted a ${missing} row`);
      assert.equal(rows.length, 2);
    }
  });

  test('REF_MISSING_OR_TYPO: exactly one connecting anchor is damaged, not all three', () => {
    const e = oneOfEach.get('REF_MISSING_OR_TYPO')!;
    const rows = rowsFor(e.eventId);
    const damaged = rows.filter((r) => r.defects.some((d) => ['REF_MISSING', 'REF_TYPO', 'DESC_TRUNCATED'].includes(d)));
    assert.equal(damaged.length, 1, `expected exactly one damaged row, got ${damaged.length}`);
  });

  test('IDENTITY_DESTROYED: gateway row carries no readable anchor at all', () => {
    const e = oneOfEach.get('IDENTITY_DESTROYED')!;
    const rows = rowsFor(e.eventId);
    const [g] = gw(rows);
    assert.equal(g!.blankedColumns.includes('payment_id'), true);
    assert.equal(g!.blankedColumns.includes('order_id'), true);
    assert.equal(g!.blankedColumns.includes('rrn'), true);
    assert.equal(g!.blankedColumns.includes('settlement_id'), true);
  });

  test('ORPHAN_NO_COUNTERPART: exactly one bank row, no gateway or ledger', () => {
    const e = oneOfEach.get('ORPHAN_NO_COUNTERPART')!;
    const rows = rowsFor(e.eventId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sourceSystem, 'bank');
  });

  test('UNSPLITTABLE_NET_BATCH: the event has its own clean gateway/ledger pair plus a separate credit', () => {
    const e = oneOfEach.get('UNSPLITTABLE_NET_BATCH')!;
    const rows = rowsFor(e.eventId);
    assert.equal(rows.length, 3);
    const [g] = gw(rows), [l] = lg(rows), [b] = bk(rows);
    assert.equal(g!.amountPaise, l!.netAmountPaise, 'ADR-037 must still hold for this event\'s own pair');
    assert.notEqual(b!.creditAmountPaise, g!.netAmountPaise, 'the mystery credit is not a trivial 1-subset match');
  });
});

describe('every emitted amount and date parses through the real engine parsers', () => {
  const { result } = projectAll(SEED);
  const allRows = [...result.events.flatMap((p) => p.rows), ...result.noise.rows];

  test('gateway amounts parse via the messy-money parser', () => {
    for (const row of allRows) {
      if (row.sourceSystem !== 'gateway') continue;
      assert.equal(parseMoney(String(row.amountPaise / 100)).ok, true);
    }
  });

  test('EVERY date round-trips: formatted for its source, parsed back, same business date', () => {
    // Projected rows hold ISO dates; the FILE carries three different formats.
    // So the property worth testing is the round trip — format as the source
    // would, parse with that source's declared format, and land on the same
    // calendar day. Parsing the internal ISO value directly (as an earlier
    // version of this test did) tests nothing about what the file contains.
    let checked = 0;
    for (const row of allRows) {
      const cases: [string, Parameters<typeof parseSourceDate>[1], string][] =
        row.sourceSystem === 'gateway'
          ? [[row.createdAt, 'YYYY-MM-DD HH:MM:SS', row.createdAt.slice(0, 10)],
             ...(row.capturedAt !== null
               ? [[row.capturedAt, 'YYYY-MM-DD HH:MM:SS', row.capturedAt.slice(0, 10)] as
                 [string, Parameters<typeof parseSourceDate>[1], string]] : [])]
          : row.sourceSystem === 'bank'
            ? [[formatDDMMYYYY(row.valueDate), 'DD-MM-YYYY', row.valueDate],
               [formatDDMMYYYY(row.postingDate), 'DD-MM-YYYY', row.postingDate]]
            : [[formatMMDDYYYY(row.entryDate), 'MM/DD/YYYY', row.entryDate]];

      for (const [text, format, expected] of cases) {
        const result = parseSourceDate(text, format);
        assert.equal(result.ok, true, `"${text}" (${format}) failed to parse`);
        assert.equal((result as { ok: true; value: { businessDate: string } | null }).value?.businessDate,
          expected, `"${text}" (${format}) parsed to the wrong calendar day`);
        checked += 1;
      }
    }
    assert.ok(checked > 900, `only ${checked} date fields checked — the loop is not covering the dataset`);
  });

  test('THE ~30% AMBIGUITY RULE: most ledger dates must defeat format inference (schema.md §2.3)', () => {
    // A ledger date of 03/04/2026 is 3 April as MM/DD and 4 March as DD/MM, and
    // nothing in the string says which. §2.3 wants most rows ambiguous so that a
    // parser which INFERS the format is visibly, frequently wrong — that is the
    // whole reason dates.ts refuses to guess. Days above 12 cannot be a month, so
    // they hand an inferring parser a free correct answer.
    const ledgerDays = allRows
      .filter((r): r is Extract<ProjectedRow, { sourceSystem: 'ledger' }> => r.sourceSystem === 'ledger')
      .map((r) => Number(r.entryDate.split('-')[2]));
    const ambiguous = ledgerDays.filter((d) => d <= 12).length;
    const share = ambiguous / ledgerDays.length;
    assert.ok(share > 0.35,
      `only ${(share * 100).toFixed(1)}% of ledger dates are ambiguous; an inferring parser would ` +
      `guess right too often for the declared-format rule to be visibly load-bearing`);
  });
});

describe('noise', () => {
  test('every noise row is keyed and carries an excluded status', () => {
    const { result } = projectAll(SEED);
    for (const row of result.noise.rows) {
      assert.equal(row.eventId, null);
      assert.ok(row.defects.includes('NOISE_ROW'));
      if (row.sourceSystem === 'gateway') assert.ok(['authorized', 'failed'].includes(row.status));
      if (row.sourceSystem === 'ledger') assert.ok(['draft', 'void'].includes(row.status));
    }
  });

  test('noise counts match what was requested', () => {
    resetSequentialIds();
    const rng = new Rng(SEED);
    const rows = projectNoise(rng, '2026-07-22', 30, 25, 12);
    assert.equal(rows.filter((r) => r.sourceSystem === 'gateway').length, 25);
    assert.equal(rows.filter((r) => r.sourceSystem === 'ledger').length, 12);
  });
});
