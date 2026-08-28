/**
 * S0–S14 — the run orchestrator.
 *
 * No single doc specifies this stage; it is assembled from `matching-engine.md`
 * §1 (execution order), `schema.md` §4 (what a run records), §9.1 (which events
 * are logged) and ADR-046 (failure handling). Two things here are judgment
 * rather than transcription, and both are argued where they are made:
 * TRANSACTION BOUNDARIES and AUDIT-WRITE POINTS.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT ONE TRANSACTION.
 *
 * The obvious design — wrap the whole run in `withTransaction` — is wrong for a
 * specific and non-obvious reason: `GET /api/runs/:runId` is the dashboard's
 * POLL TARGET while a run is in flight (api-contract endpoint 4). Status lives
 * on the `runs` row, so an uncommitted status transition is invisible, and a run
 * inside one transaction would sit at `pending` for its entire duration and then
 * jump to `completed`. The progress indicator would be decorative.
 *
 * So the run is a SEQUENCE of transactions, one per phase, with the status
 * transition committed between them. The cost is real and worth stating: a crash
 * mid-run leaves the database holding the phases that already committed. That is
 * the case ADR-046's boot reaper exists for — the run is marked `failed` with
 * `interrupted by restart`, and its partial rows stay visible rather than being
 * silently rolled back into a run that looks like it never happened.
 *
 * Within a phase, everything is atomic: the matching phase writes every group or
 * none, so the single-match trigger rejecting one member can never leave a
 * half-persisted match set behind.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT IS AUDITED, AND WHAT IS NOT. The audit log is a trail of DECISIONS
 * (ADR-042). Every decision that changed a record's fate gets an entry:
 * exclusion, rejection, deduplication, identity establishment, each match, each
 * displacement, each exception. Ingestion ITSELF is a transcription rather than
 * a decision — the `transactions` table already holds every row verbatim
 * alongside its `raw_payload` — so it is summarised in one entry per source
 * instead of one per row. `MATCH_CANDIDATE_REJECTED` is deliberately NOT written
 * here; schema.md §9.1 floors it at 0.40 precisely because logging every
 * pairwise rejection would produce ~90,000 rows at 300 records and drown the
 * trail, and the near misses are already carried in each exception's
 * `evidence.candidates`.
 */

import { createHash } from 'node:crypto';

import { withTransaction, type TxClient } from '../../db/pool.js';
import type { BusinessDate } from '../../types/domain.js';
import type {
  ClassifiedException, NormalizedTransaction, RunConfig,
} from '../../types/engine.js';
import type { CanonicalValue } from '../audit/canonical-json.js';

import { ingestSources, CsvParseError } from '../ingestion/index.js';
import { dedupe } from '../matching/dedupe.js';
import { buildBlockIndexes, rebuildCounterpartyIndex } from '../matching/blocking.js';
import { runTier1 } from '../matching/tier1-exact.js';
import { runTier15 } from '../matching/tier1_5-alias.js';
import { resolveIdentities } from '../matching/identity-resolution.js';
import { runTier2, pairKeyOf } from '../matching/tier2-fuzzy.js';
import {
  assembleGroups, fromTier1, fromTier2, type GroupPair, type RefusedPair,
} from '../matching/group-assembly.js';
import { runClassification } from '../classification/collect.js';

import * as runsRepo from '../../repositories/runs.js';
import * as txnRepo from '../../repositories/transactions.js';
import * as matchRepo from '../../repositories/matches.js';
import * as excRepo from '../../repositories/exceptions.js';
import * as aliasRepo from '../../repositories/aliases.js';
import { appendAuditEntry, type AuditEntryInput } from '../../repositories/audit.js';

const ENGINE = { actorType: 'engine', actorId: 'recon-engine' } as const;

export interface RunSources {
  gateway: string;
  bank: string;
  ledger: string;
}

