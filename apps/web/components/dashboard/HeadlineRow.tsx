import { Figure } from '@/components/ui/Figure';
import { count, humanizeCategory, pct, ratio4 } from '@/lib/format';
import type { EngineMetrics, MeasuredMetrics } from '@/types/api';
import styles from './HeadlineRow.module.css';

/**
 * ui-spec §2 block 1 — four figures, one row, equal visual weight.
 *
 * FALSE POSITIVES SITS SECOND, NOT LAST, and that ordering is the argument.
 * A 65% match rate with zero wrong matches is a better result than 78% with
 * five, and a viewer must not be able to take the first number without meeting
 * the second. ADR-020 enforces that at the API — endpoint 5 returns both
 * objects or neither — and this row is where the same rule is enforced in
 * pixels. Splitting these across tabs would let a sceptic leave with the
 * flattering half.
 *
 * TWO OF THE FOUR ARE MEASURED, TWO ARE SELF-REPORTED, and they are coloured
 * accordingly. The match rate is the engine's account of itself; the false
 * positives and the ceiling are scored against an answer key that existed
 * before the engine ran. That is not a detail to be explained in a footnote —
 * it is the whole reason the first number is worth anything.
 */
export function HeadlineRow({
  engine, measured, measuredAgainst,
}: {
  engine: EngineMetrics;
  measured: MeasuredMetrics | null;
  measuredAgainst: string | null;
}) {
  const { matchRate, coldStart } = engine;
  const atRisk = engine.exceptions.amountAtRisk;

  /**
   * NEVER NAME A CLI COMMAND HERE. This read "run `npm run score` to produce
   * one", which is an instruction the only people who see this screen cannot
   * follow — and it makes a deliberate architectural boundary look like an
   * unfinished feature.
   *
   * The boundary is ADR-021: no module under `apps/api` may read the answer
   * key, so the application structurally CANNOT measure itself, and a
   * measurement arrives from an offline pass through endpoint 23. That is the
   * reason the accuracy figures are worth believing, so the absence says it
   * rather than apologising for it.
   */
  const noScoreReport =
    'Not measured yet — no score report has been posted for this run.';
  const whyUnmeasured =
    'The engine is never given the answer key, so it cannot mark its own work. Accuracy is '
    + 'measured by a separate offline pass and posted back, which is why this is absent rather '
    + 'than estimated.';

  return (
    <div className={styles.row}>
      <Figure
        size="hero"
        label="Match Rate"
        provenance="engine"
        value={pct(matchRate.matchRatePct)}
        note={
          <>
            {count(matchRate.matchedRecords)} matched · {count(matchRate.reconcilableRecords)}{' '}
            records counted{' '}
            <span className={styles.subtle}>
              · {count(matchRate.pendingReviewExcluded)} awaiting review, excluded
            </span>
          </>
        }
        basis={{ summary: 'Denominator', body: matchRate.denominatorNote }}
      />

      {measured ? (
        /*
         * THE ENGINE'S OWN FIGURE, NOT THE SYSTEM'S (ADR-119).
         *
         * `matching` counts a human-approved proposal as an engine true
         * positive, so it RISES every time somebody clicks Approve — run
         * `verify` moved from recall 0.6075 to 0.6941 on 22 approvals, with a
         * byte-identical scorer and no code change. A tile that showed that
         * without saying so would credit the engine with a person's work,
         * which is the exact failure ADR-020's cold/warm rule exists to stop.
         *
         * So the number rendered is `matchingEngineOnly`, which cannot move
         * after the run finishes, and the human contribution is disclosed
         * rather than folded in. `null` on the two reports written before
         * scorer 1.4.0 — a real absence, so it falls back and says so.
         */
        <Figure
          size="hero"
          label="False Positives"
          provenance="measured"
          value={count((measured.matchingEngineOnly ?? measured.matching).falsePositives)}
          unit="wrong matches"
          note={
            <>
              Precision {ratio4((measured.matchingEngineOnly ?? measured.matching).precision)} over{' '}
              {count((measured.matchingEngineOnly ?? measured.matching).truePositives)} pairs the
              engine confirmed on its own
            </>
          }
          basis={{
            summary: 'What was compared',
            body:
              `Every pair the engine confirmed was looked up in ${measuredAgainst ?? 'the answer key'}, `
              + `which was generated before the engine ran and is never read by the API (ADR-021). `
              + `${count(measured.matching.excludedExceptionEventPairs)} pairs were excluded from both `
              + `sides because their economic event is itself an exception (ADR-072), and `
              + `${count((measured.matchingEngineOnly ?? measured.matching).pendingPairs)} `
              + `proposed-but-unconfirmed pairs are scored separately as review-queue precision `
              + `rather than counted here. `
              + (measured.matchingEngineOnly === null
                ? 'This report predates the engine-alone figure, so it counts human approvals '
                  + 'toward the engine. Re-score the run to separate them.'
                : measured.humanReview !== null
                  && (measured.humanReview.confirmedGroups > 0 || measured.humanReview.rejectedGroups > 0)
                  ? `A reviewer has since approved ${count(measured.humanReview.confirmedGroups)} and `
                    + `rejected ${count(measured.humanReview.rejectedGroups)} of the engine's `
                    + `proposals. Counting those too, precision is `
                    + `${ratio4(measured.matching.precision)} over `
                    + `${count(measured.matching.truePositives)} pairs and recall is `
                    + `${measured.humanReview.recallDelta} higher. Both figures ship; the tile shows `
                    + 'the engine alone, because that is the one that cannot change afterwards.'
                  : 'Nobody has reviewed a proposal on this run, so the engine-alone and '
                    + 'with-review figures happen to be identical.'),
          }}
        />
      ) : (
        <Figure
          size="hero"
          label="False Positives"
          provenance="absent"
          absentReason={noScoreReport}
          note={whyUnmeasured}
        />
      )}

      {/*
        ON A WARM RUN THIS FIGURE DOES NOT EXIST, and drawing the warm number
        here is exactly what ADR-020 forbids. It used to do precisely that:
        `run-metrics` computed cold start with the SAME expression as the warm
        rate, so a run with a learned alias active reported the alias's benefit
        under the label that exists to exclude it (ADR-130).
      */}
      {coldStart.matchRatePct === null ? (
        <Figure
          size="hero"
          label="Without Learned Rules"
          provenance="absent"
          absentReason={
            `Not computed. ${count(coldStart.aliasesActiveAtStart)} learned `
            + `${coldStart.aliasesActiveAtStart === 1 ? 'rule was' : 'rules were'} active when this `
            + 'run began, and what it would have matched without them needs a second pass the '
            + 'engine does not make.'}
          note="The warm figure is never shown here in its place."
        />
      ) : (
        <Figure
          size="hero"
          label="Without Learned Rules"
          provenance="engine"
          value={pct(coldStart.matchRatePct)}
          note={coldStart.isCold
            ? 'No learned rules were active — this run is its own cold start'
            : `Computed by running the engine again with all `
              + `${count(coldStart.aliasesActiveAtStart)} learned `
              + `${coldStart.aliasesActiveAtStart === 1 ? 'rule' : 'rules'} disabled`}
          basis={{
            summary: 'Cold and warm, always together',
            body:
              'A warm run reuses corrections a human taught the system earlier, so it will always '
              + 'score at least as well as a cold one. Reporting only the warm figure would credit '
              + 'the engine for work a person did (ADR-020). On a warm run this figure is not an '
              + 'estimate: the engine matches the same records a second time with the alias set '
              + 'empty, because an alias changes blocking and candidate generation as well as '
              + 'scoring — so subtracting alias-touched records would give a bound, not an answer.',
          }}
        />
      )}

      {/*
        "CEILING" IS THE FIELD'S NAME, NOT A LABEL A READER CAN USE. It named
        the concept for whoever already knew it, which on this screen is nobody:
        a panelist has under a minute and no glossary. "Best Possible" says the
        same thing in words that need no prior sentence, and the unit fixes it
        to this dataset so it cannot be read as a claim about the engine.
        The field, the ADRs and the disclosure keep the term (ADR-135).
      */}
      {measured ? (
        <Figure
          size="hero"
          label="Best Possible"
          provenance="measured"
          value={pct(measured.ceiling.theoreticalMaxMatchRatePct)}
          unit="on this dataset"
          note={
            <>
              {count(measured.resolvability.unresolvableDesigned)} events are unresolvable by
              construction
              {measured.ceiling.headroomPct !== null && (
                <> · {measured.ceiling.headroomPct.toFixed(2)} points below it</>
              )}
            </>
          }
          basis={{
            summary: 'Why the maximum is below 100%',
            body:
              'The dataset deliberately contains payments that cannot be reconciled from the three '
              + 'sources alone — a netted batch credit with no breakup file, an identity destroyed '
              + 'across every key. The ceiling is computed from the realized data, not assumed, and '
              + 'it is shown beside the match rate because a rate without its maximum is not a '
              + 'score, it is just a number.',
          }}
        />
      ) : (
        <Figure
          size="hero"
          label="Best Possible"
          provenance="absent"
          absentReason={noScoreReport}
          note="The maximum is computed from the answer key, so it arrives with the measurement."
        />
      )}

      {/*
        THIS IS THE AI FINANCE CONTROLLER TRACK, AND THE FIRST QUESTION IS
        "HOW MUCH IS UNACCOUNTED FOR?" (ADR-164). The four figures to the left
        are about the ENGINE — how much it matched, how wrong, how it would do
        cold, how well it could do. This one is about the MONEY, which is the
        thing the audience actually manages.

        `provenance="engine"`: it is the engine's own sum of `amountAtRisk` over
        every exception it raised — added up in S14 over the WHOLE population,
        because endpoint 6 paginates at 200 and a component adding up its page
        would under-report the exposure. It is not scored against anything, so
        it never wears the measured accent.

        Absent, not zero, on a run whose metrics predate the block.
      */}
      {atRisk ? (
        <Figure
          size="hero"
          label="Money at Risk"
          provenance="engine"
          value={atRisk.totalDisplay}
          note={
            <>
              across {count(engine.exceptions.total)} exceptions ·{' '}
              {atRisk.highSeverityDisplay} in {count(atRisk.highSeverityCount)} high-severity
            </>
          }
          basis={{
            summary: 'What “at risk” is the sum of',
            body:
              `The money-at-risk figure on every exception, added together over all `
              + `${count(engine.exceptions.total)} of them — a value discrepancy contributes the `
              + `discrepancy, a missing or unsplittable record contributes the amount in question. `
              + `The sum is computed server-side over the whole run, not the paginated list, so it `
              + `does not change as you page through the exceptions. The single largest line is `
              + `${atRisk.largestSingle ? `${atRisk.largestSingle.amountDisplay} `
                + `(${humanizeCategory(atRisk.largestSingle.category)})` : 'not available'}`
              + `${atRisk.withoutAmount > 0
                ? `. ${count(atRisk.withoutAmount)} group-level exceptions carry no single figure `
                  + `and are not counted here.`
                : '.'}`,
          }}
        />
      ) : (
        <Figure
          size="hero"
          label="Money at Risk"
          provenance="absent"
          absentReason="Not totalled for this run — its metrics were written before money at risk was summed."
          note="It is the engine’s own sum over the exception list, added when the run finalises."
        />
      )}
    </div>
  );
}
