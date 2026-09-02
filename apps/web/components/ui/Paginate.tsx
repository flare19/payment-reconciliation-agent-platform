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
 *
 * "GO TO PAGE" IS A PLAIN GET FORM, DELIBERATELY NOT A CLIENT COMPONENT
 * (Tejas, 2026-09-03 — flipping through 47 review proposals one at a time in
 * front of judges is awkward). `Paginate` has no `'use client'` of its own and
 * that is load-bearing: it is called from five plain server pages and from
 * `ReviewQueue` (already a client component), and `ReviewQueue`'s own history
 * comment names the exact failure this avoids — "functions cannot cross the
 * server-to-client boundary... it is a runtime rule, so `tsc` accepted the
 * callback and the page threw on load." Marking `Paginate` itself `'use
 * client'` would force every one of those five server pages to pass `hrefFor`
 * across that same boundary and break the same way, everywhere at once.
 *
 * So the jump box is a `<form method="get">`, matching the pattern the
 * `/exceptions` sort form already uses: zero client JS, works with the same
 * `hrefFor` this component already has, and the browser does the navigation.
 * `hrefFor(1)` is only ever CALLED here, never passed onward, so nothing new
 * crosses any boundary.
 */
function jumpAction(hrefFor: (page: number) => string): { path: string; params: [string, string][] } {
  const [path, query] = hrefFor(1).split('?');
  const params = new URLSearchParams(query ?? '');
  params.delete('page');
  return { path: path ?? '', params: [...params.entries()] };
}

export function Paginate(
  { pagination, hrefFor, unit }:
  { pagination: Pagination; hrefFor: (page: number) => string; unit: string },
) {
  const { page, pageSize, total, totalPages } = pagination;
  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  // Below this, Previous/Next alone is faster than typing a number.
  const jumpId = `jump-${unit.replace(/\s+/g, '-').toLowerCase()}`;
  const jump = totalPages > 5 ? jumpAction(hrefFor) : null;

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

          {jump && (
            <form method="get" action={jump.path || undefined} className={styles.jump}>
              {jump.params.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
              <label htmlFor={jumpId} className={styles.jumpLabel}>Go to page</label>
              <input
                id={jumpId}
                name="page"
                type="number"
                inputMode="numeric"
                min={1}
                max={totalPages}
                defaultValue={page}
                className={styles.jumpInput}
              />
              <button type="submit" className={styles.jumpButton}>Go</button>
            </form>
          )}
        </div>
      )}
    </nav>
  );
}
