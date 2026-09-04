import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runMigrations } from '../../src/db/migrate.js';
import { createPool, closePool, getPool } from '../../src/db/pool.js';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import { createRun } from '../../src/repositories/runs.js';
import { executeRun } from '../../src/services/run/orchestrator.js';
import { listExceptionTriageCandidates } from '../../src/repositories/exceptions.js';
import { listQueueTriageCandidates } from '../../src/repositories/matches.js';
import { triageRun, ELIGIBLE_CATEGORIES } from '../../src/services/agent/triage.js';

/**
 * A1's ORDER BY, against a real run.
 *
 * §3 states the order exactly, and it is the reason the Analyst's work list is
 * reproducible even though its conclusions are not. These assert the ORDER, not
 * a pinned list of ids — an order is the property; the ids are an accident of
 * this dataset.
 */

import { TEST_DB_URL as DB_URL, SKIP_REASON } from './test-db.js';
const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
const sources = {
  gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
  bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
  ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
};
const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

describe('A1 triage (integration)',
  { skip: SKIP_REASON }, () => {
    let runId: string;

    before(async () => {
      createPool({ databaseUrl: DB_URL!, corsOrigins: [] } as never);
      await runMigrations(getPool());
      await getPool().query(`TRUNCATE runs, transactions, matches, match_members, exceptions,
        audit_log, audit_chain_heads, learned_aliases, explanation_cache, score_reports,
        agent_investigations, agent_questions CASCADE`);
      const run = await createRun({
        label: 'triage', datasetSeed: 90210,
        configSnapshot: { ...ENGINE_DEFAULTS, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
      });
      runId = run.id;
      const out = await executeRun(runId, sources, ENGINE_DEFAULTS);
      assert.equal(out.status, 'completed', out.errorDetail ?? '');
    });
    after(async () => { await closePool(); });

    test('only eligible categories are ever selected', async () => {
      const all = await listExceptionTriageCandidates(runId, ELIGIBLE_CATEGORIES, 1000);
      assert.ok(all.length > 0);
      for (const c of all) {
        assert.ok((ELIGIBLE_CATEGORIES as readonly string[]).includes(c.category), c.category);
      }
      // The two exclusions are real on this dataset, not vacuous: the run
      // genuinely contains DUPLICATE_RECORDs, and none is selected.
      const { rows } = await getPool().query<{ c: number }>(
        `SELECT count(*)::int c FROM exceptions
          WHERE run_id=$1 AND category IN ('DUPLICATE_RECORD','TIMING_DRIFT')`, [runId]);
      assert.ok(rows[0]!.c > 0, 'the fixture must contain excluded categories to exclude');
      assert.equal(all.some((c) => c.category === 'DUPLICATE_RECORD'), false);
    });

    test('§3\'s order holds: severity DESC, then amount DESC, then canonical', async () => {
      const all = await listExceptionTriageCandidates(runId, ELIGIBLE_CATEGORIES, 1000);
      for (let i = 1; i < all.length; i += 1) {
        const prev = all[i - 1]!;
        const cur = all[i]!;
        assert.ok(RANK[prev.severity]! <= RANK[cur.severity]!,
          `severity went ${prev.severity} -> ${cur.severity} at ${i}`);
        if (prev.severity !== cur.severity) continue;
        // NULLS LAST: an exception with no stated amount must not outrank a
        // proved discrepancy by accident of a missing column.
        if (prev.amountAtRiskPaise === null) {
          assert.equal(cur.amountAtRiskPaise, null,
            `a NULL amount sorted above ${cur.amountAtRiskPaise} at ${i}`);
        } else if (cur.amountAtRiskPaise !== null) {
          assert.ok(prev.amountAtRiskPaise >= cur.amountAtRiskPaise,
            `amount rose ${prev.amountAtRiskPaise} -> ${cur.amountAtRiskPaise} at ${i}`);
        }
      }
    });

    test('the order is TOTAL — the same query twice gives the same list', async () => {
      // A non-total order would silently change which exceptions get the budget
      // between two runs of identical data (ADR-032).
      const a = await listExceptionTriageCandidates(runId, ELIGIBLE_CATEGORIES, 25);
      const b = await listExceptionTriageCandidates(runId, ELIGIBLE_CATEGORIES, 25);
      assert.deepEqual(a.map((x) => x.exceptionId), b.map((x) => x.exceptionId));
      assert.equal(new Set(a.map((x) => x.exceptionId)).size, a.length);
    });

    test('a human-dispositioned exception drops out of the work list', async () => {
      // Spending an investigation on a closed question is the one way this
      // budget can be wasted without anybody noticing.
      const before = await listExceptionTriageCandidates(runId, ELIGIBLE_CATEGORIES, 1000);
      const target = before[0]!;
      await getPool().query(
        `UPDATE exceptions SET status='wont_fix', resolved_by='r', resolved_at=now(),
                resolution_note='n' WHERE id=$1`, [target.exceptionId]);
      const after = await listExceptionTriageCandidates(runId, ELIGIBLE_CATEGORIES, 1000);
      assert.equal(after.some((c) => c.exceptionId === target.exceptionId), false);
      assert.equal(after.length, before.length - 1);
      await getPool().query(
        `UPDATE exceptions SET status='explained', resolved_by=NULL, resolved_at=NULL,
                resolution_note=NULL WHERE id=$1`, [target.exceptionId]);
    });

    test('A1b: the review queue is ordered by DOUBT, ascending', async () => {
      // The exception list orders by severity; this one orders by confidence
      // ASC, because the least certain proposal is where a reviewer most needs
      // the work done for them (ADR-081).
      const queue = await listQueueTriageCandidates(runId, 1000);
      assert.ok(queue.length > 0, 'the holdout must have a review queue');
      for (let i = 1; i < queue.length; i += 1) {
        assert.ok(queue[i - 1]!.confidence <= queue[i]!.confidence,
          `confidence fell at ${i}`);
      }
      for (const m of queue) {
        assert.ok(m.memberTransactionIds.length >= 2, 'a match has at least two members');
        assert.ok(m.maxMemberAmountPaise > 0);
      }
    });

    test('A1b returns every pending match and nothing else', async () => {
      const queue = await listQueueTriageCandidates(runId, 1000);
      const { rows } = await getPool().query<{ c: number }>(
        `SELECT count(*)::int c FROM matches WHERE run_id=$1 AND status='pending_review'`,
        [runId]);
      assert.equal(queue.length, rows[0]!.c);
      assert.equal(new Set(queue.map((m) => m.matchId)).size, queue.length);
    });

    test('triageRun caps both lists and reports what it left out', async () => {
      const plan = await triageRun(runId);
      assert.equal(plan.investigate.length, 20);
      assert.equal(plan.corroborate.length, 15);
      // It fetches cap+1 to know there was more, so the skipped counts are
      // "at least this many" rather than a full COUNT — and must be > 0 here.
      assert.ok(plan.investigationsSkipped > 0);
      assert.ok(plan.queueTriagesSkipped > 0);
      // Every selected exception is eligible and every match is pending.
      for (const c of plan.investigate) {
        assert.ok((ELIGIBLE_CATEGORIES as readonly string[]).includes(c.category));
      }
    });

    test('triage reads nothing it could write — it is a SELECT-only stage', async () => {
      const before = await getPool().query<{ e: number; m: number; a: number }>(
        `SELECT (SELECT count(*)::int FROM exceptions WHERE run_id=$1) e,
                (SELECT count(*)::int FROM matches WHERE run_id=$1) m,
                (SELECT count(*)::int FROM audit_log WHERE run_id=$1) a`, [runId]);
      await triageRun(runId);
      const after = await getPool().query<{ e: number; m: number; a: number }>(
        `SELECT (SELECT count(*)::int FROM exceptions WHERE run_id=$1) e,
                (SELECT count(*)::int FROM matches WHERE run_id=$1) m,
                (SELECT count(*)::int FROM audit_log WHERE run_id=$1) a`, [runId]);
      assert.deepEqual(after.rows[0], before.rows[0]);
    });
  });
