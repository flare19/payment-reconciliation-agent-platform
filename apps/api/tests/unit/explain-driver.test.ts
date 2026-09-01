import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXCEPTION_PRECEDENCE,
  type AnchorStrength, type ExceptionCategory, type Severity, type SourceSystem,
} from '../../src/types/domain.js';
import type { ExceptionEvidence } from '../../src/types/engine.js';
import {
  planSignatures, resolveExplanations, auditEventFor,
  type ExceptionToExplain, type ExplainDeps,
} from '../../src/services/explain/cache.js';
import type {
  ExplainBatchResult, ExplainLlmClient, SignaturePrompt,
} from '../../src/services/explain/llm-client.js';
import { templateFor } from '../../src/services/explain/templates.js';
import type { TxForSignature } from '../../src/services/explain/signature.js';

const OPTS = { promptVersion: 'v1', model: 'gemini-3.5-flash' };

function evidence(o: Partial<ExceptionEvidence> = {}): ExceptionEvidence {
  return {
    candidatesConsidered: 0, candidates: [], anchorStrength: 'none', aliasesAttempted: [],
    windowUsed: { amountBandPaise: 0, dateWindow: [-1, 3] }, candidateCapHit: false,
    severityBasis: { base: 'medium', amountAtRiskPaise: null, escalated: false }, ...o,
  };
}

let seq = 0;
function exc(o: Partial<ExceptionToExplain> = {}): ExceptionToExplain {
  seq += 1;
  return {
    id: `exc-${seq}`, transactionId: null, relatedTransactionIds: [],
    category: 'MISSING_IN_BANK', secondaryFlags: [], severity: 'high',
    evidence: evidence(), ...o,
  };
}

const NO_TX = new Map<string, TxForSignature>();

/**
 * The i-th GENUINELY distinct discrepancy shape.
 *
 * Written after a first attempt varied `candidatesConsidered: 0..99` and got
 * four groups rather than a hundred — which is ADR-018's collapse working
 * exactly as specified, and a reminder that a fixture built by incrementing one
 * field tests the bucketing rather than the batching. This walks a mixed-radix
 * cross product of the four components that actually carry distinct values:
 * 8 categories x 3 anchor strengths x 4 candidate bands x 2 alias states = 192
 * distinct signatures, injective for i < 192.
 */
const CATEGORIES = [...EXCEPTION_PRECEDENCE] as ExceptionCategory[];
const ANCHORS: AnchorStrength[] = ['strong', 'weak', 'none'];
const CANDIDATE_BANDS = [0, 1, 2, 4];

function distinctExc(i: number, o: Partial<ExceptionToExplain> = {}): ExceptionToExplain {
  return exc({
    category: CATEGORIES[i % 8]!,
    evidence: evidence({
      anchorStrength: ANCHORS[Math.floor(i / 8) % 3]!,
      candidatesConsidered: CANDIDATE_BANDS[Math.floor(i / 24) % 4]!,
      aliasesAttempted: Math.floor(i / 96) % 2 === 0 ? [] : ['alias-uuid'],
    }),
    ...o,
  });
}

/** A client whose every call is scripted, and which records what it was asked. */
function fakeClient(
  script: ((sigs: readonly SignaturePrompt[], maxRequests: number) => ExplainBatchResult)[],
): ExplainLlmClient & { calls: { sigs: readonly SignaturePrompt[]; maxRequests: number }[] } {
  const calls: { sigs: readonly SignaturePrompt[]; maxRequests: number }[] = [];
  let i = 0;
  return {
    model: 'gemini-3.5-flash',
    calls,
    async explainBatch(sigs, { maxRequests }) {
      calls.push({ sigs, maxRequests });
      const step = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return step(sigs, maxRequests);
    },
  };
}

/** Answers every signature it is given. */
const answerAll = (sigs: readonly SignaturePrompt[]): ExplainBatchResult => ({
  ok: true,
  byId: new Map(sigs.map((s) => [s.id, {
    explanation: `model prose for ${s.category}`, suggestedAction: 'do the model thing',
  }])),
  requestsMade: 1, tokensIn: 100, tokensOut: 50,
});

const emptyCache: ExplainDeps['lookupCache'] = async () => null;

