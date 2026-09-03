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
// ALIAS_TYPES is interpolated into the prompt rather than retyped, for the same
// reason the ceilings are: the model must be told exactly what the gate accepts.
import { ALIAS_TYPES, validateVerdict, type GateContext } from './grounding-gate.js';
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
  /**
   * Called as each tool call completes, BEFORE the loop continues.
   *
   * §3: "Every step is written to `audit_log` as it happens, so a partial
   * investigation that hits a budget still leaves a complete, ordered,
   * tamper-evident record of what it did." Writing the trail only at the end
   * would lose exactly the investigations most worth inspecting — the ones that
   * crashed or ran out of budget.
   *
   * A throw here is swallowed: the audit trail must not be able to kill the
   * investigation it is describing.
   */
  onToolCall?: (record: ToolCallRecord) => Promise<void>;
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
  'CITATIONS ARE RECORD IDs -- the UUID-shaped values a tool returned, like',
  '"9f1c4d7e-0000-4000-8000-00000000000a": a transactionId, exceptionId or matchId. Cite only',
  'ones a tool actually returned to you in THIS investigation; an id you did not retrieve is an',
  'id you invented, and a deterministic gate will catch it and void your verdict.',
  'A resultDigest is NOT a record id and must NEVER appear in "citations". It belongs only in',
  'reasoning[].resultDigest. Putting a checksum in citations voids the verdict.',
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
  'ALWAYS RETRIEVE BEFORE YOU CONCLUDE. Start with get_exception. A verdict reached without',
  'calling any tool is not an investigation, and every reasoning step you write is checked',
  'against the tools you ACTUALLY called: naming a tool you did not call voids the verdict',
  'outright. Do not describe a search you did not run.',
  '',
  'YOU HAVE A TURN BUDGET AND YOU CAN SEE IT. Each turn tells you how many turns remain.',
  'Use them. Being cut off mid-thought wastes the work, but so does answering before you',
  'have looked -- and only one of those two is dishonest. When one turn remains, stop',
  'calling tools and write the verdict from what you actually retrieved.',
  'CONFIRMED_UNRESOLVABLE with a stated reason is a real and valuable answer.',
  '',
  'Every tool result carries a short "resultDigest" like `get_exception:sha256:a3f9c1d20b44`.',
  'Copy',
  'it back EXACTLY in the matching reasoning step. It is a checksum, not a summary: a',
  'deterministic gate compares what you echo against what the tool actually returned, so a',
  'digest you alter or invent voids the verdict. It is deliberately short — copy all of it.',
  '',
  // ── THE PROPOSAL SCHEMA (issue #53) ──
  // Absent until AUDIT-3. The gate validated all four variants and the prompt
  // named none of them, so RESOLUTION_PROPOSED could not be produced: 20 live
  // investigations yielded 0 proposals, and the single attempt was rejected
  // with `proposedAction must be an object`. Three of agent-design.md §7's six
  // metrics read 0 for that reason alone. The ceilings below are interpolated
  // from AGENT_DEFAULTS so the prompt cannot drift from what the gate enforces.
  'RESOLUTION_PROPOSED is the ONLY verdict that carries a "proposedAction". The other three',
  'must set it to null. There are four shapes, and every one of them requires a "rationale"',
  'string -- a human reads that sentence before acting on your proposal:',
  '',
  '  {"type":"MANUAL_MATCH","rationale":"...",',
  '   "members":[{"transactionId":"<an id a tool returned>","role":"gateway|bank|ledger"},',
  '              {"transactionId":"...","role":"..."}]}',
  '      Two or more members, at most one per role, all the same direction, none of them',
  '      already in a match. Every transactionId must be one a tool returned to you.',
  '',
  '  {"type":"CREATE_ALIAS","rationale":"...",',
  `   "aliasType":"${ALIAS_TYPES.join('|')}",`,
  '   "rawValue":"<the value as it appears>","canonicalValue":"<what it should resolve to>"}',
  '      The two values must differ. Call check_alias first: an alias that contradicts an',
  '      active one is refused, and check_alias tells you how many records it would resolve.',
  '',
  '  {"type":"MARK_WONT_FIX","rationale":"why this exception should be closed unresolved"}',
  '',
  '  {"type":"ADJUST_SEARCH_BOUNDS","rationale":"...",',
  '   "poolSize":N,"maxSubsetSize":N,"nodeBudget":N}',
  `      Positive integers, at most ${AGENT_DEFAULTS.rerunSubsetCeilings.poolSize} / `
    + `${AGENT_DEFAULTS.rerunSubsetCeilings.maxSubsetSize} / `
    + `${AGENT_DEFAULTS.rerunSubsetCeilings.nodeBudget}.`,
  '',
  'A proposal you cannot ground is worse than no proposal. CONFIRMED_UNRESOLVABLE with a',
  'stated reason beats a MANUAL_MATCH on records you did not retrieve.',
  '',
  'When you are done, reply with ONLY this JSON and no other text:',
  '{"verdict":"...","confidence":"...","summary":"...","citations":["..."],',
  ' "reasoning":[{"step":1,"tool":"...","resultDigest":"<copied verbatim>",',
  '               "inference":"what you concluded from it"}],',
  ' "proposedAction":null}',
  '',
  'That last field is null for CONFIRMED_UNRESOLVABLE, NEEDS_EXTERNAL_DATA and',
  'INSUFFICIENT_EVIDENCE. For RESOLUTION_PROPOSED, replace it with one of the four objects',
  'above, filled in.',
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
/**
 * The turn loop itself, WITHOUT a gate.
 *
 * Extracted so investigations and review-queue corroborations share one
 * implementation of §8's bounds, the tool dispatch and the grounding plumbing,
 * and differ only in which A3 vocabulary validates the result. Two copies of the
 * bounds would be two places for a ceiling to drift, and the drift would be
 * invisible because each copy would keep passing its own tests.
 */
