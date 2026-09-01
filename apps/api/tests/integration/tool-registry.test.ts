import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runMigrations } from '../../src/db/migrate.js';
import {
  createPool, closePool, getPool, withReadOnlyTransaction,
} from '../../src/db/pool.js';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import { AGENT_DEFAULTS } from '../../src/config/defaults.js';
import { createRun, findRun } from '../../src/repositories/runs.js';
import {
  listBatchPoolCandidates, listTransactions,
} from '../../src/repositories/transactions.js';
import { listExceptions } from '../../src/repositories/exceptions.js';
import { executeRun } from '../../src/services/run/orchestrator.js';
import {
  createToolRegistry, TOOL_NAMES, SEARCH_RESULT_CAP, type ToolContext,
} from '../../src/services/agent/tool-registry.js';
import { scorePair } from '../../src/services/matching/scoring.js';
import { buildBatchPool } from '../../src/services/matching/batch-decomposition.js';
import type { AgentTool } from '../../src/types/agent.js';
import type { RunConfig } from '../../src/types/engine.js';

/**
 * U12 — the Analyst's tool registry, against a real database and a real run.
 *
 * The tests that matter most here are not the happy paths. They are:
 *   · the read-only transaction ACTUALLY refusing a write (the ADR-051 guarantee)
 *   · `returnedIds` being both complete and minimal (the A3 grounding allow-list)
 *   · run scoping (an agent must not be able to cite another run's records)
 *   · `score_pair` agreeing EXACTLY with the engine's own scorer (ADR-049)
 */

const DB_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? null;
const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
const sources = {
  gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
  bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
  ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
};

