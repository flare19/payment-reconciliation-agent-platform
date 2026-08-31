/**
 * U12 — the Analyst's tool registry (agent-design.md §4, ADR-049, ADR-051).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * NINE TOOLS. NONE OF THEM WRITES — AND THAT IS ENFORCED THREE WAYS, NOT ASSERTED.
 *
 *   1. TYPE.     `AgentTool.readOnly` is the literal `true`. A tool that wanted
 *                to declare otherwise would not compile.
 *   2. RUNTIME.  Every handler runs inside `withReadOnlyTransaction` — Postgres
 *                `BEGIN TRANSACTION READ ONLY`. An INSERT/UPDATE/DELETE reached
 *                from any tool fails with SQLSTATE 25006 no matter what the
 *                calling code believes, INCLUDING through a repository function
 *                that was read-only when the tool was written and is not any
 *                more. This is the one that survives future edits.
 *   3. STRUCTURE. `createToolRegistry` refuses to build unless every entry is
 *                readOnly, the names are exactly the nine `agent-design.md` §4
 *                specifies, and none of them reads as a mutation. A tenth tool
 *                cannot appear by accident.
 *
 * `agent-design.md` §4 promises the agent "is not *trusted* not to write — it is
 * *unable* to." (2) is what makes that sentence true rather than aspirational:
 * the guarantee lives in the database, not in this file's good intentions.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── THE AGENT NEVER DOES ARITHMETIC (ADR-049) ──
 * `score_pair` calls `scorePair` — the same function S9 called, pinned to one
 * definition by `single-scorer-guard.test.ts`. `rerun_subset_search` calls
 * `decomposeBatch` — the same S10 search. Neither reimplements anything, and no
 * number in a reasoning chain is one the engine could not have produced.
 *
 * ── RESULT DIGESTS, NOT RAW DUMPS (§4) ──
 * Every tool returns a bounded, pre-shaped result and SAYS how much it did not
 * return. A tool that quietly hands back 50 of 300 rows invites a conclusion
 * drawn from a sample the model believes is the population — which is a
 * hallucination the grounding gate cannot catch, because every id in it is real.
 *
 * ── `returnedIds` IS THE GROUNDING ALLOW-LIST ──
 * Every id a tool actually returned is recorded, and A3 rejects any citation
 * that is not in that set. It must therefore be COMPLETE (an id returned but not
 * recorded makes a truthful citation look invented) and MINIMAL (an id recorded
 * but not returned launders a hallucination into an accepted verdict). Each tool
 * below derives it from the payload it is about to return, never from its own
 * arguments — an argument is what the model ASKED for, not what it was shown.
 */

import { withReadOnlyTransaction, type TxClient } from '../../db/pool.js';
import { AGENT_DEFAULTS } from '../../config/defaults.js';
import { formatPaise } from '../ingestion/money.js';
import type { AgentTool } from '../../types/agent.js';
import type { NormalizedTransaction, RunConfig } from '../../types/engine.js';

import { damerauLevenshteinWithin, scorePair } from '../matching/scoring.js';
import { ANCHOR_PREFIX_LEN } from '../matching/blocking.js';
import { decomposeBatch } from '../matching/batch-decomposition.js';

import * as txnRepo from '../../repositories/transactions.js';
import * as excRepo from '../../repositories/exceptions.js';
import * as auditRepo from '../../repositories/audit.js';
import * as aliasRepo from '../../repositories/aliases.js';

/** §4: the workhorse is bounded at 50 results. */
export const SEARCH_RESULT_CAP = 50;
/** Trails and similar-exception lookups are bounded too; a trail can be long. */
export const TRAIL_RESULT_CAP = 40;
export const SIMILAR_RESULT_CAP = 20;

/**
 * The nine names, exactly (agent-design.md §4).
 *
 * Declared as data so `createToolRegistry` can check the built registry against
 * the spec rather than against itself. A tool added without touching this list
 * fails construction; a tool in this list with no implementation does too.
 */
