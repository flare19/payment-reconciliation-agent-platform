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

export async function runMigrations(client: pg.PoolClient | pg.Pool): Promise<MigrationResult> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    CHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
  try {
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
