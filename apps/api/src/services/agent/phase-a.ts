/**
 * A4 + the Phase A run orchestration (agent-design.md §3, ADR-048, ADR-052). U13.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * PHASE A RUNS STRICTLY AFTER S14, AS A SEPARATE JOB (ADR-048).
 *
 * It is deliberately NOT called from `executeRun`. The engine must produce
 * byte-identical output with `AGENT_ENABLED=false`, and the cheapest way to
 * guarantee that is for the orchestrator to contain no reference to this file
 * at all. Phase A reads a FINISHED run the way the offline scorer does.
 *
 * It cannot modify a match, an exception, a confidence, a category or a metric.
 * The tool registry is read-only at the database level (`withReadOnlyTransaction`,
 * SQLSTATE 25006), and the only rows this file writes are `agent_investigations`
 * and `audit_log` — its own account of its own work.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── THE SHARED REQUEST BUDGET IS ENFORCED HERE ──
 * A1 applies only the two per-list caps; §3's shared
 * `AGENT_MAX_LLM_REQUESTS_PER_RUN` is spent here, where requests are real and
 * countable. Reserving it at plan time against each investigation's 10-step
 * CEILING would have starved ADR-081's queue work on a worst case that rarely
 * happens (see `triage.ts`). Exceptions run first; queue corroboration is what
 * gets cut, which ADR-081 decided in advance precisely so it is not decided
 * under pressure on submission day.
 *
 * ── EVERY OUTCOME IS PERSISTED, INCLUDING THE UNFLATTERING ONES ──
 * A grounding failure, a budget exhaustion and a transport error are all
 * recorded as investigations with a stated cause. §7 reads the grounding-failure
 * count as a signal that the prompt or tools need work, so suppressing one would
 * corrupt the only metric that can tell us this layer is drifting.
 */

import { AGENT_DEFAULTS } from '../../config/defaults.js';
import { withTransaction, type TxClient } from '../../db/pool.js';
import type { InvestigationBudget, ToolCallRecord } from '../../types/agent.js';
import type { CanonicalValue } from '../audit/canonical-json.js';

import * as invRepo from '../../repositories/investigations.js';
import * as excRepo from '../../repositories/exceptions.js';
import * as txnRepo from '../../repositories/transactions.js';
import * as auditRepo from '../../repositories/audit.js';
import * as aliasRepo from '../../repositories/aliases.js';
import * as matchRepo from '../../repositories/matches.js';

import { investigate, reasoningChain, type InvestigationOutcome } from './investigation-loop.js';
import { buildInvestigationPrompt } from './investigation-prompt.js';
import { createToolRegistry } from './tool-registry.js';
import { triageRun, type TriagePlan } from './triage.js';
import type { AgentLlmClient, AgentUsage, CostModel } from './agent-client.js';
import { usdFor } from './agent-client.js';
import type { RunConfig } from '../../types/engine.js';
import type { GateContext } from './grounding-gate.js';

/** ADR-052: agent traces live in `audit_log`, hash-chained like everything else. */
const ANALYST = { actorType: 'agent', actorId: 'analyst@1.0.0' } as const;

const blank = {
  transactionId: null, tier: null, ruleId: null, ruleVersion: null,
  decision: null, confidence: null, beforeState: null, afterState: null,
} as const;

function details(value: object): Record<string, CanonicalValue> {
  return value as Record<string, CanonicalValue>;
}

export interface PhaseADeps {
  client: AgentLlmClient;
  config: RunConfig;
  /** Rates for the model in use. Null when nothing is billed (free tier). */
  cost: CostModel | null;
  promptVersion?: string;
  budget?: InvestigationBudget;
  maxLlmRequests?: number;
  now?: () => number;
}

export interface PhaseAResult {
  runId: string;
  plan: TriagePlan;
  investigated: number;
  /** Investigations not attempted because the shared request budget ran out. */
  skippedForBudget: number;
  verdicts: Record<string, number>;
  groundingFailures: number;
  budgetExhaustedCount: number;
  requestsSpent: number;
  usage: AgentUsage;
  costUsd: number | null;
  auditEntries: number;
}

/**
 * The A3 evidence base that is the same for every investigation in a run.
 *
 * Built ONCE per run and shared — but note what is NOT shared: `toolCalls`. The
 * loop supplies those per investigation and the gate throws if they carry
 * another investigation's id (#21). Sharing the record map is safe because it is
 * a description of the run; sharing tool calls would be the laundering the
 * per-investigation rule exists to prevent.
 */
