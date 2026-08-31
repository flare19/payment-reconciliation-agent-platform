import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateVerdict, type GateContext } from '../../src/services/agent/grounding-gate.js';
import type { RawVerdict, ToolCallRecord } from '../../src/types/agent.js';
import type { Direction, SourceSystem } from '../../src/types/domain.js';

/**
 * A3 is the only thing standing between a hallucinated reasoning chain and the
 * database, and it is pure functions over a verdict plus a tool-call log — so it
 * is cheap to test exhaustively (testing-strategy §1.6).
 *
 * EVERY test here asserts the NEGATIVE: that a bad verdict does not come back
 * with `groundingPassed: true`. A gate that fails open is worse than no gate,
 * because it produces confident-looking output nobody re-checks.
 */

const RUN = 'run-1';
const G1 = 'txn-gateway-1';
const B1 = 'txn-bank-1';
const L1 = 'txn-ledger-1';

const INV = 'inv-1';

function call(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    investigationId: INV, step: 1, tool: 'get_exception', arguments: {},
    returnedIds: [G1, B1], resultDigest: 'UNSPLITTABLE_BATCH, credit ₹4,82,110',
    durationMs: 4, ...over,
  };
}

function context(over: Partial<GateContext> = {}): GateContext {
  const record = (sourceSystem: SourceSystem, direction: Direction = 'credit',
                  alreadyMatched = false) => ({ runId: RUN, sourceSystem, direction, alreadyMatched });
  return {
    toolCalls: [call()],
    records: new Map([
      [G1, record('gateway')], [B1, record('bank')], [L1, record('ledger')],
    ]),
    runId: RUN,
    investigationId: INV,
    activeAliases: new Map(),
    ...over,
  };
}

function verdict(over: Partial<RawVerdict> = {}): RawVerdict {
  return {
    verdict: 'CONFIRMED_UNRESOLVABLE',
    confidence: 'high',
    proposedAction: null,
    reasoning: [{
      step: 1, tool: 'get_exception', arguments: {},
      resultDigest: 'UNSPLITTABLE_BATCH, credit ₹4,82,110',
      inference: 'The engine stopped on a pool cap, not on a proof.',
    }],
    citations: [G1],
    summary: 'No decomposition exists among the available payments.',
    ...over,
  };
}

const passes = (v: RawVerdict, c: GateContext = context()): boolean =>
  validateVerdict(v, c).verdict.groundingPassed;

describe('A3 — a well-grounded verdict is accepted', () => {
  test('accepted, with citations populated and deduplicated', () => {
    const r = validateVerdict(verdict({ citations: [G1, B1, G1] }), context());
    assert.equal(r.verdict.groundingPassed, true);
    assert.equal(r.verdict.groundingFailure, null);
    assert.equal(r.rejection, null);
    assert.deepEqual(r.verdict.citations, [B1, G1], 'deduplicated and ordered');
    assert.equal(r.verdict.verdict, 'CONFIRMED_UNRESOLVABLE');
  });

  test('citations are populated ONLY by the gate', () => {
    // An unverified citation must never reach the database, so the accepted
    // verdict's citations are the gate's output rather than the model's claim.
    const r = validateVerdict(verdict({ citations: [] }), context());
    assert.equal(r.verdict.groundingPassed, true);
    assert.deepEqual(r.verdict.citations, []);
  });
});

