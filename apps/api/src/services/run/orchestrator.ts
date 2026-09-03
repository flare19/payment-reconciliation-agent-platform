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
  ClassifiedException, NormalizedTransaction, RunConfig, ActiveAlias,} from '../../types/engine.js';
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
import { runBatchStage } from '../matching/batch-stage.js';
import { runClassification } from '../classification/collect.js';
import { computeRunMetrics, type StageTimings } from '../metrics/run-metrics.js';
import {
  auditEventFor, planSignatures, resolveExplanations,
  type ExceptionToExplain, type ExplainStats,
} from '../explain/cache.js';
import type { ExplainLlmClient } from '../explain/llm-client.js';
import { PROMPT_VERSION } from '../explain/templates.js';
import type { TxForSignature } from '../explain/signature.js';
import { DEFAULT_EXPLAIN_MODEL } from '../../config/defaults.js';
import * as explainRepo from '../../repositories/explanations.js';

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

/**
 * What S13 needs that a `RunConfig` cannot carry.
 *
 * The API key and the model name are ENVIRONMENT, not run configuration — they
 * are not overridable per run and they must never reach `config_snapshot`.
 * They arrive here instead, injected by the route, so the orchestrator has no
 * dependency on `loadEnv()` and a test can hand it a fake client.
 *
 * `model` is required even when `client` is null, and that is not redundant:
 * the model name is hashed into every `signature_hash` (ADR-018), so a keyless
 * run must compute the SAME hashes a keyed run would. If it used a placeholder,
 * the day a key arrives every signature would change and the cache the keyless
 * runs had been checking against would be a different namespace.
 */
export interface ExplainDeps {
  /** `null` when there is no key or `LLM_EXPLAIN_ENABLED=false`. A legitimate state. */
  client: ExplainLlmClient | null;
  /** The CONFIGURED explain model, whether or not a client exists. */
  model: string;
  promptVersion: string;
}

const DEFAULT_EXPLAIN_DEPS: ExplainDeps = {
  client: null, model: DEFAULT_EXPLAIN_MODEL, promptVersion: PROMPT_VERSION,
};

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

/**
 * S5-S11, as a pure function of (pool, config, aliases).
 *
 * Extracted so it can run TWICE (ADR-132): once with the run's real alias set —
 * that IS the run — and once with an empty one, to compute what the engine
 * would have matched on its own. Nothing here touches the database, writes an
 * audit entry, or reads a clock. `time` is the only injected dependency, and
 * the cold pass passes a no-op so a counterfactual can never pollute the run's
 * reported stage timings.
 *
 * THE TWO PASSES SHARE NO MUTABLE STATE, and that is load-bearing rather than
 * incidental: `runTier15` returns COPIED records (`{ ...t, counterpartyKey }`)
 * instead of mutating, and each pass builds its own block indexes — the only
 * thing `rebuildCounterpartyIndex` writes to. It is asserted rather than
 * assumed: on a cold run the counterfactual must reproduce the run's own
 * matched set exactly, and `computeRunMetrics` refuses to publish if it does
 * not.
 */
