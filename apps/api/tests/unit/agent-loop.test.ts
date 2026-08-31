import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_DEFAULTS } from '../../src/config/defaults.js';
import {
  investigate, extractVerdict, reasoningChain, systemPrompt,
  type LoopDeps,
} from '../../src/services/agent/investigation-loop.js';
import type {
  AgentLlmClient, AgentTurnRequest, AgentTurnResult,
} from '../../src/services/agent/agent-client.js';
import type { AgentTool, RawVerdict, ToolCallRecord } from '../../src/types/agent.js';
import type { ToolRegistry } from '../../src/services/agent/tool-registry.js';

/**
 * A2 against a scripted fake client — no network, no key, no money.
 *
 * The tests that matter are the BOUNDS and the GROUNDING PLUMBING. A loop that
 * reaches a verdict on a happy path proves very little; a loop that stops at the
 * right bound, names which one, and never lets one investigation's evidence
 * ground another's conclusion is the whole of §8 and issue #21.
 */

const G1 = '11111111-1111-1111-1111-111111111111';
const G2 = '22222222-2222-2222-2222-222222222222';

function fakeClient(script: AgentTurnResult[]): AgentLlmClient & {
  requests: AgentTurnRequest[];
} {
  const requests: AgentTurnRequest[] = [];
  let i = 0;
  return {
    model: 'fake-model',
    requests,
    async turn(request) {
      requests.push(request);
      const step = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return step;
    },
  };
}

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}):
AgentTurnResult => ({
  ok: true, kind: 'tool_call', text: '', calls: [{ id, name, args }],
  usage: { tokensIn: 100, tokensOut: 20 },
});

const finalVerdict = (v: Partial<RawVerdict> = {}): AgentTurnResult => ({
  ok: true, kind: 'final',
  text: JSON.stringify({
    verdict: 'CONFIRMED_UNRESOLVABLE', confidence: 'high',
    summary: 'no bank record exists for this payment anywhere in the run',
    citations: [G1],
    reasoning: [{ step: 1, tool: 'get_exception', arguments: {},
      resultDigest: 'digest', inference: 'looked' }],
    proposedAction: null, ...v,
  }),
  usage: { tokensIn: 200, tokensOut: 80 },
});

/** A registry of one tool that returns whatever ids it is told to. */
function fakeRegistry(returnedIds: string[] = [G1]): ToolRegistry & { calls: number } {
  let calls = 0;
  const tool: AgentTool = {
    name: 'get_exception',
    description: 'x'.repeat(50),
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    async execute() {
      calls += 1;
      return { result: { ids: returnedIds }, returnedIds, digest: 'digest' };
    },
  };
  return {
    tools: [tool],
    get: (n) => (n === 'get_exception' ? tool : undefined),
    declarations: () => [{ name: tool.name, description: tool.description,
      parameters: tool.inputSchema }],
    get calls() { return calls; },
  } as ToolRegistry & { calls: number };
}

function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    client: fakeClient([finalVerdict()]),
    registry: fakeRegistry(),
    gateContext: {
      runId: 'run-1',
      records: new Map([[G1, {
        runId: 'run-1', sourceSystem: 'gateway' as const, direction: 'credit' as const,
        alreadyMatched: false,
      }]]),
      activeAliases: new Map(),
    },
    ...over,
  };
}

const REQUEST = {
  investigationId: 'inv-1', runId: 'run-1', exceptionId: 'exc-1',
  prompt: 'investigate this exception',
};

describe('extractVerdict', () => {
  test('parses bare JSON, fenced JSON, and JSON with surrounding prose', () => {
    const obj = { verdict: 'CONFIRMED_UNRESOLVABLE' };
    assert.deepEqual(extractVerdict(JSON.stringify(obj)), obj);
    assert.deepEqual(extractVerdict('```json\n' + JSON.stringify(obj) + '\n```'), obj);
    assert.deepEqual(extractVerdict('Here you go:\n' + JSON.stringify(obj) + '\nDone.'), obj);
  });

  test('returns null rather than a DEFAULT when nothing is usable', () => {
    // A defaulted verdict is one the model did not actually reach. The gate must
    // see the absence, not a plausible substitute.
    for (const bad of ['', 'no json here', '{ broken', '```\n```']) {
      assert.equal(extractVerdict(bad), null, JSON.stringify(bad));
    }
  });
});

