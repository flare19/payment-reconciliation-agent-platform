/**
 * THE BOOKS BALANCE — a reconciliation of the reconciler.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS EXISTS BECAUSE THE DASHBOARD'S OWN NUMBERS LOOK LIKE THEY DO NOT ADD UP.
 *
 * A reader sees "573 matched", "216 awaiting review" and "212 exceptions",
 * adds them, gets 1001 against a population of 874, and concludes the engine is
 * double-counting. It is not: the populations legitimately overlap, because a
 * gateway↔bank pair that matched but has no ledger entry is genuinely BOTH a
 * match and a MISSING_IN_LEDGER finding. A list that hid those would understate
 * the problem.
 *
 * But "trust us, it reconciles" is exactly the sentence this project exists not
 * to write. So the arithmetic is published, recomputed from base rows on every
 * request, and expressed as identities that CAN FAIL — the same stance as
 * `/audit/verify`, which is valuable precisely because it is able to say false.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── THE FIVE CHECKS, AND WHICH ONE MATTERS MOST ──
 * C1 DENOMINATOR    ingested − excluded − duplicates = reconcilable
 * C2 DISPOSITION    matched + inReviewQueue + neither = reconcilable
 * C3 NO ORPHANS     every reconcilable record the engine neither matched nor
 *                   proposed appears on the exception list
 * C4 EXCEPTIONS     the four disjoint classes of exception record sum to the total
 * C5 HEADLINE       the recomputed figures equal what `runs.metrics` published
 *
 * **C3 is the honesty claim and the reason to build this.** C1, C2 and C4 are
 * arithmetic — satisfying but mechanical. C3 is a statement about conduct:
 * nothing fell off the books. Every record is matched, proposed, or explained,
 * and none was silently dropped. That is the property a finance controller
 * actually needs and the one an engine can most easily violate without anyone
 * noticing, because a dropped record makes every other number look BETTER.
 *
 * C5 is what makes the rest load-bearing. Without it this panel would be a
 * second opinion nobody asked for; with it, the headline at the top of the
 * dashboard is proven to be what these base rows produce.
 */

import type { ReconciliationCounts } from '../../repositories/reconciliation.js';

/** One identity, with both sides shown so a reader can check the claim themselves. */
export interface BalanceCheck {
  id: 'DENOMINATOR' | 'DISPOSITION' | 'NO_ORPHANS' | 'EXCEPTIONS' | 'HEADLINE';
  /** The identity in words, with the actual numbers substituted. */
  expression: string;
  left: number;
  right: number;
  holds: boolean;
  /** `left − right`. Zero when it holds; the size of the problem when it does not. */
  delta: number;
  /** What a reader should conclude — stated for the failing case too. */
  note: string;
}

export interface ReconciliationReport {
  balanced: boolean;
  checks: BalanceCheck[];
  population: {
    ingested: number;
    excluded: number;
    nonPrimaryDuplicates: number;
    reconcilable: number;
  };
  disposition: {
    matched: number;
    /** Split so the panel can show what a human added, rather than blur it in. */
    matchedByEngine: number;
    matchedByHuman: number;
    inReviewQueue: number;
    neither: number;
  };
  exceptionBreakdown: {
    total: number;
    inConfirmedMatch: number;
    inReviewQueue: number;
    pure: number;
    outsideDenominator: number;
  };
  /** Exception ROWS vs RECORDS. Equal unless a record ever carries two rows. */
  exceptionRows: number;
}

/** What the engine published about itself, for C5. */
export interface PublishedHeadline {
  reconcilable: number | null;
  matched: number | null;
  exceptions: number | null;
}

const check = (
  id: BalanceCheck['id'], expression: string,
  left: number, right: number, note: string,
): BalanceCheck => ({
  id, expression, left, right,
  holds: left === right,
  delta: left - right,
  note,
});

/**
 * Build the report. PURE — every input is already in memory, so a test can hand
 * it a deliberately unbalanced population and watch each identity fail
 * individually. A check nobody has watched fail is indistinguishable from one
 * that cannot fire (CLAUDE.md §9), and that applies with particular force to a
 * check whose entire value is its ability to say no.
 */
