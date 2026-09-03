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
  AgentConfidence, CorroborationVerdict, ProposedAction, RawAnswer, RawCorroboration, RawVerdict,
  ReasoningStep, ToolCallRecord, ValidatedAnswer, ValidatedCorroboration, ValidatedVerdict, Verdict,
} from '../../types/agent.js';
import type { AliasType, Direction, SourceSystem } from '../../types/domain.js';
import { AGENT_DEFAULTS } from '../../config/defaults.js';

const VERDICTS: readonly Verdict[] = [
  'RESOLUTION_PROPOSED', 'CONFIRMED_UNRESOLVABLE', 'NEEDS_EXTERNAL_DATA', 'INSUFFICIENT_EVIDENCE',
];
const CONFIDENCES: readonly AgentConfidence[] = ['high', 'medium', 'low'];
const CORROBORATION_VERDICTS: readonly CorroborationVerdict[] =
  ['CORROBORATED', 'CONTRADICTED', 'NO_NEW_EVIDENCE'];
/**
 * EXPORTED so the investigation prompt can be checked against it (issue #53).
 *
 * A schema the model is never shown is a schema the model cannot satisfy. The
 * gate validated all four variants meticulously while `SYSTEM_PROMPT` named
 * none of them, so `RESOLUTION_PROPOSED` — the verdict agent-design.md §7 calls
 * the agent's entire reason to exist — was unreachable, and the one live
 * attempt died on `proposedAction must be an object`. `agent-prompt.test.ts`
 * now asserts every name below appears in the prompt, so a fifth action type
 * fails a test rather than silently becoming unreachable.
 */
export const ACTION_TYPES =
  ['MANUAL_MATCH', 'CREATE_ALIAS', 'MARK_WONT_FIX', 'ADJUST_SEARCH_BOUNDS'] as const;
export const SOURCE_SYSTEMS: readonly SourceSystem[] = ['gateway', 'bank', 'ledger'];
/** Mirrors `learned_aliases.alias_type`'s CHECK constraint (migration 005). */
export const ALIAS_TYPES: readonly AliasType[] =
  ['merchant_name', 'counterparty_name', 'reference_id', 'description_token'];

/**
 * The ONE normalization every alias-value comparison in the agent layer must
 * share (#58). Before this, `check_alias` normalized with `.trim().toUpperCase()`
 * and the gate's contradiction check compared the model's raw `rawValue`
 * against a map keyed by the ALREADY-normalized `normalizedValue` — so
 * `"amazon seller services"` silently missed an active alias stored as
 * `"AMAZON SELLER SERVICES"` and the one check written to reject a
 * contradiction passed it instead.
 */
