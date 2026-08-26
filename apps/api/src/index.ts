import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { closePool, createPool, getPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';

const env = loadEnv();
createPool(env);

if (env.runMigrationsOnBoot) {
  const { applied } = await runMigrations(getPool());
  if (applied.length > 0) console.log(`[boot] applied ${applied.length} migration(s)`);
}

// TODO(day5+): reap interrupted runs (ADR-046). Any run in a non-terminal state
// older than STALE_RUN_TIMEOUT_MINUTES becomes `failed` with
// error_detail = 'interrupted by restart'. Without this a crashed run sits at
// `matching` forever and the dashboard polls it indefinitely — a failure mode
// that only shows up in front of an audience, because only then does anything restart.
//   await reapStaleRuns(env.staleRunTimeoutMinutes);

const server = createApp(env).listen(env.port, () => {
  console.log(`[boot] api listening on :${env.port} (${env.nodeEnv})`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => { void closePool().then(() => process.exit(0)); });
  });
}
