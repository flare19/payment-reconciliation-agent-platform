import Link from 'next/link';
import { count } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import { CATEGORY_LABEL, label } from '@/lib/taxonomy';
import type { ExceptionSummary } from '@/types/api';
import styles from './ExceptionExposureBand.module.css';

/**
 * What the exception list says FIRST (queue item 4, ADR-167).
 *
 * The primary screen opened straight into the taxonomy — a category rail and a
 * severity split, structural facts — before naming a single rupee. This is the
 * AI Finance Controller track and a controller triages by exposure, so the
 * money leads: the run-wide total, the high-severity subtotal, and the three
 * largest single lines, each a link into its own exception. The taxonomy is
 * still right there in the facet rail; it is just no longer the first thing.
 *
 * The total is `engine.exceptions.amountAtRisk` — summed server-side over the
 * whole run (ADR-164), `provenance: engine`. It and the top three are run-wide,
 * not scoped to the active filter, matching the facet counts beside them (which
 * are also run totals by design).
 */
export function ExceptionExposureBand({
  totalDisplay,
  totalCount,
  highSeverityDisplay,
  highSeverityCount,
  top,
  runQ,
}: {
  totalDisplay: string;
  totalCount: number;
  highSeverityDisplay: string;
  highSeverityCount: number;
  /** The run's largest exceptions by amount at risk, already sorted, ≤ 3. */
  top: ExceptionSummary[];
  runQ: string | undefined;
}) {
  return (
    <section className={styles.band} aria-label="Money at risk on this run">
      <div className={styles.headline}>
        <p className={styles.total} data-provenance="engine">
          <span className={`${styles.totalValue} num`}>{totalDisplay}</span>
          <span className={styles.totalLabel}>
            at risk across {count(totalCount)} exceptions
          </span>
        </p>
        <p className={styles.sub}>
          <span className="num">{highSeverityDisplay}</span> of it in{' '}
          <span className="num">{count(highSeverityCount)}</span> high-severity{' '}
          {highSeverityCount === 1 ? 'exception' : 'exceptions'}
        </p>
      </div>

      {top.length > 0 && (
        <ol className={styles.top}>
          {top.map((e, i) => (
            <li key={e.exceptionId} className={styles.topRow}>
              <Link
                href={hrefWith(`/exceptions/${e.exceptionId}`, { run: runQ })}
                className={styles.topLink}
              >
                <span className={styles.rank} aria-hidden="true">{i + 1}</span>
                <span className={`${styles.amount} num`}>
                  {e.amountAtRiskDisplay ?? '—'}
                </span>
                <span className={styles.cat} translate="no">
                  {label(CATEGORY_LABEL, e.category)}
                </span>
                <span className={styles.rec} translate="no">
                  {e.primaryRecord.sourceSystem}
                  {e.primaryRecord.externalId ? ` · ${e.primaryRecord.externalId}` : ''}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
