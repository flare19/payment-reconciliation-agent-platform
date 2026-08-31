/**
 * ALL SQL for `matches` and `match_members` lives here and nowhere else
 * (CLAUDE.md §4.1).
 *
 * A match is a GROUP, not a pair (ADR-016). The membership table handles 1:1:1,
 * 1:1:0 and N:1:N with one shape — three nullable FKs would look simpler and
 * break on the first net-settlement batch.
 *
 * ── The invariant this file exists to respect ──
 * A transaction belongs to at most one non-rejected match per run. Postgres
 * cannot express that as a partial unique index (no subqueries in the
 * predicate), so migration 004 enforces it with a `BEFORE INSERT` trigger on
 * `match_members`. That means a violation surfaces here as a raised exception at
 * INSERT time, not as a constraint name — `insertMatch` therefore writes the
 * group and its members inside ONE transaction, so a rejected member can never
 * leave a half-written group behind.
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { getPool, withTransaction, type TxClient } from '../db/pool.js';
import type { Cardinality, MatchStatus, MatchTier, MemberRole } from '../types/domain.js';
import type { ProposedMatch, ScoreBreakdown } from '../types/engine.js';

export interface MatchMember {
  transactionId: string;
  role: MemberRole;
  isAnchor: boolean;
}

export interface Match {
  id: string;
  runId: string;
  tier: MatchTier;
  status: MatchStatus;
  confidence: number;
  ruleId: string;
  ruleVersion: string;
  cardinality: Cardinality;
  amountDeltaPaise: number;
  dateDeltaDays: number;
  aliasIds: string[];
  scoreBreakdown: ScoreBreakdown | null;
  matchedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  members: MatchMember[];
}

const COLUMNS = `
  m.id, m.run_id, m.tier, m.status, m.confidence, m.rule_id, m.rule_version,
  m.cardinality, m.amount_delta_paise, m.date_delta_days, m.alias_ids,
  m.score_breakdown, m.matched_at, m.reviewed_by, m.reviewed_at, m.review_note`;

interface MatchRow {
  id: string;
  run_id: string;
  tier: MatchTier;
  status: MatchStatus;
  confidence: number;
  rule_id: string;
  rule_version: string;
  cardinality: Cardinality;
  amount_delta_paise: number;
  date_delta_days: number;
  alias_ids: string[];
  score_breakdown: ScoreBreakdown | null;
  matched_at: Date;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  members: MatchMember[] | null;
}

/**
 * Members arrive as an aggregated JSON array so a group is one row rather than
 * one row per member — which keeps pagination meaningful. `ORDER BY` inside the
 * aggregate is load-bearing: without it the member order varies per plan and two
 * runs emit different JSON for the same group (ADR-032).
 */
const MEMBERS_AGG = `
  COALESCE((
    SELECT json_agg(json_build_object(
             'transactionId', mm.transaction_id,
             'role',          mm.role,
             'isAnchor',      mm.is_anchor)
           ORDER BY CASE mm.role WHEN 'gateway' THEN 0 WHEN 'bank' THEN 1 ELSE 2 END,
                    mm.transaction_id)
      FROM match_members mm WHERE mm.match_id = m.id
  ), '[]'::json) AS members`;

function toMatch(r: MatchRow): Match {
  return {
    id: r.id,
    runId: r.run_id,
    tier: r.tier,
    status: r.status,
    confidence: r.confidence,
    ruleId: r.rule_id,
    ruleVersion: r.rule_version,
    cardinality: r.cardinality,
    amountDeltaPaise: r.amount_delta_paise,
    dateDeltaDays: r.date_delta_days,
    aliasIds: r.alias_ids,
    scoreBreakdown: r.score_breakdown,
    matchedAt: r.matched_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
    members: r.members ?? [],
  };
}

/**
 * Write one group and its members atomically.
 *
 * The single-match trigger fires on member INSERT, so a group whose second
 * member is rejected must not survive as a one-member group. Wrapping both
 * writes in one transaction is what makes the trigger's rejection mean "this
 * group was not written" rather than "this group was written wrong".
 */
export async function insertMatch(
  runId: string, proposal: ProposedMatch, ruleVersion: string, client?: TxClient,
): Promise<Match> {
  const run = async (c: TxClient): Promise<Match> => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO matches (
         run_id, tier, status, confidence, rule_id, rule_version, cardinality,
         amount_delta_paise, date_delta_days, alias_ids, score_breakdown)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        runId, proposal.tier, proposal.status, proposal.confidence, proposal.ruleId,
        ruleVersion, proposal.cardinality, proposal.amountDeltaPaise, proposal.dateDeltaDays,
        proposal.aliasIds,
        proposal.scoreBreakdown === null ? null : JSON.stringify(proposal.scoreBreakdown),
      ],
    );
    const matchId = rows[0]!.id;

    await c.query(
      `INSERT INTO match_members (match_id, transaction_id, role, is_anchor)
       SELECT $1, t.txn_id::uuid, t.role, t.is_anchor
         FROM unnest($2::uuid[], $3::text[], $4::boolean[]) AS t(txn_id, role, is_anchor)`,
      [
        matchId,
        proposal.members.map((m) => m.transactionId),
        proposal.members.map((m) => m.role),
        proposal.members.map((m) => m.isAnchor),
      ],
    );

    const full = await c.query<MatchRow>(
      `SELECT ${COLUMNS}, ${MEMBERS_AGG} FROM matches m WHERE m.id = $1`, [matchId]);
    return toMatch(full.rows[0]!);
  };
  return client === undefined ? withTransaction(run) : run(client);
}