// ─────────────────────────────────────────────────────────────────────────────

describe('planSignatures — ADR-018 collapse', () => {
  test('exceptions of the same shape collapse to ONE signature', () => {
    const groups = planSignatures(
      [exc(), exc(), exc(), exc()], NO_TX, OPTS);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.occurrenceCount, 4);
    assert.equal(groups[0]!.exceptionIds.length, 4);
  });

  test('different shapes stay separate', () => {
    const groups = planSignatures([
      exc({ category: 'MISSING_IN_BANK' }),
      exc({ category: 'MISSING_IN_LEDGER' }),
      exc({ category: 'MISSING_IN_BANK', evidence: evidence({ anchorStrength: 'strong' }) }),
    ], NO_TX, OPTS);
    assert.equal(groups.length, 3);
  });

  test('every exception lands in exactly one group — none is lost', () => {
    const exceptions = [
      exc({ category: 'MISSING_IN_BANK' }), exc({ category: 'MISSING_IN_BANK' }),
      exc({ category: 'AMBIGUOUS_MATCH' }), exc({ category: 'TIMING_DRIFT', severity: 'low' }),
      exc({ category: 'DUPLICATE_RECORD' }),
    ];
    const groups = planSignatures(exceptions, NO_TX, OPTS);
    const ids = groups.flatMap((g) => g.exceptionIds);
    assert.equal(ids.length, exceptions.length);
    assert.equal(new Set(ids).size, exceptions.length);
  });

  test('ordering is severity, then occurrence, then hash — a TOTAL order (ADR-032)', () => {
    // The budget is spent along this order, so an unspecified one would mean two
    // runs of the same data explaining different exceptions with the model.
    const groups = planSignatures([
      exc({ category: 'TIMING_DRIFT', severity: 'low' }),
      exc({ category: 'MISSING_IN_LEDGER', severity: 'medium' }),
      exc({ category: 'MISSING_IN_BANK', severity: 'high' }),
      exc({ category: 'MISSING_IN_BANK', severity: 'high' }),
      exc({ category: 'AMBIGUOUS_MATCH', severity: 'high' }),
    ], NO_TX, OPTS);

    assert.deepEqual(groups.map((g) => g.topSeverity), ['high', 'high', 'medium', 'low']);
    // Within `high`, the two-occurrence group outranks the one-occurrence group.
    assert.equal(groups[0]!.category, 'MISSING_IN_BANK');
    assert.equal(groups[0]!.occurrenceCount, 2);
  });

  test('a group takes the severity of its MOST severe member', () => {
    // Same signature, different severities: severity is escalated by money at
    // risk (ADR-044) and money is not in the signature, so this is normal.
    const groups = planSignatures([
      exc({ severity: 'low' }), exc({ severity: 'high' }), exc({ severity: 'medium' }),
    ], NO_TX, OPTS);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.topSeverity, 'high');
  });

  test('the plan is stable under input permutation', () => {
    const build = (): ExceptionToExplain[] => {
      seq = 0;
      return [
        exc({ category: 'MISSING_IN_BANK' }), exc({ category: 'AMBIGUOUS_MATCH' }),
        exc({ category: 'TIMING_DRIFT', severity: 'low' }), exc({ category: 'MISSING_IN_BANK' }),
      ];
    };
    const forward = planSignatures(build(), NO_TX, OPTS).map((g) => g.hash);
    const backward = planSignatures([...build()].reverse(), NO_TX, OPTS).map((g) => g.hash);
    assert.deepEqual(forward, backward);
  });
});

