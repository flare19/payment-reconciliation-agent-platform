import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runMigrations } from '../../src/db/migrate.js';
import { createPool, closePool, getPool } from '../../src/db/pool.js';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import { createRun } from '../../src/repositories/runs.js';
import { executeRun } from '../../src/services/run/orchestrator.js';
import {
  searchTransactionsForAgent, findTransactionsByAnchorValue,
  findTransactionsByAnchorPrefix, listTransactions,
} from '../../src/repositories/transactions.js';
import { findSimilarExceptions } from '../../src/repositories/exceptions.js';
import { ANCHOR_PREFIX_LEN } from '../../src/services/matching/blocking.js';
import { compareCanonical } from '../../src/types/domain.js';

/**
 * The read-only queries behind the Analyst's tool registry (U12).
 *
 * Against a REAL Postgres and a REAL holdout run, because every defect these can
 * have is a defect a typecheck cannot see: a `jsonb_each_text` that does not
 * bind, an ORDER BY that is not total, a filter that silently matches nothing.
 */

import { TEST_DB_URL as DB_URL, SKIP_REASON } from './test-db.js';
const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
const sources = {
  gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
  bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
  ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
};

describe('agent read queries (integration)',
  { skip: SKIP_REASON }, () => {
    let runId: string;

    before(async () => {
      createPool({ databaseUrl: DB_URL!, corsOrigins: [] } as never);
      await runMigrations(getPool());
      await getPool().query(`TRUNCATE runs, transactions, matches, match_members, exceptions,
        audit_log, audit_chain_heads, learned_aliases, explanation_cache, score_reports,
        agent_investigations, agent_questions CASCADE`);
      const run = await createRun({
        label: 'agent-queries', datasetSeed: 90210,
        configSnapshot: { ...ENGINE_DEFAULTS, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
      });
      runId = run.id;
      const out = await executeRun(runId, sources, ENGINE_DEFAULTS);
      assert.equal(out.status, 'completed', out.errorDetail ?? '');
    });
    after(async () => { await closePool(); });

    // ── search_transactions ──────────────────────────────────────────────────

    test('an unfiltered search is bounded and canonically ordered', async () => {
      const { transactions, totalMatching } = await searchTransactionsForAgent(runId, {}, 50);
      assert.equal(transactions.length, 50);
      assert.equal(totalMatching, 920, 'the agent must be told the population it saw 50 of');

      // ADR-032: the SQL order must equal the TS comparator, or a bounded search
      // returns a different 50 rows on two runs and the agent cites evidence a
      // re-run cannot reproduce.
      const resorted = [...transactions].sort(compareCanonical);
      assert.deepEqual(transactions.map((t) => t.id), resorted.map((t) => t.id));
    });

    test('every filter narrows, and they compose', async () => {
      const all = await searchTransactionsForAgent(runId, {}, 1);
      assert.equal(all.totalMatching, 920);

      const bank = await searchTransactionsForAgent(runId, { sourceSystem: 'bank' }, 1);
      assert.equal(bank.totalMatching, 301);

      const credits = await searchTransactionsForAgent(
        runId, { sourceSystem: 'bank', direction: 'credit' }, 1);
      assert.ok(credits.totalMatching > 0 && credits.totalMatching < 301,
        'composing two filters must narrow further than either alone');

      const dated = await searchTransactionsForAgent(
        runId, { dateFrom: '2026-08-20', dateTo: '2026-08-21' }, 50);
      assert.ok(dated.totalMatching > 0);
      for (const t of dated.transactions) {
        assert.ok(t.txnDate >= '2026-08-20' && t.txnDate <= '2026-08-21', t.txnDate);
      }

      const big = await searchTransactionsForAgent(runId, { amountMinPaise: 10_000_000 }, 50);
      for (const t of big.transactions) assert.ok(t.amountPaise >= 10_000_000);

      const excluded = await searchTransactionsForAgent(
        runId, { statusNorm: 'excluded_failed' }, 50);
      for (const t of excluded.transactions) assert.equal(t.statusNorm, 'excluded_failed');
    });

    test('unmatchedOnly excludes records already in a match', async () => {
      const unmatched = await searchTransactionsForAgent(runId, { unmatchedOnly: true }, 1);
      const { rows } = await getPool().query<{ c: number }>(
        `SELECT count(DISTINCT mm.transaction_id)::int c
           FROM match_members mm JOIN matches m ON m.id = mm.match_id
          WHERE m.run_id = $1 AND m.status <> 'human_rejected'`, [runId]);
      // 920 total, minus the records sitting in a live match. Derived from the
      // database rather than pinned, so it stays true when the engine moves.
      assert.equal(unmatched.totalMatching, 920 - rows[0]!.c);
      assert.ok(rows[0]!.c > 0, 'the fixture must actually contain matched records');
    });

    test('a filter matching nothing returns an empty page, not an error', async () => {
      const none = await searchTransactionsForAgent(
        runId, { counterparty: 'NO_SUCH_MERCHANT_ANYWHERE' }, 50);
      assert.deepEqual(none.transactions, []);
      assert.equal(none.totalMatching, 0);
    });

    // ── find_by_anchor ───────────────────────────────────────────────────────

    test('an anchor value is found across sources, under ANY reference key', async () => {
      // The question the tool exists to answer: does this reference appear
      // anywhere else? The engine's own #38 finding is the case — a bank
      // `bank_ref_no` byte-identical to a gateway `rrn`.
      const all = await listTransactions(runId);
      const gateway = all.find((t) =>
        t.sourceSystem === 'gateway' && typeof t.referenceIds['rrn'] === 'string')!;
      assert.ok(gateway, 'the fixture must contain a gateway record carrying an rrn');
      const rrn = gateway.referenceIds['rrn'] as string;

      const hits = await findTransactionsByAnchorValue(runId, rrn);
      assert.ok(hits.some((t) => t.id === gateway.id), 'the record itself must be returned');
      // Every hit really does carry the value somewhere in reference_ids.
      for (const h of hits) {
        assert.ok(Object.values(h.referenceIds).includes(rrn),
          `${h.id} was returned but does not carry ${rrn}`);
      }
      const resorted = [...hits].sort(compareCanonical);
      assert.deepEqual(hits.map((t) => t.id), resorted.map((t) => t.id));
    });

    test('an anchor value nobody carries returns empty', async () => {
      assert.deepEqual(await findTransactionsByAnchorValue(runId, 'pay_NOTHING_AT_ALL'), []);
    });

    test('the prefix block returns candidates AND the values that matched', async () => {
      const all = await listTransactions(runId);
      const withRef = all.find((t) => Object.values(t.referenceIds)
        .some((v) => typeof v === 'string' && v.length >= ANCHOR_PREFIX_LEN))!;
      const value = Object.values(withRef.referenceIds)
        .find((v): v is string => typeof v === 'string' && v.length >= ANCHOR_PREFIX_LEN)!;
      const prefix = value.slice(0, ANCHOR_PREFIX_LEN);

      const block = await findTransactionsByAnchorPrefix(runId, prefix, ANCHOR_PREFIX_LEN);
      assert.ok(block.length > 0);
      assert.ok(block.some((b) => b.transaction.id === withRef.id));
      for (const b of block) {
        assert.ok(b.anchorValues.length > 0,
          'a block member must report which of its values matched the prefix');
        for (const v of b.anchorValues) assert.equal(v.slice(0, ANCHOR_PREFIX_LEN), prefix);
      }
    });

    // ── find_similar_exceptions ──────────────────────────────────────────────

    test('similar exceptions are found by SIGNATURE — the sharp lookup U11 made possible', async () => {
      const { rows } = await getPool().query<{ signature_hash: string; c: number }>(
        `SELECT signature_hash, count(*)::int c FROM exceptions WHERE run_id = $1
          GROUP BY 1 ORDER BY c DESC LIMIT 1`, [runId]);
      const { signature_hash: hash, c } = rows[0]!;
      assert.ok(c > 1, 'the fixture must have a signature shared by several exceptions');

      const similar = await findSimilarExceptions({ signatureHash: hash }, 100);
      assert.equal(similar.length, Math.min(c, 100));
      for (const s of similar) assert.equal(s.signatureHash, hash);
    });

    test('by category is the broader net, and excludeExceptionId is honoured', async () => {
      const byCategory = await findSimilarExceptions({ category: 'MISSING_IN_LEDGER' }, 100);
      assert.ok(byCategory.length > 0);
      for (const s of byCategory) assert.equal(s.category, 'MISSING_IN_LEDGER');

      const without = await findSimilarExceptions(
        { category: 'MISSING_IN_LEDGER', excludeExceptionId: byCategory[0]!.id }, 100);
      assert.equal(without.some((s) => s.id === byCategory[0]!.id), false);
    });

    test('it REFUSES an unfiltered scan rather than returning an arbitrary page', async () => {
      // Without a selector this is a data dump with a LIMIT on it, and the agent
      // would reason over whatever happened to sort first while believing it had
      // found something similar.
      await assert.rejects(
        () => findSimilarExceptions({}, 10), /requires signatureHash or category/);
      await assert.rejects(
        () => findSimilarExceptions({ resolvedOnly: true }, 10), /unfiltered scan/);
    });

    test('resolvedOnly narrows to human dispositions', async () => {
      // Nothing is human-resolved on a fresh run, so this must be EMPTY rather
      // than falling back to everything — a filter that silently no-ops would
      // hand the agent unresolved exceptions as if they were precedent.
      const resolved = await findSimilarExceptions(
        { category: 'MISSING_IN_LEDGER', resolvedOnly: true }, 100);
      assert.deepEqual(resolved, []);

      const target = (await findSimilarExceptions({ category: 'MISSING_IN_LEDGER' }, 1))[0]!;
      await getPool().query(
        `UPDATE exceptions SET status='human_resolved', resolved_by='reviewer',
                resolved_at=now(), resolution_note='posted the missing entry'
          WHERE id=$1`, [target.id]);

      const after = await findSimilarExceptions(
        { category: 'MISSING_IN_LEDGER', resolvedOnly: true }, 100);
      assert.equal(after.length, 1);
      assert.equal(after[0]!.id, target.id);
      assert.equal(after[0]!.resolutionNote, 'posted the missing entry');
    });

    test('a human disposition sorts FIRST — it is the useful part', async () => {
      const all = await findSimilarExceptions({ category: 'MISSING_IN_LEDGER' }, 100);
      assert.ok(all.length > 1);
      assert.notEqual(all[0]!.resolvedBy, null,
        'the resolved exception must lead; that is the precedent the agent came for');
      const firstUnresolved = all.findIndex((s) => s.resolvedBy === null);
      assert.equal(all.slice(firstUnresolved).every((s) => s.resolvedBy === null), true,
        'resolved rows must not be interleaved with unresolved ones');
    });
  });
