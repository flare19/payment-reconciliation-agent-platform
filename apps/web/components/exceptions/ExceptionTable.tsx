import Link from 'next/link';
import { SeverityChip, Chip } from '@/components/ui/Chip';
import { count, day, ratio4 } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import { CATEGORY_LABEL, SOURCE_LABEL, label } from '@/lib/taxonomy';
import type { ExceptionSummary } from '@/types/api';
import styles from './ExceptionTable.module.css';

/**
 * THE PRIMARY SCREEN'S TABLE. Two decisions here are load-bearing:
 *
 * 1. **The explanation is visible in the list, not behind a click.** The single
 *    most impressive property of this system is that it explains itself in plain
 *    English, and that has to be legible while scrolling rather than something a
 *    viewer discovers by opening a row. It is clamped to two lines, not one — a
 *    single line truncates most of these mid-clause and reads as broken text
 *    rather than as a summary.
 *
 * 2. **`sharedExplanationCount` is shown inline.** It is the visible face of the
 *    signature-cache design: "this explanation covers 14 exceptions" prompts
 *    exactly the question worth being asked about how 212 exceptions cost three
 *    API calls.
 *
 * Default order is severity then money at risk, which is how a finance
 * controller triages. A default that buried a ₹5,00,000 mismatch under nine ₹5
 * ones would waste the entire feature.
 */
export function ExceptionTable(
  { exceptions, runQ }: { exceptions: ExceptionSummary[]; runQ: string | undefined },
) {
  return (
    <table className={styles.table}>
      <caption className="sr-only">
        Exceptions, most severe and highest amount at risk first
      </caption>
      {/* Explicit widths, because `table-layout: fixed` decides them from the
          first row otherwise — and what it decided left the explanation column
          about four words wide. That column is the one ui-spec §3 says must be
          legible WHILE SCROLLING, so it gets the largest share and everything
          else is sized to what its content actually needs. */}
      <colgroup>
        <col style={{ width: '8%' }} />
        <col style={{ width: '12%' }} />
        <col style={{ width: '13%' }} />
        <col style={{ width: '9%' }} />
        <col style={{ width: '9%' }} />
        <col style={{ width: '5%' }} />
        <col style={{ width: '44%' }} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Severity</th>
          <th scope="col">Category</th>
          <th scope="col">Record</th>
          <th scope="col" className={styles.numCol}>Amount</th>
          <th scope="col" className={styles.numCol}>At Risk</th>
          <th scope="col" className={styles.numCol}>Best</th>
          <th scope="col">Explanation</th>
        </tr>
      </thead>
      <tbody>
        {exceptions.map((e) => {
          const href = hrefWith(`/exceptions/${e.exceptionId}`, { run: runQ });
          return (
            <tr key={e.exceptionId}>
              <td className={styles.sevCell}>
                <SeverityChip severity={e.severity} />
              </td>

              <td className={styles.catCell}>
                <Link href={href} className={styles.catLink}>
                  {label(CATEGORY_LABEL, e.category)}
                </Link>
                {e.secondaryFlags.length > 0 && (
                  <span className={styles.flags}>
                    {e.secondaryFlags.map((f) => (
                      <Chip key={f} tone="outline">{label(CATEGORY_LABEL, f)}</Chip>
                    ))}
                  </span>
                )}
              </td>

              <td className={styles.recordCell}>
                <span className={styles.source}>
                  {label(SOURCE_LABEL, e.primaryRecord.sourceSystem)}
                </span>
                <span className={`${styles.extId} num`} translate="no">
                  {e.primaryRecord.externalId ?? '—'}
                </span>
                <span className={styles.date}>{day(e.primaryRecord.txnDate)}</span>
              </td>

              <td className={`${styles.numCol} num`}>{e.primaryRecord.amountDisplay}</td>

              <td className={`${styles.numCol} num ${styles.atRisk}`}>
                {e.amountAtRiskDisplay ?? (
                  <span
                    className={styles.none}
                    title="A non-primary duplicate never enters the matching pool, so no amount at risk is computed. Absent, not zero."
                  >
                    n/a
                  </span>
                )}
              </td>

              <td className={`${styles.numCol} num ${styles.score}`}>
                {e.bestCandidateScore === null ? (
                  <span className={styles.none} title="No candidate scored above the log floor">
                    —
                  </span>
                ) : ratio4(e.bestCandidateScore)}
              </td>

              <td className={styles.explainCell}>
                <p className={styles.explanation}>
                  {e.explanationText ?? <span className={styles.none}>Not yet explained</span>}
                </p>
                {e.sharedExplanationCount !== null && e.sharedExplanationCount > 0 && (
                  <span className={styles.shared}>
                    Shared with <span className="num">{count(e.sharedExplanationCount)}</span> other
                    {e.sharedExplanationCount === 1 ? ' exception' : ' exceptions'}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
