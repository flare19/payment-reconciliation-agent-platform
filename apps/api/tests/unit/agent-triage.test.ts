import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_DEFAULTS } from '../../src/config/defaults.js';
import { loadEnv } from '../../src/config/env.js';
import {
  planTriage, isEligibleCategory, ELIGIBLE_CATEGORIES, DEFAULT_TRIAGE_BUDGET,
  type TriageBudget, type TriageCandidate, type QueueTriageCandidate,
} from '../../src/services/agent/triage.js';
import { EXCEPTION_PRECEDENCE, type ExceptionCategory } from '../../src/types/domain.js';

const exc = (i: number): TriageCandidate => ({
  exceptionId: `e${i}`, transactionId: `t${i}`, category: 'MISSING_IN_BANK',
  severity: 'high', amountAtRiskPaise: 1000, signatureHash: null,
});
const match = (i: number): QueueTriageCandidate => ({
  matchId: `m${i}`, tier: 'fuzzy', confidence: 0.7,
  memberTransactionIds: [`t${i}`], maxMemberAmountPaise: 500,
});
const many = <T>(n: number, f: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => f(i));

describe('A1 eligibility (agent-design §3)', () => {
  test('exactly six categories are eligible; DUPLICATE_RECORD and TIMING_DRIFT are not', () => {
    // Excluded because the engine's verdict on both is already complete — a
    // proved duplicate shares a strong anchor, a timing drift has identity and
    // amount agreeing. An agent adds nothing but tokens.
    assert.equal(ELIGIBLE_CATEGORIES.length, 6);
    assert.equal(isEligibleCategory('DUPLICATE_RECORD'), false);
    assert.equal(isEligibleCategory('TIMING_DRIFT'), false);
    for (const c of ['AMBIGUOUS_MATCH', 'UNSPLITTABLE_BATCH', 'MISSING_IN_BANK',
      'MISSING_IN_LEDGER', 'MISSING_IN_GATEWAY', 'AMOUNT_MISMATCH'] as ExceptionCategory[]) {
      assert.equal(isEligibleCategory(c), true, c);
    }
  });

  test('every eligible category is a REAL category — no typo can hide here', () => {
    // A misspelled category would silently make that pile uninvestigated, and
    // `category = ANY(...)` would never match it. Nothing else would fail.
    for (const c of ELIGIBLE_CATEGORIES) {
      assert.ok((EXCEPTION_PRECEDENCE as readonly string[]).includes(c), c);
    }
  });
});

describe('budget constants have ONE home', () => {
  test('the triage budget reads AGENT_DEFAULTS, not a second copy of the numbers', () => {
    assert.equal(DEFAULT_TRIAGE_BUDGET.maxInvestigations, 20);
    assert.equal(DEFAULT_TRIAGE_BUDGET.maxQueueTriages, 15);
    assert.equal(AGENT_DEFAULTS.maxLlmRequestsPerRun, 220);
    assert.equal(DEFAULT_TRIAGE_BUDGET.maxInvestigations,
      AGENT_DEFAULTS.maxInvestigationsPerRun);
    assert.equal(DEFAULT_TRIAGE_BUDGET.maxQueueTriages,
      AGENT_DEFAULTS.maxQueueTriagesPerRun);
  });

  test('corroboration has its OWN step budget, not the Q&A loop\'s', () => {
    // Numerically equal today and bounding different loops. Sharing the constant
    // would mean a future change to the Q&A surface silently re-tuned
    // review-queue corroboration. The A2 loop reads these, not triage.
    assert.equal(AGENT_DEFAULTS.corroborate.maxSteps, 6);
    assert.equal(AGENT_DEFAULTS.corroborate.maxToolCalls, 8);
    assert.equal(AGENT_DEFAULTS.budget.maxSteps, 10);
    assert.notEqual(
      AGENT_DEFAULTS.corroborate as unknown, AGENT_DEFAULTS.qa as unknown,
      'they must not be the same object');
  });

  test('env defaults agree with AGENT_DEFAULTS value-for-value', () => {
    // The `source_rank` lesson: a constant defined in two places is two
    // constants, and the drift is invisible until it matters.
    const prev = { ...process.env };
    process.env['DATABASE_URL'] = 'postgres://x/y';
    process.env['CORS_ORIGIN'] = 'http://localhost:3000';
    for (const k of ['AGENT_MAX_INVESTIGATIONS_PER_RUN', 'AGENT_MAX_QUEUE_TRIAGES_PER_RUN',
      'AGENT_MAX_LLM_REQUESTS_PER_RUN']) delete process.env[k];
    try {
      const env = loadEnv();
      assert.equal(env.agentMaxInvestigationsPerRun, AGENT_DEFAULTS.maxInvestigationsPerRun);
      assert.equal(env.agentMaxQueueTriagesPerRun, AGENT_DEFAULTS.maxQueueTriagesPerRun);
      assert.equal(env.agentMaxLlmRequestsPerRun, AGENT_DEFAULTS.maxLlmRequestsPerRun);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
      Object.assign(process.env, prev);
    }
  });
});