async function buildGateContext(
  runId: string,
): Promise<Omit<GateContext, 'investigationId' | 'toolCalls'>> {
  const [records, aliases, matchedIds] = await Promise.all([
    txnRepo.listTransactions(runId),
    aliasRepo.listActiveAliases(),
    matchRepo.listMatchedTransactionIds(runId),
  ]);
  const matched = new Set(matchedIds);
  return {
    runId,
    records: new Map(records.map((t) => [t.id, {
      runId: t.runId,
      sourceSystem: t.sourceSystem,
      direction: t.direction,
      alreadyMatched: matched.has(t.id),
    }])),
    activeAliases: new Map(
      aliases.map((a) => [`${a.aliasType}::${a.normalizedValue}`, a.canonicalValue])),
  };
}

/** One investigation, start to persisted verdict. */
export async function investigateOne(
  runId: string,
  exceptionId: string,
  deps: PhaseADeps,
  gateContext: Omit<GateContext, 'investigationId' | 'toolCalls'>,
): Promise<{ outcome: InvestigationOutcome; investigationId: string; auditEntries: number }> {
  const budget = deps.budget ?? AGENT_DEFAULTS.budget;
  const promptVersion = deps.promptVersion ?? 'agent-v1';
  let auditEntries = 0;

  const exception = await excRepo.findException(exceptionId);
  if (exception === null || exception.runId !== runId) {
    throw new Error(`investigateOne: exception ${exceptionId} is not in run ${runId}`);
  }

  const investigation = await invRepo.startInvestigation({
    runId, exceptionId, model: deps.client.model, promptVersion });

  const append = async (
    entry: Parameters<typeof auditRepo.appendAuditEntry>[0],
  ): Promise<void> => {
    await withTransaction((c: TxClient) => auditRepo.appendAuditEntry(entry, c));
    auditEntries += 1;
  };

  await append({
    ...blank, ...ANALYST, runId,
    eventType: 'INVESTIGATION_STARTED', subjectType: 'investigation',
    subjectId: investigation.id,
    transactionId: exception.transactionId,
    reason:
      `investigation opened on ${exception.category} exception ${exceptionId} `
      + `(${exception.severity} severity) using ${deps.client.model}`,
    details: details({ exceptionId, category: exception.category,
      severity: exception.severity, model: deps.client.model, promptVersion }),
  });

  const [subject, trail] = await Promise.all([
    exception.transactionId === null
      ? Promise.resolve(null)
      : txnRepo.findTransaction(exception.transactionId),
    auditRepo.readSubjectTrail('exception', exception.transactionId ?? exceptionId, 20),
  ]);

  const registry = createToolRegistry({ runId, config: deps.config });
  const outcome = await investigate(
    {
      investigationId: investigation.id,
      runId,
      exceptionId,
      prompt: buildInvestigationPrompt({
        exception,
        subject,
        engineTrail: trail.map((t) => ({ eventType: t.eventType, reason: t.reason })),
      }),
    },
    {
      client: deps.client,
      registry,
      gateContext,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      // §3: written AS IT HAPPENS, so a budget-stopped investigation still
      // leaves a complete ordered trail of what it actually did.
      onToolCall: async (record: ToolCallRecord) => {
        await append({
          ...blank, ...ANALYST, runId,
          eventType: 'AGENT_TOOL_CALLED', subjectType: 'investigation',
          subjectId: investigation.id,
          reason: `step ${record.step}: called ${record.tool}, `
            + `which returned ${record.returnedIds.length} citable id(s) in ${record.durationMs} ms`,
          details: details({
            step: record.step, tool: record.tool, arguments: record.arguments,
            returnedIds: record.returnedIds, resultDigest: record.resultDigest,
            durationMs: record.durationMs,
          }),
        });
      },
    },
    budget);

  const costUsd = deps.cost === null ? null : usdFor(outcome.usage, deps.cost);

  await invRepo.concludeInvestigation(investigation.id, {
    verdict: outcome.verdict.verdict,
    confidence: outcome.verdict.confidence,
    proposedAction: outcome.verdict.proposedAction === null
      ? null : (outcome.verdict.proposedAction as unknown as Record<string, unknown>),
    reasoning: reasoningChain(outcome.toolCalls, outcome.verdict),
    citations: outcome.verdict.citations,
    groundingPassed: outcome.verdict.groundingPassed,
    groundingFailure: outcome.verdict.groundingFailure,
    budgetExhausted: outcome.verdict.budgetExhausted,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls.length,
    tokensIn: outcome.usage.tokensIn,
    tokensOut: outcome.usage.tokensOut,
    costUsd,
  });

  // The unflattering outcomes get their OWN event, not a footnote on the
  // conclusion. §7 reads the grounding-failure count as a signal the prompt or
  // tools need work, and a signal buried inside another event is not a signal.
  if (!outcome.verdict.groundingPassed) {
    await append({
      ...blank, ...ANALYST, runId,
      eventType: 'AGENT_GROUNDING_FAILED', subjectType: 'investigation',
      subjectId: investigation.id,
      reason: `verdict rejected by the A3 gate and downgraded: `
        + `${outcome.verdict.groundingFailure ?? 'unstated'}`,
      details: details({ check: outcome.groundingRejection?.check ?? null,
        reason: outcome.groundingRejection?.reason ?? null }),
    });
  }
  if (outcome.verdict.budgetExhausted) {
    await append({
      ...blank, ...ANALYST, runId,
      eventType: 'AGENT_BUDGET_EXHAUSTED', subjectType: 'investigation',
      subjectId: investigation.id,
      reason: outcome.stopReason,
      details: details({ stopCause: outcome.stopCause, steps: outcome.steps,
        toolCalls: outcome.toolCalls.length, tokensIn: outcome.usage.tokensIn,
        tokensOut: outcome.usage.tokensOut }),
    });
  }

  await append({
    ...blank, ...ANALYST, runId,
    eventType: 'INVESTIGATION_CONCLUDED', subjectType: 'investigation',
    subjectId: investigation.id,
    transactionId: exception.transactionId,
    decision: outcome.verdict.verdict,
    reason:
      `${outcome.verdict.verdict} at ${outcome.verdict.confidence} confidence after `
      + `${outcome.steps} step(s) and ${outcome.toolCalls.length} tool call(s): `
      + `${outcome.stopReason}`,
    details: details({
      verdict: outcome.verdict.verdict, confidence: outcome.verdict.confidence,
      citations: outcome.verdict.citations, groundingPassed: outcome.verdict.groundingPassed,
      budgetExhausted: outcome.verdict.budgetExhausted, stopCause: outcome.stopCause,
      tokensIn: outcome.usage.tokensIn, tokensOut: outcome.usage.tokensOut,
      costUsd,
    }),
  });

  return { outcome, investigationId: investigation.id, auditEntries };
}

