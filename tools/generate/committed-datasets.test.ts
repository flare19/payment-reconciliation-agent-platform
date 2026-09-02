import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SEED_DATASETS } from '../../apps/api/src/config/datasets.js';

/**
 * THIS TEST EXISTS BECAUSE `apps/api` IS NOT ALLOWED TO WRITE IT.
 *
 * `config/datasets.ts` decides which datasets a run may be started against, and
 * the criterion is "it has a committed answer key" — because a dataset with no
 * key can never populate `score_reports`, so two of the four headline tiles
 * render "not measured" and the run makes the weaker demo (ADR-041, ADR-098).
 *
 * The engine cannot check that criterion itself. **ADR-021** forbids any module
 * under `apps/api` from referencing `data/truth`, because ground truth
 * reachable from the engine invalidates every accuracy claim in the project —
 * and the leak guard enforces it by grep, so even an `existsSync` would fail.
 *
 * So the registry is a hand-maintained allowlist inside the wall, and the
 * invariant that makes the allowlist honest is checked out here, where both
 * sides are visible. **Adding a seed to the registry without committing its
 * answer key fails this test**, which is the only thing keeping that allowlist
 * from becoming a comment.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

describe('every offerable dataset is actually committed, with its key', () => {
  for (const { seed, label } of SEED_DATASETS) {
    test(`${label} (seed ${seed}) — fixtures, key, and hashes that agree`, () => {
      const files = {
        gateway: `${ROOT}data/fixtures/${label}/gateway_export.csv`,
        bank: `${ROOT}data/fixtures/${label}/bank_settlement.csv`,
        ledger: `${ROOT}data/fixtures/${label}/merchant_ledger.csv`,
      } as const;
      const keyPath = `${ROOT}data/truth/${label}_seed_${seed}.json`;

      for (const [source, path] of Object.entries(files)) {
        assert.ok(existsSync(path), `${label}: ${source} fixture is missing at ${path}`);
      }
      assert.ok(existsSync(keyPath),
        `${label}: NO ANSWER KEY at ${keyPath}. A dataset without a key renders two `
        + 'headline tiles as "not measured" — remove it from SEED_DATASETS or generate the key.');

      const key = JSON.parse(readFileSync(keyPath, 'utf8')) as {
        manifest: { seed: number; fileHashes: Record<string, string> };
      };

      assert.equal(key.manifest.seed, seed,
        `${label}: the key at ${keyPath} was generated from a different seed`);

      // THE FIXTURES AND THE KEY MUST COME FROM THE SAME GENERATION. Regenerating
      // one without the other is silent: the engine reads bytes the key does not
      // describe, and every pair scored against it is scored against the wrong
      // answer. `tools/score` refuses to run on a mismatch (§2.4); this catches
      // it at commit time instead of at measurement time.
      for (const [source, path] of Object.entries(files)) {
        assert.equal(sha256(readFileSync(path, 'utf8')), key.manifest.fileHashes[source],
          `${label}: ${source} does not hash to what the answer key claims — `
          + 'fixtures and key are from different generations');
      }
    });

    test(`${label} (seed ${seed}) — both sides are tracked by git, not just present on disk`, () => {
      // `data/fixtures/dev/` exists on this machine and is gitignored. Presence
      // on a developer's disk says nothing about what a deployed environment
      // will find, and that difference is exactly why DEV_SEED is not offerable.
      const paths = [
        `data/fixtures/${label}/gateway_export.csv`,
        `data/fixtures/${label}/bank_settlement.csv`,
        `data/fixtures/${label}/merchant_ledger.csv`,
        `data/truth/${label}_seed_${seed}.json`,
      ];
      for (const p of paths) {
        const tracked = execSync(`git ls-files --error-unmatch "${p}" 2>/dev/null || true`,
          { cwd: ROOT, encoding: 'utf8' }).trim();
        assert.equal(tracked, p,
          `${label}: ${p} is not tracked by git — it will not exist when deployed`);
      }
    });
  }
});
