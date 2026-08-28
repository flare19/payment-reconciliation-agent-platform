import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from './prng.js';
import { planEvents, DEFAULT_EVENT_PLAN, type EconomicEvent } from './events.js';
import { plantIdentityClusters, MIN_AMBIGUOUS_CLUSTER } from './planting.js';
import {
  matcherView, proveIdentityDestroyed, proveOrphanHasNoCounterpart,
  proveUnsplittableBatch, proveWithRegeneration, DEFAULT_PROOF_CONFIG,
} from './proofs.js';
import type { BankRow, EventProjection, GatewayRow, ProjectionResult } from './projection.js';
import type { Scenario } from './scenarios.js';

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

const gw = (over: Partial<GatewayRow> = {}): GatewayRow => ({
  sourceSystem: 'gateway', eventId: 'evt_000000', defects: [],
  // Every anchor destroyed: this is what IDENTITY_DESTROYED means.
  blankedColumns: ['payment_id', 'order_id', 'rrn', 'settlement_id'],
  paymentId: 'pay_QK29fT10aXbZ81', orderId: null, method: 'card', status: 'captured',
  amountPaise: 199_900, currency: 'INR', feePaise: 4_718, taxPaise: 849,
  netAmountPaise: 194_333, createdAt: '2026-08-14 18:42:11', capturedAt: null,
  merchantName: 'AMZN', customerEmail: null, rrn: null, settlementId: null, notes: null, ...over,
});

const bk = (over: Partial<BankRow> = {}): BankRow => ({
  sourceSystem: 'bank', eventId: 'evt_000000', defects: [], blankedColumns: [],
  utr: 'SBIN0R52026081412345', valueDate: '2026-08-16', postingDate: '2026-08-16',
  description: 'NEFT-SETL-AMZN-BATCH12', creditAmountPaise: 500_000, debitAmountPaise: null,
  closingBalancePaise: 9_900_000, bankRefNo: null, transactionType: 'SETTLEMENT', ...over,
});

const asResult = (events: EventProjection[]): ProjectionResult =>
  ({ events, noise: { rows: [] } });

const evt = (id: string, scenario: Scenario = 'IDENTITY_DESTROYED'): EconomicEvent => ({
  eventId: id, scenario,
  canonical: { amountPaise: 199_900, date: '2026-08-14', merchant: 'AMAZON RETAIL', method: 'card', direction: 'credit' },
});

describe('planting identity clusters', () => {
  test('every IDENTITY_DESTROYED event lands in a cluster of at least three', () => {
    const { events } = planEvents(new Rng(SEED), DEFAULT_EVENT_PLAN);
    const { events: planted, identityClusters } = plantIdentityClusters(new Rng(SEED), events);
    const targets = planted.filter((e) => e.scenario === 'IDENTITY_DESTROYED');
    assert.equal(identityClusters.reduce((n, c) => n + c.eventIds.length, 0), targets.length);
    for (const c of identityClusters) {
      assert.ok(c.eventIds.length >= MIN_AMBIGUOUS_CLUSTER, `cluster of ${c.eventIds.length}`);
    }
  });

  test('cluster members share identical canonical facts', () => {
    const { events } = planEvents(new Rng(SEED), DEFAULT_EVENT_PLAN);
    const { events: planted, identityClusters } = plantIdentityClusters(new Rng(SEED), events);
    const byId = new Map(planted.map((e) => [e.eventId, e]));
    for (const cluster of identityClusters) {
      const facts = cluster.eventIds.map((id) => JSON.stringify(byId.get(id)!.canonical));
      assert.equal(new Set(facts).size, 1, 'cluster members must be indistinguishable');
    }
  });

  test('nothing outside the cluster is touched', () => {
    const { events } = planEvents(new Rng(SEED), DEFAULT_EVENT_PLAN);
    const { events: planted } = plantIdentityClusters(new Rng(SEED), events);
    for (const [i, before] of events.entries()) {
      if (before.scenario === 'IDENTITY_DESTROYED') continue;
      assert.deepEqual(planted[i], before, `${before.eventId} was rewritten`);
    }
  });

  test('a dataset too small to carry the claim FAILS rather than weakening it', () => {
    // Two indistinguishable rows are an ordinary ambiguous pair. §4's claim is
    // specifically about three or more, and a silent cluster of two would leave
    // the ceiling stated but unearned.
    assert.throws(() => plantIdentityClusters(new Rng(SEED), [evt('evt_000000'), evt('evt_000001')]),
      /cannot form a cluster of 3/);
  });

  test('planting is deterministic', () => {
    const { events } = planEvents(new Rng(SEED), DEFAULT_EVENT_PLAN);
    assert.deepEqual(plantIdentityClusters(new Rng(SEED), events),
      plantIdentityClusters(new Rng(SEED), events));
  });
});

