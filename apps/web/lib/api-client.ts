/**
 * THE ONLY place in the frontend that fetches the API (CLAUDE.md §4.7).
 *
 * One base URL, one error-envelope handler, one casing assumption. No `fetch`
 * anywhere else — not in a component, not in a route handler, not "just this once".
 *
 * The frontend does NO currency arithmetic and NO currency formatting: the API
 * sends `amountPaise` plus a pre-formatted `amountDisplay` (api-contract §0), so
 * the dashboard and the API cannot disagree about a number. In a reconciliation
 * product that would be an embarrassing bug to have on screen.
 */

import { CATEGORY_LABEL } from '@/lib/taxonomy';
import type {
  Alias, AliasListResponse, AuditListResponse, ChainVerification, ExceptionDetail,
  ExceptionListResponse, Health, InvestigationDetail, MatchListResponse, MatchSummary,
  PopulationResponse, ReviewQueueResponse, TransactionDetail,
  InvestigationListResponse, MetricsResponse, RunListResponse, RunSummary,
  RunQuestion, QuestionListResponse,
} from '@/types/api';

const BASE_URL = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080/api';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** ui-spec §9: every error surface names the failing endpoint. */
    readonly path: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      // A dashboard that caches a reconciliation run is a dashboard showing a
      // number that is no longer true. Freshness beats the request it saves.
      cache: 'no-store',
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    // The API being unreachable is the single most likely demo-day failure, and
    // it arrives as a bare TypeError with no status. Give it the same envelope
    // as every other error so one surface can render all of them.
    throw new ApiClientError(0, 'API_UNREACHABLE',
      `Could not reach the API at ${BASE_URL}. ${(cause as Error).message}`, path);
  }

  if (!res.ok) {
    let code = 'INTERNAL_ERROR';
    let message = res.statusText;
    try {
      const body = await res.json() as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Non-JSON error body — keep the status text. The API should never do this
      // (api-contract §0), so if it happens it is worth seeing verbatim.
    }
    throw new ApiClientError(res.status, code, message, path);
  }
  return res.json() as Promise<T>;
}

/**
 * Endpoints whose absence is a legitimate state rather than a failure.
 *
 * `measured` metrics before the scorer has run, and Analyst results on a run
 * Phase A never touched, are both *nothing to report* — not errors. Rendering
 * them as error banners would train a viewer to ignore error banners, and the
 * one place this project cannot afford that is a screen whose whole argument is
 * which numbers exist and which do not.
 */
async function optional<T>(p: Promise<T>, absentCodes: readonly string[]): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiClientError && absentCodes.includes(err.code)) return null;
    throw err;
  }
}

// ── endpoint 3 ───────────────────────────────────────────────────────────────
export const listRuns = (pageSize = 25) =>
  apiFetch<RunListResponse>(`/runs?page=1&pageSize=${pageSize}`);

// ── endpoint 4 ───────────────────────────────────────────────────────────────
export const getRun = (runId: string) =>
  apiFetch<RunSummary>(`/runs/${runId}`);

// ── endpoint 5 ───────────────────────────────────────────────────────────────
export const getMetrics = (runId: string) =>
  apiFetch<MetricsResponse>(`/runs/${runId}/metrics`);

/**
 * The dashboard computes the verdict distribution from the returned list, so it
 * asks for the contract's maximum page size — a distribution over page one of
 * several would describe an arbitrary subset. The component still checks
 * `pagination.total` against what arrived and refuses to draw the bar if the
 * run ever outgrows one page.
 */
// ── endpoint 26 ──────────────────────────────────────────────────────────────
export const getInvestigations = (runId: string, pageSize = 200) =>
  apiFetch<InvestigationListResponse>(
    `/runs/${runId}/investigations?page=1&pageSize=${pageSize}`);

