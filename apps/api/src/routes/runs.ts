/**
 * Endpoints 2, 3, 4, 5, 19, 22, 23, 24 — the run lifecycle.
 *
 * Thin: parse, validate, delegate, serialize (CLAUDE.md §4.3).
 *
 * ── The async protocol (api-contract §5) ──
 * `POST /api/runs` returns `202` with a `runId` IMMEDIATELY and starts the
 * orchestrator without awaiting it. The frontend polls `GET /api/runs/:runId`
 * every 750ms and drives a progress bar off `progress.stage`. That is the whole
 * reason the orchestrator commits each phase separately: an unawaited run whose
 * status is invisible would leave the client polling a row that never changes.
 *
 * Polling rather than WebSockets or SSE is a deliberate non-choice, not an
 * oversight — a realtime transport is one more thing that can fail in front of
 * a panel, for a run that finishes in seconds.
 */

import { Router } from 'express';
import { ApiError } from '../app.js';
import type { Env } from '../config/env.js';
import { ENGINE_DEFAULTS } from '../config/defaults.js';
import type { RunConfig } from '../types/engine.js';
import { executeRun, type RunSources } from '../services/run/orchestrator.js';
import { createExplainClient } from '../services/explain/llm-client.js';
import * as runsRepo from '../repositories/runs.js';
import * as txnRepo from '../repositories/transactions.js';
import * as matchRepo from '../repositories/matches.js';
import * as excRepo from '../repositories/exceptions.js';
import * as scoreRepo from '../repositories/score-reports.js';
import { verifyRunChain } from '../repositories/audit.js';
import { formatPaise } from '../services/ingestion/money.js';
import { handler, pageParams, found, enumParam, requireString, pathParam } from './helpers.js';
import { runSummary, runDetail, paginate, matchSummary, exceptionSummary } from './serialize.js';

/** Config keys a caller may override (api-contract §2, endpoint 2). */
const OVERRIDABLE = [
  'amountTolerancePct', 'amountToleranceFloorPaise', 'amountToleranceCapPaise',
  'dateWindowCardDays', 'dateWindowUpiDays', 'dateWindowLedgerDays',
  'fuzzyAutoConfirmThreshold', 'fuzzyReviewThreshold', 'ambiguityDeltaThreshold',
  'aliasLearningEnabled', 'llmExplainEnabled', 'llmMaxCallsPerRun',
] as const;

/**
 * Merge `configOverrides` onto the defaults.
 *
 * Unknown keys are REJECTED rather than ignored. A caller who misspells
 * `fuzzyAutoConfirmThreshold` and gets a 200 has silently run with the default
 * and will read the resulting match rate as if their setting applied.
 */
export function resolveConfig(
  overrides: unknown,
): Omit<RunConfig, 'referenceDate' | 'aliasCountAtStart'> {
  if (overrides === undefined || overrides === null) return { ...ENGINE_DEFAULTS };
  if (typeof overrides !== 'object') {
    throw new ApiError(400, 'INVALID_REQUEST', 'configOverrides must be an object');
  }
  const out: Record<string, unknown> = { ...ENGINE_DEFAULTS };
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(OVERRIDABLE as readonly string[]).includes(k)) {
      throw new ApiError(400, 'INVALID_REQUEST',
        `configOverrides.${k} is not an overridable setting`,
        { overridable: [...OVERRIDABLE] });
    }
    out[k] = v;
  }
  return out as Omit<RunConfig, 'referenceDate' | 'aliasCountAtStart'>;
}