export interface RunOutcome {
  runId: string;
  status: 'completed' | 'failed';
  referenceDate: BusinessDate | null;
  counts: runsRepo.RunRecordCounts;
  matches: number;
  exceptions: number;
  auditEntries: number;
  errorDetail?: string;
}

/** sha256 of the exact bytes, so the scorer can refuse a mismatched answer key. */
export function hashSource(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * A phase-scoped audit writer.
 *
 * Every entry in a phase shares that phase's transaction, so the chain's
 * advisory lock is taken once and held rather than re-acquired per append, and
 * the entries commit atomically with the rows they describe. An audit trail that
 * can survive the write it documents is worse than none.
 */
class PhaseAudit {
  count = 0;
  constructor(private readonly client: TxClient, private readonly runId: string) {}

  async write(entry: Omit<AuditEntryInput, 'runId' | 'actorType' | 'actorId'>): Promise<void> {
    await appendAuditEntry({ ...entry, ...ENGINE, runId: this.runId }, this.client);
    this.count += 1;
  }
}

/**
 * Bridge a typed object into `CanonicalValue`.
 *
 * `CanonicalValue`'s object arm is `{ [k: string]: CanonicalValue }`, and a named
 * interface like `MatchMember` does not satisfy an index signature structurally
 * even when every field would. The values here are all JSON-shaped already, and
 * `canonicalJson` still validates at write time — it THROWS on `NaN`, a
 * function, or anything else JSON cannot represent, rather than silently
 * emitting `null`. So this widens a type without widening what can be stored.
 */
function details(value: object): Record<string, CanonicalValue> {
  return value as Record<string, CanonicalValue>;
}

const blank = {
  transactionId: null, tier: null, ruleId: null, ruleVersion: null,
  decision: null, confidence: null, beforeState: null, afterState: null,
} as const;

/**
 * Execute a run end to end.
 *
 * `runId` must already exist at status `pending` — the route creates it and
 * returns `202` before this is called, so the client has something to poll.
 * Failure is caught here and recorded; this never throws for a data problem,
 * only for a programming error the caller should see.
 */
export async function executeRun(
  runId: string, sources: RunSources, baseConfig: Omit<RunConfig, 'referenceDate' | 'aliasCountAtStart'>,
): Promise<RunOutcome> {
  try {
    return await runPhases(runId, sources, baseConfig);
  } catch (err) {
    const detail = err instanceof CsvParseError
      ? `PARSE_FAILED: ${err.message}`
      : err instanceof Error ? err.message : String(err);

    // The failure record is its own transaction: whatever rolled back, the fact
    // that the run failed and why must survive.
    await withTransaction(async (c) => {
      await runsRepo.finishRun(runId, { status: 'failed', errorDetail: detail }, c);
      await appendAuditEntry({
        ...ENGINE, ...blank, runId,
        eventType: 'RUN_FAILED', subjectType: 'run', subjectId: runId,
        reason: `run failed: ${detail}`,
        details: { errorDetail: detail },
      }, c);
    });
    return {
      runId, status: 'failed', referenceDate: null,
      counts: { gateway: 0, bank: 0, ledger: 0, excluded: 0, rejected: 0,
                nonPrimaryDuplicates: 0, reconcilable: 0 },
      matches: 0, exceptions: 0, auditEntries: 0, errorDetail: detail,
    };
  }
}

async function runPhases(
  runId: string, sources: RunSources,
  baseConfig: Omit<RunConfig, 'referenceDate' | 'aliasCountAtStart'>,
): Promise<RunOutcome> {
  let auditEntries = 0;

  // ── S0 LOAD + S1–S3 PARSE/NORMALIZE/EXCLUDE ────────────────────────────────
  await runsRepo.setRunStatus(runId, 'ingesting');

  const inputFileHashes = {
    gateway: hashSource(sources.gateway),
    bank: hashSource(sources.bank),
    ledger: hashSource(sources.ledger),
  };
  const ingested = ingestSources({ runId, files: sources });

  // The alias set is read ONCE, before matching, and its size is snapshotted.
  // A run's output must be a pure function of (files, config, active aliases);
  // re-reading mid-run would let a concurrent alias write change the answer
  // halfway through and make the run unreproducible.
  const aliases = await aliasRepo.listActiveAliases();

  // ADR-039: the reference date is dataset-derived and is only knowable after
  // parsing, so the resolved config — the thing `config_snapshot` must record —
  // does not exist until here. That is why RUN_STARTED is written now rather
  // than at row creation: it is the anchor of the chain and must carry the
  // configuration the run ACTUALLY used.
  const config: RunConfig = {
    ...baseConfig,
    referenceDate: ingested.referenceDate ?? '1970-01-01',
    aliasCountAtStart: aliases.length,
  };

  const deduped = dedupe(ingested.transactions);
  const nonPrimaryDuplicates = ingested.transactions.length - deduped.pool.length;
  const reconcilable = deduped.pool.filter((t) => t.statusNorm === 'reconcilable').length;
  const counts: runsRepo.RunRecordCounts = {
    ...ingested.counts, nonPrimaryDuplicates, reconcilable,
  };

  await withTransaction(async (c) => {
    const audit = new PhaseAudit(c, runId);

    await runsRepo.recordIngestion(runId, {
      referenceDate: ingested.referenceDate, recordCounts: counts,
      rejectedRows: ingested.rejectedRows, inputFileHashes,
    }, c);
    await runsRepo.setRunMetrics(runId, {}, c);   // cleared; S14 fills it
    await persistConfigSnapshot(runId, config, c);

    // THE ANCHOR (schema.md §9.1). Full config, the three file hashes and the
    // reference date, in one immutable entry, before any matching decision. This
    // is what makes a reported number reproducible by a sceptic.
    await audit.write({
      ...blank,
      eventType: 'RUN_STARTED', subjectType: 'run', subjectId: runId,
      reason:
        `run started over ${ingested.transactions.length} records ` +
        `(${counts.gateway} gateway / ${counts.bank} bank / ${counts.ledger} ledger), ` +
        `reference date ${config.referenceDate}`,
      details: details({ configSnapshot: config, inputFileHashes, referenceDate: config.referenceDate,
                         recordCounts: counts, activeAliasCount: aliases.length }),
    });

    await txnRepo.insertTransactions(ingested.transactions, c);

    // Ingestion is a transcription; one entry per source, not per row. The rows
    // themselves are in `transactions` with `raw_payload` intact.
    for (const source of ['gateway', 'bank', 'ledger'] as const) {
      await audit.write({
        ...blank,
        eventType: 'RECORD_INGESTED', subjectType: 'run', subjectId: runId,
        reason: `ingested ${counts[source]} rows from the ${source} source`,
        details: { source, rows: counts[source], fileHash: inputFileHashes[source] },
      });
    }

    // ADR-046: a row that could not be READ is an ingestion defect, not a
    // reconciliation finding. Audited, counted, and never classified.
    for (const r of ingested.rejectedRows) {
      await audit.write({
        ...blank,
        eventType: 'RECORD_REJECTED', subjectType: 'run', subjectId: runId,
        reason: `${r.sourceSystem} row ${r.rowNumber} could not be parsed: ${r.error}`,
        details: { source: r.sourceSystem, rowNumber: r.rowNumber, error: r.error, rawLine: r.rawLine },
      });
    }

    // Exclusion IS a decision — these rows were readable and were deliberately
    // removed from the matching population. Excluded is not hidden.
    for (const t of ingested.transactions) {
      if (t.statusNorm === 'reconcilable') continue;
      await audit.write({
        ...blank, transactionId: t.id,
        eventType: 'RECORD_EXCLUDED', subjectType: 'transaction', subjectId: t.id,
        decision: t.statusNorm,
        reason:
          `${t.sourceSystem} row ${t.sourceRowNumber} excluded from matching: ` +
          `status '${t.statusRaw}' is not reconcilable`,
        details: { statusRaw: t.statusRaw, statusNorm: t.statusNorm, sourceRowNumber: t.sourceRowNumber },
      });
    }

    // S4 — dedupe marks, and one entry per non-primary copy (matching-engine §2.2).
    await txnRepo.markDuplicates(
      deduped.findings.map((f) => ({
        transactionId: f.transactionId, primaryId: f.primaryTransactionId, kind: f.kind,
      })), c);
    for (const f of deduped.findings) {
      await audit.write({
        ...blank, transactionId: f.transactionId,
        eventType: 'RECORD_DEDUPLICATED', subjectType: 'transaction', subjectId: f.transactionId,
        decision: f.kind, ruleId: f.kind === 'exact' ? 'DEDUP_STRONG_ANCHOR_V1' : 'DEDUP_SUSPECTED_PAIR_V1',
        ruleVersion: config.ruleVersion,
        reason: f.reason,
        details: { primaryTransactionId: f.primaryTransactionId, kind: f.kind,
                   anchorKey: f.anchorKey ?? null, anchorValue: f.anchorValue ?? null },
      });
    }
    auditEntries += audit.count;
  });

  // ── S5–S11 MATCHING (pure, in memory) ──────────────────────────────────────
  await runsRepo.setRunStatus(runId, 'matching');

  const blocks = buildBlockIndexes(deduped.pool);
  const t1 = runTier1(blocks, config);
  const claimedByExact = new Set(t1.matches.flatMap((m) => [m.aId, m.bId]));
  const t15 = runTier15(deduped.pool, config, aliases, claimedByExact);
  rebuildCounterpartyIndex(blocks, t15.pool);

  const exactPairs = [...t1.matches, ...t15.matches];
  const claimed = new Set(exactPairs.flatMap((m) => [m.aId, m.bId]));

  // S8 — identity short-circuit. Every verdict it reaches is a pair Tier 2 must
  // NOT re-score: a similarity score may never overturn a deterministic identity
  // verdict (matching-engine §6.3).
  const identity = resolveIdentities(t15.pool, config);
  const settled = new Set<string>();
  for (const { pair, verdict } of identity) {
    if (verdict.kind !== 'not_established') settled.add(pairKeyOf(pair[0].id, pair[1].id));
  }

  const tier2 = runTier2(blocks, config, claimed, settled);

  // S10 batch decomposition is NOT wired yet — see the note at the bottom of
  // this file. Passing an empty list keeps S11's contract honest rather than
  // pretending the stage ran.
  const byId = new Map<string, NormalizedTransaction>(t15.pool.map((t) => [t.id, t]));
  const groupPairs: GroupPair[] = [
    ...exactPairs.map((m) => fromTier1(m, byId)).filter((p): p is GroupPair => p !== null),
    ...tier2.accepted.map(fromTier2),
  ];
  const assembled = assembleGroups(groupPairs, []);

  const appliedAliasIds = [...new Set(exactPairs.flatMap((m) => m.aliasIds))];

  await withTransaction(async (c) => {
    const audit = new PhaseAudit(c, runId);

    // S7 populated counterparty_key on every pooled record; persist before the
    // matches so a reader of `transactions` sees the values matching used.
    await txnRepo.setCounterpartyKeys(
      t15.pool.map((t) => ({ transactionId: t.id, counterpartyKey: t.counterpartyKey })), c);

    for (const { pair, verdict } of identity) {
      if (verdict.kind !== 'established') continue;
      // `outcome: 'match'` means S6 already claimed this pair — S8 re-derives it
      // and says so "for completeness" (identity-resolution.ts). Logging those
      // would put a second entry beside every MATCH_CONFIRMED_EXACT and claim
      // the identity stage contributed 203 findings when it contributed the ones
      // Tier 1 DECLINED. What S8 is for is the amount/timing verdicts.
      if (verdict.outcome === 'match') continue;
      await audit.write({
        ...blank, transactionId: pair[0].id,
        eventType: 'IDENTITY_ESTABLISHED', subjectType: 'transaction', subjectId: pair[0].id,
        ruleId: verdict.ruleId, ruleVersion: config.ruleVersion, decision: verdict.outcome,
        reason: verdict.reason,
        details: { counterpartId: pair[1].id, anchorKey: verdict.anchorKey,
                   anchorValue: verdict.anchorValue, outcome: verdict.outcome },
      });
    }

    const written = await matchRepo.insertMatches(runId, assembled.matches, config.ruleVersion, c);
    for (const m of written) {
      await audit.write({
        ...blank,
        eventType: eventForMatch(m.tier, m.status), subjectType: 'match', subjectId: m.id,
        tier: m.tier, ruleId: m.ruleId, ruleVersion: m.ruleVersion,
        decision: m.status, confidence: m.confidence,
        reason: reasonForMatch(m),
        details: details({ members: m.members, cardinality: m.cardinality,
                           amountDeltaPaise: m.amountDeltaPaise, dateDeltaDays: m.dateDeltaDays,
                           aliasIds: m.aliasIds, scoreBreakdown: m.scoreBreakdown }),
      });
    }

    // ADR-032: "your counterpart went to a stronger claim" is one of the most
    // useful things the exception list can say, and it is invisible in any
    // design that assigns greedily per record.
    for (const d of tier2.displaced) {
      await audit.write({
        ...blank, transactionId: d.a.id,
        eventType: 'MATCH_CANDIDATE_DISPLACED', subjectType: 'transaction', subjectId: d.a.id,
        tier: 'fuzzy', ruleId: d.ruleId, ruleVersion: config.ruleVersion,
        confidence: d.score,
        reason: d.rejectedBecause,
        details: details({ counterpartId: d.b.id, score: d.score, breakdown: d.breakdown }),
      });
    }

    if (appliedAliasIds.length > 0) {
      await aliasRepo.recordAliasApplications(appliedAliasIds, c);
      for (const id of appliedAliasIds) {
        await audit.write({
          ...blank,
          eventType: 'ALIAS_APPLIED', subjectType: 'alias', subjectId: id,
          reason: `alias ${id} contributed to at least one Tier 1.5 match in this run`,
          details: { aliasId: id },
        });
      }
    }
    auditEntries += audit.count;
  });

  // ── S12 CLASSIFY ───────────────────────────────────────────────────────────
  await runsRepo.setRunStatus(runId, 'classifying');

  const exceptions = runClassification({
    pool: t15.pool, duplicates: deduped.findings, identity, tier2,
    batches: [], groups: assembled.matches, refused: assembled.refused, config,
  });

  await withTransaction(async (c) => {
    const audit = new PhaseAudit(c, runId);
    await excRepo.insertExceptions(runId, exceptions, c);
    for (const e of exceptions) {
      await audit.write({
        ...blank, transactionId: e.transactionId,
        eventType: 'EXCEPTION_RAISED', subjectType: 'exception',
        subjectId: e.transactionId ?? runId,
        ruleId: e.detectedByRule, ruleVersion: e.ruleVersion,
        decision: e.category, confidence: e.bestCandidateScore,
        reason: reasonForException(e),
        details: { category: e.category, secondaryFlags: e.secondaryFlags, severity: e.severity,
                   amountAtRiskPaise: e.amountAtRiskPaise,
                   candidatesConsidered: e.evidence.candidatesConsidered,
                   relatedTransactionIds: e.relatedTransactionIds },
      });
    }
    auditEntries += audit.count;
  });

  // ── S13 EXPLAIN — U11, Day 10 ──────────────────────────────────────────────
  // The status transition happens regardless so the poll target is truthful
  // about where the run is; with no explain layer the phase is a no-op and every
  // exception keeps `explanation_text = NULL`, which is exactly what the UI
  // renders as "not yet explained" rather than as an empty explanation.
  await runsRepo.setRunStatus(runId, 'explaining');

  // ── S14 METRICS + FINALIZE ─────────────────────────────────────────────────
  // `services/metrics/run-metrics.ts` is U8 (Day 9) and is deliberately still a
  // stub: ADR-040's denominator has three defensible readings and choosing one
  // is not a wiring decision. The population counts it will need are already
  // recorded in `runs.record_counts`, so U8 changes this call site and nothing
  // upstream of it.
  return await withTransaction(async (c) => {
    const audit = new PhaseAudit(c, runId);
    await audit.write({
      ...blank,
      eventType: 'RUN_COMPLETED', subjectType: 'run', subjectId: runId,
      reason:
        `run completed: ${assembled.matches.length} match groups, ` +
        `${exceptions.length} exceptions over ${counts.reconcilable} reconcilable records`,
      details: details({ matches: assembled.matches.length, exceptions: exceptions.length,
                         recordCounts: counts, refusedPairs: assembled.refused.length }),
    });
    await runsRepo.finishRun(runId, { status: 'completed' }, c);
    auditEntries += audit.count;

    return {
      runId, status: 'completed' as const, referenceDate: ingested.referenceDate,
      counts, matches: assembled.matches.length, exceptions: exceptions.length,
      auditEntries,
    };
  });
}

/** The config actually used, written verbatim (schema.md §4). */
async function persistConfigSnapshot(
  runId: string, config: RunConfig, c: TxClient,
): Promise<void> {
  await c.query(`UPDATE runs SET config_snapshot = $2 WHERE id = $1`,
    [runId, JSON.stringify(config)]);
}

/** §9.1's match events distinguish the tier that earned it and review from confirmation. */
function eventForMatch(tier: string, status: string): string {
  if (status === 'pending_review') return 'MATCH_FLAGGED_FOR_REVIEW';
  if (tier === 'exact') return 'MATCH_CONFIRMED_EXACT';
  if (tier === 'alias') return 'MATCH_CONFIRMED_ALIAS';
  if (tier === 'batch') return 'MATCH_CONFIRMED_FUZZY';
  return 'MATCH_CONFIRMED_FUZZY';
}

function reasonForMatch(m: matchRepo.Match): string {
  const roles = m.members.map((x) => x.role).join(' + ');
  const verb = m.status === 'pending_review' ? 'proposed for review' : 'matched';
  return `${roles} ${verb} at tier ${m.tier} with confidence ${m.confidence.toFixed(4)} (${m.ruleId})`;
}

function reasonForException(e: ClassifiedException): string {
  const flags = e.secondaryFlags.length === 0 ? '' : `, also flagged ${e.secondaryFlags.join(', ')}`;
  return `${e.category} raised at ${e.severity} severity by ${e.detectedByRule}${flags}`;
}

/**
 * ── Two stages this orchestrator does NOT run, and why that is stated rather
 * than hidden ──
 *
 * S10 (batch decomposition) is built and unit-tested in
 * `matching/batch-decomposition.ts`, but wiring it needs a decision this unit
 * should not make alone: which unmatched bank credits enter the pool, and how a
 * decomposition's members interact with S11's role-collision rule. Until it is
 * wired, `UNSPLITTABLE_BATCH` is never raised and those records fall into the
 * presence categories — visible in the exception counts, and NOT silently
 * absorbed.
 *
 * S13 (explain) and S14 (metrics) are U11 and U8. Both have their status
 * transitions and their call sites here; neither fabricates a value it cannot
 * compute. `runs.metrics` stays NULL until U8 fills it, which endpoint 5 already
 * renders as `409 RUN_NOT_COMPLETE` rather than as zeroes.
 */
export const UNWIRED_STAGES = ['S10_BATCH', 'S13_EXPLAIN', 'S14_METRICS'] as const;
