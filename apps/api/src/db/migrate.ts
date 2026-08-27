import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Forward-only numbered migrations (ADR-022).
 *
 * A bad migration is fixed by a NEW migration, never by editing a shipped one —
 * editing one leaves every environment that already ran it in a different state
 * from every environment that hasn't, with nothing recording the divergence.
 * The checksum below turns that from a silent problem into a startup failure.
 *
 * Concurrency: safe under `RUN_MIGRATIONS_ON_BOOT=true` because there is exactly
 * one API instance and no rolling deploy (deployment.md §5.3). The advisory lock
 * makes that assumption explicit rather than merely true-for-now.
 */

const MIGRATION_LOCK_ID = 8_241_066;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
}

async function checksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function runMigrations(target: pg.PoolClient | pg.Pool): Promise<MigrationResult> {
  // A Pool hands out a DIFFERENT connection per query, and `pg_advisory_lock` is
  // SESSION-scoped — so locking on a pool would take the lock on one connection
  // and run the migrations on others, protecting nothing. Pin one client for the
  // whole operation.
  const pooled = typeof (target as pg.Pool).connect === 'function';
  const client = pooled
    ? await (target as pg.Pool).connect()
    : (target as pg.PoolClient);

  try {
    return await runOnClient(client);
  } finally {
    if (pooled) (client as pg.PoolClient).release();
  }
}

async function runOnClient(client: pg.PoolClient): Promise<MigrationResult> {
  // The lock is taken FIRST, before any DDL. `CREATE TABLE IF NOT EXISTS` is not
  // atomic in Postgres: two sessions running it concurrently can both pass the
  // existence check and then collide on `pg_type_typname_nsp_index`. Creating the
  // bookkeeping table before acquiring the lock left exactly that race, which only
  // showed up once two test files began migrating the same database in parallel.
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    CHAR(64) NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(migrationsDir()))
      .filter((f) => f.endsWith('.sql'))
      // Zero-padded NNN_ prefix, so lexical order IS numeric order.
      .sort();

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations ORDER BY filename',
    );
    const already = new Map(rows.map((r) => [r.filename, r.checksum]));

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const sql = await readFile(join(migrationsDir(), file), 'utf8');
      const sum = await checksum(sql);
      const prior = already.get(file);

      if (prior !== undefined) {
        if (prior !== sum) {
          throw new Error(
            `Migration ${file} has changed since it was applied ` +
            `(recorded ${prior.slice(0, 12)}…, now ${sum.slice(0, 12)}…). ` +
            `Migrations are forward-only: add a new migration instead of editing this one.`,
          );
        }
        skipped.push(file);
        continue;
      }

      // Each migration runs in its own transaction: a failure leaves the database
      // at the last complete migration rather than half-way through a broken one.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [file, sum],
        );
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
  }
}
