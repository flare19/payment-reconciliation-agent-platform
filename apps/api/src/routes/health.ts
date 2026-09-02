/**
 * Endpoint 1 — the deploy smoke check.
 *
 * Reports what is CONFIGURED, not what is desirable. `llmConfigured: false` is a
 * legitimate operating state (ADR-017: a run completes with the LLM API
 * unavailable, every explanation falls back to a template), so this reports it
 * as a fact rather than as a failure. A health check that goes red for a
 * deliberate configuration teaches its reader to ignore it.
 */

import { Router } from 'express';
import { llmConfigured, type Env } from '../config/env.js';
import { SEED_DATASETS } from '../config/datasets.js';
import { getPool } from '../db/pool.js';
import { handler } from './helpers.js';

export function healthRouter(env: Env, version: string): Router {
  const r = Router();

  r.get('/health', handler(async (_req, res) => {
    let dbConnected = false;
    try {
      await getPool().query('SELECT 1');
      dbConnected = true;
    } catch {
      // Swallowed on purpose: the endpoint's job is to REPORT reachability, and
      // a health check that 500s tells a load balancer nothing it can act on.
      dbConnected = false;
    }
    res.status(dbConnected ? 200 : 503).json({
      status: dbConnected ? 'ok' : 'degraded',
      dbConnected,
      // MUST go through `llmConfigured` (config/env.ts), which reads the key
      // belonging to `LLM_PROVIDER`. This line used to test `geminiApiKey`
      // directly and was missed by the ADR-093 swap, so an Anthropic deploy
      // reported `false` while its runs really were calling Anthropic --
      // deployment.md §5.4's pre-submission checklist tests this exact field.
      llmConfigured: llmConfigured(env),
      /**
       * WHICH DATASETS A RUN MAY BE STARTED AGAINST (ADR-129).
       *
       * Served rather than duplicated in the frontend, because the criterion —
       * "committed, with an answer key" — is enforced on this side of the wall
       * and a second copy of the list would eventually disagree with the one
       * `POST /api/runs` actually validates against. The launcher offering a
       * seed the API would refuse is the failure this prevents.
       */
      datasets: SEED_DATASETS.map((d) => ({ seed: d.seed, label: d.label })),
      version,
    });
  }));

  return r;
}