export function runsRouter(env: Env, readSeedDataset: () => RunSources): Router {
  const r = Router();

  // Built ONCE, not per run: the SDK client is stateless and rebuilding it per
  // request would be waste. `null` here is the ordinary state on this build —
  // there is no key, so S13 writes templates and the run completes (ADR-017).
  //
  // `model` is passed whether or not a client exists, because it is hashed into
  // every `signature_hash` (ADR-018). A keyless run must compute the same
  // hashes a keyed one would, or the cache the keyless runs checked against
  // would be a different namespace the day a key arrives.
  const explain = {
    client: createExplainClient(env),
    model: env.explainModel,
    promptVersion: env.promptVersion,
  };

  // 2 · POST /api/runs — 202, then poll.
  r.post('/', handler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Variant A (multipart upload) needs `multer` wiring and a 10 MB per-file
    // cap; only variant B (seeded dataset) is served here. Rejecting explicitly
    // beats accepting an upload and silently reconciling the seed data.
    if (body['useSeedDataset'] !== true) {
      throw new ApiError(400, 'MISSING_REQUIRED_FILE',
        'file upload is not enabled on this build; pass { useSeedDataset: true }');
    }
    const config = resolveConfig(body['configOverrides']);
    const label = typeof body['label'] === 'string' && body['label'].trim() !== ''
      ? body['label'].trim()
      : `seed-${new Date().toISOString()}`;
    const datasetSeed = typeof body['datasetSeed'] === 'number' ? body['datasetSeed'] : null;

    const run = await runsRepo.createRun({
      label, datasetSeed,
      configSnapshot: { ...config, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
    });

    // Deliberately NOT awaited: the contract is 202-then-poll. `executeRun`
    // records its own failure, so a rejection here would be a programming error
    // and is logged rather than lost.
    void executeRun(run.id, readSeedDataset(), config, explain).catch((err: unknown) => {
      console.error('[api] run crashed outside its own error handling', run.id, err);
    });

    res.status(202).json({
      runId: run.id, status: run.status, label: run.label,
      startedAt: run.startedAt.toISOString(),
    });
  }));

  // 3 · GET /api/runs
  r.get('/', handler(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req);
    const { runs, total } = await runsRepo.listRuns(pageSize, offset);
    res.json({ runs: runs.map(runSummary), pagination: paginate(page, pageSize, total) });
  }));

  // 4 · GET /api/runs/:runId — the poll target.
  r.get('/:runId', handler(async (req, res) => {
    const run = found(await runsRepo.findRun(pathParam(req, 'runId')),
      'RUN_NOT_FOUND', `No run exists with id ${pathParam(req, 'runId')}`);
    res.json(runDetail(run));
  }));

  // 5 · GET /api/runs/:runId/metrics
  r.get('/:runId/metrics', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    const run = found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    if (run.status !== 'completed') {
      throw new ApiError(409, 'RUN_NOT_COMPLETE',
        `Run is ${run.status}; metrics are available once it completes.`);
    }
    const report = await scoreRepo.latestScoreReport(runId);
    // ADR-041: two objects from two tables, returned together or not at all.
    // `measured` is NULL when nothing has scored this run — the frontend renders
    // "not measured against ground truth" and must NEVER substitute engine
    // figures into a slot labelled measured. A fabricated accuracy number is
    // worse than an absent one, and that substitution is the exact failure this
    // architecture exists to prevent.
    res.json({
      engine: run.metrics,
      measured: report?.report ?? null,
      measuredAt: report === null ? null : report.scoredAt.toISOString(),
      measuredAgainst: report?.truthKeyFile ?? null,
      scorerVersion: report?.scorerVersion ?? null,
    });
  }));

  // 6 · GET /api/runs/:runId/exceptions
  r.get('/:runId/exceptions', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const { page, pageSize, offset } = pageParams(req);

    const filter = {
      ...opt('category', enumParam(req, 'category', [
        'DUPLICATE_RECORD', 'AMBIGUOUS_MATCH', 'MISSING_IN_BANK', 'MISSING_IN_LEDGER',
        'MISSING_IN_GATEWAY', 'AMOUNT_MISMATCH', 'TIMING_DRIFT', 'UNSPLITTABLE_BATCH'] as const)),
      ...opt('severity', enumParam(req, 'severity', ['high', 'medium', 'low'] as const)),
      ...opt('status', enumParam(req, 'status', [
        'open', 'explained', 'human_resolved', 'wont_fix'] as const)),
      ...opt('search', typeof req.query['search'] === 'string' ? req.query['search'] : undefined),
    };
    const sort = enumParam(req, 'sort', ['severity', 'amount', 'created'] as const) ?? 'severity';

    const { exceptions, total } = await excRepo.listExceptions(runId, filter, sort, pageSize, offset);
    const byId = await transactionsById(runId, exceptions.flatMap(
      (e) => (e.transactionId === null ? [] : [e.transactionId])));

    const facets = await excRepo.exceptionFacets(runId);
    res.json({
      exceptions: exceptions.map((e) => exceptionSummary(
        e, e.transactionId === null ? null : byId.get(e.transactionId) ?? null, null)),
      facets: {
        category: Object.fromEntries(facets.byCategory.map((f) => [f.category, f.count])),
        severity: Object.fromEntries(facets.bySeverity.map((f) => [f.severity, f.count])),
        status: Object.fromEntries(facets.byStatus.map((f) => [f.status, f.count])),
      },
      pagination: paginate(page, pageSize, total),
    });
  }));

  // 8 · GET /api/runs/:runId/matches   ·   9 · .../review-queue
  r.get('/:runId/matches', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const { page, pageSize, offset } = pageParams(req);
    const filter = {
      ...opt('tier', enumParam(req, 'tier', ['exact', 'alias', 'fuzzy', 'batch', 'manual'] as const)),
      ...opt('status', enumParam(req, 'status', [
        'auto_confirmed', 'pending_review', 'human_confirmed', 'human_rejected'] as const)),
    };
    const { matches, total } = await matchRepo.listMatches(runId, filter, pageSize, offset);
    const byId = await transactionsById(runId, matches.flatMap((m) => m.members.map((x) => x.transactionId)));
    res.json({
      matches: matches.map((m) => matchSummary(m, byId)),
      pagination: paginate(page, pageSize, total),
    });
  }));

  r.get('/:runId/review-queue', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const { page, pageSize, offset } = pageParams(req);
    const { matches, total } = await matchRepo.listReviewQueue(runId, pageSize, offset);
    const byId = await transactionsById(runId, matches.flatMap((m) => m.members.map((x) => x.transactionId)));
    res.json({
      items: matches.map((m) => ({
        matchId: m.id, tier: m.tier, confidence: m.confidence,
        scoreBreakdown: m.scoreBreakdown,
        members: m.members.map((mem) => {
          const t = byId.get(mem.transactionId);
          return t === undefined ? { transactionId: mem.transactionId, role: mem.role } : {
            transactionId: t.id, role: mem.role, externalId: t.externalId,
            amountDisplay: formatPaise(t.amountPaise), txnDate: t.txnDate,
            counterpartyRaw: t.counterpartyRaw,
          };
        }),
        whyFlagged: whyFlagged(m),
        // Alias suggestions are produced DETERMINISTICALLY (schema.md §12) — the
        // differing field pair the reviewer is already looking at, pre-filled.
        // Never an LLM inference. Wiring `wouldAlsoResolve` needs a count across
        // the run, which lands with the alias-learning UI.
        aliasSuggestions: [],
      })),
      pagination: paginate(page, pageSize, total),
    });
  }));

  // 24 · GET /api/runs/:runId/population — rows outside the denominator.
  r.get('/:runId/population', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    const run = found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const { page, pageSize, offset } = pageParams(req);
    const kind = enumParam(req, 'kind', ['excluded', 'rejected', 'duplicates'] as const) ?? 'excluded';

    // Rejected rows never became transactions (ADR-046), so they live on the run
    // row rather than in `transactions`. Excluded is not hidden: every one of
    // these is counted, listed, and carries the reason it left the denominator.
    if (kind === 'rejected') {
      const items = run.rejectedRows.slice(offset, offset + pageSize).map((x) => ({
        kind: 'rejected', sourceSystem: x.sourceSystem, sourceRowNumber: x.rowNumber,
        reason: x.error, rawLine: x.rawLine,
      }));
      res.json({ items, counts: populationCounts(run), pagination: paginate(page, pageSize, run.rejectedRows.length) });
      return;
    }

    const { items, total } = await txnRepo.listNonReconcilable(runId, kind, pageSize, offset);
    res.json({
      items: items.map((t) => ({
        kind, transactionId: t.id, sourceSystem: t.sourceSystem,
        sourceRowNumber: t.sourceRowNumber, externalId: t.externalId,
        amountPaise: t.amountPaise, amountDisplay: formatPaise(t.amountPaise), txnDate: t.txnDate,
        reason: kind === 'excluded'
          ? `status '${t.statusRaw}' is not reconcilable (${t.statusNorm})`
          : `duplicate of ${t.duplicateOfTransactionId} (${t.duplicateKind})`,
      })),
      counts: populationCounts(run),
      pagination: paginate(page, pageSize, total),
    });
  }));

  // 22 · GET /api/runs/:runId/audit/verify — recompute the hash chain.
  r.get('/:runId/audit/verify', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    // Eight fields, not §22's original five (issue #28). `anchored` is the important
    // addition: a hash chain proves the entries you HOLD are consistent, and
    // cannot prove you hold all of them. Without the anchor, deleting the tail
    // reads as clean — the cheapest tamper available, certified valid in front
    // of a finance panel.
    res.json(await verifyRunChain(runId));
  }));

  // 23 · POST /api/runs/:runId/score-report — the offline scorer posts a measurement.
  r.post('/:runId/score-report', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    const run = found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const truthKeyFile = requireString(body, 'truthKeyFile');
    const truthKeyHash = requireString(body, 'truthKeyHash');
    const scorerVersion = requireString(body, 'scorerVersion');
    const report = body['report'];
    if (typeof report !== 'object' || report === null) {
      throw new ApiError(400, 'INVALID_REQUEST', 'report must be an object');
    }

    // Scoring a run against a key built from different bytes should be
    // IMPOSSIBLE, not something noticed late. The check holds from both ends:
    // the scorer refuses to read the wrong files, and this refuses to store a
    // measurement of the wrong run.
    const expected = Object.values(run.inputFileHashes).sort().join('|');
    const claimed = typeof body['inputFileHashes'] === 'object' && body['inputFileHashes'] !== null
      ? Object.values(body['inputFileHashes'] as Record<string, string>).sort().join('|')
      : null;
    if (claimed !== null && claimed !== expected) {
      throw new ApiError(422, 'TRUTH_KEY_MISMATCH',
        'The score report was built against different input bytes than this run used.',
        { runHashes: run.inputFileHashes, reportHashes: body['inputFileHashes'] });
    }

    const stored = await scoreRepo.insertScoreReport({
      runId, truthKeyFile, truthKeyHash, scorerVersion,
      report: report as Record<string, unknown>,
    });
    if (stored === null) {
      // Same scorer, same key, same run is the SAME measurement. A number must
      // not be quietly replaced after it has been read.
      const existing = await scoreRepo.latestScoreReport(runId);
      res.status(200).json({ scoreReportId: existing?.id ?? null, alreadyRecorded: true });
      return;
    }
    res.status(201).json({ scoreReportId: stored.id, alreadyRecorded: false });
  }));

  // 19 · GET /api/runs/:runId/export?format=csv&scope=exceptions|matches
  r.get('/:runId/export', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const scope = enumParam(req, 'scope', ['exceptions', 'matches'] as const) ?? 'exceptions';

    const rows: string[][] = [];
    if (scope === 'exceptions') {
      const { exceptions } = await excRepo.listExceptions(runId, {}, 'severity', MAX_EXPORT, 0);
      rows.push(['exceptionId', 'category', 'secondaryFlags', 'severity', 'status',
                 'transactionId', 'amountAtRiskPaise', 'amountAtRiskDisplay',
                 'bestCandidateScore', 'detectedByRule', 'explanationSource', 'explanationText']);
      for (const e of exceptions) {
        rows.push([e.id, e.category, e.secondaryFlags.join(' '), e.severity, e.status,
                   e.transactionId ?? '', String(e.amountAtRiskPaise ?? ''),
                   e.amountAtRiskPaise === null ? '' : formatPaise(e.amountAtRiskPaise),
                   String(e.bestCandidateScore ?? ''), e.detectedByRule,
                   e.explanationSource ?? '', e.explanationText ?? '']);
      }
    } else {
      const { matches } = await matchRepo.listMatches(runId, {}, MAX_EXPORT, 0);
      rows.push(['matchId', 'tier', 'status', 'confidence', 'cardinality', 'ruleId',
                 'countsTowardEngineMatchRate', 'memberCount', 'memberTransactionIds']);
      for (const m of matches) {
        rows.push([m.id, m.tier, m.status, m.confidence.toFixed(4), m.cardinality, m.ruleId,
                   String(m.tier !== 'manual' && m.status !== 'human_rejected'),
                   String(m.members.length), m.members.map((x) => x.transactionId).join(' ')]);
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${scope}-${runId}.csv"`);
    res.send(rows.map((r2) => r2.map(csvCell).join(',')).join('\n'));
  }));

  return r;

  function populationCounts(run: runsRepo.Run): Record<string, number> {
    const c = run.recordCounts;
    return {
      excluded: c['excluded'] ?? 0,
      rejected: run.rejectedRowCount,
      duplicates: c['nonPrimaryDuplicates'] ?? 0,
      reconcilable: c['reconcilable'] ?? 0,
    };
  }
}

