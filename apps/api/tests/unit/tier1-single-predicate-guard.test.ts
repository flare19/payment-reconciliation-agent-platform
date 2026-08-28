import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripComments } from './truth-leak-guard.test.js';

/**
 * schema.md §6.2 — Tier 1.5 substitutes learned aliases and **re-runs the
 * IDENTICAL Tier 1 test.**
 *
 * "Identical" is a structural requirement, not a style note. Two copies of the
 * exact-match predicate agree on the day the second one is written and drift
 * afterwards, and the drift is invisible: neither copy fails a test, the tiers
 * simply start disagreeing about what "exact" means. Tier attribution then
 * misreports which tier earned a match, which is a number the submission
 * publishes (validation-strategy §2.2 scores `viaTier`).
 *
 * This is the same guarantee `single-scorer-guard.test.ts` enforces for
 * `scorePair`, written before the code rather than after — both files are still
 * stubs. The checks are therefore CONDITIONAL on implementation and activate
 * themselves the moment it lands, so nobody has to remember to switch them on.
 *
 * A conditional guard risks being a guard that cannot fail (issue #11 found one
 * of those already), so the detector is exercised against synthetic sources at
 * the bottom of this file. That half is never vacuous.
 */

const SRC = new URL('../../src/', import.meta.url).pathname;
const TIER1 = 'services/matching/tier1-exact.ts';
const TIER1_5 = 'services/matching/tier1_5-alias.ts';

/** A file that exists only to be implemented later: no executable content but `export {}`. */
export function isStub(code: string): boolean {
  return stripComments(code).replace(/\s/g, '') === 'export{};';
}

/** Does this module re-run Tier 1's predicate rather than carrying its own? */
export function importsTier1(code: string): boolean {
  return /from\s+['"]\.\/tier1-exact(?:\.js)?['"]/.test(stripComments(code));
}

/** Tier 1.5 is an EXACT test after substitution, never a scored one (schema.md §6.2). */
export function importsScorer(code: string): boolean {
  return /from\s+['"]\.\/scoring(?:\.js)?['"]/.test(stripComments(code));
}

const read = (rel: string): Promise<string> => readFile(SRC + rel, 'utf8');

describe('Tier 1.5 re-runs Tier 1, it does not reimplement it (schema.md §6.2)', () => {
  test('once implemented, tier1_5-alias.ts imports the Tier 1 predicate', async () => {
    const code = await read(TIER1_5);
    if (isStub(code)) return;   // activates on implementation; see the meta-tests below
    assert.ok(importsTier1(code),
      `${TIER1_5} must call the predicate defined in ${TIER1}, not a copy of it. ` +
      `Two copies agree the day the second is written and drift silently after.`);
  });

  test('once implemented, tier1_5-alias.ts does not reach for the fuzzy scorer', async () => {
    // Tier 1.5 is an exact test on substituted values. Implementing it by scoring
    // would put alias-resolved pairs into the fuzzy band and quietly change tier
    // attribution for every merchant-variant match in the dataset.
    const code = await read(TIER1_5);
    if (isStub(code)) return;
    assert.ok(!importsScorer(code),
      `${TIER1_5} must not import the Tier 2 scorer. Tier 1.5 is exact-after-substitution.`);
  });

  test('the guard is inert only while BOTH tiers are unimplemented', async () => {
    // The one way a conditional guard goes wrong: Tier 1.5 lands, the author
    // leaves the Tier 1 stub in place and inlines the predicate, and the import
    // check above finds nothing to complain about because there is no seam yet.
    const [one, oneFive] = await Promise.all([read(TIER1), read(TIER1_5)]);
    if (isStub(oneFive)) return;
    assert.ok(!isStub(one),
      `${TIER1_5} is implemented while ${TIER1} is still a stub, which means the ` +
      `predicate was written somewhere other than the file that owns it.`);
  });
});

describe('the Tier 1 guard can actually fail', () => {
  // A guard that cannot fail is not a guard. These cases carry the whole weight
  // while both tiers are stubs.
  test('a stub is recognised as a stub, and real code is not', () => {
    assert.equal(isStub('// TODO: implement. Contract: docs/matching-engine.md.\nexport {};'), true);
    assert.equal(isStub('export function tier15(): void {}'), false);
    assert.equal(isStub('export {};\nexport const X = 1;'), false);
  });

  test('a genuine import is detected', () => {
    assert.equal(importsTier1(`import { matchesExactly } from './tier1-exact.js';`), true);
    assert.equal(importsTier1(`import { matchesExactly } from './tier1-exact';`), true);
  });

  test('an inlined copy is NOT mistaken for a re-run', () => {
    // The realistic failure: the author reimplements the predicate and says so in
    // a comment. The comment is stripped; only what executes counts.
    const copied = `// same predicate as tier1-exact.js, kept in sync by hand\n`
      + `function matchesExactly(a: unknown, b: unknown) { return a === b; }`;
    assert.equal(importsTier1(copied), false,
      'a comment naming tier1-exact must not satisfy the guard');
  });

  test('the scorer import is detected', () => {
    assert.equal(importsScorer(`import { scorePair } from './scoring.js';`), true);
    assert.equal(importsScorer(`import { x } from './tier1-exact.js';`), false);
  });
});
