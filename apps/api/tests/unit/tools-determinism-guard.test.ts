import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripComments } from './truth-leak-guard.test.js';

/**
 * validation-strategy.md §1 — "no `Math.random()`, no wall-clock, no `Date.now()`
 * anywhere in the generator. Same seed → byte-identical files and key."
 *
 * That sentence is the foundation of every accuracy number this project reports:
 * a dataset that drifts between rehearsal and submission cannot be measured
 * against a key, and a "what broke" investigation you cannot reproduce is a story
 * rather than a finding. One stray `Math.random()` — in a tie-break, in a jitter,
 * in a "just pick one" — removes the guarantee silently, because the output still
 * looks like plausible data.
 *
 * IT LIVES HERE, not under `tools/`, for one reason: `stripComments`. The guard
 * must scan code and not prose, and several comments under `tools/` name these
 * APIs precisely because the rule is worth restating where it matters —
 * `tools/generate/index.ts` says "No Math.random, no Date.now, anywhere". A
 * substring scan flags those, cries wolf, and gets deleted. The stripper already
 * exists in this package (ADR-021's leak guard), and copying it across the
 * package boundary to move this file 40 lines away would be a second
 * implementation of a parser to satisfy a filing preference.
 */

const TOOLS = new URL('../../../../tools/', import.meta.url).pathname;

/** Unseeded randomness and every wall-clock read. */
const FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\bMath\s*\.\s*random\b/, what: 'Math.random()' },
  { pattern: /\bDate\s*\.\s*now\b/, what: 'Date.now()' },
  { pattern: /\bnew\s+Date\s*\(/, what: 'new Date()' },
  { pattern: /\bperformance\s*\.\s*now\b/, what: 'performance.now()' },
  { pattern: /\bcrypto\s*\.\s*(randomUUID|randomBytes|getRandomValues)\b/, what: 'crypto randomness' },
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('the generator is a pure function of its seed', () => {
  test('nothing under tools/ reads the clock or draws unseeded randomness', async () => {
    const files = await walk(TOOLS);
    assert.ok(files.length > 0, 'expected to find files under tools/ to scan');

    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      for (const { pattern, what } of FORBIDDEN) {
        if (pattern.test(code)) offenders.push(`${file.replace(TOOLS, '')}: ${what}`);
      }
    }
    assert.deepEqual(offenders, [],
      'Everything in the generator derives from one seed (validation-strategy §1). ' +
      'A timestamp in the manifest is written by the caller, not read here.');
  });

  test('the guard detects a real call and ignores one in a comment', () => {
    // A guard that cannot fail is not a guard, and one that cries wolf gets deleted.
    const real = stripComments('const x = Math.random();');
    assert.ok(FORBIDDEN[0]!.pattern.test(real), 'a genuine call must survive stripping');

    const prose = stripComments('// No Math.random, no Date.now, anywhere.\nconst x = 1;');
    for (const { pattern, what } of FORBIDDEN) {
      assert.ok(!pattern.test(prose), `${what} in a comment must not be flagged`);
    }

    const blockProse = stripComments('/**\n * Determinism: no Date.now() in the decision path.\n */\nconst y = 2;');
    assert.ok(!FORBIDDEN[1]!.pattern.test(blockProse), 'a block comment must be stripped too');

    // Spacing and property access must not be an escape hatch.
    assert.ok(FORBIDDEN[0]!.pattern.test(stripComments('Math . random()')));
    assert.ok(FORBIDDEN[2]!.pattern.test(stripComments('const t = new Date();')));
  });
});