export function normalizeAliasValue(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * The field names `checkActionSchema` requires, per variant. Declared as data
 * beside the checks that enforce them so the prompt test can iterate them.
 * `rationale` is required on every variant and is therefore listed once, below.
 */
export const ACTION_REQUIRED_FIELDS: Readonly<Record<
  (typeof ACTION_TYPES)[number], readonly string[]
>> = {
  MANUAL_MATCH: ['members', 'transactionId', 'role'],
  CREATE_ALIAS: ['aliasType', 'rawValue', 'canonicalValue'],
  MARK_WONT_FIX: [],
  ADJUST_SEARCH_BOUNDS: ['poolSize', 'maxSubsetSize', 'nodeBudget'],
};

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

  // CREATE_ALIAS names two strings, not entity ids (#58) — `rawValue` and
  // `canonicalValue` cannot appear in `returnedIds` (a NEW alias has no row to
  // return), so `idsInAction` above cannot ground them. What CAN be checked is
  // that the model actually looked them up: `check_alias` exists precisely for
  // this, and a genuine lookup leaves the value in the call's own ARGUMENTS
  // even though the full tool RESULT is not persisted on `ToolCallRecord`.
  // `!= null`, not `!== null` — `checkSchema` already treats an ABSENT
  // `proposedAction` as equivalent to a null one, and `checkConstraints` below
  // learned this lesson once already (issue #21): `!== null` reads `.type` off
  // `undefined` and throws, which `validateVerdict` is documented to do only
  // for a caller bug.
  if (verdict.proposedAction != null && verdict.proposedAction.type === 'CREATE_ALIAS') {
    const aliasGrounding = checkAliasValuesGrounded(verdict.proposedAction, context.toolCalls);
    if (aliasGrounding !== null) return aliasGrounding;
  }

  // A conclusion drawn from nothing is not a conclusion. Verdicts that assert
  // something about the data must show they looked at some. NEEDS_EXTERNAL_DATA
  // joins this set (#58) — it is a claim that a specific outside record is
  // needed, and that claim is unearned from zero tool calls. Left out before,
  // it was reachable with an empty reasoning chain and no tool call at all,
  // which made it the cheapest verdict in the vocabulary — the same failure
  // mode the corroboration gate's NO_NEW_EVIDENCE reasoning already names.
  const assertsSomething = verdict.verdict === 'RESOLUTION_PROPOSED'
    || verdict.verdict === 'CONFIRMED_UNRESOLVABLE'
    || verdict.verdict === 'NEEDS_EXTERNAL_DATA';
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
    const digestMismatch = digestFor(context.toolCalls, step, i + 1);
    if (digestMismatch !== null) return digestMismatch;
  }
  return null;
}

/**
 * `resultDigest` must be what the RUNTIME recorded, not the model's paraphrase of
 * it. Keeping them in separate fields is what lets a reader check the reasoning
 * against the evidence; letting the model write both would make the chain
 * self-consistent and unverifiable at the same time.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE JOIN KEY IS (tool, resultDigest). IT USED TO INCLUDE `step`, AND THAT WAS
 * A BUG THAT REJECTED TRUTHFUL VERDICTS (issue #54).
 *
 * `step.step` is model-authored — the index in the narrative it chose to write.
 * `ToolCallRecord.step` was the runtime's counter. Nothing kept them in sync, and
 * they came apart on two ordinary events: the model omitting a call from its
 * write-up (a call that returned nothing useful is naturally left out), and a
 * single turn issuing more than one tool call (all of them stamped identically,
 * so no narrative numbering could address them individually).
 *
 * Measured on holdout run 80ddde9d: 10 of 10 corroborations and 3 of the 5
 * verdict-producing investigations were rejected this way — 13 of 15 — every one
 * of them citing a tool it really called and echoing a digest the runtime really
 * produced. agent-design.md §7 reads the grounding-failure count as a signal that
 * the prompt or the tools need work, and this file's own words apply: "A metric
 * that counts our own bugs as the model's hallucinations is worse than no metric."
 *
 * ── WHY THIS DOES NOT WEAKEN THE GATE ──
 * The checksum property is unchanged, because the DIGEST was always the thing
 * doing the work. A model narrating a step it never took still cannot produce the
 * digest for it: digests are long, tool-prefixed (`digestOf`) and handed over
 * verbatim, so they cannot be guessed, and copying one from a different tool's
 * result fails the `c.tool === step.tool` half. What is dropped is only the
 * requirement that the model number its narrative the way the runtime happened to
 * count turns — which was never evidence of anything.
 *
 * Ordering is not lost either: the persisted chain is rebuilt from the tool calls
 * themselves (`reasoningChain`), in the order they were actually made, so the
 * transcript's order comes from the runtime and never from the model.
 * ══════════════════════════════════════════════════════════════════════════════
 */
function digestFor(
  calls: readonly ToolCallRecord[], step: ReasoningStep, position: number,
): string | null {
  // `position` is the index in the reasoning array, not `step.step`. The message
  // has to name something well-defined, and a model-supplied number is not.
  const sameTool = calls.filter((c) => c.tool === step.tool);
  if (sameTool.some((c) => c.resultDigest === step.resultDigest)) return null;
  // Reached only when the tool WAS called (checkGrounding tests that first), so
  // this is the specific claim: a result no call of that tool actually returned.
  return `reasoning step ${position} reports a "${step.tool}" result the runtime `
    + 'did not record';
}

