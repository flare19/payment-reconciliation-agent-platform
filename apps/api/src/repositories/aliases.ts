/**
 * ALL SQL for `learned_aliases` lives here and nowhere else (CLAUDE.md §4.1).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * `eligibleForAliasTier` IS COMPUTED HERE, NEVER STORED.
 *
 * schema.md §6.3's penalty rule: an alias with `conflict_count > 0` AND
 * `confirmation_count < 2` is barred from Tier 1.5's exact re-run and may only
 * contribute a resolved `counterparty_key` to Tier 2. Storing that as a column
 * would mean two writers could disagree with the counts it is derived from, and
 * an alias silently regaining Tier 1.5 eligibility is a silently wrong auto-
 * match. matching-engine.md §5 says the server owns this rule; this is where the
 * server owns it, in the SELECT list, so every reader gets the same answer.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Aliases are NEVER edited in place. Two write paths only:
 *   supersede — a conflicting assertion inserts a new row and points the old one
 *     at it, carrying `conflict_count + 1`. Correctable, and the first contested
 *     application falls back to human review rather than poisoning future runs.
 *   revoke    — terminal, requires a reason (`alias_revoked_has_reason`), no
 *     replacement row.
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { randomUUID } from 'node:crypto';

import { getPool, withTransaction, type TxClient } from '../db/pool.js';
import type { AliasScope, AliasType } from '../types/domain.js';
import type { ActiveAlias } from '../types/engine.js';

export type AliasStatus = 'active' | 'superseded' | 'revoked';

export interface Alias {
  id: string;
  aliasType: AliasType;
  scopeSource: AliasScope;
  rawValue: string;
  normalizedValue: string;
  canonicalValue: string;
  status: AliasStatus;
  confirmationCount: number;
  conflictCount: number;
  appliedCount: number;
  lastAppliedAt: Date | null;
  createdFromMatchId: string | null;
  createdBy: string;
  approvedAt: Date;
  supersededBy: string | null;
  revokedReason: string | null;
  /** COMPUTED, never stored — §6.3's penalty. */
  eligibleForAliasTier: boolean;
}

/**
 * The penalty expression, written once. Inlined into every SELECT rather than
 * recomputed per call site, because two spellings of this rule is two answers.
 */
const ELIGIBLE_SQL =
  `(conflict_count = 0 OR confirmation_count >= 2) AS eligible_for_alias_tier`;

const COLUMNS = `
  id, alias_type, scope_source, raw_value, normalized_value, canonical_value,
  status, confirmation_count, conflict_count, applied_count, last_applied_at,
  created_from_match_id, created_by, approved_at, superseded_by, revoked_reason,
  ${ELIGIBLE_SQL}`;

interface AliasRow {
  id: string;
  alias_type: AliasType;
  scope_source: AliasScope;
  raw_value: string;
  normalized_value: string;
  canonical_value: string;
  status: AliasStatus;
  confirmation_count: number;
  conflict_count: number;
  applied_count: number;
  last_applied_at: Date | null;
  created_from_match_id: string | null;
  created_by: string;
  approved_at: Date;
  superseded_by: string | null;
  revoked_reason: string | null;
  eligible_for_alias_tier: boolean;
}

function toAlias(r: AliasRow): Alias {
  return {
    id: r.id,
    aliasType: r.alias_type,
    scopeSource: r.scope_source,
    rawValue: r.raw_value,
    normalizedValue: r.normalized_value,
    canonicalValue: r.canonical_value,
    status: r.status,
    confirmationCount: r.confirmation_count,
    conflictCount: r.conflict_count,
    appliedCount: r.applied_count,
    lastAppliedAt: r.last_applied_at,
    createdFromMatchId: r.created_from_match_id,
    createdBy: r.created_by,
    approvedAt: r.approved_at,
    supersededBy: r.superseded_by,
    revokedReason: r.revoked_reason,
    eligibleForAliasTier: r.eligible_for_alias_tier,
  };
}

/**
 * The engine's alias set for a run (S7's input).
 *
 * `status = 'active'` only: superseded and revoked aliases never apply again.
 * The ORDER BY is decision-feeding — Tier 1.5 iterates this list, and an
 * unspecified order would make which alias fires first depend on the query plan
 * (ADR-032). A cold run gets an empty array, which is the correct cold baseline
 * (ADR-020), not a missing feature.
 */
export async function listActiveAliases(client?: TxClient): Promise<ActiveAlias[]> {
  const { rows } = await (client ?? getPool()).query<AliasRow>(
    `SELECT ${COLUMNS} FROM learned_aliases
      WHERE status = 'active'
      ORDER BY alias_type, normalized_value, scope_source, id`,
  );
  return rows.map((r) => ({
    id: r.id,
    aliasType: r.alias_type,
    scopeSource: r.scope_source,
    normalizedValue: r.normalized_value,
    canonicalValue: r.canonical_value,
    eligibleForAliasTier: r.eligible_for_alias_tier,
  }));
}

