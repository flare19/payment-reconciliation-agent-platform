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
 * Run a function inside a transaction. Used by every multi-write operation —
 * alias supersession, match approval, investigation persistence.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