function idsInAction(action: ProposedAction | null): string[] {
  // `== null` for the same reason as `checkConstraints` above.
  if (action == null) return [];
  return action.type === 'MANUAL_MATCH' ? action.members.map((m) => m.transactionId) : [];
}

/**
 * Did the model actually look up `rawValue` and `canonicalValue` before
 * proposing to map one to the other (#58)? Grounded on `check_alias`'s
 * `value` argument and `search_transactions`'s `counterparty` argument — the
 * two tools whose arguments carry a counterparty-shaped string at all.
 * `get_transaction` takes only a `transactionId`, so it cannot ground a
 * text value this way; if it did, the value would live in the tool's
 * RESULT, which is not part of `ToolCallRecord` (only `returnedIds`,
 * `resultDigest` and `arguments` are).
 */
function checkAliasValuesGrounded(
  action: Extract<ProposedAction, { type: 'CREATE_ALIAS' }>,
  calls: readonly ToolCallRecord[],
): string | null {
  const looked = new Set<string>();
  for (const call of calls) {
    const args = call.arguments;
    if (call.tool === 'check_alias' && typeof args['value'] === 'string') {
      looked.add(normalizeAliasValue(args['value']));
    }
    if (call.tool === 'search_transactions' && typeof args['counterparty'] === 'string') {
      looked.add(normalizeAliasValue(args['counterparty']));
    }
  }
  if (!looked.has(normalizeAliasValue(action.rawValue))) {
    return `CREATE_ALIAS.rawValue "${action.rawValue}" was never looked up via check_alias `
      + 'or search_transactions in this investigation';
  }
  if (!looked.has(normalizeAliasValue(action.canonicalValue))) {
    return `CREATE_ALIAS.canonicalValue "${action.canonicalValue}" was never looked up via `
      + 'check_alias or search_transactions in this investigation';
  }
  return null;
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
  // `== null`, NOT `=== null`. `checkSchema` above already treats an ABSENT
  // `proposedAction` as equivalent to a null one — correctly, because a model
  // omitting an optional-looking field is ordinary. This guard did not, so an
  // omitted field reached `action.type` and THREW.
  //
  // A throw here is much worse than a rejection: `validateVerdict` is documented
  // to throw only for a caller bug, so `investigateOne` does not catch it, and
  // the whole investigation was recorded as failed instead of being downgraded.
  // Found by a live run — 2 of 17 investigations lost this way.
  if (action == null) return null;

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
    // Normalized, same as the map's own keys (#58) — `activeAliases` is built
    // from `learned_aliases.normalized_value`, and comparing a raw model value
    // against it made this check fail open on anything but a byte-identical
    // match.
    const key = `${action.aliasType}::${normalizeAliasValue(action.rawValue)}`;
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

/**
 * A rejected verdict still carries `reasoning` (#22): the reasoning array is
 * shown on the exception drill-down and typed `ReasoningStep[]`, so it must
 * actually BE that shape even when it came from output that just failed
 * `checkSchema` — which is precisely the case most likely to hand this
 * function a malformed entry (a bad `tool`, a missing `resultDigest`, an
 * arbitrary extra key). Each entry is checked individually and kept only if
 * it is well-shaped; a single malformed step no longer voids the whole array,
 * and a malformed one is silently dropped rather than smuggled through
 * `Array.isArray` alone. The exact per-field checks `checkSchema` and
 * `checkCorroborationSchema` both already apply on the accept path.
 */
function sanitizeReasoning(value: unknown): ReasoningStep[] {
  if (!Array.isArray(value)) return [];
  const out: ReasoningStep[] = [];
  for (const step of value) {
    const s = step as Record<string, unknown> | null;
    if (s === null || typeof s !== 'object') continue;
    if (typeof s['tool'] !== 'string' || s['tool'] === '') continue;
    if (typeof s['resultDigest'] !== 'string') continue;
    if (typeof s['inference'] !== 'string') continue;
    out.push({
      step: typeof s['step'] === 'number' ? s['step'] : out.length + 1,
      tool: s['tool'], resultDigest: s['resultDigest'], inference: s['inference'],
      arguments: (typeof s['arguments'] === 'object' && s['arguments'] !== null
        ? s['arguments'] : {}) as Record<string, unknown>,
    });
  }
  return out;
}

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
      reasoning: sanitizeReasoning(source.reasoning),
      citations: [],
      summary: typeof source.summary === 'string' ? source.summary : '',
      groundingPassed: false,
      groundingFailure: `${check}: ${reason}`,
      budgetExhausted: false,
    },
    rejection: { check, reason },
  };
}

