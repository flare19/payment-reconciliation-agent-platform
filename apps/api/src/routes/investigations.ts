/**
 * Endpoints 25–28 — the Analyst (Phase A).
 *
 * Thin: parse, validate, delegate, serialize (CLAUDE.md §4.3).
 *
 * ── `AGENT_DISABLED` is a real state, not a placeholder ──
 * Endpoint 25 runs the loop since U13; endpoint 28 (Q&A) is still U15. Either
 * way `AGENT_DISABLED` is the contract's own name for a legitimate operating
 * state — `AGENT_ENABLED=false`, or no API key — and the frontend has to handle
 * it because a deploy without a key is a real configuration. Returning a
 * fabricated empty investigation would be the worse answer: it would say the
 * agent ran and found nothing.
 *
 * The READ endpoints work now, because the repository and the table exist and an
 * empty list is a true statement about a run nobody has investigated.
 *
 * The agent PROPOSES; humans dispose through endpoints 16/20/21. There is no
 * handler here that applies a proposal, and there must never be (ADR-049,
 * ADR-051).
 */

import { Router } from 'express';
import { ApiError } from '../app.js';
import { llmConfigured, type Env } from '../config/env.js';
import * as invRepo from '../repositories/investigations.js';
import * as excRepo from '../repositories/exceptions.js';
import * as runsRepo from '../repositories/runs.js';
import { handler, found, pageParams, uuidParam, requireString } from './helpers.js';
import { investigationDto, questionDto, paginate } from './serialize.js';
import { createAgentClient, costModelFor } from '../services/llm-provider.js';
import { buildGateContext } from '../services/agent/phase-a.js';
import { createSpendGuard } from '../services/agent/spend-guard.js';
import { investigateOne, answerOne } from '../services/agent/phase-a.js';
import { checkQaQuota } from '../services/agent/qa-quota.js';
import { AGENT_DEFAULTS } from '../config/defaults.js';
import { isEligibleCategory } from '../services/agent/triage.js';
import type { RunConfig } from '../types/engine.js';

