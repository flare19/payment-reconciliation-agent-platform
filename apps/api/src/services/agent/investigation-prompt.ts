/**
 * The opening user message for one investigation (agent-design.md §3). U13.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE ENGINE'S OWN REASONING IS THE PROMPT.
 *
 * §3: the agent is given "the exception, its evidence, the engine's rejection
 * reasons". That is not framing — it is the mechanism that stops the Analyst
 * re-deriving a conclusion the engine already reached and recorded. An agent
 * handed only "this exception is unmatched" spends its first three steps
 * rediscovering what `evidence.candidates[].rejectedBecause` already says.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── SPECIFICS ARE PRESENT HERE, AND THAT IS THE OPPOSITE OF S13 ──
 * The explain layer sends ONLY bucketed signatures — no amounts, no ids — so any
 * specific in its output is necessarily fabricated (#52). Phase A is different
 * BY DESIGN: the agent must reason over real records, so real ids and amounts go
 * in. The protection is not withholding data, it is A3: every id the agent
 * CITES must have come back from a tool call it actually made. An id that
 * appears only in this prompt and never in a tool result is not citable, which
 * is why the prompt states what it is showing and tells the agent to retrieve
 * anything it intends to lean on.
 *
 * That distinction is also the ADR-080 consequence-3 line: the free tier's
 * "content improves Google's products" caveat is acceptable for S13 by
 * construction and acceptable for Phase A only because this dataset is
 * synthetic. On real money, Phase A needs a paid tier.
 */

import { formatPaise } from '../ingestion/money.js';
import type { ExceptionRecord } from '../../repositories/exceptions.js';
import type { NormalizedTransaction } from '../../types/engine.js';

/** The engine facts one investigation starts from. */
export interface InvestigationContext {
  exception: ExceptionRecord;
  /** The exception's own record, when it has one (group-level ones do not). */
  subject: NormalizedTransaction | null;
  /** What the engine recorded about this exception, in its own words. */
  engineTrail: { eventType: string; reason: string }[];
}

function line(label: string, value: unknown): string {
  return `  ${label}: ${String(value)}`;
}

/**
 * Build the opening message.
 *
 * Deliberately a FACT SHEET rather than a narrative. Prose invites the model to
 * continue the prose; a labelled list of what the engine found invites it to go
 * and check something. The closing instruction names the specific question the
 * investigation exists to answer, which differs per category — a
 * `UNSPLITTABLE_BATCH` and a `MISSING_IN_LEDGER` are not the same job and a
 * single generic "investigate this" prompt gets a single generic investigation.
 */