/** `409 RUN_NOT_COMPLETE` on a run still in flight is an absence, not a failure. */
export const getMetricsIfComplete = (runId: string) =>
  optional(getMetrics(runId), ['RUN_NOT_COMPLETE']);

/** A run Phase A never ran on, or an API with the agent disabled. */
export const getInvestigationsIfAny = (runId: string) =>
  optional(getInvestigations(runId), ['RUN_NOT_COMPLETE', 'AGENT_DISABLED']);

// ── endpoint 28 · ask a question about the run (U15) ─────────────────────────

/**
 * THE SECOND CONTROL IN THE FRONTEND THAT SPENDS MONEY, and the only one that
 * takes free text.
 *
 * SYNCHRONOUS AND SLOW ON PURPOSE. Unlike endpoint 25 there is no 202 and no
 * poll target: the contract returns the answer in the response body, so this
 * promise is held open for the length of the whole investigation -- up to about
 * 30 seconds at 6 bounded steps. Any caller must render a waiting state; a
 * spinner-less button here reads as a broken page.
 *
 * The server bounds the question at 500 characters, and the component mirrors
 * that bound rather than owning it -- the bound is a SPEND bound and the server
 * is where it is enforced.
 */
export const askQuestion = (runId: string, question: string) =>
  apiPost<RunQuestion>(`/runs/${runId}/ask`, { question });

/** The persisted history. Free, and true even when the agent is switched off. */
export const getQuestions = (runId: string) =>
  apiFetch<QuestionListResponse>(`/runs/${runId}/questions`);

export const getQuestionsIfAny = (runId: string) =>
  optional(getQuestions(runId), ['RUN_NOT_COMPLETE', 'AGENT_DISABLED']);

// ─────────────────────────────────────────────────────────────────────────────
// U18 · the remaining screens
//
// Reads are plain `apiFetch`. Writes go through `apiPost`, which exists so that
// every mutation carries the same error envelope and so the one place a
// reviewer identity is invented is visible in a grep.
// ─────────────────────────────────────────────────────────────────────────────

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
};

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

// ── endpoint 1 ───────────────────────────────────────────────────────────────
export const getHealth = () => apiFetch<Health>('/health');

// ── endpoint 6 ───────────────────────────────────────────────────────────────
export const listExceptions = (
  runId: string,
  filters: {
    category?: string; severity?: string; status?: string; search?: string;
    sort?: string; page?: number; pageSize?: number;
  } = {},
) => apiFetch<ExceptionListResponse>(
  `/runs/${runId}/exceptions${qs({ ...filters, pageSize: filters.pageSize ?? 50 })}`);

// ── endpoint 7 ───────────────────────────────────────────────────────────────
export const getException = (exceptionId: string) =>
  apiFetch<ExceptionDetail>(`/exceptions/${exceptionId}`);

// ── endpoint 8 ───────────────────────────────────────────────────────────────
export const listMatches = (
  runId: string, filters: { tier?: string; status?: string; page?: number } = {},
) => apiFetch<MatchListResponse>(
  `/runs/${runId}/matches${qs({ ...filters, pageSize: 25 })}`);

/**
 * How many proposals are STILL waiting, right now.
 *
 * `runs.metrics.reviewBurden` is frozen at run completion (ADR-041) and is the
 * engine's account of what it deferred; this is the live state of that same
 * pile. The dashboard showed 71 while `/review` showed 49 and neither said
 * which question it was answering (ADR-120). `pageSize: 1` because only
 * `pagination.total` is wanted.
 */
export const countPendingReview = (runId: string) =>
  apiFetch<MatchListResponse>(
    `/runs/${runId}/matches${qs({ status: 'pending_review', pageSize: 1 })}`)
    .then((r) => r.pagination.total);

// ── endpoint 9 ───────────────────────────────────────────────────────────────
export const getReviewQueue = (runId: string, page = 1) =>
  apiFetch<ReviewQueueResponse>(`/runs/${runId}/review-queue${qs({ page, pageSize: 1 })}`);

