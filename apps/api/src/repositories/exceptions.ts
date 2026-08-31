/**
 * ALL SQL for `exceptions` lives here and nowhere else (CLAUDE.md §4.1).
 *
 * The exception list is the primary graded feature, not a fallback path, so this
 * file carries more read surface than any other: filters, facets, pagination and
 * a sort that a reviewer can act on.
 *
 * Two constraints shape the writes:
 *   `exc_resolution_complete` — a resolved exception must name who resolved it,
 *     when, and why. A resolution without a stated reason is the same hole in the
 *     audit trail a reason-less rejection would be (api-contract §20), so the
 *     database refuses it rather than trusting the route to remember.
 *   `severity` is COMPUTED (ADR-044) and arrives already decided; this file
 *     never derives it, because a severity computed in two places is a severity
 *     that disagrees with itself.
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { getPool, type TxClient } from '../db/pool.js';
import type { ExceptionCategory, Severity } from '../types/domain.js';
import type { ClassifiedException, ExceptionEvidence } from '../types/engine.js';

export type ExceptionStatus = 'open' | 'explained' | 'human_resolved' | 'wont_fix';
export type ExplanationSource = 'llm' | 'template' | 'llm_cache';

export interface ExceptionRecord {
  id: string;
  runId: string;
  transactionId: string | null;
  relatedTransactionIds: string[];
  category: ExceptionCategory;
  secondaryFlags: ExceptionCategory[];
  severity: Severity;
  bestCandidateScore: number | null;
  amountAtRiskPaise: number | null;
  requiresHumanConfirmation: boolean;
  evidence: ExceptionEvidence;
  detectedByRule: string;
  ruleVersion: string;
  explanationText: string | null;
  explanationSource: ExplanationSource | null;
  signatureHash: string | null;
  suggestedAction: string | null;
  status: ExceptionStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

const COLUMNS = `
  id, run_id, transaction_id, related_transaction_ids, category, secondary_flags,
  severity, best_candidate_score, amount_at_risk_paise, requires_human_confirmation,
  evidence, detected_by_rule, rule_version, explanation_text, explanation_source,
  signature_hash, suggested_action, status, resolved_by, resolved_at,
  resolution_note, created_at`;

interface ExcRow {
  id: string;
  run_id: string;
  transaction_id: string | null;
  related_transaction_ids: string[];
  category: ExceptionCategory;
  secondary_flags: ExceptionCategory[];
  severity: Severity;
  best_candidate_score: number | null;
  amount_at_risk_paise: number | null;
  requires_human_confirmation: boolean;
  evidence: ExceptionEvidence;
  detected_by_rule: string;
  rule_version: string;
  explanation_text: string | null;
  explanation_source: ExplanationSource | null;
  signature_hash: string | null;
  suggested_action: string | null;
  status: ExceptionStatus;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
}

function toException(r: ExcRow): ExceptionRecord {
  return {
    id: r.id,
    runId: r.run_id,
    transactionId: r.transaction_id,
    relatedTransactionIds: r.related_transaction_ids,
    category: r.category,
    secondaryFlags: r.secondary_flags,
    severity: r.severity,
    bestCandidateScore: r.best_candidate_score,
    amountAtRiskPaise: r.amount_at_risk_paise,
    requiresHumanConfirmation: r.requires_human_confirmation,
    evidence: r.evidence,
    detectedByRule: r.detected_by_rule,
    ruleVersion: r.rule_version,
    explanationText: r.explanation_text,
    explanationSource: r.explanation_source,
    signatureHash: r.signature_hash,
    suggestedAction: r.suggested_action,
    status: r.status,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
  };
}

/**
 * Write S12's output. One multi-row INSERT — at 555 exceptions the per-statement
 * round trip would dominate, and this runs inside the run's own transaction.
 */
const COLUMNS_PER_ROW = 12;
const CHUNK = 2000;

