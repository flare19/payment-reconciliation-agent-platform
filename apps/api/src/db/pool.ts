import pg from 'pg';
import type { Env } from '../config/env.js';

/**
 * BIGINT HAZARD — read before touching this file.
 *
 * `pg` returns int8 (BIGINT) as a STRING by default, to avoid silent precision
 * loss above 2^53. Every money column in this schema is BIGINT paise (ADR-006),
 * so without an override `row.amount_paise` is a string and `a + b` silently
 * concatenates: 100 + 250 becomes "100250". That is exactly the class of bug
 * that would surface as a mysteriously wrong match rate rather than a crash.
 *
 * We parse int8 to Number and assert it is inside the safe-integer range.
 * ₹10 crore is 10^11 paise; Number.MAX_SAFE_INTEGER is ~9×10^15, so there are
 * four orders of magnitude of headroom. If the assertion ever fires, the fix is
 * a real decision (bigint or a decimal type), not a widened guard.
 */
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `BIGINT ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be represented ` +
      `without precision loss. See the note in src/db/pool.ts.`,
    );
  }
  return n;
});

/**
 * NUMERIC (confidence, cost) also arrives as a string, for the same reason.
 * These columns are small and bounded — NUMERIC(5,4) and NUMERIC(8,4) — so
 * Number is exact for every value they can hold.
 */
const NUMERIC_OID = 1700;
pg.types.setTypeParser(NUMERIC_OID, (value: string) => Number(value));

/**
 * DATE must stay a `YYYY-MM-DD` STRING, not a JS Date.
 *
 * The default parser builds a Date at local midnight, which shifts the calendar
 * day for anyone running outside UTC — and every date comparison in the matching
 * engine is a BUSINESS-DAY operation on an IST date (schema.md §0). Turning a
 * business date into an instant is how you get a one-day error that only
 * reproduces on someone else's laptop.
 */
const DATE_OID = 1082;
pg.types.setTypeParser(DATE_OID, (value: string) => value);

let pool: pg.Pool | null = null;

export function createPool(env: Env): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: env.databaseUrl,
    // Railway's managed Postgres requires TLS but presents a cert chain Node
    // won't verify by default. Local dev has no TLS at all.
    ssl: env.databaseUrl.includes('localhost') || env.databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    console.error('[db] idle client error', err.message);
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Pool not initialised. Call createPool(env) at boot.');
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

/**
 * ADVISORY LOCKS — read this before adding a third one.
 *
 * This codebase has now shipped the same bug twice, in two different files:
 * a Postgres advisory lock acquired on a connection that is not the one holding
 * the critical section, so the lock is released before the work it guards runs.
 *
 *  1. `db/migrate.ts` (unit 1) — `pg_advisory_lock` is SESSION-scoped and was
 *     taken on a `Pool`, which hands out a different connection per query.
 *  2. `repositories/audit.ts` (unit 9) — `pg_advisory_xact_lock` is
 *     TRANSACTION-scoped and was taken on a caller-supplied client that need not
 *     be inside a transaction. In autocommit each statement is its own
 *     transaction, so the lock died with the statement that took it.
 *
 * Both were invisible: the lock call succeeds, nothing errors, and the guarantee
 * is simply absent. The structural answers below make the third occurrence
 * harder rather than relying on the next reader noticing.
 */

/**
 * A client KNOWN to be inside an explicit transaction.
 *
 * The brand is unforgeable outside this module and `withTransaction` is its only
 * producer, so `pg_advisory_xact_lock` cannot be handed a client whose
 * transaction does not exist. A bare `getPool().connect()` no longer typechecks
 * where a `TxClient` is required — which is the compile-time half of the fix for
 * occurrence 2 above.
 */
declare const inTransaction: unique symbol;
export type TxClient = pg.PoolClient & { readonly [inTransaction]: true };

/** Every advisory-lock namespace in the system, so a new one is added next to its neighbours. */
export const ADVISORY_LOCK = {
  /** Session-scoped: spans the migration runner's several transactions. */
  migrations: 8_241_066,
  /** Transaction-scoped, keyed per chain: serializes `audit_log` appends. */
  auditChain: 8_241_067,
} as const;

/**
 * The single place a transaction-scoped advisory lock is taken.
 *
 * Requiring a `TxClient` is the whole point: there is no signature here that
 * accepts a `Pool` or a bare `PoolClient`, so the lock cannot be taken somewhere
 * it will not survive.
 */
export async function takeAdvisoryXactLock(
  client: TxClient, namespace: number, key: number,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [namespace, key]);
}

/**
 * A SQL predicate — true when (namespace, key) is STILL held by this backend.
 *
 * The runtime half of the fix, and the reason it is a fragment rather than its
 * own query: embedded in the NEXT statement of the same transaction it costs
 * nothing, and it tests the exact property that failed rather than a proxy for
 * it. If the lock did not survive to the statement that reads the chain head,
 * the lock protected nothing and the append must not proceed.
 *
 * `::int4::oid` because `pg_locks` stores the two int4 keys as oids, and lock
 * keys here are signed (`hashUuidToInt` returns a signed 32-bit int).
 */
export function advisoryXactLockHeldSql(namespaceParam: number, keyParam: number): string {
  return `EXISTS (
    SELECT 1 FROM pg_locks
     WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
       AND classid = $${namespaceParam}::int4::oid
       AND objid   = $${keyParam}::int4::oid
       AND objsubid = 2)`;
}

/**
 * Run a function inside a transaction. Used by every multi-write operation —
 * alias supersession, match approval, investigation persistence.
 *
 * The only producer of a `TxClient`: the brand is applied here, immediately
 * after `BEGIN` succeeds, and it is what lets `takeAdvisoryXactLock` trust its
 * argument.
 */
export async function withTransaction<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client as TxClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
