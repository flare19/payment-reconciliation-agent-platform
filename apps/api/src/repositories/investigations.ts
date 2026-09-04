/**
 * ALL SQL for `agent_investigations` and `agent_questions` lives here and
 * nowhere else (CLAUDE.md §4.1).
 *
 * Phase A — the Analyst. Two properties of this table are load-bearing and this
 * file must not soften either:
 *
 *  1. **`confidence` is a LABEL, never a number.** `matches.confidence` is
 *     `NUMERIC(5,4)` and COMPUTED; the agent's is `high|medium|low` and
 *     ASSERTED. Giving them the same shape would invite sorting and averaging
 *     across two quantities that are not the same kind of thing (ADR-052).
 *  2. **`citations` is populated ONLY after the A3 grounding gate verified each
 *     id appeared in a real tool result from THIS investigation** (ADR-050).
 *     Unverified content never reaches the column, so this file offers no write
 *     path that sets citations without `grounding_passed`.
 *
 * Budget exhaustion is an honest verdict, never a fabricated conclusion —
 * `budget_exhausted` mirrors the engine's own `searchBoundExceeded` (ADR-054).
 * The agent PROPOSES; humans dispose through endpoints 16/20/21, so there is no
 * mutating path here that applies a proposal (ADR-049, ADR-051).
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { getPool, type TxClient } from '../db/pool.js';

export type InvestigationStatus = 'running' | 'concluded' | 'failed';
export type InvestigationVerdict =
  | 'RESOLUTION_PROPOSED' | 'CONFIRMED_UNRESOLVABLE'
  | 'NEEDS_EXTERNAL_DATA' | 'INSUFFICIENT_EVIDENCE';
export type AgentConfidence = 'high' | 'medium' | 'low';

export interface Investigation {
  id: string;
  runId: string;
  exceptionId: string;
  status: InvestigationStatus;
  verdict: InvestigationVerdict | null;
  confidence: AgentConfidence | null;
  proposedAction: Record<string, unknown> | null;
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
  humanDisposition: 'accepted' | 'declined' | null;
  resultingMatchId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const COLUMNS = `
  id, run_id, exception_id, status, verdict, confidence, proposed_action, reasoning,
  citations, grounding_passed, grounding_failure, budget_exhausted, steps, tool_calls,
  tokens_in, tokens_out, cost_usd, model, prompt_version, human_disposition,
  resulting_match_id, started_at, finished_at`;

interface InvRow {
  id: string;
  run_id: string;
  exception_id: string;
  status: InvestigationStatus;
  verdict: InvestigationVerdict | null;
  confidence: AgentConfidence | null;
  proposed_action: Record<string, unknown> | null;
  reasoning: unknown[];
  citations: string[];
  grounding_passed: boolean;
  grounding_failure: string | null;
  budget_exhausted: boolean;
  steps: number;
  tool_calls: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  model: string;
  prompt_version: string;
  human_disposition: 'accepted' | 'declined' | null;
  resulting_match_id: string | null;
  started_at: Date;
  finished_at: Date | null;
}

function toInvestigation(r: InvRow): Investigation {
  return {
    id: r.id,
    runId: r.run_id,
    exceptionId: r.exception_id,
    status: r.status,
    verdict: r.verdict,
    confidence: r.confidence,
    proposedAction: r.proposed_action,
    reasoning: r.reasoning,
    citations: r.citations,
    groundingPassed: r.grounding_passed,
    groundingFailure: r.grounding_failure,
    budgetExhausted: r.budget_exhausted,
    steps: r.steps,
    toolCalls: r.tool_calls,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    model: r.model,
    promptVersion: r.prompt_version,
    humanDisposition: r.human_disposition,
    resultingMatchId: r.resulting_match_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/**
 * Open an investigation. `running` with no verdict yet — `inv_concluded_has_verdict`
 * only binds once the status becomes `concluded`.
 *
 * The row is created BEFORE the loop runs so `investigationId` exists for the
 * grounding gate to scope tool results to (issue #21). A gate that cannot tell
 * which investigation a tool result came from cannot enforce its per-investigation
 * property at all.
 */
