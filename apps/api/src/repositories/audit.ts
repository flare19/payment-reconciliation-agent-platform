/**
 * ALL SQL for `audit_log` lives here and nowhere else (CLAUDE.md §4.1).
 *
 * The append-only trigger and the hash chain (ADR-042) between them mean this
 * table has exactly one legal operation: INSERT. There is no update path and no
 * delete path in this file, deliberately — if you find yourself needing one, the
 * design has gone wrong.
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import {
  ADVISORY_LOCK, advisoryXactLockHeldSql, getPool, takeAdvisoryXactLock, withTransaction,
  type TxClient,
} from '../db/pool.js';
import { canonicalJson } from '../services/audit/canonical-json.js';
import {
  GENESIS_HASH, computeEntryHash, toStoredForm, verifyChain,
  type ChainAnchor, type ChainVerification, type HashableAuditEntry, type StoredAuditEntry,
} from '../services/audit/hash-chain.js';

/** What a caller supplies. `occurredAt` is optional here and filled in at append. */
export type AuditEntryInput = Omit<HashableAuditEntry, 'occurredAt'> & { occurredAt?: Date };

/**
 * Append one entry, chained to the current head.
 *
 * ---------------------------------------------------------------------------
 * `occurred_at` IS SUPPLIED BY THE APPLICATION, never left to the column default.
 *
 * It is inside the hash, so a `now()` default would be unknown at hash time and
 * every entry would fail verification. This is the one place in the engine where
 * reading the clock is correct: `occurred_at` is a record of when something
 * happened, not an input to a decision (CLAUDE.md §4.8).
 * ---------------------------------------------------------------------------
 *
 * The transaction-scoped advisory lock makes the single-writer assumption in
 * `schema.md` §9.0 ENFORCED rather than merely documented. Two concurrent appends
 * would otherwise read the same head and produce two entries claiming the same
 * predecessor — a chain that verifies as broken, caused by the writer rather than
 * by tampering, which is the worst possible false positive for this mechanism.
 * It costs one lock acquisition per append and removes the assumption entirely.
 *
 * `client` is a `TxClient`, not a `PoolClient`: `pg_advisory_xact_lock` lives
 * exactly as long as the transaction, so on a client in autocommit it is released
 * by the statement that took it and the append runs unprotected. The type makes
 * that unrepresentable and the `lock_held` check below catches the untyped caller
 * (issue #16 — this is the second time an advisory lock in this repo has been
 * taken somewhere it did not survive; see the note in `db/pool.ts`).
 */
