import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from './prng.js';
import { allocateScenarios, SCENARIOS, SCENARIO_SPECS, type Scenario } from './scenarios.js';
import { planEvents, MERCHANTS, DEFAULT_EVENT_PLAN, type EconomicEvent } from './events.js';
import { EXCEPTION_PRECEDENCE } from '../../apps/api/src/types/domain.js';
import { amountToleranceBand } from '../../apps/api/src/services/matching/tolerance.js';
import { ENGINE_DEFAULTS } from '../../apps/api/src/config/defaults.js';
import { dayDelta } from '../../apps/api/src/services/ingestion/dates.js';

const SEED = 90_210;
const plan = (over: Partial<typeof DEFAULT_EVENT_PLAN> = {}) =>
  planEvents(new Rng(SEED), { ...DEFAULT_EVENT_PLAN, ...over });

describe('scenario allocation (§3)', () => {
  test('the weights sum to 100, so the table is complete', () => {
    const total = SCENARIOS.reduce((s, k) => s + SCENARIO_SPECS[k].weight, 0);
    assert.ok(Math.abs(total - 100) < 1e-9, `weights sum to ${total}, not 100`);
  });

  test('allocation is exact — every event gets a scenario, none is invented', () => {
    for (const total of [0, 1, 7, 300, 1_000, 10_000]) {
      const counts = allocateScenarios(total);
      assert.equal([...counts.values()].reduce((a, b) => a + b, 0), total);
      assert.ok([...counts.values()].every((n) => n >= 0));
    }
  });

  test('at 300 events the §4 unresolvable family is 21, and splits 9/6/6', () => {
    // The number §4 argues for specifically, and the number the ~93% ceiling in
    // the README, the UI and the pitch is computed from. If this drifts with the
    // seed, every document quoting it goes stale on regeneration.
    const c = allocateScenarios(300);
    assert.equal(c.get('IDENTITY_DESTROYED'), 9);
    assert.equal(c.get('ORPHAN_NO_COUNTERPART'), 6);
    assert.equal(c.get('UNSPLITTABLE_NET_BATCH'), 6);
    assert.equal(
      c.get('IDENTITY_DESTROYED')! + c.get('ORPHAN_NO_COUNTERPART')! + c.get('UNSPLITTABLE_NET_BATCH')!,
      21);
  });

  test('every count lands within one of its ideal share', () => {
    // The property largest-remainder buys over independent draws, which at a 3%
    // weight on 300 events would have a standard deviation near 3.
    const total = 300;
    const counts = allocateScenarios(total);
    for (const s of SCENARIOS) {
      const ideal = (total * SCENARIO_SPECS[s].weight) / 100;
      assert.ok(Math.abs(counts.get(s)! - ideal) < 1,
        `${s}: allocated ${counts.get(s)}, ideal ${ideal}`);
    }
  });

  test('allocation consumes no randomness and depends only on its inputs', () => {
    // It must not shift the stream that generates the events themselves.
    const rng = new Rng(SEED);
    const before = rng.nextUint32();
    allocateScenarios(300); allocateScenarios(9_999);
    assert.equal(new Rng(SEED).nextUint32(), before);
    assert.deepEqual([...allocateScenarios(300)], [...allocateScenarios(300)]);
  });

  test('a stable count does not mean a stable membership', () => {
    // Which events are unresolvable must still vary freely with the seed; only
    // how many is pinned.
    const ids = (seed: number) => planEvents(new Rng(seed), DEFAULT_EVENT_PLAN)
      .events.filter((e) => SCENARIO_SPECS[e.scenario].resolvability === 'UNRESOLVABLE')
      .map((e) => e.eventId);
    assert.equal(ids(SEED).length, ids(SEED + 1).length);
    assert.notDeepEqual(ids(SEED), ids(SEED + 1));
  });

  test('bad inputs throw', () => {
    assert.throws(() => allocateScenarios(-1), /non-negative integer/);
    assert.throws(() => allocateScenarios(1.5), /non-negative integer/);
  });
});

