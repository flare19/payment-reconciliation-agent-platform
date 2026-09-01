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
import type { Env } from '../config/env.js';
import * as invRepo from '../repositories/investigations.js';
import * as excRepo from '../repositories/exceptions.js';
import * as runsRepo from '../repositories/runs.js';
import { handler, found, pageParams, pathParam, requireString } from './helpers.js';
import { investigationDto, questionDto, paginate } from './serialize.js';
import { createAgentClient } from '../services/llm-provider.js';
import { investigateOne } from '../services/agent/phase-a.js';
import { isEligibleCategory } from '../services/agent/triage.js';
import * as txnRepo from '../repositories/transactions.js';
import * as matchRepo from '../repositories/matches.js';
import * as aliasRepo from '../repositories/aliases.js';
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
    const id = pathParam(req, 'exceptionId');
    found(await excRepo.findException(id),
      'EXCEPTION_NOT_FOUND', `No exception exists with id ${id}`);
    // One live investigation per exception (`ux_inv_exc_active`). Checking here
    // turns a unique-violation into the contract's 409.
    const live = await invRepo.findInvestigationForException(id);
    if (live !== null && live.status !== 'failed') {
      throw new ApiError(409, 'INVESTIGATION_IN_PROGRESS',
        `Exception ${id} already has an investigation (${live.status}).`);
    }
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

    // The A3 evidence base. Assembled per request here rather than cached, so a
    // record matched since the last investigation cannot be proposed again.
    const [records, matchedIds, aliases] = await Promise.all([
      txnRepo.listTransactions(exception.runId),
      matchRepo.listMatchedTransactionIds(exception.runId),
      aliasRepo.listActiveAliases(),
    ]);
    const matched = new Set(matchedIds);

    // Deliberately NOT awaited: an investigation is bounded at 60 s and the
    // contract is 202-then-poll (endpoint 27), the same protocol a run uses.
    void investigateOne(exception.runId, id, {
      client,
      config: run.configSnapshot as RunConfig,
      // No cost model on a free-tier key: NULL, never 0. A zero cost reads as a
      // measured figure, and this build has not measured one (ADR-080).
      cost: null,
      promptVersion: env.agentPromptVersion,
    }, {
      runId: exception.runId,
      records: new Map(records.map((t) => [t.id, {
        runId: t.runId, sourceSystem: t.sourceSystem, direction: t.direction,
        alreadyMatched: matched.has(t.id),
      }])),
      activeAliases: new Map(
        aliases.map((a) => [`${a.aliasType}::${a.normalizedValue}`, a.canonicalValue])),
    }).catch((err: unknown) => {
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
    const runId = pathParam(req, 'runId');
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
    const id = pathParam(req, 'investigationId');
    const inv = found(await invRepo.findInvestigation(id),
      'INVESTIGATION_NOT_FOUND', `No investigation exists with id ${id}`);
    res.json(investigationDto(inv));
  }));

  // 28 · POST /api/runs/:runId/ask
  r.post('/runs/:runId/ask', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    requireString(req.body ?? {}, 'question');

    if (!env.agentQaEnabled || env.geminiApiKey === null) {
      throw new ApiError(503, 'AGENT_DISABLED',
        'Q&A is disabled: set AGENT_QA_ENABLED=true and provide ANTHROPIC_API_KEY.');
    }
    // ADR-056's rate limit is enforced from stored history, so it holds across
    // process restarts rather than living in memory.
    const asked = await invRepo.countRecentQuestions(runId, 60);
    if (asked >= env.agentQaMaxQuestionsPerRun) {
      throw new ApiError(429, 'AGENT_QUOTA_EXCEEDED',
        `This run has used its ${env.agentQaMaxQuestionsPerRun}-question hourly budget.`);
    }
    throw new ApiError(503, 'AGENT_DISABLED',
      'The Q&A loop is not yet implemented in this build (U15).');
  }));

  // Read-only history, useful before the loop lands.
  r.get('/runs/:runId/questions', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const questions = await invRepo.listQuestions(runId, 50);
    res.json({ questions: questions.map(questionDto) });
  }));

  return r;
}
