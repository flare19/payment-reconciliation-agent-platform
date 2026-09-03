import { ratio4 } from '@/lib/format';
import styles from './CategoryAccuracy.module.css';

/**
 * Measured multi-label precision and recall for one exception category
 * (queue item 2, ADR-041, ADR-020's discipline applied to classification).
 *
 * The exception list looks equally confident about every category. The scorer
 * knows it should not be: on the holdout MISSING_IN_GATEWAY is P 0.2857 — the
 * engine over-raises it — and UNSPLITTABLE_BATCH is R 0.5000. The one place
 * that fact belongs is next to the category name.
 *
 * The figure is `provenance="measured"`: it comes from `score_reports`, scored
 * offline against a key the API never reads (ADR-041). Two absences are drawn
 * as absences, never as a zero:
 *
 *   · no score report on the run at all  → "accuracy not measured"
 *   · a report exists but this category has no true events in the key, so
 *     precision/recall are undefined for it → "not scored for this category"
 *
 * Substituting `0.0000` for either of those is the exact failure this project
 * is built to prevent — it would read as "the engine is wrong about every one",
 * when the truth is "nobody measured this".
 */
export function CategoryAccuracy({
  pr,
  hasReport,
}: {
  pr: { precision: number; recall: number } | null | undefined;
  hasReport: boolean;
}) {
  if (!hasReport) {
    return (
      <span
        className={styles.absent}
        data-provenance="absent"
        title="No score report has been posted for this run, so category accuracy is not measured. It is never filled in from the engine's own counts."
      >
        accuracy not measured
      </span>
    );
  }

  if (!pr) {
    return (
      <span
        className={styles.absent}
        data-provenance="absent"
        title="The answer key holds no true events of this category on this run, so precision and recall are undefined for it."
      >
        not scored for this category
      </span>
    );
  }

  // Precision below this reads as "the engine over-raises this category" and is
  // the whole reason the figure is on the page — flag it rather than let it sit
  // in a row of identical-looking numbers.
  const overRaised = pr.precision < 0.75;

  return (
    <span
      className={`${styles.pr} ${overRaised ? styles.weak : ''}`}
      data-provenance="measured"
      title={
        `Measured against the answer key: precision ${ratio4(pr.precision)}, `
        + `recall ${ratio4(pr.recall)}. Precision is the share of records the engine put in `
        + `this category that belong there; recall is the share of records that belong here `
        + `that it found. Neither is computed by the engine (ADR-041).`
      }
    >
      <span className={styles.tag} aria-hidden="true">measured</span>
      <span className={styles.metric}>P&nbsp;{ratio4(pr.precision)}</span>
      <span className={styles.sep} aria-hidden="true">·</span>
      <span className={styles.metric}>R&nbsp;{ratio4(pr.recall)}</span>
    </span>
  );
}