/**
 * Run Phase A over a finished run.
 *
 * Never throws for an investigation-level failure — one bad exception must not
 * stop the phase, because a partial Phase A is worth more than none and ADR-048
 * says nothing here is a dependency of anything in the engine.
 */
export async function runPhaseA(
  runId: string, deps: PhaseADeps,
): Promise<PhaseAResult> {
  const budget = deps.budget ?? AGENT_DEFAULTS.budget;
  const maxRequests = deps.maxLlmRequests ?? AGENT_DEFAULTS.maxLlmRequestsPerRun;

  const [plan, gateContext] = await Promise.all([
    triageRun(runId), buildGateContext(runId),
  ]);

  const verdicts: Record<string, number> = {};
  const usage: AgentUsage = { tokensIn: 0, tokensOut: 0 };
  let investigated = 0;
  let groundingFailures = 0;
  let budgetExhaustedCount = 0;
  let requestsSpent = 0;
  let auditEntries = 0;

  for (const candidate of plan.investigate) {
    // The shared request budget, checked against what has ACTUALLY been spent.
    // A whole investigation's worst case must fit, or it is not started —
    // starting one that cannot finish spends requests to produce
    // INSUFFICIENT_EVIDENCE, which is the worst way to run out.
    if (requestsSpent + budget.maxSteps > maxRequests) break;

    try {
      const { outcome, auditEntries: n } = await investigateOne(
        runId, candidate.exceptionId, deps, gateContext);
      investigated += 1;
      auditEntries += n;
      requestsSpent += outcome.steps;
      usage.tokensIn += outcome.usage.tokensIn;
      usage.tokensOut += outcome.usage.tokensOut;
      verdicts[outcome.verdict.verdict] = (verdicts[outcome.verdict.verdict] ?? 0) + 1;
      if (!outcome.verdict.groundingPassed) groundingFailures += 1;
      if (outcome.verdict.budgetExhausted) budgetExhaustedCount += 1;
    } catch (err) {
      // A defect in OUR code, not the model's. Recorded against the run and
      // stepped over: one exception must not cost the other nineteen.
      await withTransaction((c) => auditRepo.appendAuditEntry({
        ...blank, ...ANALYST, runId,
        eventType: 'INVESTIGATION_CONCLUDED', subjectType: 'run', subjectId: runId,
        decision: 'failed',
        reason: `investigation of exception ${candidate.exceptionId} failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        details: { exceptionId: candidate.exceptionId },
      }, c));
      auditEntries += 1;
    }
  }

  return {
    runId,
    plan,
    investigated,
    skippedForBudget: plan.investigate.length - investigated,
    verdicts,
    groundingFailures,
    budgetExhaustedCount,
    requestsSpent,
    usage,
    costUsd: deps.cost === null ? null : usdFor(usage, deps.cost),
    auditEntries,
  };
}
