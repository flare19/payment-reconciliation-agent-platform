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
        <Figure
          size="hero"
          label="False Positives"
          provenance="measured"
          value={count(measured.matching.falsePositives)}
          unit="wrong matches"
          note={
            <>
              Precision {ratio4(measured.matching.precision)} over{' '}
              {count(measured.matching.truePositives)} confirmed pairs
            </>
          }
          basis={{
            summary: 'What was compared',
            body:
              `Every pair the engine confirmed was looked up in ${measuredAgainst ?? 'the answer key'}, `
              + `which was generated before the engine ran and is never read by the API (ADR-021). `
              + `${count(measured.matching.excludedExceptionEventPairs)} pairs were excluded from both `
              + `sides because their economic event is itself an exception (ADR-072), and `
              + `${count(measured.matching.pendingPairs)} proposed-but-unconfirmed pairs are scored `
              + `separately as review-queue precision rather than counted here.`,
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

      <Figure
        size="hero"
        label="Cold Start"
        provenance="engine"
        value={pct(coldStart.matchRatePct)}
        note={
          coldStart.isCold
            ? `No learned aliases — ${count(coldStart.aliasesActiveAtStart)} active when the run began`
            : `${count(coldStart.aliasesActiveAtStart)} learned aliases were active when the run began`
        }
        basis={{
          summary: 'Cold and warm, always together',
          body:
            'A warm run reuses aliases a human taught the system on an earlier run, so it will '
            + 'always score at least as well as a cold one. Reporting only the warm figure would '
            + 'credit the engine for corrections a person made (ADR-020), so both are always shown '
            + 'and always labelled — here they are equal because this run is cold.',
        }}
      />

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