describe('the loop reaches a verdict', () => {
  test('a tool call then a conclusion, with the tool actually executed', async () => {
    const registry = fakeRegistry();
    const out = await investigate(REQUEST, deps({
      client: fakeClient([toolCall('c1', 'get_exception'), finalVerdict()]),
      registry,
    }));
    assert.equal(out.stopCause, 'concluded');
    assert.equal(out.steps, 2);
    assert.equal(registry.calls, 1);
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.verdict.verdict, 'CONFIRMED_UNRESOLVABLE');
    assert.equal(out.verdict.groundingPassed, true);
    assert.equal(out.verdict.budgetExhausted, false);
  });

  test('usage accumulates across turns', async () => {
    const out = await investigate(REQUEST, deps({
      client: fakeClient([toolCall('c1', 'get_exception'), finalVerdict()]),
    }));
    assert.equal(out.usage.tokensIn, 300);
    assert.equal(out.usage.tokensOut, 100);
  });

  test('tool results are fed back, so the model sees what it asked for', async () => {
    const client = fakeClient([toolCall('c1', 'get_exception'), finalVerdict()]);
    await investigate(REQUEST, deps({ client }));
    const second = client.requests[1]!;
    assert.equal(second.messages.some((m) => m.role === 'tool_result'), true);
    assert.equal(second.messages.some((m) => m.role === 'assistant'), true);
  });
});

describe('§8 bounds — each one stops the loop and NAMES itself', () => {
  const never = (): AgentTurnResult => toolCall('c', 'get_exception');

  test('the step ceiling', async () => {
    const out = await investigate(REQUEST, deps({ client: fakeClient([never()]) }),
      { ...AGENT_DEFAULTS.budget, maxSteps: 3, maxToolCalls: 99 });
    assert.equal(out.stopCause, 'steps');
    assert.equal(out.steps, 3);
    assert.match(out.stopReason, /3-step ceiling/);
    assert.equal(out.verdict.budgetExhausted, true);
    assert.equal(out.verdict.verdict, 'INSUFFICIENT_EVIDENCE');
  });

  test('the tool-call ceiling', async () => {
    const out = await investigate(REQUEST, deps({ client: fakeClient([never()]) }),
      { ...AGENT_DEFAULTS.budget, maxSteps: 99, maxToolCalls: 2 });
    assert.equal(out.stopCause, 'tool_calls');
    assert.equal(out.toolCalls.length, 2);
    assert.match(out.stopReason, /2-tool-call ceiling/);
  });

  test('the wall clock, on an injected clock so the test is deterministic', async () => {
    let t = 0;
    const out = await investigate(REQUEST, deps({
      client: fakeClient([never()]),
      now: () => { t += 400; return t; },
    }), { ...AGENT_DEFAULTS.budget, maxSteps: 99, maxToolCalls: 99, maxWallMs: 1000 });
    assert.equal(out.stopCause, 'wall_clock');
    assert.match(out.stopReason, /1000 ms ceiling/);
  });

  test('the token ceiling', async () => {
    const out = await investigate(REQUEST, deps({ client: fakeClient([never()]) }),
      { ...AGENT_DEFAULTS.budget, maxSteps: 99, maxToolCalls: 99, maxTokens: 500 });
    assert.equal(out.stopCause, 'tokens');
    assert.match(out.stopReason, /500-token ceiling/);
  });

  test('EVERY bound produces budgetExhausted — an honest verdict, not a guess (§8)', async () => {
    // The S10 parallel: "I ran out of room" and "I looked and found nothing" are
    // different claims, and the system says which.
    for (const budget of [
      { maxSteps: 1, maxToolCalls: 99, maxWallMs: 60_000, maxTokens: 40_000 },
      { maxSteps: 99, maxToolCalls: 1, maxWallMs: 60_000, maxTokens: 40_000 },
      { maxSteps: 99, maxToolCalls: 99, maxWallMs: 60_000, maxTokens: 1 },
    ]) {
      const out = await investigate(REQUEST, deps({ client: fakeClient([never()]) }), budget);
      assert.equal(out.verdict.budgetExhausted, true, JSON.stringify(budget));
      assert.equal(out.verdict.verdict, 'INSUFFICIENT_EVIDENCE');
      assert.ok(out.stopReason.length > 20, 'the bound must name itself');
    }
  });

  test('a bound is checked BEFORE the call that would breach it', async () => {
    // A bound checked afterwards is a report, not a bound: with maxSteps 2 the
    // client must be called exactly twice, never a third time.
    const client = fakeClient([never()]);
    await investigate(REQUEST, deps({ client }),
      { ...AGENT_DEFAULTS.budget, maxSteps: 2, maxToolCalls: 99 });
    assert.equal(client.requests.length, 2);
  });

  test('the preflight hook can refuse a turn — the spend guard\'s seam', async () => {
    const client = fakeClient([never()]);
    const out = await investigate(REQUEST, deps({
      client,
      preflight: ({ step }) => (step > 2 ? 'refused: would exceed the daily spend cap' : null),
    }), { ...AGENT_DEFAULTS.budget, maxSteps: 99, maxToolCalls: 99 });
    assert.equal(client.requests.length, 2, 'the refused turn must not reach the model');
    assert.equal(out.verdict.budgetExhausted, true);
    assert.match(out.stopReason, /daily spend cap/);
  });
});

