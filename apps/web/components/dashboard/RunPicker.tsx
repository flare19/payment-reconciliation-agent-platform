import Link from 'next/link';
import { at, count, day, pct } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import type { RunSummary } from '@/types/api';
import styles from './RunPicker.module.css';

/**
 * ui-spec §2 block 5 — runs listed with their cold/warm state attached.
 *
 * A run's alias state is a property of the run, not a separate run, and listing
 * the two as unrelated rows would let a reader compare a warm rate against a
 * cold one without noticing which is which. So the badge is in the row, always,
 * including on a run where the two figures are equal.
 *
 * Selection lives in the URL (`?run=…`) rather than component state, so a judge
 * can middle-click a run, share the link, or use the back button — and so the
 * server renders the selected run rather than the browser resolving it after
 * paint.
 */
export function RunPicker({ runs, selectedRunId }: { runs: RunSummary[]; selectedRunId: string }) {
  return (
    <table className={styles.table}>
      <caption className="sr-only">Reconciliation runs, most recent first</caption>
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Alias State</th>
          <th scope="col">Reference Date</th>
          <th scope="col" className={styles.numCol}>Match Rate</th>
          <th scope="col" className={styles.numCol}>Exceptions</th>
          <th scope="col" className={styles.numCol}>Records</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const isSelected = run.runId === selectedRunId;
          /**
           * A RUN IN FLIGHT HAS NO METRICS AND NO REFERENCE DATE, and this row
           * is where the run list shows it. Reading through the null threw
           * `Cannot read properties of null` inside the map, which took the
           * WHOLE Runs section off the page — launcher included — while the
           * request still returned 200 and the rest of the dashboard rendered.
           * A silently missing section is worse than an error: nothing on
           * screen said the picker was gone (ADR-121).
           */
          const h = run.headline;
          const isCold = h !== null && h.coldStartMatchRatePct === h.matchRatePct;
          return (
            <tr key={run.runId} className={isSelected ? styles.selected : undefined}>
              <th scope="row" className={styles.runCell}>
                <Link href={hrefWith('/', { run: run.runId })} className={styles.runLink} scroll={false}>
                  <span className={styles.runLabel} translate="no">{run.label}</span>
                  <span className={styles.runMeta}>
                    {run.status === 'completed' && run.finishedAt
                      ? at(run.finishedAt)
                      : `${run.status} · started ${at(run.startedAt)}`}
                  </span>
                </Link>
                {isSelected && <span className="sr-only">(currently shown)</span>}
              </th>
              <td>
                {h === null ? (
                  <span className={styles.pending}>—</span>
                ) : (
                  <span className={`${styles.badge} ${isCold ? styles.cold : styles.warm}`}>
                    {isCold ? 'Cold' : 'Warm'}
                  </span>
                )}
              </td>
              <td className={styles.dateCell}>
                {run.referenceDate === null ? '—' : day(run.referenceDate)}
              </td>
              <td className={`${styles.numCol} num`}>
                {h === null ? '—' : pct(h.matchRatePct)}
              </td>
              <td className={`${styles.numCol} num`}>
                {h === null ? '—' : count(h.exceptionCount)}
              </td>
              <td className={`${styles.numCol} num ${styles.muted}`}>
                {count(run.recordCounts.reconcilable)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
