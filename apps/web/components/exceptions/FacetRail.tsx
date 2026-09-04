import Link from 'next/link';
import { CategoryAccuracy } from '@/components/exceptions/CategoryAccuracy';
import { count } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import { CATEGORY_LABEL, STATUS_LABEL, label } from '@/lib/taxonomy';
import type { ExceptionFacets } from '@/types/api';
import styles from './FacetRail.module.css';

/**
 * Facet filters, served alongside the list so the counts need no second request.
 *
 * Every facet is a LINK, not a checkbox: the filter belongs in the URL (a judge
 * middle-clicks, shares, uses the back button), and a link needs no JavaScript
 * to work. Selecting an active facet clears it, which is the behaviour a
 * toggle would have had without the state.
 *
 * The counts are the run's totals per value, NOT the counts within the current
 * filter — the API computes facets over the whole run. That is the more useful
 * reading (it says what else is there), and mislabelling it as "matching your
 * filter" would be wrong the moment two filters are combined.
 */
interface Group {
  key: 'category' | 'severity' | 'status';
  title: string;
  labels: Record<string, string>;
}

const GROUPS: Group[] = [
  { key: 'severity', title: 'Severity', labels: { high: 'High', medium: 'Medium', low: 'Low' } },
  { key: 'category', title: 'Category', labels: CATEGORY_LABEL },
  { key: 'status', title: 'Status', labels: STATUS_LABEL },
];

export function FacetRail(
  { facets, active, runId, isDefaultRun, accuracy, hasScoreReport }:
  {
    facets: ExceptionFacets;
    active: { category?: string; severity?: string; status?: string };
    runId: string;
    isDefaultRun: boolean;
    /**
     * Measured precision/recall per category (`multiLabel.perCategory`), scored
     * offline (ADR-041). `null` when the run has no score report — the accuracy
     * line then renders as absent beside each category, never as a zero.
     */
    accuracy: Record<string, { precision: number; recall: number }> | null;
    hasScoreReport: boolean;
  },
) {
  const runQ = isDefaultRun ? undefined : runId;
  const anyActive = Boolean(active.category || active.severity || active.status);

  return (
    <aside className={styles.rail} aria-label="Filters">
      <div className={styles.head}>
        <h2 className="label">Filter</h2>
        {anyActive && (
          <Link href={hrefWith('/exceptions', { run: runQ })} className={styles.clearAll}>
            Clear All
          </Link>
        )}
      </div>

      {GROUPS.map((group) => {
        const entries = Object.entries(facets[group.key] ?? {})
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1]);
        if (entries.length === 0) return null;

        return (
          <section key={group.key} className={styles.group}>
            <h3 className={styles.groupTitle}>{group.title}</h3>
            <ul className={styles.list}>
              {entries.map(([value, n]) => {
                const isActive = active[group.key] === value;
                // Clicking the active facet clears it — the toggle a checkbox
                // would have given, without needing to be a checkbox.
                const next = { ...active, run: runQ, [group.key]: isActive ? undefined : value };
                return (
                  <li key={value}>
                    <Link
                      href={hrefWith('/exceptions', next)}
                      className={`${styles.facet} ${isActive ? styles.active : ''}`}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      <span className={styles.facetName}>
                        {label(group.labels, value)}
                      </span>
                      <span className={`${styles.facetCount} num`}>{count(n)}</span>
                    </Link>
                    {/*
                      Only the Category group carries a measured accuracy line
                      (queue item 2). Severity and status are the engine's own
                      labels — there is no ground-truth precision for "high".
                    */}
                    {group.key === 'category' && (
                      <span className={styles.facetAccuracy}>
                        <CategoryAccuracy pr={accuracy?.[value]} hasReport={hasScoreReport} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {/*
              WHAT A LOW PRECISION HERE MEANS, SAID PLAINLY (ADR-172).

              Three of these read badly out of context — MISSING_IN_GATEWAY at
              0.2857 looks like the classifier is wrong two times in three. It
              is not, and the distinction is the one that matters for an
              exception list: recall is 0.93–1.00, so nothing is being MISSED.
              Precision below it means the engine attached a category to events
              the key does not credit it for — it over-labels rather than
              overlooks, and every record is still on the list with its money
              and its evidence in front of a human.

              These are the multi-label figures, which count a category raised
              anywhere on an event. Scored on the PRIMARY category alone the
              same run reads P 1.0000 on five of the seven. Publishing the
              harsher number is deliberate; leaving it unexplained beside a
              count is what would be misleading.
            */}
            {group.key === 'category' && hasScoreReport && (
              <p className={styles.groupNote}>
                Precision counts every category raised anywhere on an event, so it falls when
                the engine adds a second true-but-uncredited label. Scored on the primary
                category alone, five of these seven read <span className="num">1.0000</span>.
                Recall is the figure that says nothing was missed.
              </p>
            )}
          </section>
        );
      })}
    </aside>
  );
}
