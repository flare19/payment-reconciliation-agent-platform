import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Env } from './config/env.js';
import type { ErrorCode } from './types/dto.js';

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

export function createApp(env: Env): Express {
  const app = express();
  app.disable('x-powered-by');
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

  // TODO(day5+): mount routers here as they land. See docs/api-contract.md §1
  // for the binding endpoint table (28 endpoints).
  //   app.use('/api', healthRouter);
  //   app.use('/api/runs', runsRouter);
  //   ...

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: 'Route not found' } });
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
