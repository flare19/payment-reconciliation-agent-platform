/**
 * Synthetic data generator (Day 5-6). Contract: docs/validation-strategy.md §1-4.
 *
 * TRUTH FIRST — this is the whole design. The generator does not create messy
 * files and then work out what should match. It creates economic events, projects
 * them into source rows under a weighted scenario distribution, and writes the
 * answer key IN THE SAME PASS from the same in-memory structure. The key is a
 * byproduct of generation, not a post-hoc annotation, so it cannot disagree with
 * the data.
 *
 * Two constraints the classifier depends on (get these wrong and the engine looks
 * broken for reasons that are actually the generator's fault) — enforced by
 * invariants.ts, not merely stated here:
 *  - DUPLICATE_ROW must emit its copy carrying the SAME STRONG ANCHOR. Duplicates
 *    are detected by anchor evidence, never by amount+date+counterparty similarity,
 *    because IDENTITY_DESTROYED deliberately plants 3+ same-amount/day/merchant
 *    anchorless rows (ADR-034).
 *  - For every non-AMOUNT_TRUE_MISMATCH event, ledger `net_amount` must equal
 *    gateway `amount` EXACTLY. Gateway amount is what the customer was charged,
 *    which is ledger net — not ledger gross (ADR-037).
 *
 * Unresolvability is PROVEN during generation, not merely labelled
 * (validation-strategy §4) — proofs.ts, run below with bounded, deterministic
 * regeneration on failure.
 *
 * Determinism: a single seeded PRNG (prng.ts). No Math.random, no Date.now,
 * anywhere under tools/ — enforced by a guard test, not by intention.
 */

import { Rng } from './prng.js';
import { planEvents, type EventPlanOptions, type EventPlan } from './events.js';
import { plantIdentityClusters, type IdentityCluster } from './planting.js';
import {
  projectEvent, projectUnsplittableEvent, projectNoise, resetSequentialIds,
} from './project.js';
import { proveIdentityDestroyed, proveOrphanHasNoCounterpart, proveUnsplittableBatch, proveWithRegeneration } from './proofs.js';
import { buildProofPool } from './pool.js';
import { assertProjectionInvariants } from './invariants.js';
import { buildAnswerKey, serializeAnswerKey, type AnswerKey } from './answer-key.js';
import { serializeToCsv, type EmittedFiles } from './csv.js';
import type { EconomicEvent } from './events.js';
import type { BankRow, EventProjection, GatewayRow, ProjectedRow, ProjectionResult } from './projection.js';
import { ENGINE_DEFAULTS } from '../../apps/api/src/config/defaults.js';
import type { RunConfig } from '../../apps/api/src/types/engine.js';

const DEV_SEED = 1_337;
const HOLDOUT_SEED = 90_210;

export interface GenerateOptions {
  seed: number;
  eventPlan?: Partial<EventPlanOptions>;
  noiseGatewayCount?: number;
  noiseLedgerCount?: number;
  config?: RunConfig;
  /** Bounded, per ADR: no infinite retry loop, and the ceiling is a stated number. */
  maxProofAttempts?: number;
  /** Merchant-name variants the alias table is pre-populated with. Empty = fully cold (§2.3, ADR-020). */
  seededVariants?: ReadonlySet<string>;
}

export interface GeneratedDataset {
  files: { gateway: string; bank: string; ledger: string };
  answerKey: AnswerKey;
  answerKeyJson: string;
}

const DEFAULT_CONFIG: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-20', aliasCountAtStart: 0 };

/**
 * A placeholder, PRE-EMISSION row number for the proof pool only.
 *
 * `buildBatchPool`'s ranking uses `compareCanonical` as a tie-break, which reads
 * `sourceRowNumber` — but the REAL file position is not decided until
 * `serializeToCsv` shuffles the rows (schema.md §3's actual join key). Using an
 * arbitrary stable index here instead only affects which of several EXACTLY TIED
 * candidates the cap keeps, never WHETHER a valid subset exists, so it cannot
 * turn a genuine proof into a false one.
 */
function withPlaceholderRowNumbers(
  gatewayRows: readonly GatewayRow[],
): { row: GatewayRow; sourceRowNumber: number }[] {
  return gatewayRows.map((row, i) => ({ row, sourceRowNumber: i + 1 }));
}

