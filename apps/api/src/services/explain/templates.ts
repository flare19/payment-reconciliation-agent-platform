/**
 * S13 — the hand-written floor (schema.md §10.4).
 *
 * `explanation_text` is NEVER null on a completed run. When the LLM API is
 * unavailable, the call cap is hit, or a batch comes back as malformed JSON
 * twice, every affected exception gets the template for its category from here
 * and `explanation_source = 'template'`. This is the PRIMARY path, not a
 * degraded one — the engine has no Anthropic/Gemini key on most runs, and
 * ADR-017 requires the run to complete without one.
 *
 * The prose is deliberately general — it describes the SHAPE of the category,
 * not this instance — because a template is fanned out across every exception
 * that shares a signature and must be true of all of them. Specifics belong in
 * the exception's own `evidence` object, which the UI renders beside this text.
 *
 * This file also owns the STATIC system prompt (schema.md §10.4). It is versioned
 * by `PROMPT_VERSION` — change the wording and you must bump it, or the cache
 * will serve prose written against the old instructions (ADR-018).
 */

import { DEFAULT_PROMPT_VERSION } from '../../config/defaults.js';
import type { ExceptionCategory } from '../../types/domain.js';

export interface TemplateText {
  explanationText: string;
  suggestedAction: string;
}

/**
 * The last-resort text, used when the category is somehow unrecognised. Every
 * real category has its own entry below; this exists so `templateFor` is total.
 */
export const EXPLANATION_FALLBACK_TEMPLATE: TemplateText = {
  explanationText:
    'The engine could not reconcile this record against the other sources and has '
    + 'flagged it for a person to look at. The evidence panel lists every candidate it '
    + 'considered and why each was rejected.',
  suggestedAction:
    'Review the record against the other sources manually and resolve or dismiss it with a note.',
};

const TEMPLATES: Record<ExceptionCategory, TemplateText> = {
  DUPLICATE_RECORD: {
    explanationText:
      'The same payment appears more than once within a single source. One copy has been '
      + 'kept as the real record and the others set aside, so the payment is not counted twice.',
    suggestedAction:
      'Confirm the extra copy is a genuine duplicate and remove it from the source system.',
  },
  AMBIGUOUS_MATCH: {
    explanationText:
      'Two or more records in the other source are an almost equally good match for this one, '
      + 'and they score too close together for the engine to choose safely. It has stopped rather '
      + 'than risk pairing the wrong two records.',
    suggestedAction:
      'Compare the tied candidates by hand and confirm which one belongs to this payment.',
  },
  MISSING_IN_BANK: {
    explanationText:
      'This payment was captured at the gateway and its settlement window has already passed, '
      + 'but no matching credit has arrived in the bank file. The money that was collected has '
      + 'not been seen to settle.',
    suggestedAction:
      'Check the bank statement and the settlement report for a credit matching this payment.',
  },
  MISSING_IN_LEDGER: {
    explanationText:
      'The gateway and/or bank show this payment, but the merchant ledger has no corresponding '
      + 'entry. The books are missing a transaction the payment systems agree happened.',
    suggestedAction:
      'Post the missing entry to the ledger, or find out why it was never recorded.',
  },
  MISSING_IN_GATEWAY: {
    explanationText:
      'A bank credit or a ledger entry exists for this amount, but there is no gateway record '
      + 'behind it. Money or a booking has appeared with no payment the gateway processed.',
    suggestedAction:
      'Trace the credit back to its origin — it may be a manual transfer, a refund reversal, or a fee adjustment.',
  },
  AMOUNT_MISMATCH: {
    explanationText:
      'The records clearly refer to the same payment — their reference numbers agree — but the '
      + 'amounts do not match by more than rounding or a known fee would explain. One side is '
      + 'recording a different figure from the other.',
    suggestedAction:
      'Check for a partial capture, a post-authorization adjustment, or a fee that was applied on only one side.',
  },
  UNSPLITTABLE_BATCH: {
    explanationText:
      'A single bank settlement credit looks like it bundles several gateway payments, but no '
      + 'combination of the outstanding payments adds up to it within tolerance, and no breakup '
      + 'file was provided. The engine cannot say which payments it covers.',
    suggestedAction:
      'Ask the acquirer for the settlement breakup file so the credit can be split against individual payments.',
  },
  TIMING_DRIFT: {
    explanationText:
      'The records match on identity and on amount; only the dates disagree, and by more than '
      + 'the normal settlement lag. This is usually a processing delay rather than a money problem.',
    suggestedAction:
      'Confirm the settlement date against the bank file and clear the exception if the delay is expected.',
  },
};

/** Total by construction — an unknown category falls to the generic floor. */
export function templateFor(category: ExceptionCategory): TemplateText {
  return TEMPLATES[category] ?? EXPLANATION_FALLBACK_TEMPLATE;
}

/**
 * `prompt_version` (schema.md §10.2). Hashed into every signature, so bumping it
 * re-resolves the whole cache. Bump on ANY change to `SYSTEM_PROMPT` or to the
 * category definition table below.
 */
export const PROMPT_VERSION = DEFAULT_PROMPT_VERSION;

/**
 * The static system prompt (schema.md §10.4), sent once per batch. Not assumed
 * to be discounted by prompt caching — the economy is signature collapse, not a
 * cacheable prefix (ADR-080 consequence 4).
 */
export const SYSTEM_PROMPT = [
  'You are the explanation layer of a payment reconciliation engine. A deterministic rule '
  + 'engine has already decided that a record could not be reconciled and has already assigned '
  + 'its exception category. Your only job is to explain that decision in plain English to a '
  + 'finance operations analyst.',
  '',
  'Rules you must follow:',
  '1. Never dispute, revise, or second-guess the category you are given. It is already final.',
  '2. Never invent amounts, dates, merchant names, or reference numbers. You will be given '
  + 'ranges and structural facts, never specifics — write at that level of generality.',
  '3. Write for a finance analyst, not an engineer. No jargon, no rule IDs, no confidence scores.',
  '4. Two to three sentences maximum for the explanation. One sentence for the suggested action.',
  '5. The suggested action must be something a human can actually do. If the record is genuinely '
  + 'unresolvable from the data available, say so plainly instead of inventing a next step.',
  '6. Respond only with the specified JSON. No preamble.',
  '',
  'Category definitions:',
  '- DUPLICATE_RECORD: two or more rows in the same source represent one economic event.',
  '- AMBIGUOUS_MATCH: two or more candidates in the target source scored high and within a '
  + 'hair of each other; the engine refused to choose.',
  '- MISSING_IN_BANK: a captured gateway payment is past its settlement window with no bank '
  + 'credit at any score.',
  '- MISSING_IN_LEDGER: a gateway and/or bank record has no merchant-ledger counterpart.',
  '- MISSING_IN_GATEWAY: a bank credit or ledger entry has no gateway counterpart.',
  '- AMOUNT_MISMATCH: identity is established (a strong reference agrees) but the amounts '
  + 'differ beyond rounding and known fees.',
  '- UNSPLITTABLE_BATCH: a bank settlement credit plausibly nets several gateway payments, but '
  + 'no subset sums to it within tolerance and no breakup file exists.',
  '- TIMING_DRIFT: identity and amount both agree; only the date sits outside the expected window.',
].join('\n');
