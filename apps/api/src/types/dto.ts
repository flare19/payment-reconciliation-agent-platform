/**
 * Wire shapes — camelCase, per docs/api-contract.md §0.
 *
 * The snake_case ↔ camelCase boundary is the REPOSITORY layer. Services and
 * routes never see a snake_case key, and the frontend never sees one either.
 *
 * Money on the wire is always a pair: `amountPaise` (integer) plus a
 * server-formatted `amountDisplay` string. The frontend does no currency
 * arithmetic and no currency formatting — one formatter, server-side, so the
 * dashboard and the API can never disagree about a number.
 */

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface MoneyDto {
  amountPaise: number;
  amountDisplay: string;
}

export const ERROR_CODES = [
  'INVALID_REQUEST', 'UNSUPPORTED_FILE_TYPE', 'MISSING_REQUIRED_FILE', 'INVALID_ALIAS',
  'RUN_NOT_FOUND', 'EXCEPTION_NOT_FOUND', 'TRANSACTION_NOT_FOUND', 'MATCH_NOT_FOUND',
  'ALIAS_NOT_FOUND', 'SCORE_REPORT_NOT_FOUND', 'INVESTIGATION_NOT_FOUND',
  'RUN_NOT_COMPLETE', 'MATCH_NOT_REVIEWABLE', 'ALIAS_CONFLICT_UNCONFIRMED',
  'EXCEPTION_ALREADY_RESOLVED', 'TRANSACTION_ALREADY_MATCHED', 'INVESTIGATION_IN_PROGRESS',
  'FILE_TOO_LARGE', 'PARSE_FAILED', 'TRUTH_KEY_MISMATCH',
  'AGENT_QUOTA_EXCEEDED', 'AGENT_DISABLED', 'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
