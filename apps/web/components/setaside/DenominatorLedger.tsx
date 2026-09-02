import { count } from '@/lib/format';
import type { PopulationResponse } from '@/types/api';
import styles from './DenominatorLedger.module.css';

/**
 * The match rate's denominator, shown as the arithmetic it actually is.
 *
 * This exists because the dashboard's `874 of 920` invited exactly one
 * question — *did we lose rows?* — and the frontend had no way to answer it.
 * The answer is a four-line subtraction, and a subtraction is far more
 * convincing shown than described.
 *
 * THE `0 FAILED TO PARSE` LINE IS THE POINT, and it renders even at zero —
 * especially at zero. It is the only place in the product that says ingestion
 * was lossless, and an absent line would leave "rejected" as something a reader
 * has to take on trust.
 */
export function DenominatorLedger({ counts }: { counts: PopulationResponse['counts'] }) {
  const attempted = counts.reconcilable + counts.excluded + counts.rejected + counts.duplicates;
  const parsed = attempted - counts.rejected;

  return (
    <table className={styles.ledger}>
      <caption className="sr-only">
        How the counted-record total is derived from the rows attempted
      </caption>
      <tbody>
        <tr className={styles.total}>
          <td className={`${styles.n} num`}>{count(attempted)}</td>
          <th scope="row" className={styles.what}>Rows in the three files</th>
        </tr>

        <tr className={counts.rejected === 0 ? styles.good : styles.bad}>
          <td className={`${styles.n} num`}>&minus;{count(counts.rejected)}</td>
          <th scope="row" className={styles.what}>
            Failed to parse
            <span className={styles.why}>
              {counts.rejected === 0
                ? 'Nothing was lost reading the files. Every row was understood.'
                : 'Rows the parser could not read. These are listed below.'}
            </span>
          </th>
        </tr>

        <tr className={styles.subtotal}>
          <td className={`${styles.n} num`}>{count(parsed)}</td>
          <th scope="row" className={styles.what}>Read successfully</th>
        </tr>

        <tr>
          <td className={`${styles.n} num`}>&minus;{count(counts.excluded)}</td>
          <th scope="row" className={styles.what}>
            Nothing to reconcile against
            <span className={styles.why}>
              Mostly payments authorised but never captured — no money moved, so no bank
              settlement exists to match them to.
            </span>
          </th>
        </tr>

        <tr>
          <td className={`${styles.n} num`}>&minus;{count(counts.duplicates)}</td>
          <th scope="row" className={styles.what}>
            The same row twice
            <span className={styles.why}>
              The first copy is counted. Counting the second would score the engine against a
              record it correctly set aside.
            </span>
          </th>
        </tr>

        <tr className={styles.result}>
          <td className={`${styles.n} num`}>{count(counts.reconcilable)}</td>
          <th scope="row" className={styles.what}>
            Records the match rate is measured over
          </th>
        </tr>
      </tbody>
    </table>
  );
}