export interface RawLoopOutcome {
  raw: unknown;
  toolCalls: ToolCallRecord[];
  steps: number;
  usage: AgentUsage;
  stopCause: StopCause;
  stopReason: string;
  budgetExhausted: boolean;
}

export async function runAgentLoop(
  request: InvestigationRequest,
  deps: LoopDeps,
  budget: InvestigationBudget,
  system: string,
): Promise<RawLoopOutcome> {
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

  // ── THE THIRD OPTION: CONCLUDE, RATHER THAN BE CUT OFF (see #64) ──
  // Set when a bound will bind on the NEXT turn. That turn still happens, with
  // no tools and an instruction to write the verdict now, and then the loop
  // stops. Measured on the holdout: the 10-step ceiling fired ZERO times and
  // the 40,000-token ceiling fired FIFTEEN, at steps 6-9 -- so fifteen
  // investigations were killed mid-reasoning, discarding 6-9 steps of real
  // retrieval each, and the `remaining === 0` branch that says "write your
  // verdict now" was unreachable. The file's own words: "being cut off loses
  // work, answering early invents it." This is the option it did not take.
  let concludeNow = false;
  let concludeBecause = '';

  for (;;) {
    // ── BOUNDS, CHECKED BEFORE THE CALL THAT WOULD BREACH THEM ──
    // Hard stops: already breached, nothing to recover.
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

    // Soft stops: reserve room for ONE more turn and spend it concluding.
    // `spent / steps` is the measured average for THIS investigation rather than
    // a constant, because token cost per turn varies by an order of magnitude
    // with the tool payloads it happened to fetch -- `rerun_subset_search`
    // returns far more than `get_exception`, and the holdout showed 41,632 vs
    // 51,396 tokens at the same step count.
    const spent = usage.tokensIn + usage.tokensOut;
    const reserve = steps === 0 ? 0 : Math.ceil(spent / steps);
    const tokensBinding = steps > 0 && spent + reserve >= budget.maxTokens;
    const stepsBinding = steps + 1 >= budget.maxSteps;

    if (!concludeNow && (tokensBinding || stepsBinding)) {
      // NAMED, so the reason a verdict was rushed is in the audit trail rather
      // than inferred. `agent-design.md` §8: the system says WHICH bound stopped it.
      concludeBecause = tokensBinding
        ? `the ${budget.maxTokens}-token ceiling (${spent} spent, ~${reserve}/turn)`
        : `the ${budget.maxSteps}-step ceiling`;
      concludeNow = true;
    }
    if (concludeNow && (spent >= budget.maxTokens || steps >= budget.maxSteps)) {
      // The conclude turn itself has now been taken and still produced nothing.
      stopCause = tokensBinding ? 'tokens' : 'steps';
      stopReason = `stopped at ${concludeBecause} after being asked to conclude`;
      break;
    }

    // A SPEND refusal is a HARD stop, and the distinction from the bounds above
    // is the whole point. A token or step ceiling is a WORK bound: the money is
    // already spent, so one more turn to turn that work into a verdict is free
    // of regret. A spend ceiling is a MONEY bound: granting a final turn spends
    // exactly what the guard just said could not be afforded. On a prepaid key
    // with auto-reload off, the failure mode is a dead balance mid-run.
    const refusal = deps.preflight?.({ step: steps + 1, usageSoFar: { ...usage } }) ?? null;
    if (refusal !== null) {
      stopCause = 'tokens';
      stopReason = refusal;
      break;
    }

    steps += 1;
    // ── THE AGENT CAN SEE ITS OWN BUDGET ──
    // The first live investigation spent all ten steps and never concluded: the
    // model had no way to know a bound existed, so it investigated until it was
    // cut off and the verdict became INSUFFICIENT_EVIDENCE regardless of what it
    // had found. A bound the agent cannot see is a bound it cannot pace against.
    // Injected as a system-role turn rather than edited into the static prompt,
    // so the stable prefix stays stable.
    // The countdown's TONE tracks the budget, and getting this wrong cost a live
    // run in each direction. With no countdown at all the model spent all ten
    // steps and never concluded. With a countdown that urged conclusion from
    // step one, it concluded IMMEDIATELY and fabricated a reasoning step naming
    // a tool it had never called — which the A3 gate caught, but which is the
    // worse failure of the two: being cut off loses work, answering early
    // invents it.
    // ── THE COUNTDOWN NOW TRACKS THE BOUND THAT ACTUALLY BINDS (see #64) ──
    // It used to be `budget.maxSteps - steps`, so the model was told "2 steps
    // left" and then killed by a token ceiling it was never shown. `remaining`
    // is now the smaller of the two, in TURNS, so the number it sees is the
    // number of turns it really has.
    const spentNow = usage.tokensIn + usage.tokensOut;
    // `steps` was incremented above for the turn ABOUT to happen, so the number
    // of turns actually billed so far is one fewer. Dividing by `steps` here
    // halves the average on turn 2 and reports a countdown twice as generous as
    // the tokens fund — which is the same class of error as the defect itself.
    const completed = steps - 1;
    const perTurn = completed === 0 ? 0 : Math.ceil(spentNow / completed);
    const turnsOnTokens = perTurn === 0
      ? Number.POSITIVE_INFINITY
      : Math.floor((budget.maxTokens - spentNow) / perTurn);
    const remaining = Math.max(0, Math.min(budget.maxSteps - steps, turnsOnTokens));

    const pacing = concludeNow
      ? 'FINAL STEP. Do not call any more tools — none are available on this turn. Reply '
        + 'with ONLY the verdict JSON object and no other text: no preamble, no explanation '
        + 'outside the JSON, no markdown fence. Use only what you actually retrieved. A verdict from '
        + 'partial evidence, with its limits stated, is worth more than no verdict. If what '
        + 'you found does not support a proposal, say CONFIRMED_UNRESOLVABLE or '
        + 'NEEDS_EXTERNAL_DATA and state why.'
      : remaining <= 2
        ? `[${remaining} turn(s) left. Wrap up: gather anything essential, then conclude.]`
        : toolCalls.length === 0
          ? `[${remaining} turns left. Retrieve the exception first — do not conclude yet.]`
          : `[${remaining} turns left. Keep investigating until you can answer from `
            + 'evidence you retrieved.]';
    const paced: AgentMessage[] = [...messages, { role: 'user', text: pacing }];

    const turn = await deps.client.turn({
      system,
      messages: paced,
      // WITHHELD on the final turn, not merely discouraged. An instruction not
      // to call tools is a request; an empty tool list is a property. The last
      // live run's worst outcome was a model that concluded early and fabricated
      // a tool call it had never made -- it cannot do that with nothing to call.
      tools: concludeNow ? [] : declarations,
      // The conclude turn needs room for BOTH the thinking and the verdict:
      // `max_tokens` counts thinking on an adaptive model, so the allowance that
      // is comfortable for a tool call can leave a verdict half-written.
      maxOutputTokens: concludeNow ? 4096 : 2048,
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
      // ── PROSE IS NOT A VERDICT, BUT IT IS NOT A HALLUCINATION EITHER ──
      // Sonnet 5 at low effort ends turns in prose often enough that the first
      // live run lost 2 of 2 investigations to "the model finished but its
      // final message was not usable JSON" — after 4-7 REAL tool calls each,
      // with no bound having bound. Discarding that is the same waste #64
      // removed from the token ceiling, for a different reason.
      //
      // So a formatting miss earns ONE re-ask, with tools withheld and the
      // schema restated. This does NOT weaken A3's no-retry rule: that rule
      // forbids a second attempt at a HALLUCINATED answer, because a retry loop
      // selects for whichever output happened to pass the gate. Nothing here is
      // re-judged — the same evidence is re-serialised, and the gate still sees
      // it exactly once.
      if (raw === null && !concludeNow) {
        concludeBecause = 'the previous reply was prose rather than the verdict JSON';
        concludeNow = true;
        messages.push({ role: 'assistant', text: turn.text, toolCalls: [] });
        continue;
      }
      stopCause = 'concluded';
      stopReason = raw === null
        ? 'the model finished but its final message was not usable JSON, twice'
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
      //
      // `step` is the CALL ordinal, not the turn counter (issue #54). A turn may
      // issue several tool calls, and stamping them all with the turn number made
      // them indistinguishable in the persisted chain and in the audit trail —
      // three rows all reading "step 2: called get_transaction". It is no longer
      // a join key anywhere (A3 joins on the digest), so it is free to mean the
      // thing a reader assumes it means: the Nth thing this investigation did.
      // Turn count is still reported separately, as `steps`.
      const record: ToolCallRecord = {
        investigationId: request.investigationId,
        step: toolCalls.length + 1,
        tool: call.name,
        arguments: call.args,
        returnedIds: result.returnedIds,
        resultDigest: result.digest,
        durationMs: now() - t0,
      };
      toolCalls.push(record);
      if (deps.onToolCall !== undefined) {
        // Swallowed deliberately: a failure to WRITE the trail must not change
        // what the investigation concludes. The trail describes the work; it is
        // not part of it.
        try { await deps.onToolCall(record); } catch { /* trail write failed */ }
      }
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

  return {
    raw: raw ?? { __missing: stopReason },
    toolCalls,
    steps,
    usage,
    stopCause,
    stopReason,
    budgetExhausted:
      stopCause === 'steps' || stopCause === 'tool_calls'
      || stopCause === 'wall_clock' || stopCause === 'tokens',
  };
}

/**
 * Run one INVESTIGATION: the loop, then A3's investigation vocabulary.
 *
 * Even a budget-stopped run goes through the gate — it produced no verdict, so
 * the gate downgrades it, and the SAME code path stamps every outcome. A bypass
 * here would be the one place an unvalidated verdict could reach the database.
 */
export async function investigate(
  request: InvestigationRequest,
  deps: LoopDeps,
  budget: InvestigationBudget = AGENT_DEFAULTS.budget,
): Promise<InvestigationOutcome> {
  const out = await runAgentLoop(request, deps, budget, SYSTEM_PROMPT);
  const gate = validateVerdict(out.raw, {
    ...deps.gateContext, investigationId: request.investigationId,
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

/**
 * The reasoning chain as persisted (§6): what was CALLED, not what was claimed.
 *
 * Inferences are attached on `(tool, resultDigest)` — THE SAME JOIN THE A3 GATE
 * USES, deliberately, so a step the gate accepted as grounded is the step whose
 * inference is shown next to it. Keying on the model's `step` number instead
 * mis-attributed prose whenever one turn made several calls: on holdout run
 * 80ddde9d, corroboration 4d7bfc85 made three `get_transaction` calls in one
 * turn and all three were persisted carrying the SAME inference, describing one
 * of them (issue #54). An inference beside the wrong evidence is worse than a
 * blank one, because a reader checking the chain has no way to tell.
 */
export function reasoningChain(
  toolCalls: readonly ToolCallRecord[], verdict: RawVerdict,
): ReasoningStep[] {
  const inferenceFor = new Map<string, string>();
  const key = (tool: string, digest: string): string => `${tool}\u0000${digest}`;
  for (const r of verdict.reasoning) {
    if (typeof r?.tool === 'string' && typeof r?.resultDigest === 'string'
      && typeof r?.inference === 'string' && r.inference !== '') {
      // First writer wins: if the model narrated two steps against identical
      // evidence, the earlier one is the one it reached first.
      const k = key(r.tool, r.resultDigest);
      if (!inferenceFor.has(k)) inferenceFor.set(k, r.inference);
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
    inference: inferenceFor.get(key(c.tool, c.resultDigest)) ?? '',
  }));
}