export async function startInvestigation(
  input: { runId: string; exceptionId: string; model: string; promptVersion: string },
  client?: TxClient,
): Promise<Investigation> {
  const { rows } = await (client ?? getPool()).query<InvRow>(
    `INSERT INTO agent_investigations (run_id, exception_id, status, model, prompt_version)
     VALUES ($1, $2, 'running', $3, $4)
     RETURNING ${COLUMNS}`,
    [input.runId, input.exceptionId, input.model, input.promptVersion],
  );
  return toInvestigation(rows[0]!);
}

export interface ConcludeInput {
  verdict: InvestigationVerdict;
  confidence: AgentConfidence;
  /** Required by `inv_proposal_paired` iff verdict is RESOLUTION_PROPOSED. */
  proposedAction: Record<string, unknown> | null;
  reasoning: unknown[];
  /** Only ids the A3 gate verified against this investigation's own tool results. */
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

/**
 * Conclude. Status, verdict and `finished_at` move together
 * (`inv_concluded_has_verdict`), and the proposal must be present exactly when
 * the verdict says it is (`inv_proposal_paired`).
 *
 * A grounding FAILURE is recorded, not swallowed. ADR-053 makes hallucination a
 * build blocker rather than a metric, so an investigation that failed the gate
 * must be visible as such — writing it away as `INSUFFICIENT_EVIDENCE` would
 * turn the one number that must be zero into a number nobody can see.
 */
export async function concludeInvestigation(
  investigationId: string, input: ConcludeInput, client?: TxClient,
): Promise<Investigation | null> {
  const { rows } = await (client ?? getPool()).query<InvRow>(
    `UPDATE agent_investigations
        SET status = 'concluded', finished_at = now(),
            verdict = $2, confidence = $3, proposed_action = $4, reasoning = $5,
            citations = $6, grounding_passed = $7, grounding_failure = $8,
            budget_exhausted = $9, steps = $10, tool_calls = $11,
            tokens_in = $12, tokens_out = $13, cost_usd = $14
      WHERE id = $1 AND status = 'running'
      RETURNING ${COLUMNS}`,
    [
      investigationId, input.verdict, input.confidence,
      input.proposedAction === null ? null : JSON.stringify(input.proposedAction),
      JSON.stringify(input.reasoning), input.citations,
      input.groundingPassed, input.groundingFailure, input.budgetExhausted,
      input.steps, input.toolCalls, input.tokensIn, input.tokensOut, input.costUsd,
    ],
  );
  return rows.length === 0 ? null : toInvestigation(rows[0]!);
}

/**
 * The loop threw. Failure is a state, not an absence.
 *
 * `usage` is OPTIONAL but is not decoration: a run that died on a provider
 * transport failure at step 4 still paid for steps 1–3, and `agentSpendUsdSince`
 * sums `cost_usd` off these rows to seed the public endpoint's ceiling
 * (ADR-095). A failed row that leaves `cost_usd` NULL therefore spends real
 * money the guard cannot see — the same "counter that resets" hole this file
 * already warns about for `agent_questions`, arriving through the failure path
 * instead of a missing table. Callers that know what the attempt cost pass it;
 * `COALESCE` keeps a caller that genuinely has no usage from zeroing a value
 * some other path already wrote.
 */
export async function failInvestigation(
  investigationId: string, reason: string,
  usage?: { tokensIn: number; tokensOut: number; costUsd: number | null },
  client?: TxClient,
): Promise<void> {
  await (client ?? getPool()).query(
    `UPDATE agent_investigations
        SET status = 'failed', finished_at = now(), grounding_failure = $2,
            tokens_in = COALESCE($3, tokens_in),
            tokens_out = COALESCE($4, tokens_out),
            cost_usd  = COALESCE($5, cost_usd)
      WHERE id = $1 AND status = 'running'`,
    [investigationId, reason,
     usage?.tokensIn ?? null, usage?.tokensOut ?? null, usage?.costUsd ?? null],
  );
}

/**
 * A human's disposition on a PROPOSAL (ADR-051).
 *
 * `resultingMatchId` is set by the endpoint that actually created the match, not
 * by the agent — the agent proposes, humans dispose, and the tool registry
 * contains no mutating tool by construction (ADR-049).
 */
export async function recordDisposition(
  investigationId: string,
  disposition: 'accepted' | 'declined',
  resultingMatchId: string | null,
  client?: TxClient,
): Promise<Investigation | null> {
  const { rows } = await (client ?? getPool()).query<InvRow>(
    `UPDATE agent_investigations
        SET human_disposition = $2, resulting_match_id = $3
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [investigationId, disposition, resultingMatchId],
  );
  return rows.length === 0 ? null : toInvestigation(rows[0]!);
}

export async function findInvestigation(id: string): Promise<Investigation | null> {
  const { rows } = await getPool().query<InvRow>(
    `SELECT ${COLUMNS} FROM agent_investigations WHERE id = $1`, [id]);
  return rows.length === 0 ? null : toInvestigation(rows[0]!);
}

/** Every investigation in a run, oldest first. `id` makes the order total. */
export async function listInvestigations(
  runId: string, limit: number, offset: number,
): Promise<{ investigations: Investigation[]; total: number }> {
  const pool = getPool();
  const [page, count] = await Promise.all([
    pool.query<InvRow>(
      `SELECT ${COLUMNS} FROM agent_investigations
        WHERE run_id = $1 ORDER BY started_at, id LIMIT $2 OFFSET $3`,
      [runId, limit, offset]),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM agent_investigations WHERE run_id = $1`, [runId]),
  ]);
  return { investigations: page.rows.map(toInvestigation), total: count.rows[0]!.count };
}

