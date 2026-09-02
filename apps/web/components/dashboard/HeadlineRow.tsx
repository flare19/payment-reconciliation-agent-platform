import { Figure } from '@/components/ui/Figure';
import { count, pct, ratio4 } from '@/lib/format';
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

  const noScoreReport =
    'Not measured against ground truth. No score report exists for this run — '
    + 'run `npm run score` to produce one.';

  return (
    <div className={styles.row}>
      <Figure
        size="hero"
        label="Match Rate"
        provenance="engine"
        value={pct(matchRate.matchRatePct)}
        note={
          <>
            {count(matchRate.matchedRecords)} of {count(matchRate.reconcilableRecords)} reconcilable
            records{' '}
            <span className={styles.subtle}>
              · {count(matchRate.pendingReviewExcluded)} pending review, excluded
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
          note="The engine’s own figure is deliberately not substituted here."
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

      {measured ? (
        <Figure
          size="hero"
          label="Ceiling"
          provenance="measured"
          value={pct(measured.ceiling.theoreticalMaxMatchRatePct)}
          unit="maximum"
          note={
            <>
              {count(measured.resolvability.unresolvableDesigned)} events are unresolvable by
              construction
              {measured.ceiling.headroomPct !== null && (
                <> · {measured.ceiling.headroomPct.toFixed(2)} points of headroom</>
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
          label="Ceiling"
          provenance="absent"
          absentReason={noScoreReport}
          note="The ceiling is computed from the answer key, so it arrives with the measurement."
        />
      )}
    </div>
  );
}