export async function findAlias(id: string, client?: TxClient): Promise<Alias | null> {
  const { rows } = await (client ?? getPool()).query<AliasRow>(
    `SELECT ${COLUMNS} FROM learned_aliases WHERE id = $1`, [id]);
  return rows.length === 0 ? null : toAlias(rows[0]!);
}

export interface CreateAliasInput {
  aliasType: AliasType;
  scopeSource: AliasScope;
  rawValue: string;
  normalizedValue: string;
  canonicalValue: string;
  createdBy: string;
  createdFromMatchId?: string | null;
}

export type AliasUpsert =
  /** §6.3 case 1: the same assertion again. No new row. */
  | { outcome: 'reaffirmed'; alias: Alias }
  /** §6.3 case 2: a different canonical value. Old row superseded, new row penalised. */
  | { outcome: 'superseded'; alias: Alias; previous: Alias }
  | { outcome: 'created'; alias: Alias };

/**
 * Assert an alias, applying §6.3's supersede-with-penalty policy.
 *
 * All three branches run in ONE transaction, and the ORDER inside the supersede
 * branch is forced by the schema:
 *
 *   1. retire the old row FIRST, naming a successor id that does not exist yet;
 *   2. then insert the successor under that id.
 *
 * The reverse order — insert then retire, which reads more naturally — violates
 * `ux_alias_active`, because both rows are `active` between the two statements.
 * Naming a successor before it exists is only legal because migration 012 made
 * `superseded_by` DEFERRABLE; the unique index and the
 * `alias_superseded_has_target` CHECK still fire immediately, so no window
 * exists in which a key has two active aliases or a superseded row has no
 * stated successor. The full argument is in that migration's header.
 *
 * The id is therefore generated here rather than by the column default: step 1
 * has to know it before step 2 creates the row.
 */
export async function upsertAlias(
  input: CreateAliasInput, client?: TxClient,
): Promise<AliasUpsert> {
  const run = async (c: TxClient): Promise<AliasUpsert> => {
    const { rows: existing } = await c.query<AliasRow>(
      `SELECT ${COLUMNS} FROM learned_aliases
        WHERE alias_type = $1 AND normalized_value = $2 AND scope_source = $3
          AND status = 'active'
        FOR UPDATE`,
      [input.aliasType, input.normalizedValue, input.scopeSource],
    );
    const current = existing.length === 0 ? null : toAlias(existing[0]!);

    // Case 1 — same assertion. Confirmation, not conflict. Two independent
    // confirmations also lift an earlier penalty (§6.3 rule 3).
    if (current !== null && current.canonicalValue === input.canonicalValue) {
      const { rows } = await c.query<AliasRow>(
        `UPDATE learned_aliases
            SET confirmation_count = confirmation_count + 1
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [current.id],
      );
      return { outcome: 'reaffirmed', alias: toAlias(rows[0]!) };
    }

    const newId = randomUUID();
    const conflictCount = current === null ? 0 : current.conflictCount + 1;

    // Step 1, and it MUST come first: free the active slot. The successor id is
    // legal here only because the FK is deferred to COMMIT (migration 012).
    let previous: Alias | null = null;
    if (current !== null) {
      const { rows: retired } = await c.query<AliasRow>(
        `UPDATE learned_aliases
            SET status = 'superseded', superseded_by = $2
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [current.id, newId],
      );
      previous = toAlias(retired[0]!);
    }

    // Step 2: the slot is free, so the successor can be active.
    const { rows: inserted } = await c.query<AliasRow>(
      `INSERT INTO learned_aliases (
         id, alias_type, scope_source, raw_value, normalized_value, canonical_value,
         status, confirmation_count, conflict_count, created_by, created_from_match_id)
       VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7,$8,$9)
       RETURNING ${COLUMNS}`,
      [
        newId, input.aliasType, input.scopeSource, input.rawValue, input.normalizedValue,
        input.canonicalValue, conflictCount, input.createdBy,
        input.createdFromMatchId ?? null,
      ],
    );
    const alias = toAlias(inserted[0]!);

    return previous === null
      ? { outcome: 'created', alias }
      : { outcome: 'superseded', alias, previous };
  };
  return client === undefined ? withTransaction(run) : run(client);
}

/**
 * Revoke (endpoint 17). Terminal, and NOT the same as supersession: there is no
 * replacement row, and `alias_revoked_has_reason` refuses a revocation with no
 * stated reason.
 */