describe('resolveExplanations — the no-key path (the PRIMARY path)', () => {
  test('with no client every signature takes the template, and the run still resolves', async () => {
    const groups = planSignatures([exc(), exc({ category: 'AMBIGUOUS_MATCH' })], NO_TX, OPTS);
    const out = await resolveExplanations(
      groups, { client: null, lookupCache: emptyCache }, { llmMaxCallsPerRun: 8 });

    assert.equal(out.resolved.length, 2);
    assert.equal(out.stats.apiCalls, 0);
    assert.equal(out.stats.templated, 2);
    assert.equal(out.stats.generated, 0);
    for (const r of out.resolved) {
      assert.equal(r.source, 'template');
      assert.equal(r.templateCause, 'no_client');
      assert.equal(r.explanationText, templateFor(r.category).explanationText);
      assert.ok(r.explanationText.length > 0, 'explanation_text is never empty');
    }
  });

  test('a template is NEVER written to the cache (ADR-084)', async () => {
    // The poisoning failure this prevents: a template row cached during a
    // keyless run is served as a HIT by every later run, including runs that do
    // have a key, so that signature is never sent to the model again. One
    // offline afternoon would permanently downgrade the demo, silently.
    const groups = planSignatures([exc()], NO_TX, OPTS);
    const out = await resolveExplanations(
      groups, { client: null, lookupCache: emptyCache }, { llmMaxCallsPerRun: 8 });
    assert.equal(out.resolved[0]!.needsCacheWrite, false);
  });
});

describe('resolveExplanations — cache', () => {
  test('a hit is reused, costs no request, and is labelled llm_cache', async () => {
    const groups = planSignatures([exc(), exc()], NO_TX, OPTS);
    const client = fakeClient([answerAll]);
    const out = await resolveExplanations(groups, {
      client,
      lookupCache: async () => ({
        explanationText: 'cached prose', suggestedAction: 'cached action',
        tokensIn: 999, tokensOut: 999,
      }),
    }, { llmMaxCallsPerRun: 8 });

    assert.equal(out.stats.cacheHits, 1);
    assert.equal(out.stats.apiCalls, 0);
    assert.equal(client.calls.length, 0, 'a cached signature must not reach the model');
    assert.equal(out.resolved[0]!.source, 'llm_cache');
    assert.equal(out.resolved[0]!.explanationText, 'cached prose');
    assert.equal(out.resolved[0]!.needsCacheWrite, false, 'already in the cache');
  });

  test('a cache hit does not re-bill this run for the tokens the FIRST run spent', async () => {
    const groups = planSignatures([exc()], NO_TX, OPTS);
    const out = await resolveExplanations(groups, {
      client: null,
      lookupCache: async () => ({
        explanationText: 'c', suggestedAction: 'a', tokensIn: 999, tokensOut: 999,
      }),
    }, { llmMaxCallsPerRun: 8 });
    assert.equal(out.stats.tokensIn, 0);
    assert.equal(out.stats.tokensOut, 0);
    assert.equal(out.resolved[0]!.tokensIn, null);
  });
});

