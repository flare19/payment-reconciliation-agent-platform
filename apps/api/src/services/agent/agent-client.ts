/**
 * The Analyst's model client — PROVIDER-NEUTRAL BY CONSTRUCTION (U13).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS INTERFACE EXISTS AT ALL
 *
 * The investigation loop must be testable without a network, without a key, and
 * without spending money — the same property U11's `ExplainLlmClient` gave the
 * explain layer, and the reason that layer could be built and pinned by tests
 * before a key existed. A2 is the more expensive surface by two orders of
 * magnitude, so it matters more here.
 *
 * It is also the seam the provider swap runs through. ADR-080 chose Gemini
 * because no Anthropic key existed; its own "Revisit if" anticipates the switch
 * back. With the loop written against this interface, that switch is a
 * constructor change and a new implementation file — not a rewrite of the loop,
 * the bounds, the audit trail or the grounding plumbing.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── IT NEVER THROWS, FOR THE SAME REASON THE EXPLAIN CLIENT DOESN'T ──
 * Every outcome is a value. A transport failure mid-investigation must become
 * `INSUFFICIENT_EVIDENCE` with a stated cause — an honest verdict — not an
 * exception that kills the phase. ADR-048: nothing in Phase A is a dependency
 * of anything in the engine, and that has to include its failures.
 *
 * ── `usage` COMES BACK ON EVERY ARM, INCLUDING FAILURES ──
 * A request that failed still cost tokens if it reached the model. The spend
 * ledger must see it, or the measured cost of a run understates what was
 * actually billed — and an understated cost guard is worse than none, because
 * it reads as protection.
 */

import type { AgentConfidence } from '../../types/agent.js';

/** A tool the model may call, as the provider needs it declared. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One entry in the conversation. Provider-neutral; the client maps it. */
export type AgentMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: AgentToolCall[] }
  | { role: 'tool_result'; callId: string; toolName: string; content: string };

export interface AgentToolCall {
  /** Provider-assigned id, echoed on the matching result. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentUsage {
  tokensIn: number;
  tokensOut: number;
}

export const ZERO_USAGE: AgentUsage = { tokensIn: 0, tokensOut: 0 };

export type AgentTurnResult =
  | {
    ok: true;
    /** The model wants tools run. The loop executes them and continues. */
    kind: 'tool_call';
    text: string;
    calls: AgentToolCall[];
    usage: AgentUsage;
  }
  | {
    ok: true;
    /** The model is done. `text` should be the verdict JSON; A3 validates it. */
    kind: 'final';
    text: string;
    usage: AgentUsage;
  }
  | {
    ok: false;
    reason: 'transport' | 'refused' | 'budget';
    detail: string;
    /** Non-zero when the request reached the model before failing. */
    usage: AgentUsage;
  };

export interface AgentTurnRequest {
  system: string;
  messages: readonly AgentMessage[];
  tools: readonly ToolDeclaration[];
  maxOutputTokens: number;
}

export interface AgentLlmClient {
  /** Hashed into nothing, but recorded on every investigation row. */
  readonly model: string;
  turn(request: AgentTurnRequest): Promise<AgentTurnResult>;
}

/**
 * What one model call is allowed to cost, checked BEFORE it is made.
 *
 * `estimateInputTokens` exists so a spend guard can refuse a call it cannot
 * afford rather than discover the cost afterwards. Output is bounded by
 * `maxOutputTokens`, which the provider enforces, so worst-case cost of a turn
 * is computable exactly in advance — that is the whole basis of the pre-flight
 * refusal, and the reason a count-based cap is not good enough when the money
 * is real.
 */
export interface CostModel {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export function usdFor(usage: AgentUsage, cost: CostModel): number {
  return (usage.tokensIn * cost.inputUsdPerMillion
    + usage.tokensOut * cost.outputUsdPerMillion) / 1_000_000;
}

/** Worst case for a turn that has not happened yet: counted in, capped out. */
export function worstCaseUsd(
  estimatedInputTokens: number, maxOutputTokens: number, cost: CostModel,
): number {
  return usdFor(
    { tokensIn: estimatedInputTokens, tokensOut: maxOutputTokens }, cost);
}

/** Confidence is a LABEL (§6). Parsing it here keeps the loop from inventing one. */
export function parseConfidence(value: unknown): AgentConfidence | null {
  return value === 'high' || value === 'medium' || value === 'low' ? value : null;
}