export const TOOL_NAMES = [
  'get_exception',
  'get_transaction',
  'search_transactions',
  'find_by_anchor',
  'get_audit_trail',
  'find_similar_exceptions',
  'score_pair',
  'rerun_subset_search',
  'check_alias',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Words that must never name a tool.
 *
 * Cheap, and it catches the realistic failure: someone adds `apply_alias` or
 * `confirm_match` because it would be convenient during a demo. It is a
 * tripwire, not the guarantee — the guarantee is the read-only transaction.
 */
const MUTATING_WORDS = [
  'create', 'insert', 'update', 'delete', 'write', 'apply', 'set', 'put',
  'confirm', 'reject', 'resolve', 'approve', 'save', 'persist', 'mark', 'patch',
];

export interface ToolContext {
  runId: string;
  /** The run's own `config_snapshot`, so locked code runs with the run's config. */
  config: RunConfig;
}

/** A record as the model sees it: bounded, pre-formatted, no raw payload. */
function recordDigest(t: NormalizedTransaction): Record<string, unknown> {
  return {
    transactionId: t.id,
    sourceSystem: t.sourceSystem,
    sourceRowNumber: t.sourceRowNumber,
    externalId: t.externalId,
    referenceIds: t.referenceIds,
    anchorStrength: t.anchorStrength,
    amountPaise: t.amountPaise,
    // api-contract §0: money is shown to a reader formatted, and carried as
    // paise. Both, always — a model handed only `12345` writes "12,345 rupees".
    amountDisplay: formatPaise(t.amountPaise),
    netAmountPaise: t.netAmountPaise,
    direction: t.direction,
    txnDate: t.txnDate,
    counterpartyNorm: t.counterpartyNorm,
    method: t.method,
    statusNorm: t.statusNorm,
    txnType: t.txnType,
  };
}

function digestOf(label: string, value: unknown): string {
  const json = JSON.stringify(value);
  return `${label}: ${json.length > 4000 ? `${json.slice(0, 4000)}… (truncated)` : json}`;
}

/**
 * Build the nine tools.
 *
 * Every handler receives the read-only client. None of them opens its own
 * connection, so there is no path by which a tool can escape the transaction it
 * was given.
 */
function buildTools(ctx: ToolContext): AgentTool[] {
  const inReadOnlyTx = async <T>(fn: (c: TxClient) => Promise<T>): Promise<T> =>
    withReadOnlyTransaction(fn);

  const tools: AgentTool[] = [
    {
      name: 'get_exception',
      description:
        'Fetch one exception with its full evidence: every candidate the engine considered, '
        + 'why each was rejected, the severity basis, and the search bounds that applied. '
        + 'The starting point of every investigation.',
      inputSchema: {
        type: 'object',
        properties: { exceptionId: { type: 'string' } },
        required: ['exceptionId'],
      },
      readOnly: true,
      async execute(args: unknown) {
        const { exceptionId } = args as { exceptionId: string };
        const e = await inReadOnlyTx((c) => excRepo.findException(exceptionId, c));
        if (e === null || e.runId !== ctx.runId) {
          // Scoped to THIS run: an agent investigating run A must not be able to
          // retrieve — and therefore cite — a record from run B.
          const result = { found: false, exceptionId };
          return { result, returnedIds: [], digest: digestOf('get_exception', result) };
        }
        const result = {
          found: true,
          exceptionId: e.id,
          category: e.category,
          secondaryFlags: e.secondaryFlags,
          severity: e.severity,
          status: e.status,
          transactionId: e.transactionId,
          relatedTransactionIds: e.relatedTransactionIds,
          amountAtRiskPaise: e.amountAtRiskPaise,
          amountAtRiskDisplay: e.amountAtRiskPaise === null
            ? null : formatPaise(e.amountAtRiskPaise),
          bestCandidateScore: e.bestCandidateScore,
          detectedByRule: e.detectedByRule,
          evidence: e.evidence,
          explanationText: e.explanationText,
          signatureHash: e.signatureHash,
        };
        // The exception id, its subject record, and every candidate the evidence
        // names — all of them genuinely returned here, so all of them citable.
        const returnedIds = [
          e.id,
          ...(e.transactionId === null ? [] : [e.transactionId]),
          ...e.relatedTransactionIds,
          ...e.evidence.candidates.map((c) => c.transactionId),
        ];
        return { result, returnedIds, digest: digestOf('get_exception', result) };
      },
    },

    {
      name: 'get_transaction',
      description:
        'Fetch one normalized record. Set includeRawPayload to also get the verbatim '
        + 'source row, which is how you find a reference that normalization dropped.',
      inputSchema: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          includeRawPayload: { type: 'boolean' },
        },
        required: ['transactionId'],
      },
      readOnly: true,
      async execute(args: unknown) {
        const { transactionId, includeRawPayload } =
          args as { transactionId: string; includeRawPayload?: boolean };
        const t = await inReadOnlyTx((c) => txnRepo.findTransaction(transactionId, c));
        if (t === null || t.runId !== ctx.runId) {
          const result = { found: false, transactionId };
          return { result, returnedIds: [], digest: digestOf('get_transaction', result) };
        }
        const result = {
          found: true,
          ...recordDigest(t),
          descriptionRaw: t.descriptionRaw,
          duplicateOfTransactionId: t.duplicateOfTransactionId,
          ingestWarnings: t.ingestWarnings,
          // §4: never by default. The raw row is the largest thing a tool can
          // return and it is only occasionally the thing that matters.
          rawPayload: includeRawPayload === true ? t.rawPayload : null,
        };
        const returnedIds = [t.id,
          ...(t.duplicateOfTransactionId === null ? [] : [t.duplicateOfTransactionId])];
        return { result, returnedIds, digest: digestOf('get_transaction', result) };
      },
    },

    {
      name: 'search_transactions',
      description:
        `Search this run's records. All filters optional and combinable. Returns at most `
        + `${SEARCH_RESULT_CAP} records, canonically ordered, and always reports how many `
        + `matched in total so you know whether you saw all of them.`,
      inputSchema: {
        type: 'object',
        properties: {
          sourceSystem: { type: 'string', enum: ['gateway', 'bank', 'ledger'] },
          direction: { type: 'string', enum: ['credit', 'debit'] },
          statusNorm: { type: 'string' },
          dateFrom: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
          dateTo: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
          amountMinPaise: { type: 'integer' },
          amountMaxPaise: { type: 'integer' },
          counterparty: { type: 'string', description: 'case-insensitive substring' },
          unmatchedOnly: { type: 'boolean' },
          limit: { type: 'integer' },
        },
      },
      readOnly: true,
      async execute(args: unknown) {
        const a = (args ?? {}) as Record<string, unknown>;
        const requested = typeof a['limit'] === 'number' ? a['limit'] : SEARCH_RESULT_CAP;
        const limit = Math.max(1, Math.min(SEARCH_RESULT_CAP, Math.floor(requested)));
        const filter: txnRepo.TransactionSearchFilter = {};
        if (typeof a['sourceSystem'] === 'string') filter.sourceSystem = a['sourceSystem'] as never;
        if (typeof a['direction'] === 'string') filter.direction = a['direction'] as never;
        if (typeof a['statusNorm'] === 'string') filter.statusNorm = a['statusNorm'] as never;
        if (typeof a['dateFrom'] === 'string') filter.dateFrom = a['dateFrom'];
        if (typeof a['dateTo'] === 'string') filter.dateTo = a['dateTo'];
        if (typeof a['amountMinPaise'] === 'number') filter.amountMinPaise = a['amountMinPaise'];
        if (typeof a['amountMaxPaise'] === 'number') filter.amountMaxPaise = a['amountMaxPaise'];
        if (typeof a['counterparty'] === 'string') filter.counterparty = a['counterparty'];
        if (a['unmatchedOnly'] === true) filter.unmatchedOnly = true;

        const { transactions, totalMatching } = await inReadOnlyTx((c) =>
          txnRepo.searchTransactionsForAgent(ctx.runId, filter, limit, c));

        const result = {
          returned: transactions.length,
          totalMatching,
          // Stated rather than implied. "31 matched, you are seeing 20" is the
          // difference between a bounded search and a misleading one.
          truncated: totalMatching > transactions.length,
          records: transactions.map(recordDigest),
        };
        return {
          result,
          returnedIds: transactions.map((t) => t.id),
          digest: digestOf('search_transactions', {
            returned: result.returned, totalMatching, truncated: result.truncated,
          }),
        };
      },
    },

    {
      name: 'find_by_anchor',
      description:
        'Find every record in this run carrying a reference value, under any reference key '
        + 'and in any source. mode "near" also returns values within one edit of yours, using '
        + "the engine's own edit-distance rule.",
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          mode: { type: 'string', enum: ['exact', 'near'] },
        },
        required: ['value'],
      },
      readOnly: true,
      async execute(args: unknown) {
        const { value, mode } = args as { value: string; mode?: 'exact' | 'near' };
        const exact = await inReadOnlyTx((c) =>
          txnRepo.findTransactionsByAnchorValue(ctx.runId, value, c));

        const near: { transaction: NormalizedTransaction; matchedValue: string;
          distance: number }[] = [];

        if (mode === 'near' && value.length >= ctx.config.nearAnchorMinLength) {
          const prefix = value.slice(0, ANCHOR_PREFIX_LEN);
          const block = await inReadOnlyTx((c) =>
            txnRepo.findTransactionsByAnchorPrefix(ctx.runId, prefix, ANCHOR_PREFIX_LEN, c));
          const exactIds = new Set(exact.map((t) => t.id));
          for (const { transaction, anchorValues } of block) {
            if (exactIds.has(transaction.id)) continue;
            for (const candidate of anchorValues) {
              if (candidate.length < ctx.config.nearAnchorMinLength) continue;
              // THE ENGINE'S edit distance, not a second one. `scoring.ts` owns
              // this function and `single-scorer-guard.test.ts` pins it to one
              // definition — a near-anchor rule that disagreed with S9's by one
              // character would put a number in a reasoning chain that the engine
              // would never have produced (ADR-049).
              const distance = damerauLevenshteinWithin(
                value, candidate, ctx.config.nearAnchorMaxDistance);
              if (distance >= 1 && distance <= ctx.config.nearAnchorMaxDistance) {
                near.push({ transaction, matchedValue: candidate, distance });
                break;
              }
            }
          }
        }

        const result = {
          value,
          mode: mode ?? 'exact',
          exact: exact.map(recordDigest),
          near: near.map((n) => ({
            ...recordDigest(n.transaction),
            matchedValue: n.matchedValue,
            editDistance: n.distance,
          })),
          // Said explicitly so "no near matches" is never confused with "near
          // matching was not attempted".
          nearSearched: mode === 'near' && value.length >= ctx.config.nearAnchorMinLength,
          nearSkippedReason: mode !== 'near'
            ? 'mode was not "near"'
            : value.length < ctx.config.nearAnchorMinLength
              ? `value is shorter than the ${ctx.config.nearAnchorMinLength}-character `
                + 'minimum for near-anchor comparison (ADR-031)'
              : null,
        };
        return {
          result,
          returnedIds: [...exact.map((t) => t.id), ...near.map((n) => n.transaction.id)],
          digest: digestOf('find_by_anchor',
            { value, exact: exact.length, near: near.length, nearSearched: result.nearSearched }),
        };
      },
    },

    {
      name: 'get_audit_trail',
      description:
        'Read what the ENGINE recorded about a record, match, exception or run — its own '
        + 'reasoning, in order. Use this before forming your own conclusion, so you do not '
        + 're-derive something the engine already decided and wrote down.',
      inputSchema: {
        type: 'object',
        properties: {
          subjectType: {
            type: 'string',
            enum: ['transaction', 'match', 'exception', 'alias', 'run', 'investigation'],
          },
          subjectId: { type: 'string' },
        },
        required: ['subjectType', 'subjectId'],
      },
      readOnly: true,
      async execute(args: unknown) {
        const { subjectType, subjectId } = args as { subjectType: string; subjectId: string };
        const entries = await inReadOnlyTx((c) =>
          auditRepo.readSubjectTrail(subjectType, subjectId, TRAIL_RESULT_CAP, c));
        // Cross-run entries are filtered out here rather than in SQL because the
        // alias chain legitimately has `run_id IS NULL`; the rule is "this run or
        // run-independent", not "this run".
        const scoped = entries.filter((e) => e.runId === ctx.runId || e.runId === null);
        const result = {
          subjectType,
          subjectId,
          returned: scoped.length,
          truncated: entries.length === TRAIL_RESULT_CAP,
          entries: scoped.map((e) => ({
            sequenceNo: e.sequenceNo,
            eventType: e.eventType,
            actorType: e.actorType,
            actorId: e.actorId,
            tier: e.tier,
            ruleId: e.ruleId,
            decision: e.decision,
            confidence: e.confidence,
            // The engine's own sentence. This is the payload of the tool.
            reason: e.reason,
            transactionId: e.transactionId,
            // `occurredAt` round-trips as a Date from the driver but as a
            // string through `canonicalize`, so both are possible here.
            occurredAt: e.occurredAt instanceof Date
              ? e.occurredAt.toISOString() : String(e.occurredAt),
          })),
        };
        const returnedIds = [
          ...scoped.map((e) => e.subjectId),
          ...scoped.flatMap((e) => (e.transactionId === null ? [] : [e.transactionId])),
          ...scoped.map((e) => String(e.sequenceNo)),
        ];
        return { result, returnedIds, digest: digestOf('get_audit_trail',
          { subjectType, subjectId, entries: scoped.length }) };
      },
    },

    {
      name: 'find_similar_exceptions',
      description:
        'Find prior exceptions of the same shape — by signatureHash for the exact discrepancy '
        + 'shape, or by category for a broader net. Includes how a human resolved them, if one '
        + 'did. Deliberately spans runs: a resolution from a previous run is the point.',
      inputSchema: {
        type: 'object',
        properties: {
          signatureHash: { type: 'string' },
          category: { type: 'string' },
          resolvedOnly: { type: 'boolean' },
          excludeExceptionId: { type: 'string' },
        },
      },
      readOnly: true,
      async execute(args: unknown) {
        const a = (args ?? {}) as Record<string, unknown>;
        const query: excRepo.SimilarExceptionQuery = {};
        if (typeof a['signatureHash'] === 'string') query.signatureHash = a['signatureHash'];
        if (typeof a['category'] === 'string') query.category = a['category'] as never;
        if (a['resolvedOnly'] === true) query.resolvedOnly = true;
        if (typeof a['excludeExceptionId'] === 'string') {
          query.excludeExceptionId = a['excludeExceptionId'];
        }
        if (query.signatureHash === undefined && query.category === undefined) {
          // Returned as a RESULT, not thrown: a malformed tool call is something
          // the model should see and correct on its next step, not something that
          // kills the investigation.
          const result = {
            error: 'find_similar_exceptions needs signatureHash or category',
            returned: 0, exceptions: [],
          };
          return { result, returnedIds: [], digest: digestOf('find_similar_exceptions', result) };
        }
        const similar = await inReadOnlyTx((c) =>
          excRepo.findSimilarExceptions(query, SIMILAR_RESULT_CAP, c));
        const result = {
          returned: similar.length,
          exceptions: similar.map((s) => ({
            exceptionId: s.id,
            runId: s.runId,
            sameRun: s.runId === ctx.runId,
            category: s.category,
            severity: s.severity,
            status: s.status,
            resolvedBy: s.resolvedBy,
            resolutionNote: s.resolutionNote,
            amountAtRiskDisplay: s.amountAtRiskPaise === null
              ? null : formatPaise(s.amountAtRiskPaise),
          })),
        };
        return {
          result,
          returnedIds: similar.map((s) => s.id),
          digest: digestOf('find_similar_exceptions', { returned: similar.length }),
        };
      },
    },

    {
      name: 'score_pair',
      description:
        'Ask whether two records would match, using the EXACT scorer the engine used at '
        + 'Tier 2. Returns the component breakdown, or which hard gate disqualified the pair. '
        + 'This is your only route to "would these match?" — never estimate it yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          transactionIdA: { type: 'string' },
          transactionIdB: { type: 'string' },
        },
        required: ['transactionIdA', 'transactionIdB'],
      },
      readOnly: true,
      async execute(args: unknown) {
        const { transactionIdA, transactionIdB } =
          args as { transactionIdA: string; transactionIdB: string };
        const [a, b] = await inReadOnlyTx(async (c) => Promise.all([
          txnRepo.findTransaction(transactionIdA, c),
          txnRepo.findTransaction(transactionIdB, c),
        ]));
        if (a === null || b === null || a.runId !== ctx.runId || b.runId !== ctx.runId) {
          const result = {
            error: 'both records must exist in this run',
            transactionIdA, transactionIdB,
            foundA: a !== null && a.runId === ctx.runId,
            foundB: b !== null && b.runId === ctx.runId,
          };
          return { result, returnedIds: [], digest: digestOf('score_pair', result) };
        }

        // THE ENGINE'S SCORER, with the RUN'S config. Not a copy, not a
        // re-derivation, not a fresh default config — the same function S9
        // called with the same numbers it used (ADR-049).
        const score = scorePair(a, b, ctx.config);

        const result = score.discarded
          ? {
            matched: false, discarded: true,
            reason: score.reason, ruleId: score.ruleId,
            transactionIdA: a.id, transactionIdB: b.id,
          }
          : {
            matched: false, discarded: false,
            score: score.score,
            breakdown: score.breakdown,
            ruleId: score.ruleId,
            anchorAgreement: score.anchor,
            amount: score.amount,
            date: score.date,
            transactionIdA: a.id, transactionIdB: b.id,
            // The bands the ENGINE would apply to this number, so the model never
            // has to remember or infer them. `matched` stays false because this
            // tool answers "how would this score", not "is this matched" — the
            // latter is a question about `matches`, which only S11 answers.
            wouldAutoConfirm: score.score >= ctx.config.fuzzyAutoConfirmThreshold,
            wouldReachReviewBand: score.score >= ctx.config.fuzzyReviewThreshold,
            autoConfirmThreshold: ctx.config.fuzzyAutoConfirmThreshold,
            reviewThreshold: ctx.config.fuzzyReviewThreshold,
          };
        return {
          result,
          returnedIds: [a.id, b.id],
          digest: digestOf('score_pair', result),
        };
      },
    },

    {
      name: 'rerun_subset_search',
      description:
        'Re-run the engine\'s own settlement decomposition for one bank credit with WIDER '
        + 'bounds than S10 used. Use this when an UNSPLITTABLE_BATCH reports searchBoundExceeded '
        + '— that is the engine saying it ran out of room, not that no answer exists. Both '
        + 'outcomes are useful: a decomposition found, or a stronger claim that none exists.',
      inputSchema: {
        type: 'object',
        properties: {
          bankTransactionId: { type: 'string' },
          poolSize: { type: 'integer', description: `max ${AGENT_DEFAULTS.rerunSubsetCeilings.poolSize}` },
          maxSubsetSize: { type: 'integer', description: `max ${AGENT_DEFAULTS.rerunSubsetCeilings.maxSubsetSize}` },
          nodeBudget: { type: 'integer', description: `max ${AGENT_DEFAULTS.rerunSubsetCeilings.nodeBudget}` },
        },
        required: ['bankTransactionId'],
      },
      readOnly: true,
      async execute(args: unknown) {
        const a = args as {
          bankTransactionId: string;
          poolSize?: number; maxSubsetSize?: number; nodeBudget?: number;
        };
        const ceilings = AGENT_DEFAULTS.rerunSubsetCeilings;
        // CLAMPED, not rejected. A model asking for a pool of a million gets the
        // ceiling and is told so; failing the call would spend a step teaching it
        // arithmetic it is not allowed to do anyway. The A3 gate separately
        // refuses a PROPOSAL that names bounds above these (ADR-085).
        const bounds = {
          poolSize: clamp(a.poolSize, ctx.config.batchPoolCap, ceilings.poolSize),
          maxSubsetSize: clamp(a.maxSubsetSize, ctx.config.batchMaxSubsetSize, ceilings.maxSubsetSize),
          nodeBudget: clamp(a.nodeBudget, ctx.config.batchNodeBudget, ceilings.nodeBudget),
        };

        const outcome = await inReadOnlyTx(async (c) => {
          const credit = await txnRepo.findTransaction(a.bankTransactionId, c);
          if (credit === null || credit.runId !== ctx.runId) return null;
          // S10's OWN population, UNCAPPED (issue #55). This used to be
          // `searchTransactionsForAgent({ unmatchedOnly: true }, bounds.poolSize)`,
          // which was wrong twice: `unmatchedOnly` asks whether a record is in any
          // match at all where the engine asks whether its BANK ROLE is open (54
          // records vs 14 on the holdout), and the LIMIT truncated by row number
          // BEFORE `buildBatchPool` applied the date window, the counterparty
          // filter and the date-proximity ranking — so widening `poolSize` widened
          // an arbitrary prefix rather than the search. `buildBatchPool` does the
          // capping, at `bounds.poolSize`, exactly as it does for the engine.
          const pool = await txnRepo.listBatchPoolCandidates(ctx.runId, c);
          // THE ENGINE'S SEARCH (ADR-049), with the run's config and only the
          // three bounds ADR-085 permits the agent to widen. `batchSubsetBudgetMs`
          // is NOT among them — it stays ADR-060's safety valve, so
          // `searchExhausted` remains a claim about the data rather than about
          // how fast this machine happens to be.
          const widened: RunConfig = {
            ...ctx.config,
            batchPoolCap: bounds.poolSize,
            batchMaxSubsetSize: bounds.maxSubsetSize,
            batchNodeBudget: bounds.nodeBudget,
          };
          return { credit, pool, outcome: decomposeBatch(credit, pool, widened) };
        });

        if (outcome === null) {
          const result = { error: 'bank record not found in this run', ...a };
          return { result, returnedIds: [], digest: digestOf('rerun_subset_search', result) };
        }

        const { credit, outcome: o } = outcome;
        const memberIds = o.kind === 'decomposed' ? o.members.map((m) => m.id) : [];
        // Every bound at or above the run's. A single narrowed dimension is enough
        // to make "stronger than the engine's" false, so this is an AND.
        const widerThanEngine =
          bounds.poolSize >= ctx.config.batchPoolCap
          && bounds.maxSubsetSize >= ctx.config.batchMaxSubsetSize
          && bounds.nodeBudget >= ctx.config.batchNodeBudget;
        const result = {
          bankTransactionId: credit.id,
          creditAmountDisplay: formatPaise(credit.amountPaise),
          boundsUsed: bounds,
          engineBounds: {
            poolSize: ctx.config.batchPoolCap,
            maxSubsetSize: ctx.config.batchMaxSubsetSize,
            nodeBudget: ctx.config.batchNodeBudget,
          },
          outcome: o.kind,
          reason: o.reason,
          stats: o.stats,
          members: o.kind === 'decomposed'
            ? o.members.map(recordDigest)
            : [],
          candidateSubsets: o.kind === 'ambiguous' ? o.subsets : null,
          // The honest reading of the result, spelled out so the model does not
          // have to infer it (§5). CONDITIONAL on the bounds actually being wider
          // (issue #55): "a stronger claim than the engine's" is only true when
          // nothing was narrowed, and the agent may pass bounds BELOW the run's.
          // Asserting it unconditionally handed the model a false statement in
          // deterministic prose, which is the one place it cannot check us.
          interpretation: !o.stats.exhaustive
            ? `The search stopped at a bound (${o.stats.boundHit?.bound ?? 'unknown'}). `
              + 'A decomposition may still exist; this is not a proof.'
            : widerThanEngine
              ? 'The whole declared space was searched, over the same candidate '
                + 'population the engine uses and at bounds no narrower than its own. '
                + 'This is a STRONGER claim than the engine\'s original one.'
              : 'The whole declared space was searched AT THESE BOUNDS, which are '
                + 'narrower than the engine\'s in at least one dimension (see '
                + 'engineBounds). This is NOT a stronger claim than the engine\'s. '
                + 'Re-run at or above the engine\'s bounds before concluding.',
        };
        return {
          result,
          returnedIds: [credit.id, ...memberIds, ...(o.kind === 'ambiguous' ? o.subsets.flat() : [])],
          digest: digestOf('rerun_subset_search',
            { outcome: o.kind, exhaustive: o.stats.exhaustive, members: memberIds.length }),
        };
      },
    },

    {
      name: 'check_alias',
      description:
        'Look up whether a counterparty value already has a human-confirmed alias, and how '
        + 'many records in this run share that value — the size of a proposed alias before '
        + 'anyone approves it.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      readOnly: true,
      async execute(args: unknown) {
        const { value } = args as { value: string };
        const normalized = value.trim().toUpperCase();
        const { aliases, wouldAlsoResolve } = await inReadOnlyTx(async (c) => ({
          aliases: await aliasRepo.listActiveAliases(c),
          wouldAlsoResolve: await txnRepo.countRecordsWithCounterparty(ctx.runId, normalized, c),
        }));
        const active = aliases.filter((al) => al.normalizedValue === normalized);
        const result = {
          value,
          normalizedValue: normalized,
          activeAliases: active.map((al) => ({
            aliasId: al.id,
            aliasType: al.aliasType,
            scopeSource: al.scopeSource,
            canonicalValue: al.canonicalValue,
            eligibleForAliasTier: al.eligibleForAliasTier,
          })),
          hasActiveAlias: active.length > 0,
          // The figure that makes a proposal reviewable: one record is a
          // footnote, forty is a decision.
          wouldAlsoResolve,
        };
        return {
          result,
          returnedIds: active.map((al) => al.id),
          digest: digestOf('check_alias',
            { normalized, hasActiveAlias: result.hasActiveAlias, wouldAlsoResolve }),
        };
      },
    },
  ];

  return tools;
}

