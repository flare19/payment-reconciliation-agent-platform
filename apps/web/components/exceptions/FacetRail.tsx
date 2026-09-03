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
          </section>
        );
      })}
    </aside>
  );
}
