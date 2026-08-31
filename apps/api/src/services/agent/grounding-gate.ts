/**
 * A3 — the grounding gate (ADR-050).
 *
 * ===========================================================================
 * THE AGENT'S OUTPUT IS UNTRUSTED UNTIL IT PASSES THIS FILE.
 *
 * This is the mechanism that turns "we hope it doesn't hallucinate" into
 * "hallucination is structurally detected". It is deliberately NOT an LLM: adding
 * a second non-deterministic component to check the first one gives you two
 * things to be uncertain about instead of one.
 *
 * A GATE THAT FAILS OPEN IS WORSE THAN NO GATE, because it produces
 * confident-looking output that nobody re-checks. Every check below therefore
 * defaults to rejection: a verdict is accepted only when it positively passes,
 * never merely because no check happened to object.
 *
 * NO RETRY. A failure downgrades the verdict to INSUFFICIENT_EVIDENCE and stops.
 * A second attempt at a hallucinated answer is still an attempt at a hallucinated
 * answer, and a retry loop would quietly select for whichever output happened to
 * pass — which is the opposite of what this gate is for.
 * ===========================================================================
 */

import type {
  AgentConfidence, ProposedAction, RawVerdict, ReasoningStep, ToolCallRecord,
  ValidatedVerdict, Verdict,
} from '../../types/agent.js';
import type { AliasType, Direction, SourceSystem } from '../../types/domain.js';
import { AGENT_DEFAULTS } from '../../config/defaults.js';

const VERDICTS: readonly Verdict[] = [
  'RESOLUTION_PROPOSED', 'CONFIRMED_UNRESOLVABLE', 'NEEDS_EXTERNAL_DATA', 'INSUFFICIENT_EVIDENCE',
];
const CONFIDENCES: readonly AgentConfidence[] = ['high', 'medium', 'low'];
const ACTION_TYPES = ['MANUAL_MATCH', 'CREATE_ALIAS', 'MARK_WONT_FIX', 'ADJUST_SEARCH_BOUNDS'] as const;
const SOURCE_SYSTEMS: readonly SourceSystem[] = ['gateway', 'bank', 'ledger'];
/** Mirrors `learned_aliases.alias_type`'s CHECK constraint (migration 005). */
const ALIAS_TYPES: readonly AliasType[] =
  ['merchant_name', 'counterparty_name', 'reference_id', 'description_token'];

/** Everything the gate needs about the world, so the gate itself stays pure. */
export interface GateContext {
  /**
   * The investigation being validated. Every `toolCalls` entry must carry this id
   * — checked, not assumed (issue #21).
   */
  investigationId: string;
  /** Every tool call THIS investigation made. The grounding allow-list. */
  toolCalls: readonly ToolCallRecord[];
  /** Records in this run, by id, with the facts the constraint checks need. */
  records: ReadonlyMap<string, {
    runId: string;
    sourceSystem: SourceSystem;
    direction: Direction;
    /** True when the record already belongs to a non-rejected match. */
    alreadyMatched: boolean;
  }>;
  runId: string;
  /** Active alias lookups, keyed `aliasType::normalizedValue`. */
  activeAliases: ReadonlyMap<string, string>;
}

export interface GateResult {
  verdict: ValidatedVerdict;
  /** Null when the verdict passed unchanged. */
  rejection: { check: 'schema' | 'grounding' | 'constraint'; reason: string } | null;
}

/**
 * Run the gate. Returns either the verdict with `groundingPassed: true`, or a
 * downgraded `INSUFFICIENT_EVIDENCE` carrying why.
 */
export function validateVerdict(raw: unknown, context: GateContext): GateResult {
  assertContextIsScoped(context);

  const schema = checkSchema(raw);
  if (schema !== null) return reject(raw, 'schema', schema);

  const verdict = raw as RawVerdict;

  const grounding = checkGrounding(verdict, context);
  if (grounding !== null) return reject(verdict, 'grounding', grounding);

  const constraint = checkConstraints(verdict, context);
  if (constraint !== null) return reject(verdict, 'constraint', constraint);

  return {
    verdict: {
      ...verdict,
      // Citations are populated ONLY here, after every one has been verified to
      // have come out of a real tool call. An unverified citation never reaches
      // the database.
      citations: [...new Set(verdict.citations)].sort(),
      groundingPassed: true,
      groundingFailure: null,
      budgetExhausted: false,
    },
    rejection: null,
  };
}

// ─── 0. Precondition: the evidence base is this investigation's ──────────────