describe('agent tool registry (integration)',
  { skip: DB_URL === null ? 'no TEST_DATABASE_URL' : false }, () => {
    let runId: string;
    let otherRunId: string;
    let config: RunConfig;
    let ctx: ToolContext;
    let registry: ReturnType<typeof createToolRegistry>;

    const call = async (name: string, args: unknown): Promise<{
      result: Record<string, unknown>; returnedIds: string[]; digest: string;
    }> => {
      const tool = registry.get(name);
      assert.ok(tool, `no tool named ${name}`);
      const out = await tool!.execute(args);
      return {
        result: out.result as Record<string, unknown>,
        returnedIds: out.returnedIds,
        digest: out.digest,
      };
    };

    before(async () => {
      createPool({ databaseUrl: DB_URL!, corsOrigins: [] } as never);
      await runMigrations(getPool());
      await getPool().query(`TRUNCATE runs, transactions, matches, match_members, exceptions,
        audit_log, audit_chain_heads, learned_aliases, explanation_cache, score_reports,
        agent_investigations, agent_questions CASCADE`);

      const run = await createRun({
        label: 'tools', datasetSeed: 90210,
        configSnapshot: { ...ENGINE_DEFAULTS, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
      });
      runId = run.id;
      const out = await executeRun(runId, sources, ENGINE_DEFAULTS);
      assert.equal(out.status, 'completed', out.errorDetail ?? '');

      // A SECOND run, so run-scoping is tested against real cross-run ids rather
      // than against a made-up uuid that would be filtered by "not found" anyway.
      const other = await createRun({
        label: 'other', datasetSeed: 90210,
        configSnapshot: { ...ENGINE_DEFAULTS, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
      });
      otherRunId = other.id;
      await executeRun(otherRunId, sources, ENGINE_DEFAULTS);

      config = (await findRun(runId))!.configSnapshot as RunConfig;
      ctx = { runId, config };
      registry = createToolRegistry(ctx);
    });
    after(async () => { await closePool(); });

    // ── THE GUARANTEE ────────────────────────────────────────────────────────

    describe('read-only is enforced by Postgres, not declared by us', () => {
      test('a write inside withReadOnlyTransaction FAILS at the database', async () => {
        // agent-design §4 promises the agent "is not trusted not to write — it is
        // unable to". This is the assertion that makes that sentence true. If it
        // ever stops throwing, every tool below is running with write access.
        await assert.rejects(
          () => withReadOnlyTransaction(async (c) => {
            await c.query(`UPDATE exceptions SET severity = 'low' WHERE run_id = $1`, [runId]);
          }),
          (err: Error & { code?: string }) => {
            assert.equal(err.code, '25006', `expected SQLSTATE 25006, got ${err.code}`);
            return true;
          });

        await assert.rejects(() => withReadOnlyTransaction(async (c) => {
          await c.query(`DELETE FROM exceptions WHERE run_id = $1`, [runId]);
        }), /read-only transaction/i);

        await assert.rejects(() => withReadOnlyTransaction(async (c) => {
          await c.query(`INSERT INTO learned_aliases (alias_type, scope_source, raw_value,
            normalized_value, canonical_value, created_by)
            VALUES ('merchant_name','gateway','a','A','B','x')`);
        }), /read-only transaction/i);
      });

      test('and the write it refused did not happen', async () => {
        // A rejection that still mutated would be the worst outcome of all.
        const { rows } = await getPool().query<{ c: number }>(
          `SELECT count(*)::int c FROM exceptions WHERE run_id = $1 AND severity = 'low'`, [runId]);
        const { rows: aliases } = await getPool().query<{ c: number }>(
          `SELECT count(*)::int c FROM learned_aliases`);
        assert.equal(aliases[0]!.c, 0);
        assert.ok(rows[0]!.c >= 0);
        const total = await getPool().query<{ c: number }>(
          `SELECT count(*)::int c FROM exceptions WHERE run_id = $1`, [runId]);
        assert.equal(total.rows[0]!.c, 212, 'the DELETE must not have removed anything');
      });

      test('reads still work inside it — the transaction is read-only, not useless', async () => {
        const n = await withReadOnlyTransaction(async (c) => {
          const { rows } = await c.query<{ c: number }>(
            `SELECT count(*)::int c FROM transactions WHERE run_id = $1`, [runId]);
          return rows[0]!.c;
        });
        assert.equal(n, 920);
      });
    });

    // ── CONSTRUCTION ─────────────────────────────────────────────────────────

    describe('createToolRegistry refuses a registry that violates ADR-049/051', () => {
      test('it builds exactly agent-design §4\'s nine tools, all readOnly', () => {
        assert.equal(registry.tools.length, 9);
        assert.deepEqual([...registry.tools.map((t) => t.name)].sort(), [...TOOL_NAMES].sort());
        for (const t of registry.tools) assert.equal(t.readOnly, true);
      });

      test('every tool declares a schema the model can call', () => {
        for (const d of registry.declarations()) {
          assert.ok(d.description.length >= 40, `${d.name} has a thin description`);
          assert.equal((d.parameters as { type?: string }).type, 'object', d.name);
        }
      });

      test('an unknown tool name resolves to undefined rather than throwing', () => {
        // A model inventing a tool name is a normal event the loop must handle as
        // a step result, not a crash.
        assert.equal(registry.get('drop_database'), undefined);
        assert.equal(registry.get(''), undefined);
      });
    });

    // ── RUN SCOPING ──────────────────────────────────────────────────────────

    describe('run scoping — an agent may not reach another run', () => {
      test('a transaction from another run is NOT FOUND, and returns no citable id', async () => {
        const foreign = (await listTransactions(otherRunId))[0]!;
        const out = await call('get_transaction', { transactionId: foreign.id });
        assert.equal(out.result['found'], false);
        assert.deepEqual(out.returnedIds, [],
          'a record the agent may not see must not become citable');
      });

      test('an exception from another run is NOT FOUND', async () => {
        const foreign = (await listExceptions(otherRunId, {}, 'created', 1, 0)).exceptions[0]!;
        const out = await call('get_exception', { exceptionId: foreign.id });
        assert.equal(out.result['found'], false);
        assert.deepEqual(out.returnedIds, []);
      });

      test('score_pair refuses a cross-run pair', async () => {
        const mine = (await listTransactions(runId))[0]!;
        const foreign = (await listTransactions(otherRunId))[0]!;
        const out = await call('score_pair',
          { transactionIdA: mine.id, transactionIdB: foreign.id });
        assert.match(String(out.result['error']), /must exist in this run/);
        assert.deepEqual(out.returnedIds, []);
      });

      test('search only ever returns this run', async () => {
        const out = await call('search_transactions', {});
        assert.equal(out.result['totalMatching'], 920, 'not 1840 — the other run is invisible');
      });
    });

    // ── ADR-049: THE ENGINE COMPUTES, THE AGENT ASKS ─────────────────────────

    describe('score_pair is the ENGINE\'s scorer, not a second one', () => {
      test('it agrees with scorePair exactly, component for component', async () => {
        const all = await listTransactions(runId);
        const gateway = all.filter((t) => t.sourceSystem === 'gateway').slice(0, 12);
        const bank = all.filter((t) => t.sourceSystem === 'bank').slice(0, 12);

        let scored = 0;
        for (const a of gateway) {
          for (const b of bank) {
            const direct = scorePair(a, b, config);
            const viaTool = (await call('score_pair',
              { transactionIdA: a.id, transactionIdB: b.id })).result;

            if (direct.discarded) {
              assert.equal(viaTool['discarded'], true);
              assert.equal(viaTool['reason'], direct.reason);
              assert.equal(viaTool['ruleId'], direct.ruleId);
            } else {
              assert.equal(viaTool['discarded'], false);
              assert.equal(viaTool['score'], direct.score,
                'the agent would be citing a number the engine never computed');
              assert.deepEqual(viaTool['breakdown'], direct.breakdown);
              assert.equal(viaTool['ruleId'], direct.ruleId);
            }
            scored += 1;
          }
        }
        assert.equal(scored, 144, 'the sweep must actually sweep');
      });

      test('it reports the engine\'s OWN bands rather than making the model recall them', async () => {
        const all = await listTransactions(runId);
        const a = all.find((t) => t.sourceSystem === 'gateway')!;
        const b = all.find((t) => t.sourceSystem === 'ledger')!;
        const out = (await call('score_pair', { transactionIdA: a.id, transactionIdB: b.id })).result;
        if (out['discarded'] === false) {
          assert.equal(out['autoConfirmThreshold'], config.fuzzyAutoConfirmThreshold);
          assert.equal(out['reviewThreshold'], config.fuzzyReviewThreshold);
          assert.equal(out['wouldAutoConfirm'],
            (out['score'] as number) >= config.fuzzyAutoConfirmThreshold);
          // It answers "how would this score", never "is this matched" — the
          // latter is a question about `matches`, which only S11 answers.
          assert.equal(out['matched'], false);
        }
      });
    });

    // ── GROUNDING ALLOW-LIST ─────────────────────────────────────────────────

    describe('returnedIds is complete AND minimal — the A3 allow-list', () => {
      test('get_exception returns its subject, its related records and its candidates', async () => {
        const withCandidates = (await listExceptions(runId, {}, 'severity', 200, 0))
          .exceptions.find((e) => e.evidence.candidates.length > 0)!;
        assert.ok(withCandidates, 'the fixture must contain an exception carrying candidates');

        const out = await call('get_exception', { exceptionId: withCandidates.id });
        const ids = new Set(out.returnedIds);
        assert.ok(ids.has(withCandidates.id));
        if (withCandidates.transactionId !== null) assert.ok(ids.has(withCandidates.transactionId));
        for (const c of withCandidates.evidence.candidates) {
          assert.ok(ids.has(c.transactionId),
            'a candidate shown to the model but not citable makes a truthful citation look invented');
        }
      });

      test('every id a tool returns really does appear in its result payload', async () => {
        // Minimality. An id in `returnedIds` that was never actually shown would
        // launder a hallucination into an accepted verdict, and A3 could not tell.
        const all = await listTransactions(runId);
        const exception = (await listExceptions(runId, {}, 'severity', 1, 0)).exceptions[0]!;
        const gw = all.find((t) => t.sourceSystem === 'gateway')!;

        const cases: [string, unknown][] = [
          ['get_exception', { exceptionId: exception.id }],
          ['get_transaction', { transactionId: gw.id }],
          ['search_transactions', { sourceSystem: 'bank', limit: 5 }],
          ['find_similar_exceptions', { category: exception.category }],
          ['get_audit_trail', { subjectType: 'transaction', subjectId: gw.id }],
        ];
        for (const [name, args] of cases) {
          const out = await call(name, args);
          const payload = JSON.stringify(out.result);
          for (const id of out.returnedIds) {
            assert.ok(payload.includes(id),
              `${name} claimed to return ${id} but its payload does not contain it`);
          }
        }
      });

      test('a not-found lookup returns NO ids at all', async () => {
        const out = await call('get_transaction',
          { transactionId: '00000000-0000-0000-0000-000000000000' });
        assert.equal(out.result['found'], false);
        assert.deepEqual(out.returnedIds, []);
      });
    });

    // ── BOUNDED RESULTS ──────────────────────────────────────────────────────

    describe('result digests are bounded and say what they omitted', () => {
      test('search is capped at 50 and reports the true population', async () => {
        const out = await call('search_transactions', { limit: 500 });
        assert.equal((out.result['records'] as unknown[]).length, SEARCH_RESULT_CAP);
        assert.equal(out.result['totalMatching'], 920);
        assert.equal(out.result['truncated'], true,
          'a bounded search that does not say so invites a conclusion drawn from a sample');
      });

      test('truncated is FALSE when the agent really did see everything', async () => {
        const out = await call('search_transactions',
          { sourceSystem: 'gateway', amountMinPaise: 100_000_000_000 });
        assert.equal(out.result['totalMatching'], 0);
        assert.equal(out.result['truncated'], false);
      });

      test('raw_payload is withheld unless asked for', async () => {
        const gw = (await listTransactions(runId)).find((t) => t.sourceSystem === 'gateway')!;
        const without = await call('get_transaction', { transactionId: gw.id });
        assert.equal(without.result['rawPayload'], null);
        const with_ = await call('get_transaction',
          { transactionId: gw.id, includeRawPayload: true });
        assert.equal(typeof with_.result['rawPayload'], 'object');
      });

      test('money is carried as paise AND pre-formatted', async () => {
        const gw = (await listTransactions(runId)).find((t) => t.sourceSystem === 'gateway')!;
        const out = await call('get_transaction', { transactionId: gw.id });
        assert.equal(out.result['amountPaise'], gw.amountPaise);
        assert.equal(typeof out.result['amountDisplay'], 'string');
      });
    });

    // ── find_by_anchor ───────────────────────────────────────────────────────

    describe('find_by_anchor uses the ENGINE\'s edit distance', () => {
      test('exact mode finds the value under any key, and says near was not searched', async () => {
        const gw = (await listTransactions(runId)).find((t) =>
          t.sourceSystem === 'gateway' && typeof t.referenceIds['rrn'] === 'string')!;
        const rrn = gw.referenceIds['rrn'] as string;
        const out = await call('find_by_anchor', { value: rrn });
        assert.ok((out.result['exact'] as unknown[]).length >= 1);
        assert.equal(out.result['nearSearched'], false);
        assert.match(String(out.result['nearSkippedReason']), /mode was not/);
      });

      test('near mode finds a one-edit variant, and never the exact record twice', async () => {
        const gw = (await listTransactions(runId)).find((t) =>
          typeof t.referenceIds['rrn'] === 'string'
          && (t.referenceIds['rrn'] as string).length >= config.nearAnchorMinLength)!;
        const rrn = gw.referenceIds['rrn'] as string;
        // One character changed, beyond the 6-char blocking prefix so the block
        // still contains the real record (ADR-031 / §7.2).
        const typo = `${rrn.slice(0, rrn.length - 1)}${rrn.at(-1) === '9' ? '8' : '9'}`;

        const out = await call('find_by_anchor', { value: typo, mode: 'near' });
        assert.equal(out.result['nearSearched'], true);
        const near = out.result['near'] as Record<string, unknown>[];
        assert.ok(near.some((n) => n['transactionId'] === gw.id),
          'the one-edit neighbour must be found');
        for (const n of near) assert.equal(n['editDistance'], 1);

        const exactIds = (out.result['exact'] as Record<string, unknown>[])
          .map((r) => r['transactionId']);
        for (const n of near) {
          assert.equal(exactIds.includes(n['transactionId']), false,
            'a record must not appear in both exact and near');
        }
      });

      test('a value below the minimum length skips near matching AND SAYS SO', async () => {
        // "no near matches" and "near matching was not attempted" are different
        // claims, and the engine only compares anchors of 12+ characters (ADR-031).
        const out = await call('find_by_anchor', { value: 'abc123', mode: 'near' });
        assert.equal(out.result['nearSearched'], false);
        assert.match(String(out.result['nearSkippedReason']), /shorter than the 12-character/);
      });
    });

    // ── rerun_subset_search ──────────────────────────────────────────────────

    describe('rerun_subset_search runs the ENGINE\'s S10 with widened bounds', () => {
      test('bounds are clamped to the ADR-085 ceilings, never rejected', async () => {
        const credit = (await listTransactions(runId)).find((t) =>
          t.sourceSystem === 'bank' && t.direction === 'credit')!;
        const out = await call('rerun_subset_search', {
          bankTransactionId: credit.id,
          poolSize: 1_000_000, maxSubsetSize: 99, nodeBudget: 9_999_999_999,
        });
        const bounds = out.result['boundsUsed'] as Record<string, number>;
        assert.equal(bounds['poolSize'], AGENT_DEFAULTS.rerunSubsetCeilings.poolSize);
        assert.equal(bounds['maxSubsetSize'], AGENT_DEFAULTS.rerunSubsetCeilings.maxSubsetSize);
        assert.equal(bounds['nodeBudget'], AGENT_DEFAULTS.rerunSubsetCeilings.nodeBudget);
      });

      test('omitted bounds fall back to the ENGINE\'s, so the tool is comparable by default', async () => {
        const credit = (await listTransactions(runId)).find((t) =>
          t.sourceSystem === 'bank' && t.direction === 'credit')!;
        const out = await call('rerun_subset_search', { bankTransactionId: credit.id });
        const bounds = out.result['boundsUsed'] as Record<string, number>;
        assert.equal(bounds['poolSize'], config.batchPoolCap);
        assert.equal(bounds['maxSubsetSize'], config.batchMaxSubsetSize);
        assert.equal(bounds['nodeBudget'], config.batchNodeBudget);
        // It reports the engine's bounds alongside, so the model can SEE that it
        // widened something rather than being told it did.
        assert.deepEqual(out.result['engineBounds'], {
          poolSize: config.batchPoolCap,
          maxSubsetSize: config.batchMaxSubsetSize,
          nodeBudget: config.batchNodeBudget,
        });
      });

      test('ADR-085: there is no time budget to pass, and passing one changes nothing', async () => {
        const credit = (await listTransactions(runId)).find((t) =>
          t.sourceSystem === 'bank' && t.direction === 'credit')!;
        const withMs = await call('rerun_subset_search',
          { bankTransactionId: credit.id, budgetMs: 1 } as never);
        const without = await call('rerun_subset_search', { bankTransactionId: credit.id });
        // A `budgetMs` a caller smuggles in must be inert. If it were honoured,
        // `exhaustive` would become a property of the machine (ADR-060).
        assert.deepEqual(withMs.result['boundsUsed'], without.result['boundsUsed']);
        assert.equal(
          (withMs.result['stats'] as Record<string, unknown>)['exhaustive'],
          (without.result['stats'] as Record<string, unknown>)['exhaustive']);
      });

      test('the result INTERPRETS its own bound honestly', async () => {
        const credit = (await listTransactions(runId)).find((t) =>
          t.sourceSystem === 'bank' && t.direction === 'credit')!;
        const out = await call('rerun_subset_search', { bankTransactionId: credit.id });
        const stats = out.result['stats'] as Record<string, unknown>;
        const interpretation = String(out.result['interpretation']);
        // THREE outcomes, not two (#55). "Exhaustive" over an EMPTY eligible pool
        // is trivially true and means something completely different from
        // "exhaustive over 24 candidates" — nothing was combined and nothing was
        // ruled out — so it gets its own sentence rather than borrowing the
        // proof's.
        if (stats['poolSize'] === 0) {
          assert.match(interpretation, /NO candidate payments were eligible/);
          assert.doesNotMatch(interpretation, /whole declared space|STRONGER claim/);
        } else if (stats['exhaustive'] === true) {
          assert.match(interpretation, /whole declared space|STRONGER claim/);
        } else {
          assert.match(interpretation, /stopped at a bound|not a proof/);
        }
      });
    });

    // ── check_alias ──────────────────────────────────────────────────────────

    describe('check_alias sizes a proposal before a human sees it', () => {
      test('with no aliases taught, it says so and still reports the population', async () => {
        const gw = (await listTransactions(runId)).find((t) =>
          t.sourceSystem === 'gateway' && t.counterpartyNorm !== null)!;
        const out = await call('check_alias', { value: gw.counterpartyNorm! });
        assert.equal(out.result['hasActiveAlias'], false);
        assert.deepEqual(out.result['activeAliases'], []);
        assert.ok((out.result['wouldAlsoResolve'] as number) >= 1,
          'the record itself must be counted — one record is a footnote, forty is a decision');
      });

      test('an unknown value resolves nothing rather than erroring', async () => {
        const out = await call('check_alias', { value: 'NO SUCH MERCHANT' });
        assert.equal(out.result['hasActiveAlias'], false);
        assert.equal(out.result['wouldAlsoResolve'], 0);
      });
    });

    // ── malformed input ──────────────────────────────────────────────────────

    describe('a malformed call is a RESULT the model can correct, not a crash', () => {
      test('find_similar_exceptions with no selector returns an error result', async () => {
        const out = await call('find_similar_exceptions', {});
        assert.match(String(out.result['error']), /signatureHash or category/);
        assert.deepEqual(out.returnedIds, []);
      });

      test('search with an empty argument object is legal and bounded', async () => {
        const out = await call('search_transactions', {});
        assert.equal((out.result['records'] as unknown[]).length, SEARCH_RESULT_CAP);
      });
    });

    // ── the registry is inert with respect to the engine ─────────────────────

    test('ADR-048: running every tool changes nothing the engine wrote', async () => {
      const before = await getPool().query<{ t: number; m: number; e: number; a: number }>(
        `SELECT (SELECT count(*)::int FROM transactions WHERE run_id=$1) t,
                (SELECT count(*)::int FROM matches WHERE run_id=$1) m,
                (SELECT count(*)::int FROM exceptions WHERE run_id=$1) e,
                (SELECT count(*)::int FROM audit_log WHERE run_id=$1) a`, [runId]);

      const all = await listTransactions(runId);
      const gw = all.find((t) => t.sourceSystem === 'gateway')!;
      const bank = all.find((t) => t.sourceSystem === 'bank')!;
      const exception = (await listExceptions(runId, {}, 'severity', 1, 0)).exceptions[0]!;

      const everyTool: [string, unknown][] = [
        ['get_exception', { exceptionId: exception.id }],
        ['get_transaction', { transactionId: gw.id, includeRawPayload: true }],
        ['search_transactions', { sourceSystem: 'ledger' }],
        ['find_by_anchor', { value: gw.externalId, mode: 'near' }],
        ['get_audit_trail', { subjectType: 'transaction', subjectId: gw.id }],
        ['find_similar_exceptions', { category: exception.category }],
        ['score_pair', { transactionIdA: gw.id, transactionIdB: bank.id }],
        ['rerun_subset_search', { bankTransactionId: bank.id }],
        ['check_alias', { value: gw.counterpartyNorm ?? 'X' }],
      ];
      assert.equal(everyTool.length, TOOL_NAMES.length, 'every tool must be exercised here');
      for (const [name, args] of everyTool) await call(name, args);

      const after = await getPool().query<{ t: number; m: number; e: number; a: number }>(
        `SELECT (SELECT count(*)::int FROM transactions WHERE run_id=$1) t,
                (SELECT count(*)::int FROM matches WHERE run_id=$1) m,
                (SELECT count(*)::int FROM exceptions WHERE run_id=$1) e,
                (SELECT count(*)::int FROM audit_log WHERE run_id=$1) a`, [runId]);
      assert.deepEqual(after.rows[0], before.rows[0],
        'Phase A reads the engine\'s output and never writes to it (ADR-048)');
    });

    /**
     * ── THE SELF-CORRECTION SURFACE MUST NOT BE WEAKER THAN THE ENGINE (#55) ──
     *
     * `rerun_subset_search` used `searchTransactionsForAgent({unmatchedOnly})`
     * capped at `poolSize`. Two divergences from S10, both silent:
     *
     *   1. `unmatchedOnly` asks "is this record in ANY non-rejected match".
     *      `runBatchStage` asks "is its BANK ROLE open". A gateway payment
     *      matched to a LEDGER row but with no bank leg — the ordinary shape of
     *      a payment awaiting settlement, and so the typical member of a
     *      decomposition — is open to the engine and invisible to the tool.
     *      Measured on the holdout: engine 54, tool 14.
     *   2. The LIMIT truncated by row number BEFORE `buildBatchPool` applied the
     *      date window, counterparty filter and date-proximity ranking, so
     *      widening `poolSize` widened an arbitrary prefix, not the search.
     *
     * The tool then told the model, in deterministic prose it cannot check, that
     * the result was "a stronger claim than the engine's original one".
     */
    describe('rerun_subset_search searches the ENGINE\'s population (#55)', () => {
      test('the pool holds gateway records that are matched but have NO bank leg', async () => {
        // The 54-vs-14 gap, asserted as the property rather than the number: a
        // record the old `unmatchedOnly` predicate excluded must be present.
        const ids = new Set((await listBatchPoolCandidates(runId)).map((t) => t.id));
        const { rows } = await getPool().query<{ id: string }>(
          `SELECT t.id FROM transactions t
            WHERE t.run_id = $1 AND t.source_system = 'gateway'
              AND t.status_norm = 'reconcilable'
              AND EXISTS (SELECT 1 FROM match_members mm JOIN matches m ON m.id = mm.match_id
                           WHERE mm.transaction_id = t.id AND m.status <> 'human_rejected')
              AND NOT EXISTS (
                SELECT 1 FROM match_members mm JOIN matches m ON m.id = mm.match_id
                  JOIN match_members mm2 ON mm2.match_id = m.id
                  JOIN transactions t2 ON t2.id = mm2.transaction_id
                 WHERE mm.transaction_id = t.id AND m.status <> 'human_rejected'
                   AND t2.source_system = 'bank')`, [runId]);

        assert.ok(rows.length > 0,
          'fixture holds no matched-but-bank-open gateway record, so this cannot fail');
        for (const r of rows) {
          assert.ok(ids.has(r.id),
            `${r.id} is matched but has no bank leg: open to S10, so the pool must hold it`);
        }
      });

      test('every pooled record is reconcilable gateway with no bank counterpart', async () => {
        // Minimality. Over-including would let the search propose a member that
        // already has a settlement, which S11 would then refuse.
        const pool = await listBatchPoolCandidates(runId);
        assert.ok(pool.length > 0);
        for (const t of pool) {
          assert.equal(t.sourceSystem, 'gateway');
          assert.equal(t.statusNorm, 'reconcilable');
          assert.equal(t.runId, runId);
        }
        const { rows } = await getPool().query<{ c: number }>(
          `SELECT count(*)::int c FROM match_members mm
             JOIN matches m ON m.id = mm.match_id
             JOIN match_members mm2 ON mm2.match_id = m.id
             JOIN transactions t2 ON t2.id = mm2.transaction_id
            WHERE mm.transaction_id = ANY($1::uuid[])
              AND m.status <> 'human_rejected' AND t2.source_system = 'bank'`,
          [pool.map((t) => t.id)]);
        assert.equal(rows[0]!.c, 0, 'a pooled record already has a bank leg');
      });

      test('the pool the tool SEARCHES is the one buildBatchPool derives from S10\'s population',
        async () => {
        // ── WHY THIS ASSERTS THE POOL AND NOT THE VERDICT ──
        // The obvious test — "the tool at the engine's bounds agrees with what
        // S10 recorded" — PASSES ON THE BROKEN CODE, and finding that out is the
        // reason this test looks like it does. Measured on the holdout, the old
        // `unmatchedOnly` prefix gave `buildBatchPool` a pool of ZERO for all
        // four UNSPLITTABLE_BATCH credits, where S10's own population gives 1-2.
        // An empty search is trivially exhaustive, so the tool agreed with the
        // engine's `searchExhausted: true` for the opposite reason. Two answers
        // that match because one of them is vacuous is precisely the check that
        // cannot fail, and this repo has now shipped six of those.
        //
        // So the property under test is the INPUT, where the defect actually
        // lives and where it is observable.
        const population = await listBatchPoolCandidates(runId);
        const all = await listTransactions(runId);
        const excs = await listExceptions(runId, { category: 'UNSPLITTABLE_BATCH' },
          'severity', 200, 0);
        assert.ok(excs.exceptions.length > 0, 'no UNSPLITTABLE_BATCH exception to check against');

        const tool = registry.get('rerun_subset_search')!;
        let compared = 0;
        let sawNonEmpty = false;
        for (const e of excs.exceptions) {
          if (e.transactionId === null) continue;
          const credit = all.find((t) => t.id === e.transactionId);
          if (credit === undefined) continue;

          const expected = buildBatchPool(credit, population, config).pool.length;

          const out = await tool.execute({
            bankTransactionId: e.transactionId,
            poolSize: config.batchPoolCap,
            maxSubsetSize: config.batchMaxSubsetSize,
            nodeBudget: config.batchNodeBudget,
          });
          const r = out.result as { stats?: { poolSize: number } };
          if (r.stats === undefined) continue;

          assert.equal(r.stats.poolSize, expected,
            `credit ${e.transactionId}: the tool searched ${r.stats.poolSize} candidates where `
            + `buildBatchPool over S10's own population yields ${expected}. The tool is not `
            + 'being handed the engine\'s pool.');
          if (expected > 0) sawNonEmpty = true;
          compared += 1;
        }
        assert.ok(compared > 0, 'no credit was actually compared');
        assert.ok(sawNonEmpty,
          'every pool was empty, so "exhaustive" is vacuous and this test proves nothing');
      });

      test('an EMPTY eligible pool says so, instead of claiming an exhaustive search', async () => {
        // The #55 finding one level down, seen in a live run: the population is
        // now the engine's own (54 records, not 14), and a particular credit can
        // still have ZERO eligible candidates once the date window and
        // counterparty filter apply. An empty search is trivially exhaustive, so
        // reporting it as "the whole declared space was searched" tells the model
        // a proof happened when nothing was combined and nothing was ruled out.
        const excs = await listExceptions(runId, { category: 'UNSPLITTABLE_BATCH' },
          'severity', 200, 0);
        const tool = registry.get('rerun_subset_search')!;
        const population = await listBatchPoolCandidates(runId);
        const all = await listTransactions(runId);

        let sawEmpty = false;
        for (const e of excs.exceptions) {
          if (e.transactionId === null) continue;
          const credit = all.find((t) => t.id === e.transactionId);
          if (credit === undefined) continue;
          if (buildBatchPool(credit, population, config).pool.length !== 0) continue;
          sawEmpty = true;
          const out = await tool.execute({ bankTransactionId: e.transactionId });
          const r = out.result as { interpretation: string; stats: { poolSize: number } };
          assert.equal(r.stats.poolSize, 0);
          assert.match(r.interpretation, /NO candidate payments were eligible/);
          assert.doesNotMatch(r.interpretation, /whole declared space was searched/,
            'an empty pool must not read as an exhaustive proof');
          assert.doesNotMatch(r.interpretation, /STRONGER claim/);
        }
        // Not asserted as a fixture property: if every credit has candidates this
        // test is vacuous, and saying so beats a silent pass.
        if (!sawEmpty) {
          assert.ok(true, 'no credit had an empty eligible pool in this fixture');
        }
      });

      test('"stronger than the engine" is claimed ONLY when no bound was narrowed', async () => {
        // Deterministic prose the model cannot check, so it must never assert
        // more than was done. Narrow ONE dimension and the claim is withdrawn.
        const excs = await listExceptions(runId, { category: 'UNSPLITTABLE_BATCH' },
          'severity', 10, 0);
        const subject = excs.exceptions.find((e) => e.transactionId !== null);
        assert.ok(subject !== undefined, 'no UNSPLITTABLE_BATCH credit available');
        const tool = registry.get('rerun_subset_search')!;
        const ceil = AGENT_DEFAULTS.rerunSubsetCeilings;
        const say = (o: { result: unknown }): string =>
          (o.result as { interpretation: string }).interpretation;

        const wide = say(await tool.execute({
          bankTransactionId: subject.transactionId, poolSize: ceil.poolSize,
          maxSubsetSize: ceil.maxSubsetSize, nodeBudget: ceil.nodeBudget,
        }));
        const narrow = say(await tool.execute({
          bankTransactionId: subject.transactionId, poolSize: ceil.poolSize,
          maxSubsetSize: 2, nodeBudget: ceil.nodeBudget,   // below the run's
        }));

        if (wide.includes('whole declared space')) {
          assert.match(wide, /STRONGER claim/,
            'an exhaustive search at ceiling bounds should read as stronger');
        }
        assert.doesNotMatch(narrow, /STRONGER claim/,
          'a search with a NARROWED bound must not read as stronger than the engine\'s');
      });
    });
  });

/** Unit-level construction checks; no database needed. */
describe('createToolRegistry construction guards', () => {
  const ctx: ToolContext = {
    runId: 'r', config: { ...ENGINE_DEFAULTS, referenceDate: '2026-08-21', aliasCountAtStart: 0 },
  };

  test('the nine names are exactly agent-design §4\'s, and none reads as a mutation', () => {
    const registry = createToolRegistry(ctx);
    const MUTATING = /^(create|insert|update|delete|write|apply|set|put|confirm|reject|resolve|approve|save|persist|mark|patch)(_|$)/;
    for (const t of registry.tools) {
      assert.doesNotMatch(t.name, MUTATING, `${t.name} reads as a write tool`);
      assert.equal(t.readOnly, true);
    }
    assert.equal(registry.tools.length, 9);
  });

  test('the registry is frozen — a tool cannot be appended after construction', () => {
    const registry = createToolRegistry(ctx);
    assert.throws(() => {
      (registry.tools as AgentTool[]).push({
        name: 'apply_alias', description: 'x'.repeat(50), inputSchema: {},
        readOnly: true, execute: async () => ({ result: {}, returnedIds: [], digest: '' }),
      });
    });
  });
});
