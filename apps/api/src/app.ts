import { readFileSync } from 'node:fs';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Env } from './config/env.js';
import type { ErrorCode } from './types/dto.js';
import type { RunSources } from './services/run/orchestrator.js';
import { healthRouter } from './routes/health.js';
import { runsRouter } from './routes/runs.js';
import { auditRouter } from './routes/audit.js';
import { exceptionsRouter } from './routes/exceptions.js';
import { matchesRouter, manualMatchRouter } from './routes/matches.js';
import { transactionsRouter } from './routes/transactions.js';
import { aliasesRouter } from './routes/aliases.js';
import { investigationsRouter } from './routes/investigations.js';
import { rateLimit } from './routes/rate-limit.js';

const VERSION = '1.0.0';

/**
 * The committed holdout dataset, read from disk on demand.
 *
 * Read per run rather than cached at boot so the file hashes recorded on the
 * run always describe the bytes that run actually read. A cached copy would
 * make `input_file_hashes` a claim about start-up rather than about the run.
 */
function defaultSeedDataset(): RunSources {
  const dir = new URL('../../../data/fixtures/holdout/', import.meta.url).pathname;
  return {
    gateway: readFileSync(dir + 'gateway_export.csv', 'utf8'),
    bank: readFileSync(dir + 'bank_settlement.csv', 'utf8'),
    ledger: readFileSync(dir + 'merchant_ledger.csv', 'utf8'),
  };
}

/**
 * Express app factory. Kept separate from `index.ts` so tests can build an app
 * without binding a port.
 *
 * Routes are THIN (CLAUDE.md §4.3): parse, validate, delegate to a service,
 * serialize. If a route grows business logic, move it to `services/`.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function createApp(
  env: Env, readSeedDataset: () => RunSources = defaultSeedDataset,
): Express {
  const app = express();
  app.disable('x-powered-by');

  // ── LOAD-BEARING, NOT BOILERPLATE (ADR-096) ──
  // Railway terminates TLS at its edge, so without this `req.ip` is the EDGE's
  // address for every visitor and the whole deployment shares one rate-limit
  // bucket -- the first judge to browse would exhaust the read tier for
  // everyone else. `1` takes the hop the immediate proxy wrote (the RIGHTMOST
  // X-Forwarded-For entry); `true` would take the leftmost, which a client can
  // set to anything it likes and is therefore the spoofable choice.
  app.set('trust proxy', env.trustProxyHops ?? 1);

  app.use(express.json({ limit: '1mb' }));

  // Exact origins only, never '*' (deployment.md §3).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && env.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // ── THE METER, AHEAD OF EVERY ROUTER (ADR-096) ──
  // Mounted after CORS so a refused cross-origin request still carries the
  // headers the browser needs to READ the 429, and before every router so no
  // handler can be reached without passing it. `POST /api/runs` is the reason
  // this is not agent-only: it spends no LLM money and is the cheapest way to
  // hurt this deployment (~1,700 rows and 2.4 s of engine per call).
  app.use(rateLimit({ enabled: env.rateLimitEnabled }));

  // api-contract.md §1's binding endpoint table. Mount order matters in one
  // place: the agent router owns `/api/runs/:runId/investigations` and
  // `/api/runs/:runId/ask`, so it is mounted at `/api` BEFORE the runs router
  // claims `/api/runs/:runId/...`.
  app.use('/api', healthRouter(env, VERSION));                  // 1
  app.use('/api', investigationsRouter(env));                   // 25–28
  app.use('/api/runs', manualMatchRouter());                    // 21
  app.use('/api/runs', auditRouter());                          // 14
  app.use('/api/runs', runsRouter(env, readSeedDataset));       // 2–6, 8, 9, 19, 22, 23, 24
  app.use('/api/exceptions', exceptionsRouter());               // 7, 20
  app.use('/api/matches', matchesRouter());                     // 10, 11
  app.use('/api/transactions', transactionsRouter());           // 12, 13
  app.use('/api/aliases', aliasesRouter());                     // 15–18

  // A 404 for an unknown PATH is not a missing run. `RUN_NOT_FOUND` here would
  // send a client hunting for a run id that was never in the URL.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'INVALID_REQUEST', message: 'No such endpoint.', details: {} },
    });
  });

  // Uniform error envelope — never a bare string, never an HTML error page
  // (api-contract §0). Internal errors must not leak a stack to the client.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details ?? {} },
      });
      return;
    }
    console.error('[api] unhandled', err);
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', details: {} },
    });
  });

  return app;
}
