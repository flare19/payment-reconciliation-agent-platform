import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripComments } from './truth-leak-guard.test.js';

/**
 * ADR-049 — the agent never does arithmetic.
 *
 * The guarantee is that `scorePair` in services/matching/scoring.ts is called by
 * BOTH the engine at S9 and the Analyst's `score_pair` tool, so a number in a
 * reasoning chain is always a number the engine computed. That guarantee is worth
 * exactly as much as the claim that there is only ONE implementation.
 *
 * A comment saying "this is the only scorer" is a hope. This is the check.
 *
 * It is deliberately structural rather than behavioural: a second implementation
 * would not fail any existing test — it would agree with the first one on the day
 * it was written and drift later, which is precisely the failure that is
 * impossible to notice in a diff.
 */

const SRC = new URL('../../src/', import.meta.url).pathname;
const SCORING = 'services/matching/scoring.ts';

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

async function definitionsOf(pattern: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await walk(SRC)) {
    const code = stripComments(await readFile(file, 'utf8'));
    if (pattern.test(code)) hits.push(file.replace(SRC, ''));
  }
  return hits;
}

describe('single-implementation guarantees', () => {
  test('exactly one scorePair definition, and it lives in scoring.ts', async () => {
    const hits = await definitionsOf(/(?:export\s+)?function\s+scorePair\b/);
    assert.deepEqual(hits, [SCORING],
      'scorePair must be defined once. The agent and the engine call the same function (ADR-049).');
  });

  test('exactly one trigramSimilarity definition', async () => {
    const hits = await definitionsOf(/(?:export\s+)?function\s+trigramSimilarity\b/);
    assert.deepEqual(hits, [SCORING],
      'Two similarity functions disagreeing by 0.01 is a silent accuracy bug.');
  });

  test('exactly one edit-distance definition', async () => {
    const hits = await definitionsOf(/function\s+damerauLevenshtein\w*\b/);
    assert.deepEqual(hits, [SCORING]);
  });

  test('no module outside scoring.ts computes a similarity of its own', async () => {
    // Catches the realistic drift: someone needs "just a quick name comparison"
    // in the classifier or an agent tool and writes a second one inline.
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      const rel = file.replace(SRC, '');
      if (rel === SCORING) continue;
      const code = stripComments(await readFile(file, 'utf8'));
      if (/function\s+\w*(?:[Ss]imilarity|[Tt]rigram|[Ll]evenshtein|[Jj]aro|[Ww]inkler)\w*\s*\(/.test(code)) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [],
      `Similarity belongs in ${SCORING} only (ADR-049).`);
  });

  test('the agent services directory contains no scoring arithmetic', async () => {
    // ADR-049 in its sharpest form: the agent chooses which questions to ask,
    // deterministic code computes every answer.
    const offenders: string[] = [];
    for (const file of await walk(join(SRC, 'services', 'agent'))) {
      const code = stripComments(await readFile(file, 'utf8'));
      if (/\bscoreWeights\b|\bround4\s*\(|\bMath\.round\s*\([^)]*\*\s*10_?000/.test(code)) {
        offenders.push(file.replace(SRC, ''));
      }
    }
    assert.deepEqual(offenders, [],
      'The agent must call scorePair, never recompute a score (ADR-049).');
  });
});
