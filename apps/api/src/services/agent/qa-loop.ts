/**
 * A2 Q&A — the question loop (agent-design.md §9). U15.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * A SECOND LOOP OVER THE SAME TOOLS, NOT A SECOND SYSTEM (§9).
 *
 * This shares `runAgentLoop` with investigations and corroborations — one
 * implementation of §8's bounds, one tool dispatch, one grounding plumbing —
 * and differs only in four things: the budget, the registry, the prompt, and
 * which A3 vocabulary validates the result. That is the same seam
 * `corroborate.ts` uses, and it is why this file is short.
 *
 * Three copies of the bounds would be three places for a ceiling to drift, and
 * the drift would be invisible because each copy would keep passing its own
 * tests.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT MAKES THIS DIFFERENT FROM AN INVESTIGATION ──
 * An investigation is handed ONE exception and asked to reach a verdict about
 * it. A question arrives as free text about a FINISHED RUN and may be about
 * anything in it — one settlement, a category, a merchant, a total. So:
 *
 *   · there is no verdict vocabulary; the prose IS the result;
 *   · there is no `proposedAction`, and the gate refuses one (ADR-081's line);
 *   · the opening prompt names no subject record, because there may not be one.
 *
 * ── "I DON'T KNOW" IS A REAL ANSWER, AND THE PROMPT SAYS SO ──
 * The investigation prompt had to be taught this the expensive way: a model
 * that cannot admit an empty result invents one. `CONFIRMED_UNRESOLVABLE` is
 * that admission for an investigation; for a question it is plainly saying the
 * run's data does not answer it. An agent that always produces an answer is an
 * agent whose answers carry no information.
 */

import { AGENT_DEFAULTS } from '../../config/defaults.js';
import type { InvestigationBudget, ToolCallRecord, ValidatedAnswer } from '../../types/agent.js';
import { validateAnswer } from './grounding-gate.js';
import { runAgentLoop, type LoopDeps, type StopCause } from './investigation-loop.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AgentUsage } from './agent-client.js';

/**
 * §9: "Bounded at 6 steps and 8 tool calls."
 *
 * `AGENT_DEFAULTS.qa` is numerically equal to `AGENT_DEFAULTS.corroborate` and
 * deliberately a separate constant — `defaults.ts` says why: they bound
 * different loops for different reasons, and collapsing them would mean a
 * change to one silently re-tuning the other.
 */
export const QA_BUDGET: InvestigationBudget = {
  maxSteps: AGENT_DEFAULTS.qa.maxSteps,
  maxToolCalls: AGENT_DEFAULTS.qa.maxToolCalls,
  maxWallMs: AGENT_DEFAULTS.budget.maxWallMs,
  maxTokens: AGENT_DEFAULTS.budget.maxTokens,
};

/**
 * §9: "Read-only tools only (`rerun_subset_search` is excluded — a question
 * should not spend a 2-second compute budget)."
 *
 * Removed from the REGISTRY rather than discouraged in the prompt, for the
 * reason `corroborate.ts` gives about the same tool: an instruction is a
 * request, an absent tool is a property. On a public, unauthenticated endpoint
 * that difference is the difference between a bound and a hope.
 *
 * `get_exception` STAYS, unlike corroboration — and the contrast is the point.
 * Corroboration excluded it because its subject is a `pending_review` match, so
 * the tool could only ever return `found: false`. A question's subject is the
 * whole run, and *"why wasn't settlement X matched?"* — §9's own first example —
 * is answered by exactly that tool.
 */
export const QA_EXCLUDED_TOOLS = ['rerun_subset_search'] as const;

