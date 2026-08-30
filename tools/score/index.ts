/**
 * Offline scorer (U9). Contract: docs/validation-strategy.md §5.
 *
 * Reads engine output from the API and the answer key from disk, joins them on
 * (sourceSystem, sourceRowNumber), and POSTs a score report to endpoint 23.
 *
 * This is the ONLY place ground truth is read (ADR-021). It lives outside
 * `apps/api` on purpose: leak-freedom should be obvious to a reader in five
 * seconds rather than something you audit.
 *
 * Refuses to run if the key's manifest hashes disagree with the run's
 * `inputFileHashes` — scoring against the wrong dataset should be impossible,
 * not something you notice late. The check holds from both ends: this refuses
 * to read, and endpoint 23 refuses to store (`422 TRUTH_KEY_MISMATCH`).
 *
 * Reports, per validation-strategy §5:
 *   pairwise precision / recall / F1 + RAW false-positive count
 *   8×8 classification confusion matrix
 *   accuracy by difficulty (EASY/MEDIUM/HARD)
 *   unresolvable recall  ← below 100% is a BUILD BLOCKER, not a metric
 *   false-despair rate   ← the engine's honest headroom, and the Analyst's market
 *   review-queue precision (pending_review scored separately — ADR-040)
 *   tier attribution  ← the key's viaTier distribution vs the engine's per-tier
 *                       PAIR counts. A DIAGNOSTIC, never an accuracy term.
 *   Analyst: false-despair recovered, proposal precision,
 *            HALLUCINATED RESOLUTIONS (must be 0 — ADR-053), unresolvable agreement
 *
 * ── READ ADR-072 AND §5.1.2 BEFORE JOINING ANYTHING ON TIER ──
 * `viaTier` is not comparable to `matches.tier`. The key labels a PAIR; the
 * engine reports a GROUP, at the WEAKEST tier among its constituent pairs
 * (matching-engine.md §10 rule 5). On the holdout 413 of 658 matched pairs
 * (63%) disagree — 375 of them a Tier 1 pair sitting in a group correctly
 * reported `fuzzy` because it also holds a fuzzy third leg. Every one of those
 * is matched correctly and completely.
 *
 * Correctness is PAIR MEMBERSHIP alone: did the engine put these two records in
 * one group? Two further cases, neither a recall miss:
 *   · tier fall-through (gateway<->bank labelled `exact`, reached at Tier 2)
 *     is matched, not missed;
 *   · a pair whose EVENT-level expectedOutcome is EXCEPTION is scored against
 *     the classification key (§5.2), never against the pairing key — the
 *     AMOUNT_TRUE_MISMATCH case, where the pair key says shouldMatch: true and
 *     the engine is right to refuse.
 *
 * ── EXIT CODES, because this is a build gate as well as a report ──
 *   0  scored, and every honesty gate passed
 *   1  usage / transport / hash-mismatch failure — nothing was scored
 *   2  scored, but a BUILD BLOCKER fired (§5.3: the engine invented a match on a
 *      designed-unresolvable event, or §5.2's S8 regression cells are non-zero)
 * A scorer that exits 0 on a build blocker is a scorer nobody will notice.
 *
 * Usage:
 *   npm run score -- --run <runId> [--key data/truth/holdout_seed_90210.json]
 *                    [--api http://localhost:3001] [--post] [--out report.json]
 * `--post` is opt-in: reading is safe, writing a measurement into the database
 * is not something a dry run should do by accident.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  scoreMatching, scoreClassification, scoreResolvability, scoreByDifficulty,
  tierDiagnostic, round4,
  type AnswerKey, type EngineSnapshot, type EngineRecord, type EngineMatch,
  type EngineException,
} from './scoring.js';

export const SCORER_VERSION = '1.2.0';

interface Args {
  runId: string; keyFile: string; api: string; post: boolean; out: string | null;
}

export function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
  };
  const runId = get('run');
  if (runId === null) {
    throw new Error('usage: npm run score -- --run <runId> [--key <file>] [--api <url>] [--post]');
  }
  return {
    runId,
    keyFile: get('key') ?? 'data/truth/holdout_seed_90210.json',
    api: get('api') ?? process.env['SCORE_API_URL'] ?? 'http://localhost:3001',
    post: argv.includes('--post'),
    out: get('out'),
  };
}

/**
 * The key's own bytes, hashed. Stored on the report so a reader can prove which
 * key produced which number — `truth_key_hash` in schema.md §11.2.
 */
