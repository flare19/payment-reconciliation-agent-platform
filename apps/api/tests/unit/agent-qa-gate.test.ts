import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateAnswer, type GateContext } from '../../src/services/agent/grounding-gate.js';
import { QA_BUDGET, QA_EXCLUDED_TOOLS, qaRegistry, questionPrompt }
  from '../../src/services/agent/qa-loop.js';
import type { RawAnswer, ToolCallRecord } from '../../src/types/agent.js';
import type { ToolRegistry } from '../../src/services/agent/tool-registry.js';

/**
 * A2 Q&A's gate and registry (agent-design.md §9). U15.
 *
 * The grounding half is `checkGrounding`, shared verbatim with investigations
 * and corroborations — a second copy would drift, and the drift would be
 * invisible because every copy would keep passing its own tests. So these
 * concentrate on what is genuinely different about an ANSWER: no verdict
 * vocabulary, no proposal arm, and a registry with one tool deliberately
 * missing.
 */

const G1 = '11111111-1111-1111-1111-111111111111';
const G2 = '22222222-2222-2222-2222-222222222222';

const call = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  investigationId: 'q-1', step: 1, tool: 'get_transaction', arguments: {},
  returnedIds: [G1], resultDigest: 'digest', durationMs: 5, ...over,
});

function context(over: Partial<GateContext> = {}): GateContext {
  return {
    investigationId: 'q-1', toolCalls: [call()], runId: 'run-1',
    records: new Map(), activeAliases: new Map(), ...over,
  };
}

function answer(over: Partial<RawAnswer> = {}): RawAnswer {
  return {
    answer: 'Settlement SBIN0R52 was never matched: no gateway record shares its reference.',
    confidence: 'high',
    citations: [G1],
    reasoning: [{ step: 1, tool: 'get_transaction', arguments: {},
      resultDigest: 'digest', inference: 'the bank row carries no gateway counterpart' }],
    ...over,
  };
}

const passes = (raw: unknown, ctx = context()): boolean =>
  validateAnswer(raw, ctx).answer.groundingPassed;

describe('an answer is grounded in what a tool actually returned', () => {
  test('a well-formed, fully-cited answer passes', () => {
    assert.equal(passes(answer()), true);
  });

  test('a citation no tool returned voids the answer', () => {
    // The whole point. G2 was never in any `returnedIds`.
    const result = validateAnswer(answer({ citations: [G2] }), context());
    assert.equal(result.answer.groundingPassed, false);
    assert.equal(result.rejection?.check, 'grounding');
    assert.match(result.rejection?.reason ?? '', /appears in no tool result/);
  });

  test('a reasoning step naming a tool that was never called voids the answer', () => {
    assert.equal(
      passes(answer({
        reasoning: [{ step: 1, tool: 'search_transactions', arguments: {},
          resultDigest: 'digest', inference: 'invented' }],
      })),
      false);
  });

  test('an altered resultDigest voids the answer', () => {
    // The digest is a checksum on the chain: a model narrating a step it never
    // took cannot produce the digest for it.
    assert.equal(
      passes(answer({
        reasoning: [{ step: 1, tool: 'get_transaction', arguments: {},
          resultDigest: 'not-the-digest', inference: 'plausible but unearned' }],
      })),
      false);
  });

  test('AN ANSWER FROM ZERO TOOL CALLS IS REFUSED', () => {
    // Without `checkGrounding`'s "asserts something" arm, an empty answer would
    // be the CHEAPEST one to produce — which is exactly how an agent learns to
    // stop retrieving. Every answer asserts something, including "the data does
    // not show that": that is a claim about having looked.
    assert.equal(
      passes(answer({ citations: [], reasoning: [] }), context({ toolCalls: [] })),
      false);
  });
});