export function qaRegistry(registry: ToolRegistry): ToolRegistry {
  const excluded = new Set<string>(QA_EXCLUDED_TOOLS);
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
  'You are the Analyst, answering a question about ONE finished reconciliation run. A',
  'deterministic engine has already matched what it could and filed the rest as exceptions.',
  'Your job is to answer the question from that run\'s real data, using the tools.',
  '',
  'THE ONE RULE THAT MATTERS: you choose which questions to ask; deterministic code computes',
  'every answer. Never estimate a score, compare two amounts, sum a set, or decide a date falls',
  'inside a window. Call a tool and use what it returns. A number you calculated yourself is',
  'not evidence and will be rejected.',
  '',
  'ALWAYS RETRIEVE BEFORE YOU ANSWER. An answer reached without calling a tool is not an',
  'answer about this run — it is a guess about reconciliation in general, and the gate rejects',
  'it. Every reasoning step you write is checked against the tools you ACTUALLY called.',
  '',
  '"THE DATA DOES NOT SHOW THAT" IS A REAL ANSWER AND OFTEN THE RIGHT ONE. If the run does not',
  'contain what the question asks for, say so plainly and say what you looked at. A confident',
  'answer built from nothing is the worst thing you can produce here — worse than no answer,',
  'because a reader cannot tell the difference without checking.',
  '',
  'CITATIONS ARE RECORD IDs -- the UUID-shaped values a tool returned, like',
  '"9f1c4d7e-0000-4000-8000-00000000000a": a transactionId, exceptionId or matchId. Cite only',
  'ones a tool actually returned to you while answering THIS question; an id you did not',
  'retrieve is an id you invented, and a deterministic gate will catch it and void the answer.',
  'A resultDigest is NOT a record id and must NEVER appear in "citations". It belongs only in',
  'reasoning[].resultDigest.',
  '',
  'YOU DO NOT RECOMMEND CHANGES. You report what the run\'s data says. Do not propose matching',
  'two records, creating a rule, or closing an exception — a human decides those through the',
  'review screens. An answer carrying a proposed action is refused outright.',
  '',
  'Confidence is a LABEL: high, medium or low. Never a number.',
  '',
  'YOU HAVE A TURN BUDGET AND YOU CAN SEE IT. Each turn tells you how many turns remain. When',
  'one turn remains, stop calling tools and write the answer from what you actually retrieved.',
  '',
  'Every tool result carries a short "resultDigest" like `get_exception:sha256:a3f9c1d20b44`.',
  'Copy it back EXACTLY in the matching reasoning step. It is a checksum, not a summary: a',
  'deterministic gate compares what you echo against what the tool actually returned, so a',
  'digest you alter or invent voids the answer. It is deliberately short — copy all of it.',
  '',
  'When you are done, reply with ONLY this JSON and no other text:',
  '{"answer":"the answer, in plain English, for a finance controller to read",',
  ' "confidence":"high|medium|low","citations":["<record ids a tool returned>"],',
  ' "reasoning":[{"step":1,"tool":"...","resultDigest":"<copied verbatim>",',
  '               "inference":"what you concluded from it"}]}',
].join('\n');

export function qaSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export interface QuestionRequest {
  /** The `agent_questions` row id. Every tool record is stamped with it (#21). */
  questionId: string;
  runId: string;
  /** The question as asked, already length-checked by the route. */
  question: string;
}

export interface QuestionOutcome {
  answer: ValidatedAnswer;
  toolCalls: ToolCallRecord[];
  steps: number;
  usage: AgentUsage;
  stopCause: StopCause;
  stopReason: string;
  groundingRejection: { check: string; reason: string } | null;
}

/**
 * The opening user turn.
 *
 * Names the run and nothing else. An investigation's prompt hands the model its
 * subject — the exception, its evidence, the engine's stated reasons — because
 * there is exactly one. A question has no such subject until the model goes and
 * finds it, so seeding a guess here would be putting words in the reader's
 * mouth and narrowing the search before it starts.
 */
export function questionPrompt(request: QuestionRequest): string {
  return [
    `Run under question: ${request.runId}`,
    '',
    'Question from a finance controller:',
    request.question,
  ].join('\n');
}

/**
 * Answer one question about a finished run.
 *
 * Never throws for a model or tool failure — every such outcome is an answer
 * with `groundingPassed: false` and a stated reason, the same posture
 * `investigate` and `corroborate` take. A budget-stopped run still goes through
 * the gate: it produced nothing to ground, so the gate refuses it, and the SAME
 * code path stamps every outcome. A bypass would be the one place an
 * ungrounded answer could reach a reader.
 */
export async function answerQuestion(
  request: QuestionRequest,
  deps: LoopDeps,
  budget: InvestigationBudget = QA_BUDGET,
): Promise<QuestionOutcome> {
  const out = await runAgentLoop(
    {
      // The loop stamps every tool record with this id and the gate verifies it
      // (#21). A question's evidence base is its own, exactly as an
      // investigation's is.
      investigationId: request.questionId,
      runId: request.runId,
      // `runAgentLoop` reads only `investigationId` and `prompt`; `exceptionId`
      // is carried by `InvestigationRequest` and never consumed. A question has
      // no single subject record, so the run id stands in rather than a
      // fabricated one. Worth collapsing into a narrower loop-request type one
      // day — not on the eve of a submission, and not in a file three working
      // paths share.
      exceptionId: request.runId,
      prompt: questionPrompt(request),
    },
    { ...deps, registry: qaRegistry(deps.registry) },
    budget,
    SYSTEM_PROMPT);

  const gate = validateAnswer(out.raw, {
    ...deps.gateContext,
    investigationId: request.questionId,
    toolCalls: out.toolCalls,
  });

  return {
    answer: { ...gate.answer, budgetExhausted: out.budgetExhausted },
    toolCalls: out.toolCalls,
    steps: out.steps,
    usage: out.usage,
    stopCause: out.stopCause,
    stopReason: out.stopReason,
    groundingRejection: gate.rejection,
  };
}
