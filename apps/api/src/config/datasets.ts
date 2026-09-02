import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RunSources } from '../services/run/orchestrator.js';

/**
 * The datasets a run may be started against, and the loader that reads them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A HAND-MAINTAINED ALLOWLIST AND NOT A DIRECTORY SCAN.
 *
 * A dataset is offerable only if it has a committed ANSWER KEY: without one,
 * `score_reports` can never be populated for it, so two of the four headline
 * tiles render "not measured" (ADR-041, ADR-098) and the run makes the WEAKER
 * demo, not the stronger one. The obvious implementation — look for
 * `data/truth/<label>_seed_<seed>.json` — is exactly what **ADR-021 forbids**:
 * nothing under `apps/api` may reference `data/truth`, because ground truth
 * reachable from the engine invalidates every accuracy claim in the project.
 *
 * So the engine is told WHICH datasets are offerable and is never told why.
 * The "every offerable seed has a committed key" invariant is enforced from
 * outside, by `tools/generate/committed-datasets.test.ts`, which is allowed to
 * see both sides of the wall. Adding a row here without adding the key fails
 * that test.
 * ---------------------------------------------------------------------------
 */

export interface SeedDataset {
  /** The `datasetSeed` a caller passes to `POST /api/runs`. */
  readonly seed: number;
  /** Directory under `data/fixtures/`, and the answer key's filename prefix. */
  readonly label: string;
}

/** The reported dataset (ADR-027). Also what a run with no `datasetSeed` gets. */
export const HOLDOUT_SEED = 90_210;

/** The second committed dataset, so two runs can differ (ADR-117). */
export const DEMO_SEED = 20_260_905;

export const SEED_DATASETS: readonly SeedDataset[] = [
  { seed: HOLDOUT_SEED, label: 'holdout' },
  { seed: DEMO_SEED, label: 'demo' },
];

/**
 * DEV_SEED (1337) is deliberately absent. `data/fixtures/dev/` is gitignored so
 * that regenerating it during development cannot silently change a shipped
 * artifact, which also means it does not exist in a deployed environment.
 * Offering a seed that 500s everywhere but a developer's laptop is worse than
 * not offering it (ADR-117).
 */

export const DEFAULT_SEED = HOLDOUT_SEED;

export function findSeedDataset(seed: number): SeedDataset | undefined {
  return SEED_DATASETS.find((d) => d.seed === seed);
}

export const availableSeeds = (): number[] => SEED_DATASETS.map((d) => d.seed);

/** Thrown for a seed with no committed dataset. The route maps it to a 400. */
export class UnknownDatasetError extends Error {
  constructor(readonly seed: number) {
    super(`no committed dataset for seed ${seed}`);
    this.name = 'UnknownDatasetError';
  }
}

/**
 * Read per run rather than cached at boot, so the file hashes recorded on the
 * run always describe the bytes that run actually read. A cached copy would
 * make `input_file_hashes` a claim about start-up rather than about the run.
 */
export function readSeedDataset(seed: number | null): RunSources {
  const resolved = seed ?? DEFAULT_SEED;
  const dataset = findSeedDataset(resolved);
  if (!dataset) throw new UnknownDatasetError(resolved);

  const dir = fileURLToPath(new URL(`../../../../data/fixtures/${dataset.label}/`, import.meta.url));
  return {
    gateway: readFileSync(`${dir}gateway_export.csv`, 'utf8'),
    bank: readFileSync(`${dir}bank_settlement.csv`, 'utf8'),
    ledger: readFileSync(`${dir}merchant_ledger.csv`, 'utf8'),
  };
}
