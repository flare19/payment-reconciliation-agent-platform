import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, closePool, getPool } from '../../src/db/pool.js';
import { createApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import type { RunSources } from '../../src/services/run/orchestrator.js';

/**
 * Every endpoint over real HTTP, against a real database.
 *
 * The contract is BINDING and the frontend is built in a different session from
 * a different document — so the thing that must be true is not "the handler
 * compiles" but "a client that read api-contract.md gets what it expects". That
 * is only checkable by making the request.
 *
 * The bar here is wide rather than deep: reach every route, assert the shape the
 * contract promises, and pin the handful of fields the contract says must NEVER
 * be re-derived by a frontend or substituted when absent.
 */

const DB_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? null;
const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
const seed = (): RunSources => ({
  gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
  bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
  ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
});

const env = {
  databaseUrl: DB_URL ?? '', corsOrigins: [],
  geminiApiKey: null, explainModel: 'gemini-3.5-flash', agentModel: 'gemini-3.7-flash',
  llmExplainEnabled: false, llmMaxCallsPerRun: 8,
  agentEnabled: false, agentMaxInvestigationsPerRun: 5, agentMaxCostUsdPerRun: 1,
  agentMaxLlmRequestsPerRun: 220,
  agentQaEnabled: false, agentQaMaxQuestionsPerRun: 10,
} as unknown as Env;

describe('routes (integration)', { skip: DB_URL === null ? 'no TEST_DATABASE_URL' : false }, () => {
  let server: Server;
  let base: string;
  let runId: string;

  const req = async (
    method: string, path: string, body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown>; text: string }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* CSV, etc. */ }
    return { status: res.status, json, text };
  };

  before(async () => {
    createPool({ databaseUrl: DB_URL!, corsOrigins: [] } as never);
    await runMigrations(getPool());
    await getPool().query(`TRUNCATE runs, transactions, matches, match_members, exceptions,
      audit_log, audit_chain_heads, learned_aliases, explanation_cache, score_reports,
      agent_investigations, agent_questions CASCADE`);

    server = createApp(env, seed).listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;

    // 2 · POST /api/runs, then poll to completion (§5's async protocol).
    const created = await req('POST', '/api/runs', { useSeedDataset: true, datasetSeed: 90210, label: 'routes' });
    assert.equal(created.status, 202, created.text);
    runId = created.json['runId'] as string;

    for (let i = 0; i < 200; i += 1) {
      const poll = await req('GET', `/api/runs/${runId}`);
      const status = poll.json['status'];
      if (status === 'completed' || status === 'failed') {
        assert.equal(status, 'completed', JSON.stringify(poll.json['errorDetail']));
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('run did not finish');
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await closePool();
  });

  // ── conventions ────────────────────────────────────────────────────────────

  test('1 · health reports what is CONFIGURED, not what is desirable', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json['dbConnected'], true);
    // A deliberate configuration must not read as a failure (ADR-017).
    assert.equal(r.json['llmConfigured'], false);
  });

  test('an unknown path is INVALID_REQUEST, not RUN_NOT_FOUND', async () => {
    const r = await req('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal((r.json['error'] as Record<string, unknown>)['code'], 'INVALID_REQUEST');
  });

  test('errors use the uniform envelope, never a bare string', async () => {
    const r = await req('GET', '/api/runs/00000000-0000-4000-8000-000000000000');
    assert.equal(r.status, 404);
    const e = r.json['error'] as Record<string, unknown>;
    assert.equal(e['code'], 'RUN_NOT_FOUND');
    assert.equal(typeof e['message'], 'string');
    assert.deepEqual(e['details'], {});
  });

  // ── runs ───────────────────────────────────────────────────────────────────

  test('4 · RunDetail carries progress, the denominator terms and the file hashes', async () => {
    const r = await req('GET', `/api/runs/${runId}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json['progress'], { stage: 'completed', pct: 100 });
    assert.equal(r.json['referenceDate'], '2026-08-21');
    const c = r.json['recordCounts'] as Record<string, number>;
    assert.equal(c['reconcilable'], c['gateway'] + c['bank'] + c['ledger']
      - c['excluded']! - c['rejectedRows']! - c['nonPrimaryDuplicates']!);
    assert.match((r.json['inputFileHashes'] as Record<string, string>)['gateway']!, /^sha256:[0-9a-f]{64}$/);
    // S14 fills the headline. `falsePositiveMatches` stays null because it is a
    // MEASURED figure and lives in score_reports (ADR-041) — the engine must
    // never fill that slot with something it computed about itself.
    const h = r.json['headline'] as Record<string, unknown>;
    assert.equal(h['matchRatePct'], 65.22);
    assert.equal(h['coldStartMatchRatePct'], 65.22);
    assert.equal(h['exceptionCount'], 212);
    assert.equal(h['falsePositiveMatches'], null);
    // §11.5 rule 3: review burden travels WITH the match rate. This read named
    // the wrong metrics block until U8 and silently resolved to null.
    assert.equal(h['pendingReviewCount'], 71);
  });

  test('2 · an unknown configOverride is REJECTED, not silently ignored', async () => {
    // A caller who misspells a threshold and gets a 200 has run with the default
    // and will read the resulting match rate as if their setting applied.
    const r = await req('POST', '/api/runs',
      { useSeedDataset: true, configOverrides: { fuzzyAutoConfirmThreshhold: 0.9 } });
    assert.equal(r.status, 400);
    assert.equal((r.json['error'] as Record<string, unknown>)['code'], 'INVALID_REQUEST');
  });

  test('5 · metrics returns engine and measured TOGETHER, and measured is null', async () => {
    const r = await req('GET', `/api/runs/${runId}/metrics`);
    assert.equal(r.status, 200);
    assert.ok('engine' in r.json);
    // ADR-041: nothing has scored this run, so `measured` is null and the
    // frontend renders "not measured against ground truth". Substituting engine
    // figures into a slot labelled measured is the exact failure this whole
    // architecture exists to prevent.
    assert.equal(r.json['measured'], null);
    assert.equal(r.json['measuredAt'], null);
    assert.equal(r.json['scorerVersion'], null);
  });

  test('5 · metrics is 409 on a run that has not completed', async () => {
    const created = await req('POST', '/api/runs', { useSeedDataset: true, label: 'in-flight' });
    const r = await req('GET', `/api/runs/${created.json['runId'] as string}/metrics`);
    // Either it is still running (409) or it finished between the two calls.
    if (r.status !== 200) {
      assert.equal(r.status, 409);
      assert.equal((r.json['error'] as Record<string, unknown>)['code'], 'RUN_NOT_COMPLETE');
    }
  });

  test('6 · the exception list paginates, facets and filters', async () => {
    const r = await req('GET', `/api/runs/${runId}/exceptions?pageSize=5`);
    assert.equal(r.status, 200);
    const items = r.json['exceptions'] as Record<string, unknown>[];
    assert.equal(items.length, 5);
    assert.deepEqual(r.json['pagination'], { page: 1, pageSize: 5, total: 212, totalPages: 43 });

    const facets = r.json['facets'] as Record<string, Record<string, number>>;
    assert.equal(facets['category']!['MISSING_IN_GATEWAY'], 53);
    assert.equal(facets['severity']!['high'], 101);

    // Default sort is severity then money at risk — ADR-044's whole point.
    assert.equal(items[0]!['severity'], 'high');
    // Deterministic, rule-derived, never an LLM judgement.
    assert.ok(['resolvable_by_human', 'needs_external_data', 'unresolvable_from_sources']
      .includes(items[0]!['resolvability'] as string));
    assert.equal(typeof items[0]!['amountAtRiskDisplay'], 'string');

    const filtered = await req('GET', `/api/runs/${runId}/exceptions?category=AMOUNT_MISMATCH`);
    assert.equal((filtered.json['pagination'] as Record<string, number>)['total'], 18);
  });

  test('6 · an unknown filter value is a 400, not an unfiltered list', async () => {
    const r = await req('GET', `/api/runs/${runId}/exceptions?severity=catastrophic`);
    assert.equal(r.status, 400);
  });

  test('7 · ExceptionDetail carries rule-engine evidence and record previews', async () => {
    const list = await req('GET', `/api/runs/${runId}/exceptions?pageSize=50`);
    const withCandidates = (list.json['exceptions'] as Record<string, unknown>[])
      .find((e) => (e['bestCandidateScore'] as number | null) !== null);
    assert.ok(withCandidates, 'the holdout must produce at least one scored exception');

    const r = await req('GET', `/api/exceptions/${withCandidates!['exceptionId'] as string}`);
    assert.equal(r.status, 200);
    const ev = r.json['evidence'] as Record<string, unknown>;
    assert.equal(typeof ev['candidatesConsidered'], 'number');
    assert.equal(typeof r.json['detectedByRule'], 'string');
    for (const c of ev['candidates'] as Record<string, unknown>[]) {
      // `rejectedBecause` is generated by the RULE ENGINE, not the LLM — it must
      // render with the explain layer disabled, which it is in this test.
      assert.equal(typeof c['rejectedBecause'], 'string');
    }
  });

  test('8 · MatchSummary computes countsTowardEngineMatchRate server-side', async () => {
    const r = await req('GET', `/api/runs/${runId}/matches?pageSize=10`);
    assert.equal(r.status, 200);
    for (const m of r.json['matches'] as Record<string, unknown>[]) {
      // The frontend must NOT re-derive this. A browse list that counted human
      // fixes as engine matches would overstate the number the project exists
      // to state honestly.
      assert.equal(m['countsTowardEngineMatchRate'],
        m['tier'] !== 'manual' && m['status'] !== 'human_rejected');
      assert.ok(['gateway', 'bank', 'ledger'].includes(m['headlineAmountSource'] as string));
      assert.equal(typeof m['headlineAmountDisplay'], 'string');
    }
  });

  test('9 · the review queue is WEAKEST first, and explains why each was flagged', async () => {
    const r = await req('GET', `/api/runs/${runId}/review-queue?pageSize=5`);
    assert.equal(r.status, 200);
    const items = r.json['items'] as Record<string, unknown>[];
    assert.ok(items.length > 0);
    const scores = items.map((i) => i['confidence'] as number);
    assert.deepEqual(scores, [...scores].sort((a, b) => a - b),
      "a reviewer's time belongs where the engine was least sure");
    assert.equal(typeof items[0]!['whyFlagged'], 'string');
  });

  test('12 · TransactionDetail exposes rawPayload and exactly one navigation link', async () => {
    const matches = await req('GET', `/api/runs/${runId}/matches?pageSize=1`);
    const member = ((matches.json['matches'] as Record<string, unknown>[])[0]!['members'] as
      Record<string, unknown>[])[0]!;
    const r = await req('GET', `/api/transactions/${member['transactionId'] as string}`);
    assert.equal(r.status, 200);
    // The POINT of this endpoint: the raw row beside what the parser made of it.
    assert.equal(typeof r.json['rawPayload'], 'object');
    assert.ok(r.json['membership'] !== null, 'a matched record links to its match');
  });

  test('13 + 14 · audit trails paginate and sort by sequenceNo ascending', async () => {
    const run = await req('GET', `/api/runs/${runId}/audit?pageSize=10`);
    assert.equal(run.status, 200);
    const entries = run.json['entries'] as Record<string, unknown>[];
    const seqs = entries.map((e) => e['sequenceNo'] as number);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(entries[0]!['eventType'], 'RUN_STARTED', 'the anchor comes first');
    assert.equal((run.json['pagination'] as Record<string, number>)['total'], 591);

    const byActor = await req('GET', `/api/runs/${runId}/audit?actorType=engine`);
    assert.equal((byActor.json['pagination'] as Record<string, number>)['total'], 591);
    const byEvent = await req('GET', `/api/runs/${runId}/audit?eventType=RECORD_DEDUPLICATED`);
    assert.equal((byEvent.json['pagination'] as Record<string, number>)['total'], 9);
  });

  test('22 · chain verification returns nine fields, including `anchored` (issue #28)', async () => {
    const r = await req('GET', `/api/runs/${runId}/audit/verify`);
    assert.equal(r.status, 200);
    assert.equal(r.json['valid'], true);
    // A hash chain proves the entries you HOLD are consistent and cannot prove
    // you hold all of them. Without the anchor, deleting the tail reads as clean.
    assert.equal(r.json['anchored'], true);
    assert.equal(r.json['entriesChecked'], 591);
    assert.equal(r.json['firstDivergenceSequenceNo'], null);
  });

  test('24 · population lists every row outside the denominator, with its reason', async () => {
    for (const kind of ['excluded', 'rejected', 'duplicates']) {
      const r = await req('GET', `/api/runs/${runId}/population?kind=${kind}`);
      assert.equal(r.status, 200, kind);
      for (const item of r.json['items'] as Record<string, unknown>[]) {
        // Excluded is not hidden: counted, listed, and carrying its reason.
        assert.equal(typeof item['reason'], 'string');
      }
    }
    const dupes = await req('GET', `/api/runs/${runId}/population?kind=duplicates`);
    assert.equal((dupes.json['pagination'] as Record<string, number>)['total'], 9);
  });

  test('19 · CSV export quotes cells containing commas and quotes', async () => {
    const r = await req('GET', `/api/runs/${runId}/export?scope=exceptions`);
    assert.equal(r.status, 200);
    const lines = r.text.split('\n');
    assert.match(lines[0]!, /^exceptionId,category/);
    assert.equal(lines.length, 213, 'header plus every exception');
    const matches = await req('GET', `/api/runs/${runId}/export?scope=matches`);
    assert.equal(matches.text.split('\n').length, 285);
  });

  // ── human actions ──────────────────────────────────────────────────────────

  test('10 + 11 · approve is idempotent; reject requires a stated reason', async () => {
    const queue = await req('GET', `/api/runs/${runId}/review-queue?pageSize=2`);
    const [first, second] = queue.json['items'] as Record<string, unknown>[];

    const approved = await req('POST', `/api/matches/${first!['matchId'] as string}/approve`,
      { reviewedBy: 'tejas', note: 'checked the RRN by hand' });
    assert.equal(approved.status, 200, approved.text);
    assert.equal((approved.json['match'] as Record<string, unknown>)['status'], 'human_confirmed');
    assert.equal((approved.json['auditEntryIds'] as number[]).length, 1);

    // §0: re-approving returns 200 with the existing state, not an error.
    const again = await req('POST', `/api/matches/${first!['matchId'] as string}/approve`,
      { reviewedBy: 'tejas' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json['auditEntryIds'], []);

    // A rejection with no reason is a hole in the audit trail.
    const noReason = await req('POST', `/api/matches/${second!['matchId'] as string}/reject`,
      { reviewedBy: 'tejas' });
    assert.equal(noReason.status, 400);

    const rejected = await req('POST', `/api/matches/${second!['matchId'] as string}/reject`,
      { reviewedBy: 'tejas', reason: 'different customers' });
    assert.equal(rejected.status, 200);
    assert.equal((rejected.json['match'] as Record<string, unknown>)['status'], 'human_rejected');
    assert.equal((rejected.json['match'] as Record<string, unknown>)['countsTowardEngineMatchRate'], false);
  });

  test('20 · resolve requires a note, and a second attempt is 409', async () => {
    const list = await req('GET', `/api/runs/${runId}/exceptions?pageSize=1`);
    const id = (list.json['exceptions'] as Record<string, unknown>[])[0]!['exceptionId'] as string;

    assert.equal((await req('POST', `/api/exceptions/${id}/resolve`,
      { resolvedBy: 'tejas', resolution: 'human_resolved' })).status, 400);

    const ok = await req('POST', `/api/exceptions/${id}/resolve`,
      { resolvedBy: 'tejas', resolution: 'human_resolved', note: 'raised with the bank' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((ok.json['exception'] as Record<string, unknown>)['status'], 'human_resolved');

    const twice = await req('POST', `/api/exceptions/${id}/resolve`,
      { resolvedBy: 'someone', resolution: 'wont_fix', note: 'no' });
    assert.equal(twice.status, 409);
    assert.equal((twice.json['error'] as Record<string, unknown>)['code'], 'EXCEPTION_ALREADY_RESOLVED');
  });

  test('21 · a manual match is tier `manual` and does NOT count as an engine match', async () => {
    const pop = await req('GET', `/api/runs/${runId}/population?kind=excluded&pageSize=200`);
    const unmatched = await req('GET', `/api/runs/${runId}/exceptions?category=MISSING_IN_BANK&pageSize=2`);
    const ids = (unmatched.json['exceptions'] as Record<string, unknown>[])
      .map((e) => (e['primaryRecord'] as Record<string, unknown>)['transactionId'] as string);
    assert.equal(ids.length, 2);
    assert.ok(pop.status === 200);

    const r = await req('POST', `/api/runs/${runId}/matches`, {
      createdBy: 'tejas', reason: 'same payment, reference was truncated in the bank file',
      members: ids.map((transactionId) => ({ transactionId })),
    });
    // Both legs are unmatched MISSING_IN_BANK records from the same source, so
    // the group is same-source and the engine refuses it — or they differ and it
    // succeeds. Either is a legitimate contract outcome; what must NOT happen is
    // a manual match counting toward the engine's rate.
    if (r.status === 201) {
      const m = r.json['match'] as Record<string, unknown>;
      assert.equal(m['tier'], 'manual');
      assert.equal(m['countsTowardEngineMatchRate'], false,
        'a human asserting two records are the same is not the engine matching them');
    } else {
      assert.ok([400, 409].includes(r.status), r.text);
    }
  });

  // ── aliases ────────────────────────────────────────────────────────────────

  test('15–18 · create, supersede-with-penalty, revoke, lineage', async () => {
    const created = await req('POST', '/api/aliases', {
      aliasType: 'merchant_name', rawValue: 'AMZN',
      canonicalValue: 'AMAZON RETAIL', createdBy: 'tejas',
    });
    assert.equal(created.status, 201, created.text);
    const alias = created.json['alias'] as Record<string, unknown>;
    assert.equal(alias['eligibleForAliasTier'], true);

    const conflict = await req('POST', '/api/aliases', {
      aliasType: 'merchant_name', rawValue: 'AMZN',
      canonicalValue: 'AMAZON INDIA', createdBy: 'someone-else',
    });
    assert.equal(conflict.status, 201);
    const penalised = conflict.json['alias'] as Record<string, unknown>;
    // §6.3's penalty: the first contested application falls back to human
    // review rather than auto-resolving.
    assert.equal(penalised['conflictCount'], 1);
    assert.equal(penalised['eligibleForAliasTier'], false);
    assert.ok(conflict.json['superseded'] !== null, 'the old row must be superseded, not overwritten');

    // Never edited in place.
    const badPatch = await req('PATCH', `/api/aliases/${penalised['aliasId'] as string}`,
      { canonicalValue: 'SOMETHING ELSE' });
    assert.equal(badPatch.status, 400);

    const history = await req('GET', `/api/aliases/${penalised['aliasId'] as string}/history`);
    assert.equal(history.status, 200);
    assert.equal((history.json['lineage'] as unknown[]).length, 2);
    assert.ok((history.json['entries'] as unknown[]).length >= 2, 'every assertion is audited');

    const revoked = await req('PATCH', `/api/aliases/${penalised['aliasId'] as string}`,
      { status: 'revoked', revokedReason: 'wrong merchant', actor: 'tejas' });
    assert.equal(revoked.status, 200);
    assert.equal((revoked.json['alias'] as Record<string, unknown>)['status'], 'revoked');

    const active = await req('GET', '/api/aliases?status=active');
    assert.equal((active.json['pagination'] as Record<string, number>)['total'], 0);
  });

  test('16 · a self-alias is refused with INVALID_ALIAS, not a constraint name', async () => {
    const r = await req('POST', '/api/aliases', {
      aliasType: 'merchant_name', rawValue: 'SAME', canonicalValue: 'SAME', createdBy: 'tejas',
    });
    assert.equal(r.status, 400);
    assert.equal((r.json['error'] as Record<string, unknown>)['code'], 'INVALID_ALIAS');
  });

  // ── the agent ──────────────────────────────────────────────────────────────

  test('25–28 · the Analyst reports AGENT_DISABLED rather than faking a result', async () => {
    // A legitimate operating state, not a placeholder: a deploy without an API
    // key is a real configuration the frontend already has to handle. Returning
    // an empty investigation would say the agent ran and found nothing.
    const list = await req('GET', `/api/runs/${runId}/exceptions?pageSize=1`);
    const excId = (list.json['exceptions'] as Record<string, unknown>[])[0]!['exceptionId'] as string;

    const investigate = await req('POST', `/api/exceptions/${excId}/investigate`, {});
    assert.equal(investigate.status, 503);
    assert.equal((investigate.json['error'] as Record<string, unknown>)['code'], 'AGENT_DISABLED');

    const ask = await req('POST', `/api/runs/${runId}/ask`, { question: 'why is row 12 unmatched?' });
    assert.equal(ask.status, 503);

    // Reads work now: an empty list is a TRUE statement about a run nobody has
    // investigated.
    const investigations = await req('GET', `/api/runs/${runId}/investigations`);
    assert.equal(investigations.status, 200);
    assert.deepEqual(investigations.json['investigations'], []);
    const metrics = investigations.json['agentMetrics'] as Record<string, number>;
    // ADR-053 makes this a build blocker, not a metric — reported beside the
    // rest rather than buried.
    assert.equal(metrics['hallucinatedResolutions'], 0);
  });

  // ── the scorer's entry point ───────────────────────────────────────────────

  test('23 · a score report against different bytes is refused (TRUTH_KEY_MISMATCH)', async () => {
    const wrong = await req('POST', `/api/runs/${runId}/score-report`, {
      truthKeyFile: 'data/truth/holdout_seed_90210.json',
      truthKeyHash: 'a'.repeat(64), scorerVersion: '1.0.0',
      inputFileHashes: { gateway: 'sha256:deadbeef', bank: 'sha256:deadbeef', ledger: 'sha256:deadbeef' },
      report: { pairPrecision: 1 },
    });
    assert.equal(wrong.status, 422);
    assert.equal((wrong.json['error'] as Record<string, unknown>)['code'], 'TRUTH_KEY_MISMATCH');

    const run = await req('GET', `/api/runs/${runId}`);
    const ok = await req('POST', `/api/runs/${runId}/score-report`, {
      truthKeyFile: 'data/truth/holdout_seed_90210.json',
      truthKeyHash: 'b'.repeat(64), scorerVersion: '1.0.0',
      inputFileHashes: run.json['inputFileHashes'],
      report: { pairPrecision: 1, pairRecall: 0.395 },
    });
    assert.equal(ok.status, 201, ok.text);

    // Re-posting the same measurement must not replace a number already read.
    const again = await req('POST', `/api/runs/${runId}/score-report`, {
      truthKeyFile: 'data/truth/holdout_seed_90210.json',
      truthKeyHash: 'b'.repeat(64), scorerVersion: '1.0.0',
      report: { pairRecall: 0.99 },
    });
    assert.equal(again.status, 200);
    assert.equal(again.json['alreadyRecorded'], true);

    // And now endpoint 5 composes both objects.
    const metrics = await req('GET', `/api/runs/${runId}/metrics`);
    assert.deepEqual(metrics.json['measured'], { pairPrecision: 1, pairRecall: 0.395 });
    assert.equal(metrics.json['scorerVersion'], '1.0.0');
  });
});
