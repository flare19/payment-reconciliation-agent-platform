import { loadEnv } from '../config/env.js';
import { closePool, createPool } from './pool.js';
import { runMigrations } from './migrate.js';

const env = loadEnv();
const pool = createPool(env);
try {
  const { applied, skipped } = await runMigrations(pool);
  console.log(`[migrate] applied ${applied.length}, already current ${skipped.length}`);
  for (const f of applied) console.log(`  + ${f}`);
} catch (err) {
  console.error(`[migrate] FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