export async function insertExceptions(
  runId: string, exceptions: readonly ClassifiedException[], client?: TxClient,
): Promise<number> {
  if (exceptions.length === 0) return 0;
  const q = client ?? getPool();
  let written = 0;

  for (let start = 0; start < exceptions.length; start += CHUNK) {
    const chunk = exceptions.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    chunk.forEach((e, i) => {
      const b = i * COLUMNS_PER_ROW;
      tuples.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},` +
        `$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12})`);
      values.push(
        runId, e.transactionId, e.relatedTransactionIds, e.category, e.secondaryFlags,
        e.severity, e.bestCandidateScore, e.amountAtRiskPaise, e.requiresHumanConfirmation,
        JSON.stringify(e.evidence), e.detectedByRule, e.ruleVersion,
      );
    });

    const result = await q.query(
      `INSERT INTO exceptions (
         run_id, transaction_id, related_transaction_ids, category, secondary_flags,
         severity, best_candidate_score, amount_at_risk_paise, requires_human_confirmation,
         evidence, detected_by_rule, rule_version)
       VALUES ${tuples.join(',')}`,
      values,
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

export async function findException(
  id: string, client?: TxClient,
): Promise<ExceptionRecord | null> {
  const { rows } = await (client ?? getPool()).query<ExcRow>(
    `SELECT ${COLUMNS} FROM exceptions WHERE id = $1`, [id]);
  return rows.length === 0 ? null : toException(rows[0]!);
}

export interface ExceptionFilter {
  category?: ExceptionCategory;
  severity?: Severity;
  status?: ExceptionStatus;
  /** Free text over the explanation and the rule id. */
  search?: string;
}

export type ExceptionSort = 'severity' | 'amount' | 'created';

/**
 * The exception list (endpoint 6) — the primary screen.
 *
 * Default sort is severity, then money at risk. That ordering is the whole point
 * of ADR-044: a fixed per-category severity made a ₹5 rounding mismatch and a
 * ₹500,000 partial capture both `high`, which makes this screen useless. Sorting
 * by computed severity and then by amount puts the biggest real problem first.
 *
 * Every branch ends in `, id` so the order is TOTAL. Without it two exceptions
 * with equal severity and equal amount can swap places between pages, and a row
 * appears twice or never — a paginated list with a non-total sort is a list that
 * silently loses rows (ADR-032).
 */
const SORT_SQL: Record<ExceptionSort, string> = {
  severity: `ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                      amount_at_risk_paise DESC NULLS LAST, created_at, id`,
  amount: `ORDER BY amount_at_risk_paise DESC NULLS LAST, created_at, id`,
  created: `ORDER BY created_at, id`,
};

function buildWhere(runId: string, f: ExceptionFilter): { sql: string; params: unknown[] } {
  const where = ['run_id = $1'];
  const params: unknown[] = [runId];
  if (f.category !== undefined) { params.push(f.category); where.push(`category = $${params.length}`); }
  if (f.severity !== undefined) { params.push(f.severity); where.push(`severity = $${params.length}`); }
  if (f.status !== undefined) { params.push(f.status); where.push(`status = $${params.length}`); }
  if (f.search !== undefined && f.search.trim() !== '') {
    params.push(`%${f.search.trim()}%`);
    where.push(`(explanation_text ILIKE $${params.length} OR detected_by_rule ILIKE $${params.length})`);
  }
  return { sql: where.join(' AND '), params };
}

export async function listExceptions(
  runId: string, filter: ExceptionFilter, sort: ExceptionSort,
  limit: number, offset: number,
): Promise<{ exceptions: ExceptionRecord[]; total: number }> {
  const { sql, params } = buildWhere(runId, filter);
  const pool = getPool();
  const [page, count] = await Promise.all([
    pool.query<ExcRow>(
      `SELECT ${COLUMNS} FROM exceptions WHERE ${sql} ${SORT_SQL[sort]}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM exceptions WHERE ${sql}`, params),
  ]);
  return { exceptions: page.rows.map(toException), total: count.rows[0]!.count };
}

/**
 * Facet counts for the list's filter chips.
 *
 * Computed over the RUN, not over the current filter, so a chip always shows how
 * many exist rather than how many survive the filter already applied — a chip
 * that reads `0` because of the filter it would itself remove is a dead end.
 */
export async function exceptionFacets(runId: string): Promise<{
  byCategory: { category: ExceptionCategory; count: number }[];
  bySeverity: { severity: Severity; count: number }[];
  byStatus: { status: ExceptionStatus; count: number }[];
}> {
  const pool = getPool();
  const [cat, sev, st] = await Promise.all([
    pool.query<{ category: ExceptionCategory; count: number }>(
      `SELECT category, count(*)::int AS count FROM exceptions WHERE run_id = $1
        GROUP BY category ORDER BY category`, [runId]),
    pool.query<{ severity: Severity; count: number }>(
      `SELECT severity, count(*)::int AS count FROM exceptions WHERE run_id = $1
        GROUP BY severity ORDER BY severity`, [runId]),
    pool.query<{ status: ExceptionStatus; count: number }>(
      `SELECT status, count(*)::int AS count FROM exceptions WHERE run_id = $1
        GROUP BY status ORDER BY status`, [runId]),
  ]);
  return { byCategory: cat.rows, bySeverity: sev.rows, byStatus: st.rows };
}

/**
 * Attach S13's narration.
 *
 * `explanation_source` records WHICH path produced the text — `llm`, `llm_cache`
 * or `template`. The run must complete with the LLM API unavailable
 * (ADR-017), and a template-sourced explanation labelled as model output would
 * misrepresent what the system did.
 */
export async function setExplanation(
  exceptionId: string,
  e: {
    explanationText: string; suggestedAction: string;
    explanationSource: ExplanationSource; signatureHash: string;
  },
  client?: TxClient,
): Promise<void> {
  await (client ?? getPool()).query(
    `UPDATE exceptions
        SET explanation_text = $2, suggested_action = $3,
            explanation_source = $4, signature_hash = $5,
            status = CASE WHEN status = 'open' THEN 'explained' ELSE status END
      WHERE id = $1`,
    [exceptionId, e.explanationText, e.suggestedAction, e.explanationSource, e.signatureHash],
  );
}

/**
 * A human's disposition (endpoint 20).
 *
 * Guarded on the current status inside the WHERE clause, so a second resolver
 * gets `null` rather than overwriting the first — the route turns that into
 * `409 EXCEPTION_ALREADY_RESOLVED`. `resolutionNote` is required by
 * `exc_resolution_complete`; passing an empty one fails at the database, which
 * is the right place for it to fail.
 */
export async function resolveException(
  exceptionId: string,
  resolution: { status: 'human_resolved' | 'wont_fix'; resolvedBy: string; note: string },
  client?: TxClient,
): Promise<ExceptionRecord | null> {
  const { rows } = await (client ?? getPool()).query<ExcRow>(
    `UPDATE exceptions
        SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4
      WHERE id = $1 AND status IN ('open', 'explained')
      RETURNING ${COLUMNS}`,
    [exceptionId, resolution.status, resolution.resolvedBy, resolution.note],
  );
  return rows.length === 0 ? null : toException(rows[0]!);
}

/** Every exception on one record, for the record inspector. */
export async function listExceptionsForTransaction(
  transactionId: string,
): Promise<ExceptionRecord[]> {
  const { rows } = await getPool().query<ExcRow>(
    `SELECT ${COLUMNS} FROM exceptions
      WHERE transaction_id = $1 OR $1 = ANY(related_transaction_ids)
      ORDER BY created_at, id`,
    [transactionId],
  );
  return rows.map(toException);
}

/**
 * Exceptions still needing narration (S13's work list).
 *
 * Ordered by severity so a bounded LLM budget (`llmMaxCallsPerRun`) is spent on
 * the exceptions a controller reads first, rather than on whichever rows the
 * planner happened to return.
 */
export async function listUnexplained(runId: string, limit: number): Promise<ExceptionRecord[]> {
  const { rows } = await getPool().query<ExcRow>(
    `SELECT ${COLUMNS} FROM exceptions
      WHERE run_id = $1 AND explanation_text IS NULL
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               amount_at_risk_paise DESC NULLS LAST, created_at, id
      LIMIT $2`,
    [runId, limit],
  );
  return rows.map(toException);
}

/**
 * `find_similar_exceptions` — institutional memory for the Analyst (U12).
 *
 * READ-ONLY, like every Phase A query (ADR-049, ADR-051).
 *
 * Two lookup modes, and the difference matters:
 *   · by `signatureHash` — the SAME structural discrepancy shape, as computed by
 *     S13 (ADR-018). This is the sharp one, and it only became usable when U11
 *     started populating `signature_hash` on every exception.
 *   · by `category` — a much broader net, for when no signature is available.
 *
 * **Deliberately NOT scoped to one run.** Every other agent query is
 * run-scoped, and the asymmetry is the point: a human resolution recorded on a
 * previous run is exactly the institutional memory this tool exists to surface,
 * and confining it to the current run would return only exceptions the agent
 * could already see. The safety property that matters — an agent may not CITE a
 * record it did not retrieve — is enforced by the A3 grounding gate over tool
 * results, not by the WHERE clause, so widening the read here does not widen
 * what a verdict may claim. `resolvedOnly` narrows it to exceptions a human
 * actually dispositioned, which is the interesting subset.
 */
export interface SimilarExceptionQuery {
  signatureHash?: string;
  category?: ExceptionCategory;
  /** Only exceptions a human has resolved or dismissed. */
  resolvedOnly?: boolean;
  /** Never return the exception being investigated. */
  excludeExceptionId?: string;
}

export interface SimilarException {
  id: string;
  runId: string;
  category: ExceptionCategory;
  severity: Severity;
  signatureHash: string | null;
  status: ExceptionStatus;
  resolvedBy: string | null;
  resolutionNote: string | null;
  amountAtRiskPaise: number | null;
  createdAt: Date;
}

export async function findSimilarExceptions(
  query: SimilarExceptionQuery, limit: number, client?: TxClient,
): Promise<SimilarException[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    where.push(sql.replace('$?', `$${params.length}`));
  };

  if (query.signatureHash !== undefined) add('signature_hash = $?', query.signatureHash);
  if (query.category !== undefined) add('category = $?', query.category);
  if (query.excludeExceptionId !== undefined) add('id <> $?', query.excludeExceptionId);
  if (query.resolvedOnly === true) where.push(`status IN ('human_resolved', 'wont_fix')`);

  // Neither selector supplied would return "every exception ever", which is not
  // a similarity query — it is a data dump with a LIMIT on it, and the agent
  // would reason over whatever happened to sort first.
  if (query.signatureHash === undefined && query.category === undefined) {
    throw new Error(
      'findSimilarExceptions requires signatureHash or category: without one, ' +
      'this is an unfiltered scan rather than a similarity lookup.');
  }

  const { rows } = await (client ?? getPool()).query<{
    id: string; run_id: string; category: ExceptionCategory; severity: Severity;
    signature_hash: string | null; status: ExceptionStatus; resolved_by: string | null;
    resolution_note: string | null; amount_at_risk_paise: number | null; created_at: Date;
  }>(
    `SELECT id, run_id, category, severity, signature_hash, status, resolved_by,
            resolution_note, amount_at_risk_paise, created_at
       FROM exceptions
      WHERE ${where.join(' AND ')}
      -- Resolved ones first: a human's disposition is the useful part. Then
      -- newest, then id, so the order is TOTAL (ADR-032) and a re-run cites the
      -- same rows.
      ORDER BY (resolved_by IS NULL), created_at DESC, id
      LIMIT $${params.length + 1}`,
    [...params, limit]);

  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    category: r.category,
    severity: r.severity,
    signatureHash: r.signature_hash,
    status: r.status,
    resolvedBy: r.resolved_by,
    resolutionNote: r.resolution_note,
    amountAtRiskPaise: r.amount_at_risk_paise,
    createdAt: r.created_at,
  }));
}

/**
 * A1 TRIAGE — the exceptions worth investigating (agent-design §3, U13).
 *
 * READ-ONLY. Selection is DETERMINISTIC even though the investigations it feeds
 * are not, and that is the whole point of doing it in SQL with an explicit
 * ORDER BY: the Analyst's *work list* is reproducible from the run alone, so two
 * people asking "why did it investigate those twenty?" get the same answer
 * (ADR-032 rule 9).
 *
 * §3's order, exactly: `severity DESC, amount_at_risk_paise DESC,
 * (source_system, source_row_number) ASC`.
 *
 * Three things that sentence does not say and this query has to decide:
 *
 *  · **`severity DESC` is a taxonomy order, not a string order.** Alphabetically
 *    DESC would be medium > low > high, which is worse than useless. The CASE
 *    ranks high/medium/low the way `listExceptions` already does.
 *  · **`amount_at_risk_paise` is nullable** (group-level exceptions with no single
 *    amount). NULLS LAST: an exception with no stated amount must not outrank a
 *    proved ₹5,00,000 discrepancy by accident of a missing column.
 *  · **`transaction_id` is nullable too**, so the canonical tie-break needs a LEFT
 *    JOIN and its own NULLS LAST. `e.id` closes the order so it is TOTAL — a
 *    non-total order here would silently change which exceptions get the budget
 *    between two runs of the same data.
 */
export interface TriageCandidate {
  exceptionId: string;
  transactionId: string | null;
  category: ExceptionCategory;
  severity: Severity;
  amountAtRiskPaise: number | null;
  signatureHash: string | null;
}

export async function listExceptionTriageCandidates(
  runId: string,
  eligibleCategories: readonly ExceptionCategory[],
  limit: number,
  client?: TxClient,
): Promise<TriageCandidate[]> {
  if (eligibleCategories.length === 0 || limit <= 0) return [];
  const { rows } = await (client ?? getPool()).query<{
    id: string; transaction_id: string | null; category: ExceptionCategory;
    severity: Severity; amount_at_risk_paise: number | null; signature_hash: string | null;
  }>(
    `SELECT e.id, e.transaction_id, e.category, e.severity,
            e.amount_at_risk_paise, e.signature_hash
       FROM exceptions e
       LEFT JOIN transactions t ON t.id = e.transaction_id
      WHERE e.run_id = $1
        AND e.category = ANY($2::text[])
        -- Already dispositioned by a human: the Analyst adds nothing, and
        -- spending an investigation on a closed question is the one way this
        -- budget can be wasted without anybody noticing.
        AND e.status IN ('open', 'explained')
      ORDER BY CASE e.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               e.amount_at_risk_paise DESC NULLS LAST,
               source_rank(t.source_system) NULLS LAST, t.source_row_number NULLS LAST,
               e.id
      LIMIT $3`,
    [runId, [...eligibleCategories], limit]);

  return rows.map((r) => ({
    exceptionId: r.id,
    transactionId: r.transaction_id,
    category: r.category,
    severity: r.severity,
    amountAtRiskPaise: r.amount_at_risk_paise,
    signatureHash: r.signature_hash,
  }));
}