describe('the taxonomy stays in step with the engine', () => {
  test('every expected category is one the engine can actually emit', () => {
    // The reason ExceptionCategory is imported rather than restated: a private
    // copy would compile, agree today, and drift the first time a category is
    // renamed — after which the scorer compares answers against a key written in
    // a different language, and no test could see it.
    for (const s of SCENARIOS) {
      const category = SCENARIO_SPECS[s].category;
      if (category === null) continue;
      assert.ok((EXCEPTION_PRECEDENCE as readonly string[]).includes(category),
        `${s} expects "${category}", which is not in the engine's taxonomy`);
    }
  });

  test('an expected category is present exactly when an exception is expected', () => {
    for (const s of SCENARIOS) {
      const spec = SCENARIO_SPECS[s];
      assert.equal(spec.category !== null, spec.outcome === 'EXCEPTION',
        `${s} pairs outcome ${spec.outcome} with category ${String(spec.category)}`);
    }
  });

  test('every unresolvable scenario is an exception, and §4 names exactly three', () => {
    const unresolvable = SCENARIOS.filter((s) => SCENARIO_SPECS[s].resolvability === 'UNRESOLVABLE');
    assert.deepEqual([...unresolvable].sort(),
      ['IDENTITY_DESTROYED', 'ORPHAN_NO_COUNTERPART', 'UNSPLITTABLE_NET_BATCH']);
    for (const s of unresolvable) assert.equal(SCENARIO_SPECS[s].outcome, 'EXCEPTION');
  });

  test('a two-source scenario expects the absence it is named for', () => {
    assert.deepEqual([...SCENARIO_SPECS.MISSING_IN_LEDGER.sources], ['gateway', 'bank']);
    assert.deepEqual([...SCENARIO_SPECS.MISSING_IN_BANK.sources], ['gateway', 'ledger']);
    assert.deepEqual([...SCENARIO_SPECS.ORPHAN_NO_COUNTERPART.sources], ['bank']);
  });
});

describe('planEvents — determinism', () => {
  test('the same seed gives byte-identical events', () => {
    assert.deepEqual(plan().events, plan().events);
  });

  test('different seeds give different events but the same shape', () => {
    const a = planEvents(new Rng(1), DEFAULT_EVENT_PLAN);
    const b = planEvents(new Rng(2), DEFAULT_EVENT_PLAN);
    assert.notDeepEqual(a.events, b.events);
    assert.deepEqual(a.realizedDistribution, b.realizedDistribution);
  });

  test('event ids are unique, ordered and stable', () => {
    const events = plan().events;
    assert.equal(new Set(events.map((e) => e.eventId)).size, events.length);
    assert.equal(events[0]!.eventId, 'evt_000000');
    assert.equal(events[41]!.eventId, 'evt_000041');
  });

  test('sub-streams isolate fields from one another', () => {
    // Adding a draw to the amount model must not reshuffle merchants or dates.
    const rng = new Rng(SEED);
    rng.derive('events.amount').nextUint32();
    assert.deepEqual(planEvents(rng, DEFAULT_EVENT_PLAN).events, plan().events);
  });

  test('the realized distribution reports what was generated', () => {
    const { events, realizedDistribution } = plan();
    const counted = new Map<Scenario, number>();
    for (const e of events) counted.set(e.scenario, (counted.get(e.scenario) ?? 0) + 1);
    for (const s of SCENARIOS) assert.equal(realizedDistribution[s], counted.get(s) ?? 0, s);
  });
});

