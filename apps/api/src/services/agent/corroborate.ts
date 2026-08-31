/**
 * A2 CORROBORATE — the review queue as a second work list (agent-design §3, ADR-081).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * IT NEVER SAYS "CONFIRM THIS".
 *
 * §3: "The Analyst does not recommend confirming or rejecting a match. That
 * would be a language model influencing match/no-match, which is the exact thing
 * ADR-017 forbids and the reason a measured accuracy number means anything here."
 *
 * What it does instead is the work a reviewer would otherwise do by hand BEFORE
 * clicking: assemble the case. The verdict is a statement about EVIDENCE —
 * CORROBORATED, CONTRADICTED, NO_NEW_EVIDENCE — and the human still clicks,
 * through `PATCH /api/matches/:id`, exactly as today.
 *
 * Three things enforce that rather than requesting it: the vocabulary has no
 * word for a recommendation, `agent_corroborations` has no column to store one
 * (ADR-087), and the gate REFUSES a verdict carrying a `proposedAction` rather
 * than stripping it.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS IS WORTH DOING, AS THE TRADE IT IS ──
 * A corroborated proposal is a click a reviewer makes in seconds instead of
 * minutes, and the review queue is the largest single block of value in a run.
 * A confirmed pending match becomes `human_confirmed`, which DOES count toward
 * the engine match rate — so this is the one Analyst surface that can move the
 * headline, and it moves it only by making a human faster, never by deciding
 * anything. That distinction is the whole design.
 */

import { AGENT_DEFAULTS } from '../../config/defaults.js';
import type {
  InvestigationBudget, ToolCallRecord, ValidatedCorroboration,
} from '../../types/agent.js';
import { validateCorroboration } from './grounding-gate.js';
import { runAgentLoop, type LoopDeps, type StopCause } from './investigation-loop.js';
import type { AgentUsage } from './agent-client.js';
import type { ToolRegistry } from './tool-registry.js';
import { formatPaise } from '../ingestion/money.js';
import type { NormalizedTransaction } from '../../types/engine.js';
import type { Match } from '../../repositories/matches.js';

/** §3: bounded at 6 steps and 8 tool calls — half an investigation. */
export const CORROBORATION_BUDGET: InvestigationBudget = {
  maxSteps: AGENT_DEFAULTS.corroborate.maxSteps,
  maxToolCalls: AGENT_DEFAULTS.corroborate.maxToolCalls,
  maxWallMs: AGENT_DEFAULTS.budget.maxWallMs,
  maxTokens: AGENT_DEFAULTS.budget.maxTokens,
};

/**
 * §3: `rerun_subset_search` is excluded, as it is for the Q&A loop.
 *
 * Not because it would be harmful, but because it is the one tool that spends a
 * multi-second deterministic compute budget, and a question about whether a
 * PAIR has corroborating evidence has no business running a settlement
 * decomposition. Removing it from the registry is stronger than instructing the
 * model not to reach for it.
 */
export const CORROBORATION_EXCLUDED_TOOLS = ['rerun_subset_search'] as const;

export function corroborationRegistry(registry: ToolRegistry): ToolRegistry {
  const excluded = new Set<string>(CORROBORATION_EXCLUDED_TOOLS);
  const tools = registry.tools.filter((t) => !excluded.has(t.name));
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    tools: Object.freeze(tools),
    get: (name) => byName.get(name),
    declarations: () => tools.map((t) => ({
      name: t.name, description: t.description, parameters: t.inputSchema,
    })),
  };
}

