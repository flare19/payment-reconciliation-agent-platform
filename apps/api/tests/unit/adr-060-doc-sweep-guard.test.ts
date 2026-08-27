import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * ADR-060 (amended by ADR-063) changed S10's bounds from 250 ms / 200,000
 * nodes to a 1,300,000-node primary budget with a 2 s safety valve, and
 * `searchBoundExceeded` is an object (`{ bound, value }`), not a boolean.
 *
 * "I checked the docs" is a moment in time; a failing test is a property
 * (the same reasoning as `truth-leak-guard.test.ts`). This has no natural
 * unit test of its own — it exists to keep the S10 bound numbers from
 * drifting out of sync across the docs the way they did before (issue #3).
 *
 * `docs/adr-log.md` and `docs/what-broke.md` are DELIBERATELY EXCLUDED: the
 * ADR log is append-only (CLAUDE.md §9.2) and its historical entries are
 * allowed to describe numbers that were later superseded — that history is
 * corrected by appending a new ADR (see ADR-063 and the Superseded section),
 * never by editing the old entry. `what-broke.md` narrates past mistakes in
 * the first person and is expected to still say what the wrong number *was*.
 */

const DOCS = new URL('../../../../docs/', import.meta.url).pathname;
const API_SRC = new URL('../../src/', import.meta.url).pathname;
const API_TESTS = new URL('../', import.meta.url).pathname;

const EXCLUDED_DOCS = new Set(['adr-log.md', 'what-broke.md']);

const STALE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: '250 ms figure from the old ADR-038 bound', pattern: /250\s?ms/i },
  { name: '200,000-node figure from the old ADR-060 bound', pattern: /200,000|200k nodes/i },
  { name: 'searchBoundExceeded described as a boolean', pattern: /searchBoundExceeded[:`]*\s*`?\s*:?\s*true/ },
];

async function docFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(DOCS, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md') && !EXCLUDED_DOCS.has(entry.name)) {
      out.push(join(DOCS, entry.name));
    }
  }
  return out;
}

test('no doc (other than the append-only ADR log and what-broke.md) states the pre-ADR-063 S10 bound numbers', async () => {
  for (const path of await docFiles()) {
    const text = await readFile(path, 'utf8');
    for (const { name, pattern } of STALE_PATTERNS) {
      assert.doesNotMatch(text, pattern, `${path} still states the ${name}`);
    }
  }
});

test('config/env.ts does not default BATCH_SUBSET_BUDGET_MS to the stale 250 ms figure', async () => {
  const text = await readFile(join(API_SRC, 'config/env.ts'), 'utf8');
  assert.doesNotMatch(text, /BATCH_SUBSET_BUDGET_MS['"],\s*250\)/,
    'env.ts still defaults the safety valve to 250ms, which would fire before the node budget on a large search');
});

test('the batch-decomposition test comments do not cite the stale 200k node figure', async () => {
  const text = await readFile(join(API_TESTS, 'unit/batch-decomposition.test.ts'), 'utf8');
  for (const { name, pattern } of STALE_PATTERNS) {
    assert.doesNotMatch(text, pattern, `batch-decomposition.test.ts still states the ${name}`);
  }
});