/**
 * THROWS rather than rejecting, and the distinction is the point (issue #21).
 *
 * `raw` is untrusted model output, so a defect in it is a verdict to reject.
 * `context` is trusted SYSTEM input assembled by the investigation loop, so a
 * defect in it is a programming error — and downgrading it to
 * INSUFFICIENT_EVIDENCE would blame the model for the caller's bug and inflate the
 * grounding-failure count that `agent-design.md` §7 reads as a signal that the
 * prompt or the tools need work. A metric that counts our own bugs as the model's
 * hallucinations is worse than no metric.
 *
 * Why the check exists at all: grounding is per-investigation, and before this the
 * gate had no way to verify the array it was handed. The obvious loop
 * implementation — accumulate `ToolCallRecord`s on the run-level phase and pass
 * them down — silently widens the allow-list to every investigation in the run.
 * One investigation's results then ground another's conclusions, which is exactly
 * the laundering the per-investigation rule exists to prevent. Nothing would have
 * failed; the grounding-failure count would have gone DOWN.
 */
function assertContextIsScoped(context: GateContext): void {
  for (const [i, call] of context.toolCalls.entries()) {
    if (call.investigationId !== context.investigationId) {
      throw new Error(
        `grounding gate: toolCalls[${i}] belongs to investigation ${call.investigationId}, ` +
        `not ${context.investigationId}. Grounding is per-investigation — an id retrieved by a ` +
        `different investigation is not evidence here. Pass only this investigation's tool calls.`,
      );
    }
  }
}

// ─── 1. Schema ───────────────────────────────────────────────────────────────

function checkSchema(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return 'verdict is not an object';
  const v = raw as Record<string, unknown>;

  if (typeof v['verdict'] !== 'string' || !VERDICTS.includes(v['verdict'] as Verdict)) {
    return `verdict must be one of ${VERDICTS.join(', ')}, got ${JSON.stringify(v['verdict'])}`;
  }
  // A LABEL, never a number (ADR-053). The engine's confidence is computed and the
  // agent's is asserted; identical types would invite averaging one into the other.
  if (typeof v['confidence'] !== 'string' || !CONFIDENCES.includes(v['confidence'] as AgentConfidence)) {
    return `confidence must be a label (${CONFIDENCES.join('/')}), got ${JSON.stringify(v['confidence'])}`;
  }
  if (typeof v['summary'] !== 'string' || v['summary'].trim() === '') {
    return 'summary is required and must be non-empty';
  }
  if (!Array.isArray(v['citations']) || v['citations'].some((c) => typeof c !== 'string')) {
    return 'citations must be an array of strings';
  }
  if (!Array.isArray(v['reasoning'])) return 'reasoning must be an array';
  for (const [i, step] of (v['reasoning'] as unknown[]).entries()) {
    const s = step as Record<string, unknown>;
    if (s === null || typeof s !== 'object') return `reasoning[${i}] is not an object`;
    if (typeof s['tool'] !== 'string' || s['tool'] === '') return `reasoning[${i}].tool is required`;
    if (typeof s['resultDigest'] !== 'string') return `reasoning[${i}].resultDigest is required`;
    if (typeof s['inference'] !== 'string') return `reasoning[${i}].inference is required`;
  }

  const action = v['proposedAction'];
  const isProposal = v['verdict'] === 'RESOLUTION_PROPOSED';
  if (isProposal && (action === null || action === undefined)) {
    return 'RESOLUTION_PROPOSED must carry a proposedAction';
  }
  if (!isProposal && action !== null && action !== undefined) {
    return `${String(v['verdict'])} must not carry a proposedAction`;
  }
  if (isProposal) return checkActionSchema(action);
  return null;
}

/** A non-empty string. `undefined`, `null`, `''`, `'   '` and every non-string are not one. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * EVERY action variant's payload is validated here, not just `MANUAL_MATCH`
 * (issue #19).
 *
 * The old version descended into `MANUAL_MATCH` alone and left the other three
 * unchecked, which mattered more than it looks: `checkConstraints` then compared
 * fields that might not exist, and `undefined <= 0` is `false`. So the one bounds
 * check that did exist SILENTLY AFFIRMED for every value that was not a positive
 * number — a check written to reject that accepted instead, which is the precise
 * shape of failing open. A `CREATE_ALIAS` missing `canonicalValue` slipped past
 * the self-map test the same way, since `'AMZN' === undefined` is false.
 *
 * The union is exhausted deliberately: adding a fifth action type without a
 * branch here is a TypeScript error rather than a silently unvalidated proposal.
 */