describe('A3 — citation grounding (the anti-hallucination check)', () => {
  test('an id that appears in NO tool result is rejected', () => {
    // The core case. An id the agent never retrieved is an id it invented.
    const r = validateVerdict(verdict({ citations: ['txn-never-seen'] }), context());
    assert.equal(r.verdict.groundingPassed, false);
    assert.equal(r.rejection!.check, 'grounding');
    assert.match(r.verdict.groundingFailure!, /appears in no tool result/);
    assert.equal(r.verdict.verdict, 'INSUFFICIENT_EVIDENCE', 'downgraded, not accepted');
  });

  test('GROUNDING IS PER INVESTIGATION — another run’s ids are not evidence', () => {
    // The agent did not see this id while forming this conclusion. Accepting it
    // would let one investigation launder another’s results into a chain that
    // never actually examined them.
    const otherInvestigation = context({ toolCalls: [call({ returnedIds: ['txn-from-elsewhere'] })] });
    assert.equal(passes(verdict({ citations: ['txn-from-elsewhere'] }), otherInvestigation), true);
    assert.equal(passes(verdict({ citations: [G1] }), otherInvestigation), false,
      'an id from a DIFFERENT investigation must not ground a citation here');
  });

  test('A CONTEXT CARRYING ANOTHER INVESTIGATION’S TOOL CALLS IS REFUSED', () => {
    // Issue #21. The test above only proves the gate honours whichever context it
    // is handed — a restatement of "the function reads its argument". It would pass
    // unchanged if the loop passed the WHOLE RUN's tool-call log, which is the
    // natural implementation and silently widens grounding to every investigation
    // at once. Every existing test would still pass and the grounding-failure count
    // would DROP, reading as an improvement.
    //
    // A mixed context is a caller bug, not a model failure, so it throws rather
    // than downgrading: attributing a programming error to the model would corrupt
    // the grounding-failure metric agent-design §7 reads as a prompt-quality signal.
    const mixed = context({
      toolCalls: [
        call({ returnedIds: [G1] }),
        call({ investigationId: 'inv-somewhere-else', step: 2, returnedIds: ['txn-laundered'] }),
      ],
    });
    assert.throws(() => validateVerdict(verdict({ citations: [G1] }), mixed),
      /investigation/i, 'a tool call from another investigation must not be silently accepted');

    // And the laundering this prevents: without the check, citing an id only the
    // foreign call returned would have grounded cleanly.
    assert.throws(() => validateVerdict(verdict({ citations: ['txn-laundered'] }), mixed),
      /investigation/i);
  });

  test('a context whose calls are ALL foreign is refused too', () => {
    // Not just a mixed context: a wholesale swap is the same bug and must not read
    // as a well-scoped investigation that happened to retrieve different ids.
    const foreign = context({
      toolCalls: [call({ investigationId: 'inv-elsewhere', returnedIds: [G1] })],
    });
    assert.throws(() => validateVerdict(verdict({ citations: [G1] }), foreign), /investigation/i);
  });

  test('an empty tool-call log is not a scoping error', () => {
    // Nothing to be out of scope. This must still reach the ordinary checks, which
    // reject an asserting verdict with no reasoning for the RIGHT reason.
    const r = validateVerdict(
      verdict({ reasoning: [], citations: [] }), context({ toolCalls: [] }));
    assert.equal(r.verdict.groundingPassed, false);
    assert.equal(r.rejection!.check, 'grounding');
    assert.match(r.verdict.groundingFailure!, /requires a reasoning chain/);
  });

  test('a reasoning step naming a tool that was never called is rejected', () => {
    const r = validateVerdict(verdict({
      reasoning: [{ step: 1, tool: 'rerun_subset_search', arguments: {},
        resultDigest: 'x', inference: 'y' }],
    }), context());
    assert.equal(r.verdict.groundingPassed, false);
    assert.match(r.verdict.groundingFailure!, /never called/);
  });

  test('a step whose resultDigest is not what the runtime recorded is rejected', () => {
    // resultDigest is the RUNTIME's record; inference is the model's. Letting the
    // model write both would make the chain self-consistent and unverifiable at
    // the same time.
    const r = validateVerdict(verdict({
      reasoning: [{ step: 1, tool: 'get_exception', arguments: {},
        resultDigest: 'a result the tool never returned', inference: 'y' }],
    }), context());
    assert.equal(r.verdict.groundingPassed, false);
    assert.match(r.verdict.groundingFailure!, /the runtime did not record/);
  });

  test('a conclusion drawn from no tool calls at all is rejected', () => {
    for (const v of ['RESOLUTION_PROPOSED', 'CONFIRMED_UNRESOLVABLE'] as const) {
      const body = v === 'RESOLUTION_PROPOSED'
        ? verdict({ verdict: v, reasoning: [], citations: [],
            proposedAction: { type: 'MARK_WONT_FIX', rationale: 'because' } })
        : verdict({ verdict: v, reasoning: [], citations: [] });
      const r = validateVerdict(body, context());
      assert.equal(r.verdict.groundingPassed, false, `${v} with no reasoning must be rejected`);
      assert.match(r.verdict.groundingFailure!, /requires a reasoning chain/);
    }
  });

  test('ids inside a PROPOSAL are grounded too, not just citations', () => {
    // A proposal is what a human will act on, so its ids are load-bearing claims.
    const r = validateVerdict(verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1],
      proposedAction: { type: 'MANUAL_MATCH', rationale: 'same payment',
        members: [{ transactionId: G1, role: 'gateway' },
                  { transactionId: 'txn-invented', role: 'bank' }] },
    }), context());
    assert.equal(r.verdict.groundingPassed, false);
    assert.match(r.verdict.groundingFailure!, /txn-invented/);
  });
});