export async function findInvestigationForException(
  exceptionId: string,
): Promise<Investigation | null> {
  const { rows } = await getPool().query<InvRow>(
    `SELECT ${COLUMNS} FROM agent_investigations
      WHERE exception_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
    [exceptionId],
  );
  return rows.length === 0 ? null : toInvestigation(rows[0]!);
}

/**
 * What the Analyst decided, for the AGENT to read (ADR-171).
 *
 * Takes a `TxClient` because the tool registry runs every read inside
 * `withReadOnlyTransaction` — read-only is enforced by Postgres, not by the
 * function's name (ADR-051), and a repository call that quietly grabs its own
 * pooled connection would step outside that guarantee.
 *
 * Scoped to `runId` even when `exceptionId` is given: an exception belongs to
 * exactly one run, and passing both means a wrong-run id returns nothing rather
 * than another run's verdict.
 */
export async function findInvestigationsForAgent(
  runId: string, exceptionId: string | null, limit: number, client?: TxClient,
): Promise<Investigation[]> {
  const { rows } = await (client ?? getPool()).query<InvRow>(
    `SELECT ${COLUMNS} FROM agent_investigations
      WHERE run_id = $1 AND ($2::uuid IS NULL OR exception_id = $2::uuid)
      ORDER BY started_at DESC, id DESC LIMIT $3`,
    [runId, exceptionId, limit],
  );
  return rows.map(toInvestigation);
}

/**
 * Agent metrics for a run (schema.md §11.4).
 *
 * `hallucinatedResolutions` is `grounding_passed = false` among concluded
 * investigations, and it MUST be zero — ADR-053 makes it a build blocker, not a
 * metric. Computing it in SQL alongside the rest keeps the number one query away
 * rather than something someone remembers to check.
 */
export async function agentMetrics(runId: string): Promise<{
  total: number; concluded: number; failed: number;
  groundingFailures: number; budgetExhausted: number;
  proposals: number; accepted: number; declined: number;
  tokensIn: number; tokensOut: number; costUsd: number;
}> {
  const { rows } = await getPool().query<{
    total: number; concluded: number; failed: number;
    grounding_failures: number; budget_exhausted: number;
    proposals: number; accepted: number; declined: number;
    tokens_in: number; tokens_out: number; cost_usd: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'concluded')::int AS concluded,
            count(*) FILTER (WHERE status = 'failed')::int    AS failed,
            count(*) FILTER (WHERE status = 'concluded' AND grounding_passed = false)::int
              AS grounding_failures,
            count(*) FILTER (WHERE budget_exhausted)::int     AS budget_exhausted,
            count(*) FILTER (WHERE verdict = 'RESOLUTION_PROPOSED')::int AS proposals,
            count(*) FILTER (WHERE human_disposition = 'accepted')::int  AS accepted,
            count(*) FILTER (WHERE human_disposition = 'declined')::int  AS declined,
            COALESCE(sum(tokens_in), 0)::int  AS tokens_in,
            COALESCE(sum(tokens_out), 0)::int AS tokens_out,
            COALESCE(sum(cost_usd), 0)::numeric AS cost_usd
       FROM agent_investigations WHERE run_id = $1`,
    [runId],
  );
  const r = rows[0]!;
  return {
    total: r.total, concluded: r.concluded, failed: r.failed,
    groundingFailures: r.grounding_failures, budgetExhausted: r.budget_exhausted,
    proposals: r.proposals, accepted: r.accepted, declined: r.declined,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: Number(r.cost_usd),
  };
}

