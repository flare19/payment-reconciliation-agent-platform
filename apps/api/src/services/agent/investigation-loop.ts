/**
 * A2 — the investigation loop (agent-design.md §3, §6, §8). U13.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE LOOP IS WRITTEN OUT ON PURPOSE.
 *
 * §3: "No automatic tool-loop helper is used — the loop is written out, because
 * §8's step, tool-call, wall-clock and request bounds have to be enforced
 * between turns and a helper that hides the turn boundary hides the place the
 * bounds live."
 *
 * Every bound below is checked at a turn boundary, before the call that would
 * breach it. A bound checked afterwards is a report, not a bound.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── BUDGET EXHAUSTION IS AN HONEST VERDICT, NEVER A GUESS (§8) ──
 * When a bound stops the loop the verdict is `INSUFFICIENT_EVIDENCE` with
 * `budgetExhausted: true` and a reason naming WHICH bound. This mirrors S10's
 * `searchBoundExceeded` exactly: "I ran out of room" and "I looked and found
 * nothing" are different claims and the system says which. An agent that
 * produces its best guess when it runs out of room is worse than one that says
 * it ran out of room.
 *
 * ── GROUNDING IS PER-INVESTIGATION, AND THAT IS LOAD-BEARING (issue #21) ──
 * Every `ToolCallRecord` this loop produces carries THIS investigation's id, and
 * the A3 gate throws if handed one that does not. The natural implementation —
 * accumulate tool calls on the run-level phase and pass them down — silently
 * widens the allow-list to every investigation in the run, so one
 * investigation's results ground another's conclusions. Nothing would fail; the
 * grounding-failure count would go DOWN. The records never leave this function's
 * local array until they are handed to the gate with the matching id.
 *
 * ── THE MODEL NEVER SEES A NUMBER IT DID NOT ASK FOR ──
 * The loop passes tool results through verbatim as digests. It computes nothing,
 * compares nothing, and summarises nothing numeric (ADR-049). Every figure in a
 * reasoning chain came out of `scorePair`, `decomposeBatch` or a repository read.
 */

import { AGENT_DEFAULTS } from '../../config/defaults.js';
import type {
  InvestigationBudget, RawVerdict, ReasoningStep, ToolCallRecord, ValidatedVerdict,
} from '../../types/agent.js';
import { validateVerdict, type GateContext } from './grounding-gate.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  ZERO_USAGE, type AgentLlmClient, type AgentMessage, type AgentUsage,
} from './agent-client.js';

/** Which bound stopped an investigation. Named, never collapsed to "budget". */
export type StopCause =
  | 'concluded' | 'steps' | 'tool_calls' | 'wall_clock' | 'tokens'
  | 'transport' | 'no_verdict';

export interface InvestigationRequest {
  /** The row id from `startInvestigation`. Every tool record is stamped with it. */
  investigationId: string;
  runId: string;
  exceptionId: string;
  /** The opening user message: the exception, its evidence, the engine's reasons. */
  prompt: string;
}

export interface InvestigationOutcome {
  verdict: ValidatedVerdict;
  toolCalls: ToolCallRecord[];
  steps: number;
  usage: AgentUsage;
  stopCause: StopCause;
  /** Why the loop stopped, in a sentence. Never a placeholder. */
  stopReason: string;
  /** Rejection from A3, if the gate downgraded the verdict. */
  groundingRejection: { check: string; reason: string } | null;
}

export interface LoopDeps {
  client: AgentLlmClient;
  registry: ToolRegistry;
  /** The A3 evidence base, minus `toolCalls` — the loop supplies those itself. */
  gateContext: Omit<GateContext, 'investigationId' | 'toolCalls'>;
  /**
   * Injected so the loop is deterministic under test. `Date.now` in production.
   * ADR-039 does not apply — this bounds the AGENT, never a matching decision,
   * and no engine output depends on it.
   */
  now?: () => number;
  /**
   * Called before every model turn. Returning a string REFUSES the turn with
   * that reason — the seam the spend guard plugs into, so a pre-flight cost
   * refusal reads as `budgetExhausted` rather than as a crash.
   */
  preflight?: (estimate: { step: number; usageSoFar: AgentUsage }) => string | null;
}