describe('resolveExplanations — the model path', () => {
  test('fresh output is labelled llm and IS written to the cache', async () => {
    const groups = planSignatures([exc(), exc()], NO_TX, OPTS);
    const out = await resolveExplanations(
      groups, { client: fakeClient([answerAll]), lookupCache: emptyCache },
      { llmMaxCallsPerRun: 8 });

    assert.equal(out.stats.generated, 1);
    assert.equal(out.stats.apiCalls, 1);
    assert.equal(out.stats.tokensIn, 100);
    assert.equal(out.stats.tokensOut, 50);
    assert.equal(out.resolved[0]!.source, 'llm');
    assert.equal(out.resolved[0]!.needsCacheWrite, true);
    assert.equal(out.resolved[0]!.explanationText, 'model prose for MISSING_IN_BANK');
  });

  /**
   * ── #52: a fabricated specific is REFUSED, not stored ──
   *
   * S13's input provably contains no specifics, so a rupee figure in the output
   * is necessarily invented. Until now nothing checked: the text went straight
   * to `explanation_text` and, worse, to `explanation_cache` — which is
   * run-independent, so ONE fabricated figure would then be served to every
   * later run sharing that signature, with `hit_count` making it look
   * well-established.
   */
  const answerWithFabricatedAmount = (
    sigs: readonly SignaturePrompt[],
  ): ExplainBatchResult => ({
    ok: true,
    byId: new Map(sigs.map((s) => [s.id, {
      explanation: `The gateway captured ₹4,82,110 for this ${s.category} and no bank `
        + 'credit matched it.',
      suggestedAction: 'Ask the bank for a settlement advice.',
    }])),
    requestsMade: 1, tokensIn: 100, tokensOut: 50,
  });

  test('#52: a fabricated amount is templated, NOT stored and NOT cached', async () => {
    const groups = planSignatures([exc(), exc()], NO_TX, OPTS);
    const out = await resolveExplanations(
      groups, { client: fakeClient([answerWithFabricatedAmount]), lookupCache: emptyCache },
      { llmMaxCallsPerRun: 8 });

    const r = out.resolved[0]!;
    assert.equal(r.source, 'template', 'the model text must not be used');
    assert.equal(r.templateCause, 'ungrounded_specific',
      'its OWN cause — folding it into malformed_response would hide the count');
    assert.doesNotMatch(r.explanationText, /4,82,110|₹/,
      'no fabricated figure may survive into the exception list');
    // ADR-084 + #52 acceptance criterion 3: a rejected batch writes no cache row,
    // so the fabrication cannot outlive this run.
    assert.equal(r.needsCacheWrite, false);
    assert.equal(out.stats.generated, 0, 'a refused signature was not generated');
    assert.equal(out.stats.templated, 1);
    // Criterion 2: the rejection is VISIBLE, and reaches runs.metrics.llmCost.
    assert.equal(out.stats.failures.length, 1);
    assert.equal(out.stats.failures[0]!.reason, 'ungrounded');
    assert.match(out.stats.failures[0]!.detail, /currency amount/);
  });

  test('#52: a clean answer in the SAME batch is unaffected', async () => {
    // Rejection is per signature, not per batch. One bad explanation must not
    // discard the good ones — the same reasoning `parseResponse` rule 2 applies
    // to a response covering 8 of 10.
    const mixed = (sigs: readonly SignaturePrompt[]): ExplainBatchResult => ({
      ok: true,
      byId: new Map(sigs.map((s, i) => [s.id, i === 0
        ? { explanation: 'Payment pay_c9zqFpdcakznDx is unmatched.',
            suggestedAction: 'Check the gateway.' }
        : { explanation: `model prose for ${s.category}`,
            suggestedAction: 'do the model thing' }])),
      requestsMade: 1, tokensIn: 100, tokensOut: 50,
    });
    const groups = planSignatures(
      [exc(), exc({ category: 'AMBIGUOUS_MATCH' })], NO_TX, OPTS);
    assert.equal(groups.length, 2, 'this test needs two distinct signatures');

    const out = await resolveExplanations(
      groups, { client: fakeClient([mixed]), lookupCache: emptyCache },
      { llmMaxCallsPerRun: 8 });

    const bySource = out.resolved.map((r) => r.source).sort();
    assert.deepEqual(bySource, ['llm', 'template']);
    assert.equal(out.stats.generated, 1);
    assert.equal(out.stats.templated, 1);
  });

  test('#52: the suggested ACTION is checked too, not just the explanation', async () => {
    // The action is the field a human acts on. A clean explanation with an
    // invented reference id in the action is still an invented reference id.
    const cleanProseDirtyAction = (
      sigs: readonly SignaturePrompt[],
    ): ExplainBatchResult => ({
      ok: true,
      byId: new Map(sigs.map((s) => [s.id, {
        explanation: `A captured payment has no bank credit for this ${s.category}.`,
        suggestedAction: 'Ask the bank about settlement setl_yWY9cEo8cDeRXl.',
      }])),
      requestsMade: 1, tokensIn: 100, tokensOut: 50,
    });
    const groups = planSignatures([exc()], NO_TX, OPTS);
    const out = await resolveExplanations(
      groups, { client: fakeClient([cleanProseDirtyAction]), lookupCache: emptyCache },
      { llmMaxCallsPerRun: 8 });

    assert.equal(out.resolved[0]!.templateCause, 'ungrounded_specific');
    assert.match(out.stats.failures[0]!.detail, /reference id/);
  });

  test('§10.3 batches at most 10 signatures per request', async () => {
    const exceptions = Array.from({ length: 25 }, (_, i) => distinctExc(i));
    const groups = planSignatures(exceptions, NO_TX, OPTS);
    assert.equal(groups.length, 25, 'the fixture must actually produce distinct signatures');

    const client = fakeClient([answerAll]);
    await resolveExplanations(groups, { client, lookupCache: emptyCache },
      { llmMaxCallsPerRun: 8 });

    for (const call of client.calls) {
      assert.ok(call.sigs.length <= 10, `a batch carried ${call.sigs.length} signatures`);
    }
    assert.equal(client.calls.length, Math.ceil(groups.length / 10));
  });

  test('a signature the response omits takes the template, and the rest are kept', async () => {
    // A partial response is not malformed JSON. Discarding the answers that DID
    // come back would be a worse trade than templating the one that did not.
    const groups = planSignatures(
      [exc({ category: 'MISSING_IN_BANK' }), exc({ category: 'AMBIGUOUS_MATCH' })], NO_TX, OPTS);
    const client = fakeClient([(sigs) => ({
      ok: true,
      byId: new Map([[sigs[0]!.id, { explanation: 'only the first', suggestedAction: 'act' }]]),
      requestsMade: 1, tokensIn: 10, tokensOut: 5,
    })]);
    const out = await resolveExplanations(groups, { client, lookupCache: emptyCache },
      { llmMaxCallsPerRun: 8 });

    assert.equal(out.stats.generated, 1);
    assert.equal(out.stats.templated, 1);
    const templated = out.resolved.find((r) => r.source === 'template')!;
    assert.equal(templated.templateCause, 'not_in_response');
  });
});