// ── endpoints 10, 11 ─────────────────────────────────────────────────────────
export const approveMatch = (
  matchId: string,
  body: { reviewedBy: string; note?: string; aliasProposals?: unknown[] },
) => apiPost<{ match: MatchSummary; aliasesCreated: Alias[]; auditEntryIds: string[] }>(
  `/matches/${matchId}/approve`, body);

export const rejectMatch = (matchId: string, body: { reviewedBy: string; reason: string }) =>
  apiPost<{ match: MatchSummary; exceptionCreated: unknown; auditEntryIds: string[] }>(
    `/matches/${matchId}/reject`, body);

// ── endpoints 12, 13 ─────────────────────────────────────────────────────────
export const getTransaction = (transactionId: string) =>
  apiFetch<TransactionDetail>(`/transactions/${transactionId}`);

export const getTransactionAudit = (transactionId: string, page = 1) =>
  apiFetch<AuditListResponse>(
    `/transactions/${transactionId}/audit${qs({ page, pageSize: 50 })}`);

// ── endpoint 14 ──────────────────────────────────────────────────────────────
export const listAudit = (
  runId: string,
  filters: { eventType?: string; actorType?: string; page?: number } = {},
) => apiFetch<AuditListResponse>(
  `/runs/${runId}/audit${qs({ ...filters, pageSize: 50 })}`);

// ── endpoint 15 ──────────────────────────────────────────────────────────────
export const listAliases = (filters: { status?: string; search?: string; page?: number } = {}) =>
  apiFetch<AliasListResponse>(`/aliases${qs({ ...filters, pageSize: 50 })}`);

// ── endpoint 20 ──────────────────────────────────────────────────────────────
export const resolveException = (
  exceptionId: string,
  body: { resolvedBy: string; resolution: 'human_resolved' | 'wont_fix'; note: string },
) => apiPost<{ exception: ExceptionDetail; auditEntryIds: string[] }>(
  `/exceptions/${exceptionId}/resolve`, body);

// ── endpoint 22 ──────────────────────────────────────────────────────────────
/**
 * Chain verification is a BUTTON, not a background check (ui-spec §6). Running
 * it live in front of a panel is a stronger demonstration than any description
 * of the trigger that enforces it, and it takes one click.
 */
export const verifyAuditChain = (runId: string) =>
  apiFetch<ChainVerification>(`/runs/${runId}/audit/verify`);

// ── endpoint 24 ──────────────────────────────────────────────────────────────
export const getPopulation = (
  runId: string, kind: 'excluded' | 'rejected' | 'duplicates', page = 1,
) => apiFetch<PopulationResponse>(
  `/runs/${runId}/population${qs({ kind, page, pageSize: 50 })}`);

// ── endpoint 27 ──────────────────────────────────────────────────────────────
export const getInvestigation = (investigationId: string) =>
  apiFetch<InvestigationDetail>(`/investigations/${investigationId}`);

/**
 * The investigations for ONE exception, found by filtering the run's list.
 *
 * There is no `GET /api/exceptions/:id/investigations` in the contract, and the
 * exception detail page must show a PERSISTED investigation without spending
 * money — a demo that re-runs the agent on every page load is a demo that
 * empties a prepaid key in front of an audience.
 */
export async function getInvestigationsForException(runId: string, exceptionId: string) {
  const data = await getInvestigationsIfAny(runId);
  if (!data) return [];
  return data.investigations.filter((i) => i.exceptionId === exceptionId);
}

// ── endpoint 25 · THE ONLY CALL IN THE FRONTEND THAT SPENDS MONEY ────────────

/**
 * Ask the Analyst to investigate one exception.
 *
 * Roughly $0.10–0.12 per investigation, so this is deliberately the only
 * money-spending path the frontend has, it is reached only by an explicit
 * click, and it is never called during render (ADR-109).
 *
 * Three outcomes, and the caller must handle all three:
 *   `202` — dispatched. Poll `/api/investigations/:id` for the verdict.
 *   `200` with `reused: true` — one already exists. FREE, same verdict.
 *   `409 INVESTIGATION_IN_PROGRESS` — someone else is running it right now.
 */