/** Bulk path for S11's output. One transaction for the whole set. */
export async function insertMatches(
  runId: string, proposals: readonly ProposedMatch[], ruleVersion: string,
  client?: TxClient,
): Promise<Match[]> {
  const run = async (c: TxClient): Promise<Match[]> => {
    const out: Match[] = [];
    for (const p of proposals) out.push(await insertMatch(runId, p, ruleVersion, c));
    return out;
  };
  return client === undefined ? withTransaction(run) : run(client);
}

export async function findMatch(matchId: string): Promise<Match | null> {
  const { rows } = await getPool().query<MatchRow>(
    `SELECT ${COLUMNS}, ${MEMBERS_AGG} FROM matches m WHERE m.id = $1`, [matchId]);
  return rows.length === 0 ? null : toMatch(rows[0]!);
}

/**
 * Browse what DID match (endpoint 8).
 *
 * `ORDER BY confidence DESC, matched_at, id` — confidence alone is not a total
 * order, and two matches with identical confidence would otherwise paginate
 * non-deterministically. The trailing `id` makes every comparison decisive.
 */
export async function listMatches(
  runId: string,
  filter: { tier?: MatchTier; status?: MatchStatus },
  limit: number, offset: number,
): Promise<{ matches: Match[]; total: number }> {
  const where = ['m.run_id = $1'];
  const params: unknown[] = [runId];
  if (filter.tier !== undefined) { params.push(filter.tier); where.push(`m.tier = $${params.length}`); }
  if (filter.status !== undefined) { params.push(filter.status); where.push(`m.status = $${params.length}`); }
  const predicate = where.join(' AND ');

  const pool = getPool();
  const [page, count] = await Promise.all([
    pool.query<MatchRow>(
      `SELECT ${COLUMNS}, ${MEMBERS_AGG} FROM matches m
        WHERE ${predicate}
        ORDER BY m.confidence DESC, m.matched_at, m.id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM matches m WHERE ${predicate}`, params),
  ]);
  return { matches: page.rows.map(toMatch), total: count.rows[0]!.count };
}

/**
 * The human review queue (endpoint 9): `pending_review` only.
 *
 * Weakest first. A reviewer's time is best spent where the engine was least
 * sure, and sorting by confidence DESC would put the near-certain proposals at
 * the top of a queue whose whole purpose is the doubtful ones.
 */