describe('A3 — schema', () => {
  test('CONFIDENCE MUST BE A LABEL, never a number (ADR-053)', () => {
    // The engine's confidence is computed and the agent's is asserted. Identical
    // types would invite averaging one into the other.
    const r = validateVerdict({ ...verdict(), confidence: 0.87 as never }, context());
    assert.equal(r.verdict.groundingPassed, false);
    assert.equal(r.rejection!.check, 'schema');
    assert.match(r.verdict.groundingFailure!, /confidence must be a label/);
  });

  test('an unknown verdict value is rejected', () => {
    assert.equal(passes({ ...verdict(), verdict: 'DEFINITELY_A_MATCH' as never }), false);
  });

  test('RESOLUTION_PROPOSED without an action, and others WITH one, are rejected', () => {
    assert.equal(passes(verdict({ verdict: 'RESOLUTION_PROPOSED', proposedAction: null })), false);
    assert.equal(passes(verdict({
      verdict: 'CONFIRMED_UNRESOLVABLE',
      proposedAction: { type: 'MARK_WONT_FIX', rationale: 'x' },
    })), false, 'a non-proposal must not smuggle in an action');
  });

  test('missing or empty required fields are rejected', () => {
    assert.equal(passes(verdict({ summary: '' })), false);
    assert.equal(passes(verdict({ summary: '   ' })), false);
    assert.equal(passes({ ...verdict(), citations: 'not-an-array' as never }), false);
    assert.equal(passes({ ...verdict(), reasoning: 'nope' as never }), false);
  });

  test('a non-object verdict is rejected rather than throwing', () => {
    for (const junk of [null, undefined, 'a string', 42, []]) {
      const r = validateVerdict(junk, context());
      assert.equal(r.verdict.groundingPassed, false);
      assert.equal(r.verdict.verdict, 'INSUFFICIENT_EVIDENCE');
    }
  });

  test('a MANUAL_MATCH with fewer than two members is rejected', () => {
    assert.equal(passes(verdict({
      verdict: 'RESOLUTION_PROPOSED',
      proposedAction: { type: 'MANUAL_MATCH', rationale: 'x',
        members: [{ transactionId: G1, role: 'gateway' }] },
    })), false);
  });
});

