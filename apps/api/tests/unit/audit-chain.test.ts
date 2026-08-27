import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, canonicalize } from '../../src/services/audit/canonical-json.js';
import {
  computeEntryHash, toStoredForm, verifyChain, GENESIS_HASH,
  type HashableAuditEntry, type StoredAuditEntry,
} from '../../src/services/audit/hash-chain.js';

/** What a jsonb column does to a value: exactly what JSON can carry, nothing more. */
const throughJsonb = (v: unknown): unknown => JSON.parse(JSON.stringify(v) ?? 'null');

function entry(over: Partial<HashableAuditEntry> = {}): HashableAuditEntry {
  return {
    runId: '11111111-1111-1111-1111-111111111111',
    eventType: 'MATCH_CONFIRMED_EXACT', subjectType: 'match',
    subjectId: '22222222-2222-2222-2222-222222222222',
    transactionId: null, actorType: 'engine', actorId: 'matching-engine@1.0.0',
    tier: 'exact', ruleId: 'EXACT_PAYMENT_ID_V1', ruleVersion: '1.0.0',
    decision: 'matched', confidence: 1,
    beforeState: null, afterState: { matchId: 'm1' },
    reason: 'payment_id agrees on both sides.',
    details: {}, occurredAt: new Date('2026-08-27T10:00:00.000Z'),
    ...over,
  };
}

function chainOf(entries: HashableAuditEntry[]): StoredAuditEntry[] {
  let prev = GENESIS_HASH;
  return entries.map((e, i) => {
    const entryHash = computeEntryHash(e, prev);
    const stored: StoredAuditEntry = { ...e, sequenceNo: i + 1, prevHash: prev, entryHash };
    prev = entryHash;
    return stored;
  });
}

describe('canonical JSON — byte stability is the whole point', () => {
  test('KEY ORDER cannot change the bytes', () => {
    // The load-bearing case: Postgres jsonb does NOT preserve insertion order, so
    // an entry hashed before the write and verified after the read would disagree
    // on any object with more than one key.
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(
      canonicalJson({ z: { y: 1, x: 2 }, a: [3, 2, 1] }),
      canonicalJson({ a: [3, 2, 1], z: { x: 2, y: 1 } }));
  });

  test('ARRAY order IS preserved, because array order carries meaning here', () => {
    // secondaryFlags are in precedence order; candidate lists are ranked. Sorting
    // them would destroy information the entry is asserting.
    assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
    assert.equal(canonicalJson(['TIMING_DRIFT', 'AMOUNT_MISMATCH']),
                 '["TIMING_DRIFT","AMOUNT_MISMATCH"]');
  });

  test('absent and null normalise to one representation', () => {
    // `undefined` vanishes from JSON.stringify but round-trips from Postgres as
    // null. Both must hash the same or every nullable field breaks the chain.
    assert.equal(canonicalJson({ a: undefined }), canonicalJson({ a: null }));
    assert.equal(canonicalJson(undefined), 'null');
  });

  test('THE STORED FORM IS A FIXED POINT of a jsonb round trip', () => {
    // The assertion above only proves canonicalJson agrees with ITSELF. The threat
    // is that it disagrees with what the column actually holds, which is what
    // issue #17 was: `canonicalJson({a:undefined})` is `{"a":null}` and the stored
    // `JSON.stringify({a:undefined})` is `{}`. So the real invariant is that a
    // canonicalized value survives storage unchanged.
    const shapes: unknown[] = [
      null, undefined, {}, [], 0, -0, '', 'plain',
      { a: undefined }, { a: null }, { a: 1, b: undefined },
      { outer: { inner: { a: 1, b: undefined } } },
      { xs: [{ a: 1, b: undefined }, null, 3] },
      { at: new Date('2026-08-27T10:00:00.000Z') },
      { zebra: 1, alpha: { yankee: [3, 2, 1], bravo: 'x' }, mike: null },
      { 'key with spaces': 'v', 'ключ': 'значение' },
      { n: 1.1, big: 12345678901234567890, tiny: 1e-320 },
    ];
    for (const shape of shapes) {
      const once = canonicalize(shape as never);
      assert.equal(canonicalJson(once), canonicalJson(canonicalize(once)),
        `canonicalize is not idempotent for ${JSON.stringify(shape)}`);
      assert.equal(canonicalJson(once), canonicalJson(throughJsonb(once) as never),
        `the canonical form does not survive storage for ${JSON.stringify(shape)}`);
    }
  });

  test('Dates become ISO-8601 UTC, so a driver Date and a string agree', () => {
    const iso = '2026-08-27T10:00:00.000Z';
    assert.equal(canonicalJson(new Date(iso)), canonicalJson(iso));
  });

  test('values JSON cannot represent are refused, not silently nulled', () => {
    // JSON.stringify turns NaN and Infinity into `null`, which would make two
    // genuinely different entries hash identically.
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => canonicalJson(bad as number), /not representable/);
    }
    assert.throws(() => canonicalJson(new Date('nope')), /invalid Date/);
  });

  test('-0 and 0 cannot diverge', () => {
    assert.equal(canonicalJson(-0), canonicalJson(0));
  });

  test('unicode and control characters are stable', () => {
    for (const s of ['AMZN', 'Amazon Retail ✓', 'line\nbreak', '"quoted"', '\\slash', '₹1,234.50']) {
      assert.equal(canonicalJson(s), canonicalJson(s));
      assert.equal(JSON.parse(canonicalJson(s)), s, 'must round-trip through JSON.parse');
    }
  });

  test('the same logical object always produces identical bytes', () => {
    const build = (): unknown => ({
      details: { candidates: [{ id: 'b', score: 0.61 }, { id: 'a', score: 0.58 }] },
      reason: 'x', occurredAt: new Date('2026-08-27T10:00:00.000Z'),
    });
    const first = canonicalJson(build() as never);
    for (let i = 0; i < 50; i += 1) assert.equal(canonicalJson(build() as never), first);
  });
});

