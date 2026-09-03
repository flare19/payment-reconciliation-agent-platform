import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, closePool, getPool, withTransaction } from '../../src/db/pool.js';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';
import type { ClassifiedException, NormalizedTransaction, ProposedMatch, RunConfig } from '../../src/types/engine.js';
import { emptyEvidence } from '../../src/services/classification/evidence.js';
import * as runs from '../../src/repositories/runs.js';
import * as txns from '../../src/repositories/transactions.js';
import * as matches from '../../src/repositories/matches.js';
import * as exceptions from '../../src/repositories/exceptions.js';
import * as aliases from '../../src/repositories/aliases.js';
import * as explanations from '../../src/repositories/explanations.js';
import * as scoreReports from '../../src/repositories/score-reports.js';
import * as investigations from '../../src/repositories/investigations.js';

/**
 * Every repository query against a real Postgres.
 *
 * The unit suite cannot see any of this: TypeScript typechecks the SHAPE of a
 * query's result and says nothing about whether the SQL parses, whether the
 * column exists, or whether a CHECK constraint will refuse the write. A
 * repository that compiles and does not run is the most expensive kind of green
 * build, because it fails first on Day 8 when the orchestrator finally calls it.
 *
 * So this file's bar is deliberately low and wide: EXECUTE every statement at
 * least once, and assert the invariants the schema exists to enforce actually
 * fire — the single-match trigger, the resolution-completeness constraint, and
 * the alias supersede-with-penalty policy.
 */

const DB_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? null;
const config: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-21', aliasCountAtStart: 0 };