describe('planTriage — caps, the shared budget, and what it reports', () => {
  const budget: TriageBudget = { maxInvestigations: 20, maxQueueTriages: 15 };

  test('both caps bind, and what was left out is COUNTED', () => {
    const plan = planTriage(
      { exceptions: many(30, exc), queue: many(30, match) },
      { eligibleExceptions: 96, pendingMatches: 71 }, budget);
    assert.equal(plan.investigate.length, 20);
    assert.equal(plan.corroborate.length, 15);
    // A plan that says "20 investigations" without "of 96 eligible" is a number
    // with no denominator.
    assert.equal(plan.investigationsSkipped, 76);
    assert.equal(plan.queueTriagesSkipped, 56);
    assert.equal(plan.eligibleExceptionCount, 96);
    assert.equal(plan.pendingMatchCount, 71);
  });

  test('order is preserved exactly — planning must not re-sort what SQL ordered', () => {
    const exceptions = many(5, exc);
    const plan = planTriage({ exceptions, queue: [] },
      { eligibleExceptions: 5, pendingMatches: 0 }, budget);
    assert.deepEqual(plan.investigate.map((e) => e.exceptionId),
      exceptions.map((e) => e.exceptionId));
  });

  test('triage applies the two per-list caps and NOTHING else', () => {
    // The shared request budget is deliberately NOT enforced here. Reserving
    // each investigation's 10-step CEILING up front would leave room for three
    // corroborations of a permitted fifteen and make ADR-081's second work list
    // almost inert on every run — starved by a worst case that rarely happens.
    // A ceiling is a maximum, not an average, and reserving against it is a
    // guess wearing a bound's clothes. The A2 loop counts REAL requests.
    const plan = planTriage(
      { exceptions: many(20, exc), queue: many(15, match) },
      { eligibleExceptions: 20, pendingMatches: 15 }, budget);
    assert.equal(plan.investigate.length, 20);
    assert.equal(plan.corroborate.length, 15,
      'the queue is not pre-starved on an estimate; the loop cuts it on real spend');
    assert.equal(plan.queueTriagesSkipped, 0);
  });

  test('a cap of zero yields an empty list, never a negative slice', () => {
    const plan = planTriage(
      { exceptions: many(20, exc), queue: many(15, match) },
      { eligibleExceptions: 20, pendingMatches: 15 },
      { maxInvestigations: 0, maxQueueTriages: -3 });
    assert.deepEqual(plan.investigate, []);
    assert.deepEqual(plan.corroborate, []);
    assert.equal(plan.investigationsSkipped, 20);
    assert.equal(plan.queueTriagesSkipped, 15);
  });

  test('empty input is a valid plan, not a crash', () => {
    const plan = planTriage({ exceptions: [], queue: [] },
      { eligibleExceptions: 0, pendingMatches: 0 }, budget);
    assert.deepEqual(plan.investigate, []);
    assert.deepEqual(plan.corroborate, []);
    assert.equal(plan.investigationsSkipped, 0);
    assert.equal(plan.queueTriagesSkipped, 0);
  });

  test('planning is PURE — same input, same plan, every time', () => {
    const input = { exceptions: many(25, exc), queue: many(20, match) };
    const counts = { eligibleExceptions: 25, pendingMatches: 20 };
    const first = JSON.stringify(planTriage(input, counts, budget));
    for (let i = 0; i < 10; i += 1) {
      assert.equal(JSON.stringify(planTriage(input, counts, budget)), first);
    }
  });
});