describe('A3 — constraints on a proposal', () => {
  const proposal = (members: { transactionId: string; role: SourceSystem }[]): RawVerdict =>
    verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1, B1],
      proposedAction: { type: 'MANUAL_MATCH', rationale: 'the same payment', members },
    });

  test('a well-formed proposal passes', () => {
    const r = validateVerdict(
      proposal([{ transactionId: G1, role: 'gateway' }, { transactionId: B1, role: 'bank' }]),
      context());
    assert.equal(r.verdict.groundingPassed, true);
  });

  test('an ALREADY-MATCHED record is rejected', () => {
    const ctx = context({
      records: new Map([
        [G1, { runId: RUN, sourceSystem: 'gateway' as const, direction: 'credit' as const, alreadyMatched: true }],
        [B1, { runId: RUN, sourceSystem: 'bank' as const, direction: 'credit' as const, alreadyMatched: false }],
      ]),
    });
    const r = validateVerdict(
      proposal([{ transactionId: G1, role: 'gateway' }, { transactionId: B1, role: 'bank' }]), ctx);
    assert.equal(r.verdict.groundingPassed, false);
    assert.equal(r.rejection!.check, 'constraint');
    assert.match(r.verdict.groundingFailure!, /already belongs to a match/);
  });

  test('two members of the SAME source role are rejected', () => {
    const ctx = context({
      records: new Map([
        [G1, { runId: RUN, sourceSystem: 'gateway' as const, direction: 'credit' as const, alreadyMatched: false }],
        ['txn-gateway-2', { runId: RUN, sourceSystem: 'gateway' as const, direction: 'credit' as const, alreadyMatched: false }],
      ]),
      toolCalls: [call({ returnedIds: [G1, 'txn-gateway-2'] })],
    });
    // Cite exactly what this context returned, so grounding passes and the
    // CONSTRAINT check is the thing under test. The checks run schema ->
    // grounding -> constraint, so an inconsistent fixture would silently test
    // the wrong one.
    const r = validateVerdict(verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1, 'txn-gateway-2'],
      proposedAction: { type: 'MANUAL_MATCH', rationale: 'the same payment',
        members: [{ transactionId: G1, role: 'gateway' },
                  { transactionId: 'txn-gateway-2', role: 'gateway' }] },
    }), ctx);
    assert.equal(r.verdict.groundingPassed, false);
    assert.equal(r.rejection!.check, 'constraint');
    assert.match(r.verdict.groundingFailure!, /share the gateway role/);
  });

  test('OPPOSITE DIRECTIONS are rejected — a credit never matches a debit', () => {
    const ctx = context({
      records: new Map([
        [G1, { runId: RUN, sourceSystem: 'gateway' as const, direction: 'credit' as const, alreadyMatched: false }],
        [B1, { runId: RUN, sourceSystem: 'bank' as const, direction: 'debit' as const, alreadyMatched: false }],
      ]),
    });
    const r = validateVerdict(
      proposal([{ transactionId: G1, role: 'gateway' }, { transactionId: B1, role: 'bank' }]), ctx);
    assert.equal(r.verdict.groundingPassed, false);
    assert.match(r.verdict.groundingFailure!, /credit never matches a debit/);
  });

  test('a member from a different run is rejected', () => {
    const ctx = context({
      records: new Map([
        [G1, { runId: RUN, sourceSystem: 'gateway' as const, direction: 'credit' as const, alreadyMatched: false }],
        [B1, { runId: 'a-different-run', sourceSystem: 'bank' as const, direction: 'credit' as const, alreadyMatched: false }],
      ]),
    });
    assert.equal(passes(
      proposal([{ transactionId: G1, role: 'gateway' }, { transactionId: B1, role: 'bank' }]), ctx), false);
  });

  test('a role that disagrees with the record is rejected', () => {
    assert.equal(passes(
      proposal([{ transactionId: G1, role: 'bank' }, { transactionId: B1, role: 'gateway' }])), false);
  });

  test('an alias contradicting an active one must go to a human, not be proposed', () => {
    // ADR-013's supersede-with-penalty is a human decision through endpoint 16.
    const ctx = context({ activeAliases: new Map([['merchant_name::AMZN', 'AMAZON PAY']]) });
    const r = validateVerdict(verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1],
      proposedAction: { type: 'CREATE_ALIAS', aliasType: 'merchant_name',
        rawValue: 'AMZN', canonicalValue: 'AMAZON RETAIL', rationale: 'same merchant' },
    }), ctx);
    assert.equal(r.verdict.groundingPassed, false);
    assert.match(r.verdict.groundingFailure!, /must be confirmed by a human/);
  });

  test('a self-referential alias is rejected', () => {
    assert.equal(passes(verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1],
      proposedAction: { type: 'CREATE_ALIAS', aliasType: 'merchant_name',
        rawValue: 'AMZN', canonicalValue: 'AMZN', rationale: 'x' },
    })), false);
  });
});

