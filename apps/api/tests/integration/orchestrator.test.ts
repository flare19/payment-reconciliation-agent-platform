import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, closePool, getPool } from '../../src/db/pool.js';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import { createRun, findRun } from '../../src/repositories/runs.js';
import { verifyRunChain, readChain } from '../../src/repositories/audit.js';
import { listTransactions } from '../../src/repositories/transactions.js';
import { executeRun, hashSource } from '../../src/services/run/orchestrator.js';

/**
 * The whole engine, S0 → S12, against a real database.
 *
 * Every stage has been unit-tested in isolation and the pipeline has been run in
 * memory. This is the first thing that proves the two agree: that what the
 * engine computes is what the database ends up holding, that the phases commit
 * in an order a poller can observe, and that a failure leaves a run that says so
 * rather than a run that looks finished.
 */

const DB_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? null;
const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
const sources = {
  gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
  bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
  ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
};

describe('run orchestrator (integration)', { skip: DB_URL === null ? 'no TEST_DATABASE_URL' : false }, () => {
  let runId: string;

  before(async () => {
    createPool({ databaseUrl: DB_URL!, corsOrigins: [] } as never);
    await runMigrations(getPool());
    await getPool().query(`TRUNCATE runs, transactions, matches, match_members, exceptions,
      audit_log, audit_chain_heads, learned_aliases, explanation_cache, score_reports,
      agent_investigations, agent_questions CASCADE`);
    const run = await createRun({
      label: 'holdout', datasetSeed: 90210, configSnapshot: {
        ...ENGINE_DEFAULTS, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
    });
    runId = run.id;
  });
  after(async () => { await closePool(); });

  const count = async (sql: string): Promise<number> =>
    (await getPool().query<{ c: number }>(sql, [runId])).rows[0]!.c;

  test('a full run completes and persists every stage', async () => {
    const out = await executeRun(runId, sources, ENGINE_DEFAULTS);
    assert.equal(out.status, 'completed', out.errorDetail ?? '');
    assert.equal(out.referenceDate, '2026-08-21');
    assert.equal(out.matches, 284);
    assert.equal(out.exceptions, 214);

    assert.equal(await count(`SELECT count(*)::int c FROM transactions WHERE run_id=$1`), 920);
    assert.equal(await count(`SELECT count(*)::int c FROM matches WHERE run_id=$1`), 284);
    assert.equal(await count(`SELECT count(*)::int c FROM exceptions WHERE run_id=$1`), 214);
    // 784, not 598: issue #40 let a gateway matched at Tier 1 keep looking for
    // its bank leg, and #38 let it find that leg through a `bank_ref_no` equal to
    // its own `rrn`. Both turn two-way groups into three-way ones. The GROUP count
    // is unchanged at 284 throughout — the same events, more completely assembled.
    assert.equal(await count(
      `SELECT count(*)::int c FROM match_members mm JOIN matches m ON m.id=mm.match_id
        WHERE m.run_id=$1`), 784);
  });

  test('ADR-040: every term of the match-rate denominator is recorded', async () => {
    // reconcilable = ingested − excluded − rejected_rows − non_primary_duplicates.
    // A denominator whose components are not on the run row is one nobody can check.
    const run = await findRun(runId);
    const c = run!.recordCounts;
    const ingested = c.gateway! + c.bank! + c.ledger!;
    assert.equal(ingested, 920);
    assert.equal(c.excluded, 37);
    assert.equal(c.rejected, 0);
    assert.equal(c.nonPrimaryDuplicates, 9);
    assert.equal(c.reconcilable, ingested - c.excluded! - c.rejected! - c.nonPrimaryDuplicates!);
    assert.equal(c.reconcilable, 874);
  });

  test('the RUN_STARTED anchor carries what makes the run reproducible', async () => {
    // schema.md §9.1: full config, the three file hashes and the reference date,
    // in one immutable entry, BEFORE any matching decision. This entry is the
    // whole answer to "prove this number came from those bytes".
    const chain = await readChain(runId);
    const started = chain.find((e) => e.eventType === 'RUN_STARTED');
    assert.ok(started, 'a run with no anchor is a run nobody can reproduce');
    assert.equal(started!.sequenceNo, chain[0]!.sequenceNo, 'the anchor must come first');

    const d = started!.details as Record<string, Record<string, unknown>>;
    assert.equal(d['referenceDate'], '2026-08-21');
    assert.equal(d['inputFileHashes']!['gateway'], hashSource(sources.gateway));
    assert.equal(d['inputFileHashes']!['bank'], hashSource(sources.bank));
    assert.equal(d['inputFileHashes']!['ledger'], hashSource(sources.ledger));
    // ADR-039: the reference date is dataset-derived, so the resolved config
    // cannot exist before parsing — which is why the anchor is written here
    // rather than at row creation.
    assert.equal(d['configSnapshot']!['referenceDate'], '2026-08-21');
    assert.equal(d['configSnapshot']!['aliasCountAtStart'], 0);
  });

  test('the run row stores the config ACTUALLY used, not the one requested', async () => {
    const run = await findRun(runId);
    assert.equal(run!.configSnapshot.referenceDate, '2026-08-21',
      'the row was created with a placeholder date; the run must overwrite it');
    assert.equal(run!.inputFileHashes['gateway'], hashSource(sources.gateway));
  });

  test('the audit chain verifies and is anchored', async () => {
    const v = await verifyRunChain(runId);
    assert.equal(v.valid, true);
    assert.equal(v.anchored, true, 'a truncated log must not read as clean');
    assert.equal(v.firstDivergenceSequenceNo, null);
    // Pinned exactly. A loose floor here would hide the thing this test is for:
    // the chain covering every decision the run made, and no more.
    assert.equal(v.entriesChecked, 593);
  });

  test('the audit trail records DECISIONS, and is not drowned by transcription', async () => {
    const { rows } = await getPool().query<{ event_type: string; c: number }>(
      `SELECT event_type, count(*)::int c FROM audit_log WHERE run_id=$1 GROUP BY 1`, [runId]);
    const by = Object.fromEntries(rows.map((r) => [r.event_type, r.c]));

    assert.equal(by['RUN_STARTED'], 1);
    assert.equal(by['RUN_COMPLETED'], 1);
    // One per SOURCE, not one per row: ingestion is a transcription and the
    // rows themselves are in `transactions` with raw_payload intact.
    assert.equal(by['RECORD_INGESTED'], 3);
    // These ARE decisions — each one changed a record's fate.
    assert.equal(by['RECORD_EXCLUDED'], 37);
    assert.equal(by['RECORD_DEDUPLICATED'], 9);
    // 32, not 203, and that is §10 rule 5 rather than lost exact matches. Tier 1
    // still produces all 203 gateway<->ledger pairs; 171 of their groups now also
    // hold a fuzzy bank leg, and "group tier is the WEAKEST tier used" reports
    // those as fuzzy. 203 - 171 = 32. Reporting them as exact would overstate the
    // evidence for the leg a reader is most likely to check.
    //
    // The eleven pairs #38 recovered move this number DOWN by nine and
    // MATCH_FLAGGED_FOR_REVIEW UP by seven, because seven of the newly-found bank
    // legs score in the review band and §10 rule 4 makes a group holding a
    // proposal a proposal. That is the ADR-038/ADR-040 trade working, not a loss.
    assert.equal(by['MATCH_CONFIRMED_EXACT'], 32);
    assert.equal(by['MATCH_CONFIRMED_FUZZY'], 181);
    assert.equal(by['MATCH_FLAGGED_FOR_REVIEW'], 71);
    assert.equal(by['MATCH_CANDIDATE_DISPLACED'], 35);
    assert.equal(by['EXCEPTION_RAISED'], 214);

    // S8 re-derives every pair S6 already claimed and reports outcome 'match'
    // "for completeness". Logging those would put a second entry beside every
    // exact match and overstate what the identity stage contributed.
    assert.equal(by['IDENTITY_ESTABLISHED'], 9,
      'only the verdicts Tier 1 declined — the amount/timing ones S8 exists for');

    // schema.md §9.1 floors this at 0.40 to avoid ~90k rows of noise; the near
    // misses live in each exception's evidence.candidates instead.
    assert.equal(by['MATCH_CANDIDATE_REJECTED'], undefined);
  });

  test('no record sits in two matches — the trigger held under a real run', async () => {
    assert.equal(await count(
      `SELECT count(*)::int c FROM (
         SELECT mm.transaction_id FROM match_members mm JOIN matches m ON m.id=mm.match_id
          WHERE m.run_id=$1 GROUP BY 1 HAVING count(*) > 1) x`), 0);
  });

  test('S7 persisted counterparty_key on every POOLED record, and only those', async () => {
    const all = await listTransactions(runId);
    // "Pooled" excludes the non-primary duplicates: S4 removed them before
    // matching, so Tier 1.5 never saw them and they correctly keep a NULL key.
    // Setting one anyway would claim the alias tier considered a record it did
    // not.
    const pooled = all.filter((t) =>
      t.statusNorm === 'reconcilable'
      && t.counterpartyNorm !== null
      && t.duplicateOfTransactionId === null);
    assert.ok(pooled.length > 0);
    assert.equal(pooled.filter((t) => t.counterpartyKey === null).length, 0,
      'counterparty_key is NULL until Tier 1.5 runs — after it, every pooled row has one');

    const removed = all.filter((t) => t.duplicateOfTransactionId !== null);
    assert.equal(removed.length, 9);
    assert.equal(removed.filter((t) => t.counterpartyKey !== null).length, 0,
      'a deduplicated copy never entered the pool, so it has no post-alias key');
  });

  test('S14 persists a headline whose denominator terms reproduce it', async () => {
    // ADR-040 has three defensible readings and the wrong one is the FLATTERING
    // one, so the published terms must reproduce the published denominator here,
    // from the stored object, not only inside the function that computed it.
    const run = await findRun(runId);
    const m = run!.metrics as Record<string, Record<string, number>>;
    assert.equal(m['matchRate']!['matchRatePct'], 65.22);
    assert.equal(m['matchRate']!['matchedRecords'], 570);
    assert.equal(m['matchRate']!['reconcilableRecords'], 874);
    const p = m['population']!;
    assert.equal(
      p['ingested']! - p['excluded']! - p['rejectedRows']! - p['nonPrimaryDuplicates']!,
      m['matchRate']!['reconcilableRecords']);
  });

  test('S14 reports what it did NOT compute, rather than zeroing it', async () => {
    const run = await findRun(runId);
    const m = run!.metrics as Record<string, unknown>;
    assert.deepEqual(m['stagesNotRun'], ['S13_EXPLAIN']);
    assert.equal(m['llmCost'], null);
    // S10 runs since #46, so these are counts. On this dataset every unmatched
    // settlement credit has a candidate pool below the batch-shaped floor, so
    // no batch verdict reaches S12 and both counts are 0 — a real zero from a
    // stage that ran, which is a different claim from `null`.
    const e = m['exceptions'] as Record<string, unknown>;
    assert.equal(e['batchSearchExhausted'], 4);
    assert.equal(e['batchSearchBoundExceeded'], 0);
  });

  test('tierAttribution survives the jsonb round trip as PAIR counts (ADR-072)', async () => {
    // The figure `tools/score` reads for its tier diagnostic. If it ever became
    // the group-tier count it would read 46 instead of 203 and U9's per-tier
    // table would be wrong for 63% of matched pairs.
    const run = await findRun(runId);
    const t = (run!.metrics as Record<string, Record<string, number>>)['tierAttribution']!;
    assert.equal(t['exact'], 203);
    assert.equal(t['fuzzy'], 279);
    assert.equal(t['implied'], 231);
    assert.equal(t['batch'], 18, 'S10 split legs, attributed to their own tier (ADR-072)');
    assert.equal(t['unattributed'], 0);
    assert.equal(t['identityEstablished'], 9, 'what S8 contributed, not what it re-derived');
    assert.notEqual(t['exact'], 46, 'this is the GROUP-tier count, not the pair count');
  });

  test('a second identical run produces identical counts (ADR-032)', async () => {
    const second = await createRun({
      label: 'holdout-again', datasetSeed: 90210, configSnapshot: {
        ...ENGINE_DEFAULTS, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
    });
    const out = await executeRun(second.id, sources, ENGINE_DEFAULTS);
    assert.equal(out.status, 'completed');
    assert.equal(out.matches, 284);
    assert.equal(out.exceptions, 214);
    assert.equal(out.referenceDate, '2026-08-21');
    assert.equal(out.auditEntries, 593, 'the same inputs must produce the same trail');
  });

  test('a failed run says so, and its committed phases stay visible (ADR-046)', async () => {
    // The cost of phase-per-transaction, stated rather than hidden: a run that
    // fails late keeps what already committed. That is the honest outcome — the
    // alternative is a run that silently looks like it never happened.
    const failing = await createRun({
      label: 'broken', configSnapshot: {
        ...ENGINE_DEFAULTS, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
    });
    const out = await executeRun(failing.id, {
      ...sources, bank: 'utr,value_date\n"unterminated',
    }, ENGINE_DEFAULTS);

    assert.equal(out.status, 'failed');
    assert.match(out.errorDetail!, /PARSE_FAILED/,
      'matching-engine §12: a whole unparseable file fails the run, no partial run');

    const stored = await findRun(failing.id);
    assert.equal(stored!.status, 'failed');
    assert.ok(stored!.finishedAt !== null, 'runs_finished_iff_terminal');
    assert.match(stored!.errorDetail!, /PARSE_FAILED/);

    const chain = await readChain(failing.id);
    assert.equal(chain.length, 1, 'the failure is recorded even though nothing else committed');
    assert.equal(chain[0]!.eventType, 'RUN_FAILED');
    assert.equal((await getPool().query(
      `SELECT 1 FROM transactions WHERE run_id=$1`, [failing.id])).rowCount, 0);
  });

  test('the boot reaper does not touch a completed run', async () => {
    const { reapInterruptedRuns } = await import('../../src/repositories/runs.js');
    const reaped = await reapInterruptedRuns(0);
    assert.ok(!reaped.includes(runId), 'a completed run is terminal and must be left alone');
  });
});