describe('failure is a verdict, never an exception (ADR-048)', () => {
  test('a transport failure concludes INSUFFICIENT_EVIDENCE with a stated cause', async () => {
    const out = await investigate(REQUEST, deps({
      client: fakeClient([{ ok: false, reason: 'transport', detail: '503 upstream',
        usage: { tokensIn: 50, tokensOut: 0 } }]),
    }));
    assert.equal(out.stopCause, 'transport');
    assert.match(out.stopReason, /503 upstream/);
    assert.equal(out.verdict.verdict, 'INSUFFICIENT_EVIDENCE');
    // Not a budget problem — the distinction is reported honestly.
    assert.equal(out.verdict.budgetExhausted, false);
    assert.equal(out.usage.tokensIn, 50, 'a failed request that reached the model still cost');
  });

  test('an unknown tool name is a step result, not a crash, and grounds NOTHING', async () => {
    const out = await investigate(REQUEST, deps({
      client: fakeClient([toolCall('c1', 'drop_database'), finalVerdict({ citations: [], reasoning: [] })]),
    }));
    assert.equal(out.stopCause, 'concluded');
    assert.equal(out.toolCalls.length, 0,
      'an unknown tool returned no ids and must not enter the allow-list');
  });

  test('a tool that THROWS does not kill the investigation or contribute evidence', async () => {
    const exploding: ToolRegistry = {
      tools: [],
      get: () => ({
        name: 'get_exception', description: 'x'.repeat(50),
        inputSchema: {}, readOnly: true,
        async execute() { throw new Error('connection reset'); },
      }) as AgentTool,
      declarations: () => [{ name: 'get_exception', description: 'x'.repeat(50),
        parameters: {} }],
    };
    const out = await investigate(REQUEST, deps({
      client: fakeClient([toolCall('c1', 'get_exception'), finalVerdict({ citations: [], reasoning: [] })]),
      registry: exploding,
    }));
    assert.equal(out.stopCause, 'concluded');
    assert.equal(out.toolCalls.length, 0, 'a failed tool returned nothing to cite');
  });

  test('a final message that is not JSON downgrades rather than inventing a verdict', async () => {
    const out = await investigate(REQUEST, deps({
      client: fakeClient([{ ok: true, kind: 'final', text: 'I think it is fine, honestly.',
        usage: { tokensIn: 10, tokensOut: 5 } }]),
    }));
    assert.equal(out.stopCause, 'concluded');
    assert.match(out.stopReason, /not usable JSON/);
    assert.equal(out.verdict.verdict, 'INSUFFICIENT_EVIDENCE');
    assert.equal(out.verdict.groundingPassed, false);
    assert.notEqual(out.groundingRejection, null);
  });
});

describe('grounding is PER-INVESTIGATION (issue #21)', () => {
  test('every tool record carries THIS investigation\'s id', async () => {
    const out = await investigate(REQUEST, deps({
      client: fakeClient([toolCall('c1', 'get_exception'), finalVerdict()]),
    }));
    assert.ok(out.toolCalls.length > 0);
    for (const c of out.toolCalls) assert.equal(c.investigationId, 'inv-1');
  });

  test('a citation the tools never returned is REJECTED', async () => {
    // The whole point of A3. The tool returns G1; the model cites G2.
    const out = await investigate(REQUEST, deps({
      client: fakeClient([toolCall('c1', 'get_exception'), finalVerdict({ citations: [G2] })]),
      registry: fakeRegistry([G1]),
    }));
    assert.equal(out.verdict.groundingPassed, false);
    assert.equal(out.verdict.verdict, 'INSUFFICIENT_EVIDENCE');
    assert.equal(out.groundingRejection?.check, 'grounding');
  });

  test('two investigations do not share an evidence base', async () => {
    // The failure this guards: accumulating tool calls at the RUN level would
    // let investigation B cite what investigation A retrieved. Nothing would
    // fail; the grounding-failure count would go DOWN.
    const a = await investigate(REQUEST, deps({
      client: fakeClient([toolCall('c1', 'get_exception'), finalVerdict()]),
      registry: fakeRegistry([G1]),
    }));
    const b = await investigate({ ...REQUEST, investigationId: 'inv-2' }, deps({
      client: fakeClient([finalVerdict({ citations: [G1], reasoning: [] })]),
      registry: fakeRegistry([G1]),
    }));
    assert.equal(a.verdict.groundingPassed, true, 'A retrieved G1 and may cite it');
    assert.equal(b.verdict.groundingPassed, false,
      'B never retrieved anything, so B may cite nothing — even an id A saw');
  });
});

