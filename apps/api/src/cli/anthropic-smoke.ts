/**
 * The cheapest possible first paid request (ADR-093).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * RUN THIS BEFORE `npm run analyst`. IT COSTS ABOUT A TENTH OF A CENT.
 *
 * It answers, in one call, the four things that would otherwise be discovered
 * halfway through a real run on a hard-capped key:
 *
 *   1. Does the key work at all, and is the model id valid?
 *   2. Does a TOOL CALL round-trip — declaration accepted, `tool_use` returned,
 *      result replayed, second turn accepted? That is the whole loop in
 *      miniature, and it is what broke on Gemini (`thought_signature`).
 *   3. What is per-turn latency? agent-design.md §8 bounds a WHOLE investigation
 *      at 60 s, and ADR-086 exists because a model was adopted from a
 *      description instead of a measurement. Do not adopt this one that way.
 *   4. What does a turn actually cost, at the rates in `defaults.ts`?
 *
 * `npm run smoke` (in apps/api).
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import {
  ANTHROPIC_COST_PER_MILLION, DEFAULT_ANTHROPIC_AGENT_MODEL,
} from '../config/defaults.js';
import {
  createAnthropicAgentClient, type AgentEffort,
} from '../services/agent/anthropic-agent-client.js';
import type { AgentMessage } from '../services/agent/agent-client.js';

function readEnvFile(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../../.env', import.meta.url).pathname, 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  } catch { return {}; }
}

async function main(): Promise<void> {
  const fileEnv = readEnvFile();
  const get = (k: string): string | undefined => process.env[k] ?? fileEnv[k];

  const apiKey = get('ANTHROPIC_API_KEY');
  if (apiKey === undefined || apiKey === '') {
    throw new Error('ANTHROPIC_API_KEY is not set (put it in apps/api/.env)');
  }
  const model = get('LLM_AGENT_MODEL') ?? DEFAULT_ANTHROPIC_AGENT_MODEL;
  const effort = (get('AGENT_EFFORT') ?? 'high') as AgentEffort;
  const client = createAnthropicAgentClient({ apiKey, model, effort });

  process.stdout.write(`model ${model} · effort ${effort}\n\n`);

  // A tool the model must call to answer — it cannot know the value otherwise,
  // so a `final` on turn 1 means tool use is not working.
  const tools = [{
    name: 'get_exception_count',
    description: 'Returns how many exceptions a reconciliation run produced. '
      + 'You cannot know this number without calling this tool.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
  }];

  const messages: AgentMessage[] = [{
    role: 'user',
    text: 'How many exceptions did run abc-123 produce? Call the tool, then reply '
      + 'with ONLY the number and nothing else.',
  }];

  const t0 = Date.now();
  const first = await client.turn({ system: 'You are a terse reconciliation assistant.', messages, tools, maxOutputTokens: 1024 });
  const turn1Ms = Date.now() - t0;

  if (!first.ok) {
    process.stdout.write(`TURN 1 FAILED (${first.reason}): ${first.detail}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`turn 1  ${first.kind}  ${turn1Ms} ms  `
    + `${first.usage.tokensIn} in / ${first.usage.tokensOut} out\n`);

  if (first.kind !== 'tool_call') {
    process.stdout.write(
      '\nTOOL USE DID NOT ROUND-TRIP: the model answered without calling the tool.\n'
      + 'The investigation loop depends on this. Do not spend a run until it works.\n');
    process.exitCode = 1;
    return;
  }
  const call = first.calls[0]!;
  process.stdout.write(`        called ${call.name}(${JSON.stringify(call.args)})`
    + `${call.providerSignature === undefined ? '' : ' · carries a providerSignature'}\n`);

  messages.push({ role: 'assistant', text: first.text, toolCalls: first.calls });
  messages.push({
    role: 'tool_result', callId: call.id, toolName: call.name,
    content: JSON.stringify({ exceptions: 212 }),
  });

  const t1 = Date.now();
  const second = await client.turn({ system: 'You are a terse reconciliation assistant.', messages, tools, maxOutputTokens: 1024 });
  const turn2Ms = Date.now() - t1;

  if (!second.ok) {
    // This is the shape of the Gemini `thought_signature` failure: turn 1 fine,
    // turn 2 rejected because the replayed history lost provider state.
    process.stdout.write(`\nTURN 2 FAILED (${second.reason}): ${second.detail}\n`
      + 'A turn-1-fine / turn-2-rejected pattern means replayed history is losing\n'
      + 'provider state — exactly what broke every multi-step run on Gemini.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`turn 2  ${second.kind}  ${turn2Ms} ms  `
    + `${second.usage.tokensIn} in / ${second.usage.tokensOut} out\n`);
  process.stdout.write(`        answer: ${second.kind === 'final' ? second.text.trim() : '(tool call)'}\n\n`);

  const rates = (ANTHROPIC_COST_PER_MILLION as Record<string,
  { inputUsdPerMillion: number; outputUsdPerMillion: number } | undefined>)[model];
  const tokensIn = first.usage.tokensIn + second.usage.tokensIn;
  const tokensOut = first.usage.tokensOut + second.usage.tokensOut;
  const cost = rates === undefined ? null
    : (tokensIn * rates.inputUsdPerMillion + tokensOut * rates.outputUsdPerMillion) / 1e6;

  const slowest = Math.max(turn1Ms, turn2Ms);
  process.stdout.write([
    '── ADR-086: MEASURE THE BOUND BEFORE ADOPTING THE MODEL ──',
    `slowest turn        ${slowest} ms`,
    `10 turns at that    ${((slowest * 10) / 1000).toFixed(1)} s  `
      + `(agent-design.md §8 bounds a whole investigation at 60 s)`,
    slowest * 10 > 60_000
      ? '  ⚠ A 10-step investigation would BREACH the 60 s bound. Lower AGENT_EFFORT,'
        + '\n    cut maxSteps, or raise the bound with an ADR — but do not just hope.'
      : '  ✓ Inside the bound at this effort.',
    '',
    `this smoke test cost ${cost === null ? 'unknown (no rate for this model)' : `$${cost.toFixed(5)}`}`,
    '',
    'DO NOT EXTRAPOLATE A RUN COST FROM THIS NUMBER. This is a 2-turn toy with',
    'a few hundred tokens of context. A real investigation resends the whole',
    'growing conversation every turn — the quadratic growth that IS the token',
    'defect — and the holdout measured ~47,500 input tokens for ONE. Multiplying',
    'this number by turns understates a real investigation by roughly 8x, and a',
    'plausible number with nothing measured behind it is how this repo has been',
    'burned five times. Size a run from `npm run analyst -- --dry-run` instead.',
    '',
  ].join('\n'));
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
