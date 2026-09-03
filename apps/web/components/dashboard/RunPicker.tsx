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
/**
 * RUNS ARE NEVER DELETED, SO THIS LIST ONLY EVER GROWS (ADR-134).
 *
 * `audit_log` is append-only by trigger and `audit_chain_heads.run_id` is
 * `ON DELETE RESTRICT`, so the database refuses to erase a run's history —
 * measured, not assumed: deleting a run raises the FK violation, and deleting
 * its audit rows raises *"audit_log is append-only"*. That is ADR-015 working,
 * and tidying the list by dismantling it would trade the audit guarantee for
 * cosmetics.
 *
 * So the fix is presentational and hides nothing: the most recent few, the
 * selected one always included wherever it sits, the true total stated, and
 * every row one click away. The audit screen still shows all of them.
 */
const DEFAULT_VISIBLE = 5;

export function RunPicker(
  { runs, runsTotal, selectedRunId, showAll, runQ }: {
    runs: RunSummary[];
    /**
     * The TRUE total (`pagination.total`), not `runs.length`. `runs` is
     * capped at `resolveRun`'s fetch size — currently the API's own ceiling,
     * 200 — so on a database this footer's "All N runs" claim would be false
     * the moment total exceeds that, and `runs.length` has no way to know
     * it. This is what "Show all" actually said "All 25 runs" against
     * before this field existed, while 31 were real (found live,
     * 2026-09-03).
     */
    runsTotal: number;
    selectedRunId: string;
    showAll: boolean;
    runQ: string | undefined;
  },
) {
  const selected = runs.find((r) => r.runId === selectedRunId);
  const head = runs.slice(0, DEFAULT_VISIBLE);
  // The selected run is never hidden by the cut, however far down it sits.
  const visible = showAll || (selected !== undefined && head.includes(selected))
    ? (showAll ? runs : head)
    : [...head, ...(selected === undefined ? [] : [selected])];
  // Against runsTotal, not runs.length — the true count of runs NOT shown,
  // including any beyond what was even fetched.
  const hidden = runsTotal - visible.length;
  // True only when every run that exists was actually fetched. Beyond the
  // fetch ceiling this is false even in showAll mode, and the footer below
  // says so rather than claiming completeness it does not have.
  const fetchedEverything = runs.length === runsTotal;

  return (
    <>
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
        {visible.map((run) => {
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
          // READ, never derived. This line used to compare
          // `coldStartMatchRatePct === matchRatePct`, and those were the same
          // expression in run-metrics, so every run was labelled Cold —
          // including one that had a learned alias active (ADR-130).
          const isCold = h?.isCold ?? null;
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
                {isCold === null ? (
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
      {hidden > 0 && (
        <p className={styles.more}>
          Showing <span className="num">{visible.length}</span> of{' '}
          <span className="num">{runsTotal}</span> runs.{' '}
          <Link href={hrefWith('/', { run: runQ, runs: 'all' })}>Show all</Link> — every run ever
          started is kept, because the audit log is append-only and its history cannot be deleted.
        </p>
      )}
      {showAll && fetchedEverything && (
        <p className={styles.more}>
          All <span className="num">{runsTotal}</span> runs.{' '}
          <Link href={hrefWith('/', { run: runQ })}>Show recent only</Link>.
        </p>
      )}
      {showAll && !fetchedEverything && (
        <p className={styles.more}>
          Showing the most recent <span className="num">{runs.length}</span> of{' '}
          <span className="num">{runsTotal}</span> runs — older ones exist and are not listed
          here; the <Link href="/audit">audit trail</Link> still covers every one.{' '}
          <Link href={hrefWith('/', { run: runQ })}>Show recent only</Link>.
        </p>
      )}
    </>
  );
}