describe('the reasoning chain is a TRANSCRIPT, not narration (§6)', () => {
  test('it is built from tool calls, and the digest is what the TOOL returned', async () => {
    const out = await investigate(REQUEST, deps({
      client: fakeClient([toolCall('c1', 'get_exception'), finalVerdict()]),
    }));
    const chain = reasoningChain(out.toolCalls, out.verdict);
    assert.equal(chain.length, 1);
    assert.equal(chain[0]!.tool, 'get_exception');
    assert.equal(chain[0]!.resultDigest, 'digest', 'never the model\'s paraphrase');
    assert.equal(chain[0]!.inference, 'looked');
  });

  test('a step the model narrated but never called does not appear', async () => {
    // Otherwise the chain would contain a step with no evidence behind it,
    // which is precisely the thing a reader is meant to be able to re-check.
    const out = await investigate(REQUEST, deps({
      client: fakeClient([finalVerdict({
        reasoning: [], citations: [],
      })]),
    }));
    assert.deepEqual(reasoningChain(out.toolCalls, out.verdict), []);
  });
});

describe('the agent can SEE its step budget', () => {
  test('every turn carries a countdown, and the last one forbids more tools', async () => {
    // The first live investigation spent all ten steps and never concluded,
    // because the model had no way to know a bound existed. A bound the agent
    // cannot see is a bound it cannot pace against.
    const client = fakeClient([toolCall('c1', 'get_exception')]);
    await investigate(REQUEST, deps({ client }),
      { ...AGENT_DEFAULTS.budget, maxSteps: 3, maxToolCalls: 99 });

    assert.equal(client.requests.length, 3);
    const lastTextOf = (i: number): string => {
      const msgs = client.requests[i]!.messages;
      const last = msgs[msgs.length - 1]!;
      return last.role === 'user' ? last.text : '';
    };
    assert.match(lastTextOf(0), /2 step\(s\) remain/);
    assert.match(lastTextOf(1), /1 step\(s\) remain/);
    assert.match(lastTextOf(2), /FINAL STEP\. Do not call any more tools/);
  });

  test('the countdown is a separate turn, so the cached prefix stays stable', async () => {
    // Editing the static system prompt per step would invalidate the prefix on
    // every turn — the one thing prompt caching cannot survive.
    const client = fakeClient([finalVerdict()]);
    await investigate(REQUEST, deps({ client }));
    assert.equal(client.requests[0]!.system, systemPrompt(),
      'the system prompt must be byte-identical across turns');
  });

  test('pacing does not pollute the stored history', async () => {
    // The countdown is scaffolding, not conversation. If it accumulated, step 10
    // would carry nine stale countdowns each contradicting the last.
    const client = fakeClient([toolCall('c1', 'get_exception')]);
    await investigate(REQUEST, deps({ client }),
      { ...AGENT_DEFAULTS.budget, maxSteps: 3, maxToolCalls: 99 });
    const third = client.requests[2]!.messages;
    const countdowns = third.filter(
      (m) => m.role === 'user' && /step\(s\) remain|FINAL STEP/.test(m.text));
    assert.equal(countdowns.length, 1, 'exactly one countdown, the current one');
  });
});

test('the system prompt states the ADR-049 rule and the four verdicts', () => {
  const p = systemPrompt();
  assert.match(p, /deterministic code computes/i);
  assert.match(p, /Never estimate a score/i);
  for (const v of ['RESOLUTION_PROPOSED', 'CONFIRMED_UNRESOLVABLE',
    'NEEDS_EXTERNAL_DATA', 'INSUFFICIENT_EVIDENCE']) {
    assert.match(p, new RegExp(v));
  }
  assert.match(p, /Confidence is a LABEL/);
  assert.match(p, /STEP BUDGET AND YOU CAN SEE IT/);
});