export function runMatchingPipeline(
  pool: NormalizedTransaction[],
  config: RunConfig,
  aliases: readonly ActiveAlias[],
  time: <T>(name: string, f: () => T) => T,
) {
  const blocks = time('block', () => buildBlockIndexes(pool));
  const t1 = time('tier1', () => runTier1(blocks, config));
  const claimedByExact = new Set(t1.matches.flatMap((m) => [m.aId, m.bId]));
  const t15 = time('tier15', () => runTier15(pool, config, aliases, claimedByExact));
  rebuildCounterpartyIndex(blocks, t15.pool);

  const exactPairs = [...t1.matches, ...t15.matches];

  // S8 — identity short-circuit. Every verdict it reaches is a pair Tier 2 must
  // NOT re-score: a similarity score may never overturn a deterministic identity
  // verdict (matching-engine §6.3).
  const identity = time('identity', () => resolveIdentities(t15.pool, config));
  const settled = new Set<string>();
  for (const { pair, verdict } of identity) {
    if (verdict.kind !== 'not_established') settled.add(pairKeyOf(pair[0].id, pair[1].id));
  }

  // S6/S7's PAIRS, not their records (§6.3, issue #40). A gateway matched to its
  // ledger row still needs Tier 2 to find its bank leg, or §10 rule 2's 3-way
  // group can never form and the bank leg becomes a MISSING_IN_BANK exception
  // that reports having considered nothing.
  const tier2 = time('tier2', () => runTier2(blocks, config, exactPairs, settled));

  // ── S10 BATCH (issue #46) ───────────────────────────────────────────────────
  // Sees only what S6-S9 left unmatched, so it can extend the engine's output
  // but never contradict it. The two decisions U6 declined to make alone — which
  // records enter the pool, and how a decomposition interacts with S11's
  // role-collision rule — are argued in `batch-stage.ts`'s header.
  const byId = new Map<string, NormalizedTransaction>(t15.pool.map((t) => [t.id, t]));
  const tierPairs: GroupPair[] = [
    ...exactPairs.map((m) => fromTier1(m, byId)).filter((p): p is GroupPair => p !== null),
    ...tier2.accepted.map(fromTier2),
  ];
  // S10 reads counterparts PER ROLE from these pairs (#49). "Has this gateway a
  // BANK leg?" is the question; "is it in any group?" is the one that emptied
  // the pool and is the #40 error one stage later.
  const batch = time('batch', () => runBatchStage(t15.pool, tierPairs, config));

  // A tier pair a split absorbed is dropped, not kept beside it (#51, ADR-079):
  // rule 3 admits multiple members of one role only through pairs that DECLARE
  // the exception, so a non-declaring fuzzy pair beside three declaring ones is
  // refused and its leg falls out of the group the stage just proved.
  const superseded = new Set(batch.supersededTierPairs.map((p) => pairKeyOf(p.aId, p.bId)));
  const groupPairs: GroupPair[] = [
    ...tierPairs.filter((p) => !superseded.has(pairKeyOf(p.a.id, p.b.id))),
    ...batch.splitPairs,
  ];
  // S10's verdicts arrive as pre-formed GROUPS, not pairs: a decomposition is
  // already a group, and `assembleGroups` marks their members `inBatch` so no
  // pairwise pair can claim one of them (§10 rule 3).
  const assembled = time('group', () => assembleGroups(groupPairs, batch.groups));
  return { t15, exactPairs, identity, tier2, batch, assembled };
}

