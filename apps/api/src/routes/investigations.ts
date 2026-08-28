/**
 * Endpoints 25–28 — the Analyst (Phase A).
 *
 * Thin: parse, validate, delegate, serialize (CLAUDE.md §4.3).
 *
 * ── Why these return 503 today, and why that is the right answer ──
 * The investigation loop is U12/U13 and the Q&A loop is U15. Until they land,
 * `AGENT_DISABLED` is not a placeholder — it is the contract's own name for a
 * legitimate operating state (`AGENT_ENABLED=false` or no `ANTHROPIC_API_KEY`),
 * and the frontend already has to handle it because a deploy without an API key
 * is a real configuration. Returning a fabricated empty investigation would be
 * the worse answer: it would say the agent ran and found nothing.
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

export function investigationsRouter(env: Env): Router {
  const r = Router();

  const requireAgent = (): void => {
    if (!env.agentEnabled || env.anthropicApiKey === null) {
      throw new ApiError(503, 'AGENT_DISABLED',
        'The Analyst is disabled: set AGENT_ENABLED=true and provide ANTHROPIC_API_KEY.');
    }
    throw new ApiError(503, 'AGENT_DISABLED',
      'The Analyst investigation loop is not yet implemented in this build (U12/U13).');
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
    requireAgent();
    res.status(202).json({});   // unreachable; requireAgent always throws today
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

    if (!env.agentQaEnabled || env.anthropicApiKey === null) {
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
