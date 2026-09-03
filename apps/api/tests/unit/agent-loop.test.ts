import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_DEFAULTS } from '../../src/config/defaults.js';
import {
  investigate, extractVerdict, reasoningChain, systemPrompt, AgentTransportError,
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
  test('a transport failure THROWS out of investigate(), with the provider cause stated', async () => {
    // A provider outage (no model turn ever succeeded) is not a verdict the A3
    // gate should judge: `runAgentLoop` returns the `{ __missing }` sentinel,
    // and feeding that to the gate would downgrade it to INSUFFICIENT_EVIDENCE
    // with a bogus `schema: verdict … got undefined` failure and fire
    // AGENT_GROUNDING_FAILED — blaming the model, and the §7 grounding-failure
    // metric, for something on the provider's side. So investigate() re-raises,
    // and investigateOne records the row as `failed` (re-runnable) instead.
    await assert.rejects(
      investigate(REQUEST, deps({
        client: fakeClient([{ ok: false, reason: 'transport', detail: '503 upstream',
          usage: { tokensIn: 50, tokensOut: 0 } }]),
      })),
      /503 upstream/,
    );
  });

  test('the transport error CARRIES the usage — a failed attempt still cost', async () => {
    // The assertion this replaces lived on the old return value: "a failed
    // request that reached the model still cost". Throwing must not lose it.
    // `agentSpendUsdSince` seeds the public endpoint's $2/hour ceiling by
    // summing `cost_usd` off these rows, so an outage that marks rows failed
    // with a NULL cost spends money the guard cannot see — and an outage is
    // precisely the event that takes this path over and over.
    await assert.rejects(
      investigate(REQUEST, deps({
        client: fakeClient([{ ok: false, reason: 'transport', detail: '503 upstream',
          usage: { tokensIn: 50, tokensOut: 7 } }]),
      })),
      (err: unknown) => {
        assert.ok(err instanceof AgentTransportError, 'must be the typed error');
        assert.equal(err.usage.tokensIn, 50);
        assert.equal(err.usage.tokensOut, 7);
        return true;
      },
    );
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

describe('the agent can SEE the budget that actually binds (see #64)', () => {
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
    // "turn(s)", not "step(s)" (see #64): the countdown is now the smaller of the
    // step ceiling and what the TOKEN ceiling affords, so calling it a step count
    // would reintroduce the confusion that killed 15 of 20 live investigations.
    assert.match(lastTextOf(0), /2 turn\(s\) left/);
    assert.match(lastTextOf(1), /1 turn\(s\) left/);
    assert.match(lastTextOf(2), /FINAL STEP\. Do not call any more tools/);
    // Withheld, not merely discouraged: the final turn is sent with NO tools.
    assert.deepEqual(client.requests[2]!.tools, []);
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
      (m) => m.role === 'user' && /steps? left|FINAL STEP/.test(m.text));
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
  assert.match(p, /TURN BUDGET AND YOU CAN SEE IT/);
  // Both failure directions the live runs found, addressed in the prompt.
  assert.match(p, /ALWAYS RETRIEVE BEFORE YOU CONCLUDE/);
  assert.match(p, /naming a tool you did not call voids the verdict/);
});

test('early turns push RETRIEVAL, late turns push CONCLUSION', async () => {
  // Live run 1: no countdown -> spent all ten steps, never concluded.
  // Live run 2: countdown urging conclusion from step one -> concluded
  // immediately and FABRICATED a reasoning step naming a tool it never called.
  // The tone has to track the budget, not push one way throughout.
  const client = fakeClient([toolCall('c1', 'get_exception')]);
  await investigate(REQUEST, deps({ client }),
    { ...AGENT_DEFAULTS.budget, maxSteps: 6, maxToolCalls: 99 });
  const textAt = (i: number): string => {
    const msgs = client.requests[i]!.messages;
    const last = msgs[msgs.length - 1]!;
    return last.role === 'user' ? last.text : '';
  };
  assert.match(textAt(0), /Retrieve the exception first/,
    'with nothing retrieved yet it must not invite a conclusion');
  assert.match(textAt(1), /Keep investigating/);
  assert.match(textAt(4), /Wrap up/);
  assert.match(textAt(5), /FINAL STEP/);
});

/**
 * ── THE PERSISTED CHAIN ATTACHES EACH INFERENCE TO ITS OWN EVIDENCE (#54) ──
 *
 * `reasoningChain` keyed inferences on the model's `step` number while the
 * runtime stamped every call in a turn with the same number. On holdout run
 * 80ddde9d, corroboration 4d7bfc85 made three `get_transaction` calls in one
 * turn and all three were persisted carrying the SAME inference — text that
 * described exactly one of them. A reader checking the chain had no way to tell.
 */
describe('reasoningChain attaches inferences by evidence, not by number (#54)', () => {
  const rec = (step: number, tool: string, digest: string): ToolCallRecord => ({
    investigationId: 'inv-1', step, tool, arguments: {}, returnedIds: [],
    resultDigest: digest, durationMs: 1,
  });

  test('three calls of one tool keep three distinct inferences', () => {
    const calls = [
      rec(1, 'get_transaction', 'get_transaction: {"id":"gateway"}'),
      rec(2, 'get_transaction', 'get_transaction: {"id":"bank"}'),
      rec(3, 'get_transaction', 'get_transaction: {"id":"ledger"}'),
    ];
    const chain = reasoningChain(calls, {
      reasoning: [
        { step: 1, tool: 'get_transaction',
          resultDigest: 'get_transaction: {"id":"gateway"}', inference: 'the gateway leg' },
        { step: 2, tool: 'get_transaction',
          resultDigest: 'get_transaction: {"id":"bank"}', inference: 'the bank leg' },
        { step: 3, tool: 'get_transaction',
          resultDigest: 'get_transaction: {"id":"ledger"}', inference: 'the ledger leg' },
      ],
    } as unknown as RawVerdict);

    assert.deepEqual(chain.map((c) => c.inference),
      ['the gateway leg', 'the bank leg', 'the ledger leg']);
  });

  test('a narrative written out of order still lands on the right evidence', () => {
    const calls = [
      rec(1, 'get_exception', 'get_exception: {"found":true}'),
      rec(2, 'find_by_anchor', 'find_by_anchor: {"exact":1}'),
    ];
    const chain = reasoningChain(calls, {
      reasoning: [
        { step: 1, tool: 'find_by_anchor',
          resultDigest: 'find_by_anchor: {"exact":1}', inference: 'found the anchor' },
        { step: 2, tool: 'get_exception',
          resultDigest: 'get_exception: {"found":true}', inference: 'read the exception' },
      ],
    } as unknown as RawVerdict);

    assert.equal(chain[0]!.inference, 'read the exception');
    assert.equal(chain[1]!.inference, 'found the anchor');
  });

  test('a call the model never narrated gets a BLANK inference, never a borrowed one', () => {
    // The chain is the transcript of what was done. A call with no write-up is
    // shown with none — inventing one, or reusing a neighbour's, would make the
    // transcript read as though the agent reasoned about evidence it ignored.
    const calls = [
      rec(1, 'get_exception', 'get_exception: {"found":true}'),
      rec(2, 'get_audit_trail', 'get_audit_trail: {"entries":3}'),
    ];
    const chain = reasoningChain(calls, {
      reasoning: [{ step: 1, tool: 'get_exception',
        resultDigest: 'get_exception: {"found":true}', inference: 'read the exception' }],
    } as unknown as RawVerdict);

    assert.equal(chain[0]!.inference, 'read the exception');
    assert.equal(chain[1]!.inference, '');
  });

  test('the call ordinal is per CALL, so a multi-call turn is legible', () => {
    // `step` is no longer a join key anywhere, so it means the thing a reader
    // assumes: the Nth thing this investigation did. Turn count stays separate.
    const calls = [
      rec(1, 'get_transaction', 'get_transaction: {"id":"a"}'),
      rec(2, 'get_transaction', 'get_transaction: {"id":"b"}'),
    ];
    assert.deepEqual(reasoningChain(calls, { reasoning: [] } as unknown as RawVerdict)
      .map((c) => c.step), [1, 2]);
  });
});

/**
 * ── THE TOKEN CEILING NO LONGER KILLS WORK IT ALREADY PAID FOR (see #64) ──
 *
 * Measured on holdout run 80ddde9d: the 10-step ceiling fired ZERO times and the
 * 40,000-token ceiling fired FIFTEEN, at steps 6-9. Fifteen investigations were
 * cut off mid-reasoning, each discarding 6-9 steps of real retrieval, and the
 * `remaining === 0` branch carrying "write your verdict now" was unreachable
 * because the countdown measured steps while tokens did the stopping.
 */
describe('a binding token ceiling asks for a verdict instead of cutting off (#64)', () => {
  /** Reports a fixed, large usage per turn so the token ceiling binds first. */
  function heavyClient(script: AgentTurnResult[], perTurnTokens: number) {
    const requests: AgentTurnRequest[] = [];
    let i = 0;
    return {
      requests,
      model: 'heavy',
      async turn(req: AgentTurnRequest): Promise<AgentTurnResult> {
        requests.push(req);
        const step = script[Math.min(i, script.length - 1)]!;
        i += 1;
        return { ...step, usage: { tokensIn: perTurnTokens, tokensOut: 0 } } as AgentTurnResult;
      },
    };
  }

  test('the model is TOLD to conclude, and its verdict is kept', async () => {
    // 10,000 tokens/turn against a 25,000 ceiling: room for two turns, and the
    // third would cross. The step ceiling (99) never binds.
    const client = heavyClient(
      [toolCall('c1', 'get_exception'), toolCall('c2', 'get_exception'), finalVerdict()],
      10_000);
    const out = await investigate(REQUEST, deps({ client }),
      { ...AGENT_DEFAULTS.budget, maxSteps: 99, maxToolCalls: 99, maxTokens: 25_000 });

    const lastText = (i: number): string => {
      const msgs = client.requests[i]!.messages;
      const last = msgs[msgs.length - 1]!;
      return last.role === 'user' ? last.text : '';
    };
    const finalIdx = client.requests.length - 1;
    assert.match(lastText(finalIdx), /FINAL STEP/,
      'the turn before the ceiling must ask for a verdict, not be cut off');
    assert.deepEqual(client.requests[finalIdx]!.tools, [],
      'tools are WITHHELD on the conclude turn, not merely discouraged');
    assert.equal(out.stopCause, 'concluded');
    assert.equal(out.verdict.verdict, 'CONFIRMED_UNRESOLVABLE',
      'the verdict written on the conclude turn is the one that is kept');
  });

  test('the countdown reflects TOKENS when tokens bind before steps', async () => {
    // The defect in one assertion: with a 99-step ceiling and tokens affording
    // ~3 turns, the old countdown said "98 steps left" right up to the kill.
    // The SHIPPED config's shape: a 10-step ceiling with tokens funding ~3 turns.
    // Turn 1 legitimately reports the step bound (nothing is measured yet, and it
    // is a true upper bound); from turn 2 the countdown must CORRECT DOWNWARD to
    // what the tokens actually fund. Before this fix it never corrected at all.
    const client = heavyClient([toolCall('c1', 'get_exception')], 10_000);
    await investigate(REQUEST, deps({ client }),
      { ...AGENT_DEFAULTS.budget, maxSteps: 10, maxToolCalls: 99, maxTokens: 30_000 });

    const texts = client.requests.map((r) => {
      const last = r.messages[r.messages.length - 1]!;
      return last.role === 'user' ? last.text : '';
    });
    assert.match(texts[0]!, /9 turns left/, 'turn 1 reports the step bound');
    assert.match(texts[1]!, /2 turn\(s\) left/,
      `turn 2 must correct to what the tokens fund, not stay on the step count: ${texts[1]}`);
    assert.ok(texts.some((t) => /FINAL STEP/.test(t)), 'it must still reach the conclude turn');
  });

  test('a SPEND refusal is a hard stop — no extra turn is granted', async () => {
    // The distinction that matters on a prepaid key with auto-reload off. A
    // token ceiling is a WORK bound: the money is already spent, so one more
    // turn to convert it into a verdict is free of regret. A spend ceiling is a
    // MONEY bound: a "final" turn spends exactly what the guard just refused.
    const client = fakeClient([toolCall('c', 'get_exception')]);
    const out = await investigate(REQUEST, deps({
      client,
      preflight: ({ step }) => (step > 2 ? 'refused: would cross the run ceiling' : null),
    }), { ...AGENT_DEFAULTS.budget, maxSteps: 99, maxToolCalls: 99 });

    assert.equal(client.requests.length, 2,
      'the refused turn must not reach the model, even to conclude');
    assert.equal(out.verdict.budgetExhausted, true);
    assert.match(out.stopReason, /would cross the run ceiling/);
  });
});

/**
 * ── A FORMATTING MISS EARNS ONE RE-ASK; A HALLUCINATION STILL EARNS NONE ──
 *
 * The first live Sonnet run lost 2 of 2 investigations to "the model finished
 * but its final message was not usable JSON" — after 4-7 real tool calls each,
 * with no bound having bound. Discarding that is the same waste #64 removed
 * from the token ceiling, arriving through a different door.
 *
 * This does NOT weaken A3's no-retry rule. That rule forbids a second attempt
 * at a HALLUCINATED answer, because a retry loop selects for whichever output
 * happens to pass the gate. Here nothing is re-judged: the same evidence is
 * re-serialised, and the gate still sees the result exactly once.
 */
describe('prose instead of a verdict earns ONE re-ask (ADR-093)', () => {
  const prose = (): AgentTurnResult => ({
    ok: true, kind: 'final',
    text: 'Based on my investigation, this exception cannot be resolved.',
    usage: { tokensIn: 100, tokensOut: 20 },
  });

  test('the re-ask withholds tools and the second reply is used', async () => {
    const client = fakeClient([toolCall('c1', 'get_exception'), prose(), finalVerdict()]);
    const out = await investigate(REQUEST, deps({ client }), AGENT_DEFAULTS.budget);

    assert.equal(client.requests.length, 3, 'tool call, prose, then the re-ask');
    assert.deepEqual(client.requests[2]!.tools, [], 'the re-ask offers no tools');
    const last = client.requests[2]!.messages[client.requests[2]!.messages.length - 1]!;
    assert.match(last.role === 'user' ? last.text : '', /ONLY the verdict JSON object/);
    assert.equal(out.verdict.verdict, 'CONFIRMED_UNRESOLVABLE');
    assert.equal(out.verdict.groundingPassed, true, 'the recovered verdict still passes A3');
  });

  test('prose TWICE is accepted as a failure — the re-ask is one-shot', async () => {
    const client = fakeClient([toolCall('c1', 'get_exception'), prose(), prose()]);
    const out = await investigate(REQUEST, deps({ client }), AGENT_DEFAULTS.budget);

    assert.equal(client.requests.length, 3, 'exactly one re-ask, never a loop');
    assert.equal(out.verdict.verdict, 'INSUFFICIENT_EVIDENCE');
    assert.match(out.stopReason, /not usable JSON, twice/);
  });

  test('the re-ask does NOT re-judge a verdict the gate rejected', async () => {
    // The line that keeps ADR-050 intact. A verdict that PARSES and then fails
    // grounding is a hallucination, and it is downgraded once with no second
    // attempt — only unparseable output earns the re-ask.
    const hallucinated = finalVerdict({
      reasoning: [{ step: 1, tool: 'rerun_subset_search', arguments: {},
        resultDigest: 'invented', inference: 'I widened the bounds' }],
    });
    const client = fakeClient([toolCall('c1', 'get_exception'), hallucinated, finalVerdict()]);
    const out = await investigate(REQUEST, deps({ client }), AGENT_DEFAULTS.budget);

    assert.equal(client.requests.length, 2, 'a rejected verdict is NOT re-asked');
    assert.equal(out.verdict.groundingPassed, false);
    assert.match(out.verdict.groundingFailure!, /never called/);
  });
});

describe('a citation is a record id, never a checksum (ADR-093)', () => {
  // The first run on the shortened digest had SIX of ten investigations cite the
  // DIGEST as a record id. The gate was right to reject them -- a digest is in no
  // tool's `returnedIds` -- but the prompt had only ever said "cite ids a tool
  // returned", and `get_exception#9e738444619a` reads exactly like one. Two
  // changes, because either alone leaves the trap half-set: the digest now says
  // `sha256` out loud, and the prompt says what a citation IS rather than only
  // what it is not.
  test('the prompt defines a citation by SHAPE and excludes the digest', () => {
    const p = systemPrompt();
    assert.match(p, /CITATIONS ARE RECORD IDs/);
    assert.match(p, /UUID-shaped/);
    assert.match(p, /resultDigest is NOT a record id/);
    assert.match(p, /NEVER appear in "citations"/);
  });

  test('the digest format the prompt shows is the one the registry emits', () => {
    // A prompt that illustrates a stale format teaches the model to produce
    // something the gate will refuse — which reads as the model being wrong.
    assert.match(systemPrompt(), /:sha256:/);
  });
});