describe('entry hashing', () => {
  test('is deterministic for a given entry and predecessor', () => {
    const e = entry();
    const h = computeEntryHash(e, GENESIS_HASH);
    assert.match(h, /^[0-9a-f]{64}$/);
    for (let i = 0; i < 20; i += 1) assert.equal(computeEntryHash(e, GENESIS_HASH), h);
  });

  test('ANY change to a hashed field changes the hash', () => {
    const base = computeEntryHash(entry(), GENESIS_HASH);
    const mutations: Partial<HashableAuditEntry>[] = [
      { reason: 'something else' }, { actorId: 'someone-else' }, { decision: 'rejected' },
      { confidence: 0.99 }, { eventType: 'MATCH_CONFIRMED_FUZZY' }, { subjectId: 'other' },
      { transactionId: 'now-set' }, { details: { a: 1 } },
      { afterState: { matchId: 'm2' } }, { occurredAt: new Date('2026-08-27T10:00:01.000Z') },
      { runId: null }, { tier: 'fuzzy' }, { ruleVersion: '1.0.1' },
    ];
    for (const m of mutations) {
      assert.notEqual(computeEntryHash(entry(m), GENESIS_HASH), base,
        `changing ${Object.keys(m)[0]} must change the hash`);
    }
  });

  test('the same entry after a different predecessor hashes differently', () => {
    // This is what makes the chain a chain rather than a set of independent hashes.
    assert.notEqual(
      computeEntryHash(entry(), GENESIS_HASH),
      computeEntryHash(entry(), 'a'.repeat(64)));
  });

  test('key order in a details payload does not change the hash', () => {
    assert.equal(
      computeEntryHash(entry({ details: { b: 1, a: 2 } }), GENESIS_HASH),
      computeEntryHash(entry({ details: { a: 2, b: 1 } }), GENESIS_HASH));
  });
});

describe('the stored form is the hash input (issue #17)', () => {
  test('an undefined-valued key hashes as the null the column will return', () => {
    // "The field was not set" has ONE representation, and it is the one the column
    // holds. Before the fix the entry was hashed with "b":null while
    // JSON.stringify wrote the key away entirely, so the row read back could never
    // reproduce its own entry_hash.
    assert.equal(
      computeEntryHash(entry({ afterState: { a: 1, b: undefined } }), GENESIS_HASH),
      computeEntryHash(entry({ afterState: { a: 1, b: null } }), GENESIS_HASH),
    );
    // And still DIFFERENT from the key being absent: those are two different
    // stored values, and collapsing them would make two different entries hash
    // identically — the same failure the NaN guard exists to prevent.
    assert.notEqual(
      computeEntryHash(entry({ afterState: { a: 1, b: undefined } }), GENESIS_HASH),
      computeEntryHash(entry({ afterState: { a: 1 } }), GENESIS_HASH),
    );
  });

  test('details null, undefined and {} are one entry, because the column stores one', () => {
    // `details JSONB NOT NULL DEFAULT '{}'` — the column cannot hold null, so the
    // hash must not distinguish shapes it will collapse.
    const h = computeEntryHash(entry({ details: {} }), GENESIS_HASH);
    assert.equal(computeEntryHash(entry({ details: null }), GENESIS_HASH), h);
    assert.equal(computeEntryHash(entry({ details: undefined }), GENESIS_HASH), h);
  });

  test('toStoredForm is idempotent, so verification may apply it to a stored row', () => {
    const once = toStoredForm(entry({ details: { a: undefined }, afterState: null }));
    assert.equal(canonicalJson(once as never), canonicalJson(toStoredForm(once) as never));
  });

  test('a Date inside a JSON column hashes as the string the column returns', () => {
    const at = new Date('2026-08-27T10:00:00.000Z');
    assert.equal(
      computeEntryHash(entry({ details: { at } }), GENESIS_HASH),
      computeEntryHash(entry({ details: { at: at.toISOString() } }), GENESIS_HASH),
    );
  });

  test('the stored form still refuses what JSON cannot represent', () => {
    // Normalising must not become a way to smuggle NaN through as null: two
    // different entries hashing identically is the failure this guards.
    assert.throws(() => computeEntryHash(entry({ details: { n: NaN } }), GENESIS_HASH), /not representable/);
    assert.throws(() => computeEntryHash(entry({ details: { n: Infinity } }), GENESIS_HASH), /not representable/);
  });
});