// ─── A2 CORROBORATE — the same gate, a different vocabulary (ADR-081) ────────

/**
 * Validate a review-queue corroboration.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * IT REUSES `checkGrounding` VERBATIM, AND THAT IS THE POINT.
 *
 * The citation rule, the "cites a tool it never called" rule and the digest
 * checksum are the substance of A3; a second copy tuned for corroborations would
 * drift from the original and the drift would be invisible, because both would
 * keep passing their own tests. Only the SCHEMA differs, because only the
 * vocabulary differs.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── THERE IS NO PROPOSAL ARM, DELIBERATELY ──
 * A corroboration carries no `proposedAction` and the schema rejects one if it
 * appears. agent-design.md §3: "The Analyst does not recommend confirming or
 * rejecting a match. It never says 'confirm this'." The human still clicks,
 * through `PATCH /api/matches/:id`. A gate that would accept a recommendation
 * here is a gate that has stopped enforcing the line ADR-017 draws.
 */
export interface CorroborationGateResult {
  verdict: ValidatedCorroboration;
  rejection: { check: 'schema' | 'grounding'; reason: string } | null;
}

export function validateCorroboration(
  raw: unknown, context: GateContext,
): CorroborationGateResult {
  assertContextIsScoped(context);

  const schema = checkCorroborationSchema(raw);
  if (schema !== null) return rejectCorroboration(raw, 'schema', schema);

  const corroboration = raw as RawCorroboration;

  // `checkGrounding` takes a `RawVerdict`; a corroboration is the same shape
  // minus the proposal, so it is widened with an explicit null rather than
  // copied. There is no action, so `idsInAction` finds none.
  //
  // `CONFIRMED_UNRESOLVABLE` is not an arbitrary stand-in: it selects
  // `checkGrounding`'s "asserts something, so it requires a reasoning chain"
  // arm, and ALL THREE corroboration verdicts assert something. CORROBORATED
  // and CONTRADICTED obviously do. NO_NEW_EVIDENCE does too, and that is the
  // one worth being explicit about — "the engine's score is all there is" is a
  // claim about HAVING LOOKED, and a model that concludes it without calling a
  // tool has not looked. Reaching it for free would make it the cheapest
  // verdict, which is exactly how an agent learns to stop investigating.
  const grounding = checkGrounding(
    { ...corroboration, verdict: 'CONFIRMED_UNRESOLVABLE', proposedAction: null },
    context);
  if (grounding !== null) return rejectCorroboration(corroboration, 'grounding', grounding);

  return {
    verdict: {
      ...corroboration,
      citations: [...new Set(corroboration.citations)].sort(),
      groundingPassed: true,
      groundingFailure: null,
      budgetExhausted: false,
    },
    rejection: null,
  };
}