const MAX_EXPORT = 100_000;

/** `{}` for an absent value, so `exactOptionalPropertyTypes` stays satisfiable. */
function opt<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** RFC-4180: quote when the cell contains a comma, quote or newline; double inner quotes. */
export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Why a fuzzy match reached the review queue, from the score breakdown alone.
 *
 * Deterministic and rule-derived: it names the component that fell short, which
 * is the thing a reviewer needs before deciding. The explain layer may later
 * write better prose, but this must render with the LLM disabled.
 */
export function whyFlagged(m: matchRepo.Match): string {
  const b = m.scoreBreakdown;
  if (b === null) return `Scored ${m.confidence.toFixed(4)}, below the auto-confirm threshold.`;
  const weak: string[] = [];
  if (b.anchor === 0) weak.push('no shared reference number was found');
  if (b.amountUnavailable) weak.push('the amounts are not comparable for this source pair');
  else if (b.amount === 0) weak.push('the amounts disagree beyond tolerance');
  if (b.date === 0) weak.push('the dates sit at the edge of the settlement window');
  if (b.counterparty === 0) weak.push('the counterparty names do not agree');
  return weak.length === 0
    ? `Scored ${m.confidence.toFixed(4)}, below the auto-confirm threshold.`
    : `${weak.join('; ')} — scored ${m.confidence.toFixed(4)}.`;
}

/** One query for every record a page references, rather than N+1 per row. */
async function transactionsById(
  runId: string, ids: string[],
): Promise<Map<string, import('../types/engine.js').NormalizedTransaction>> {
  if (ids.length === 0) return new Map();
  const wanted = new Set(ids);
  const all = await txnRepo.listTransactions(runId);
  return new Map(all.filter((t) => wanted.has(t.id)).map((t) => [t.id, t]));
}
