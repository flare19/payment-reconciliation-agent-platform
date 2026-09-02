import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { aliasProposals } from '../../src/routes/matches.js';
import { ERROR_CODES } from '../../src/types/dto.js';

/**
 * `ALIAS_CONFLICT_UNCONFIRMED` was declared in `ERROR_CODES`, promised by
 * `api-contract.md`, fully handled by `ReviewCard` — and **thrown nowhere**.
 * Proposing a different canonical for an active key returned 200 and silently
 * superseded a correct rule (ADR-131).
 *
 * That is the sixth "declared and never reached" defect in this project, so the
 * guard here is deliberately structural rather than behavioural: it asserts the
 * code is REACHABLE from the source, which is the property that was missing.
 * The behaviour itself needs a database and lives in the integration suite.
 */

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('the alias conflict interlock is reachable (ADR-131)', () => {
  test('ALIAS_CONFLICT_UNCONFIRMED is referenced outside its own declaration', () => {
    /**
     * The narrow, checkable form of "declared and never reached". A code is
     * raised in two ways here — `new ApiError(status, CODE, …)` directly, and
     * `found(value, CODE, …)` via the helper — so the honest test is that the
     * literal appears in a module OTHER than the enum that declares it.
     *
     * Before ADR-131 this string existed in exactly one place, `types/dto.ts`,
     * while `api-contract.md` promised it and `ReviewCard` handled it.
     */
    const CODE = 'ALIAS_CONFLICT_UNCONFIRMED';
    assert.ok(ERROR_CODES.includes(CODE), 'the code should still be declared');

    const users = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('types', 'dto.ts')))
      .filter((f) => readFileSync(f, 'utf8').includes(`'${CODE}'`));

    assert.ok(users.length > 0,
      `${CODE} is declared in types/dto.ts and referenced by no other module — `
      + 'it cannot be emitted, and the contract promises it');
  });

  test('a proposal carries confirmConflict through validation', () => {
    // It was stripped: the validator returned four fields and the interlock had
    // no way to know the reviewer had already agreed to replace the rule.
    const [p] = aliasProposals([{
      aliasType: 'counterparty_name', rawValue: 'A', canonicalValue: 'B', confirmConflict: true,
    }]);
    assert.equal(p!.confirmConflict, true);
  });

  test('confirmConflict defaults to FALSE, so silence never means consent', () => {
    const [p] = aliasProposals([
      { aliasType: 'counterparty_name', rawValue: 'A', canonicalValue: 'B' },
    ]);
    assert.equal(p!.confirmConflict, false);
    // And only an exact `true` counts — a truthy string must not pass.
    const [q] = aliasProposals([{
      aliasType: 'counterparty_name', rawValue: 'A', canonicalValue: 'B', confirmConflict: 'yes',
    }]);
    assert.equal(q!.confirmConflict, false);
  });
});