export interface InvestigateResponse {
  exceptionId: string;
  status: 'running' | 'concluded';
  investigationId?: string;
  reused?: boolean;
  detailAt?: string;
  pollAt?: string;
}

export const investigateException = (exceptionId: string) =>
  apiPost<InvestigateResponse>(`/exceptions/${exceptionId}/investigate`, {});

// ── endpoint 2 · start a run ─────────────────────────────────────────────────

/**
 * Start a reconciliation run over the committed seed dataset.
 *
 * The ENGINE costs nothing — no model is involved in matching, classifying or
 * auditing. The only spend is S13, the explain layer, which is capped at
 * `llmMaxCallsPerRun` and is why `llmExplainEnabled` is exposed here rather than
 * assumed: a caller who does not want to spend must be able to say so.
 *
 * `202` then poll `GET /api/runs/:runId` until `status === 'completed'`.
 */
export const startRun = (body: {
  label?: string;
  /**
   * WHICH COMMITTED DATASET TO RECONCILE (ADR-129). Omitting it reconciles the
   * holdout, which is what every run did before this existed — nine of the
   * first ten runs reconciled byte-identical input and reported the same
   * number, because the launcher could not ask for anything else.
   */
  datasetSeed?: number;
  configOverrides?: { llmExplainEnabled?: boolean };
}) => apiPost<{ runId: string; status: string; label: string; startedAt: string }>(
  '/runs', { useSeedDataset: true, ...body });

// ── citations ────────────────────────────────────────────────────────────────

export interface ResolvedCitation {
  id: string;
  kind: 'transaction' | 'exception' | 'unknown';
  /** Where to send a reader who clicks it. `null` when nothing resolved. */
  href: string | null;
  /** Something meaningful to show instead of a truncated UUID. */
  label: string;
  detail: string | null;
}

/**
 * WHAT KIND OF THING IS THIS CITATION?
 *
 * The grounding gate accepts any id that appeared in a tool result, and tool
 * results contain more than one kind of id: `get_transaction` yields transaction
 * ids, `get_exception` and `find_similar_exceptions` yield exception ids. On the
 * holdout the split is 18 transactions to 8 exceptions.
 *
 * The first version linked every citation to `/records/:id`, so a third of them
 * led to a not-found page — on the one part of the Analyst panel whose entire
 * purpose is letting a reader check a claim against the record behind it.
 *
 * Resolved server-side, one lookup per distinct id, so there is no client
 * waterfall and the reader gets a real label rather than eight hex characters.
 */
export async function resolveCitation(id: string): Promise<ResolvedCitation> {
  try {
    const t = await getTransaction(id);
    return {
      id,
      kind: 'transaction',
      href: `/records/${id}`,
      label: t.externalId ?? id.slice(0, 8),
      detail: `${t.sourceSystem} · ${t.amountDisplay}`,
    };
  } catch (err) {
    if (!(err instanceof ApiClientError) || err.code !== 'TRANSACTION_NOT_FOUND') throw err;
  }

  try {
    const e = await getException(id);
    return {
      id,
      kind: 'exception',
      href: `/exceptions/${id}`,
      label: CATEGORY_LABEL[e.category] ?? e.category,
      detail: e.primaryRecord.amountDisplay,
    };
  } catch (err) {
    if (!(err instanceof ApiClientError) || err.code !== 'EXCEPTION_NOT_FOUND') throw err;
  }

  // Neither. Shown as unresolved rather than as a dead link — a citation the
  // gate accepted but nothing can be found for is a finding in its own right.
  return { id, kind: 'unknown', href: null, label: id.slice(0, 8), detail: null };
}