const SYSTEM_PROMPT = [
  'You are the Analyst, working a payment reconciliation engine\'s REVIEW QUEUE.',
  '',
  'A deterministic engine found these records and scored them into a band where it declined',
  'to auto-confirm. A human will decide. YOUR JOB IS NOT TO DECIDE FOR THEM.',
  '',
  'You never say "confirm this" or "reject this". You assemble the case a reviewer would',
  'otherwise assemble by hand, and you report what you found. The engine already knows its',
  'own score; what is useful is evidence the SCORER DOES NOT USE:',
  '  - a shared reference sitting in the raw payload that normalization dropped',
  '    (get_transaction with includeRawPayload)',
  '  - a competing candidate that scores just as well (search_transactions, then score_pair)',
  '  - what the engine itself recorded about the decision (get_audit_trail)',
  '  - whether a human already resolved this exact shape before (find_similar_exceptions)',
  '',
  'Your verdict is a statement about EVIDENCE, never about the decision:',
  '  CORROBORATED     independent supporting evidence beyond the score, cited.',
  '  CONTRADICTED     evidence AGAINST -- a competing candidate scoring as well, or a',
  '                   contradicting reference in the raw payload.',
  '  NO_NEW_EVIDENCE  the engine\'s score is all there is. Say so. The human decides on that',
  '                   alone and now KNOWS that is all there is, which is worth reporting.',
  '',
  'NO_NEW_EVIDENCE is a real answer and often the right one. An agent asked fifteen times',
  'whether there is more evidence will start finding some if it believes it must.',
  '',
  'Never estimate a score. Call score_pair. Cite only ids a tool returned to you in THIS',
  'corroboration, and never name a tool you did not call -- both are checked.',
  '',
  'Confidence is a LABEL: high, medium or low. Never a number.',
  '',
  'When done, reply with ONLY this JSON:',
  '{"verdict":"...","confidence":"...","summary":"...","citations":["..."],',
  ' "reasoning":[{"step":1,"tool":"...","resultDigest":"<copied verbatim>",',
  '               "inference":"..."}]}',
].join('\n');

export function corroborationSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/** The opening message: the pending match, as the engine left it. */
export function buildCorroborationPrompt(
  match: Match, members: readonly NormalizedTransaction[],
): string {
  const parts: string[] = [
    `PENDING MATCH ${match.id}`,
    `  the engine scored this ${match.confidence} and declined to auto-confirm it`,
    `  tier: ${match.tier} · rule: ${match.ruleId} · cardinality: ${match.cardinality}`,
  ];
  if (match.amountDeltaPaise !== null) {
    parts.push(`  amount delta across members: ${formatPaise(match.amountDeltaPaise)}`);
  }
  if (match.dateDeltaDays !== null) parts.push(`  date delta: ${match.dateDeltaDays} day(s)`);
  if (match.scoreBreakdown !== null) {
    parts.push(`  score components: ${JSON.stringify(match.scoreBreakdown)}`);
  }

  parts.push('', 'THE RECORDS IT GROUPED');
  for (const m of members) {
    parts.push(`  - ${m.id}`);
    parts.push(`      ${m.sourceSystem} row ${m.sourceRowNumber} · `
      + `${formatPaise(m.amountPaise)} ${m.direction} · ${m.txnDate}`);
    parts.push(`      counterparty: ${m.counterpartyNorm ?? '(none)'} · `
      + `refs: ${JSON.stringify(m.referenceIds)}`);
  }

  parts.push('',
    'YOUR JOB: find evidence the scorer does not use, for or against. If there is none, say',
    'NO_NEW_EVIDENCE — that tells the reviewer the score is the whole story, which is itself',
    'worth knowing. Do not recommend confirming or rejecting.');
  parts.push('',
    'The ids above are context, not evidence. Retrieve anything you intend to cite.');
  return parts.join('\n');
}

export interface CorroborationOutcome {
  verdict: ValidatedCorroboration;
  toolCalls: ToolCallRecord[];
  steps: number;
  usage: AgentUsage;
  stopCause: StopCause;
  stopReason: string;
  groundingRejection: { check: string; reason: string } | null;
}

/**
 * Run one corroboration.
 *
 * Shares `runAgentLoop` with investigations — one implementation of §8's bounds,
 * the tool dispatch and the grounding plumbing — and differs only in the budget,
 * the registry, the prompt and which A3 vocabulary validates the result.
 */
export async function corroborate(
  request: { corroborationId: string; runId: string; matchId: string; prompt: string },
  deps: LoopDeps,
  budget: InvestigationBudget = CORROBORATION_BUDGET,
): Promise<CorroborationOutcome> {
  const out = await runAgentLoop(
    {
      // The loop stamps every tool record with this id and the gate verifies it
      // (#21). A corroboration's evidence base is its own, exactly as an
      // investigation's is.
      investigationId: request.corroborationId,
      runId: request.runId,
      exceptionId: request.matchId,
      prompt: request.prompt,
    },
    { ...deps, registry: corroborationRegistry(deps.registry) },
    budget,
    SYSTEM_PROMPT);

  const gate = validateCorroboration(out.raw, {
    ...deps.gateContext,
    investigationId: request.corroborationId,
    toolCalls: out.toolCalls,
  });

  return {
    verdict: { ...gate.verdict, budgetExhausted: out.budgetExhausted },
    toolCalls: out.toolCalls,
    steps: out.steps,
    usage: out.usage,
    stopCause: out.stopCause,
    stopReason: out.stopReason,
    groundingRejection: gate.rejection,
  };
}
