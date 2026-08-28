import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from './prng.js';

/**
 * The whole project's reproducibility claim rests on this file, so these tests are
 * about PROPERTIES rather than golden values: a golden-vector test would pin the
 * output without saying what has to be true of it, and would have to be rewritten
 * (silently accepting whatever the code now does) the first time anything changed.
 */

const DEV_SEED = 424_242;
const draws = (rng: Rng, n = 2_000): number[] => Array.from({ length: n }, () => rng.nextUint32());

describe('determinism — the property everything else depends on', () => {
  test('the same seed produces a byte-identical stream', () => {
    assert.deepEqual(draws(new Rng(DEV_SEED)), draws(new Rng(DEV_SEED)));
  });

  test('two instances do not share state', () => {
    // A module-level generator would make output depend on call ORDER ACROSS the
    // whole program, so adding a draw anywhere would change everything everywhere.
    const a = new Rng(DEV_SEED);
    const b = new Rng(DEV_SEED);
    a.nextUint32(); a.nextUint32();
    assert.equal(b.nextUint32(), new Rng(DEV_SEED).nextUint32());
  });

  test('a non-integer seed is refused, not truncated', () => {
    // Silently truncating 1.5 to 1 would make "the same seed" ambiguous.
    for (const bad of [1.5, NaN, Infinity, 2 ** 53]) {
      assert.throws(() => new Rng(bad), /safe integer/);
    }
  });

  test('negative and zero seeds work', () => {
    assert.equal(draws(new Rng(0), 50).length, 50);
    assert.notDeepEqual(draws(new Rng(-7), 50), draws(new Rng(7), 50));
  });
});

describe('ADJACENT SEEDS ARE UNCORRELATED (ADR-027)', () => {
  test('seeds n and n+1 share no structure', () => {
    // The reason the seed is scrambled before use. DEV_SEED and HOLDOUT_SEED are
    // two integers a human picked; if adjacent seeds produced related datasets,
    // tuning against dev would partially tune against holdout, which is the exact
    // leak ADR-027 exists to prevent — arriving through the back door.
    for (let base = 1; base <= 2_000; base += 199) {
      const a = draws(new Rng(base), 64);
      const b = draws(new Rng(base + 1), 64);
      const shared = a.filter((v, i) => v === b[i]).length;
      assert.equal(shared, 0, `seeds ${base}/${base + 1} agreed on ${shared} of 64 draws`);
    }
  });

  test('the first draw of consecutive seeds is spread across the range', () => {
    // A generator seeded directly (no scrambling) walks its first output almost
    // linearly with the seed. This asserts we are not doing that.
    const firsts = Array.from({ length: 256 }, (_, i) => new Rng(1_000 + i).nextUint32());
    const buckets = new Set(firsts.map((v) => Math.floor(v / (2 ** 32 / 16))));
    assert.equal(buckets.size, 16, 'first draws cluster instead of spreading');
  });
});

describe('nextInt', () => {
  test('stays inside inclusive bounds, both ends reachable', () => {
    const rng = new Rng(DEV_SEED);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i += 1) {
      const v = rng.nextInt(3, 7);
      assert.ok(v >= 3 && v <= 7, `${v} outside [3,7]`);
      seen.add(v);
    }
    assert.deepEqual([...seen].sort((x, y) => x - y), [3, 4, 5, 6, 7]);
  });

  test('a single-value range is legal and constant', () => {
    const rng = new Rng(DEV_SEED);
    for (let i = 0; i < 20; i += 1) assert.equal(rng.nextInt(9, 9), 9);
  });

  test('is unbiased across a range that does not divide 2^32', () => {
    // 7 does not divide 2^32, which is exactly when floor(float * range) skews.
    const rng = new Rng(DEV_SEED);
    const counts = new Array<number>(7).fill(0);
    const n = 140_000;
    for (let i = 0; i < n; i += 1) { const v = rng.nextInt(0, 6); counts[v] = counts[v]! + 1; }
    for (const [i, c] of counts.entries()) {
      const deviation = Math.abs(c - n / 7) / (n / 7);
      assert.ok(deviation < 0.03, `bucket ${i} deviated ${(deviation * 100).toFixed(2)}%`);
    }
  });

  test('inverted or non-integer bounds throw', () => {
    const rng = new Rng(DEV_SEED);
    assert.throws(() => rng.nextInt(5, 4), /below min/);
    assert.throws(() => rng.nextInt(0.5, 4), /must be integers/);
  });
});