function checkCorroborationSchema(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return 'corroboration is not an object';
  const v = raw as Record<string, unknown>;

  if (!CORROBORATION_VERDICTS.includes(v['verdict'] as CorroborationVerdict)) {
    return `verdict must be one of ${CORROBORATION_VERDICTS.join(', ')}, `
      + `got ${String(v['verdict'])}`;
  }
  if (!CONFIDENCES.includes(v['confidence'] as AgentConfidence)) {
    return `confidence must be one of ${CONFIDENCES.join(', ')}, got ${String(v['confidence'])}`;
  }
  if (typeof v['summary'] !== 'string' || v['summary'].trim() === '') {
    return 'summary is required';
  }
  if (!Array.isArray(v['citations'])
    || v['citations'].some((c) => typeof c !== 'string')) {
    return 'citations must be an array of strings';
  }
  // A recommendation has no field to live in. If one arrives, the model has been
  // told the wrong job and the verdict is refused rather than quietly stripped —
  // stripping it would hide that the prompt has drifted.
  if (v['proposedAction'] !== undefined && v['proposedAction'] !== null) {
    return 'a corroboration must not carry a proposedAction: it reports evidence, '
      + 'it does not recommend confirming or rejecting a match (ADR-081)';
  }
  if (!Array.isArray(v['reasoning'])) return 'reasoning must be an array';
  for (const [i, step] of (v['reasoning'] as unknown[]).entries()) {
    const s = step as Record<string, unknown>;
    if (s === null || typeof s !== 'object') return `reasoning[${i}] is not an object`;
    if (typeof s['tool'] !== 'string' || s['tool'] === '') return `reasoning[${i}].tool is required`;
    if (typeof s['resultDigest'] !== 'string') return `reasoning[${i}].resultDigest is required`;
    if (typeof s['inference'] !== 'string') return `reasoning[${i}].inference is required`;
  }
  return null;
}

function rejectCorroboration(
  raw: unknown, check: 'schema' | 'grounding', reason: string,
): CorroborationGateResult {
  const source = (raw ?? {}) as Partial<RawCorroboration>;
  return {
    verdict: {
      // NO_NEW_EVIDENCE is the corroboration analogue of INSUFFICIENT_EVIDENCE:
      // the honest floor. A rejected corroboration must not read as
      // CONTRADICTED, which is a positive claim about evidence AGAINST a match.
      verdict: 'NO_NEW_EVIDENCE',
      confidence: 'low',
      // #22, same fix as the investigation gate's reject(): individually
      // shape-checked, not merely Array.isArray.
      reasoning: sanitizeReasoning(source.reasoning),
      citations: [],
      summary: typeof source.summary === 'string' ? source.summary : '',
      groundingPassed: false,
      groundingFailure: `${check}: ${reason}`,
      budgetExhausted: false,
    },
    rejection: { check, reason },
  };
}


/**
 * A3 FOR AN ANSWER (agent-design.md §9, U15).
 *
 * The third vocabulary through one gate. `validateVerdict` judges an
 * investigation, `validateCorroboration` a review-queue corroboration, and this
 * an answer to a free-text question — and all three run the SAME
 * `checkGrounding`, deliberately. A second grounding implementation is a second
 * place for the allow-list to drift, and the drift would be invisible because
 * each copy would keep passing its own tests.
 *
 * WHAT AN ANSWER MAY NOT DO. It may not carry a `proposedAction`, and one that
 * arrives is REFUSED rather than quietly stripped. The Q&A agent reports what
 * the run's data says; it does not recommend a change. Stripping the field
 * would hide that the prompt had drifted into advising — the same argument
 * ADR-081 makes for corroboration, and the same reason the check exists there.
 */
export interface AnswerGateResult {
  answer: ValidatedAnswer;
  rejection: { check: 'schema' | 'grounding'; reason: string } | null;
}