function txn(over: Partial<NormalizedTransaction> & Pick<NormalizedTransaction, 'id' | 'runId' | 'sourceSystem' | 'sourceRowNumber'>): NormalizedTransaction {
  return {
    sourceFile: 'f.csv', externalId: over.id, referenceIds: {}, anchorStrength: 'none',
    amountPaise: 100_000, feePaise: null, taxPaise: null, netAmountPaise: 100_000,
    currency: 'INR', direction: 'credit', txnDate: '2026-08-14', txnTimestamp: null,
    postingDate: null, counterpartyRaw: null, counterpartyNorm: 'ACME', counterpartyKey: null,
    method: 'card', statusRaw: 'captured', statusNorm: 'reconcilable', txnType: null,
    descriptionRaw: null, duplicateOfTransactionId: null, duplicateKind: null,
    ingestWarnings: [], rawPayload: { a: '1' }, ...over,
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('repositories (integration)', { skip: DB_URL === null ? 'no TEST_DATABASE_URL' : false }, () => {
  let runId: string;
  const gwId = uuid(1);
  const bkId = uuid(2);
  const ldId = uuid(3);

  before(async () => {
    createPool({ databaseUrl: DB_URL!, corsOrigins: [] } as never);
    await runMigrations(getPool());
    await getPool().query(`TRUNCATE runs, transactions, matches, match_members, exceptions,
      audit_log, audit_chain_heads, learned_aliases, explanation_cache, score_reports,
      agent_investigations, agent_questions CASCADE`);

    const run = await runs.createRun({ label: 'integration', configSnapshot: config });
    runId = run.id;
    await txns.insertTransactions([
      txn({ id: gwId, runId, sourceSystem: 'gateway', sourceRowNumber: 1,
            referenceIds: { payment_id: 'pay_AAAAAAAAAAAAAA' } }),
      txn({ id: bkId, runId, sourceSystem: 'bank', sourceRowNumber: 1 }),
      txn({ id: ldId, runId, sourceSystem: 'ledger', sourceRowNumber: 1,
            statusNorm: 'excluded_draft' }),
    ]);
  });
  after(async () => { await closePool(); });

  // ── runs ───────────────────────────────────────────────────────────────────

  test('runs: create, read, ingest bookkeeping, metrics, finish', async () => {
    await runs.recordIngestion(runId, {
      referenceDate: '2026-08-21',
      recordCounts: { gateway: 1, bank: 1, ledger: 1, excluded: 1, rejected: 0,
                      nonPrimaryDuplicates: 0, reconcilable: 2 },
      rejectedRows: [{ sourceSystem: 'bank', rowNumber: 7, rawLine: 'bad', error: 'boom' }],
      inputFileHashes: { gateway: 'a'.repeat(64) },
    });
    await runs.setRunStatus(runId, 'matching');
    await runs.setRunMetrics(runId, { matchRatePct: 61.5 });

    const found = await runs.findRun(runId);
    assert.ok(found);
    assert.equal(found!.referenceDate, '2026-08-21', 'DATE must stay a YYYY-MM-DD string');
    assert.equal(found!.rejectedRowCount, 1);
    assert.equal(found!.rejectedRows[0]!.error, 'boom');
    assert.equal(found!.status, 'matching');
    assert.deepEqual(found!.metrics, { matchRatePct: 61.5 });
    assert.equal(found!.configSnapshot.amountTolerancePct, config.amountTolerancePct);

    const { runs: list, total } = await runs.listRuns(10, 0);
    assert.equal(total, 1);
    assert.equal(list[0]!.id, runId);
  });

  test('runs: finishing sets status and finished_at together (runs_finished_iff_terminal)', async () => {
    const other = await runs.createRun({ label: 'terminal', configSnapshot: config });
    const done = await runs.finishRun(other.id, { status: 'completed' });
    assert.equal(done!.status, 'completed');
    assert.ok(done!.finishedAt !== null, 'the CHECK requires a timestamp on a terminal run');

    const failed = await runs.createRun({ label: 'fail', configSnapshot: config });
    const f = await runs.finishRun(failed.id, { status: 'failed', errorDetail: 'PARSE_FAILED' });
    assert.equal(f!.errorDetail, 'PARSE_FAILED');
  });

  test('runs: the boot reaper only touches non-terminal runs', async () => {
    const reaped = await runs.reapInterruptedRuns(0);
    assert.ok(reaped.includes(runId), 'the live run should be reaped at a 0-minute threshold');
    await getPool().query(
      `UPDATE runs SET status='matching', finished_at=NULL, error_detail=NULL WHERE id=$1`, [runId]);
  });

  // ── transactions ───────────────────────────────────────────────────────────

  test('transactions: BIGINT paise round-trips as a NUMBER, not a string', async () => {
    // The bug this guards: pg returns int8 as a string by default, so a + b
    // concatenates and the match rate is silently wrong rather than crashing.
    const t = await txns.findTransaction(gwId);
    assert.equal(typeof t!.amountPaise, 'number');
    assert.equal(t!.amountPaise + t!.amountPaise, 200_000);
  });

  test('transactions: listTransactions returns CANONICAL order (gateway < bank < ledger)', async () => {
    const all = await txns.listTransactions(runId);
    assert.deepEqual(all.map((t) => t.sourceSystem), ['gateway', 'bank', 'ledger'],
      'alphabetical would give bank < gateway < ledger and change every tie-break');
  });

  test('transactions: jsonb columns round-trip', async () => {
    const t = await txns.findTransaction(gwId);
    assert.deepEqual(t!.referenceIds, { payment_id: 'pay_AAAAAAAAAAAAAA' });
    assert.deepEqual(t!.rawPayload, { a: '1' });
    assert.deepEqual(t!.ingestWarnings, []);
  });

  test('transactions: counterparty keys and duplicate marks write in bulk', async () => {
    await txns.setCounterpartyKeys([{ transactionId: gwId, counterpartyKey: 'ACME CANON' }]);
    assert.equal((await txns.findTransaction(gwId))!.counterpartyKey, 'ACME CANON');

    await txns.markDuplicates([{ transactionId: bkId, primaryId: gwId, kind: 'exact' }]);
    const marked = await txns.findTransaction(bkId);
    assert.equal(marked!.duplicateOfTransactionId, gwId);
    assert.equal(marked!.duplicateKind, 'exact');

    const dupes = await txns.listNonReconcilable(runId, 'duplicates', 10, 0);
    assert.equal(dupes.total, 1);
    const excluded = await txns.listNonReconcilable(runId, 'excluded', 10, 0);
    assert.equal(excluded.total, 1, 'the excluded_draft ledger row');

    await txns.markDuplicates([]);   // the empty-input early return
    await getPool().query(
      `UPDATE transactions SET duplicate_of_transaction_id=NULL, duplicate_kind=NULL WHERE id=$1`,
      [bkId]);
  });

  // ── matches ────────────────────────────────────────────────────────────────

  const proposal = (members: { transactionId: string; role: 'gateway' | 'bank' | 'ledger'; isAnchor: boolean }[]): ProposedMatch => ({
    tier: 'fuzzy', status: 'pending_review', confidence: 0.7123, ruleId: 'FUZZY_WEAK_ANCHOR_V1',
    cardinality: 'one_to_one', members,
    amountDeltaPaise: -412, dateDeltaDays: 2, aliasIds: [],
    scoreBreakdown: { anchor: 0.3, amount: 0.2, date: 0.1, counterparty: 0.1123, total: 0.7123, amountUnavailable: false },
  });

  let matchId: string;

  test('matches: a group and its members write atomically, members in role order', async () => {
    const m = await matches.insertMatch(runId, proposal([
      { transactionId: bkId, role: 'bank', isAnchor: false },
      { transactionId: gwId, role: 'gateway', isAnchor: true },
    ]), 'v1');
    matchId = m.id;
    assert.equal(m.confidence, 0.7123, 'NUMERIC(5,4) must survive as a number');
    assert.equal(m.amountDeltaPaise, -412);
    assert.deepEqual(m.members.map((x) => x.role), ['gateway', 'bank'],
      'the aggregate ORDER BY, not insertion order');
    assert.equal(m.members.find((x) => x.isAnchor)!.transactionId, gwId);
  });

  test('matches: THE SINGLE-MATCH TRIGGER refuses a second claim on the same record', async () => {
    // Enforced by a BEFORE INSERT trigger, not a partial index (Postgres forbids
    // a subquery in an index predicate). If this ever stops throwing, a record
    // can sit in two matches and the match rate double-counts it.
    await assert.rejects(
      matches.insertMatch(runId, proposal([
        { transactionId: gwId, role: 'gateway', isAnchor: true },
        { transactionId: ldId, role: 'ledger', isAnchor: false },
      ]), 'v1'),
      /already|match/i,
    );
    const still = await matches.listMatches(runId, {}, 50, 0);
    assert.equal(still.total, 1, 'the refused group must not survive half-written');
  });

  test('matches: review queue, filters and counters', async () => {
    const queue = await matches.listReviewQueue(runId, 10, 0);
    assert.equal(queue.total, 1);
    const byTier = await matches.listMatches(runId, { tier: 'fuzzy', status: 'pending_review' }, 10, 0);
    assert.equal(byTier.total, 1);
    assert.equal((await matches.listMatches(runId, { tier: 'exact' }, 10, 0)).total, 0);

    const counts = await matches.countMatchesByTierAndStatus(runId);
    assert.deepEqual(counts, [{ tier: 'fuzzy', status: 'pending_review', count: 1 }]);

    // ADR-040: a proposal is not a reconciliation, so it is not "matched" yet.
    assert.deepEqual(await matches.listMatchedTransactionIds(runId), []);
    assert.equal((await matches.findMatchesForTransaction(gwId)).length, 1);
  });

  test('matches: review is guarded on pending_review, so a second reviewer gets null', async () => {
    const approved = await matches.reviewMatch(matchId,
      { status: 'human_confirmed', reviewedBy: 'tejas', note: 'looks right' });
    assert.equal(approved!.status, 'human_confirmed');
    assert.ok(approved!.reviewedAt !== null, 'reviewed_by and reviewed_at move together');

    const second = await matches.reviewMatch(matchId,
      { status: 'human_rejected', reviewedBy: 'someone-else', note: null });
    assert.equal(second, null, 'a read-then-write would have let both reviewers act');

    const nowMatched = await matches.listMatchedTransactionIds(runId);
    assert.deepEqual(nowMatched.sort(), [gwId, bkId].sort());
  });

  // ── exceptions ─────────────────────────────────────────────────────────────

  const exc = (over: Partial<ClassifiedException> = {}): ClassifiedException => ({
    transactionId: ldId, relatedTransactionIds: [gwId], category: 'MISSING_IN_BANK',
    secondaryFlags: [], severity: 'high', amountAtRiskPaise: 500_000,
    requiresHumanConfirmation: false, bestCandidateScore: 0.42,
    evidence: { ...emptyEvidence(), candidatesConsidered: 90 },
    detectedByRule: 'CLASSIFY_MISSING_IN_BANK_V1', ruleVersion: 'v1', ...over,
  });

  let exceptionId: string;

  test('exceptions: bulk insert, facets and the severity sort', async () => {
    const written = await exceptions.insertExceptions(runId, [
      exc(),
      exc({ transactionId: gwId, category: 'AMOUNT_MISMATCH', severity: 'medium',
            amountAtRiskPaise: 100, detectedByRule: 'CLASSIFY_AMOUNT_MISMATCH_V1' }),
      exc({ transactionId: bkId, category: 'MISSING_IN_BANK', severity: 'low', amountAtRiskPaise: null }),
    ]);
    assert.equal(written, 3);
    assert.equal(await exceptions.insertExceptions(runId, []), 0);

    const page = await exceptions.listExceptions(runId, {}, 'severity', 10, 0);
    assert.equal(page.total, 3);
    assert.deepEqual(page.exceptions.map((e) => e.severity), ['high', 'medium', 'low'],
      'ADR-044: computed severity first, then money at risk');
    exceptionId = page.exceptions[0]!.id;

    assert.equal(page.exceptions[0]!.amountAtRiskPaise, 500_000, 'BIGINT as a number');
    assert.equal(page.exceptions[0]!.bestCandidateScore, 0.42);
    assert.equal(page.exceptions[0]!.evidence.candidatesConsidered, 90);
    assert.deepEqual(page.exceptions[0]!.relatedTransactionIds, [gwId]);

    const facets = await exceptions.exceptionFacets(runId);
    assert.deepEqual(facets.byCategory,
      [{ category: 'AMOUNT_MISMATCH', count: 1 }, { category: 'MISSING_IN_BANK', count: 2 }]);
    assert.equal(facets.bySeverity.length, 3);
  });

  test('exceptions: every filter, sort and search branch executes', async () => {
    assert.equal((await exceptions.listExceptions(runId, { category: 'AMOUNT_MISMATCH' }, 'amount', 10, 0)).total, 1);
    assert.equal((await exceptions.listExceptions(runId, { severity: 'low' }, 'created', 10, 0)).total, 1);
    assert.equal((await exceptions.listExceptions(runId, { status: 'open' }, 'severity', 10, 0)).total, 3);
    assert.equal((await exceptions.listExceptions(runId, { search: 'MISSING' }, 'severity', 10, 0)).total, 2);
    assert.equal((await exceptions.listExceptions(runId, { search: '   ' }, 'severity', 10, 0)).total, 3);
    // All three fixtures name gwId in related_transaction_ids, and one is ON it.
    // The point of the query is that BOTH routes reach a record — an exception
    // that merely names a record still belongs in that record's inspector.
    assert.equal((await exceptions.listExceptionsForTransaction(gwId)).length, 3);
    assert.equal((await exceptions.listExceptionsForTransaction(ldId)).length, 1,
      'only the exception that is ON this record');
  });

  test('exceptions: explanation attaches and flips status to explained', async () => {
    await exceptions.setExplanation(exceptionId, {
      explanationText: 'The bank never credited this payment.',
      suggestedAction: 'Chase the settlement.',
      explanationSource: 'template', signatureHash: 'b'.repeat(64),
    });
    const e = await exceptions.findException(exceptionId);
    assert.equal(e!.status, 'explained');
    assert.equal(e!.explanationSource, 'template');
    assert.equal((await exceptions.listUnexplained(runId, 10)).length, 2);
  });

  test('exceptions: resolution is guarded, and the DB refuses one with no reason', async () => {
    const resolved = await exceptions.resolveException(exceptionId,
      { status: 'human_resolved', resolvedBy: 'tejas', note: 'raised with the bank' });
    assert.equal(resolved!.status, 'human_resolved');
    assert.ok(resolved!.resolvedAt !== null);

    const again = await exceptions.resolveException(exceptionId,
      { status: 'wont_fix', resolvedBy: 'other', note: 'nope' });
    assert.equal(again, null, '409 EXCEPTION_ALREADY_RESOLVED comes from this null');

    // exc_resolution_complete: a resolution without a stated reason is the same
    // hole in the audit trail a reason-less rejection would be. Tested against a
    // still-OPEN exception — the resolved one above already carries a note, so
    // the constraint is satisfied there and could never fire.
    const open = await exceptions.listExceptions(runId, { status: 'open' }, 'severity', 1, 0);
    await assert.rejects(
      getPool().query(
        `UPDATE exceptions SET status='wont_fix', resolved_by='x', resolved_at=now()
          WHERE id=$1`, [open.exceptions[0]!.id]),
      /exc_resolution_complete/,
    );
  });

  // ── aliases ────────────────────────────────────────────────────────────────

  test('aliases: create, reaffirm, then supersede-with-penalty (§6.3)', async () => {
    const created = await aliases.upsertAlias({
      aliasType: 'merchant_name', scopeSource: 'any', rawValue: 'AMZN',
      normalizedValue: 'AMZN', canonicalValue: 'AMAZON RETAIL', createdBy: 'tejas',
    });
    assert.equal(created.outcome, 'created');
    assert.equal(created.alias.eligibleForAliasTier, true);

    const again = await aliases.upsertAlias({
      aliasType: 'merchant_name', scopeSource: 'any', rawValue: 'AMZN',
      normalizedValue: 'AMZN', canonicalValue: 'AMAZON RETAIL', createdBy: 'someone',
    });
    assert.equal(again.outcome, 'reaffirmed');
    assert.equal(again.alias.confirmationCount, 2);

    const conflict = await aliases.upsertAlias({
      aliasType: 'merchant_name', scopeSource: 'any', rawValue: 'AMZN',
      normalizedValue: 'AMZN', canonicalValue: 'AMAZON INDIA', createdBy: 'other',
    });
    assert.equal(conflict.outcome, 'superseded');
    assert.equal(conflict.alias.conflictCount, 1);
    assert.equal(conflict.alias.confirmationCount, 1);
    // THE PENALTY: conflict_count > 0 AND confirmation_count < 2 bars Tier 1.5.
    assert.equal(conflict.alias.eligibleForAliasTier, false,
      'a contested alias must fall back to human review, not auto-resolve');
    assert.equal(conflict.previous.status, 'superseded');
    assert.equal(conflict.previous.supersededBy, conflict.alias.id);
  });

  test('aliases: a second independent confirmation lifts the penalty (§6.3 rule 3)', async () => {
    const promoted = await aliases.upsertAlias({
      aliasType: 'merchant_name', scopeSource: 'any', rawValue: 'AMZN',
      normalizedValue: 'AMZN', canonicalValue: 'AMAZON INDIA', createdBy: 'third',
    });
    assert.equal(promoted.outcome, 'reaffirmed');
    assert.equal(promoted.alias.confirmationCount, 2);
    assert.equal(promoted.alias.eligibleForAliasTier, true, 'promoted back to Tier 1.5');
  });

  test('aliases: the engine sees only active ones, with eligibility COMPUTED', async () => {
    const active = await aliases.listActiveAliases();
    assert.equal(active.length, 1, 'superseded aliases never apply again');
    assert.equal(active[0]!.canonicalValue, 'AMAZON INDIA');
    assert.equal(active[0]!.eligibleForAliasTier, true);
  });

  test('aliases: lineage walks the supersession chain, and revoke is terminal', async () => {
    const active = await aliases.listActiveAliases();
    const lineage = await aliases.aliasLineage(active[0]!.id);
    assert.equal(lineage.length, 2, 'the superseded row and its replacement');

    await aliases.recordAliasApplications([active[0]!.id, active[0]!.id]);
    assert.equal((await aliases.findAlias(active[0]!.id))!.appliedCount, 2);

    const revoked = await aliases.revokeAlias(active[0]!.id, 'wrong merchant');
    assert.equal(revoked!.status, 'revoked');
    assert.equal(await aliases.revokeAlias(active[0]!.id, 'again'), null, 'revocation is terminal');
    assert.equal((await aliases.listActiveAliases()).length, 0);

    const listed = await aliases.listAliases({ status: 'revoked' }, 10, 0);
    assert.equal(listed.total, 1);
    // TWO rows, not three: the reaffirmation in §6.3 case 1 deliberately creates
    // no row, it only increments a counter. A third row here would mean the
    // policy had silently become insert-always.
    assert.equal((await aliases.listAliases({ aliasType: 'merchant_name', search: 'AMZN' }, 10, 0)).total, 2);
    assert.equal((await aliases.listAliases({}, 10, 0)).total, 2);
  });

  // ── explanation cache ──────────────────────────────────────────────────────

  test('explanations: put, hit-counting get, peek and stats', async () => {
    const sig = 'c'.repeat(64);
    await explanations.putExplanation({
      signatureHash: sig, promptVersion: 'p1', model: 'gemini-3.5-flash',
      category: 'MISSING_IN_BANK', signatureInput: { shape: 'lag' },
      explanationText: 'text', suggestedAction: 'action', tokensIn: 100, tokensOut: 50,
    });
    // ON CONFLICT DO NOTHING: two concurrent misses must not race to overwrite.
    await explanations.putExplanation({
      signatureHash: sig, promptVersion: 'p1', model: 'gemini-3.5-flash',
      category: 'MISSING_IN_BANK', signatureInput: { shape: 'other' },
      explanationText: 'SECOND', suggestedAction: 'x',
    });
    assert.equal((await explanations.peekCachedExplanation(sig))!.explanationText, 'text');
    assert.equal((await explanations.peekCachedExplanation(sig))!.hitCount, 0, 'peek does not count');

    const hit = await explanations.getCachedExplanation(sig);
    assert.equal(hit!.hitCount, 1, 'the get counts its own hit in one statement');
    assert.deepEqual(hit!.signatureInput, { shape: 'lag' });
    assert.equal(await explanations.getCachedExplanation('d'.repeat(64)), null);

    const stats = await explanations.explanationCacheStats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.totalHits, 1);
    assert.equal(stats.tokensIn, 100);
  });

  // ── score reports ──────────────────────────────────────────────────────────

  test('score-reports: insert, re-post is refused, and reads come back ordered', async () => {
    const report = await scoreReports.insertScoreReport({
      runId, truthKeyFile: 'data/truth/holdout_seed_90210.json',
      truthKeyHash: 'e'.repeat(64), scorerVersion: 's1',
      report: { pairPrecision: 1, pairRecall: 0.395 },
    });
    assert.ok(report);
    assert.deepEqual(report!.report, { pairPrecision: 1, pairRecall: 0.395 });

    // The same scorer, key and run is the SAME measurement. A number must not be
    // quietly replaced after it has been read.
    const dup = await scoreReports.insertScoreReport({
      runId, truthKeyFile: 'data/truth/holdout_seed_90210.json',
      truthKeyHash: 'e'.repeat(64), scorerVersion: 's1', report: { pairRecall: 0.99 },
    });
    assert.equal(dup, null);

    assert.equal((await scoreReports.latestScoreReport(runId))!.id, report!.id);
    assert.equal((await scoreReports.listScoreReports(runId)).length, 1);
    assert.equal((await scoreReports.findScoreReport(report!.id))!.scorerVersion, 's1');
  });

  // ── agent ──────────────────────────────────────────────────────────────────

  test('investigations: start, conclude, dispose, and the metrics roll-up', async () => {
    const open = await investigations.startInvestigation({
      runId, exceptionId, model: 'gemini-3.5-flash', promptVersion: 'a1',
    });
    assert.equal(open.status, 'running');
    assert.equal(open.groundingPassed, false);

    const done = await investigations.concludeInvestigation(open.id, {
      verdict: 'RESOLUTION_PROPOSED', confidence: 'high',
      proposedAction: { kind: 'propose_match', members: [gwId] },
      reasoning: [{ step: 1, thought: 'checked' }], citations: [gwId],
      groundingPassed: true, groundingFailure: null, budgetExhausted: false,
      steps: 3, toolCalls: 4, tokensIn: 900, tokensOut: 120, costUsd: 0.0123,
    });
    assert.equal(done!.verdict, 'RESOLUTION_PROPOSED');
    assert.equal(done!.confidence, 'high', 'a LABEL, never a number');
    assert.equal(done!.costUsd, 0.0123);
    assert.deepEqual(done!.citations, [gwId]);

    assert.equal(await investigations.concludeInvestigation(open.id, {
      verdict: 'INSUFFICIENT_EVIDENCE', confidence: 'low', proposedAction: null,
      reasoning: [], citations: [], groundingPassed: false, groundingFailure: null,
      budgetExhausted: false, steps: 0, toolCalls: 0, tokensIn: null, tokensOut: null, costUsd: null,
    }), null, 'concluding twice must not overwrite the verdict');

    const disposed = await investigations.recordDisposition(open.id, 'accepted', matchId);
    assert.equal(disposed!.humanDisposition, 'accepted');
    assert.equal(disposed!.resultingMatchId, matchId);

    assert.equal((await investigations.findInvestigation(open.id))!.id, open.id);
    assert.equal((await investigations.findInvestigationForException(exceptionId))!.id, open.id);
    assert.equal((await investigations.listInvestigations(runId, 10, 0)).total, 1);

    const m = await investigations.agentMetrics(runId);
    assert.equal(m.total, 1);
    assert.equal(m.concluded, 1);
    assert.equal(m.proposals, 1);
    assert.equal(m.accepted, 1);
    assert.equal(m.groundingFailures, 0, 'ADR-053 makes this a build blocker, not a metric');
    assert.equal(m.tokensIn, 900);
  });

  test('investigations: a proposal with no proposed_action is refused (inv_proposal_paired)', async () => {
    // Its own exception: ux_inv_exc_active reserves the slot for any
    // investigation that has not FAILED, which is what makes endpoint 25 return
    // 409 INVESTIGATION_IN_PROGRESS rather than starting a second loop.
    const other = await exceptions.listExceptions(runId, {}, 'created', 3, 0);
    const freeException = other.exceptions.find((e) => e.id !== exceptionId)!.id;
    const open = await investigations.startInvestigation({
      runId, exceptionId: freeException, model: 'm', promptVersion: 'a1',
    });
    await assert.rejects(
      investigations.concludeInvestigation(open.id, {
        verdict: 'RESOLUTION_PROPOSED', confidence: 'low', proposedAction: null,
        reasoning: [], citations: [], groundingPassed: true, groundingFailure: null,
        budgetExhausted: false, steps: 1, toolCalls: 0, tokensIn: null, tokensOut: null, costUsd: null,
      }),
      /inv_proposal_paired/,
      'a proposal must actually propose something',
    );
    // One live investigation per exception, until one FAILS.
    await assert.rejects(
      investigations.startInvestigation({
        runId, exceptionId: freeException, model: 'm', promptVersion: 'a1' }),
      /ux_inv_exc_active/,
    );
    await investigations.failInvestigation(open.id, 'loop threw');
    assert.equal((await investigations.findInvestigation(open.id))!.status, 'failed');
    const retry = await investigations.startInvestigation({
      runId, exceptionId: freeException, model: 'm', promptVersion: 'a1' });
    assert.equal(retry.status, 'running', 'a failed investigation frees the slot');
  });

  test('agent questions: record, list and the two quota counts', async () => {
    const before = new Date(Date.now() - 60 * 60 * 1000);
    await investigations.recordQuestion({
      runId, question: 'why is row 12 unmatched?', answer: 'no bank credit exists',
      citations: [bkId], steps: 2, toolCalls: 2, tokensIn: 300, tokensOut: 80,
      costUsd: 0.004, groundingPassed: true,
    });
    const list = await investigations.listQuestions(runId, 10);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]!.citations, [bkId]);

    // §9's TWO bounds, and they are different shapes on purpose: the per-run
    // ceiling is hard (no window, so spacing questions out must not defeat it)
    // and the hourly bucket is GLOBAL across the deployment.
    assert.equal(await investigations.countQuestionsForRun(runId), 1);
    assert.equal(await investigations.countQuestionsSince(before), 1);
    assert.equal(await investigations.countQuestionsSince(new Date(Date.now() + 60_000)), 0);
  });

  test('a question row honours a caller-minted id (U15 unit 3)', async () => {
    // The audit trail is stamped with this id BEFORE the row exists. If the
    // column defaulted instead, the trail would cite an id the row does not
    // have -- and the trail is the half a reader checks.
    const id = randomUUID();
    const row = await investigations.recordQuestion({
      id, runId, question: 'which merchant has the most exceptions?', answer: 'acme',
      citations: [], steps: 1, toolCalls: 1, tokensIn: 100, tokensOut: 20,
      costUsd: null, groundingPassed: false,
    });
    assert.equal(row.id, id);
  });

  // ── the TxClient contract ──────────────────────────────────────────────────

  test('every write accepts a TxClient and rolls back with its transaction', async () => {
    // Rule 14: anything taking a database client takes TxClient, not PoolClient.
    // This also proves the writes genuinely participate in the caller's
    // transaction rather than opening their own — a repository that silently
    // commits would make the orchestrator's rollback a no-op.
    const before = (await runs.listRuns(100, 0)).total;
    await assert.rejects(withTransaction(async (c) => {
      await runs.createRun({ label: 'rolled-back', configSnapshot: config }, c);
      throw new Error('abort');
    }), /abort/);
    assert.equal((await runs.listRuns(100, 0)).total, before, 'the insert must not survive');
  });
});
