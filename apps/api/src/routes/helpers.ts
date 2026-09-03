/**
 * Route plumbing shared by every router.
 *
 * Routes are THIN (CLAUDE.md §4.3): parse, validate, delegate, serialize. These
 * are the parse-and-validate half, factored out so twenty-eight handlers cannot
 * disagree about what `?page=0` means or which error code a missing run gets.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ApiError } from '../app.js';
import type { ErrorCode } from '../types/dto.js';

/** api-contract §0: `?page=1&pageSize=50`, default 50, max 200. */
export const MAX_PAGE_SIZE = 200;

export function pageParams(req: Request): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, intOr(req.query['page'], 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, intOr(req.query['pageSize'], 50)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function intOr(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A query parameter constrained to a known set.
 *
 * Anything outside the set is a `400`, never a silent ignore. A filter the
 * server quietly drops shows the user an unfiltered list that looks filtered,
 * which is worse than an error.
 */
export function enumParam<T extends string>(
  req: Request, name: string, allowed: readonly T[],
): T | undefined {
  const raw = req.query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new ApiError(400, 'INVALID_REQUEST',
      `${name} must be one of: ${allowed.join(', ')}`, { got: raw });
  }
  return raw as T;
}

export function stringParam(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}

/**
 * A path parameter, narrowed to `string`.
 *
 * Express 5 types `req.params` as `string | string[]` because a wildcard route
 * can bind an array. None of ours do, but the union has to be collapsed
 * somewhere, and doing it once here is better than a cast at every call site.
 */
export function pathParam(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name];
  if (typeof v !== 'string' || v === '') {
    throw new ApiError(400, 'INVALID_REQUEST', `${name} is missing from the path`);
  }
  return v;
}

/** RFC 4122 shape. Deliberately not version-pinned — `randomUUID` emits v4, but
 *  refusing a well-formed v7 id would be a validator inventing a rule. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path parameter that MUST be a UUID.
 *
 * Every id in this system is a UUID, and every one of them is interpolated
 * into SQL as `$1::uuid`. Postgres rejects a malformed one with
 * `22P02 invalid input syntax for type uuid`, which is not an `ApiError`, so it
 * reached the error middleware as an unknown throw and came back
 * `500 INTERNAL_ERROR`. A client's typo is a client error: `GET
 * /api/runs/not-a-uuid/metrics` must be a `400` that names the problem, not a
 * `500` that implies the server broke.
 *
 * Checking the shape here also means a malformed id never reaches the database
 * at all, so the route stays thin and the repository keeps its guarantee that
 * it is only ever handed well-formed ids.
 */
export function uuidParam(req: Request, name: string): string {
  const v = pathParam(req, name);
  if (!UUID_RE.test(v)) {
    throw new ApiError(400, 'INVALID_REQUEST',
      `${name} must be a UUID`, { got: v });
  }
  return v;
}

/** A required, non-empty string in a JSON body. */
export function requireString(body: unknown, field: string): string {
  const v = (body as Record<string, unknown> | null)?.[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ApiError(400, 'INVALID_REQUEST', `${field} is required and must be a non-empty string`);
  }
  return v.trim();
}

export function optionalString(body: unknown, field: string): string | null {
  const v = (body as Record<string, unknown> | null)?.[field];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Turn a repository `null` into the contract's 404 for that resource. */
export function found<T>(value: T | null, code: ErrorCode, message: string): T {
  if (value === null || value === undefined) throw new ApiError(404, code, message);
  return value;
}

/**
 * Wrap an async handler so a rejected promise reaches Express's error
 * middleware.
 *
 * Express 5 forwards rejections on its own, but relying on that silently makes
 * every handler depend on a framework version detail. One explicit wrapper is
 * cheaper than discovering the exception was swallowed during a demo.
 */
export function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
