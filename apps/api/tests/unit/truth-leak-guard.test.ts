import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * ADR-021 — ground truth never enters the engine.
 *
 * This is the foundation of every accuracy claim in the project. "We checked and
 * nothing imports it" is an assertion about a moment in time; a failing test is a
 * property (testing-strategy §3).
 *
 * The guard scans CODE, not comments. A comment that mentions `data/truth` — and
 * several deliberately do, because the rule is worth restating where it matters —
 * is documentation, not a leak. A naive substring scan flags those and gets muted
 * or deleted the third time it cries wolf, which is how a guard stops guarding.
 * So comments and their contents are stripped first, with string literals
 * preserved, and the scan runs over what actually executes.
 */

const SRC = new URL('../../src/', import.meta.url).pathname;

/**
 * Remove comments while preserving string and template literals.
 * Not a full parser — it does not need to be. It needs to not mistake `//` inside
 * a URL string for the start of a comment, which a one-line regex does.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';

  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];

    switch (state) {
      case 'code':
        if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
        if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
        if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '`') state = 'template';
        out += c; i += 1; continue;

      case 'line':
        if (c === '\n') { state = 'code'; out += c; }
        i += 1; continue;

      case 'block':
        if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
        // Keep newlines so reported line numbers stay meaningful.
        if (c === '\n') out += c;
        i += 1; continue;

      case 'single':
      case 'double':
      case 'template': {
        if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
        const closer = state === 'single' ? "'" : state === 'double' ? '"' : '`';
        if (c === closer) state = 'code';
        out += c; i += 1; continue;
      }
    }
  }
  return out;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('no module under apps/api/src references data/truth', async () => {
  const files = await walk(SRC);
  assert.ok(files.length > 0, 'expected to find source files to scan');

  const offenders: string[] = [];
  for (const file of files) {
    const code = stripComments(await readFile(file, 'utf8'));
    if (/data[\/\\]truth/.test(code) || /\btruth\b[^\n]*\.json/.test(code)) {
      offenders.push(file.replace(SRC, ''));
    }
  }

  assert.deepEqual(
    offenders, [],
    `Ground truth must never be reachable from the engine (ADR-021). ` +
    `Offending files: ${offenders.join(', ')}`,
  );
});

test('the guard detects a real leak, and ignores one in a comment', () => {
  // A guard that cannot fail is not a guard. These two cases are the whole point:
  // the first must be caught, the second must not.
  const realLeak = stripComments(`import key from '../../data/truth/holdout.json';`);
  assert.match(realLeak, /data[\/\\]truth/, 'a genuine import must survive stripping');

  const commentOnly = stripComments(`// never import from data/truth (ADR-021)\nconst x = 1;`);
  assert.doesNotMatch(commentOnly, /data[\/\\]truth/, 'a comment must be stripped');

  const urlNotComment = stripComments(`const u = "https://example.com/a";\nconst v = 2;`);
  assert.match(urlNotComment, /https:\/\/example\.com\/a/, '// inside a string is not a comment');
});
