/**
 * ALL SQL for `score_reports` lives here and nowhere else (CLAUDE.md §4.1).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THIS TABLE IS THE ONLY PLACE GROUND-TRUTH-DERIVED NUMBERS LIVE (ADR-041).
 *
 * `runs.metrics` is the engine's account of ITSELF. This is a MEASUREMENT taken
 * against `data/truth/`. Merging them would make the headline number
 * unfalsifiable — you could no longer tell which figures the engine asserted and
 * which were checked against an answer key it never saw.
 *
 * Nothing under `apps/api/src` may read `data/truth/` (ADR-021, guarded by
 * `tests/unit/truth-leak-guard.test.ts`). This file stores what `tools/score`
 * computed OFFLINE and POSTs to endpoint 23; it never computes a score itself.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { getPool, type TxClient } from '../db/pool.js';

export interface ScoreReport {
  id: string;
  runId: string;
  truthKeyFile: string;
  truthKeyHash: string;
  scorerVersion: string;
  scoredAt: Date;
  report: Record<string, unknown>;
}

const COLUMNS = `id, run_id, truth_key_file, truth_key_hash, scorer_version, scored_at, report`;

interface ReportRow {
  id: string;
  run_id: string;
  truth_key_file: string;
  truth_key_hash: string;
  scorer_version: string;
  scored_at: Date;
  report: Record<string, unknown>;
}

function toReport(r: ReportRow): ScoreReport {
  return {
    id: r.id,
    runId: r.run_id,
    truthKeyFile: r.truth_key_file,
    truthKeyHash: r.truth_key_hash,
    scorerVersion: r.scorer_version,
    scoredAt: r.scored_at,
    report: r.report,
  };
}

export interface InsertScoreReportInput {
  runId: string;
  truthKeyFile: string;
  truthKeyHash: string;
  scorerVersion: string;
  report: Record<string, unknown>;
}

/**
 * Store a measurement.
 *
 * The caller must already have checked `truthKeyHash` against the run's
 * `input_file_hashes` and returned `422 TRUTH_KEY_MISMATCH` if they disagree
 * (api-contract §23). That check is a ROUTE concern rather than a constraint
 * here because it compares two tables and needs to produce a specific error
 * code — but it is not optional: scoring a run against a key built from
 * different bytes should be impossible, not something noticed late.
 *
 * `ON CONFLICT DO NOTHING` on (run_id, scorer_version, truth_key_hash): the same
 * scorer, on the same key, against the same run is the SAME measurement. Letting
 * a re-POST overwrite would allow a number to be quietly replaced after it was
 * read, which is the one thing a measurement table must not permit. `null` back
 * means the report already existed.
 */
export async function insertScoreReport(
  input: InsertScoreReportInput, client?: TxClient,
): Promise<ScoreReport | null> {
  const { rows } = await (client ?? getPool()).query<ReportRow>(
    `INSERT INTO score_reports (run_id, truth_key_file, truth_key_hash, scorer_version, report)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (run_id, scorer_version, truth_key_hash) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.runId, input.truthKeyFile, input.truthKeyHash, input.scorerVersion,
      JSON.stringify(input.report),
    ],
  );
  return rows.length === 0 ? null : toReport(rows[0]!);
}

/** The most recent measurement for a run, or null if it has never been scored. */
export async function latestScoreReport(runId: string): Promise<ScoreReport | null> {
  const { rows } = await getPool().query<ReportRow>(
    `SELECT ${COLUMNS} FROM score_reports
      WHERE run_id = $1
      ORDER BY scored_at DESC, id DESC
      LIMIT 1`,
    [runId],
  );
  return rows.length === 0 ? null : toReport(rows[0]!);
}

/**
 * Every measurement for a run, oldest first.
 *
 * Plural on purpose: a run can be scored by more than one scorer version, and
 * seeing the sequence is how you tell "the engine improved" from "the scorer
 * changed". Collapsing to the latest would hide exactly that distinction.
 */
export async function listScoreReports(runId: string): Promise<ScoreReport[]> {
  const { rows } = await getPool().query<ReportRow>(
    `SELECT ${COLUMNS} FROM score_reports
      WHERE run_id = $1
      ORDER BY scored_at, id`,
    [runId],
  );
  return rows.map(toReport);
}

export async function findScoreReport(id: string): Promise<ScoreReport | null> {
  const { rows } = await getPool().query<ReportRow>(
    `SELECT ${COLUMNS} FROM score_reports WHERE id = $1`, [id]);
  return rows.length === 0 ? null : toReport(rows[0]!);
}