// ─── agent_questions (the Q&A loop, U15) ─────────────────────────────────────

export interface AgentQuestion {
  id: string;
  runId: string;
  question: string;
  answer: string | null;
  citations: string[];
  steps: number;
  toolCalls: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  groundingPassed: boolean;
  askedAt: Date;
}

const Q_COLUMNS = `
  id, run_id, question, answer, citations, steps, tool_calls,
  tokens_in, tokens_out, cost_usd, grounding_passed, asked_at`;

interface QRow {
  id: string;
  run_id: string;
  question: string;
  answer: string | null;
  citations: string[];
  steps: number;
  tool_calls: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  grounding_passed: boolean;
  asked_at: Date;
}

function toQuestion(r: QRow): AgentQuestion {
  return {
    id: r.id, runId: r.run_id, question: r.question, answer: r.answer,
    citations: r.citations, steps: r.steps, toolCalls: r.tool_calls,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
    groundingPassed: r.grounding_passed, askedAt: r.asked_at,
  };
}

export async function recordQuestion(
  input: {
    /**
     * Minted by the CALLER, not defaulted by Postgres (U15 unit 3).
     *
     * The audit trail and every tool record are stamped with this id as the
     * answer happens, which is before this row exists. Letting the column
     * default would mean the trail cites one id and the row carries another --
     * and the trail is the half a reader checks.
     */
    id?: string;
    runId: string; question: string; answer: string | null; citations: string[];
    steps: number; toolCalls: number; tokensIn: number | null; tokensOut: number | null;
    costUsd: number | null; groundingPassed: boolean;
  },
  client?: TxClient,
): Promise<AgentQuestion> {
  const { rows } = await (client ?? getPool()).query<QRow>(
    `INSERT INTO agent_questions (
       id, run_id, question, answer, citations, steps, tool_calls,
       tokens_in, tokens_out, cost_usd, grounding_passed)
     VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING ${Q_COLUMNS}`,
    [
      input.id ?? null, input.runId, input.question, input.answer, input.citations,
      input.steps, input.toolCalls, input.tokensIn, input.tokensOut,
      input.costUsd, input.groundingPassed,
    ],
  );
  return toQuestion(rows[0]!);
}

/**
 * Recent questions for a run, newest first.
 *
 * Also the rate-limit read (ADR-056): counting recent rows is how endpoint 28
 * answers `429 AGENT_QUOTA_EXCEEDED`.
 */