export async function executeRun(
  runId: string, sources: RunSources, baseConfig: Omit<RunConfig, 'referenceDate' | 'aliasCountAtStart'>,
  explain: ExplainDeps = DEFAULT_EXPLAIN_DEPS,
): Promise<RunOutcome> {
  try {
    return await runPhases(runId, sources, baseConfig, explain);
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
  explain: ExplainDeps,
): Promise<RunOutcome> {
  let auditEntries = 0;

  // ── S0 LOAD + S1–S3 PARSE/NORMALIZE/EXCLUDE ────────────────────────────────
  await runsRepo.setRunStatus(runId, 'ingesting');

  // Stage timings are MEASURED, not estimated (schema.md §11.1). `Date.now()` is
  // legal here — ADR-039 forbids the wall clock in the DECISION path, and a
  // duration influences no match, no category and no score. It reaches only
  // `metrics.throughput`, which is a claim about this machine rather than about
  // the data.
  const startedAt = Date.now();
  const stage = new StageClock();

  const inputFileHashes = {
    gateway: hashSource(sources.gateway),
    bank: hashSource(sources.bank),
    ledger: hashSource(sources.ledger),
  };
  const ingested = stage.time('parse', () => ingestSources({ runId, files: sources }));

  // The alias set is read ONCE, before matching, and its size is snapshotted.
  // A run's output must be a pure function of (files, config, active aliases);
  // re-reading mid-run would let a concurrent alias write change the answer
  // halfway through and make the run unreproducible.
  //
  // ── `aliasLearningEnabled: false` MEANS THE RUN SEES NO ALIASES ────────────
  // api-contract §2 names this field as *the* way to measure the cold-start
  // rate, and until now it was parsed, persisted into `config_snapshot` and
  // enforced NOWHERE: the override was accepted and the run came back warm.
  // That is the defect shape CLAUDE.md §10 names — a knob that is documented
  // and inert — and this is its third instance.
  //
  // Loading `[]` is the whole fix, because every downstream consumer already
  // derives coldness from the alias set rather than from the flag:
  // `aliasCountAtStart` becomes 0, `run-metrics` therefore reports
  // `isCold: true` (ADR-020), and the cold counterfactual below correctly
  // skips its second pipeline pass because the warm run IS the cold run.
  // Nothing reads the flag downstream, so nothing else needs to change.
  //
  // Scope: this governs whether a RUN APPLIES aliases, not whether a human may
  // teach one. Approving a match with `aliasProposals` (endpoint 10) still
  // creates the alias — that is a human decision outside the run's lifecycle,
  // and ADR-020 defines cold start as the rate "with aliases disabled", not as
  // a mode in which corrections cannot be recorded.
  const aliases = baseConfig.aliasLearningEnabled
    ? await aliasRepo.listActiveAliases()
    : [];

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

  const deduped = stage.time('dedupe', () => dedupe(ingested.transactions));
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

  const warm = runMatchingPipeline(deduped.pool, config, aliases, (n, f) => stage.time(n, f));
  const { t15, exactPairs, identity, tier2, batch, assembled } = warm;

  /**
   * THE COLD COUNTERFACTUAL (ADR-132): the same pool and config with NO
   * aliases. ADR-020 defines cold start as the rate "with aliases disabled",
   * and until ADR-130 it was literally the same expression as the warm rate.
   * It is COMPUTED here rather than estimated, because an alias changes
   * blocking and candidate generation as well as scoring — so subtracting
   * alias-touched records gives a bound, not an answer.
   *
   * Skipped on a cold run, where the run's own figures ARE the cold ones.
   */
  const cold = aliases.length === 0
    ? null
    : runMatchingPipeline(deduped.pool, config, [], (_n, f) => f());

  /**
   * EVERY alias that actually resolved a counterparty key, not only those that
   * produced a Tier 1.5 match (ADR-130). A counterparty alias cannot make a
   * Tier 1.5 match — that tier re-runs the Tier 1 exact test, which needs a
   * strong anchor — so gating attribution on it meant `applied_count` stayed 0
   * and no `ALIAS_APPLIED` entry was ever written for the alias family the
   * review queue actually teaches.
   */
  const appliedAliasIds = [...new Set([
    ...exactPairs.flatMap((m) => m.aliasIds),
    ...t15.counterpartyResolutions.map((r) => r.appliedAliasId),
  ])];

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
          reason: `alias ${id} resolved at least one counterparty key in this run`,
          details: { aliasId: id },
        });
      }
    }
    auditEntries += audit.count;
  });

  // ── S12 CLASSIFY ───────────────────────────────────────────────────────────
  await runsRepo.setRunStatus(runId, 'classifying');

  const exceptions = stage.time('classify', () => runClassification({
    pool: t15.pool, duplicates: deduped.findings, identity, tier2,
    // Every credit S10 examined, verdict included (§11 entry 3). `decomposed`
    // outcomes are skipped by the classifier — they became groups above; the
    // `unsplittable` and `ambiguous` ones are what raise UNSPLITTABLE_BATCH and
    // AMBIGUOUS_MATCH, carrying the bound that stopped the search (ADR-038).
    batches: batch.batches,
    groups: assembled.matches, refused: assembled.refused, config,
  }));

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

  // ── S13 EXPLAIN (U11) ──────────────────────────────────────────────────────
  // Runs over the exceptions S12 ALREADY COMMITTED (schema.md §10.1) — that is
  // what makes ADR-017's boundary structural rather than a promise: by the time
  // any prose exists, every category and severity is already a durable row.
  //
  // With no API key this phase still runs and still does work; it writes the
  // hand-written template for every signature. That is the primary path here,
  // not a degraded one, and it is why `explanation_text` is never NULL on a
  // completed run.
  await runsRepo.setRunStatus(runId, 'explaining');
  const explained = await stage.timeAsync('explain', () =>
    runExplainPhase(runId, ingested.transactions, config, explain));
  auditEntries += explained.auditEntries;

  // ── S14 METRICS + FINALIZE ─────────────────────────────────────────────────
  // `computeRunMetrics` re-derives ADR-040's denominator and THROWS if the
  // formula disagrees with the population the engine actually matched over. That
  // failure is deliberately loud and deliberately here: a run that cannot
  // account for its own denominator must not publish a match rate, and the
  // failure path below records it as a failed run rather than a completed one
  // carrying a number nobody can reconcile.
  const aliasCounts = await aliasRepo.aliasStatusCounts();
  const metrics = computeRunMetrics({
    population: {
      gateway: counts.gateway, bank: counts.bank, ledger: counts.ledger,
      excluded: counts.excluded, rejected: counts.rejected,
      nonPrimaryDuplicates: counts.nonPrimaryDuplicates,
    },
    pool: t15.pool,
    exactPairs,
    tier2,
    identity,
    groups: assembled.matches,
    exceptions,
    aliasCountAtStart: config.aliasCountAtStart,
    counterpartyResolutions: t15.counterpartyResolutions,
    coldGroups: cold === null ? null : cold.assembled.matches,
    aliasCounts,
    // Every alias ever taught is a correction a human made, revoked ones
    // included — see `aliasStatusCounts`. Dropping the revoked ones would
    // flatter the leverage ratio by hiding the corrections that were wrong.
    humanCorrectionsToDate: aliasCounts.active + aliasCounts.superseded + aliasCounts.revoked,
    batchOutcomes: batch.batches.map((b) => ({ stats: b.outcome.stats })),
    batchPairs: batch.splitPairs,
    timings: stage.finish(startedAt),
    config,
    explain: {
      ...explained.stats,
      model: explain.model,
      promptVersion: explain.promptVersion,
      callCapPerRun: config.llmMaxCallsPerRun,
    },
  });

  return await withTransaction(async (c) => {
    const audit = new PhaseAudit(c, runId);
    await runsRepo.setRunMetrics(runId, metrics, c);
    await audit.write({
      ...blank,
      eventType: 'RUN_COMPLETED', subjectType: 'run', subjectId: runId,
      reason:
        `run completed: ${assembled.matches.length} match groups, ` +
        `${exceptions.length} exceptions over ${counts.reconcilable} reconcilable records, ` +
        `match rate ${metrics.matchRate.matchRatePct}%`,
      // The headline goes in the CHAIN, not only in `runs.metrics`. `runs` is a
      // mutable row; the audit log is append-only and hash-chained, so a number
      // recorded here cannot be quietly restated later (ADR-042).
      details: details({ matches: assembled.matches.length, exceptions: exceptions.length,
                         recordCounts: counts, refusedPairs: assembled.refused.length,
                         matchRate: metrics.matchRate, tierAttribution: metrics.tierAttribution }),
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

/**
 * S13, end to end.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE READS AND THE MODEL CALLS HAPPEN OUTSIDE ANY TRANSACTION; THE WRITES
 * HAPPEN INSIDE ONE.
 *
 * Every other phase in this file opens its transaction first and works inside
 * it. This one must not. A batch call can take up to 20 seconds and there can
 * be eight of them, and `appendAuditEntry` holds a transaction-scoped advisory
 * lock on the run's chain for the life of its transaction — so wrapping the
 * model calls would hold that lock across minutes of network I/O, block every
 * other append, and expose the run to a managed-Postgres idle-in-transaction
 * timeout on the platform this deploys to. The stage is slow because it talks
 * to a model; the WRITE has no reason to inherit that.
 *
 * The cost of the split is the ordinary one: a crash between the model call and
 * the write loses the prose and keeps the exceptions at `open`. That is the
 * correct direction to fail — a re-run regenerates it, and nothing about the
 * reconciliation itself is affected, because S13 changes no decision (ADR-017).
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── ONE AUDIT ENTRY PER SIGNATURE, NOT PER EXCEPTION ──
 * The DECISION is made once per signature: call the model, reuse the cache, or
 * take the template. Fanning the same verdict out to every exception sharing
 * that signature would be TRANSCRIPTION, and this file already draws that line
 * for ingestion — one entry per source, not one per row, for exactly the reason
 * §9.1 floors `MATCH_CANDIDATE_REJECTED` at 0.40. Each entry names the
 * exceptions it covers, and every exception's own row carries
 * `explanation_source` and `signature_hash`, so nothing is lost by not
 * repeating it a few hundred times in a hash-chained log.
 */
async function runExplainPhase(
  runId: string,
  allTransactions: readonly NormalizedTransaction[],
  config: RunConfig,
  explain: ExplainDeps,
): Promise<{ stats: ExplainStats; auditEntries: number }> {
  // Every ingested row, not the deduped pool: a DUPLICATE_RECORD exception is
  // raised ON the non-primary copy, which S4 removed from the pool. Signing it
  // against the pool alone would report `sources_present: unknown` for the one
  // category whose subject is guaranteed to be missing from it.
  const txById = new Map<string, TxForSignature>(
    allTransactions.map((t) => [t.id, t]));

  // The persisted rows, which carry the `id` the fan-out needs. `listUnexplained`
  // is S13's work list and is already ordered by severity.
  const pending = await excRepo.listUnexplained(runId, Number.MAX_SAFE_INTEGER);
  const toExplain: ExceptionToExplain[] = pending.map((e) => ({
    id: e.id,
    transactionId: e.transactionId,
    relatedTransactionIds: e.relatedTransactionIds,
    category: e.category,
    secondaryFlags: e.secondaryFlags,
    evidence: e.evidence,
    severity: e.severity,
  }));

  const groups = planSignatures(toExplain, txById, {
    promptVersion: explain.promptVersion, model: explain.model,
  });

  const { resolved, stats } = await resolveExplanations(groups, {
    // `llmExplainEnabled` is per-run config (api-contract §2 allows overriding
    // it), so a run may switch the model off even where a key exists.
    client: config.llmExplainEnabled ? explain.client : null,
    lookupCache: async (hash) => {
      const hit = await explainRepo.getCachedExplanation(hash);
      return hit === null ? null : {
        explanationText: hit.explanationText,
        suggestedAction: hit.suggestedAction,
        tokensIn: hit.tokensIn,
        tokensOut: hit.tokensOut,
      };
    },
  }, { llmMaxCallsPerRun: config.llmMaxCallsPerRun });

  let written = 0;
  await withTransaction(async (c) => {
    const audit = new PhaseAudit(c, runId);

    for (const r of resolved) {
      // ADR-084: only fresh model output is cached. A template row would be
      // served as a HIT by every later run — including runs that have a key —
      // so one keyless afternoon would permanently stop that signature ever
      // reaching the model, silently.
      if (r.needsCacheWrite) {
        await explainRepo.putExplanation({
          signatureHash: r.hash,
          promptVersion: explain.promptVersion,
          model: explain.model,
          category: r.category,
          signatureInput: { ...r.components },
          explanationText: r.explanationText,
          suggestedAction: r.suggestedAction,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
        }, c);
      }

      for (const exceptionId of r.exceptionIds) {
        await excRepo.setExplanation(exceptionId, {
          explanationText: r.explanationText,
          suggestedAction: r.suggestedAction,
          explanationSource: r.source,
          signatureHash: r.hash,
        }, c);
      }

      await audit.write({
        ...blank,
        eventType: auditEventFor(r.source),
        subjectType: 'run', subjectId: runId,
        // The model is the ACTOR only where it actually wrote the words. A
        // template attributed to `llm` would misrepresent what produced the
        // text a panelist is reading.
        decision: r.source,
        reason: r.reason,
        details: details({
          signatureHash: r.hash,
          signatureInput: { ...r.components },
          category: r.category,
          explanationSource: r.source,
          occurrenceCount: r.occurrenceCount,
          exceptionIds: r.exceptionIds,
          templateCause: r.templateCause,
        }),
      });
    }
    written = audit.count;
  });

  return { stats, auditEntries: written };
}

/**
 * Per-stage wall-clock, accumulated as the run walks S1 -> S12.
 *
 * Accumulating rather than assigning: `tier15` runs once today, but a stage that
 * is ever called twice should report the total it cost, not the last call. A
 * timing that silently drops earlier work is the throughput equivalent of a
 * recall test with a loose floor.
 *
 * Stages that did not run report `null`, never `0` (schema.md §11.1). `0 ms` is
 * a performance claim; `null` is an absence, and S10 and S13 are absences.
 */
class StageClock {
  private readonly ms = new Map<string, number>();

  time<T>(name: string, fn: () => T): T {
    const t0 = Date.now();
    try {
      return fn();
    } finally {
      this.ms.set(name, (this.ms.get(name) ?? 0) + (Date.now() - t0));
    }
  }

  /**
   * S13 is the only stage that awaits, and it awaits the network. Its figure is
   * therefore NOT comparable to the others and is deliberately excluded from
   * `engineMs` below — folding model latency into an engine throughput number
   * would make the headline a claim about Google's servers.
   */
  async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.ms.set(name, (this.ms.get(name) ?? 0) + (Date.now() - t0));
    }
  }

  private get(name: string): number {
    return this.ms.get(name) ?? 0;
  }

  finish(startedAt: number): StageTimings {
    // Parsing and normalization are one pass in `ingestSources` and cannot be
    // separated without instrumenting the parsers themselves. Reported as
    // `parse`, with `normalize` at 0 rather than inventing a split — a made-up
    // breakdown is worse than a coarser true one.
    const engineMs = ['parse', 'dedupe', 'block', 'tier1', 'tier15', 'identity',
      'tier2', 'group', 'classify'].reduce((sum, k) => sum + this.get(k), 0);
    return {
      parse: this.get('parse'),
      normalize: 0,
      dedupe: this.get('dedupe'),
      block: this.get('block'),
      tier1: this.get('tier1'),
      tier15: this.get('tier15'),
      identity: this.get('identity'),
      tier2: this.get('tier2'),
      batch: this.get('batch'),
      group: this.get('group'),
      classify: this.get('classify'),
      // S13 runs on every run since U11 — with no key it writes templates,
      // which is work, not an absence. A real measurement, never null.
      explain: this.get('explain'),
      engineMs,
      wallClockMs: Date.now() - startedAt,
    };
  }
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
 * ── EVERY STAGE NOW RUNS ──
 *
 * This list is EMPTY, and it is kept rather than deleted because the rule it
 * enforces is what mattered: a stage that did not run reports `null`, never
 * `0`, and names itself here so a reader never has to consult the source to
 * find out which figures are findings and which are absences.
 *
 * The three that were once on it, and when each came off:
 *   S14 metrics             — Day 9 (U8)
 *   S10 batch decomposition — Day 10 (issue #46)
 *   S13 explain             — Day 11 (U11)
 *
 * S13's departure is the one worth stating precisely, because "it ran" is a
 * weaker claim than it looks: with no API key the stage still executes and
 * still writes a hand-written template for every signature (schema.md §10.1).
 * So `metrics.llmCost` is now an object on every run — but `apiCalls: 0` beside
 * `signaturesTemplated: 27` says "no model was called", which is a different
 * and honest claim from the `null` that used to mean "there is no explain
 * layer".
 */
export const UNWIRED_STAGES = [] as const;