export async function appendAuditEntry(
  input: AuditEntryInput, client?: TxClient,
): Promise<StoredAuditEntry> {
  const run = async (c: TxClient): Promise<StoredAuditEntry> => {
    // Chains are per run; entries with no run form their own chain, so they get
    // their own lock key rather than colliding with run 0.
    const lockKey = input.runId === null ? 0 : hashUuidToInt(input.runId);
    await takeAdvisoryXactLock(c, ADVISORY_LOCK.auditChain, lockKey);

    // One statement, two answers: the chain head, and proof that the lock taken
    // above is still held as we read it. Folding the check in here rather than
    // issuing it separately costs no extra round trip on a path that runs
    // thousands of times per run.
    const { rows } = await c.query<{ lock_held: boolean; entry_hash: string | null }>(
      `SELECT ${advisoryXactLockHeldSql(2, 3)} AS lock_held,
              (SELECT entry_hash FROM audit_log
                WHERE run_id IS NOT DISTINCT FROM $1
                ORDER BY sequence_no DESC
                LIMIT 1) AS entry_hash`,
      [input.runId, ADVISORY_LOCK.auditChain, lockKey],
    );
    if (!rows[0]!.lock_held) {
      throw new Error(
        'appendAuditEntry: the chain lock was not held when the head was read, which means ' +
        'this client is not inside a transaction — pg_advisory_xact_lock was released by the ' +
        'statement that took it. Wrap the call in withTransaction(), or pass the TxClient it ' +
        'yields. Appending unprotected would let two writers claim the same predecessor and ' +
        'make an untampered chain verify as broken.',
      );
    }
    const prevHash = rows[0]!.entry_hash ?? GENESIS_HASH;

    // The stored form is computed ONCE and both the hash and the column values come
    // out of it (issue #17). Writing the columns from anything else — a second
    // `JSON.stringify` of the caller's object, say — is what made an untampered
    // entry verify as `entry_altered`.
    const entry = toStoredForm({ ...input, occurredAt: input.occurredAt ?? new Date() });
    const entryHash = computeEntryHash(entry, prevHash);

    // The anchor moves in the SAME statement as the entry it describes (issue #18),
    // so there is no window in which the log is longer than its recorded head, and
    // no extra round trip. Both are already serialized by the advisory lock above.
    const inserted = await c.query<{ sequence_no: number; occurred_at: Date }>(
      `WITH inserted AS (
         INSERT INTO audit_log (
           run_id, event_type, subject_type, subject_id, transaction_id,
           actor_type, actor_id, tier, rule_id, rule_version, decision, confidence,
           before_state, after_state, reason, details, prev_hash, entry_hash, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING sequence_no, occurred_at
       ), anchor AS (
         INSERT INTO audit_chain_heads (run_id, entry_count, head_hash, head_sequence_no)
         VALUES ($1, 1, $18, (SELECT sequence_no FROM inserted))
         ON CONFLICT (run_id) DO UPDATE
           SET entry_count      = audit_chain_heads.entry_count + 1,
               head_hash        = EXCLUDED.head_hash,
               head_sequence_no = EXCLUDED.head_sequence_no,
               updated_at       = now()
       )
       SELECT sequence_no, occurred_at FROM inserted`,
      [
        entry.runId, entry.eventType, entry.subjectType, entry.subjectId, entry.transactionId,
        entry.actorType, entry.actorId, entry.tier, entry.ruleId, entry.ruleVersion,
        entry.decision, entry.confidence,
        // `canonicalJson`, never `JSON.stringify`: one serializer for the hash and
        // for the columns. `null` stays SQL NULL rather than becoming JSON null,
        // which keeps `before_state IS NULL` meaningful — both read back as JS
        // `null`, so the hash agrees either way.
        entry.beforeState === null ? null : canonicalJson(entry.beforeState),
        entry.afterState === null ? null : canonicalJson(entry.afterState),
        entry.reason,
        canonicalJson(entry.details),
        prevHash, entryHash,
        entry.occurredAt,
      ],
    );

    return {
      ...entry,
      sequenceNo: Number(inserted.rows[0]!.sequence_no),
      prevHash, entryHash,
    };
  };

  return client === undefined ? withTransaction(run) : run(client);
}

/**
 * Read one chain in order.
 *
 * `ORDER BY sequence_no` is not decoration: without it Postgres may return rows
 * in any order, and a chain verified out of order reports a break that is not
 * there (ADR-032).
 */
export async function readChain(runId: string | null): Promise<StoredAuditEntry[]> {
  const { rows } = await getPool().query(
    `SELECT sequence_no, run_id, event_type, subject_type, subject_id, transaction_id,
            actor_type, actor_id, tier, rule_id, rule_version, decision, confidence,
            before_state, after_state, reason, details, prev_hash, entry_hash, occurred_at
       FROM audit_log
      WHERE run_id IS NOT DISTINCT FROM $1
      ORDER BY sequence_no`,
    [runId],
  );
  return rows.map(toStored);
}

/** Every column a `StoredAuditEntry` needs, so the read paths cannot drift. */
const ENTRY_COLUMNS = `
  sequence_no, run_id, event_type, subject_type, subject_id, transaction_id,
  actor_type, actor_id, tier, rule_id, rule_version, decision, confidence,
  before_state, after_state, reason, details, prev_hash, entry_hash, occurred_at`;

/**
 * One record's trail (endpoint 13), newest LAST.
 *
 * `ORDER BY sequence_no` ascending, always: the trail is read chronologically,
 * and `sequence_no` is deterministic even for entries written inside the same
 * millisecond — which `occurred_at` is not, and several hundred of these are
 * written per run inside one transaction.
 *
 * `transaction_id` is denormalized onto `audit_log` precisely so this query does
 * not have to join or scan `details`.
 */
