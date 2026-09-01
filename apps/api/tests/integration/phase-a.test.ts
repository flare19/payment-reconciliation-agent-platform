import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runMigrations } from '../../src/db/migrate.js';
import { createPool, closePool, getPool } from '../../src/db/pool.js';
import { ENGINE_DEFAULTS, AGENT_DEFAULTS } from '../../src/config/defaults.js';
import { createRun, findRun } from '../../src/repositories/runs.js';
import { listExceptionTriageCandidates } from '../../src/repositories/exceptions.js';
import {
  findInvestigation, findInvestigationForException, agentMetrics,
} from '../../src/repositories/investigations.js';
import { findCorroborationForMatch } from '../../src/repositories/corroborations.js';
import { listQueueTriageCandidates } from '../../src/repositories/matches.js';
import { verifyRunChain } from '../../src/repositories/audit.js';
import { executeRun } from '../../src/services/run/orchestrator.js';
import {
  runPhaseA, investigateOne, corroborateOne, type PhaseADeps,
} from '../../src/services/agent/phase-a.js';
import { ELIGIBLE_CATEGORIES } from '../../src/services/agent/triage.js';
import { withRateLimit } from '../../src/services/agent/rate-limiter.js';
import type { AgentLlmClient, AgentTurnResult } from '../../src/services/agent/agent-client.js';
import type { RunConfig } from '../../src/types/engine.js';

/**
 * Phase A over a REAL finished run, with a scripted client.
 *
 * The properties under test are the ones that cannot be checked without a
 * database: that verdicts persist, that the audit chain still verifies with
 * agent entries interleaved, and — most importantly — that ADR-048 holds:
 * Phase A reads the engine's output and changes none of it.
 */

const DB_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? null;
const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
const sources = {
  gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
  bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
  ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
};

/** Calls get_exception once, then concludes citing what that tool returned. */
function scriptedClient(): AgentLlmClient {
  const perInvestigation = new Map<string, number>();
  let lastIds: string[] = [];
  return {
    model: 'scripted-model',
    async turn(request) {
      // Identify the investigation by its opening prompt.
      const key = request.messages[0]!.role === 'user'
        ? (request.messages[0] as { text: string }).text.slice(0, 60) : 'x';
      const n = (perInvestigation.get(key) ?? 0) + 1;
      perInvestigation.set(key, n);

      if (n === 1) {
        const exceptionId = /EXCEPTION (\S+)/.exec(
          (request.messages[0] as { text: string }).text)?.[1] ?? '';
        return {
          ok: true, kind: 'tool_call', text: 'let me look at the exception',
          calls: [{ id: 'c1', name: 'get_exception', args: { exceptionId } }],
          usage: { tokensIn: 1200, tokensOut: 40 },
        } satisfies AgentTurnResult;
      }
      // Cite exactly what the tool returned, echoing the digest A3 checks.
      const results = request.messages.filter((m) => m.role === 'tool_result');
      const last = results.at(-1) as { content: string } | undefined;
      let digest = '';
      try {
        const parsed = JSON.parse(last?.content ?? '{}') as {
          resultDigest?: string; result?: { exceptionId?: string; transactionId?: string };
        };
        digest = parsed.resultDigest ?? '';
        lastIds = [parsed.result?.exceptionId, parsed.result?.transactionId]
          .filter((x): x is string => typeof x === 'string');
      } catch { /* leave empty */ }

      return {
        ok: true, kind: 'final',
        text: JSON.stringify({
          verdict: 'CONFIRMED_UNRESOLVABLE', confidence: 'medium',
          summary: 'the engine considered every available counterpart and none fits',
          citations: lastIds,
          reasoning: [{ step: 1, tool: 'get_exception', arguments: {},
            resultDigest: digest, inference: 'the evidence names no viable counterpart' }],
          proposedAction: null,
        }),
        usage: { tokensIn: 2400, tokensOut: 220 },
      } satisfies AgentTurnResult;
    },
  };
}