function checkActionSchema(action: unknown): string | null {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return 'proposedAction must be an object';
  }
  const a = action as Record<string, unknown>;
  if (typeof a['type'] !== 'string' || !ACTION_TYPES.includes(a['type'] as never)) {
    return `proposedAction.type must be one of ${ACTION_TYPES.join(', ')}`;
  }
  // Required on every variant: a human reads this before acting on the proposal.
  if (!isText(a['rationale'])) return 'proposedAction.rationale is required';

  const type = a['type'] as ProposedAction['type'];
  switch (type) {
    case 'MANUAL_MATCH': {
      if (!Array.isArray(a['members']) || a['members'].length < 2) {
        return 'MANUAL_MATCH requires at least two members';
      }
      for (const [i, m] of (a['members'] as unknown[]).entries()) {
        if (m === null || typeof m !== 'object') return `members[${i}] is not an object`;
        const member = m as Record<string, unknown>;
        if (!isText(member['transactionId'])) return `members[${i}].transactionId required`;
        // Checked against the source systems, not merely `typeof 'string'`. The
        // constraint pass compares role to the record's own source, so a junk role
        // was caught there by accident; naming the real reason here is better than
        // depending on a coincidence two checks away.
        if (!SOURCE_SYSTEMS.includes(member['role'] as SourceSystem)) {
          return `members[${i}].role must be one of ${SOURCE_SYSTEMS.join(', ')}`;
        }
      }
      return null;
    }

    case 'CREATE_ALIAS': {
      if (!ALIAS_TYPES.includes(a['aliasType'] as AliasType)) {
        return `CREATE_ALIAS.aliasType must be one of ${ALIAS_TYPES.join(', ')}`;
      }
      if (!isText(a['rawValue'])) return 'CREATE_ALIAS.rawValue is required';
      if (!isText(a['canonicalValue'])) return 'CREATE_ALIAS.canonicalValue is required';
      return null;
    }

    case 'MARK_WONT_FIX':
      // The rationale IS the proposal here; nothing further to carry.
      return null;

    case 'ADJUST_SEARCH_BOUNDS': {
      for (const field of ['poolSize', 'maxSubsetSize', 'nodeBudget'] as const) {
        const value = a[field];
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          return `ADJUST_SEARCH_BOUNDS.${field} must be a positive integer`;
        }
        // ADR-054's ceilings, enforced on the PROPOSAL. The gate is the only
        // deterministic check on what a human is shown, so a request for a pool of
        // a billion must not reach them looking actionable.
        const ceiling = AGENT_DEFAULTS.rerunSubsetCeilings[field];
        if (value > ceiling) {
          return `ADJUST_SEARCH_BOUNDS.${field} is ${value}, above the ADR-054/085 ceiling of ${ceiling}`;
        }
      }
      return null;
    }

    default: {
      // Exhaustiveness: a new action type must be handled above, not fall through.
      const unreachable: never = type;
      return `unhandled proposedAction.type ${String(unreachable)}`;
    }
  }
}

// ─── 2. Citation grounding ───────────────────────────────────────────────────

/**
 * Every id the verdict leans on must have come out of a real tool call THIS
 * investigation made. An id the agent never retrieved is an id it invented.
 *
 * Grounding is deliberately PER INVESTIGATION. An id returned to a different
 * investigation is not evidence here: the agent did not see it while forming this
 * conclusion, and accepting it would let one investigation launder another's
 * results into a reasoning chain that never actually examined them.
 */
function checkGrounding(verdict: RawVerdict, context: GateContext): string | null {
  const retrieved = new Set<string>();
  for (const call of context.toolCalls) {
    for (const id of call.returnedIds) retrieved.add(id);
  }

  for (const id of verdict.citations) {
    if (!retrieved.has(id)) {
      return `citation ${id} appears in no tool result from this investigation`;
    }
  }

  // Ids named inside the proposal itself are load-bearing claims, not decoration:
  // a proposal is the thing a human will act on.
  for (const id of idsInAction(verdict.proposedAction)) {
    if (!retrieved.has(id)) {
      return `proposed action references ${id}, which appears in no tool result from this investigation`;
    }
  }

  // A conclusion drawn from nothing is not a conclusion. Verdicts that assert
  // something about the data must show they looked at some.
  const assertsSomething = verdict.verdict === 'RESOLUTION_PROPOSED'
    || verdict.verdict === 'CONFIRMED_UNRESOLVABLE';
  if (assertsSomething && verdict.reasoning.length === 0) {
    return `${verdict.verdict} requires a reasoning chain; none was recorded`;
  }

  // Each step must name a tool that was actually called. A step describing a call
  // that never happened is a fabricated narrative, even when its conclusion is right.
  const calledTools = new Set(context.toolCalls.map((c) => c.tool));
  for (const [i, step] of verdict.reasoning.entries()) {
    if (!calledTools.has(step.tool)) {
      return `reasoning step ${i + 1} cites tool "${step.tool}", which was never called`;
    }
    const digestMismatch = digestFor(context.toolCalls, step);
    if (digestMismatch !== null) return digestMismatch;
  }
  return null;
}