export function investigationsRouter(env: Env): Router {
  const r = Router();

  // Built once. `null` is the ordinary state on a keyless deploy.
  const agentClient = createAgentClient(env);

  const requireAgent = (): NonNullable<typeof agentClient> => {
    if (agentClient === null) {
      throw new ApiError(503, 'AGENT_DISABLED',
        'The Analyst is disabled: set AGENT_ENABLED=true and provide an API key.');
    }
    return agentClient;
  };

  // 25 · POST /api/exceptions/:exceptionId/investigate
  r.post('/exceptions/:exceptionId/investigate', handler(async (req, res) => {
    const id = uuidParam(req, 'exceptionId');
    found(await excRepo.findException(id),
      'EXCEPTION_NOT_FOUND', `No exception exists with id ${id}`);
    // THREE STATES, NOT TWO (ADR-109). `ux_inv_exc_active` already guarantees at
    // most one non-`failed` investigation per exception, so the money guarantee
    // is Postgres's rather than this function's. What this decides is what the
    // caller is TOLD, and the previous version told them the wrong thing: an
    // investigation that concluded an hour ago came back as
    // `409 INVESTIGATION_IN_PROGRESS`, a code asserting work is happening when
    // none is. A client cannot tell "poll me" from "here is your answer" apart
    // from that, and a judge clicking an already-investigated exception got an
    // error where the interesting result should have been.
    const live = await invRepo.findInvestigationForException(id);

    if (live !== null && live.status === 'concluded') {
      // Free, and the same verdict every time. This is what makes the button
      // safe to put in front of someone who will click it twice.
      res.status(200).json({
        exceptionId: id,
        status: 'concluded',
        investigationId: live.id,
        reused: true,
        detailAt: `/api/investigations/${live.id}`,
      });
      return;
    }

    if (live !== null && live.status === 'running') {
      throw new ApiError(409, 'INVESTIGATION_IN_PROGRESS',
        `Exception ${id} is being investigated right now. Poll `
        + `/api/investigations/${live.id} for the verdict.`);
    }

    // Falls through when there is no investigation, or the only one FAILED.
    // Failures are re-runnable on purpose — memoising one would let a single
    // grounding rejection permanently poison an exception, and the partial
    // index's `WHERE status <> 'failed'` predicate already says so.
    const client = requireAgent();

    const exception = (await excRepo.findException(id))!;
    const run = found(await runsRepo.findRun(exception.runId),
      'RUN_NOT_FOUND', `No run exists with id ${exception.runId}`);
    if (run.status !== 'completed') {
      // ADR-048: Phase A reads a FINISHED run. Investigating a run still in
      // flight would read half an engine's output and reason over it as if it
      // were final.
      throw new ApiError(409, 'RUN_NOT_COMPLETE',
        `Run is ${run.status}; the Analyst investigates completed runs only.`);
    }
    if (!isEligibleCategory(exception.category)) {
      // §3 excludes DUPLICATE_RECORD and TIMING_DRIFT: the engine's verdict on
      // both is already complete and an agent adds nothing but tokens.
      // `INVALID_REQUEST`, not a new code: `ERROR_CODES` is locked by
      // api-contract.md and adding a member is a contract change needing an ADR.
      // The message carries the specificity the code deliberately does not.
      throw new ApiError(400, 'INVALID_REQUEST',
        `${exception.category} is not an investigated category: the engine's verdict on `
        + 'it is already complete, so the Analyst adds nothing (agent-design §3). '
        + 'Eligible: AMBIGUOUS_MATCH, UNSPLITTABLE_BATCH, MISSING_IN_BANK, '
        + 'MISSING_IN_LEDGER, MISSING_IN_GATEWAY, AMOUNT_MISMATCH.');
    }

    // ── THE SPEND CEILING, ENFORCED ON THE PATH THAT ACTUALLY REACHES THE
    //    MODEL (#61) ──
    // This endpoint is the PRODUCT path: on-demand, one exception, driven by a
    // human clicking. `runPhaseA` -- which carries the request budget and, since
    // ADR-094, the cost cap -- is the MEASUREMENT harness and is not reachable
    // from HTTP at all. So until now the bounded path and the exposed path were
    // inverted, on an unauthenticated URL against a prepaid key with auto-reload
    // off.
    //
    // The window is trailing and DERIVED from `cost_usd` rows already written,
    // so it survives a restart. A per-run cap cannot bound this: `POST /api/runs`
    // mints a fresh run with a fresh exception set on demand, so "per run" is a
    // ceiling the caller controls.
    const cost = costModelFor(env);
    const windowStart = new Date(Date.now() - 60 * 60 * 1000);
    const spentThisHour = await invRepo.agentSpendUsdSince(windowStart);
    const hourlyRemaining = env.agentMaxCostUsdPerHour - spentThisHour;
    if (cost !== null && hourlyRemaining <= 0) {
      throw new ApiError(429, 'AGENT_QUOTA_EXCEEDED',
        `The Analyst has spent $${spentThisHour.toFixed(2)} in the last hour, at or above the `
        + `$${env.agentMaxCostUsdPerHour.toFixed(2)} ceiling. It will accept investigations `
        + 'again as older spend leaves the window.');
    }

    // The A3 evidence base. Assembled per request rather than cached, so a
    // record matched since the last investigation cannot be proposed again.
    // `buildGateContext` is SHARED with the phase (#61 criterion 5): this route
    // used to rebuild it inline, which duplicated both #56's `alreadyMatched`
    // rule and #58's alias-key defect and would have needed fixing twice.
    const gateContext = await buildGateContext(exception.runId);

    // Deliberately NOT awaited: an investigation is bounded at 60 s and the
    // contract is 202-then-poll (endpoint 27), the same protocol a run uses.
    void investigateOne(exception.runId, id, {
      client,
      config: run.configSnapshot as RunConfig,
      // The REAL rate when billed (ADR-093); NULL on a free-tier key, never 0.
      // A zero cost reads as a measured figure and this build has not measured
      // one (ADR-080).
      cost,
      promptVersion: env.agentPromptVersion,
      // Bounded by whichever is TIGHTER: what is left in the hour, or the
      // per-investigation ceiling. Seeded with the hour's spend so far, so the
      // guard enforces the window rather than restarting at zero per request --
      // which is the whole defect.
      spendGuard: createSpendGuard({
        maxUsd: Math.min(hourlyRemaining, env.agentMaxCostUsdPerRun),
        cost,
        maxOutputTokensPerTurn: 4096,
      }),
    }, gateContext).catch((err: unknown) => {
      console.error('[api] investigation crashed outside its own handling', id, err);
    });

    res.status(202).json({
      exceptionId: id,
      status: 'running',
      pollAt: `/api/runs/${exception.runId}/investigations`,
    });
  }));

  // 26 · GET /api/runs/:runId/investigations
  r.get('/runs/:runId/investigations', handler(async (req, res) => {
    const runId = uuidParam(req, 'runId');
    const run = found(await runsRepo.findRun(runId),
      'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    if (run.status !== 'completed') {
      throw new ApiError(409, 'RUN_NOT_COMPLETE',
        `Run is ${run.status}; investigations are available once it completes.`);
    }
    const { page, pageSize, offset } = pageParams(req);
    const { investigations, total } = await invRepo.listInvestigations(runId, pageSize, offset);
    const metrics = await invRepo.agentMetrics(runId);
    res.json({
      investigations: investigations.map(investigationDto),
      // `hallucinatedResolutions` MUST be zero — ADR-053 makes it a build
      // blocker rather than a metric, so it is reported beside the rest rather
      // than buried where nobody looks.
      agentMetrics: { ...metrics, hallucinatedResolutions: metrics.groundingFailures },
      pagination: paginate(page, pageSize, total),
    });
  }));

  // 27 · GET /api/investigations/:investigationId
  r.get('/investigations/:investigationId', handler(async (req, res) => {
    const id = uuidParam(req, 'investigationId');
    const inv = found(await invRepo.findInvestigation(id),
      'INVESTIGATION_NOT_FOUND', `No investigation exists with id ${id}`);
    res.json(investigationDto(inv));
  }));

  // 28 · POST /api/runs/:runId/ask
  //
  // THE ONLY FREE-TEXT BOX IN THE PRODUCT, ON A PUBLIC UNAUTHENTICATED DEMO.
  // Every other spending surface needs a human to open a specific exception and
  // confirm a specific price; this one takes a sentence from a stranger. The
  // guard is `checkQaQuota` and the order of its four checks is deliberate --
  // see `qa-quota.ts`. Synchronous, because the contract's response body IS the
  // answer (§28) and `agent_questions` has no status column to poll.
  r.post('/runs/:runId/ask', handler(async (req, res) => {
    const runId = uuidParam(req, 'runId');
    const run = found(await runsRepo.findRun(runId),
      'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const question = requireString(req.body ?? {}, 'question');

    // A length bound is a SPEND bound here, not tidiness: the question is
    // echoed into every one of up to 6 turns, so an unbounded string is
    // unbounded input tokens billed six times over, from an anonymous caller.
    if (question.length > AGENT_DEFAULTS.qa.maxQuestionChars) {
      throw new ApiError(400, 'INVALID_REQUEST',
        `question is ${question.length} characters, over the `
        + `${AGENT_DEFAULTS.qa.maxQuestionChars}-character limit. Ask a shorter question — `
        + 'the Analyst reads a sentence, not a document.');
    }

    if (run.status !== 'completed') {
      // ADR-048, the same rule endpoint 25 enforces: Phase A reads a FINISHED
      // run. Answering questions about a half-written engine output would
      // reason over partial results as though they were final.
      throw new ApiError(409, 'RUN_NOT_COMPLETE',
        `Run is ${run.status}; the Analyst answers questions about completed runs only.`);
    }

    // Provider-aware, for the same reason health.ts is: testing `geminiApiKey`
    // here reported the Q&A loop unavailable on an Anthropic deploy that had a
    // key (ADR-093 — one switch, both surfaces).
    const enabled = env.agentQaEnabled && llmConfigured(env) && agentClient !== null;

    // Counts and dollars, read from rows already written so they survive a
    // restart -- a counter in memory is a ceiling an attacker clears by
    // crashing the process (ADR-095). The hour is trailing.
    const windowStart = new Date(Date.now() - 60 * 60 * 1000);
    const cost = costModelFor(env);
    // Read only when the feature is ON. `checkQaQuota` remains the single
    // authority on WHICH bound refuses -- these are its inputs, not a second
    // decision -- but the kill switch is its first check precisely because no
    // other check's outcome can change it, and doing three queries to discover
    // that would contradict the ordering.
    const [questionsThisRun, questionsThisHour, spentThisHourUsd] = enabled
      ? await Promise.all([
        invRepo.countQuestionsForRun(runId),
        invRepo.countQuestionsSince(windowStart),
        invRepo.agentSpendUsdSince(windowStart),
      ])
      : [0, 0, 0];

    const quota = checkQaQuota({
      enabled,
      questionsThisRun,
      questionsThisHour,
      spentThisHourUsd,
      limits: {
        maxQuestionsPerRun: env.agentQaMaxQuestionsPerRun,
        maxQuestionsPerHour: env.agentQaMaxQuestionsPerHour,
        maxCostUsdPerHour: env.agentMaxCostUsdPerHour,
      },
      cost,
    });
    if (!quota.allowed) throw new ApiError(quota.status, quota.code, quota.reason);

    const client = requireAgent();
    const gateContext = await buildGateContext(runId);

    // AWAITED, unlike endpoint 25. The contract returns the answer in the
    // response body and there is no poll target for a question.
    const { question: row } = await answerOne(runId, question, {
      client,
      config: run.configSnapshot as RunConfig,
      cost,
      promptVersion: env.agentPromptVersion,
      // Whichever is tighter: what is left in the hour, or one question's own
      // ceiling. Seeded from the hour's real spend, so the guard enforces the
      // window rather than restarting at zero for every caller.
      spendGuard: createSpendGuard({
        maxUsd: Math.min(quota.remainingUsd, env.agentMaxCostUsdPerRun),
        cost,
        maxOutputTokensPerTurn: AGENT_DEFAULTS.qa.maxOutputTokens,
      }),
    }, gateContext);

    res.status(200).json(questionDto(row));
  }));

  // Read-only history, useful before the loop lands.
  r.get('/runs/:runId/questions', handler(async (req, res) => {
    const runId = uuidParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const questions = await invRepo.listQuestions(runId, 50);
    res.json({ questions: questions.map(questionDto) });
  }));

  return r;
}