const SYSTEM_PROMPT = [
  'You are the Analyst: a finance-operations investigator working the exception queue of a',
  'payment reconciliation engine. A deterministic engine has already reconciled what it could.',
  'Your job is to investigate ONE exception it could not resolve, and reach an honest verdict.',
  '',
  'THE ONE RULE THAT MATTERS: you choose which questions to ask; deterministic code computes',
  'every answer. Never estimate a score, compare two amounts, sum a subset, or decide a date',
  'falls inside a window. Call score_pair or rerun_subset_search and use what they return. A',
  'number you calculated yourself is not evidence and will be rejected.',
  '',
  'Cite only ids that a tool actually returned to you in THIS investigation. An id you did not',
  'retrieve is an id you invented, and a deterministic gate will catch it and void your verdict.',
  '',
  'Verdicts:',
  '  RESOLUTION_PROPOSED     a concrete, human-confirmable action with cited evidence',
  '  CONFIRMED_UNRESOLVABLE  you investigated and agree with the engine, WITH A STATED REASON.',
  '                          This is not a failure. It is often the correct answer, and it is',
  '                          worth more than a speculative proposal.',
  '  NEEDS_EXTERNAL_DATA     resolvable in principle, but needs a document this system does not',
  '                          have. Name the document.',
  '  INSUFFICIENT_EVIDENCE   you could not determine it within your budget.',
  '',
  'Confidence is a LABEL: high, medium or low. Never a number.',
  '',
  'Every tool result carries a "resultDigest" string. Copy it back VERBATIM in the matching',
  'reasoning step. It is a checksum, not a summary: a deterministic gate compares what you',
  'echo against what the tool actually returned, so a digest you paraphrase or invent voids',
  'the verdict. Do not rewrite it, shorten it, or reformat it.',
  '',
  'When you are done, reply with ONLY this JSON and no other text:',
  '{"verdict":"...","confidence":"...","summary":"...","citations":["..."],',
  ' "reasoning":[{"step":1,"tool":"...","resultDigest":"<copied verbatim>",',
  '               "inference":"what you concluded from it"}],',
  ' "proposedAction":null}',
].join('\n');

export function systemPrompt(): string {
  return SYSTEM_PROMPT;
}

/**
 * Parse the model's final message into a `RawVerdict`.
 *
 * Deliberately lenient about WRAPPING and strict about CONTENT: a fenced code
 * block or a stray sentence around the JSON is a formatting slip the gate should
 * not have to care about, but a missing field is a defect A3 must see. So this
 * extracts the object and hands it over untouched — it never fills a default,
 * because a defaulted verdict is one the model did not actually reach.
 */
