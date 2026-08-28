/**
 * The generator's only source of randomness (validation-strategy.md §1, "Determinism").
 *
 * ===========================================================================
 * EVERYTHING THE PROJECT MEASURES DERIVES FROM THIS FILE.
 *
 * The dataset, the answer key and therefore every accuracy number are a pure
 * function of one integer seed. `Math.random()` and the wall clock appear nowhere
 * under `tools/` — enforced by a guard test, not by intention — because a demo
 * that silently drifts between rehearsal and submission cannot be honestly
 * measured, and a "what broke" investigation you cannot reproduce is a story
 * rather than a finding.
 *
 * NOT CRYPTOGRAPHIC. This produces reproducible synthetic test data. Nothing
 * here should be used for anything that needs to be unguessable.
 * ===========================================================================
 */

/** 2^32, as a float. The uint32 space every draw is taken from. */
const UINT32_SPAN = 4_294_967_296;

/**
 * splitmix32 — the SEED SCRAMBLER, and the reason it exists is ADR-027.
 *
 * The project develops against `DEV_SEED` and reports against `HOLDOUT_SEED`, and
 * that separation is worth nothing if the two datasets are correlated. Small
 * generators seeded directly from a raw integer produce visibly related output for
 * adjacent seeds — so seeds 90210 and 90211 would share structure, and tuning
 * against one would partially tune against the other. That is precisely the leak
 * ADR-027 exists to prevent, arriving through the back door.
 *
 * Every state word is drawn from this mixer instead, so adjacent seeds start from
 * unrelated states.
 */
function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e37_79b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0_aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a_2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/**
 * FNV-1a (32-bit), started from an arbitrary basis rather than the standard one.
 *
 * The basis is the PARENT stream's identity, which is what makes sub-stream
 * derivation ORDER-DEPENDENT and non-cancelling. An XOR-based combination would
 * be neither: `derive('a').derive('b')` would equal `derive('b').derive('a')`,
 * and worse, `derive('x').derive('x')` would collapse back onto the parent and
 * silently hand out the same stream twice.
 */
function fnv1a32From(basis: number, text: string): number {
  let h = basis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x0100_0193);
  }
  return h >>> 0;
}

export class Rng {
  /**
   * The MASTER seed, carried unchanged down every sub-stream. This is the number
   * recorded in the answer key's manifest (§2.4) and the number a reader supplies
   * to reproduce the dataset.
   */
  readonly seed: number;
  /**
   * This particular stream's identity. Equal to `seed` on the root; a function of
   * the parent's identity and the label on a derived stream. Kept separate from
   * `seed` so that "which seed made this dataset" stays one answer.
   */
  private readonly streamSeed: number;
  private a: number; private b: number; private c: number; private d: number;

  /**
   * `sfc32` — 128 bits of state across four words, all 32-bit integer operations,
   * which are exact and identical on every JS engine. A 32-bit-state generator
   * (mulberry32 and friends) would be shorter and is the usual reach for seeded
   * test data, but its period and its adjacent-seed behaviour are both weaker than
   * a file that decides what "the truth" is should rely on.
   */
  constructor(seed: number, streamSeed: number = seed) {
    if (!Number.isSafeInteger(seed)) {
      // A float seed silently truncating would make "the same seed" ambiguous,
      // which is the one thing this class exists to make unambiguous.
      throw new Error(`Rng: seed must be a safe integer, got ${String(seed)}`);
    }
    this.seed = seed;
    this.streamSeed = streamSeed | 0;
    const mix = splitmix32(this.streamSeed);
    this.a = mix(); this.b = mix(); this.c = mix(); this.d = mix();
  }

  /** The primitive draw. Everything else in this class is derived from it. */
  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / UINT32_SPAN;
  }

  /**
   * Uniform integer in [min, max], both ends INCLUSIVE.
   *
   * Rejection-sampled rather than `floor(float * range)`. The modulo bias that
   * introduces is tiny — parts in 10^-9 for the ranges here — and tiny is a bad
   * word to have to use about the process that generates ground truth. Rejection
   * costs a redraw on a vanishing fraction of calls and removes the sentence.
   */
  nextInt(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
      throw new Error(`Rng.nextInt: bounds must be integers, got [${min}, ${max}]`);
    }
    if (max < min) throw new Error(`Rng.nextInt: max ${max} is below min ${min}`);
    const range = max - min + 1;
    if (range > UINT32_SPAN) throw new Error('Rng.nextInt: range exceeds 2^32');
    const limit = Math.floor(UINT32_SPAN / range) * range;
    let draw = this.nextUint32();
    while (draw >= limit) draw = this.nextUint32();
    return min + (draw % range);
  }

  /** True with the given probability. `bool(0)` is never true; `bool(1)` always is. */
  bool(probability: number): boolean {
    if (!(probability >= 0 && probability <= 1)) {
      throw new Error(`Rng.bool: probability must be in [0,1], got ${probability}`);
    }
    return this.nextFloat() < probability;
  }

  /** Uniform choice. Throws on an empty list rather than returning undefined. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: cannot pick from an empty list');
    return items[this.nextInt(0, items.length - 1)]!;
  }

  /**
   * Weighted choice — how the §3 scenario distribution is realized.
   *
   * Weights are relative, not required to sum to 1, because §3 is written in
   * percentages and forcing a normalization step at the call site is an
   * opportunity to normalize wrongly.
   */
  weightedPick<T>(entries: readonly { value: T; weight: number }[]): T {
    if (entries.length === 0) throw new Error('Rng.weightedPick: no entries');
    let total = 0;
    for (const e of entries) {
      if (!(e.weight >= 0) || !Number.isFinite(e.weight)) {
        throw new Error(`Rng.weightedPick: weight must be finite and >= 0, got ${e.weight}`);
      }
      total += e.weight;
    }
    if (total <= 0) throw new Error('Rng.weightedPick: total weight is zero');

    let target = this.nextFloat() * total;
    for (const e of entries) {
      target -= e.weight;
      if (target < 0) return e.value;
    }
    // Floating-point accumulation can leave `target` at exactly 0 after the last
    // entry. Fall back to the last entry that could actually have been chosen,
    // never to a zero-weight one.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]!.weight > 0) return entries[i]!.value;
    }
    throw new Error('Rng.weightedPick: unreachable');
  }

  /** Fisher-Yates, returning a NEW array. In-place shuffling of a caller's list is a trap. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** `k` distinct items, in shuffled order. Throws rather than truncating silently. */
  sample<T>(items: readonly T[], k: number): T[] {
    if (k < 0 || k > items.length) {
      throw new Error(`Rng.sample: cannot take ${k} of ${items.length}`);
    }
    return this.shuffle(items).slice(0, k);
  }

  /**
   * A NAMED SUB-STREAM, derived from this stream's seed and the label alone.
   *
   * Why this exists: without it, every draw shares one sequence, so inserting a
   * single extra draw while iterating on defect logic reshuffles the entire
   * dataset — every event, every projection. Regenerate-and-compare, which is how
   * this generator will actually be developed and how a scoring regression gets
   * localised, becomes useless: the diff is always "everything changed".
   *
   * Sub-streams are independent of each other and of the order in which they are
   * created, and they do not advance the parent. §1's "everything derives from a
   * single seed" still holds exactly — this is a deterministic function of that
   * seed, not a second source of entropy.
   */
  derive(label: string): Rng {
    if (label === '') throw new Error('Rng.derive: label must be non-empty');
    return new Rng(this.seed, fnv1a32From(this.streamSeed, label) | 0);
  }
}