describe('chain verification', () => {
  test('an intact chain verifies, and reports its head', () => {
    const chain = chainOf([entry(), entry({ reason: 'second' }), entry({ reason: 'third' })]);
    const r = verifyChain(chain);
    assert.equal(r.valid, true);
    assert.equal(r.entriesChecked, 3);
    assert.equal(r.firstDivergenceSequenceNo, null);
    assert.equal(r.divergenceKind, null);
    assert.equal(r.chainHead, chain[2]!.entryHash);
  });

  test('an empty chain is valid and heads at genesis', () => {
    const r = verifyChain([]);
    assert.equal(r.valid, true);
    assert.equal(r.chainHead, GENESIS_HASH);
  });

  test('EDITING an entry in place is detected, and named as such', () => {
    // The scenario ADR-042 exists for: someone with database access rewrites
    // history, having first dropped the append-only trigger.
    const chain = chainOf([entry(), entry({ reason: 'second' }), entry({ reason: 'third' })]);
    chain[1]!.reason = 'a reason nobody gave';
    const r = verifyChain(chain);
    assert.equal(r.valid, false);
    assert.equal(r.firstDivergenceSequenceNo, 2);
    assert.equal(r.divergenceKind, 'entry_altered');
  });

  test('REMOVING an entry is detected, and named differently', () => {
    // "Someone edited a row" and "someone removed a row" are different claims
    // about what happened. A verifier that reports only `false` makes the reader
    // guess which.
    const chain = chainOf([entry(), entry({ reason: 'second' }), entry({ reason: 'third' })]);
    const withHole = [chain[0]!, chain[2]!];
    const r = verifyChain(withHole);
    assert.equal(r.valid, false);
    assert.equal(r.divergenceKind, 'chain_broken');
    assert.equal(r.firstDivergenceSequenceNo, 3);
  });

  test('REORDERING is detected', () => {
    const chain = chainOf([entry(), entry({ reason: 'second' }), entry({ reason: 'third' })]);
    const swapped = [chain[0]!, chain[2]!, chain[1]!];
    assert.equal(verifyChain(swapped).valid, false);
  });

  test('appending a forged entry is detected', () => {
    // A forger can compute a valid hash for their own entry, but not one that
    // chains from the real head without also rewriting everything after it.
    const chain = chainOf([entry(), entry({ reason: 'second' })]);
    chain.push({
      ...entry({ reason: 'inserted later' }),
      sequenceNo: 3, prevHash: GENESIS_HASH,
      entryHash: computeEntryHash(entry({ reason: 'inserted later' }), GENESIS_HASH),
    });
    const r = verifyChain(chain);
    assert.equal(r.valid, false);
    assert.equal(r.divergenceKind, 'chain_broken');
    assert.equal(r.firstDivergenceSequenceNo, 3);
  });

  test('only the FIRST divergence is reported', () => {
    // After one alteration every later entry fails by construction; listing them
    // all would be thousands of rows describing one event.
    const chain = chainOf(Array.from({ length: 6 }, (_, i) => entry({ reason: `e${i}` })));
    chain[1]!.reason = 'tampered';
    chain[4]!.reason = 'also tampered';
    const r = verifyChain(chain);
    assert.equal(r.firstDivergenceSequenceNo, 2);
    assert.equal(r.entriesChecked, 2, 'verification stops at the first divergence');
  });

  test('a tampered entry whose hash was ALSO recomputed still breaks the chain', () => {
    // The realistic attack: edit the row and fix its own entry_hash. The chain
    // still catches it, because the NEXT entry's prev_hash no longer matches.
    const chain = chainOf([entry(), entry({ reason: 'second' }), entry({ reason: 'third' })]);
    chain[1]!.reason = 'tampered';
    // Simulate an attacker who recomputes CORRECTLY — strip the three non-hashed
    // fields exactly as verifyChain does, so this is the strongest version of the
    // attack rather than a botched one.
    const { sequenceNo, prevHash, entryHash, ...hashable } = chain[1]!;
    void sequenceNo; void entryHash;
    chain[1]!.entryHash = computeEntryHash(hashable, prevHash);
    const r = verifyChain(chain);
    assert.equal(r.valid, false);
    assert.equal(r.firstDivergenceSequenceNo, 3);
    assert.equal(r.divergenceKind, 'chain_broken',
      'covering your tracks on one row requires rewriting every row after it');
  });

  test('sequence_no is NOT hashed, so renumbering alone does not fail verification', () => {
    // Documented consequence of BIGSERIAL being DB-assigned: the hash cannot
    // include it. Ordering is guaranteed by prev_hash linkage instead, which is
    // the stronger property — this asserts the design, not an oversight.
    const chain = chainOf([entry(), entry({ reason: 'second' })]);
    chain[0]!.sequenceNo = 900;
    chain[1]!.sequenceNo = 901;
    assert.equal(verifyChain(chain).valid, true);
  });
});