describe('Phase A (integration)',
  { skip: DB_URL === null ? 'no TEST_DATABASE_URL' : false }, () => {
    let runId: string;
    let config: RunConfig;
    let deps: PhaseADeps;
    /** Exception ids the FIRST test in this file already investigated (#57's tests avoid them). */
    const ourInvestigated = new Set<string>();

    before(async () => {
      createPool({ databaseUrl: DB_URL!, corsOrigins: [] } as never);
      await runMigrations(getPool());
      await getPool().query(`TRUNCATE runs, transactions, matches, match_members, exceptions,
        audit_log, audit_chain_heads, learned_aliases, explanation_cache, score_reports,
        agent_investigations, agent_questions CASCADE`);
      const run = await createRun({
        label: 'phase-a', datasetSeed: 90210,
        configSnapshot: { ...ENGINE_DEFAULTS, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
      });
      runId = run.id;
      const out = await executeRun(runId, sources, ENGINE_DEFAULTS);
      assert.equal(out.status, 'completed', out.errorDetail ?? '');
      config = (await findRun(runId))!.configSnapshot as RunConfig;
      deps = {
        client: scriptedClient(), config,
        cost: { inputUsdPerMillion: 5, outputUsdPerMillion: 25 },
      };
    });
    after(async () => { await closePool(); });

    test('one investigation persists a verdict, its citations and its cost', async () => {
      const candidate = (await listExceptionTriageCandidates(
        runId, ELIGIBLE_CATEGORIES, 1))[0]!;
      ourInvestigated.add(candidate.exceptionId);
      const { investigationId, outcome } = await investigateOne(
        runId, candidate.exceptionId, deps, {
          runId, records: new Map(), activeAliases: new Map(),
        });

      const stored = await findInvestigation(investigationId);
      assert.ok(stored);
      assert.equal(stored!.status, 'concluded');
      assert.equal(stored!.verdict, 'CONFIRMED_UNRESOLVABLE');
      assert.equal(stored!.confidence, 'medium');
      assert.equal(stored!.exceptionId, candidate.exceptionId);
      assert.equal(stored!.model, 'scripted-model');
      assert.equal(stored!.steps, outcome.steps);
      assert.equal(stored!.toolCalls, outcome.toolCalls.length);
      assert.equal(stored!.tokensIn, 3600);
      assert.equal(stored!.tokensOut, 260);
      // 3600 in at $5/M + 260 out at $25/M.
      assert.ok(Math.abs(stored!.costUsd! - (3600 * 5 + 260 * 25) / 1e6) < 1e-9);
      assert.equal(stored!.groundingPassed, true);
      assert.ok(stored!.citations.length > 0, 'it cited what the tool returned');
      assert.ok(stored!.reasoning.length > 0);
    });

    test('the reasoning chain stores the RUNTIME digest, not the model\'s word for it', async () => {
      const { rows } = await getPool().query<{ reasoning: { resultDigest: string }[] }>(
        `SELECT reasoning FROM agent_investigations WHERE run_id=$1 LIMIT 1`, [runId]);
      const step = rows[0]!.reasoning[0]!;
      // `label#<12 hex>` since ADR-093: a checksum the model can actually copy,
      // not 1,192 characters of result JSON it has to reproduce byte-for-byte.
      assert.match(step.resultDigest, /^get_exception:sha256:[0-9a-f]{12}$/,
        'the digest is the tool\'s own checksum, recorded by the runtime');
    });

    test('the audit trail is written AS IT HAPPENS, one entry per tool call (§3)', async () => {
      const { rows } = await getPool().query<{ event_type: string; c: number }>(
        `SELECT event_type, count(*)::int c FROM audit_log
          WHERE run_id=$1 AND actor_type='agent' GROUP BY 1 ORDER BY 1`, [runId]);
      const by = Object.fromEntries(rows.map((r) => [r.event_type, r.c]));
      assert.equal(by['INVESTIGATION_STARTED'], 1);
      assert.equal(by['AGENT_TOOL_CALLED'], 1);
      assert.equal(by['INVESTIGATION_CONCLUDED'], 1);
      // Nothing failed, so neither honesty event fires. ABSENT, not zero.
      assert.equal(by['AGENT_GROUNDING_FAILED'], undefined);
      assert.equal(by['AGENT_BUDGET_EXHAUSTED'], undefined);
    });

    test('agent entries are actor_type=agent and do not break the hash chain', async () => {
      // ADR-052: agent traces live in `audit_log` and are hash-chained for free.
      // That is only true if interleaving them leaves the chain verifiable.
      const v = await verifyRunChain(runId);
      assert.equal(v.valid, true);
      assert.equal(v.anchored, true);
      assert.equal(v.firstDivergenceSequenceNo, null);
      const { rows } = await getPool().query<{ actor_id: string }>(
        `SELECT DISTINCT actor_id FROM audit_log WHERE run_id=$1 AND actor_type='agent'`,
        [runId]);
      assert.deepEqual(rows.map((r) => r.actor_id), ['analyst@1.0.0']);
    });

    test('ADR-048: Phase A changed NOTHING the engine wrote', async () => {
      // The property the whole design exists to hold. If any of these moved,
      // the measured accuracy number stops meaning what it claims.
      const { rows } = await getPool().query<{
        m: number; e: number; mm: number; sev: number; cat: number;
      }>(
        `SELECT (SELECT count(*)::int FROM matches WHERE run_id=$1) m,
                (SELECT count(*)::int FROM exceptions WHERE run_id=$1) e,
                (SELECT count(*)::int FROM match_members mm
                   JOIN matches x ON x.id=mm.match_id WHERE x.run_id=$1) mm,
                (SELECT count(*)::int FROM exceptions
                  WHERE run_id=$1 AND severity='high') sev,
                (SELECT count(DISTINCT category)::int FROM exceptions WHERE run_id=$1) cat`,
        [runId]);
      assert.equal(rows[0]!.m, 284);
      assert.equal(rows[0]!.e, 212);
      assert.equal(rows[0]!.mm, 789);
      assert.equal(rows[0]!.cat, 7);
      const run = await findRun(runId);
      const metrics = run!.metrics as Record<string, Record<string, number>>;
      assert.equal(metrics['matchRate']!['matchRatePct'], 65.22);
      assert.equal(metrics['matchRate']!['matchedRecords'], 570);
    });

    test('a full phase investigates the triaged list and reports what it did', async () => {
      await getPool().query(`DELETE FROM agent_investigations WHERE run_id=$1`, [runId]);
      const result = await runPhaseA(runId, {
        ...deps, client: scriptedClient(),
        budget: { ...AGENT_DEFAULTS.budget, maxSteps: 4 },
      });
      assert.equal(result.investigated, 20, 'the A1 cap');
      assert.equal(result.corroborated, 15, 'the A1b cap (ADR-081)');
      assert.equal(result.corroborationVerdicts['CONFIRMED_UNRESOLVABLE'], undefined,
        'an investigation verdict must never appear in the corroboration tally');
      assert.equal(result.skippedForBudget, 0);
      assert.equal(result.verdicts['CONFIRMED_UNRESOLVABLE'], 20);
      assert.equal(result.groundingFailures, 0);
      assert.equal(result.budgetExhaustedCount, 0);
      // 20 investigations + 15 corroborations, two turns each.
      assert.equal(result.requestsSpent, 70);
      // The scripted client emits CONFIRMED_UNRESOLVABLE — an INVESTIGATION
      // verdict — so every corroboration correctly fails the corroboration
      // gate. The vocabularies are disjoint and neither accepts the other's.
      assert.equal(result.corroborationGroundingFailures, 15);
      assert.equal(result.corroborationVerdicts['NO_NEW_EVIDENCE'], 15,
        'a rejected corroboration downgrades to the honest floor');
      assert.ok(result.costUsd! > 0);
      assert.ok(result.plan.investigationsSkipped > 0, 'more were eligible than the cap allows');

      const m = await agentMetrics(runId);
      assert.equal(m.total, 20);
      assert.equal(m.groundingFailures, 0);
    });

    test('the shared request budget stops the phase, and the stop is REPORTED', async () => {
      // A1 applies only the per-list caps; the shared budget is spent here.
      await getPool().query(`DELETE FROM agent_investigations WHERE run_id=$1`, [runId]);
      const result = await runPhaseA(runId, {
        ...deps, client: scriptedClient(),
        budget: { ...AGENT_DEFAULTS.budget, maxSteps: 10 },
        maxLlmRequests: 35,
      });
      // RESERVE the worst case, CHARGE the actual. An investigation is started
      // only if its 10-step ceiling still fits, but it is charged what it really
      // spent — here 2 turns each. So 13 run (26 spent; a 14th would need
      // 26 + 10 = 36 > 35) rather than the 3 a ceiling-charging design allows.
      //
      // That distinction is the same one the triage rewrite turned on: charging
      // the ceiling starves the work list on a worst case that rarely happens.
      assert.equal(result.investigated, 13);
      assert.equal(result.corroborated, 0,
        'ADR-081: the queue is what gets cut when the request budget binds');
      assert.equal(result.requestsSpent, 26);
      assert.ok(result.requestsSpent + 10 > 35, 'it stopped exactly when one more could not fit');
      assert.ok(result.requestsSpent <= 35, 'and never exceeded the shared budget');
      assert.equal(result.skippedForBudget, 20 - 13);
    });

    test('with pacing wired, requestsSpent counts the retry a step count cannot see', async () => {
      // A retried 429 is a second BILLABLE request inside ONE step. The loop
      // counts steps, so that request is structurally invisible to it —
      // harmless against a request quota, and a hole in a dollar-denominated
      // cap. This pins the fix by running the SAME phase twice: once blind,
      // once reading the pacing layer's real count.
      const flaky = (): AgentLlmClient => {
        const scripted = scriptedClient();
        let failed = false;
        return {
          model: scripted.model,
          async turn(request) {
            if (!failed) {
              failed = true;
              return {
                ok: false, reason: 'transport', detail: '429 RESOURCE_EXHAUSTED',
                usage: { tokensIn: 10, tokensOut: 0 }, retryable: true,
              } satisfies AgentTurnResult;
            }
            return scripted.turn(request);
          },
        };
      };
      // Limits far above anything this test reaches: the point is the COUNT,
      // and a binding budget would make the two runs do different amounts of
      // work rather than the same work counted two ways.
      const pace = (c: AgentLlmClient) => withRateLimit(c, {
        maxRetries: 2, baseBackoffMs: 0,
        maxRequestsPerMinute: 1_000_000, maxTokensPerMinute: Number.MAX_SAFE_INTEGER,
        now: () => 0, sleep: async () => { /* tests never wait */ },
      });
      const opts = { budget: { ...AGENT_DEFAULTS.budget, maxSteps: 4 } };

      await getPool().query(`DELETE FROM agent_investigations WHERE run_id=$1`, [runId]);
      const blind = pace(flaky());
      const control = await runPhaseA(runId, { ...deps, client: blind.client, ...opts });

      await getPool().query(`DELETE FROM agent_investigations WHERE run_id=$1`, [runId]);
      const seen = pace(flaky());
      const wired = await runPhaseA(runId, {
        ...deps, client: seen.client, ...opts,
        requestsIssued: () => seen.stats().requestsIssued,
      });

      assert.equal(seen.stats().retries, 1, 'exactly one retry to account for');
      assert.equal(control.investigated, wired.investigated, 'same work both times');
      // Two turns each, derived rather than hard-coded: earlier tests in this
      // file leave corroborations behind, so the absolute total is cross-test
      // state. The RELATIONSHIP is what this test owns.
      assert.ok(control.requestsSpent > 0);
      assert.equal(control.requestsSpent,
        (control.investigated + control.corroborated) * 2,
        'the step count, blind to the retry');
      assert.equal(wired.requestsSpent, seen.stats().requestsIssued,
        'the wired figure IS the billable request count');
      assert.equal(wired.requestsSpent, control.requestsSpent + 1,
        'exactly one higher — and that gap is what went unbilled before');
    });

    test('a grounding failure is PERSISTED and gets its own audit event', async () => {
      // §7 reads this count as a signal the prompt or tools need work.
      // Suppressing one would corrupt the only metric that detects drift.
      await getPool().query(`DELETE FROM agent_investigations WHERE run_id=$1`, [runId]);
      const liar: AgentLlmClient = {
        model: 'lying-model',
        async turn() {
          return {
            ok: true, kind: 'final',
            text: JSON.stringify({
              verdict: 'RESOLUTION_PROPOSED', confidence: 'high',
              summary: 'these obviously match',
              citations: ['99999999-9999-9999-9999-999999999999'],
              reasoning: [], proposedAction: { type: 'MARK_WONT_FIX', rationale: 'trust me' },
            }),
            usage: { tokensIn: 100, tokensOut: 50 },
          };
        },
      };
      const candidate = (await listExceptionTriageCandidates(
        runId, ELIGIBLE_CATEGORIES, 1))[0]!;
      const { investigationId } = await investigateOne(
        runId, candidate.exceptionId, { ...deps, client: liar },
        { runId, records: new Map(), activeAliases: new Map() });

      const stored = await findInvestigation(investigationId);
      assert.equal(stored!.groundingPassed, false);
      assert.equal(stored!.verdict, 'INSUFFICIENT_EVIDENCE',
        'a hallucinated citation is downgraded, never persisted as a proposal');
      assert.deepEqual(stored!.citations, [], 'no unverified citation reaches the database');
      assert.notEqual(stored!.groundingFailure, null);

      // Scoped to THIS investigation: earlier tests in the file leave their own
      // grounding failures behind, and a run-wide count would measure them too.
      const { rows } = await getPool().query<{ c: number }>(
        `SELECT count(*)::int c FROM audit_log
          WHERE run_id=$1 AND event_type='AGENT_GROUNDING_FAILED'
            AND subject_id=$2`, [runId, investigationId]);
      assert.equal(rows[0]!.c, 1);
    });

    test('#57: a throw after startInvestigation leaves the row FAILED, not stuck at running, '
      + 'and the exception is investigable again', async () => {
      const throwing: AgentLlmClient = {
        model: 'throwing-model',
        async turn() { throw new Error('simulated transport failure'); },
      };
      // A fresh exception, never investigated by an earlier test in this file.
      const candidate = (await listExceptionTriageCandidates(runId, ELIGIBLE_CATEGORIES, 25))
        .find((c) => !ourInvestigated.has(c.exceptionId));
      assert.ok(candidate, 'need an exception no earlier test in this file has investigated');
      ourInvestigated.add(candidate!.exceptionId);

      await assert.rejects(
        () => investigateOne(runId, candidate!.exceptionId, { ...deps, client: throwing }, {
          runId, records: new Map(), activeAliases: new Map(),
        }),
        /investigation of exception .* failed: simulated transport failure/);

      const failedRow = await findInvestigationForException(candidate!.exceptionId);
      assert.ok(failedRow, 'startInvestigation must have persisted a row before the throw');
      assert.equal(failedRow!.status, 'failed',
        'a throw must not leave the row at status=running -- ux_inv_exc_active would then '
        + 'permanently block this exception from ever being investigated again');

      // ux_inv_exc_active is `UNIQUE (exception_id) WHERE status <> 'failed'` -- this second
      // call only succeeds if the first row genuinely reached 'failed', not merely 'running'.
      const { investigationId } = await investigateOne(
        runId, candidate!.exceptionId, deps, {
          runId, records: new Map(), activeAliases: new Map(),
        });
      const stored = await findInvestigation(investigationId);
      assert.equal(stored!.status, 'concluded', 'the exception must be investigable again');
    });

    test('#57: the same throw-and-recover property holds for a corroboration', async () => {
      const throwing: AgentLlmClient = {
        model: 'throwing-model',
        async turn() { throw new Error('simulated transport failure'); },
      };
      // A match no earlier test in this file has corroborated. `ux_corr_match_active`
      // is UNIQUE (match_id) WHERE status <> 'failed', so reusing one that already
      // has a live row fails at INSERT and never reaches the property under test.
      const queue = await listQueueTriageCandidates(runId, 25);
      const { rows: taken } = await getPool().query<{ match_id: string }>(
        `SELECT match_id FROM agent_corroborations WHERE status <> 'failed'`);
      const used = new Set(taken.map((r) => r.match_id));
      const candidate = queue.find((c) => !used.has(c.matchId));
      assert.ok(candidate, 'need a pending_review match with no live corroboration');

      await assert.rejects(
        () => corroborateOne(runId, candidate!.matchId, { ...deps, client: throwing }, {
          runId, records: new Map(), activeAliases: new Map(),
        }),
        /corroboration of match .* failed: simulated transport failure/);

      // NOT `findCorroborationForMatch` -- it filters `status <> 'failed'` (it answers
      // "is one already live for this match"), so a correctly-FAILED row is invisible
      // to it. Query directly, or this asserts the opposite of what it means.
      const { rows: failedRows } = await getPool().query<{ status: string }>(
        `SELECT status FROM agent_corroborations WHERE match_id = $1
          ORDER BY started_at DESC LIMIT 1`, [candidate!.matchId]);
      assert.equal(failedRows.length, 1,
        'startCorroboration must have persisted a row before the throw');
      assert.equal(failedRows[0]!.status, 'failed',
        'a throw must not leave the row at status=running -- ux_corr_match_active would then '
        + 'permanently block this match from ever being corroborated again');

      // ux_corr_match_active is `UNIQUE (match_id) WHERE status <> 'failed'`.
      const { outcome } = await corroborateOne(runId, candidate!.matchId, deps, {
        runId, records: new Map(), activeAliases: new Map(),
      });
      assert.ok(outcome.verdict.verdict, 'the match must be corroborable again');
    });
  });