describe('canonical facts', () => {
  const events: readonly EconomicEvent[] = plan({ count: 4_000 }).events;

  test('amounts are positive whole paise', () => {
    for (const e of events) {
      assert.ok(Number.isSafeInteger(e.canonical.amountPaise), `${e.eventId} non-integer paise`);
      assert.ok(e.canonical.amountPaise > 0);
    }
  });

  test('THE AMOUNT SPREAD EXERCISES ALL THREE TOLERANCE REGIMES (schema.md §5.1)', () => {
    // Floored, proportional and capped. A dataset that only lands in one leaves
    // the other two clamps untested by the data, and the measured accuracy then
    // says nothing about whether they were sized correctly.
    // The engine's OWN defaults and its OWN tolerance function, not a restatement
    // of §5.1's arithmetic here. A second copy would agree today and drift later,
    // and this test would then be asserting coverage of a band nobody uses.
    const config = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-20', aliasCountAtStart: 0 };
    let floored = 0, proportional = 0, capped = 0;
    for (const e of events) {
      const band = amountToleranceBand(e.canonical.amountPaise, config);
      if (band === config.amountToleranceFloorPaise) floored += 1;
      else if (band === config.amountToleranceCapPaise) capped += 1;
      else proportional += 1;
    }
    const n = events.length;
    assert.ok(floored / n > 0.05, `only ${(floored / n * 100).toFixed(1)}% exercise the ₹1 floor`);
    assert.ok(capped / n > 0.03, `only ${(capped / n * 100).toFixed(1)}% exercise the ₹100 cap`);
    assert.ok(proportional / n > 0.4, `only ${(proportional / n * 100).toFixed(1)}% are proportional`);
  });

  test('amounts collide naturally, so ambiguity is not only ever planted', () => {
    const byKey = new Map<string, number>();
    for (const e of events) {
      const k = `${e.canonical.merchant}|${e.canonical.date}|${e.canonical.amountPaise}`;
      byKey.set(k, (byKey.get(k) ?? 0) + 1);
    }
    const collisions = [...byKey.values()].filter((n) => n > 1).length;
    assert.ok(collisions > 0,
      'no merchant/date/amount ever repeats — IDENTITY_DESTROYED would be contrived rather than realistic');
  });

  test('dates fall inside the requested window and use calendar days', () => {
    const { events: e, window } = plan({ count: 2_000 });
    const seen = new Set<string>();
    for (const ev of e) {
      const offset = dayDelta(window.startDate, ev.canonical.date);
      assert.ok(offset >= 0 && offset < window.days,
        `${ev.eventId} at ${ev.canonical.date} is outside [${window.startDate}, ${window.endDate}]`);
      seen.add(ev.canonical.date);
    }
    assert.equal(seen.size, window.days, 'every day in the window should be used, weekends included');
  });

  test('merchants come from the catalogue and every one is used', () => {
    const canonical = new Set(MERCHANTS.map((m) => m.canonical));
    const used = new Set(events.map((e) => e.canonical.merchant));
    for (const m of used) assert.ok(canonical.has(m), `${m} is not in the catalogue`);
    assert.equal(used.size, MERCHANTS.length, 'some merchant never appears');
  });

  test('merchant variants are distinct from the canonical and from each other', () => {
    // The aliasKey (§2.3) is built from these, and a variant equal to its
    // canonical would produce an alias mapping a value to itself, which
    // learned_aliases rejects by CHECK constraint.
    for (const m of MERCHANTS) {
      assert.equal(new Set(m.variants).size, m.variants.length, `${m.canonical} has a duplicate variant`);
      assert.ok(m.variants.length >= 2, `${m.canonical} needs variants to be alias-testable`);
    }
    assert.equal(new Set(MERCHANTS.map((m) => m.canonical)).size, MERCHANTS.length);
  });

  test('every payment method appears, so the per-method date window is exercised', () => {
    assert.deepEqual(
      [...new Set(events.map((e) => e.canonical.method))].sort(),
      ['card', 'netbanking', 'upi', 'wallet']);
  });

  test('REFUND_REVERSAL is the only debit', () => {
    // A canonical fact of the event, not a defect: this is what exercises the
    // direction gate (ADR-035).
    for (const e of events) {
      const expected = e.scenario === 'REFUND_REVERSAL' ? 'debit' : 'credit';
      assert.equal(e.canonical.direction, expected, `${e.eventId} (${e.scenario})`);
    }
    assert.ok(events.some((e) => e.canonical.direction === 'debit'), 'no refunds generated');
  });

  test('bad options throw rather than silently producing a different dataset', () => {
    const rng = new Rng(SEED);
    assert.throws(() => planEvents(rng, { ...DEFAULT_EVENT_PLAN, count: 0 }), /positive integer/);
    assert.throws(() => planEvents(rng, { ...DEFAULT_EVENT_PLAN, windowDays: 0 }), /positive integer/);
    assert.throws(() => planEvents(rng, { ...DEFAULT_EVENT_PLAN, windowEndDate: '20-08-2026' }), /YYYY-MM-DD/);
  });
});
