import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_DEFAULTS } from '../../src/config/defaults.js';
import {
  corroborate, corroborationRegistry, corroborationSystemPrompt,
  buildCorroborationPrompt, CORROBORATION_BUDGET,
} from '../../src/services/agent/corroborate.js';
import { createToolRegistry } from '../../src/services/agent/tool-registry.js';
import type { LoopDeps } from '../../src/services/agent/investigation-loop.js';
import type {
  AgentLlmClient, AgentTurnResult,
} from '../../src/services/agent/agent-client.js';
import type { AgentTool } from '../../src/types/agent.js';
import type { ToolRegistry } from '../../src/services/agent/tool-registry.js';
import type { Match } from '../../src/repositories/matches.js';
import type { NormalizedTransaction } from '../../src/types/engine.js';
import { ENGINE_DEFAULTS } from '../../src/config/defaults.js';

const G1 = '11111111-1111-1111-1111-111111111111';

function fakeClient(script: AgentTurnResult[]): AgentLlmClient {
  let i = 0;
  return {
    model: 'fake',
    async turn() { const s = script[Math.min(i, script.length - 1)]!; i += 1; return s; },
  };
}

function fakeRegistry(): ToolRegistry {
  const mk = (name: string): AgentTool => ({
    name, description: 'x'.repeat(50), inputSchema: { type: 'object' }, readOnly: true,
    async execute() { return { result: { id: G1 }, returnedIds: [G1], digest: 'digest' }; },
  });
  const tools = [mk('get_transaction'), mk('rerun_subset_search'), mk('score_pair')];
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    tools, get: (n) => byName.get(n),
    declarations: () => tools.map((t) => ({
      name: t.name, description: t.description, parameters: t.inputSchema })),
  };
}

/**
 * A corroboration that LOOKED. Every corroboration verdict asserts something —
 * including NO_NEW_EVIDENCE, which claims "the score is all there is" and so
 * claims to have checked — hence a reasoning chain by default.
 */
const finalOf = (over: Record<string, unknown> = {}): AgentTurnResult => ({
  ok: true, kind: 'final',
  text: JSON.stringify({
    verdict: 'NO_NEW_EVIDENCE', confidence: 'medium',
    summary: 'the engine score is the whole story here',
    citations: [],
    reasoning: [{ step: 1, tool: 'get_transaction', arguments: {},
      resultDigest: 'digest', inference: 'the raw payload adds nothing' }],
    ...over,
  }),
  usage: { tokensIn: 100, tokensOut: 30 },
});

/** One tool call, so the reasoning chain above has a real call behind it. */
const lookFirst: AgentTurnResult = {
  ok: true, kind: 'tool_call', text: '',
  calls: [{ id: 'c', name: 'get_transaction', args: {} }],
  usage: { tokensIn: 20, tokensOut: 5 },
};

function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    client: fakeClient([finalOf()]),
    registry: fakeRegistry(),
    gateContext: { runId: 'run-1', records: new Map(), activeAliases: new Map() },
    ...over,
  };
}

const REQ = { corroborationId: 'corr-1', runId: 'run-1', matchId: 'm-1', prompt: 'p' };

describe('rerun_subset_search is EXCLUDED from corroboration (§3)', () => {
  test('the registry the model is shown does not contain it', async () => {
    const trimmed = corroborationRegistry(fakeRegistry());
    assert.equal(trimmed.get('rerun_subset_search'), undefined);
    assert.equal(trimmed.declarations().some((d) => d.name === 'rerun_subset_search'), false);
    // Removing it from the registry is stronger than instructing the model not
    // to reach for it: a question about whether a PAIR has corroborating
    // evidence has no business running a settlement decomposition.
    assert.ok(trimmed.get('get_transaction'));
    assert.ok(trimmed.get('score_pair'));
  });

  test('the real registry loses exactly one of its nine tools', () => {
    const full = createToolRegistry({
      runId: 'r', config: { ...ENGINE_DEFAULTS, referenceDate: '2026-08-21', aliasCountAtStart: 0 },
    });
    assert.equal(full.tools.length, 9);
    assert.equal(corroborationRegistry(full).tools.length, 8);
  });
});

describe('the corroboration budget is half an investigation (§3)', () => {
  test('6 steps and 8 tool calls, from their OWN constant', () => {
    assert.equal(CORROBORATION_BUDGET.maxSteps, 6);
    assert.equal(CORROBORATION_BUDGET.maxToolCalls, 8);
    assert.equal(CORROBORATION_BUDGET.maxSteps, AGENT_DEFAULTS.corroborate.maxSteps);
    assert.ok(CORROBORATION_BUDGET.maxSteps < AGENT_DEFAULTS.budget.maxSteps);
  });

  test('the step bound stops it and reports budgetExhausted', async () => {
    const never: AgentTurnResult = {
      ok: true, kind: 'tool_call', text: '',
      calls: [{ id: 'c', name: 'get_transaction', args: {} }],
      usage: { tokensIn: 10, tokensOut: 2 },
    };
    const out = await corroborate(REQ, deps({ client: fakeClient([never]) }));
    assert.equal(out.stopCause, 'steps');
    assert.equal(out.steps, 6);
    assert.equal(out.verdict.budgetExhausted, true);
    assert.equal(out.verdict.verdict, 'NO_NEW_EVIDENCE', 'the honest floor, not CONTRADICTED');
  });
});

