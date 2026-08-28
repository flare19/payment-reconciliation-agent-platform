/**
 * ALL SQL for `runs` lives here and nowhere else (CLAUDE.md §4.1).
 *
 * `runs` is the spine: every other table cascades from it, and three of its
 * columns are what make a result reproducible by a sceptic rather than merely
 * asserted — `config_snapshot` (how the engine was configured),
 * `input_file_hashes` (what it ran against) and `reference_date` (ADR-039, the
 * dataset-derived "today" every overdue test reads instead of the wall clock).
 *
 * Two CHECK constraints make illegal states unrepresentable, and this file must
 * not work around either:
 *   `runs_finished_iff_terminal` — a terminal run has a `finished_at`, a live
 *     one does not. So `finish()` sets status and timestamp together.
 *   `runs_error_iff_failed`      — only a failed run carries `error_detail`.
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { getPool, type TxClient } from '../db/pool.js';
import type { BusinessDate, RunStatus } from '../types/domain.js';
import type { RejectedRow, RunConfig } from '../types/engine.js';

export interface RunRecordCounts {
  gateway: number;
  bank: number;
  ledger: number;
  excluded: number;
  rejected: number;
}

export interface Run {
  id: string;
  label: string;
  datasetSeed: number | null;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  referenceDate: BusinessDate | null;
  recordCounts: Partial<RunRecordCounts>;
  rejectedRowCount: number;
  rejectedRows: RejectedRow[];
  inputFileHashes: Record<string, string>;
  configSnapshot: RunConfig;
  metrics: Record<string, unknown> | null;
  errorDetail: string | null;
}

/** Every column, in one place, so the four read paths cannot drift apart. */
const COLUMNS = `
  id, label, dataset_seed, status, started_at, finished_at, reference_date,
  record_counts, rejected_row_count, rejected_rows, input_file_hashes,
  config_snapshot, metrics, error_detail`;

interface RunRow {
  id: string;
  label: string;
  dataset_seed: number | null;
  status: RunStatus;
  started_at: Date;
  finished_at: Date | null;
  reference_date: string | null;
  record_counts: Partial<RunRecordCounts>;
  rejected_row_count: number;
  rejected_rows: RejectedRow[];
  input_file_hashes: Record<string, string>;
  config_snapshot: RunConfig;
  metrics: Record<string, unknown> | null;
  error_detail: string | null;
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    label: r.label,
    datasetSeed: r.dataset_seed,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    referenceDate: r.reference_date,
    recordCounts: r.record_counts,
    rejectedRowCount: r.rejected_row_count,
    rejectedRows: r.rejected_rows,
    inputFileHashes: r.input_file_hashes,
    configSnapshot: r.config_snapshot,
    metrics: r.metrics,
    errorDetail: r.error_detail,
  };
}

export interface CreateRunInput {
  label: string;
  datasetSeed?: number | null;
  configSnapshot: RunConfig;
  inputFileHashes?: Record<string, string>;
}

export async function createRun(input: CreateRunInput, client?: TxClient): Promise<Run> {
  const q = client ?? getPool();
  const { rows } = await q.query<RunRow>(
    `INSERT INTO runs (label, dataset_seed, status, config_snapshot, input_file_hashes)
     VALUES ($1, $2, 'pending', $3, $4)
     RETURNING ${COLUMNS}`,
    [
      input.label,
      input.datasetSeed ?? null,
      JSON.stringify(input.configSnapshot),
      JSON.stringify(input.inputFileHashes ?? {}),
    ],
  );
  return toRun(rows[0]!);
}

export async function findRun(runId: string): Promise<Run | null> {
  const { rows } = await getPool().query<RunRow>(
    `SELECT ${COLUMNS} FROM runs WHERE id = $1`, [runId]);
  return rows.length === 0 ? null : toRun(rows[0]!);
}

/**
 * Run history for the dashboard's picker (endpoint 3).
 *
 * `ORDER BY started_at DESC, id DESC`: the timestamp alone is not a total order
 * — two runs started in the same millisecond would paginate non-deterministically
 * and a row could appear on two pages or none (ADR-032).
 */
export async function listRuns(
  limit: number, offset: number,
): Promise<{ runs: Run[]; total: number }> {
  const pool = getPool();
  const [page, count] = await Promise.all([
    pool.query<RunRow>(
      `SELECT ${COLUMNS} FROM runs ORDER BY started_at DESC, id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]),
    pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM runs`),
  ]);
  return { runs: page.rows.map(toRun), total: count.rows[0]!.count };
}

/**
 * Advance a live run's status. Terminal states go through `finishRun` instead,
 * because `runs_finished_iff_terminal` requires the timestamp in the same write.
 */
export async function setRunStatus(
  runId: string, status: Exclude<RunStatus, 'completed' | 'failed'>, client?: TxClient,
): Promise<void> {
  await (client ?? getPool()).query(
    `UPDATE runs SET status = $2 WHERE id = $1`, [runId, status]);
}

/** Ingestion's output: the ADR-039 reference date, the population counts, rejected rows. */
export async function recordIngestion(
  runId: string,
  input: {
    referenceDate: BusinessDate | null;
    recordCounts: RunRecordCounts;
    rejectedRows: RejectedRow[];
    inputFileHashes: Record<string, string>;
  },
  client?: TxClient,
): Promise<void> {
  await (client ?? getPool()).query(
    `UPDATE runs
        SET reference_date     = $2,
            record_counts      = $3,
            rejected_rows      = $4,
            rejected_row_count = $5,
            input_file_hashes  = $6
      WHERE id = $1`,
    [
      runId, input.referenceDate, JSON.stringify(input.recordCounts),
      JSON.stringify(input.rejectedRows), input.rejectedRows.length,
      JSON.stringify(input.inputFileHashes),
    ],
  );
}

/**
 * S14's engine-computed metrics.
 *
 * ENGINE-COMPUTED ONLY (ADR-041). Anything derived from `data/truth/` belongs in
 * `score_reports` — one table is the engine's account of itself, the other is a
 * measurement, and merging them would make the headline number unfalsifiable.
 */
export async function setRunMetrics(
  runId: string, metrics: Record<string, unknown>, client?: TxClient,
): Promise<void> {
  await (client ?? getPool()).query(
    `UPDATE runs SET metrics = $2 WHERE id = $1`, [runId, JSON.stringify(metrics)]);
}

/** Terminal transition. Status, `finished_at` and `error_detail` move together. */
export async function finishRun(
  runId: string, outcome: { status: 'completed' } | { status: 'failed'; errorDetail: string },
  client?: TxClient,
): Promise<Run | null> {
  const { rows } = await (client ?? getPool()).query<RunRow>(
    `UPDATE runs
        SET status = $2, finished_at = now(), error_detail = $3
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [runId, outcome.status, outcome.status === 'failed' ? outcome.errorDetail : null],
  );
  return rows.length === 0 ? null : toRun(rows[0]!);
}

/**
 * The boot reaper (ADR-046): a run left non-terminal by a crash.
 *
 * Without this a crashed run sits at `matching` forever and the dashboard polls
 * it indefinitely — a failure that surfaces during a live demo rather than
 * during development, because only then does anything restart mid-run.
 */
export async function reapInterruptedRuns(olderThanMinutes = 5): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `UPDATE runs
        SET status = 'failed', finished_at = now(), error_detail = 'interrupted by restart'
      WHERE status NOT IN ('completed', 'failed')
        AND started_at < now() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(olderThanMinutes)],
  );
  return rows.map((r) => r.id);
}
