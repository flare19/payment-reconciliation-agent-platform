/**
 * Phase A — the Analyst (ADR-048…ADR-057).
 *
 * HARD BOUNDARY: nothing in this file may be imported by anything under
 * `services/matching`, `services/classification` or `services/metrics`.
 * The engine must run identically with AGENT_ENABLED=false (ADR-048).
 */

import type { ExceptionCategory, MemberRole } from './domain.js';

export type Verdict =
  | 'RESOLUTION_PROPOSED'
  | 'CONFIRMED_UNRESOLVABLE'
  | 'NEEDS_EXTERNAL_DATA'
  | 'INSUFFICIENT_EVIDENCE';

/**
 * A LABEL, never a number (ADR-053 / agent-design §6).
 * The engine's confidence is COMPUTED; the agent's is ASSERTED. Giving them the
 * same type invites averaging and sorting across two quantities that are not the
 * same kind of thing.
 */
export type AgentConfidence = 'high' | 'medium' | 'low';

export type ProposedAction =
  | { type: 'MANUAL_MATCH'; members: { transactionId: string; role: MemberRole }[]; rationale: string }
  | { type: 'CREATE_ALIAS'; aliasType: string; rawValue: string; canonicalValue: string; rationale: string }
  | { type: 'MARK_WONT_FIX'; rationale: string }
  | { type: 'ADJUST_SEARCH_BOUNDS'; poolSize: number; maxSubsetSize: number; budgetMs: number; rationale: string };

export interface ReasoningStep {
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  /** What the tool ACTUALLY returned, recorded by the runtime — never the model's paraphrase. */
  resultDigest: string;
  /** The model's inference. Kept in a separate field so a reader can check one against the other. */
  inference: string;
}

/** Raw model output, BEFORE the A3 grounding gate. Untrusted. */
export interface RawVerdict {
  verdict: Verdict;
  confidence: AgentConfidence;
  proposedAction: ProposedAction | null;
  reasoning: ReasoningStep[];
  citations: string[];
  summary: string;
}

/** Post-A3. `citations` here are gate-verified to have appeared in a real tool result. */
export interface ValidatedVerdict extends RawVerdict {
  groundingPassed: boolean;
  groundingFailure: string | null;
  budgetExhausted: boolean;
}

/** Every tool call made during one investigation. The A3 gate's evidence base. */
export interface ToolCallRecord {
  /**
   * WHICH investigation retrieved this. The A3 gate's scope key (issue #21).
   *
   * Grounding is per-investigation and that is load-bearing — an id returned to a
   * different investigation is not evidence here. Without this field the gate had
   * no way to check the claim it was making: it trusted whatever array the caller
   * handed it, and the natural loop implementation (accumulate tool calls at the
   * run level, pass them down) would have widened grounding to every investigation
   * at once while every test still passed.
   *
   * The Q&A loop supplies its `agent_questions.id` here. The scoping requirement is
   * identical — the evidence base must be exactly what THIS agent run retrieved.
   */
  investigationId: string;
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  /** Every entity id this call actually returned. The grounding allow-list. */
  returnedIds: string[];
  resultDigest: string;
  durationMs: number;
}

export interface InvestigationBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxWallMs: number;
  maxTokens: number;
}

export interface AgentTool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * READ-ONLY. `services/agent/tool-registry.ts` asserts at construction that no
   * handler can reach an INSERT/UPDATE/DELETE (ADR-049). Adding a write tool is
   * not a feature request — it means the design has gone wrong.
   */
  readonly readOnly: true;
  execute(args: TArgs): Promise<{ result: TResult; returnedIds: string[]; digest: string }>;
}

export interface InvestigationInput {
  investigationId: string;
  runId: string;
  exceptionId: string;
  category: ExceptionCategory;
}