describe('it reports EVIDENCE, never a decision', () => {
  test('a NO_NEW_EVIDENCE that actually LOOKED passes the gate', async () => {
    const out = await corroborate(REQ, deps({
      client: fakeClient([lookFirst, finalOf()]) }));
    assert.equal(out.verdict.groundingPassed, true);
    assert.equal(out.verdict.verdict, 'NO_NEW_EVIDENCE');
    assert.equal(out.groundingRejection, null);
  });

  test('NO_NEW_EVIDENCE reached WITHOUT looking is rejected', async () => {
    // "The engine's score is all there is" is a claim about having checked.
    // Reaching it for free would make it the cheapest verdict available, which
    // is exactly how an agent learns to stop investigating.
    const out = await corroborate(REQ, deps({
      client: fakeClient([finalOf({ reasoning: [] })]) }));
    assert.equal(out.verdict.groundingPassed, false);
    assert.match(out.groundingRejection!.reason, /requires a reasoning chain/);
  });

  test('a verdict carrying a proposedAction is REFUSED', async () => {
    // The model has been told the wrong job; refusing surfaces that, stripping
    // would hide it.
    const out = await corroborate(REQ, deps({
      client: fakeClient([lookFirst, finalOf({
        proposedAction: { type: 'MARK_WONT_FIX', rationale: 'just confirm it' } })]),
    }));
    assert.equal(out.verdict.groundingPassed, false);
    assert.match(out.groundingRejection!.reason, /must not carry a proposedAction/);
  });

  test('an INVESTIGATION verdict does not validate here', async () => {
    const out = await corroborate(REQ, deps({
      client: fakeClient([lookFirst, finalOf({ verdict: 'RESOLUTION_PROPOSED' })]) }));
    assert.equal(out.verdict.groundingPassed, false);
    assert.equal(out.verdict.verdict, 'NO_NEW_EVIDENCE');
  });

  test('a citation no tool returned is rejected, and none survives', async () => {
    const out = await corroborate(REQ, deps({
      client: fakeClient([finalOf({ citations: [G1] })]) }));  // no tool call at all
    assert.equal(out.verdict.groundingPassed, false);
    assert.deepEqual(out.verdict.citations, []);
  });

  test('tool records carry THIS corroboration\'s id (#21)', async () => {
    const out = await corroborate(REQ, deps({
      client: fakeClient([
        { ok: true, kind: 'tool_call', text: '',
          calls: [{ id: 'c', name: 'get_transaction', args: {} }],
          usage: { tokensIn: 5, tokensOut: 1 } },
        finalOf({ citations: [G1] }),
      ]) }));
    assert.equal(out.verdict.groundingPassed, true);
    for (const c of out.toolCalls) assert.equal(c.investigationId, 'corr-1');
  });
});

describe('the prompt and its instructions', () => {
  const match = {
    id: 'm-1', tier: 'fuzzy', confidence: 0.71, ruleId: 'R', cardinality: 'one_to_one',
    amountDeltaPaise: 250, dateDeltaDays: 2, scoreBreakdown: { anchor: 0.2 },
  } as unknown as Match;
  const members = [{
    id: G1, sourceSystem: 'gateway', sourceRowNumber: 4, amountPaise: 100000,
    direction: 'credit', txnDate: '2026-08-14', counterpartyNorm: 'ACME',
    referenceIds: { rrn: 'X' },
  }] as unknown as NormalizedTransaction[];

  test('it states the engine declined to auto-confirm, and shows the members', () => {
    const p = buildCorroborationPrompt(match, members);
    assert.match(p, /declined to auto-confirm/);
    assert.match(p, new RegExp(G1));
    assert.match(p, /context, not evidence/);
    assert.match(p, /Do not recommend confirming or rejecting/);
  });

  test('the system prompt forbids recommending and legitimises NO_NEW_EVIDENCE', () => {
    const p = corroborationSystemPrompt();
    assert.match(p, /never say "confirm this"/i);
    assert.match(p, /NO_NEW_EVIDENCE is a real answer/);
    assert.match(p, /evidence the SCORER DOES NOT USE/);
    // It must not offer the investigation vocabulary at all.
    assert.doesNotMatch(p, /RESOLUTION_PROPOSED/);
  });
});