/**
 * `resultDigest` must be what the RUNTIME recorded, not the model's paraphrase of
 * it. Keeping them in separate fields is what lets a reader check the reasoning
 * against the evidence; letting the model write both would make the chain
 * self-consistent and unverifiable at the same time.
 */
function digestFor(calls: readonly ToolCallRecord[], step: ReasoningStep): string | null {
  const call = calls.find((c) => c.step === step.step && c.tool === step.tool);
  if (call === undefined) {
    return `reasoning step ${step.step} has no matching tool call`;
  }
  if (call.resultDigest !== step.resultDigest) {
    return `reasoning step ${step.step} reports a result the runtime did not record`;
  }
  return null;
}

function idsInAction(action: ProposedAction | null): string[] {
  if (action === null) return [];
  return action.type === 'MANUAL_MATCH' ? action.members.map((m) => m.transactionId) : [];
}

// ─── 3. Constraints ──────────────────────────────────────────────────────────

/**
 * A proposal must be actionable. These mirror the invariants the database would
 * enforce anyway — but failing here produces a readable reason attached to the
 * investigation, whereas failing at INSERT produces a constraint violation in a
 * log that nobody reads.
 */
function checkConstraints(verdict: RawVerdict, context: GateContext): string | null {
  const action = verdict.proposedAction;
  if (action === null) return null;

  if (action.type === 'MANUAL_MATCH') {
    const seenRoles = new Set<SourceSystem>();
    let direction: Direction | null = null;

    for (const member of action.members) {
      const record = context.records.get(member.transactionId);
      if (record === undefined) {
        return `proposed member ${member.transactionId} is not a record in this run`;
      }
      if (record.runId !== context.runId) {
        return `proposed member ${member.transactionId} belongs to a different run`;
      }
      if (record.alreadyMatched) {
        return `proposed member ${member.transactionId} already belongs to a match; ` +
          `the existing match must be rejected first`;
      }
      if (record.sourceSystem !== member.role) {
        return `proposed member ${member.transactionId} is a ${record.sourceSystem} record ` +
          `but was given the role ${member.role}`;
      }
      if (seenRoles.has(record.sourceSystem)) {
        return `two proposed members share the ${record.sourceSystem} role; ` +
          `a match holds at most one record per source`;
      }
      seenRoles.add(record.sourceSystem);

      // The direction gate (ADR-035) applies to a human-confirmable proposal for
      // exactly the reason it applies to the engine: a credit is not a debit.
      if (direction === null) direction = record.direction;
      else if (direction !== record.direction) {
        return `proposed members disagree on direction (${direction} vs ${record.direction}); ` +
          `a credit never matches a debit`;
      }
    }
    return null;
  }

  if (action.type === 'CREATE_ALIAS') {
    const key = `${action.aliasType}::${action.rawValue}`;
    const existing = context.activeAliases.get(key);
    if (existing !== undefined && existing !== action.canonicalValue) {
      // Not silently superseded here: ADR-013's supersede-with-penalty flow is a
      // human decision made through endpoint 16, not something an agent may
      // trigger by proposing.
      return `an active alias already maps ${action.rawValue} to ${existing}; ` +
        `a contradicting alias must be confirmed by a human, not proposed silently`;
    }
    if (action.rawValue === action.canonicalValue) {
      return 'an alias cannot map a value to itself';
    }
  }

  // ADJUST_SEARCH_BOUNDS has no constraint check: its bounds are a matter of TYPE
  // and CEILING, both of which the schema pass now owns outright (issue #19). The
  // check that used to live here — `action.poolSize <= 0` — is exactly what failed
  // open, because `undefined <= 0` and `'lots' <= 0` are both false. Leaving a
  // weaker copy of a check that already ran is how the first one got trusted.
  return null;
}

// ─── rejection ───────────────────────────────────────────────────────────────

function reject(raw: unknown, check: GateResult['rejection'] extends null ? never
  : 'schema' | 'grounding' | 'constraint', reason: string): GateResult {
  const source = (raw ?? {}) as Partial<RawVerdict>;
  return {
    verdict: {
      // Downgraded, never dropped: the investigation happened and its failure is
      // itself a result. Grounding failures are counted and reported (agent-design
      // §7); a rising count means the prompt or the tools need work, and
      // suppressing them would hide exactly that signal.
      verdict: 'INSUFFICIENT_EVIDENCE',
      confidence: 'low',
      proposedAction: null,
      reasoning: Array.isArray(source.reasoning) ? source.reasoning : [],
      citations: [],
      summary: typeof source.summary === 'string' ? source.summary : '',
      groundingPassed: false,
      groundingFailure: `${check}: ${reason}`,
      budgetExhausted: false,
    },
    rejection: { check, reason },
  };
}