describe('A3 — rejection behaviour', () => {
  test('a rejected verdict is DOWNGRADED, never dropped', () => {
    // The investigation happened; its failure is itself a result. Suppressing it
    // would hide the signal that the prompt or the tools need work.
    const r = validateVerdict(verdict({ citations: ['invented'] }), context());
    assert.equal(r.verdict.verdict, 'INSUFFICIENT_EVIDENCE');
    assert.equal(r.verdict.confidence, 'low');
    assert.equal(r.verdict.proposedAction, null);
    assert.ok(r.verdict.groundingFailure!.length > 0);
    assert.deepEqual(r.verdict.citations, [], 'an ungrounded verdict keeps no citations');
  });

  test('the failure names which check rejected it', () => {
    assert.equal(validateVerdict({ ...verdict(), confidence: 1 as never }, context()).rejection!.check, 'schema');
    assert.equal(validateVerdict(verdict({ citations: ['x'] }), context()).rejection!.check, 'grounding');
  });

  test('THE GATE NEVER FAILS OPEN — top-level fields', () => {
    // Sweep every field with a plausible corruption. Any one of these coming back
    // accepted would mean the gate is decoration.
    const corruptions: Partial<RawVerdict>[] = [
      { verdict: 'MATCHED' as never }, { confidence: 'certain' as never },
      { confidence: 1 as never }, { summary: '' }, { citations: ['ghost'] },
      { reasoning: [{ step: 9, tool: 'nope', arguments: {}, resultDigest: 'x', inference: 'y' }] },
      { verdict: 'RESOLUTION_PROPOSED', proposedAction: null },
    ];
    for (const c of corruptions) {
      const r = validateVerdict({ ...verdict(), ...c }, context());
      assert.equal(r.verdict.groundingPassed, false,
        `a gate that accepts ${JSON.stringify(c).slice(0, 60)} is decoration`);
    }
  });

  test('THE GATE NEVER FAILS OPEN — every action type, every field', () => {
    // Issue #19. The old sweep's name was broader than what it tested: every
    // corruption in it is a top-level field or a MANUAL_MATCH, and checkSchema
    // descended into MANUAL_MATCH alone. So an ADJUST_SEARCH_BOUNDS proposal with
    // no bounds at all was ACCEPTED — `undefined <= 0` is false, so the one check
    // that existed silently affirmed — and a CREATE_ALIAS missing canonicalValue
    // slipped past the self-map test for the same reason.
    //
    // Bad values are per field KIND, not one list for everything: 'lots' is a
    // perfectly good rationale and a bad poolSize, and a sweep that conflates them
    // asserts the wrong thing in both directions.
    const NOT_TEXT = [undefined, null, '', '   ', 0, -1, NaN, [], {}, true, ['a']];
    const NOT_ENUM = [...NOT_TEXT, 'DROP TABLE', 'gatewayy'];
    const NOT_BOUND = [undefined, null, '', '32', 0, -1, NaN, Infinity, 1.5, [], {}, true];

    const variants: Array<{
      name: string;
      action: Record<string, unknown>;
      fields: Array<[string, unknown[]]>;
    }> = [
      {
        name: 'MANUAL_MATCH',
        action: { type: 'MANUAL_MATCH', rationale: 'r',
          members: [{ transactionId: G1, role: 'gateway' }, { transactionId: B1, role: 'bank' }] },
        fields: [
          ['rationale', NOT_TEXT],
          ['members', [...NOT_TEXT, [{ transactionId: G1, role: 'gateway' }],
            [{ transactionId: G1, role: 'gateway' }, { transactionId: B1 }],
            [{ transactionId: G1, role: 'gateway' }, { transactionId: 42, role: 'bank' }],
            [{ transactionId: G1, role: 'gateway' }, { transactionId: B1, role: 'ledgerr' }]]],
        ],
      },
      {
        name: 'CREATE_ALIAS',
        action: { type: 'CREATE_ALIAS', rationale: 'r',
          aliasType: 'merchant_name', rawValue: 'AMZN', canonicalValue: 'AMAZON RETAIL' },
        fields: [
          ['rationale', NOT_TEXT],
          ['aliasType', NOT_ENUM],
          ['rawValue', NOT_TEXT],
          ['canonicalValue', NOT_TEXT],
        ],
      },
      {
        name: 'MARK_WONT_FIX',
        action: { type: 'MARK_WONT_FIX', rationale: 'r' },
        fields: [['rationale', NOT_TEXT]],
      },
      {
        name: 'ADJUST_SEARCH_BOUNDS',
        action: { type: 'ADJUST_SEARCH_BOUNDS', rationale: 'r',
          poolSize: 32, maxSubsetSize: 6, nodeBudget: 1_000_000 },
        fields: [
          ['rationale', NOT_TEXT],
          ['poolSize', NOT_BOUND],
          ['maxSubsetSize', NOT_BOUND],
          ['nodeBudget', NOT_BOUND],
        ],
      },
    ];

    const propose = (action: unknown): boolean => passes(verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1, B1], proposedAction: action as never,
    }));

    let swept = 0;
    for (const { name, action, fields } of variants) {
      // The well-formed variant must PASS, or every rejection below proves nothing.
      assert.equal(propose(action), true, `${name} is well-formed and must be accepted`);

      for (const [field, badValues] of fields) {
        for (const value of badValues) {
          assert.equal(propose({ ...action, [field]: value }), false,
            `${name}.${field} = ${JSON.stringify(value) ?? 'undefined'} was ACCEPTED — the gate failed open`);
          swept += 1;
        }
        // And the field missing entirely, which is how a model most often gets it
        // wrong: `undefined <= 0` and `'AMZN' === undefined` both read as "fine".
        const { [field]: _dropped, ...without } = action;
        assert.equal(propose(without), false,
          `${name} with ${field} MISSING was ACCEPTED — the gate failed open`);
        swept += 1;
      }
    }
    assert.ok(swept >= 60, `the sweep must actually sweep; it covered ${swept}`);
  });

  test('ADR-054/085 ceilings are enforced on a proposal, not merely on the tool', () => {
    // The gate is the only deterministic check on the proposal a human sees, so a
    // request for a pool of a billion must not reach them looking actionable.
    for (const over of [
      { poolSize: 65 }, { maxSubsetSize: 11 }, { nodeBudget: 5_200_001 },
      { poolSize: 1e9, maxSubsetSize: 500, nodeBudget: 1e12 },
    ]) {
      assert.equal(passes(verdict({
        verdict: 'RESOLUTION_PROPOSED', citations: [G1],
        proposedAction: { type: 'ADJUST_SEARCH_BOUNDS', rationale: 'wider',
          poolSize: 32, maxSubsetSize: 6, nodeBudget: 1_000_000, ...over } as never,
      })), false, `bounds above the ceiling were accepted: ${JSON.stringify(over)}`);
    }
    // Exactly at the ceiling is legal.
    assert.equal(passes(verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1],
      proposedAction: { type: 'ADJUST_SEARCH_BOUNDS', rationale: 'wider',
        poolSize: 64, maxSubsetSize: 10, nodeBudget: 5_200_000 },
    })), true);
  });

  test('ADR-085: a TIME budget is not an adjustable bound and cannot be proposed', () => {
    // The defect this replaced: with `budgetMs` selectable, the operative bound
    // sat on the wall clock INSIDE the evidence a reasoning chain cites, and
    // `searchExhausted` vs `searchBoundExceeded` — two different claims about the
    // DATA — would have been decided by how fast the box was. §5's whole payoff
    // is that "exhaustive at wider bounds" is reproducible on a second machine.
    assert.equal(passes(verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1],
      proposedAction: { type: 'ADJUST_SEARCH_BOUNDS', rationale: 'wider',
        poolSize: 32, maxSubsetSize: 6, budgetMs: 1_500 } as never,
    })), false, 'a proposal carrying budgetMs instead of nodeBudget must not validate');
  });

  test('an unknown alias type is rejected', () => {
    assert.equal(passes(verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1],
      proposedAction: { type: 'CREATE_ALIAS', aliasType: 'DROP TABLE' as never,
        rawValue: 'a', canonicalValue: 'b', rationale: 'r' },
    })), false);
  });

  test('an OMITTED proposedAction is rejected, never thrown on', () => {
    // `checkSchema` treats absent as equivalent to null; `checkConstraints`
    // guarded only `=== null` and then read `action.type`, so an omitted field
    // THREW. `validateVerdict` is documented to throw only for a CALLER bug, so
    // the loop does not catch it and the whole investigation was recorded as
    // failed rather than downgraded. A live run lost 2 of 17 this way.
    const { proposedAction: _dropped, ...without } = verdict({
      verdict: 'CONFIRMED_UNRESOLVABLE', citations: [G1] });
    assert.doesNotThrow(() => validateVerdict(without, context()));
    // And it still VALIDATES: a non-proposal verdict with no action is legal.
    assert.equal(passes(without as never), true);
  });

  test('an omitted action on a PROPOSAL is still rejected by the schema', () => {
    // The other direction: absent must not become a free pass.
    const { proposedAction: _d, ...without } = verdict({
      verdict: 'RESOLUTION_PROPOSED', citations: [G1] });
    assert.equal(passes(without as never), false);
  });

  test('validation is pure — the same input always gives the same result', () => {
    const v = verdict({ citations: [G1, B1] });
    const first = JSON.stringify(validateVerdict(v, context()));
    for (let i = 0; i < 20; i += 1) {
      assert.equal(JSON.stringify(validateVerdict(v, context())), first);
    }
  });
});
