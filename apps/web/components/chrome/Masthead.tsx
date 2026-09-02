import { Suspense } from 'react';
import Link from 'next/link';
import { BrandLink, NavLinks, NavLinksFallback, type NavItem } from './NavLinks';
import styles from './Masthead.module.css';

/**
 * Screens land here as they are built. An entry that exists in this array is a
 * link a judge can click; one that does not exist yet is simply absent, because
 * a nav item leading to a "coming soon" page is worse than no nav item.
 */
const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/exceptions', label: 'Exceptions' },
  { href: '/analyst', label: 'Analyst' },
  { href: '/review', label: 'Review' },
  { href: '/matches', label: 'Matches' },
  { href: '/aliases', label: 'Aliases' },
  { href: '/audit', label: 'Audit' },
];

/**
 * Declared once so the Suspense fallback below cannot drift from the real
 * thing. A fallback that renders different markup is a layout shift nobody
 * tests for.
 */
const brand = (
  <>
    <span className={styles.mark} aria-hidden="true" />
    <span className={styles.brandText}>
      <span className={styles.brandName}>Payment Reconciliation</span>
      <span className={styles.brandKicker}>Razorpay AI Buildathon · Track 4</span>
    </span>
  </>
);

/**
 * THE SUSPENSE BOUNDARIES ARE LOAD-BEARING, NOT DECORATION. `NavLinks` and
 * `BrandLink` read `useSearchParams()` to carry the selected run across a
 * navigation. The masthead lives in the root layout, so it renders on every
 * route — including `not-found`, which is statically prerendered and has no
 * request to read search params from. Without a boundary that page deopts into
 * client-side rendering at build time.
 *
 * On the ten real screens (`force-dynamic`, all of them) the params resolve on
 * the server, the boundary settles during the same render, and the complete nav
 * ships in the HTML — so this costs nothing where it matters and only degrades
 * to a run-less nav where there is no run to carry.
 */
export function Masthead() {
  return (
    <header className={styles.masthead}>
      <div className={styles.inner}>
        <Suspense fallback={<Link href="/" className={styles.brand}>{brand}</Link>}>
          <BrandLink className={styles.brand}>{brand}</BrandLink>
        </Suspense>

        {NAV.length > 1 && (
          <nav aria-label="Primary">
            <Suspense fallback={<NavLinksFallback items={NAV} />}>
              <NavLinks items={NAV} />
            </Suspense>
          </nav>
        )}
      </div>
    </header>
  );
}