export async function listReviewQueue(
  runId: string, limit: number, offset: number,
): Promise<{ matches: Match[]; total: number }> {
  const pool = getPool();
  const [page, count] = await Promise.all([
    pool.query<MatchRow>(
      `SELECT ${COLUMNS}, ${MEMBERS_AGG} FROM matches m
        WHERE m.run_id = $1 AND m.status = 'pending_review'
        ORDER BY m.confidence ASC, m.matched_at, m.id
        LIMIT $2 OFFSET $3`,
      [runId, limit, offset]),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM matches
        WHERE run_id = $1 AND status = 'pending_review'`, [runId]),
  ]);
  return { matches: page.rows.map(toMatch), total: count.rows[0]!.count };
}

/**
 * A human's verdict on a proposal (endpoints 10 and 11).
 *
 * Guarded on `status = 'pending_review'` in the WHERE clause rather than checked
 * first and updated after: a read-then-write would let two reviewers both see
 * `pending_review` and both act. `null` back means the match was not reviewable,
 * which the route turns into `409 MATCH_NOT_REVIEWABLE`.
 *
 * `reviewed_by` and `reviewed_at` move together (`match_review_fields_paired`).
 */
export async function reviewMatch(
  matchId: string,
  verdict: { status: 'human_confirmed' | 'human_rejected'; reviewedBy: string; note: string | null },
  client?: TxClient,
): Promise<Match | null> {
  const q = client ?? getPool();
  const { rows } = await q.query<{ id: string }>(
    `UPDATE matches
        SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
      WHERE id = $1 AND status = 'pending_review'
      RETURNING id`,
    [matchId, verdict.status, verdict.reviewedBy, verdict.note],
  );
  if (rows.length === 0) return null;
  const full = await q.query<MatchRow>(
    `SELECT ${COLUMNS}, ${MEMBERS_AGG} FROM matches m WHERE m.id = $1`, [matchId]);
  return toMatch(full.rows[0]!);
}

/** Every match a transaction belongs to. Used to answer "is this record matched?". */
export async function findMatchesForTransaction(transactionId: string): Promise<Match[]> {
  const { rows } = await getPool().query<MatchRow>(
    `SELECT ${COLUMNS}, ${MEMBERS_AGG} FROM matches m
      WHERE EXISTS (SELECT 1 FROM match_members mm
                     WHERE mm.match_id = m.id AND mm.transaction_id = $1)
      ORDER BY m.matched_at, m.id`,
    [transactionId],
  );
  return rows.map(toMatch);
}

/**
 * Counts per tier and status, for `runs.metrics` (S14).
 *
 * Computed in SQL rather than by loading every match: at ADR-045's 100k
 * benchmark the difference is a scan versus a transfer, and the numbers are
 * aggregates the database is better at than we are.
 */
export async function countMatchesByTierAndStatus(
  runId: string,
): Promise<{ tier: MatchTier; status: MatchStatus; count: number }[]> {
  const result = await getPool().query<{ tier: MatchTier; status: MatchStatus; count: number }>(
    `SELECT tier, status, count(*)::int AS count
       FROM matches WHERE run_id = $1
      GROUP BY tier, status
      ORDER BY tier, status`,
    [runId],
  );
  return result.rows;
}

/**
 * Transaction ids in at least one match with a COUNTING status (ADR-040).
 *
 * `auto_confirmed` and `human_confirmed` only. A `pending_review` match is a
 * proposal, and counting proposals as reconciliations would put work a human has
 * not done into the headline number — the same class of dishonesty as reporting
 * a warm rate as a cold one.
 */
export async function listMatchedTransactionIds(runId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ transaction_id: string }>(
    `SELECT DISTINCT mm.transaction_id
       FROM match_members mm
       JOIN matches m ON m.id = mm.match_id
      WHERE m.run_id = $1 AND m.status IN ('auto_confirmed', 'human_confirmed')
      ORDER BY mm.transaction_id`,
    [runId],
  );
  return rows.map((r) => r.transaction_id);
}

/**
 * A1b TRIAGE — the review queue as a second work list (ADR-081, U13).
 *
 * READ-ONLY. `listReviewQueue` above serves the human's screen and orders by
 * `confidence ASC, matched_at, id`; this one serves the Analyst and follows
 * agent-design §3's own order, which is different and deliberately so.
 *
 * **Ascending confidence, because the least certain proposal is where a reviewer
 * most needs the work done for them.** The exception list orders by severity;
 * this one orders by doubt.
 *
 * `amount_at_risk_paise` does not exist on `matches`, so §3's second term is
 * derived: the largest member amount in the group. A pending match's money at
 * risk is the size of the payment it concerns, and taking the MAX rather than a
 * sum avoids double-counting the same economic event across its two or three
 * legs. Stated here because a derived column that looks like a stored one is how
 * a metric quietly becomes wrong.
 *
 * The canonical tie-break is the group's EARLIEST member in canonical order, so
 * two groups never compare by whichever leg the aggregate happened to visit
 * first. `m.id` closes the order so it is TOTAL (ADR-032).
 */
export interface QueueTriageCandidate {
  matchId: string;
  tier: MatchTier;
  confidence: number;
  memberTransactionIds: string[];
  maxMemberAmountPaise: number;
}

export async function listQueueTriageCandidates(
  runId: string, limit: number, client?: TxClient,
): Promise<QueueTriageCandidate[]> {
  if (limit <= 0) return [];
  const { rows } = await (client ?? getPool()).query<{
    id: string; tier: MatchTier; confidence: number;
    member_ids: string[]; max_amount: number;
  }>(
    `SELECT m.id, m.tier, m.confidence,
            ARRAY(SELECT mm2.transaction_id FROM match_members mm2
                   JOIN transactions t2 ON t2.id = mm2.transaction_id
                  WHERE mm2.match_id = m.id
                  ORDER BY source_rank(t2.source_system), t2.source_row_number) AS member_ids,
            max(t.amount_paise) AS max_amount,
            min(source_rank(t.source_system)) AS first_rank,
            min(t.source_row_number) AS first_row
       FROM matches m
       JOIN match_members mm ON mm.match_id = m.id
       JOIN transactions t ON t.id = mm.transaction_id
      WHERE m.run_id = $1 AND m.status = 'pending_review'
      GROUP BY m.id, m.tier, m.confidence
      ORDER BY m.confidence ASC,
               max(t.amount_paise) DESC,
               min(source_rank(t.source_system)), min(t.source_row_number),
               m.id
      LIMIT $2`,
    [runId, limit]);

  return rows.map((r) => ({
    matchId: r.id,
    tier: r.tier,
    confidence: Number(r.confidence),
    memberTransactionIds: r.member_ids,
    maxMemberAmountPaise: Number(r.max_amount),
  }));
}