export function extractVerdict(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Run one investigation.
 *
 * Never throws for a model or tool failure — every such outcome is a verdict
 * with a stated cause. It throws only for a programming error the caller should
 * see, which is the same line `grounding-gate.ts` draws.
 */
export async function investigate(
  request: InvestigationRequest,
  deps: LoopDeps,
  budget: InvestigationBudget = AGENT_DEFAULTS.budget,
): Promise<InvestigationOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const toolCalls: ToolCallRecord[] = [];
  const messages: AgentMessage[] = [{ role: 'user', text: request.prompt }];
  const usage: AgentUsage = { ...ZERO_USAGE };

  let steps = 0;
  let raw: unknown = null;
  let stopCause: StopCause = 'no_verdict';
  let stopReason = 'the loop ended without the model reaching a verdict';

  const declarations = deps.registry.declarations();

  for (;;) {
    // ── BOUNDS, CHECKED BEFORE THE CALL THAT WOULD BREACH THEM ──
    if (steps >= budget.maxSteps) {
      stopCause = 'steps';
      stopReason = `stopped at the ${budget.maxSteps}-step ceiling before reaching a verdict`;
      break;
    }
    if (toolCalls.length >= budget.maxToolCalls) {
      stopCause = 'tool_calls';
      stopReason = `stopped at the ${budget.maxToolCalls}-tool-call ceiling`;
      break;
    }
    const elapsed = now() - startedAt;
    if (elapsed >= budget.maxWallMs) {
      stopCause = 'wall_clock';
      stopReason = `stopped after ${elapsed} ms, at the ${budget.maxWallMs} ms ceiling`;
      break;
    }
    if (usage.tokensIn + usage.tokensOut >= budget.maxTokens) {
      stopCause = 'tokens';
      stopReason =
        `stopped after ${usage.tokensIn + usage.tokensOut} tokens, at the `
        + `${budget.maxTokens}-token ceiling`;
      break;
    }
    const refusal = deps.preflight?.({ step: steps + 1, usageSoFar: { ...usage } }) ?? null;
    if (refusal !== null) {
      stopCause = 'tokens';
      stopReason = refusal;
      break;
    }

    steps += 1;
    const turn = await deps.client.turn({
      system: SYSTEM_PROMPT,
      messages,
      tools: declarations,
      maxOutputTokens: 2048,
    });

    // Usage accrues even on failure — a request that reached the model cost
    // tokens, and a ledger that misses them understates a bill.
    usage.tokensIn += turn.usage.tokensIn;
    usage.tokensOut += turn.usage.tokensOut;

    if (!turn.ok) {
      stopCause = 'transport';
      stopReason = `the model could not be reached (${turn.reason}): ${turn.detail}`;
      break;
    }

    if (turn.kind === 'final') {
      raw = extractVerdict(turn.text);
      stopCause = 'concluded';
      stopReason = raw === null
        ? 'the model finished but its final message was not usable JSON'
        : `the model concluded after ${steps} step(s)`;
      break;
    }

    // ── TOOL CALLS ──
    messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.calls });

    for (const call of turn.calls) {
      if (toolCalls.length >= budget.maxToolCalls) {
        // The remaining calls in this turn are not executed. The model is told,
        // so its next turn is not reasoning over a silently missing result.
        messages.push({
          role: 'tool_result', callId: call.id, toolName: call.name,
          content: JSON.stringify({
            error: 'tool-call budget exhausted for this investigation',
            maxToolCalls: budget.maxToolCalls,
          }),
        });
        continue;
      }

      const tool = deps.registry.get(call.name);
      if (tool === undefined) {
        // A model inventing a tool name is an ordinary event, not a crash. It
        // gets a result it can correct on the next step, and NOTHING is added
        // to the grounding allow-list — an unknown tool returned no ids.
        messages.push({
          role: 'tool_result', callId: call.id, toolName: call.name,
          content: JSON.stringify({
            error: `no such tool: ${call.name}`,
            availableTools: declarations.map((d) => d.name),
          }),
        });
        continue;
      }

      const t0 = now();
      let result: { result: unknown; returnedIds: string[]; digest: string };
      try {
        result = await tool.execute(call.args);
      } catch (err) {
        // A tool that throws is a defect in OUR code, not the model's. It must
        // not kill the investigation, and it must not contribute evidence.
        messages.push({
          role: 'tool_result', callId: call.id, toolName: call.name,
          content: JSON.stringify({
            error: `tool ${call.name} failed`,
            detail: err instanceof Error ? err.message : String(err),
          }),
        });
        continue;
      }

      // Stamped with THIS investigation's id. The gate verifies it (#21).
      toolCalls.push({
        investigationId: request.investigationId,
        step: steps,
        tool: call.name,
        arguments: call.args,
        returnedIds: result.returnedIds,
        resultDigest: result.digest,
        durationMs: now() - t0,
      });
      // `resultDigest` is handed to the model EXPLICITLY because A3 requires it
      // echoed back and compares it against this exact string (`digestFor` in
      // grounding-gate.ts). It is a checksum on the reasoning chain: a model
      // that narrates a step it never took cannot produce the digest for it.
      messages.push({
        role: 'tool_result', callId: call.id, toolName: call.name,
        content: JSON.stringify({ resultDigest: result.digest, result: result.result }),
      });
    }
  }

  const budgetExhausted =
    stopCause === 'steps' || stopCause === 'tool_calls'
    || stopCause === 'wall_clock' || stopCause === 'tokens';

  // ── A3 ──
  // Even a budget-stopped investigation goes through the gate: it produced no
  // verdict, so the gate downgrades it, and the SAME code path stamps every
  // outcome. A bypass here would be the one place an unvalidated verdict could
  // reach the database.
  const gate = validateVerdict(
    raw ?? { __missing: stopReason },
    { ...deps.gateContext, investigationId: request.investigationId, toolCalls });

  return {
    verdict: { ...gate.verdict, budgetExhausted },
    toolCalls,
    steps,
    usage,
    stopCause,
    stopReason,
    groundingRejection: gate.rejection,
  };
}

/** The reasoning chain as persisted (§6): what was CALLED, not what was claimed. */
export function reasoningChain(
  toolCalls: readonly ToolCallRecord[], verdict: RawVerdict,
): ReasoningStep[] {
  const inferenceFor = new Map<number, string>();
  for (const r of verdict.reasoning) {
    if (typeof r?.step === 'number' && typeof r?.inference === 'string') {
      inferenceFor.set(r.step, r.inference);
    }
  }
  // Built from the TOOL CALLS, not from the model's `reasoning` array: the
  // chain is the transcript of what the agent did, and `resultDigest` is what
  // the tool actually returned — never the model's paraphrase of it (§6).
  return toolCalls.map((c) => ({
    step: c.step,
    tool: c.tool,
    arguments: c.arguments,
    resultDigest: c.resultDigest,
    inference: inferenceFor.get(c.step) ?? '',
  }));
}