/**
 * Generate one dataset, deterministically, from `options.seed` alone.
 *
 * Order matters here in a way it does not elsewhere in this package: every
 * OTHER event (including `IDENTITY_DESTROYED`, whose construction is
 * self-contained) is projected first, because `ORPHAN_NO_COUNTERPART` and
 * `UNSPLITTABLE_NET_BATCH` need the WHOLE realized gateway population to prove
 * against (pool.ts's own note explains why the full population is the
 * conservative, sufficient choice). Regenerating one of those two never
 * perturbs that population — `UNSPLITTABLE_NET_BATCH`'s own gateway/ledger pair
 * is fixed across credit retries (see project.ts), and `ORPHAN_NO_COUNTERPART`
 * never contributes a gateway row at all — so the pool built once here stays
 * valid through every retry.
 */
export function generate(options: GenerateOptions): GeneratedDataset {
  const {
    seed, noiseGatewayCount = 25, noiseLedgerCount = 12, config = DEFAULT_CONFIG,
    maxProofAttempts = 20, seededVariants = new Set<string>(),
  } = options;

  resetSequentialIds();
  const rng = new Rng(seed);

  const plan: EventPlan = planEvents(rng, {
    count: options.eventPlan?.count ?? 300,
    windowEndDate: options.eventPlan?.windowEndDate ?? '2026-08-20',
    windowDays: options.eventPlan?.windowDays ?? 30,
    ...(options.eventPlan?.specs !== undefined ? { specs: options.eventPlan.specs } : {}),
  });
  const { events, identityClusters } = plantIdentityClusters(rng, plan.events);

  const batchEvents = events.filter((e) => e.scenario === 'UNSPLITTABLE_NET_BATCH');
  const orphanEvents = events.filter((e) => e.scenario === 'ORPHAN_NO_COUNTERPART');
  const otherEvents = events.filter(
    (e) => e.scenario !== 'UNSPLITTABLE_NET_BATCH' && e.scenario !== 'ORPHAN_NO_COUNTERPART');

  // ─── pass 1: everything whose proof (if any) is purely local ────────────────
  const projections = new Map<string, ProjectedRow[]>();
  for (const event of otherEvents) projections.set(event.eventId, projectEvent(rng, event, config));

  // UNSPLITTABLE_NET_BATCH's gateway/ledger pair is fixed at attempt 0 for every
  // member before any credit retry happens, so the pool assembled below already
  // reflects its final shape.
  const batchCredits = new Map<string, BankRow>();
  for (const event of batchEvents) {
    const { rows, credit } = projectUnsplittableEvent(rng, event, config, 0);
    projections.set(event.eventId, rows);
    batchCredits.set(event.eventId, credit);
  }

  // ─── the whole-dataset gateway pool, built ONCE ──────────────────────────────
  const allGatewayRows: GatewayRow[] = [];
  for (const rows of projections.values()) {
    for (const r of rows) if (r.sourceSystem === 'gateway') allGatewayRows.push(r);
  }
  const gatewayForPool = withPlaceholderRowNumbers(allGatewayRows);

  // ─── pass 2: UNSPLITTABLE_NET_BATCH — prove, regenerating the credit alone ──
  for (const event of batchEvents) {
    const rows = projections.get(event.eventId)!;
    const proven = proveWithRegeneration(
      maxProofAttempts,
      (attempt) => projectUnsplittableEvent(rng, event, config, attempt),
      (candidate) => {
        const { poolRows, capped } = buildProofPool(candidate.credit, 0, gatewayForPool, config);
        if (capped) {
          return [{ proof: 'UNSPLITTABLE_BATCH/pool-not-capped', eventId: event.eventId,
            detail: `eligible pool exceeds batchPoolCap (${config.batchPoolCap}); ` +
              'the proof would rest on a truncated pool rather than the true eligible set' }];
        }
        return proveUnsplittableBatch(candidate.credit, poolRows, event.eventId, config);
      },
      `UNSPLITTABLE_NET_BATCH ${event.eventId}`,
    );
    // Splice the (possibly regenerated) credit back into this event's rows —
    // the gateway/ledger pair is unchanged; only the trailing credit differs.
    projections.set(event.eventId, [...rows.slice(0, -1), proven.credit]);
  }

  // ─── ORPHAN_NO_COUNTERPART — prove, regenerating the whole row ──────────────
  for (const event of orphanEvents) {
    const proven = proveWithRegeneration(
      maxProofAttempts,
      (attempt) => projectEvent(rng, event, config, attempt)[0] as BankRow,
      (bankRow) => proveOrphanHasNoCounterpart(bankRow, allGatewayRows, event.eventId, config),
      `ORPHAN_NO_COUNTERPART ${event.eventId}`,
    );
    projections.set(event.eventId, [proven]);
  }

  // ─── IDENTITY_DESTROYED — verify, never expected to need a retry ────────────
  // Construction is deterministic-safe by design (planting.ts fixes the shared
  // canonical facts; projectIdentityDestroyed unconditionally destroys every
  // gateway anchor), so a failure here is a real bug in this file, not a rare
  // randomness collision — hence no regeneration loop, just a loud throw.
  const eventProjections: EventProjection[] = events.map((event) =>
    ({ event, rows: projections.get(event.eventId)! }));
  const identityFailures = proveIdentityDestroyed({ events: eventProjections, noise: { rows: [] } }, identityClusters);
  if (identityFailures.length > 0) {
    throw new Error(
      `generate: ${identityFailures.length} IDENTITY_DESTROYED cluster(s) failed proof, which should be ` +
      `structurally impossible given how they are constructed — this is a bug in project.ts or planting.ts, ` +
      `not randomness:\n${identityFailures.map((f) => `  [${f.proof}] ${f.eventId}: ${f.detail}`).join('\n')}`);
  }

  // ─── noise, invariants, emission, key ────────────────────────────────────────
  const noise = projectNoise(rng, plan.window.startDate, plan.window.days, noiseGatewayCount, noiseLedgerCount);
  const result: ProjectionResult = { events: eventProjections, noise: { rows: noise } };

  // The last local safety net before anything is written: every G3 invariant,
  // over the FINAL, post-regeneration dataset.
  assertProjectionInvariants(result, config);

  const files: EmittedFiles = serializeToCsv(rng, result);
  const answerKey = buildAnswerKey({
    seed, events, realizedDistribution: plan.realizedDistribution, emitted: files.emitted,
    identityClusters, files: { gateway: files.gateway, bank: files.bank, ledger: files.ledger },
    seededVariants, config,
  });

  return {
    files: { gateway: files.gateway, bank: files.bank, ledger: files.ledger },
    answerKey,
    answerKeyJson: serializeAnswerKey(answerKey),
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
// `npm run generate` with no arguments produces the shipped HOLDOUT_SEED
// dataset (deployment.md §"Commit the three source files..."). A seed and label
// may be overridden for local iteration; neither is read from the environment or
// the clock, keeping the process itself a pure function of its argv.

async function main(): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const [, , seedArg, labelArg] = process.argv;
  const seed = seedArg === undefined ? HOLDOUT_SEED
    : seedArg === 'dev' ? DEV_SEED
    : Number(seedArg);
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`generate: seed argument must be an integer or "dev", got "${seedArg}"`);
  }
  const label = labelArg ?? (seed === HOLDOUT_SEED ? 'holdout' : seed === DEV_SEED ? 'dev' : String(seed));

  const dataset = generate({ seed });

  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const fixturesDir = join(root, 'data', 'fixtures', label);
  const truthDir = join(root, 'data', 'truth');
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(truthDir, { recursive: true });

  await writeFile(join(fixturesDir, 'gateway_export.csv'), dataset.files.gateway, 'utf8');
  await writeFile(join(fixturesDir, 'bank_settlement.csv'), dataset.files.bank, 'utf8');
  await writeFile(join(fixturesDir, 'merchant_ledger.csv'), dataset.files.ledger, 'utf8');
  const keyPath = join(truthDir, `${label}_seed_${seed}.json`);
  await writeFile(keyPath, dataset.answerKeyJson, 'utf8');

  console.log(`Wrote ${fixturesDir}/{gateway_export,bank_settlement,merchant_ledger}.csv`);
  console.log(`Wrote ${keyPath}`);
  console.log(
    `${dataset.answerKey.manifest.eventCount} events, ` +
    `${dataset.answerKey.manifest.recordCounts.gateway + dataset.answerKey.manifest.recordCounts.bank + dataset.answerKey.manifest.recordCounts.ledger} records, ` +
    `${dataset.answerKey.manifest.unresolvableEventCount} designed-unresolvable, ` +
    `ceiling ${dataset.answerKey.manifest.theoreticalMaxMatchRatePct}%`);
}

// Only run when invoked directly (`npm run generate`), never on import — every
// test in this package imports `generate` without wanting a CLI run to fire.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