export async function revokeAlias(
  aliasId: string, revokedReason: string, client?: TxClient,
): Promise<Alias | null> {
  const { rows } = await (client ?? getPool()).query<AliasRow>(
    `UPDATE learned_aliases
        SET status = 'revoked', revoked_reason = $2
      WHERE id = $1 AND status = 'active'
      RETURNING ${COLUMNS}`,
    [aliasId, revokedReason],
  );
  return rows.length === 0 ? null : toAlias(rows[0]!);
}

/**
 * The alias-management screen (endpoint 15).
 *
 * `ORDER BY approved_at DESC, id` — newest assertion first, with `id` making the
 * order total so pagination cannot drop a row.
 */
export async function listAliases(
  filter: { status?: AliasStatus; aliasType?: AliasType; search?: string },
  limit: number, offset: number,
): Promise<{ aliases: Alias[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) { params.push(filter.status); where.push(`status = $${params.length}`); }
  if (filter.aliasType !== undefined) { params.push(filter.aliasType); where.push(`alias_type = $${params.length}`); }
  if (filter.search !== undefined && filter.search.trim() !== '') {
    params.push(`%${filter.search.trim()}%`);
    where.push(`(raw_value ILIKE $${params.length} OR normalized_value ILIKE $${params.length}
                 OR canonical_value ILIKE $${params.length})`);
  }
  const predicate = where.length === 0 ? 'TRUE' : where.join(' AND ');

  const pool = getPool();
  const [page, count] = await Promise.all([
    pool.query<AliasRow>(
      `SELECT ${COLUMNS} FROM learned_aliases WHERE ${predicate}
        ORDER BY approved_at DESC, id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM learned_aliases WHERE ${predicate}`, params),
  ]);
  return { aliases: page.rows.map(toAlias), total: count.rows[0]!.count };
}

/**
 * The supersession chain for one alias (endpoint 18), oldest first.
 *
 * A recursive walk in SQL rather than N round trips: the chain is the artifact
 * that shows a reviewer how a contested alias arrived at its current value, and
 * fetching it one row at a time would make the depth visible as latency.
 */
export async function aliasLineage(aliasId: string): Promise<Alias[]> {
  const { rows } = await getPool().query<AliasRow>(
    `WITH RECURSIVE back AS (
       SELECT * FROM learned_aliases WHERE id = $1
       UNION
       SELECT a.* FROM learned_aliases a JOIN back b ON a.superseded_by = b.id
     ), forward AS (
       SELECT * FROM learned_aliases WHERE id = $1
       UNION
       SELECT a.* FROM learned_aliases a JOIN forward f ON a.id = f.superseded_by
     )
     SELECT ${COLUMNS} FROM (
       SELECT * FROM back UNION SELECT * FROM forward
     ) AS chain
      ORDER BY approved_at, id`,
    [aliasId],
  );
  return rows.map(toAlias);
}

/**
 * How many aliases sit in each terminal state, for S14's `aliasLearning` block.
 *
 * One grouped query rather than three filtered `listAliases` calls: the metrics
 * stage wants three integers, and paginating three result sets to count them
 * would make a cheap aggregate look expensive at the 100k benchmark (see #39 for
 * what that mistake costs on the audit path).
 *
 * Counts EVERY alias ever taught, including revoked ones. A revoked alias is
 * still a correction a human made — it is the leverage ratio's denominator, and
 * dropping it would flatter the ratio by hiding the corrections that turned out
 * to be wrong.
 */
export async function aliasStatusCounts(
  client?: TxClient,
): Promise<{ active: number; superseded: number; revoked: number }> {
  const c = client ?? getPool();
  const { rows } = await c.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM learned_aliases GROUP BY status ORDER BY status`,
  );
  const out = { active: 0, superseded: 0, revoked: 0 };
  for (const r of rows) {
    if (r.status === 'active' || r.status === 'superseded' || r.status === 'revoked') {
      out[r.status] = r.count;
    }
  }
  return out;
}

/**
 * Bump the cached application counters after a run used an alias.
 *
 * `applied_count` is a CACHE, not the source of truth: the audit log's
 * `ALIAS_APPLIED` events are, and this column can always be rebuilt by counting
 * them. Recorded here so nobody later treats a drifted counter as data loss.
 */
export async function recordAliasApplications(
  aliasIds: readonly string[], client?: TxClient,
): Promise<void> {
  if (aliasIds.length === 0) return;
  await (client ?? getPool()).query(
    `UPDATE learned_aliases AS a
        SET applied_count   = a.applied_count + u.n,
            last_applied_at = now()
       FROM (SELECT id, count(*)::int AS n FROM unnest($1::uuid[]) AS id GROUP BY id) AS u
      WHERE a.id = u.id`,
    [aliasIds],
  );
}