describe('weightedPick — how the §3 scenario distribution is realized', () => {
  test('realizes the declared weights', () => {
    const rng = new Rng(DEV_SEED);
    const entries = [
      { value: 'CLEAN_3WAY', weight: 36 },
      { value: 'TIMING_LAG_NORMAL', weight: 10 },
      { value: 'DUPLICATE_ROW', weight: 3 },
      { value: 'UNRESOLVABLE', weight: 7 },
    ];
    const total = entries.reduce((s, e) => s + e.weight, 0);
    const counts = new Map<string, number>();
    const n = 200_000;
    for (let i = 0; i < n; i += 1) {
      const v = rng.weightedPick(entries);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    for (const e of entries) {
      const observed = (counts.get(e.value) ?? 0) / n;
      const expected = e.weight / total;
      assert.ok(Math.abs(observed - expected) < 0.005,
        `${e.value}: expected ${expected.toFixed(4)}, observed ${observed.toFixed(4)}`);
    }
  });

  test('a zero-weight entry is never chosen', () => {
    // The fallback branch must not be a back door for an entry the caller excluded.
    const rng = new Rng(DEV_SEED);
    const entries = [{ value: 'yes', weight: 1 }, { value: 'never', weight: 0 }];
    for (let i = 0; i < 50_000; i += 1) assert.equal(rng.weightedPick(entries), 'yes');
  });

  test('weights need not sum to 1, and bad weights throw', () => {
    const rng = new Rng(DEV_SEED);
    assert.equal(rng.weightedPick([{ value: 'only', weight: 99 }]), 'only');
    assert.throws(() => rng.weightedPick([]), /no entries/);
    assert.throws(() => rng.weightedPick([{ value: 'x', weight: 0 }]), /total weight is zero/);
    assert.throws(() => rng.weightedPick([{ value: 'x', weight: -1 }]), /finite and >= 0/);
    assert.throws(() => rng.weightedPick([{ value: 'x', weight: NaN }]), /finite and >= 0/);
  });
});

describe('shuffle and sample', () => {
  test('shuffle is a permutation and leaves the input alone', () => {
    const source = Object.freeze(Array.from({ length: 40 }, (_, i) => i));
    const out = new Rng(DEV_SEED).shuffle(source);
    assert.notDeepEqual(out, [...source], 'a shuffle that changes nothing is suspicious');
    assert.deepEqual([...out].sort((a, b) => a - b), [...source]);
    assert.deepEqual(source, Array.from({ length: 40 }, (_, i) => i), 'input was mutated');
  });

  test('every position can receive every element', () => {
    // Catches the classic Fisher-Yates off-by-one (`nextInt(0, i-1)`), which
    // produces a valid-looking permutation that can never be the identity.
    const first = new Set<number>();
    for (let s = 0; s < 300; s += 1) first.add(new Rng(s).shuffle([0, 1, 2, 3])[0]!);
    assert.deepEqual([...first].sort(), [0, 1, 2, 3]);
  });

  test('sample takes k distinct items and refuses more than it has', () => {
    const rng = new Rng(DEV_SEED);
    const picked = rng.sample([1, 2, 3, 4, 5], 3);
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3);
    assert.deepEqual(rng.sample([1, 2, 3], 0), []);
    assert.throws(() => rng.sample([1, 2], 3), /cannot take 3 of 2/);
  });
});

describe('derive — named sub-streams', () => {
  test('the same label always gives the same stream', () => {
    assert.deepEqual(
      draws(new Rng(DEV_SEED).derive('defects')),
      draws(new Rng(DEV_SEED).derive('defects')));
  });

  test('different labels give different streams', () => {
    assert.notDeepEqual(
      draws(new Rng(DEV_SEED).derive('events'), 64),
      draws(new Rng(DEV_SEED).derive('defects'), 64));
  });

  test('deriving does not advance the parent', () => {
    // This is the whole point: adding a sub-stream must not shift anything that
    // was already being generated.
    const parent = new Rng(DEV_SEED);
    const before = parent.nextUint32();
    const fresh = new Rng(DEV_SEED);
    fresh.derive('a'); fresh.derive('b'); fresh.derive('c');
    assert.equal(fresh.nextUint32(), before);
  });

  test('sub-streams are independent of creation order', () => {
    const one = new Rng(DEV_SEED);
    const a1 = draws(one.derive('alpha'), 32);
    const two = new Rng(DEV_SEED);
    two.derive('beta'); two.derive('gamma');
    assert.deepEqual(draws(two.derive('alpha'), 32), a1);
  });

  test('DERIVATION DOES NOT CANCEL OR COMMUTE', () => {
    // An XOR-combined seed would fail all three of these: repeating a label would
    // land back on the parent's stream and hand out the same numbers twice, and
    // a/b would equal b/a.
    const root = new Rng(DEV_SEED);
    assert.notDeepEqual(draws(root.derive('x').derive('x'), 32), draws(new Rng(DEV_SEED), 32));
    assert.notDeepEqual(draws(root.derive('x').derive('x'), 32), draws(root.derive('x'), 32));
    assert.notDeepEqual(
      draws(root.derive('a').derive('b'), 32),
      draws(root.derive('b').derive('a'), 32));
  });

  test('the master seed survives derivation, for the manifest', () => {
    const child = new Rng(DEV_SEED).derive('events').derive('defects');
    assert.equal(child.seed, DEV_SEED,
      'the manifest must report the seed a reader supplies, not an internal one');
  });

  test('an empty label throws', () => {
    assert.throws(() => new Rng(DEV_SEED).derive(''), /non-empty/);
  });
});