export function buildInvestigationPrompt(ctx: InvestigationContext): string {
  const e = ctx.exception;
  const ev = e.evidence;
  const parts: string[] = [];

  parts.push(`EXCEPTION ${e.id}`);
  parts.push(line('category', e.category));
  parts.push(line('severity', e.severity));
  if (e.secondaryFlags.length > 0) {
    parts.push(line('also flagged', e.secondaryFlags.join(', ')));
  }
  parts.push(line('raised by rule', `${e.detectedByRule} (v${e.ruleVersion})`));
  if (e.amountAtRiskPaise !== null) {
    parts.push(line('amount at risk', formatPaise(e.amountAtRiskPaise)));
  }

  if (ctx.subject !== null) {
    const s = ctx.subject;
    parts.push('', 'THE RECORD');
    parts.push(line('transactionId', s.id));
    parts.push(line('source', `${s.sourceSystem} row ${s.sourceRowNumber}`));
    parts.push(line('amount', `${formatPaise(s.amountPaise)} (${s.direction})`));
    parts.push(line('date', s.txnDate));
    parts.push(line('counterparty', s.counterpartyNorm ?? '(none)'));
    parts.push(line('references', JSON.stringify(s.referenceIds)));
    parts.push(line('anchor strength', s.anchorStrength));
  } else {
    parts.push('', 'THIS IS A GROUP-LEVEL EXCEPTION with no single record.');
  }

  // ── What the engine TRIED. The most valuable part of the prompt. ──
  parts.push('', 'WHAT THE ENGINE ALREADY TRIED');
  parts.push(line('candidates considered', ev.candidatesConsidered));
  if (ev.candidates.length > 0) {
    parts.push('  candidates it scored and rejected:');
    for (const c of ev.candidates) {
      parts.push(`    - ${c.transactionId} (${c.sourceSystem}, score ${c.score}): `
        + `${c.rejectedBecause}`);
    }
  } else {
    parts.push('  it found no candidate worth scoring');
  }
  parts.push(line('anchor strength seen', ev.anchorStrength));
  parts.push(line('windows used', JSON.stringify(ev.windowUsed)));
  if (ev.candidateCapHit) {
    parts.push('  NOTE: the candidate cap bound — the search was truncated.');
  }
  if (ev.searchExhausted === true) {
    parts.push('  NOTE: the batch search was EXHAUSTIVE. The engine proved no '
      + 'combination works within its declared bounds.');
  }
  if (ev.searchBoundExceeded != null) {
    parts.push(`  NOTE: the batch search hit its ${ev.searchBoundExceeded.bound} bound `
      + `at ${ev.searchBoundExceeded.value}. This is NOT a proof that no answer exists — `
      + 'the engine ran out of room. rerun_subset_search can widen it.');
  }
  if (ev.displacedByMatchId != null) {
    parts.push(`  NOTE: this record's counterpart went to a stronger claim `
      + `(match ${ev.displacedByMatchId}).`);
  }
  if (ev.counterpartStatus != null) {
    parts.push(line('counterpart status', ev.counterpartStatus));
  }

  if (ctx.engineTrail.length > 0) {
    parts.push('', 'THE ENGINE\'S OWN LOG FOR THIS EXCEPTION');
    for (const t of ctx.engineTrail) parts.push(`  [${t.eventType}] ${t.reason}`);
  }

  parts.push('', ASK[e.category] ?? ASK_DEFAULT);
  parts.push('',
    'The ids above are context, not evidence. Retrieve anything you intend to cite: a '
    + 'citation is only valid if a tool returned it to you during THIS investigation.');
  return parts.join('\n');
}

const ASK_DEFAULT =
  'YOUR JOB: determine whether this exception can be resolved from the data available, '
  + 'and say so honestly. Agreeing with the engine — with a stated reason — is a real '
  + 'and valuable answer.';

/**
 * The question each category actually poses.
 *
 * Written per category because they are different jobs. §11's degradation order
 * names `AMBIGUOUS_MATCH` and `UNSPLITTABLE_BATCH` as the must-ship pair, and
 * they are the two with the sharpest questions — which is not a coincidence:
 * they are the ones where the engine's refusal is most informative.
 */
const ASK: Record<string, string> = {
  UNSPLITTABLE_BATCH:
    'YOUR JOB: the engine could not split this settlement credit into the payments that net '
    + 'to it. First establish WHICH claim it is making — a proof that no combination exists, '
    + 'or an admission that it ran out of search room. If it ran out, widen the search with '
    + 'rerun_subset_search and see whether a decomposition appears. Both outcomes are wins: a '
    + 'decomposition is a proposal, and a failure at wider bounds upgrades the engine\'s '
    + 'weakest claim into its strongest.',
  AMBIGUOUS_MATCH:
    'YOUR JOB: the engine found two or more candidates it could not choose between, and '
    + 'refusing to guess was correct. Look for evidence the SCORER DOES NOT USE — a shared '
    + 'reference in the raw payload that normalization dropped, or an audit trail that '
    + 'explains the tie. If nothing separates them, say so: confirming a genuine tie is more '
    + 'useful than breaking it on a hunch.',
  AMOUNT_MISMATCH:
    'YOUR JOB: identity is established but the amounts disagree. Determine whether the gap is '
    + 'explained by a fee, a partial capture, or an adjustment visible in the records — or '
    + 'whether it needs a document this system does not have.',
  MISSING_IN_BANK:
    'YOUR JOB: a captured payment has no bank settlement past its window. Check whether the '
    + 'credit exists under a different reference, inside a batch, or not at all.',
  MISSING_IN_LEDGER:
    'YOUR JOB: the payment systems agree this happened but the ledger has no entry. Check '
    + 'whether an entry exists under a different reference or counterparty spelling before '
    + 'concluding it is genuinely absent.',
  MISSING_IN_GATEWAY:
    'YOUR JOB: money or a booking exists with no gateway record behind it. Determine what it '
    + 'is — a manual transfer, a refund reversal, a fee — or whether it needs external data.',
};
