import Link from 'next/link';
import { count } from '@/lib/format';
import type { Pagination } from '@/types/api';
import styles from './Paginate.module.css';

/**
 * Pages, never infinite scroll (ui-spec §3).
 *
 * A judge needs to see "212 exceptions" as a bounded, countable set. Infinite
 * scroll makes a list feel endless, which is the opposite of the impression an
 * honest exception list is trying to leave — and it hides the total, which is
 * the number the whole screen is about.
 *
 * Page lives in the URL so the back button, a middle-click and a shared link
 * all work.
 */
export function Paginate(
  { pagination, hrefFor, unit }:
  { pagination: Pagination; hrefFor: (page: number) => string; unit: string },
) {
  const { page, pageSize, total, totalPages } = pagination;
  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav className={styles.wrap} aria-label={`${unit} pagination`}>
      <p className={styles.range}>
        <span className="num">{count(first)}</span>–<span className="num">{count(last)}</span>
        {' of '}
        <span className={`num ${styles.total}`}>{count(total)}</span> {unit}
      </p>

      {totalPages > 1 && (
        <div className={styles.controls}>
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} className={styles.button} rel="prev">
              Previous
            </Link>
          ) : (
            <span className={`${styles.button} ${styles.disabled}`} aria-disabled="true">
              Previous
            </span>
          )}

          <span className={styles.pageOf}>
            Page <span className="num">{count(page)}</span> of{' '}
            <span className="num">{count(totalPages)}</span>
          </span>

          {page < totalPages ? (
            <Link href={hrefFor(page + 1)} className={styles.button} rel="next">
              Next
            </Link>
          ) : (
            <span className={`${styles.button} ${styles.disabled}`} aria-disabled="true">
              Next
            </span>
          )}
        </div>
      )}
    </nav>
  );
}