describe('resolveExplanations — failure is an ordinary path (§10.1)', () => {
  test('malformed twice templates that batch and records the failure', async () => {
    const groups = planSignatures([exc(), exc({ category: 'AMBIGUOUS_MATCH' })], NO_TX, OPTS);
    const client = fakeClient([() => ({
      ok: false, reason: 'malformed', detail: 'attempt 2: response was not usable JSON',
      requestsMade: 2,
    })]);
    const out = await resolveExplanations(groups, { client, lookupCache: emptyCache },
      { llmMaxCallsPerRun: 8 });

    assert.equal(out.stats.templated, 2);
    assert.equal(out.stats.apiCalls, 2, 'the retry is a real request and is counted');
    assert.deepEqual(out.stats.failures, [
      { reason: 'malformed', detail: 'attempt 2: response was not usable JSON' }]);
    for (const r of out.resolved) assert.equal(r.templateCause, 'malformed_response');
  });

  test('a transport failure templates that batch', async () => {
    const groups = planSignatures([exc()], NO_TX, OPTS);
    const client = fakeClient([() => ({
      ok: false, reason: 'transport', detail: '401 API key not valid', requestsMade: 1,
    })]);
    const out = await resolveExplanations(groups, { client, lookupCache: emptyCache },
      { llmMaxCallsPerRun: 8 });
    assert.equal(out.resolved[0]!.templateCause, 'transport_failure');
    assert.equal(out.resolved[0]!.source, 'template');
    assert.equal(out.resolved[0]!.needsCacheWrite, false);
  });
});

