/**
 * ALL SQL for `agent_corroborations` lives here and nowhere else (CLAUDE.md §4.1).
 *
 * Separate from `agent_investigations` by ADR-087: a corroboration is a
 * statement about EVIDENCE on a pending match, an investigation is a statement
 * about whether an exception can be resolved, and the two vocabularies are
 * deliberately disjoint so nothing can count them together.
 *
 * There is no `proposed_action` column and this file has no way to write one.
 * agent-design.md §3: the Analyst never says "confirm this" — the human still
 * clicks, through `PATCH /api/matches/:id`.
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { getPool, type TxClient } from '../db/pool.js';
import type { AgentConfidence, CorroborationVerdict } from '../types/agent.js';

export type CorroborationStatus = 'running' | 'concluded' | 'failed';

export interface Corroboration {
  id: string;
  runId: string;
  matchId: string;
  status: CorroborationStatus;
  verdict: CorroborationVerdict | null;
  confidence: AgentConfidence | null;
  reasoning: unknown[];
  citations: string[];
  groundingPassed: boolean;
  groundingFailure: string | null;
  budgetExhausted: boolean;
  steps: number;
  toolCalls: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  model: string;
  promptVersion: string;
  startedAt: Date;
  finishedAt: Date | null;
}

const COLUMNS = `
  id, run_id, match_id, status, verdict, confidence, reasoning, citations,
  grounding_passed, grounding_failure, budget_exhausted, steps, tool_calls,
  tokens_in, tokens_out, cost_usd, model, prompt_version, started_at, finished_at`;

interface Row {
  id: string; run_id: string; match_id: string; status: CorroborationStatus;
  verdict: CorroborationVerdict | null; confidence: AgentConfidence | null;
  reasoning: unknown[]; citations: string[]; grounding_passed: boolean;
  grounding_failure: string | null; budget_exhausted: boolean; steps: number;
  tool_calls: number; tokens_in: number | null; tokens_out: number | null;
  cost_usd: string | number | null; model: string; prompt_version: string;
  started_at: Date; finished_at: Date | null;
}

function toCorroboration(r: Row): Corroboration {
  return {
    id: r.id, runId: r.run_id, matchId: r.match_id, status: r.status,
    verdict: r.verdict, confidence: r.confidence, reasoning: r.reasoning,
    citations: r.citations, groundingPassed: r.grounding_passed,
    groundingFailure: r.grounding_failure, budgetExhausted: r.budget_exhausted,
    steps: r.steps, toolCalls: r.tool_calls,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    model: r.model, promptVersion: r.prompt_version,
    startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

export async function startCorroboration(
  input: { runId: string; matchId: string; model: string; promptVersion: string },
  client?: TxClient,
): Promise<Corroboration> {
  const { rows } = await (client ?? getPool()).query<Row>(
    `INSERT INTO agent_corroborations (run_id, match_id, status, model, prompt_version)
     VALUES ($1, $2, 'running', $3, $4)
     RETURNING ${COLUMNS}`,
    [input.runId, input.matchId, input.model, input.promptVersion]);
  return toCorroboration(rows[0]!);
}

export interface ConcludeCorroborationInput {
  verdict: CorroborationVerdict;
  confidence: AgentConfidence;
  reasoning: unknown[];
  /** Only ids A3 verified against THIS corroboration's own tool results. */
  citations: string[];
  groundingPassed: boolean;
  groundingFailure: string | null;
  budgetExhausted: boolean;
  steps: number;
  toolCalls: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

export async function concludeCorroboration(
  id: string, input: ConcludeCorroborationInput, client?: TxClient,
): Promise<void> {
  await (client ?? getPool()).query(
    `UPDATE agent_corroborations
        SET status = 'concluded', verdict = $2, confidence = $3, reasoning = $4,
            citations = $5, grounding_passed = $6, grounding_failure = $7,
            budget_exhausted = $8, steps = $9, tool_calls = $10,
            tokens_in = $11, tokens_out = $12, cost_usd = $13, finished_at = now()
      WHERE id = $1`,
    [id, input.verdict, input.confidence, JSON.stringify(input.reasoning),
      input.citations, input.groundingPassed, input.groundingFailure,
      input.budgetExhausted, input.steps, input.toolCalls,
      input.tokensIn, input.tokensOut, input.costUsd]);
}

/** Newest first, with a TOTAL order so pagination cannot lose a row (ADR-032). */
export async function listCorroborations(
  runId: string, limit: number, offset: number,
): Promise<{ corroborations: Corroboration[]; total: number }> {
  const pool = getPool();
  const [page, count] = await Promise.all([
    pool.query<Row>(
      `SELECT ${COLUMNS} FROM agent_corroborations WHERE run_id = $1
        ORDER BY started_at DESC, id LIMIT $2 OFFSET $3`, [runId, limit, offset]),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM agent_corroborations WHERE run_id = $1`, [runId]),
  ]);
  return { corroborations: page.rows.map(toCorroboration), total: count.rows[0]!.count };
}

export async function findCorroborationForMatch(
  matchId: string,
): Promise<Corroboration | null> {
  const { rows } = await getPool().query<Row>(
    `SELECT ${COLUMNS} FROM agent_corroborations
      WHERE match_id = $1 AND status <> 'failed'
      ORDER BY started_at DESC LIMIT 1`, [matchId]);
  return rows.length === 0 ? null : toCorroboration(rows[0]!);
}

/**
 * Reported SEPARATELY from `agentMetrics` (ADR-087).
 *
 * §7's grounding-failure count is a claim about INVESTIGATIONS. Folding
 * corroborations in would change what the honesty metric measures without
 * anyone editing the metric.
 */
export async function corroborationMetrics(runId: string): Promise<{
  total: number; byVerdict: Record<string, number>;
  groundingFailures: number; budgetExhausted: number;
}> {
  const { rows } = await getPool().query<{
    verdict: string | null; c: number; grounding: number; budget: number;
  }>(
    `SELECT verdict, count(*)::int AS c,
            count(*) FILTER (WHERE NOT grounding_passed)::int AS grounding,
            count(*) FILTER (WHERE budget_exhausted)::int AS budget
       FROM agent_corroborations
      WHERE run_id = $1 AND status = 'concluded'
      GROUP BY verdict ORDER BY verdict`, [runId]);

  const byVerdict: Record<string, number> = {};
  let total = 0; let groundingFailures = 0; let budgetExhausted = 0;
  for (const r of rows) {
    if (r.verdict !== null) byVerdict[r.verdict] = r.c;
    total += r.c; groundingFailures += r.grounding; budgetExhausted += r.budget;
  }
  return { total, byVerdict, groundingFailures, budgetExhausted };
}