export function validateAnswer(raw: unknown, context: GateContext): AnswerGateResult {
  assertContextIsScoped(context);

  const schema = checkAnswerSchema(raw);
  if (schema !== null) return rejectAnswer(raw, 'schema', schema);

  const answer = raw as RawAnswer;

  // `checkGrounding` takes a `RawVerdict`. An answer is that shape minus the
  // verdict enum and the proposal, so it is widened with both rather than
  // copied — one grounding implementation, three callers.
  //
  // `CONFIRMED_UNRESOLVABLE` is not an arbitrary stand-in. It selects
  // `checkGrounding`'s "asserts something, so it requires a reasoning chain"
  // arm, and EVERY answer asserts something: even "the data does not show
  // that" is a claim about having looked. Without this arm an answer would be
  // reachable from zero tool calls, which would make the emptiest answer the
  // cheapest one to produce — exactly how an agent learns to stop retrieving.
  const grounding = checkGrounding(
    { ...answer, verdict: 'CONFIRMED_UNRESOLVABLE', summary: answer.answer, proposedAction: null },
    context);
  if (grounding !== null) return rejectAnswer(answer, 'grounding', grounding);

  return {
    answer: {
      ...answer,
      citations: [...new Set(answer.citations)].sort(),
      groundingPassed: true,
      groundingFailure: null,
      budgetExhausted: false,
    },
    rejection: null,
  };
}

function checkAnswerSchema(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return 'answer is not an object';
  const v = raw as Record<string, unknown>;

  if (typeof v['answer'] !== 'string' || v['answer'].trim() === '') {
    return 'answer is required and must be a non-empty string';
  }
  if (!CONFIDENCES.includes(v['confidence'] as AgentConfidence)) {
    return `confidence must be one of ${CONFIDENCES.join(', ')}, got ${String(v['confidence'])}`;
  }
  if (!Array.isArray(v['citations']) || v['citations'].some((c) => typeof c !== 'string')) {
    return 'citations must be an array of strings';
  }
  // See the header: refused, not stripped.
  if (v['proposedAction'] !== undefined && v['proposedAction'] !== null) {
    return 'an answer must not carry a proposedAction: the Q&A agent reports what the '
      + 'data says, it does not recommend a change (ADR-081)';
  }
  if (!Array.isArray(v['reasoning'])) return 'reasoning must be an array';
  for (const [i, step] of (v['reasoning'] as unknown[]).entries()) {
    const s = step as Record<string, unknown>;
    if (s === null || typeof s !== 'object') return `reasoning[${i}] is not an object`;
    if (typeof s['tool'] !== 'string' || s['tool'] === '') return `reasoning[${i}].tool is required`;
    if (typeof s['resultDigest'] !== 'string') return `reasoning[${i}].resultDigest is required`;
    if (typeof s['inference'] !== 'string') return `reasoning[${i}].inference is required`;
  }
  return null;
}

/**
 * A REFUSED ANSWER IS STILL RETURNED, never swallowed — the same posture the
 * other two vocabularies take. The caller persists it with
 * `groundingPassed: false` and the stated reason, because an answer the gate
 * caught is evidence the gate works, and hiding it would remove the only
 * signal that the prompt or the tools need attention.
 */
function rejectAnswer(
  raw: unknown, check: 'schema' | 'grounding', reason: string,
): AnswerGateResult {
  const source = (raw ?? {}) as Partial<RawAnswer>;
  return {
    answer: {
      answer: typeof source.answer === 'string' ? source.answer : '',
      confidence: 'low',
      // `sanitizeReasoning`, NOT `Array.isArray` — issue #22 fixed exactly that
      // shortcut in the other two vocabularies, and re-introducing it here
      // would let a malformed step through the one path built to catch it.
      reasoning: sanitizeReasoning(source.reasoning),
      // Emptied deliberately: a citation the gate refused is not evidence, and
      // surfacing it beside a rejected answer would give an ungrounded id the
      // appearance of a retrieved one.
      citations: [],
      groundingPassed: false,
      groundingFailure: `${check}: ${reason}`,
      budgetExhausted: false,
    },
    rejection: { check, reason },
  };
}
