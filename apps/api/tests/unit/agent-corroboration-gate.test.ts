import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateCorroboration, type GateContext } from '../../src/services/agent/grounding-gate.js';
import type { RawCorroboration, ToolCallRecord } from '../../src/types/agent.js';

/**
 * A2 CORROBORATE's gate (ADR-081, ADR-087).
 *
 * The grounding half is `checkGrounding`, shared verbatim with investigations —
 * a second copy would drift and the drift would be invisible, because both
 * copies would keep passing their own tests. So these concentrate on what is
 * genuinely different: the vocabulary, and the absence of a proposal arm.
 */

const G1 = '11111111-1111-1111-1111-111111111111';
const G2 = '22222222-2222-2222-2222-222222222222';

const call = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  investigationId: 'corr-1', step: 1, tool: 'get_transaction', arguments: {},
  returnedIds: [G1], resultDigest: 'digest', durationMs: 5, ...over,
});

function context(over: Partial<GateContext> = {}): GateContext {
  return {
    investigationId: 'corr-1', toolCalls: [call()], runId: 'run-1',
    records: new Map(), activeAliases: new Map(), ...over,
  };
}

function corroboration(over: Partial<RawCorroboration> = {}): RawCorroboration {
  return {
    verdict: 'CORROBORATED', confidence: 'high',
    summary: 'the raw payload carries a reference the scorer never saw',
    citations: [G1],
    reasoning: [{ step: 1, tool: 'get_transaction', arguments: {},
      resultDigest: 'digest', inference: 'the raw row shares a reference' }],
    ...over,
  };
}

const passes = (raw: unknown, ctx = context()): boolean =>
  validateCorroboration(raw, ctx).verdict.groundingPassed;

describe('the corroboration vocabulary is DISJOINT from the investigation one', () => {
  test('the three evidence verdicts are accepted', () => {
    for (const verdict of ['CORROBORATED', 'CONTRADICTED', 'NO_NEW_EVIDENCE'] as const) {
      assert.equal(passes(corroboration({ verdict })), true, verdict);
    }
  });

  test('an INVESTIGATION verdict is refused here', () => {
    // The two vocabularies mean different things. A gate that accepted both
    // would let a reader count them together.
    for (const verdict of ['RESOLUTION_PROPOSED', 'CONFIRMED_UNRESOLVABLE',
      'NEEDS_EXTERNAL_DATA', 'INSUFFICIENT_EVIDENCE']) {
      assert.equal(passes(corroboration({ verdict: verdict as never })), false, verdict);
    }
  });
});

describe('a corroboration may not RECOMMEND anything (agent-design §3)', () => {
  test('a proposedAction is REFUSED, not silently stripped', () => {
    // "The Analyst does not recommend confirming or rejecting a match. It never
    // says 'confirm this'." Stripping the field would hide that the prompt has
    // drifted into asking for one.
    const r = validateCorroboration({
      ...corroboration(),
      proposedAction: { type: 'MARK_WONT_FIX', rationale: 'confirm it' },
    }, context());
    assert.equal(r.verdict.groundingPassed, false);
    assert.equal(r.rejection?.check, 'schema');
    assert.match(r.rejection!.reason, /must not carry a proposedAction/);
  });

  test('an explicit null proposedAction is fine — absence is the normal shape', () => {
    assert.equal(passes({ ...corroboration(), proposedAction: null }), true);
  });
});

describe('grounding is the SAME check investigations get', () => {
  test('a citation no tool returned is rejected', () => {
    assert.equal(passes(corroboration({ citations: [G2] })), false);
  });

  test('a reasoning step naming an uncalled tool is rejected', () => {
    assert.equal(passes(corroboration({
      reasoning: [{ step: 1, tool: 'score_pair', arguments: {},
        resultDigest: 'digest', inference: 'they tie' }],
    })), false);
  });

  test('a digest the runtime never recorded is rejected', () => {
    // The checksum: a model narrating a step it never took cannot produce the
    // digest for it.
    assert.equal(passes(corroboration({
      reasoning: [{ step: 1, tool: 'get_transaction', arguments: {},
        resultDigest: 'a digest I made up', inference: 'x' }],
    })), false);
  });

  test('evidence from ANOTHER corroboration is not evidence here (#21)', () => {
    assert.throws(() => validateCorroboration(corroboration(), context({
      toolCalls: [call({ investigationId: 'a-different-one' })],
    })), /Grounding is per-investigation/);
  });
});

describe('a rejected corroboration downgrades to the honest floor', () => {
  test('it becomes NO_NEW_EVIDENCE, never CONTRADICTED', () => {
    // CONTRADICTED is a positive claim about evidence AGAINST a match. A gate
    // failure is an absence of evidence, not evidence of absence — downgrading
    // into CONTRADICTED would manufacture a finding out of a rejection.
    const r = validateCorroboration(corroboration({ citations: [G2] }), context());
    assert.equal(r.verdict.verdict, 'NO_NEW_EVIDENCE');
    assert.equal(r.verdict.confidence, 'low');
    assert.deepEqual(r.verdict.citations, [], 'no unverified citation survives');
    assert.notEqual(r.verdict.groundingFailure, null);
  });

  test('malformed input downgrades rather than throwing', () => {
    for (const bad of [null, 'text', 42, {}, { verdict: 'CORROBORATED' }]) {
      const r = validateCorroboration(bad, context());
      assert.equal(r.verdict.groundingPassed, false);
      assert.equal(r.verdict.verdict, 'NO_NEW_EVIDENCE');
    }
  });

  test('citations are deduplicated and sorted on the way through', () => {
    const r = validateCorroboration(
      corroboration({ citations: [G1, G1] }), context());
    assert.deepEqual(r.verdict.citations, [G1]);
  });
});