describe('§4 — IDENTITY_DESTROYED is proven, not labelled', () => {
  const cluster = { eventIds: ['evt_a', 'evt_b', 'evt_c'] };
  const projections = (rows: (over?: Partial<GatewayRow>) => GatewayRow[]): EventProjection[] =>
    cluster.eventIds.map((id) => ({ event: evt(id), rows: rows({ eventId: id }) }));

  test('three indistinguishable members pass', () => {
    assert.deepEqual(
      proveIdentityDestroyed(asResult(projections((o) => [gw(o)])), [cluster]), []);
  });

  test('A SURVIVING ANCHOR collapses the claim', () => {
    // One readable payment_id and the engine can tell that row from its
    // cluster-mates, so the ambiguity is not genuine.
    const withAnchor = asResult(cluster.eventIds.map((id, i) => ({
      event: evt(id),
      rows: [gw({ eventId: id, ...(i === 0 ? { blankedColumns: ['order_id', 'rrn', 'settlement_id'] } : {}) })],
    })));
    const failures = proveIdentityDestroyed(withAnchor, [cluster]);
    assert.ok(failures.some((f) => f.proof === 'IDENTITY_DESTROYED/no-anchor-survives'));
  });

  test('a differing amount, date or merchant collapses the claim', () => {
    for (const [field, over] of [
      ['amount', { amountPaise: 199_901 }],
      ['date', { createdAt: '2026-08-15 10:00:00' }],
      ['merchant', { merchantName: 'FLIPKART' }],
    ] as const) {
      const differing = asResult(cluster.eventIds.map((id, i) => ({
        event: evt(id), rows: [gw({ eventId: id, ...(i === 0 ? over : {}) })],
      })));
      const failures = proveIdentityDestroyed(differing, [cluster]);
      assert.ok(failures.some((f) => f.proof === 'IDENTITY_DESTROYED/members-are-indistinguishable'),
        `a differing ${field} must be caught`);
    }
  });

  test('MERCHANT VARIANTS THAT NORMALIZE TOGETHER stay indistinguishable', () => {
    // The reason the engine's normalizer is used rather than a local comparison:
    // two rows spelled differently but normalizing to the same counterparty ARE
    // indistinguishable to the matcher, and a raw string compare would wrongly
    // report the cluster as broken.
    const spellings = ['AMZN', 'amzn', '  AMZN  '];
    const varied = asResult(cluster.eventIds.map((id, i) => ({
      event: evt(id), rows: [gw({ eventId: id, merchantName: spellings[i]! })],
    })));
    assert.deepEqual(proveIdentityDestroyed(varied, [cluster]), []);
  });

  test('a cluster of two is refused', () => {
    assert.ok(proveIdentityDestroyed(asResult(projections((o) => [gw(o)])),
      [{ eventIds: ['evt_a', 'evt_b'] }])
      .some((f) => f.proof === 'IDENTITY_DESTROYED/cluster-size'));
  });

  test('a member that was never projected is caught', () => {
    assert.ok(proveIdentityDestroyed(asResult([]), [cluster])
      .some((f) => f.proof === 'IDENTITY_DESTROYED/member-projected'));
  });
});

describe('§4 — UNSPLITTABLE_NET_BATCH runs a real subset search', () => {
  const pool = (nets: number[]): GatewayRow[] =>
    nets.map((n, i) => gw({ eventId: `evt_${i}`, netAmountPaise: n,
      amountPaise: n + 5_567, paymentId: `pay_${String(i).padStart(14, '0')}`, blankedColumns: [] }));

  test('a credit no subset can reach is proven unresolvable', () => {
    // ₹550 sits INSIDE the pool's reachable range (the subsets total up to ₹1,500),
    // so the search has to actually run rather than being pruned at the root — but
    // no combination of 100/200/400/800 lands in the ±₹2.75 band around it.
    const failures = proveUnsplittableBatch(bk({ creditAmountPaise: 55_000 }),
      pool([10_000, 20_000, 40_000, 80_000]), 'evt_batch');
    assert.deepEqual(failures, []);
  });

  test('A CREDIT THAT IS DECOMPOSABLE IS REJECTED, and the subset is named', () => {
    // The case §4 exists to prevent: labelling something unresolvable when the
    // engine can in fact split it. The key would then score a correct engine wrong.
    const failures = proveUnsplittableBatch(bk({ creditAmountPaise: 60_000 }),
      pool([10_000, 20_000, 40_000, 80_000]), 'evt_batch');
    assert.ok(failures.some((f) => f.proof === 'UNSPLITTABLE_BATCH/no-subset-sums-into-the-band'));
    assert.match(failures[0]!.detail, /a decomposition EXISTS/);
  });

  test('a subset landing inside TOLERANCE also counts as decomposable', () => {
    // Exactness is not the test; the engine's own band is. A subset two paise off
    // would still be matched by the engine.
    const failures = proveUnsplittableBatch(bk({ creditAmountPaise: 60_002 }),
      pool([10_000, 20_000, 40_000, 80_000]), 'evt_batch');
    assert.ok(failures.some((f) => f.proof === 'UNSPLITTABLE_BATCH/no-subset-sums-into-the-band'));
  });

  test('a NON-EXHAUSTIVE search is not accepted as a proof', () => {
    // "Found nothing" because the search stopped is not "nothing is there". This
    // is the difference between a proof and a hopeful result.
    // The target has to be REACHABLE or the search prunes at the root and
    // legitimately reports exhaustive — a budget of one node only truncates a
    // search that had somewhere to go.
    const tiny = { ...DEFAULT_PROOF_CONFIG, batchNodeBudget: 1 };
    const failures = proveUnsplittableBatch(bk({ creditAmountPaise: 250_000 }),
      pool([10_000, 20_000, 40_000, 80_000, 160_000, 320_000]), 'evt_batch', tiny);
    assert.ok(failures.some((f) => f.proof === 'UNSPLITTABLE_BATCH/search-was-exhaustive'),
      'a truncated search must not be reported as a proof');
  });

  test('a batch row with no credit is caught', () => {
    assert.ok(proveUnsplittableBatch(bk({ creditAmountPaise: null, debitAmountPaise: 10 }), [], null)
      .some((f) => f.proof === 'UNSPLITTABLE_BATCH/credit-is-a-credit'));
  });
});

