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
import {
  corroborate, buildCorroborationPrompt, CORROBORATION_BUDGET,
} from './corroborate.js';
import * as corrRepo from '../../repositories/corroborations.js';
import { buildInvestigationPrompt } from './investigation-prompt.js';
import { randomUUID } from 'node:crypto';
import { createToolRegistry } from './tool-registry.js';
import { answerQuestion, QA_BUDGET } from './qa-loop.js';
import { triageRun, type TriagePlan, type TriageBudget } from './triage.js';
import type { AgentLlmClient, AgentUsage, CostModel } from './agent-client.js';
import type { SpendGuard } from './spend-guard.js';
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

/**
 * Thrown by `investigateOne`/`corroborateOne` after the row has already been
 * moved to `status = 'failed'` (#57). Carries the id so `runPhaseA`'s catch can
 * record the failure against the INVESTIGATION or CORROBORATION itself, not
 * only the run — the row's own `audit_log` trail should say why it failed, the
 * same way a concluded one says how it concluded.
 */
class AgentWorkFailedError extends Error {
  constructor(
    public readonly subjectType: 'investigation' | 'corroboration',
    public readonly subjectId: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PhaseADeps {
  client: AgentLlmClient;
  config: RunConfig;
  /** Rates for the model in use. Null when nothing is billed (free tier). */
  cost: CostModel | null;
  promptVersion?: string;
  budget?: InvestigationBudget;
  maxLlmRequests?: number;
  /**
   * The per-list caps (§3, ADR-081). Optional, and it had to become injectable
   * the moment `runPhaseA` gained a caller outside a test: the env var
   * `AGENT_MAX_INVESTIGATIONS_PER_RUN` was parsed but reached nothing, because
   * the only call site took `triageRun`'s default.
   */
  triageBudget?: TriageBudget;
  now?: () => number;
  /**
   * The TRUE count of billable requests issued so far, from the pacing layer
   * (`rate-limiter.ts`). Optional, and the reason it exists is a real gap:
   *
   * this loop can only see an investigation's STEPS, and steps are not
   * requests. A retried 429 is a second billable call the step count never
   * sees, and an investigation that THREW spent whatever it spent before
   * throwing and reported nothing at all. Both are real spend that the request
   * budget believed did not happen — harmless on a free tier, and the exact
   * shape of hole a dollar-denominated cap must not have.
   *
   * When supplied, `requestsSpent` becomes the true issued count. When absent,
   * the loop falls back to steps plus a worst-case charge for failures.
   */
  requestsIssued?: () => number;
  /**
   * ADR-094. Supplied by the caller so ONE guard spans the whole phase — a
   * per-investigation guard would let twenty investigations each spend up to the
   * run ceiling. Absent means no cap, which is correct only on a free tier.
   */
  spendGuard?: SpendGuard;
}

export interface PhaseAResult {
  runId: string;
  plan: TriagePlan;
  investigated: number;
  /** Review-queue matches corroborated (ADR-081). Cut FIRST when requests bind. */
  corroborated: number;
  corroborationVerdicts: Record<string, number>;
  /** Reported SEPARATELY from `groundingFailures` — different populations (ADR-087). */
  corroborationGroundingFailures: number;
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
export async function buildGateContext(
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
  const promptVersion = deps.promptVersion ?? 'agent-v1';

  const exception = await excRepo.findException(exceptionId);
  if (exception === null || exception.runId !== runId) {
    throw new Error(`investigateOne: exception ${exceptionId} is not in run ${runId}`);
  }

  const investigation = await invRepo.startInvestigation({
    runId, exceptionId, model: deps.client.model, promptVersion });

  try {
    return await investigateOnceOpened(
      runId, exceptionId, exception, investigation.id, deps, gateContext);
  } catch (err) {
    // The row must not be left at `status = 'running'` forever (#57) --
    // ux_inv_exc_active is a partial unique index on that status, so an
    // orphaned row permanently blocks this exception from being investigated
    // again. Failure is a state, not an absence.
    const reason = err instanceof Error ? err.message : String(err);
    await invRepo.failInvestigation(investigation.id, reason);
    throw new AgentWorkFailedError('investigation', investigation.id,
      `investigation of exception ${exceptionId} failed: ${reason}`);
  }
}

/** Everything after the row is opened -- factored out so #57's try/catch wraps it cleanly. */
async function investigateOnceOpened(
  runId: string,
  exceptionId: string,
  exception: NonNullable<Awaited<ReturnType<typeof excRepo.findException>>>,
  investigationId: string,
  deps: PhaseADeps,
  gateContext: Omit<GateContext, 'investigationId' | 'toolCalls'>,
): Promise<{ outcome: InvestigationOutcome; investigationId: string; auditEntries: number }> {
  const budget = deps.budget ?? AGENT_DEFAULTS.budget;
  const promptVersion = deps.promptVersion ?? 'agent-v1';
  const investigation = { id: investigationId };
  let auditEntries = 0;

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
      // ADR-094: the cost ceiling, enforced before each call rather than
      // reported after the run.
      ...(deps.spendGuard === undefined ? {} : { preflight: deps.spendGuard.preflight }),
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

/** One corroboration, start to persisted verdict (ADR-081, ADR-087). */
export async function corroborateOne(
  runId: string,
  matchId: string,
  deps: PhaseADeps,
  gateContext: Omit<GateContext, 'investigationId' | 'toolCalls'>,
): Promise<{ outcome: Awaited<ReturnType<typeof corroborate>>; auditEntries: number }> {
  const promptVersion = deps.promptVersion ?? 'agent-v1';

  const match = await matchRepo.findMatch(matchId);
  if (match === null || match.runId !== runId) {
    throw new Error(`corroborateOne: match ${matchId} is not in run ${runId}`);
  }
  const members = (await Promise.all(
    match.members.map((m) => txnRepo.findTransaction(m.transactionId))))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const row = await corrRepo.startCorroboration({
    runId, matchId, model: deps.client.model, promptVersion });

  try {
    return await corroborateOnceOpened(runId, matchId, match, members, row.id, deps, gateContext);
  } catch (err) {
    // Mirrors investigateOne's #57 fix: a throw here must not leave the row at
    // status = 'running' -- ux_corr_match_active would then permanently block
    // this match from ever being corroborated again.
    const reason = err instanceof Error ? err.message : String(err);
    await corrRepo.failCorroboration(row.id, reason);
    throw new AgentWorkFailedError('corroboration', row.id,
      `corroboration of match ${matchId} failed: ${reason}`);
  }
}

/** Everything after the row is opened -- factored out so #57's try/catch wraps it cleanly. */
async function corroborateOnceOpened(
  runId: string,
  matchId: string,
  match: NonNullable<Awaited<ReturnType<typeof matchRepo.findMatch>>>,
  members: readonly NonNullable<Awaited<ReturnType<typeof txnRepo.findTransaction>>>[],
  corroborationId: string,
  deps: PhaseADeps,
  gateContext: Omit<GateContext, 'investigationId' | 'toolCalls'>,
): Promise<{ outcome: Awaited<ReturnType<typeof corroborate>>; auditEntries: number }> {
  const row = { id: corroborationId };
  const promptVersion = deps.promptVersion ?? 'agent-v1';
  let auditEntries = 0;

  const append = async (
    entry: Parameters<typeof auditRepo.appendAuditEntry>[0],
  ): Promise<void> => {
    await withTransaction((c: TxClient) => auditRepo.appendAuditEntry(entry, c));
    auditEntries += 1;
  };

  await append({
    ...blank, ...ANALYST, runId,
    eventType: 'INVESTIGATION_STARTED', subjectType: 'investigation', subjectId: row.id,
    reason: `corroboration opened on pending match ${matchId} `
      + `(confidence ${match.confidence}, tier ${match.tier}) using ${deps.client.model}`,
    details: details({ matchId, tier: match.tier, confidence: match.confidence,
      model: deps.client.model, promptVersion, mode: 'corroborate' }),
  });

  const registry = createToolRegistry({ runId, config: deps.config });
  const outcome = await corroborate(
    { corroborationId: row.id, runId, matchId,
      prompt: buildCorroborationPrompt(match, members) },
    {
      client: deps.client, registry, gateContext,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      onToolCall: async (record: ToolCallRecord) => {
        await append({
          ...blank, ...ANALYST, runId,
          eventType: 'AGENT_TOOL_CALLED', subjectType: 'investigation', subjectId: row.id,
          reason: `step ${record.step}: called ${record.tool}, which returned `
            + `${record.returnedIds.length} citable id(s) in ${record.durationMs} ms`,
          details: details({ step: record.step, tool: record.tool,
            arguments: record.arguments, returnedIds: record.returnedIds,
            resultDigest: record.resultDigest, durationMs: record.durationMs,
            mode: 'corroborate' }),
        });
      },
    },
    deps.budget ?? CORROBORATION_BUDGET);

  const costUsd = deps.cost === null ? null : usdFor(outcome.usage, deps.cost);

  await corrRepo.concludeCorroboration(row.id, {
    verdict: outcome.verdict.verdict,
    confidence: outcome.verdict.confidence,
    reasoning: reasoningChain(outcome.toolCalls, {
      ...outcome.verdict, verdict: 'CONFIRMED_UNRESOLVABLE', proposedAction: null }),
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

  if (!outcome.verdict.groundingPassed) {
    await append({
      ...blank, ...ANALYST, runId,
      eventType: 'AGENT_GROUNDING_FAILED', subjectType: 'investigation', subjectId: row.id,
      reason: `corroboration rejected by the A3 gate and downgraded: `
        + `${outcome.verdict.groundingFailure ?? 'unstated'}`,
      details: details({ matchId, mode: 'corroborate',
        check: outcome.groundingRejection?.check ?? null }),
    });
  }
  if (outcome.verdict.budgetExhausted) {
    await append({
      ...blank, ...ANALYST, runId,
      eventType: 'AGENT_BUDGET_EXHAUSTED', subjectType: 'investigation', subjectId: row.id,
      reason: outcome.stopReason,
      details: details({ matchId, mode: 'corroborate', stopCause: outcome.stopCause }),
    });
  }

  await append({
    ...blank, ...ANALYST, runId,
    eventType: 'INVESTIGATION_CONCLUDED', subjectType: 'investigation', subjectId: row.id,
    decision: outcome.verdict.verdict,
    reason: `${outcome.verdict.verdict} at ${outcome.verdict.confidence} confidence on `
      + `pending match ${matchId} after ${outcome.steps} step(s): ${outcome.stopReason}`,
    details: details({ matchId, mode: 'corroborate', verdict: outcome.verdict.verdict,
      confidence: outcome.verdict.confidence, citations: outcome.verdict.citations,
      groundingPassed: outcome.verdict.groundingPassed, costUsd }),
  });

  return { outcome, auditEntries };
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
    triageRun(runId, deps.triageBudget), buildGateContext(runId),
  ]);

  const verdicts: Record<string, number> = {};
  const corroborationVerdicts: Record<string, number> = {};
  const usage: AgentUsage = { tokensIn: 0, tokensOut: 0 };
  let investigated = 0;
  let corroborated = 0;
  let corroborationGroundingFailures = 0;
  let groundingFailures = 0;
  let budgetExhaustedCount = 0;
  // Steps, as the loop can observe them — the fallback denominator.
  let stepsSpent = 0;
  const issued = deps.requestsIssued;
  const issuedBaseline = issued?.() ?? 0;
  /**
   * What has been spent against `maxLlmRequests`.
   *
   * Prefers the pacing layer's real count, which sees the two things a step
   * count structurally cannot: a retried request, and an investigation that
   * threw after spending. Falls back to steps — RESERVE the worst case, CHARGE
   * the actual, exactly as before.
   *
   * The fallback deliberately charges a failed investigation NOTHING rather
   * than its ceiling. Charging the ceiling was tried and is wrong twice over:
   * it is the starve-the-work-list defect ADR-085 removed, and it books a
   * number nobody measured into the ledger that guards real money — the same
   * trade `gemini-agent-client.ts` refuses when it reports zero usage on a
   * throw instead of an estimate. An honest gap beats an invented figure;
   * closing the gap is what `requestsIssued` is for.
   */
  const spent = (): number =>
    issued === undefined ? stepsSpent : issued() - issuedBaseline;
  let auditEntries = 0;

  for (const candidate of plan.investigate) {
    // The shared request budget, checked against what has ACTUALLY been spent.
    // A whole investigation's worst case must fit, or it is not started —
    // starting one that cannot finish spends requests to produce
    // INSUFFICIENT_EVIDENCE, which is the worst way to run out.
    if (spent() + budget.maxSteps > maxRequests) break;
    // ADR-094: a phase that cannot afford another investigation stops here
    // rather than starting one it will refuse on its first turn.
    if (deps.spendGuard !== undefined && deps.spendGuard.remainingUsd() <= 0) break;

    try {
      const { outcome, auditEntries: n } = await investigateOne(
        runId, candidate.exceptionId, deps, gateContext);
      investigated += 1;
      auditEntries += n;
      stepsSpent += outcome.steps;
      usage.tokensIn += outcome.usage.tokensIn;
      usage.tokensOut += outcome.usage.tokensOut;
      // ADR-094: settle this investigation into the running total, so the guard
      // spans the phase rather than resetting per investigation.
      deps.spendGuard?.record(outcome.usage);
      verdicts[outcome.verdict.verdict] = (verdicts[outcome.verdict.verdict] ?? 0) + 1;
      if (!outcome.verdict.groundingPassed) groundingFailures += 1;
      if (outcome.verdict.budgetExhausted) budgetExhaustedCount += 1;
    } catch (err) {
      // A defect in OUR code, not the model's. Stepped over: one exception must
      // not cost the other nineteen. Recorded against the INVESTIGATION when one
      // was opened (#57 -- its own row already moved to status = 'failed', by
      // investigateOne's own catch), and against the run only when the failure
      // happened before a row could exist (e.g. findException itself throwing).
      // `subjectType: 'investigation'` either way, matching every other audit
      // entry this file writes for a corroboration too (there is no separate
      // 'corroboration' subject type in `audit_log`).
      const subjectId = err instanceof AgentWorkFailedError ? err.subjectId : runId;
      await withTransaction((c) => auditRepo.appendAuditEntry({
        ...blank, ...ANALYST, runId,
        eventType: 'INVESTIGATION_CONCLUDED',
        subjectType: err instanceof AgentWorkFailedError ? 'investigation' : 'run',
        subjectId,
        decision: 'failed',
        reason: `investigation of exception ${candidate.exceptionId} failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        details: { exceptionId: candidate.exceptionId },
      }, c));
      auditEntries += 1;
    }
  }

  // ── A1b: the review queue, AFTER exceptions (ADR-081) ──
  // The pre-agreed degradation: if the shared request budget binds, this is what
  // gets cut, because the exception list is what the track grades. Decided in
  // advance precisely so it is not decided under pressure on submission day.
  for (const candidate of plan.corroborate) {
    if (spent() + CORROBORATION_BUDGET.maxSteps > maxRequests) break;
    try {
      const { outcome, auditEntries: n } = await corroborateOne(
        runId, candidate.matchId, deps, gateContext);
      corroborated += 1;
      auditEntries += n;
      stepsSpent += outcome.steps;
      usage.tokensIn += outcome.usage.tokensIn;
      usage.tokensOut += outcome.usage.tokensOut;
      deps.spendGuard?.record(outcome.usage);
      corroborationVerdicts[outcome.verdict.verdict] =
        (corroborationVerdicts[outcome.verdict.verdict] ?? 0) + 1;
      if (!outcome.verdict.groundingPassed) corroborationGroundingFailures += 1;
    } catch (err) {
      // Mirrors the investigation catch above (#57): recorded against the
      // corroboration's own row (subjectType 'investigation', matching this
      // file's convention) when one was opened, against the run otherwise.
      const subjectId = err instanceof AgentWorkFailedError ? err.subjectId : runId;
      await withTransaction((c) => auditRepo.appendAuditEntry({
        ...blank, ...ANALYST, runId,
        eventType: 'INVESTIGATION_CONCLUDED',
        subjectType: err instanceof AgentWorkFailedError ? 'investigation' : 'run',
        subjectId,
        decision: 'failed',
        reason: `corroboration of match ${candidate.matchId} failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        details: { matchId: candidate.matchId },
      }, c));
      auditEntries += 1;
    }
  }

  return {
    runId,
    plan,
    investigated,
    corroborated,
    corroborationVerdicts,
    corroborationGroundingFailures,
    skippedForBudget: plan.investigate.length - investigated,
    verdicts,
    groundingFailures,
    budgetExhaustedCount,
    requestsSpent: spent(),
    usage,
    costUsd: deps.cost === null ? null : usdFor(usage, deps.cost),
    auditEntries,
  };
}

/**
 * Answer ONE question about a finished run (agent-design.md §9, endpoint 28).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * SYNCHRONOUS, UNLIKE ITS TWO SIBLINGS, AND THE CONTRACT SAYS SO.
 *
 * `investigateOne` is 202-then-poll because an investigation is bounded at 60 s
 * and the caller is a button on an exception. Endpoint 28 returns
 * `{ answer, citations, toolCalls, steps, costUsd }` in the response body —
 * there is no poll target in the contract and no `status` column on
 * `agent_questions` to poll for. So this awaits, and the route awaits it.
 *
 * That is a real latency bound, not a detail: at §8's measured 4.8 s/turn a
 * 6-step question is ~30 s of held-open request. It is affordable HERE and
 * nowhere else because a question is 6 steps where an investigation is 10, and
 * because the alternative — inventing a poll protocol — would be a contract
 * change on the eve of a submission.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── THE ROW IS WRITTEN ONCE, AT THE END, AND THE ID IS MINTED HERE ──
 * `agent_investigations` is opened `running` and later concluded, because #57
 * needs a row to move to `failed` and `ux_inv_exc_active` needs one to collide
 * with. A question has neither: nothing is unique about asking the same
 * question twice, and there is no state a second caller must be told about. So
 * `agent_questions` takes a single insert after the loop returns.
 *
 * The id is still minted BEFORE the loop, because the audit trail and the tool
 * records are stamped with it as they happen (§3) and a row id that does not
 * exist yet cannot stamp anything. Letting Postgres default it would mean the
 * trail said one id and the row said another.
 *
 * ── THE AUDIT SUBJECT IS THE RUN, NOT A NEW SUBJECT TYPE ──
 * `audit_log.subject_type` is a CHECK list and `question` is not in it.
 * Corroborations met this and answered by writing `subjectType:
 * 'investigation'`, admitting in a comment that no corroboration subject type
 * exists. That compromise is available and I did not take it: a corroboration
 * really is about one specific match, so borrowing a sibling's noun loses
 * information, whereas a question's subject genuinely IS the run — it may be
 * about a settlement, a category, a total, or nothing in particular.
 *
 * So the entries are `subjectType: 'run'`, `subjectId: runId`, and the question
 * id rides in `details`. No migration, no borrowed noun, and the entries land
 * in the run's own trail where a reader looking at that run will find them.
 */
export async function answerOne(
  runId: string,
  question: string,
  deps: PhaseADeps,
  gateContext: Omit<GateContext, 'investigationId' | 'toolCalls'>,
): Promise<{ question: Awaited<ReturnType<typeof invRepo.recordQuestion>>; auditEntries: number }> {
  const promptVersion = deps.promptVersion ?? 'agent-v1';
  const questionId = randomUUID();
  let auditEntries = 0;

  const append = async (
    entry: Parameters<typeof auditRepo.appendAuditEntry>[0],
  ): Promise<void> => {
    await withTransaction((c: TxClient) => auditRepo.appendAuditEntry(entry, c));
    auditEntries += 1;
  };

  // The question is recorded BEFORE it is answered. A question that crashes the
  // process still leaves evidence it was asked -- which is the only way to tell
  // "nobody asked" from "asking broke it", and on a public endpoint that is the
  // difference between a quiet demo and an unnoticed outage.
  await append({
    ...blank, ...ANALYST, runId,
    eventType: 'QUESTION_ASKED', subjectType: 'run', subjectId: runId,
    reason: `question asked of run ${runId} using ${deps.client.model}`,
    details: details({ questionId, question, model: deps.client.model, promptVersion }),
  });

  const registry = createToolRegistry({ runId, config: deps.config });

  const outcome = await answerQuestion(
    { questionId, runId, question },
    {
      client: deps.client,
      registry,
      gateContext,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.spendGuard === undefined ? {} : { preflight: deps.spendGuard.preflight }),
      onToolCall: async (record: ToolCallRecord) => {
        await append({
          ...blank, ...ANALYST, runId,
          eventType: 'AGENT_TOOL_CALLED', subjectType: 'run', subjectId: runId,
          reason: `question step ${record.step}: called ${record.tool}, which returned `
            + `${record.returnedIds.length} citable id(s) in ${record.durationMs} ms`,
          details: details({
            questionId, step: record.step, tool: record.tool, arguments: record.arguments,
            returnedIds: record.returnedIds, resultDigest: record.resultDigest,
            durationMs: record.durationMs,
          }),
        });
      },
    },
    deps.budget ?? QA_BUDGET);

  const costUsd = deps.cost === null ? null : usdFor(outcome.usage, deps.cost);

  // An ungrounded answer is PERSISTED, with `groundingPassed: false` and no
  // citations -- the gate already stripped those. Discarding it would delete the
  // evidence that the gate fired, and §7 reads that count as the signal the
  // prompt or the tools need work.
  const row = await invRepo.recordQuestion({
    id: questionId,
    runId,
    question,
    answer: outcome.answer.answer,
    citations: outcome.answer.citations,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls.length,
    tokensIn: outcome.usage.tokensIn,
    tokensOut: outcome.usage.tokensOut,
    costUsd,
    groundingPassed: outcome.answer.groundingPassed,
  });

  if (!outcome.answer.groundingPassed) {
    await append({
      ...blank, ...ANALYST, runId,
      eventType: 'AGENT_GROUNDING_FAILED', subjectType: 'run', subjectId: runId,
      reason: `answer rejected by the A3 gate: ${outcome.answer.groundingFailure ?? 'unstated'}`,
      details: details({ questionId, check: outcome.groundingRejection?.check ?? null,
        reason: outcome.groundingRejection?.reason ?? null }),
    });
  }
  if (outcome.answer.budgetExhausted) {
    await append({
      ...blank, ...ANALYST, runId,
      eventType: 'AGENT_BUDGET_EXHAUSTED', subjectType: 'run', subjectId: runId,
      reason: outcome.stopReason,
      details: details({ questionId, stopCause: outcome.stopCause, steps: outcome.steps,
        toolCalls: outcome.toolCalls.length, tokensIn: outcome.usage.tokensIn,
        tokensOut: outcome.usage.tokensOut }),
    });
  }

  await append({
    ...blank, ...ANALYST, runId,
    eventType: 'QUESTION_ANSWERED', subjectType: 'run', subjectId: runId,
    // NOT the `confidence` column: that one is numeric and belongs to engine
    // match confidence. The agent's is a LABEL (§6), so it rides in the reason
    // and the details, exactly as INVESTIGATION_CONCLUDED does above.
    reason: `question answered at ${outcome.answer.confidence} confidence in `
      + `${outcome.steps} step(s) with `
      + `${outcome.answer.citations.length} citation(s); grounding `
      + `${outcome.answer.groundingPassed ? 'passed' : 'FAILED'}`,
    details: details({
      questionId, confidence: outcome.answer.confidence, steps: outcome.steps,
      toolCalls: outcome.toolCalls.length,
      groundingPassed: outcome.answer.groundingPassed, costUsd,
    }),
  });

  return { question: row, auditEntries };
}
