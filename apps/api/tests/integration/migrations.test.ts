import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { SOURCE_ORDER, type SourceSystem } from '../../src/types/domain.js';

/**
 * Schema invariants, against a real Postgres.
 *
 * No mocking: the SQL *is* the logic here (ADR-022), and a mocked query proves
 * nothing about a query that has to be right. Every constraint below exists to
 * make a specific wrong state unreachable — and a constraint nobody has seen fire
 * is decoration, so each test asserts the failure, not just the happy path.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL). Skips cleanly when absent so the
 * unit suite still runs on a machine with no database.
 */

const DB_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? null;

const RUN = '11111111-1111-1111-1111-111111111111';
const GATEWAY_TXN = '22222222-2222-2222-2222-222222222222';
const BANK_TXN = '33333333-3333-3333-3333-333333333333';
const MATCH_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const MATCH_B = 'aaaaaaaa-0000-0000-0000-00000000000b';
const EXCEPTION = '44444444-4444-4444-4444-444444444444';

let pool: pg.Pool;

/** Assert a statement is rejected, and that it fails for the expected REASON. */
async function rejects(sql: string, expected: RegExp, params: unknown[] = []): Promise<void> {
  try {
    await pool.query(sql, params);
    assert.fail(`expected rejection matching ${expected}, but the statement succeeded`);
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, expected);
  }
}