describe('resolveExplanations — the call cap is HARD (§10.3 step 5)', () => {
  const manyGroups = () => {
    seq = 0;
    const groups = planSignatures(
      Array.from({ length: 100 }, (_, i) => distinctExc(i)), NO_TX, OPTS);
    assert.equal(groups.length, 100, 'the cap tests need more signatures than the cap allows');
    return groups;
  };

  test('apiCalls never exceeds llmMaxCallsPerRun, and the rest take templates', async () => {
    const groups = manyGroups();
    const client = fakeClient([answerAll]);
    const out = await resolveExplanations(groups, { client, lookupCache: emptyCache },
      { llmMaxCallsPerRun: 3 });

    assert.equal(out.stats.apiCalls, 3);
    assert.equal(client.calls.length, 3);
    assert.equal(out.stats.generated, 30, 'three batches of ten');
    assert.equal(out.stats.templated, groups.length - 30);
    const capped = out.resolved.filter((r) => r.templateCause === 'call_cap');
    assert.equal(capped.length, groups.length - 30);
  });

  test('RETRIES are debited from the budget, so 8 cannot become 16', async () => {
    // Without this the advertised cap is a cap on BATCHES, and a run that
    // retried every batch would spend double what the setting promises. On a
    // free-tier key requests-per-day is the resource that binds (ADR-080).
    const groups = manyGroups();
    const client = fakeClient([() => ({
      ok: false, reason: 'malformed', detail: 'twice', requestsMade: 2,
    })]);
    const out = await resolveExplanations(groups, { client, lookupCache: emptyCache },
      { llmMaxCallsPerRun: 8 });

    assert.equal(out.stats.apiCalls, 8);
    assert.equal(client.calls.length, 4, 'four batches, two requests each');
  });

  test('the remaining budget is passed down, so the LAST batch cannot overshoot', async () => {
    // The client bounds its own retry by what is left. A budget of 1 buys one
    // attempt and no retry — the alternative is a "hard cap" of 8 that spends 9.
    const groups = manyGroups();
    const client = fakeClient([() => ({
      ok: false, reason: 'malformed', detail: 'x', requestsMade: 2,
    }), () => ({ ok: false, reason: 'malformed', detail: 'x', requestsMade: 1 })]);
    await resolveExplanations(groups, { client, lookupCache: emptyCache },
      { llmMaxCallsPerRun: 3 });

    assert.deepEqual(client.calls.map((c) => c.maxRequests), [3, 1]);
  });

  test('a cap of 0 disables the model entirely without failing the run', async () => {
    const groups = planSignatures([exc()], NO_TX, OPTS);
    const client = fakeClient([answerAll]);
    const out = await resolveExplanations(groups, { client, lookupCache: emptyCache },
      { llmMaxCallsPerRun: 0 });
    assert.equal(client.calls.length, 0);
    assert.equal(out.resolved[0]!.templateCause, 'call_cap');
  });
});

describe('every exception is accounted for, whatever happens', () => {
  test('resolutions cover every exception exactly once on a mixed run', async () => {
    seq = 0;
    const exceptions = Array.from({ length: 60 }, (_, i) => distinctExc(i, {
      severity: (['high', 'medium', 'low'] as Severity[])[i % 3]!,
    }));
    const groups = planSignatures(exceptions, NO_TX, OPTS);
    assert.equal(groups.length, 60);

    let n = 0;
    const out = await resolveExplanations(groups, {
      client: fakeClient([answerAll]),
      // Every third signature is a cache hit, so all three sources appear.
      lookupCache: async () => (n++ % 3 === 0
        ? { explanationText: 'c', suggestedAction: 'a', tokensIn: null, tokensOut: null }
        : null),
    }, { llmMaxCallsPerRun: 1 });

    const covered = out.resolved.flatMap((r) => r.exceptionIds);
    assert.equal(covered.length, exceptions.length);
    assert.equal(new Set(covered).size, exceptions.length);
    assert.equal(out.stats.exceptionsExplained, exceptions.length);
    // All three sources exercised, and every one carries non-empty prose.
    assert.deepEqual(
      [...new Set(out.resolved.map((r) => r.source))].sort(),
      ['llm', 'llm_cache', 'template']);
    for (const r of out.resolved) {
      assert.ok(r.explanationText.trim().length > 0);
      assert.ok(r.suggestedAction.trim().length > 0);
      assert.ok(r.reason.trim().length > 0, 'the audit reason is never a placeholder');
    }
  });
});

test('§9.1 event types map to where the text came from', () => {
  assert.equal(auditEventFor('llm'), 'EXPLANATION_GENERATED');
  assert.equal(auditEventFor('llm_cache'), 'EXPLANATION_CACHE_HIT');
  assert.equal(auditEventFor('template'), 'EXPLANATION_FALLBACK_TEMPLATE');
});

test('a group-level exception with no records still gets a signature and a template', () => {
  // `transactionId` is NULL for a group-level exception (schema.md §8). It must
  // not crash the stage or produce an empty explanation.
  const groups = planSignatures(
    [exc({ transactionId: null, category: 'UNSPLITTABLE_BATCH' })], NO_TX, OPTS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.components.sourcesPresent, 'unknown');
});

test('unknown SourceSystem values cannot reach the plan — the map is the only source', () => {
  const txById = new Map<string, TxForSignature>([
    ['t1', { sourceSystem: 'bank' as SourceSystem, amountPaise: 1, txnDate: '2026-08-01' }]]);
  const groups = planSignatures([exc({ transactionId: 't1' })], txById, OPTS);
  assert.equal(groups[0]!.components.sourcesPresent, 'bank_only');
});
