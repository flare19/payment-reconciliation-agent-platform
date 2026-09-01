import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseResponse, buildUserMessage, createExplainClient, MAX_SIGNATURES_PER_REQUEST,
  type SignaturePrompt, findUngroundedSpecific,
} from '../../src/services/explain/llm-client.js';
import { unwrapJson } from '../../src/services/explain/anthropic-explain-client.js';

/**
 * The client's two testable halves are its PARSER and its no-key behaviour.
 * The network call itself is not mocked — the driver's tests inject a fake
 * `ExplainLlmClient` instead, which exercises every branch that matters without
 * pretending to test Google's SDK.
 */

const asked = new Set(['sig_1', 'sig_2']);

const ok = JSON.stringify({
  explanations: [
    { id: 'sig_1', explanation: 'The bank credit never arrived.', suggested_action: 'Check the statement.' },
    { id: 'sig_2', explanation: 'Two candidates tied.', suggested_action: 'Compare them by hand.' },
  ],
});

describe('parseResponse', () => {
  test('parses the documented response shape', () => {
    const out = parseResponse(ok, asked);
    assert.ok(out);
    assert.equal(out!.size, 2);
    assert.equal(out!.get('sig_1')!.explanation, 'The bank credit never arrived.');
    assert.equal(out!.get('sig_2')!.suggestedAction, 'Compare them by hand.');
  });

  test('DROPS an id that was never asked about', () => {
    // A response naming a signature the batch did not contain is the model
    // inventing a subject. Fanning that text out would attach prose to an
    // exception it was never written about.
    const rogue = JSON.stringify({
      explanations: [
        { id: 'sig_1', explanation: 'Real one.', suggested_action: 'Do the thing.' },
        { id: 'sig_99', explanation: 'Invented.', suggested_action: 'Invented.' },
      ],
    });
    const out = parseResponse(rogue, asked);
    assert.ok(out);
    assert.equal(out!.size, 1);
    assert.equal(out!.has('sig_99'), false);
  });

  test('a PARTIAL response is used, not discarded — that is not malformed JSON', () => {
    // §10.4's retry is for unparseable output. Throwing away eight good
    // explanations because two are absent would be a worse trade than letting
    // the driver template the two.
    const partial = JSON.stringify({
      explanations: [{ id: 'sig_1', explanation: 'Only this one.', suggested_action: 'Act.' }],
    });
    const out = parseResponse(partial, asked);
    assert.ok(out);
    assert.equal(out!.size, 1);
    assert.equal(out!.has('sig_2'), false, 'the absent one is left for the template floor');
  });

  test('a blank explanation is treated as ABSENT, never written through', () => {
    // An exception rendering an empty explanation panel is worse than one
    // rendering the hand-written template.
    for (const bad of ['', '   ', '\n']) {
      const out = parseResponse(JSON.stringify({
        explanations: [{ id: 'sig_1', explanation: bad, suggested_action: 'Act.' }],
      }), asked);
      assert.ok(out);
      assert.equal(out!.has('sig_1'), false, `blank explanation ${JSON.stringify(bad)} leaked through`);
    }
    const noAction = parseResponse(JSON.stringify({
      explanations: [{ id: 'sig_1', explanation: 'Text.', suggested_action: '  ' }],
    }), asked);
    assert.equal(noAction!.has('sig_1'), false);
  });

  test('returns null — the retry signal — only when nothing is usable', () => {
    assert.equal(parseResponse(undefined, asked), null);
    assert.equal(parseResponse('', asked), null);
    assert.equal(parseResponse('not json at all', asked), null);
    assert.equal(parseResponse('{"explanations": "a string"}', asked), null);
    assert.equal(parseResponse('[]', asked), null);
    assert.equal(parseResponse('null', asked), null);
    assert.equal(parseResponse('"a bare string"', asked), null);
  });

  test('a well-formed response with no usable rows parses to an EMPTY map, not null', () => {
    // The distinction the retry depends on: `null` means "I could not read
    // this", an empty map means "I read it and it said nothing about my
    // signatures". Both end in templates, but only the first is worth a retry.
    const out = parseResponse(JSON.stringify({ explanations: [] }), asked);
    assert.notEqual(out, null);
    assert.equal(out!.size, 0);
  });

  test('non-object rows are skipped rather than crashing the batch', () => {
    const messy = JSON.stringify({
      explanations: [null, 42, 'text', { id: 'sig_1', explanation: 'Good.', suggested_action: 'Act.' }],
    });
    const out = parseResponse(messy, asked);
    assert.equal(out!.size, 1);
  });

  test('whitespace is trimmed off both fields', () => {
    const out = parseResponse(JSON.stringify({
      explanations: [{ id: 'sig_1', explanation: '  padded  ', suggested_action: '\tact\n' }],
    }), asked);
    assert.equal(out!.get('sig_1')!.explanation, 'padded');
    assert.equal(out!.get('sig_1')!.suggestedAction, 'act');
  });
});