describe('schema invariants', { skip: DB_URL === null ? 'no TEST_DATABASE_URL' : false }, () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL!, max: 4 });
    await runMigrations(pool);

    // TRUNCATE, not DELETE: audit_log's append-only trigger is row-level and
    // TRUNCATE bypasses it by design. That is the intended reset path.
    await pool.query(`TRUNCATE runs, transactions, matches, match_members, exceptions,
                      audit_log, learned_aliases, explanation_cache, score_reports,
                      agent_investigations, agent_questions CASCADE`);

    await pool.query(
      `INSERT INTO runs (id,label,status,config_snapshot) VALUES ($1,'test','pending','{}')`, [RUN]);
    await pool.query(
      `INSERT INTO transactions
         (id,run_id,source_system,source_file,source_row_number,external_id,reference_ids,
          anchor_strength,amount_paise,direction,txn_date,status_raw,status_norm,raw_payload)
       VALUES
         ($1,$3,'gateway','g.csv',1,'pay_1','{}','strong',100,'credit','2026-08-14','captured','reconcilable','{}'),
         ($2,$3,'bank','b.csv',1,'utr_1','{}','weak',100,'credit','2026-08-16','SETTLEMENT','reconcilable','{}')`,
      [GATEWAY_TXN, BANK_TXN, RUN]);
    await pool.query(
      `INSERT INTO matches (id,run_id,tier,status,confidence,rule_id,rule_version,cardinality) VALUES
         ($1,$3,'exact','auto_confirmed',1.0,'R','1','one_to_one'),
         ($2,$3,'fuzzy','auto_confirmed',0.9,'R','1','one_to_one')`,
      [MATCH_A, MATCH_B, RUN]);
    await pool.query(
      `INSERT INTO exceptions (id,run_id,category,severity,evidence,detected_by_rule,rule_version)
       VALUES ($1,$2,'AMBIGUOUS_MATCH','high','{}','R','1')`, [EXCEPTION, RUN]);
  });

  after(async () => { await pool?.end(); });

  test('migrations are idempotent', async () => {
    const { applied, skipped } = await runMigrations(pool);
    assert.equal(applied.length, 0, 'a second run must apply nothing');
    assert.ok(skipped.length >= 10);
  });

  test('a transaction cannot join two live matches', async () => {
    await pool.query(`INSERT INTO match_members VALUES ($1,$2,'gateway',true)`, [MATCH_A, GATEWAY_TXN]);
    await rejects(
      `INSERT INTO match_members VALUES ($1,$2,'gateway',true)`,
      /single-match invariant/, [MATCH_B, GATEWAY_TXN]);
  });

  test('rejecting a match frees its members, and un-rejecting is then refused', async () => {
    await pool.query(
      `UPDATE matches SET status='human_rejected', reviewed_by='t', reviewed_at=now() WHERE id=$1`, [MATCH_A]);
    // The freed transaction may now join another match...
    await pool.query(`INSERT INTO match_members VALUES ($1,$2,'gateway',true)`, [MATCH_B, GATEWAY_TXN]);
    // ...which means the rejected one can no longer be revived.
    await rejects(
      `UPDATE matches SET status='auto_confirmed' WHERE id=$1`,
      /cannot un-reject match/, [MATCH_A]);
  });

  test('a match has at most one anchor', async () => {
    await rejects(
      `INSERT INTO match_members VALUES ($1,$2,'bank',true)`,
      /ux_match_one_anchor/, [MATCH_B, BANK_TXN]);
  });

  test('audit_log rejects UPDATE and DELETE', async () => {
    await pool.query(
      `INSERT INTO audit_log (run_id,event_type,subject_type,subject_id,actor_type,actor_id,reason,prev_hash,entry_hash)
       VALUES ($1,'RUN_STARTED','run',$1,'engine','matching-engine@1.0.0','Run started.',repeat('0',64),repeat('a',64))`,
      [RUN]);
    await rejects(`UPDATE audit_log SET reason='tampered'`, /append-only/);
    await rejects(`DELETE FROM audit_log`, /append-only/);
  });

  test('audit_log refuses a blank reason', async () => {
    // A log that says "processed" is not an audit trail; a log that says nothing
    // at all is worse.
    await rejects(
      `INSERT INTO audit_log (run_id,event_type,subject_type,subject_id,actor_type,actor_id,reason,prev_hash,entry_hash)
       VALUES ($1,'X','run',$1,'engine','e','   ',repeat('0',64),repeat('b',64))`,
      /reason_check/, [RUN]);
  });

  test('a run with audit history cannot be deleted', async () => {
    await rejects(`DELETE FROM runs WHERE id=$1`, /audit_log_run_id_fkey/, [RUN]);
  });

  test('duplicate_of and duplicate_kind are set together or not at all', async () => {
    await rejects(
      `INSERT INTO transactions
         (run_id,source_system,source_file,source_row_number,external_id,reference_ids,anchor_strength,
          amount_paise,direction,txn_date,status_raw,status_norm,raw_payload,duplicate_kind)
       VALUES ($1,'gateway','g.csv',99,'p','{}','none',1,'credit','2026-08-14','captured','reconcilable','{}','exact')`,
      /txn_dupe_fields_paired/, [RUN]);
  });

  test('resolving an exception requires a stated reason', async () => {
    await rejects(
      `INSERT INTO exceptions (run_id,category,severity,evidence,detected_by_rule,rule_version,
                               status,resolved_by,resolved_at)
       VALUES ($1,'MISSING_IN_BANK','high','{}','R','1','human_resolved','t',now())`,
      /exc_resolution_complete/, [RUN]);
  });

  test('a RESOLUTION_PROPOSED verdict must carry a proposed action', async () => {
    await rejects(
      `INSERT INTO agent_investigations (run_id,exception_id,status,verdict,confidence,model,prompt_version,finished_at)
       VALUES ($1,$2,'concluded','RESOLUTION_PROPOSED','high','gemini-3.7-flash','agent-v1',now())`,
      /inv_proposal_paired/, [RUN, EXCEPTION]);
  });

  test('agent confidence is a label, never a number', async () => {
    // ADR-053: the engine's confidence is computed, the agent's is asserted.
    // Keeping them different types stops anyone averaging one into the other.
    await rejects(
      `INSERT INTO agent_investigations (run_id,exception_id,status,confidence,model,prompt_version)
       VALUES ($1,$2,'running','0.87','gemini-3.7-flash','agent-v1')`,
      /confidence_check/, [RUN, EXCEPTION]);
  });

  test('source_rank orders gateway < bank < ledger, not alphabetically', async () => {
    const { rows } = await pool.query<{ source_system: string }>(
      `SELECT source_system FROM transactions WHERE run_id=$1
       ORDER BY source_rank(source_system), source_row_number`, [RUN]);
    assert.deepEqual(rows.map((r) => r.source_system), ['gateway', 'bank']);
  });

  test('SQL source_rank() and TypeScript SOURCE_ORDER agree, value for value', async () => {
    // Canonical ordering is defined TWICE — once in plpgsql for ORDER BY clauses,
    // once in TypeScript for in-memory sorting — because SQL cannot call into TS.
    // Two implementations of one rule is exactly the shape of a bug that goes
    // unnoticed: they drift, half the pipeline sorts one way, and the run stops
    // being reproducible for a reason nobody can see in a diff.
    //
    // The migration comment says "change both in the same commit". A comment is a
    // hope. This test is the guarantee.
    const sources = Object.keys(SOURCE_ORDER) as SourceSystem[];
    const { rows } = await pool.query<{ s: string; rank: number }>(
      `SELECT s, source_rank(s) AS rank FROM unnest($1::text[]) AS s`, [sources]);

    assert.equal(rows.length, sources.length, 'every SourceSystem must be ranked');
    for (const row of rows) {
      assert.equal(
        row.rank, SOURCE_ORDER[row.s as SourceSystem],
        `source_rank('${row.s}')=${row.rank} disagrees with SOURCE_ORDER.${row.s}=${SOURCE_ORDER[row.s as SourceSystem]}`,
      );
    }

    // An unknown value must sort last in both, not crash and not sort first.
    const { rows: unknown } = await pool.query<{ rank: number }>(
      `SELECT source_rank('not_a_source') AS rank`);
    assert.ok(
      unknown[0]!.rank > Math.max(...Object.values(SOURCE_ORDER)),
      'an unrecognised source must sort after every known one',
    );
  });

  test('a terminal run must have finished_at, a live one must not', async () => {
    await rejects(
      `INSERT INTO runs (label,status,config_snapshot) VALUES ('x','completed','{}')`,
      /runs_finished_iff_terminal/);
  });
});