export function hashKeyFile(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Refuse to score a run whose inputs are not the ones the key describes.
 *
 * The manifest records a content hash per emitted source file; the engine
 * records the same hashes independently in `runs.input_file_hashes`. Comparing
 * them is what makes "we scored against the wrong dataset" structurally
 * impossible rather than a thing you discover after publishing.
 *
 * `runs.input_file_hashes` carries a `sha256:` prefix; the manifest does not.
 * Compared on the bare digest, sorted, so neither format nor key order matters.
 */
export function assertSameDataset(
  manifestHashes: Record<string, string>, runHashes: Record<string, string>,
): void {
  const bare = (v: string): string => v.replace(/^sha256:/, '').toLowerCase();
  const key = Object.values(manifestHashes).map(bare).sort();
  const run = Object.values(runHashes).map(bare).sort();
  if (key.length === 0 || run.length === 0 || key.join('|') !== run.join('|')) {
    throw new Error(
      `TRUTH_KEY_MISMATCH: this run did not ingest the files this answer key describes.\n` +
      `  key manifest: ${key.join(', ') || '(none)'}\n` +
      `  run ingested: ${run.join(', ') || '(none)'}\n` +
      `Scoring a run against a key built from different bytes is refused, not warned about.`);
  }
}

/** Endpoint pagination caps at 200; walk it rather than assuming one page. */
async function fetchAll<T>(api: string, path: string, field: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 1000; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${api}${path}${sep}page=${page}&pageSize=200`);
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
    const body = await res.json() as Record<string, unknown>;
    out.push(...((body[field] ?? []) as T[]));
    const pg = body['pagination'] as { totalPages?: number } | undefined;
    if (pg?.totalPages === undefined || page >= pg.totalPages) break;
  }
  return out;
}

export async function fetchEngineSnapshot(
  api: string, runId: string,
): Promise<EngineSnapshot & { run: Record<string, any> }> {
  const runRes = await fetch(`${api}/api/runs/${runId}`);
  if (!runRes.ok) throw new Error(`GET /api/runs/${runId} -> ${runRes.status}`);
  const run = await runRes.json() as Record<string, any>;
  if (run['status'] !== 'completed') {
    throw new Error(`run ${runId} is '${run['status']}', not 'completed' — nothing to score`);
  }

  const [matches, exceptions, excluded, duplicates] = await Promise.all([
    fetchAll<EngineMatch>(api, `/api/runs/${runId}/matches`, 'matches'),
    fetchAll<EngineException>(api, `/api/runs/${runId}/exceptions`, 'exceptions'),
    fetchAll<EngineRecord>(api, `/api/runs/${runId}/population?kind=excluded`, 'items'),
    fetchAll<EngineRecord>(api, `/api/runs/${runId}/population?kind=duplicates`, 'items'),
  ]);

  // There is no "list every transaction in a run" endpoint, by design — the
  // contract has no screen for one (endpoint 24 lists only the rows OUTSIDE the
  // denominator). The record map is therefore assembled from the previews the
  // engine already embeds: every reconcilable row is either a match member or an
  // exception's primary record, and the population endpoint supplies the rest.
  //
  // This is why ADR-073 exists: those previews carry `transactionId`, and until
  // U9 tried to perform the join they did NOT carry `sourceRowNumber`, which is
  // the only identity `data/truth/` can address.
  const records = new Map<string, EngineRecord>();
  const add = (r: EngineRecord | null | undefined): void => {
    if (r && r.transactionId && r.sourceRowNumber !== undefined) records.set(r.transactionId, r);
  };
  for (const m of matches) for (const mem of m.members) add(mem as unknown as EngineRecord);
  for (const e of exceptions) add(e.primaryRecord);
  for (const r of [...excluded, ...duplicates]) add(r);

  return { records: [...records.values()], matches, exceptions, metrics: run['metrics'] ?? {}, run };
}

export interface ScoreReport {
  [k: string]: unknown;
  scorerVersion: string;
  matching: ReturnType<typeof scoreMatching>;
  classification: ReturnType<typeof scoreClassification>;
  byDifficulty: ReturnType<typeof scoreByDifficulty>;
  resolvability: ReturnType<typeof scoreResolvability>;
  tierDiagnostic: ReturnType<typeof tierDiagnostic>;
  ceiling: { theoreticalMaxMatchRatePct: number; achievedPct: number | null; headroomPct: number | null };
  buildBlockers: string[];
}

/** Assemble the whole §5 measurement. Pure — every input is already in memory. */
export function buildReport(key: AnswerKey, engine: EngineSnapshot): ScoreReport {
  const matching = scoreMatching(key, engine);
  const classification = scoreClassification(key, engine);
  const resolvability = scoreResolvability(key, engine);

  // §5.3 and §5.2's watch cells are BUILD BLOCKERS, not metrics. Collected into
  // one list so a caller does not have to know which of five nested figures is
  // the one that must never move.
  const buildBlockers: string[] = [];
  if (resolvability.unresolvableRecall < 1) {
    buildBlockers.push(
      `unresolvable recall is ${resolvability.unresolvableRecall}, not 1.0 — the engine ` +
      `INVENTED a match on ${resolvability.inventedMatchesOnUnresolvable.length} ` +
      `designed-unresolvable event(s): ${resolvability.inventedMatchesOnUnresolvable.join(', ')}`);
  }
  const cells = classification.s8RegressionCells;
  if (cells.amountMismatchScoredAsPendingMatch > 0) {
    buildBlockers.push(
      `${cells.amountMismatchScoredAsPendingMatch} AMOUNT_MISMATCH event(s) were SCORED as a ` +
      `pending match instead of DECIDED by S8 (§5.2) — identity resolution is not running ` +
      `where it should be`);
  }
  if (cells.timingDriftAutoConfirmed > 0) {
    buildBlockers.push(
      `${cells.timingDriftAutoConfirmed} TIMING_DRIFT event(s) auto-confirmed (§5.2) — the ` +
      `pre-ADR-029 failure where a late settlement scores just over the threshold and ` +
      `matches silently`);
  }

  const achieved = (engine.metrics?.['matchRate']?.['matchRatePct'] ?? null) as number | null;
  const ceilingPct = key.manifest.theoreticalMaxMatchRatePct;

  return {
    scorerVersion: SCORER_VERSION,
    matching,
    classification,
    byDifficulty: scoreByDifficulty(key, engine),
    resolvability,
    tierDiagnostic: tierDiagnostic(key, engine),
    ceiling: {
      theoreticalMaxMatchRatePct: ceilingPct,
      achievedPct: achieved,
      // Against the CEILING, not against 100. The dataset contains 21 events
      // that are unresolvable by construction; measuring against 100% would
      // report designed-in impossibility as engine failure.
      headroomPct: achieved === null ? null : round4(ceilingPct - achieved),
    },
    buildBlockers,
  };
}

/** Human-readable summary. The number a person reads is not the JSON blob. */
export function formatReport(r: ScoreReport, key: AnswerKey): string {
  const m = r.matching;
  const L: string[] = [];
  L.push('');
  L.push('══ MATCHING (pairs) ═══════════════════════════════════════════');
  L.push(`  precision ${m.precision}   recall ${m.recall}   F1 ${m.f1}`);
  L.push(`  TP ${m.truePositives}   FP ${m.falsePositives}   FN ${m.falseNegatives}`);
  L.push(`  FALSE POSITIVES: ${m.falsePositives}   <- the raw integer, per ADR-020`);
  L.push(`  pending_review pairs ${m.pendingPairs} (scored separately, ADR-040)` +
    `   review-queue precision ${m.reviewQueuePrecision ?? 'n/a'}` +
    ` over ${m.pendingPairs - m.pendingExcludedFromQueuePrecision} judged`);
  L.push(`  excluded from both sides: ${m.excludedExceptionEventPairs} pairs whose EVENT is an ` +
    `EXCEPTION (ADR-072), ${m.excludedSameSourceLegs} same-source cardinality legs`);
  L.push('');
  L.push('══ CLASSIFICATION ═════════════════════════════════════════════');
  L.push(`  macro precision ${r.classification.macroPrecision}   macro recall ${r.classification.macroRecall}`);
  L.push(`  secondary-flag Jaccard ${r.classification.secondaryFlagJaccard ?? 'n/a'}` +
    `   · ${r.classification.multiCategoryEvents} events raised >1 category (only one is scored)`);
  for (const [c, v] of Object.entries(r.classification.perCategory)) {
    if (v.support === 0) continue;
    L.push(`    ${c.padEnd(22)} P ${v.precision.toFixed(3)}  R ${v.recall.toFixed(3)}  n=${v.support}`);
  }
  L.push('');
  L.push('══ RESOLVABILITY ══════════════════════════════════════════════');
  L.push(`  unresolvable recall ${r.resolvability.unresolvableRecall} ` +
    `over ${r.resolvability.unresolvableDesigned} designed-unresolvable events`);
  L.push(`  false-despair ${r.resolvability.falseDespairEvents}/${r.resolvability.gaveUpOn} ` +
    `= ${r.resolvability.falseDespairRate}   <- the engine's honest headroom`);
  L.push(`  batch bounds: proved ${r.resolvability.boundHonesty.searchExhausted}, ` +
    `budget-limited ${r.resolvability.boundHonesty.searchBoundExceeded}`);
  L.push('');
  L.push('══ BY DIFFICULTY (recall) ═════════════════════════════════════');
  for (const [d, v] of Object.entries(r.byDifficulty)) {
    L.push(`  ${d.padEnd(8)} ${v.recall}  over ${v.pairs} pairs`);
  }
  L.push('');
  L.push('══ TIER (diagnostic, NEVER an accuracy term — ADR-072) ════════');
  L.push(`  key viaTier      ${JSON.stringify(r.tierDiagnostic.keyViaTier)}`);
  L.push(`  engine pairs     ${JSON.stringify(r.tierDiagnostic.engineTierPairs)}`);
  L.push('');
  L.push('══ CEILING ════════════════════════════════════════════════════');
  L.push(`  engine match rate ${r.ceiling.achievedPct ?? 'n/a'}%  of a computed ceiling of ` +
    `${r.ceiling.theoreticalMaxMatchRatePct}%  (headroom ${r.ceiling.headroomPct ?? 'n/a'} pts)`);
  L.push(`  ${key.manifest.unresolvableEventCount} of ${key.events.length} events are ` +
    `unresolvable by construction — the ceiling is below 100 by design`);
  L.push('');
  if (r.buildBlockers.length > 0) {
    L.push('══ BUILD BLOCKERS ═════════════════════════════════════════════');
    for (const b of r.buildBlockers) L.push(`  x ${b}`);
  } else {
    L.push('══ every honesty gate passed ══════════════════════════════════');
    L.push('  unresolvable recall 1.0 · no S8 regression cell fired');
  }
  L.push('');
  return L.join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  const raw = readFileSync(args.keyFile, 'utf8');
  const key = JSON.parse(raw) as AnswerKey;
  const engine = await fetchEngineSnapshot(args.api, args.runId);

  // Before anything is computed. A number produced against the wrong dataset is
  // worse than no number, and it is indistinguishable from a real one.
  assertSameDataset(key.manifest.fileHashes, engine.run['inputFileHashes'] ?? {});

  const report = buildReport(key, engine);
  process.stdout.write(formatReport(report, key));

  if (args.out !== null) {
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    process.stdout.write(`\nwrote ${args.out}\n`);
  }

  if (args.post) {
    const res = await fetch(`${args.api}/api/runs/${args.runId}/score-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        truthKeyFile: args.keyFile,
        truthKeyHash: hashKeyFile(raw),
        scorerVersion: SCORER_VERSION,
        inputFileHashes: engine.run['inputFileHashes'],
        report,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`POST score-report -> ${res.status} ${body}`);
    process.stdout.write(`posted: ${body}\n`);
  } else {
    process.stdout.write('\n(dry run — pass --post to record this measurement)\n');
  }

  return report.buildBlockers.length > 0 ? 2 : 0;
}

// Run only when invoked as a script, so tests may import the module freely.
if (process.argv[1]?.endsWith('score/index.ts') === true) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
      process.exitCode = 1;
    },
  );
}