describe('§4 — ORPHAN_NO_COUNTERPART has no credible counterpart', () => {
  test('an orphan with nothing nearby passes', () => {
    assert.deepEqual(proveOrphanHasNoCounterpart(
      bk({ creditAmountPaise: 45_000, description: 'MISC CREDIT REVERSAL' }),
      [gw({ netAmountPaise: 900_000, amountPaise: 950_000 })], 'evt_orphan'), []);
  });

  test('AN ORPHAN THE ENGINE COULD MATCH IS REJECTED', () => {
    // §4's own phrasing — "no event references the row" — is true by construction
    // and proves nothing. The property that matters is that no gateway payment is
    // a credible counterpart, because if one is, the engine may pair them and the
    // key would be calling a correct engine wrong.
    const failures = proveOrphanHasNoCounterpart(
      bk({ creditAmountPaise: 194_333, valueDate: '2026-08-16', description: 'AMZN' }),
      [gw()], 'evt_orphan');
    assert.ok(failures.some((f) => f.proof === 'ORPHAN/has-no-credible-counterpart'));
    assert.match(failures[0]!.detail, /is matchable and must be regenerated/);
  });

  test('a candidate outside the date window is not a counterpart', () => {
    assert.deepEqual(proveOrphanHasNoCounterpart(
      bk({ creditAmountPaise: 194_333, valueDate: '2026-09-30', description: 'AMZN' }),
      [gw()], 'evt_orphan'), []);
  });

  test('a candidate for a different merchant is not a counterpart', () => {
    assert.deepEqual(proveOrphanHasNoCounterpart(
      bk({ creditAmountPaise: 194_333, valueDate: '2026-08-16', description: 'FLIPKART' }),
      [gw()], 'evt_orphan'), []);
  });
});

describe('bounded regeneration', () => {
  test('it returns the first candidate that proves', () => {
    const attempts: number[] = [];
    const got = proveWithRegeneration(5,
      (n) => { attempts.push(n); return n; },
      (n) => (n < 2 ? [{ proof: 'p', eventId: null, detail: 'nope' }] : []), 'test');
    assert.equal(got, 2);
    assert.deepEqual(attempts, [0, 1, 2]);
  });

  test('IT THROWS when the attempts run out, rather than shipping the last try', () => {
    // Silently accepting the final attempt is how a proof becomes decoration: the
    // key would assert unresolvability the generator never established.
    assert.throws(() => proveWithRegeneration(3, (n) => n,
      () => [{ proof: 'always', eventId: 'evt_x', detail: 'still resolvable' }], 'identity'),
      (err: Error) => {
        assert.match(err.message, /3 attempts all failed/);
        assert.match(err.message, /cannot honestly claim/);
        assert.match(err.message, /still resolvable/);
        return true;
      });
  });

  test('a zero attempt budget is refused', () => {
    assert.throws(() => proveWithRegeneration(0, (n) => n, () => [], 'x'), /attempts must be >= 1/);
  });
});

describe('the matcher view is a view, not a parser', () => {
  test('net is null exactly when the row blanks it — the fee-inference trigger', () => {
    assert.equal(matcherView(gw({ blankedColumns: [] }), 1).netAmountPaise, 194_333);
    assert.equal(matcherView(gw({ blankedColumns: ['fee', 'net_amount'] }), 1).netAmountPaise, null);
  });

  test('blanked anchors do not appear in referenceIds', () => {
    const view = matcherView(gw({ blankedColumns: ['payment_id'], rrn: '234567890123' }), 1);
    assert.equal(view.referenceIds.payment_id, undefined);
    assert.equal(view.referenceIds.rrn, '234567890123');
  });

  test('a refunded row reads as a debit', () => {
    assert.equal(matcherView(gw({ status: 'refunded' }), 1).direction, 'debit');
    assert.equal(matcherView(gw(), 1).direction, 'credit');
  });
});