export async function readTransactionTrail(
  transactionId: string, limit: number, offset: number, client?: TxClient,
): Promise<{ entries: StoredAuditEntry[]; total: number }> {
  const pool = client ?? getPool();
  const [page, count] = await Promise.all([
    pool.query(
      `SELECT ${ENTRY_COLUMNS} FROM audit_log
        WHERE transaction_id = $1
        ORDER BY sequence_no
        LIMIT $2 OFFSET $3`,
      [transactionId, limit, offset]),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_log WHERE transaction_id = $1`, [transactionId]),
  ]);
  return { entries: page.rows.map(toStored), total: count.rows[0]!.count };
}

/** A whole run's trail (endpoint 14), optionally filtered by event or actor. */
export async function readRunTrail(
  runId: string,
  filter: { eventType?: string; actorType?: string },
  limit: number, offset: number,
): Promise<{ entries: StoredAuditEntry[]; total: number }> {
  const where = ['run_id = $1'];
  const params: unknown[] = [runId];
  if (filter.eventType !== undefined) {
    params.push(filter.eventType); where.push(`event_type = $${params.length}`);
  }
  if (filter.actorType !== undefined) {
    params.push(filter.actorType); where.push(`actor_type = $${params.length}`);
  }
  const predicate = where.join(' AND ');

  const pool = getPool();
  const [page, count] = await Promise.all([
    pool.query(
      `SELECT ${ENTRY_COLUMNS} FROM audit_log WHERE ${predicate}
        ORDER BY sequence_no LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_log WHERE ${predicate}`, params),
  ]);
  return { entries: page.rows.map(toStored), total: count.rows[0]!.count };
}

/**
 * One SUBJECT's trail — `get_audit_trail` (agent-design §4, U12).
 *
 * The engine's own account of why it did what it did, which is the thing that
 * stops the Analyst re-deriving a conclusion the engine already recorded. Served
 * by `ix_audit_subj (subject_type, subject_id, sequence_no)`.
 *
 * `readTransactionTrail` answers a different question — everything that happened
 * to a RECORD — and neither replaces the other: a match's or an exception's
 * entries carry `subject_id` of the match/exception, and its `transaction_id` is
 * only ever the one denormalized record.
 *
 * `ORDER BY sequence_no` ascending, always: chronological, and deterministic
 * even for entries written inside the same millisecond, which `occurred_at` is
 * not (several hundred are written per run inside one transaction).
 */
export async function readSubjectTrail(
  subjectType: string, subjectId: string, limit: number, client?: TxClient,
): Promise<StoredAuditEntry[]> {
  const { rows } = await (client ?? getPool()).query(
    `SELECT ${ENTRY_COLUMNS} FROM audit_log
      WHERE subject_type = $1 AND subject_id = $2
      ORDER BY sequence_no
      LIMIT $3`,
    [subjectType, subjectId, limit],
  );
  return rows.map(toStored);
}

/**
 * The chain's anchor, or null if it has never been written to.
 *
 * Read separately from the entries because it answers a different question: the
 * entries say whether what is present is consistent, the anchor says whether
 * anything is missing from the end (issue #18).
 */
export async function readChainAnchor(runId: string | null): Promise<ChainAnchor | null> {
  const { rows } = await getPool().query<{ entry_count: number; head_hash: string }>(
    `SELECT entry_count, head_hash FROM audit_chain_heads
      WHERE run_id IS NOT DISTINCT FROM $1`,
    [runId],
  );
  const row = rows[0];
  return row === undefined ? null : { entryCount: Number(row.entry_count), headHash: row.head_hash };
}

/** Endpoint 22. Read-only, safe at any time, fast enough to run live in a pitch. */
export async function verifyRunChain(runId: string | null): Promise<ChainVerification> {
  const [entries, anchor] = await Promise.all([readChain(runId), readChainAnchor(runId)]);
  return verifyChain(entries, anchor);
}

interface AuditRow {
  sequence_no: string | number;
  run_id: string | null;
  event_type: string; subject_type: string; subject_id: string;
  transaction_id: string | null;
  actor_type: string; actor_id: string;
  tier: string | null; rule_id: string | null; rule_version: string | null;
  decision: string | null; confidence: number | null;
  before_state: unknown; after_state: unknown;
  reason: string; details: unknown;
  prev_hash: string; entry_hash: string; occurred_at: Date;
}

function toStored(row: AuditRow): StoredAuditEntry {
  return {
    sequenceNo: Number(row.sequence_no),
    runId: row.run_id,
    eventType: row.event_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    transactionId: row.transaction_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    tier: row.tier,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    decision: row.decision,
    confidence: row.confidence,
    beforeState: row.before_state as never,
    afterState: row.after_state as never,
    reason: row.reason,
    details: row.details as never,
    occurredAt: row.occurred_at,
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
  };
}

/** UUID text -> a stable 32-bit int for the advisory lock key. Collisions only cost contention. */
function hashUuidToInt(uuid: string): number {
  let h = 0;
  for (let i = 0; i < uuid.length; i += 1) {
    h = (Math.imul(h, 31) + uuid.charCodeAt(i)) | 0;
  }
  return h;
}