describe('buildUserMessage', () => {
  const sig: SignaturePrompt = {
    id: 'sig_1', category: 'AMOUNT_MISMATCH', amountDelta: '3_to_10pct',
    dateDelta: 'within_window', sourcesPresent: 'gateway+bank', anchorStrength: 'strong',
    aliasInvolved: 'no', candidateCount: '1', secondaryFlags: ['TIMING_DRIFT'],
    occurrenceCount: 14,
  };

  test('emits §10.4\'s snake_case prompt body', () => {
    const body = JSON.parse(buildUserMessage([sig])) as Record<string, Record<string, unknown>[]>;
    assert.deepEqual(body['signatures']![0], {
      id: 'sig_1', category: 'AMOUNT_MISMATCH', amount_delta: '3_to_10pct',
      date_delta: 'within_window', sources_present: 'gateway+bank', anchor_strength: 'strong',
      alias_involved: 'no', candidate_count: '1', secondary_flags: ['TIMING_DRIFT'],
      occurrence_count: 14,
    });
  });

  test('carries no amount, no id and no merchant name (ADR-018, ADR-080 consequence 3)', () => {
    // The privacy property that makes a free tier acceptable here: the prompt is
    // buckets and counts. If a specific ever reaches this string, the claim in
    // ADR-080 stops being true.
    const body = buildUserMessage([sig]);
    assert.equal(/\d{4,}/.test(body.replace(/occurrence_count":\s*\d+/, '')), false,
      'no long digit run may appear — that would be an amount or a reference id');
    assert.equal(body.includes('₹'), false);
  });
});

describe('createExplainClient — the no-key path is a legitimate state', () => {
  const base = { geminiApiKey: 'k', explainModel: 'gemini-3.5-flash', llmExplainEnabled: true };

  test('returns null with no key, so the driver templates everything', () => {
    assert.equal(createExplainClient({ ...base, geminiApiKey: null }), null);
    assert.equal(createExplainClient({ ...base, geminiApiKey: '' }), null);
  });

  test('returns null when the explain layer is switched off', () => {
    assert.equal(createExplainClient({ ...base, llmExplainEnabled: false }), null);
  });

  test('returns a client carrying the configured model, which the signature hashes', () => {
    const c = createExplainClient(base);
    assert.ok(c);
    assert.equal(c!.model, 'gemini-3.5-flash');
  });
});

test('§10.3 batches at most 10 signatures per request', () => {
  assert.equal(MAX_SIGNATURES_PER_REQUEST, 10);
});

/**
 * ── S13's GROUNDING CHECK (issue #52) ──
 *
 * Phase A treats a fabricated specific as a build blocker (ADR-053). S13 — the
 * layer a panelist actually reads — had only a line in the prompt asking the
 * model not to invent one, and nothing that checked.
 *
 * The detector is sharp because S13's INPUT provably contains no specifics:
 * ADR-018's signature is bucketed by construction, `buildUserMessage` emits only
 * those buckets, and the test above already asserts no long digit run reaches
 * the prompt. So a rupee figure, a date or a reference id in the OUTPUT did not
 * come from us — there is no legitimate route by which it could have.
 *
 * Both arms, always: a check only ever seen to pass is indistinguishable from
 * one that cannot fire.
 */
describe('S13 rejects a specific the prompt never supplied (#52)', () => {
  const FABRICATED: [string, string][] = [
    ['a rupee symbol', 'The gateway captured ₹4,82,110 with no matching bank credit.'],
    ['a bare Rs. amount', 'A payment of Rs. 48210 is unmatched.'],
    ['an INR label', 'The INR 500 difference is unexplained.'],
    ['a payment id', 'Payment pay_c9zqFpdcakznDx has no counterpart.'],
    ['a settlement id', 'The credit setl_yWY9cEo8cDeRXl nets several payments.'],
    ['an RRN', 'Reference 398527795876 appears on only one side.'],
    ['an ISO date', 'The record is dated 2026-07-28 and sits outside the window.'],
    ['a calendar date', 'Posted on 28/07/2026, outside the settlement window.'],
    ['a fabricated count', 'This shape covers 147 exceptions across the batch.'],
  ];

  for (const [what, text] of FABRICATED) {
    test(`REJECTED: ${what}`, () => {
      const reason = findUngroundedSpecific(text, 39);
      assert.notEqual(reason, null, `"${text}" should have been refused`);
      assert.match(reason!, /which the prompt never supplied/);
    });
  }

  const CLEAN: [string, string][] = [
    ['generic prose', 'A captured gateway payment is past its settlement window with no bank '
      + 'credit at any score. Ask the bank for a settlement advice covering this period.'],
    ['a bucket label echoed', 'The amounts differ by 3 to 10 percent, beyond rounding and '
      + 'known fees.'],
    ['a small ordinal', 'Two candidates scored within a hair of each other.'],
    ['a percentage', 'The difference is under 1 percent of the payment.'],
  ];

  for (const [what, text] of CLEAN) {
    test(`ACCEPTED: ${what}`, () => {
      assert.equal(findUngroundedSpecific(text, 39), null,
        `"${text}" is legitimate S13 output and must not be refused`);
    });
  }

  test('the signature\'s OWN occurrence count is grounded, and only that value', () => {
    // buildUserMessage sends `occurrence_count`, so quoting it is grounded, not
    // invented (#52's fifth acceptance criterion). Exempted by VALUE, not by
    // length: the holdout's largest is 39, but ADR-045's 100k benchmark will
    // produce signatures covering hundreds, and a rule that only holds at one
    // scale is not a rule.
    assert.equal(findUngroundedSpecific('This shape covers 147 exceptions.', 147), null);
    assert.notEqual(findUngroundedSpecific('This shape covers 147 exceptions.', 39), null);
    assert.notEqual(findUngroundedSpecific('This shape covers 148 exceptions.', 147), null);
  });

  test('a small allowed count cannot mask a longer fabricated number', () => {
    // The lookarounds in `scrubAllowedCount` are load-bearing. With a count of 1,
    // a naive replace turns "100" into "00" and hides it.
    assert.notEqual(findUngroundedSpecific('The batch totalled 100 payments.', 1), null);
    assert.notEqual(findUngroundedSpecific('Reference 111111111111 is unmatched.', 1), null);
    assert.equal(findUngroundedSpecific('This covers 1 exception.', 1), null);
  });

  test('a null occurrence count exempts nothing', () => {
    assert.notEqual(findUngroundedSpecific('This shape covers 147 exceptions.', null), null);
  });
});

describe('the Anthropic explain client unwraps a fenced response (ADR-093)', () => {
  // The first live Anthropic run generated 10 of 21 signatures and lost 2 whole
  // batches to "not usable JSON". The Gemini client constrained output with a
  // response schema; porting the request without porting the constraint left
  // the gap. Lenient about wrapping, strict about content.
  test('a ```json fence is stripped', () => {
    assert.equal(unwrapJson('```json\n{"explanations":[]}\n```'), '{"explanations":[]}');
  });
  test('a bare fence is stripped', () => {
    assert.equal(unwrapJson('```\n{"a":1}\n```'), '{"a":1}');
  });
  test('preamble around the object is dropped', () => {
    assert.equal(unwrapJson('Here you go:\n{"a":1}\nHope that helps.'), '{"a":1}');
  });
  test('clean JSON is returned unchanged', () => {
    assert.equal(unwrapJson('{"a":1}'), '{"a":1}');
  });
  test('it does not manufacture JSON from prose', () => {
    // Strict about content: unwrapping must not turn a refusal into an object.
    assert.equal(unwrapJson('I cannot help with that.'), 'I cannot help with that.');
    assert.equal(parseResponse(unwrapJson('I cannot help with that.'), new Set(['sig_1'])), null);
  });
});