describe('an answer may not recommend a change (ADR-081)', () => {
  test('a proposedAction is REFUSED, not quietly stripped', () => {
    const result = validateAnswer(
      { ...answer(), proposedAction: { type: 'MARK_WONT_FIX', rationale: 'because' } },
      context());
    assert.equal(result.answer.groundingPassed, false);
    assert.equal(result.rejection?.check, 'schema');
    assert.match(result.rejection?.reason ?? '', /must not carry a proposedAction/);
  });

  test('an explicitly null proposedAction is fine', () => {
    assert.equal(passes({ ...answer(), proposedAction: null }), true);
  });
});

describe('the schema refuses what a reader could not use', () => {
  test('an empty answer string is refused', () => {
    for (const bad of ['', '   ', undefined, 42]) {
      assert.equal(passes(answer({ answer: bad as never })), false, JSON.stringify(bad));
    }
  });

  test('a numeric confidence is refused — confidence is a label', () => {
    assert.equal(passes(answer({ confidence: 0.9 as never })), false);
  });

  test('a rejected answer keeps its prose but drops its citations', () => {
    // The prose is what a reader sees and the reason it was refused; the
    // citations are the part that failed and must not be shown as evidence.
    const result = validateAnswer(answer({ citations: [G2] }), context());
    assert.deepEqual(result.answer.citations, []);
    assert.notEqual(result.answer.answer, '');
    assert.match(result.answer.groundingFailure ?? '', /^grounding: /);
  });

  test('a malformed reasoning step is dropped, not carried through', () => {
    // Issue #22: individually shape-checked, not merely `Array.isArray`.
    const result = validateAnswer(
      answer({ citations: [G2], reasoning: [{ nonsense: true } as never] }),
      context());
    assert.deepEqual(result.answer.reasoning, []);
  });
});

describe('the Q&A registry withholds the one tool §9 excludes', () => {
  const tool = (name: string) => ({
    name, description: `${name} does a thing`, inputSchema: { type: 'object' as const },
    execute: async () => ({ result: {}, returnedIds: [], digest: 'd' }),
  });

  const base: ToolRegistry = (() => {
    const tools = [tool('get_exception'), tool('get_transaction'), tool('rerun_subset_search')];
    const byName = new Map(tools.map((t) => [t.name, t]));
    return {
      tools: Object.freeze(tools),
      get: (n: string) => byName.get(n),
      declarations: () => tools.map((t) => ({
        name: t.name, description: t.description, parameters: t.inputSchema,
      })),
    } as unknown as ToolRegistry;
  })();

  test('rerun_subset_search is ABSENT, not merely discouraged', () => {
    // An instruction is a request; an absent tool is a property. On a public,
    // unauthenticated endpoint that is the difference between a bound and a hope.
    const registry = qaRegistry(base);
    assert.equal(registry.get('rerun_subset_search'), undefined);
    assert.equal(
      registry.declarations().some((d) => d.name === 'rerun_subset_search'), false);
  });

  test('get_exception STAYS — unlike corroboration, and that is the point', () => {
    // §9's own first example question is "why wasn't settlement X matched?",
    // which this tool answers. Corroboration excluded it because its subject is
    // a match; a question's subject is the whole run.
    assert.notEqual(qaRegistry(base).get('get_exception'), undefined);
  });

  test('the exclusion list is exactly what §9 names', () => {
    assert.deepEqual([...QA_EXCLUDED_TOOLS], ['rerun_subset_search']);
  });
});

describe('the budget is §9\'s, and separate from corroboration\'s', () => {
  test('6 steps and 8 tool calls', () => {
    assert.equal(QA_BUDGET.maxSteps, 6);
    assert.equal(QA_BUDGET.maxToolCalls, 8);
  });
});

describe('the opening prompt seeds no answer', () => {
  test('it carries the run and the question, and nothing else', () => {
    const prompt = questionPrompt({
      questionId: 'q-1', runId: 'run-9', question: 'Which merchant has the most exceptions?',
    });
    assert.match(prompt, /run-9/);
    assert.match(prompt, /Which merchant has the most exceptions\?/);
    // An investigation's prompt hands the model its subject because there is
    // exactly one. Seeding a guess here would narrow the search before it starts.
    assert.equal(/exception [0-9a-f-]{36}/.test(prompt), false);
  });
});