export function buildReconciliationReport(
  c: ReconciliationCounts, published: PublishedHeadline,
): ReconciliationReport {
  const checks: BalanceCheck[] = [
    check('DENOMINATOR',
      `${c.ingested} ingested − ${c.excluded} excluded − ${c.nonPrimaryDuplicates} duplicates = ${c.reconcilable} reconcilable`,
      c.ingested - c.excluded - c.nonPrimaryDuplicates, c.reconcilable,
      'Both sides are counted independently off the rows, so this can disagree. '
      + 'The denominator is the number every rate on this page divides by.'),

    check('DISPOSITION',
      `${c.matched} matched + ${c.inReviewQueue} in review + ${c.neither} neither = ${c.reconcilable} reconcilable`,
      c.matched + c.inReviewQueue + c.neither, c.reconcilable,
      'Every reconcilable record is in exactly one of three states. A proposal is '
      + 'held out of the match rate rather than counted toward it (ADR-040).'),

    check('NO_ORPHANS',
      `${c.neither} unresolved records ≡ ${c.neitherCovered} named on the exception list`,
      c.neither, c.neitherCovered,
      'The one that is not arithmetic. Every record the engine could neither match '
      + 'nor propose is named on the exception list — nothing was silently dropped. '
      + 'A dropped record would make every other number on this page look better.'),

    check('EXCEPTIONS',
      `${c.exceptionsInConfirmedMatch} in a confirmed group + ${c.exceptionsInReviewQueue} in a proposal `
      + `+ ${c.exceptionsPure} unresolved + ${c.exceptionsOutsideDenominator} collapsed duplicates = ${c.exceptionRecords} exceptions`,
      c.exceptionsInConfirmedMatch + c.exceptionsInReviewQueue
        + c.exceptionsPure + c.exceptionsOutsideDenominator,
      c.exceptionRecords,
      'Why the exception count is larger than the unresolved count: a group missing '
      + 'its third leg is both a match and a finding. The classes are disjoint and cover the list.'),
  ];

  // C5 is skipped rather than failed when the run published nothing to compare
  // against — an in-flight or failed run has no headline, and calling that a
  // broken identity would cry wolf. Absence is not disagreement.
  const p = published;
  if (p.reconcilable !== null && p.matched !== null && p.exceptions !== null) {
    /**
     * COMPARED AGAINST THE ENGINE'S OWN COLUMN, NOT THE LIVE TOTAL.
     *
     * `runs.metrics` is written once by S14 and never recomputed, so it knows
     * only what the engine confirmed by itself. `matched` keeps moving as
     * reviewers approve proposals. Comparing the frozen figure against the
     * moving one made this identity fail on every run where a human had done
     * their job — on one real run, 24 approvals turned a correct 570 into a
     * "mismatched" 640. A check that fires on the workflow the product is built
     * around is not a check, it is an alarm nobody will keep listening to.
     *
     * So the comparison is like-for-like, and the human contribution is
     * REPORTED beside it rather than silently folded in or silently dropped.
     */
    const agree = p.reconcilable === c.reconcilable
      && p.matched === c.matchedByEngine
      && p.exceptions === c.exceptionRows;
    const human = c.matchedByHuman > 0
      ? ` (+${c.matchedByHuman} later confirmed by a human, correctly not in the engine's own figure)`
      : '';
    checks.push({
      id: 'HEADLINE',
      expression: `published ${p.matched}/${p.reconcilable}/${p.exceptions} `
        + `= recomputed ${c.matchedByEngine}/${c.reconcilable}/${c.exceptionRows}${human}`,
      left: agree ? 1 : 0,
      right: 1,
      holds: agree,
      delta: agree ? 0 : 1,
      note: 'The headline figures at the top of this page, recomputed from the rows '
        + 'beneath them. Engine-alone on both sides: the published figure is frozen at '
        + 'S14, so a reviewer’s later approval belongs beside it, not inside it '
        + '(ADR-119). This is the check that makes the other four load-bearing.',
    });
  }

  return {
    balanced: checks.every((k) => k.holds),
    checks,
    population: {
      ingested: c.ingested,
      excluded: c.excluded,
      nonPrimaryDuplicates: c.nonPrimaryDuplicates,
      reconcilable: c.reconcilable,
    },
    disposition: {
      matched: c.matched,
      matchedByEngine: c.matchedByEngine,
      matchedByHuman: c.matchedByHuman,
      inReviewQueue: c.inReviewQueue,
      neither: c.neither,
    },
    exceptionBreakdown: {
      total: c.exceptionRecords,
      inConfirmedMatch: c.exceptionsInConfirmedMatch,
      inReviewQueue: c.exceptionsInReviewQueue,
      pure: c.exceptionsPure,
      outsideDenominator: c.exceptionsOutsideDenominator,
    },
    exceptionRows: c.exceptionRows,
  };
}
