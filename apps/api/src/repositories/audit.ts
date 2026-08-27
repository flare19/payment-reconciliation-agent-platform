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
import {
  GENESIS_HASH, computeEntryHash, verifyChain,
  type ChainVerification, type HashableAuditEntry, type StoredAuditEntry,
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

    const entry: HashableAuditEntry = { ...input, occurredAt: input.occurredAt ?? new Date() };
    const entryHash = computeEntryHash(entry, prevHash);

    const inserted = await c.query<{ sequence_no: number; occurred_at: Date }>(
      `INSERT INTO audit_log (
         run_id, event_type, subject_type, subject_id, transaction_id,
         actor_type, actor_id, tier, rule_id, rule_version, decision, confidence,
         before_state, after_state, reason, details, prev_hash, entry_hash, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING sequence_no, occurred_at`,
      [
        entry.runId, entry.eventType, entry.subjectType, entry.subjectId, entry.transactionId,
        entry.actorType, entry.actorId, entry.tier, entry.ruleId, entry.ruleVersion,
        entry.decision, entry.confidence,
        entry.beforeState === undefined ? null : JSON.stringify(entry.beforeState),
        entry.afterState === undefined ? null : JSON.stringify(entry.afterState),
        entry.reason,
        JSON.stringify(entry.details ?? {}),
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

/** Endpoint 22. Read-only, safe at any time, fast enough to run live in a pitch. */
export async function verifyRunChain(runId: string | null): Promise<ChainVerification> {
  return verifyChain(await readChain(runId));
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