export async function listQuestions(runId: string, limit: number): Promise<AgentQuestion[]> {
  const { rows } = await getPool().query<QRow>(
    `SELECT ${Q_COLUMNS} FROM agent_questions
      WHERE run_id = $1 ORDER BY asked_at DESC, id DESC LIMIT $2`,
    [runId, limit],
  );
  return rows.map(toQuestion);
}


/**
 * Agent spend in a trailing window, in USD (see #61).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * DERIVED, NOT A NEW LEDGER TABLE.
 *
 * `cost_usd` is already written on every concluded investigation and
 * corroboration, so the spend ledger the issue asks for already exists — it just
 * had no reader. Summing it is persistent by construction: it survives a process
 * restart and a redeploy, which an in-memory counter does not, and on a
 * hard-capped prepaid key a counter that forgets on restart is a counter an
 * attacker resets by making the process crash.
 *
 * Rows with a NULL `cost_usd` (the free tier, or a model with no published rate)
 * contribute ZERO rather than being guessed at. That understates spend on a
 * mixed-provider window, which is the safe direction only because a NULL there
 * means nothing was billed.
 * ══════════════════════════════════════════════════════════════════════════════
 */
export async function agentSpendUsdSince(
  since: Date, client?: TxClient,
): Promise<number> {
  const { rows } = await (client ?? getPool()).query<{ usd: string }>(
    // ── EVERY SPENDER, OR THE CEILING IS NOT A CEILING (U15 unit 2) ──
    // `agent_questions` joined this sum the moment a third surface could bill
    // the key. Omitting it would have been worse than an undercount: the Q&A
    // endpoint seeds its OWN guard from this function, so questions invisible
    // here are questions invisible to the guard meant to bound them — each
    // request would start believing nothing had been spent. That is precisely
    // the "counter an attacker resets" failure this file's header warns about,
    // arriving through a different door. Its timestamp column is `asked_at`,
    // not `started_at`: a question is one request, not a phase with a start
    // and an end.
    `SELECT COALESCE(
        (SELECT sum(cost_usd) FROM agent_investigations WHERE started_at >= $1), 0)
      + COALESCE(
        (SELECT sum(cost_usd) FROM agent_corroborations  WHERE started_at >= $1), 0)
      + COALESCE(
        (SELECT sum(cost_usd) FROM agent_questions       WHERE asked_at   >= $1), 0)
      AS usd`,
    [since],
  );
  return Number(rows[0]?.usd ?? 0);
}


/**
 * Q&A QUOTA READS (agent-design.md §9, U15 unit 2).
 *
 * Two counts, deliberately separate from the dollar ceiling above and NOT a
 * substitute for it. §9 specifies both a per-run and a per-hour question cap,
 * and they bound a different thing than money does: a count bounds VOLUME — how
 * hard an anonymous visitor can hammer a public endpoint — while only dollars
 * bound SPEND, because question cost varies by an order of magnitude with how
 * many tools a question makes the model reach for. A count cap alone cannot
 * bound a bill, and a dollar cap alone leaves the endpoint free to be hammered
 * with cheap questions. Both, or neither is honest.
 *
 * Counted from rows already written, like the spend sum, so both survive a
 * restart. Nothing here is held in memory.
 */
export async function countQuestionsForRun(
  runId: string, client?: TxClient,
): Promise<number> {
  const { rows } = await (client ?? getPool()).query<{ n: string }>(
    `SELECT count(*) AS n FROM agent_questions WHERE run_id = $1`, [runId]);
  return Number(rows[0]?.n ?? 0);
}

export async function countQuestionsSince(
  since: Date, client?: TxClient,
): Promise<number> {
  const { rows } = await (client ?? getPool()).query<{ n: string }>(
    `SELECT count(*) AS n FROM agent_questions WHERE asked_at >= $1`, [since]);
  return Number(rows[0]?.n ?? 0);
}