function clamp(requested: number | undefined, fallback: number, ceiling: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return fallback;
  return Math.max(1, Math.min(ceiling, Math.floor(requested)));
}

export interface ToolRegistry {
  readonly tools: readonly AgentTool[];
  /** Lookup by name; `undefined` for a name the model invented. */
  get(name: string): AgentTool | undefined;
  /** The schemas, for the model's function-calling declaration. */
  declarations(): { name: string; description: string; parameters: Record<string, unknown> }[];
}

/**
 * Build the registry, refusing to return one that violates ADR-049 or ADR-051.
 *
 * These checks are CONSTRUCTION-TIME and they THROW. A registry that quietly
 * dropped a bad tool would leave the agent running with eight tools and no
 * indication of which one went missing; a registry that quietly accepted one
 * would be the design failure ADR-051 exists to make impossible.
 *
 * They are a tripwire, not the guarantee. The guarantee is that every handler
 * runs inside `withReadOnlyTransaction`, where Postgres itself rejects a write.
 */
export function createToolRegistry(ctx: ToolContext): ToolRegistry {
  const tools = buildTools(ctx);

  const names = tools.map((t) => t.name);
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    throw new Error(`tool registry: duplicate tool names ${duplicates.join(', ')}`);
  }

  const expected = [...TOOL_NAMES].sort();
  const actual = [...names].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `tool registry: the built tools do not match agent-design.md §4's nine. `
      + `Missing: [${expected.filter((n) => !actual.includes(n)).join(', ')}]. `
      + `Unexpected: [${actual.filter((n) => !expected.includes(n as ToolName)).join(', ')}]. `
      + `A tenth tool cannot appear by accident, and a write tool must never appear at all `
      + `(ADR-049, ADR-051).`);
  }

  for (const tool of tools) {
    if (tool.readOnly !== true) {
      throw new Error(`tool registry: ${tool.name} is not marked readOnly (ADR-051)`);
    }
    const lower = tool.name.toLowerCase();
    const offending = MUTATING_WORDS.find((w) =>
      lower === w || lower.startsWith(`${w}_`) || lower.includes(`_${w}_`) || lower.endsWith(`_${w}`));
    if (offending !== undefined) {
      throw new Error(
        `tool registry: ${tool.name} reads as a mutation ("${offending}"). Phase A proposes; `
        + `humans dispose through endpoints 16/20/21. If you need a write tool, the design has `
        + `gone wrong (ADR-049, ADR-051).`);
    }
    if (typeof tool.description !== 'string' || tool.description.length < 40) {
      throw new Error(`tool registry: ${tool.name} needs a description the model can act on`);
    }
  }

  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    tools: Object.freeze(tools),
    get: (name) => byName.get(name),
    declarations: () => tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
  };
}
