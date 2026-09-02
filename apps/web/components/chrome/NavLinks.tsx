'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { hrefWith } from '@/lib/run-context';
import styles from './Masthead.module.css';

/**
 * The masthead's links, and the one place that keeps `?run=` alive across a
 * navigation.
 *
 * THE NAV IS WHERE RUN SELECTION USED TO DIE. Every screen resolves its run
 * through `resolveRun()`, which falls back to "most recent completed" when no
 * `?run=` is present. The nav rendered bare hrefs, so choosing a run in the
 * picker and then clicking Exceptions silently dropped the selection and showed
 * a DIFFERENT run's exceptions under the selected run's name. Nothing errored,
 * nothing looked wrong, and a reader comparing two runs would have been shown
 * one run's numbers twice.
 *
 * This is the navigation-level twin of ADR-113, which fixed the same class of
 * bug at the entity level (the exception detail page reading the resolved run
 * instead of the exception's own run).
 *
 * `useSearchParams()` is why this file needs a Suspense boundary in `Masthead`:
 * the ten real screens are `force-dynamic` and resolve it server-side, but the
 * statically rendered `not-found` page has no request to read it from.
 */

export type NavItem = { href: string; label: string };

/**
 * Presentational, and it takes `run` as an argument rather than reading it.
 * That is what lets the Suspense fallback render byte-identical markup without
 * touching the query string.
 */
function NavList({ items, run }: { items: NavItem[]; run: string | undefined }) {
  const pathname = usePathname();

  return (
    <ul className={styles.nav}>
      {items.map((item) => {
        // Nested routes count as their section — `/exceptions/<id>` keeps
        // Exceptions marked, because a reader who has drilled into a finding has
        // not left the exception list in any sense they would recognise.
        const active = item.href === '/'
          ? pathname === '/'
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={hrefWith(item.href, { run })}
              className={`${styles.navLink} ${active ? styles.navLinkActive : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const run = useSearchParams().get('run') ?? undefined;
  return <NavList items={items} run={run} />;
}

/** Rendered only where there is no request to read a run from. */
export function NavLinksFallback({ items }: { items: NavItem[] }) {
  return <NavList items={items} run={undefined} />;
}

/**
 * The wordmark is a link to the dashboard, so it drops the run exactly the way
 * the nav did. Same fix, same reason.
 */
export function BrandLink(
  { className, children }: { className?: string; children: React.ReactNode },
) {
  const run = useSearchParams().get('run') ?? undefined;
  return <Link href={hrefWith('/', { run })} className={className}>{children}</Link>;
}
