import Link from 'next/link';
import { NavLinks } from './NavLinks';
import styles from './Masthead.module.css';

/**
 * Screens land here as they are built. An entry that exists in this array is a
 * link a judge can click; one that does not exist yet is simply absent, because
 * a nav item leading to a "coming soon" page is worse than no nav item.
 */
const NAV: { href: string; label: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/exceptions', label: 'Exceptions' },
  { href: '/review', label: 'Review' },
  { href: '/matches', label: 'Matches' },
  { href: '/aliases', label: 'Aliases' },
  { href: '/audit', label: 'Audit' },
];

export function Masthead() {
  return (
    <header className={styles.masthead}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.brandText}>
            <span className={styles.brandName}>Payment Reconciliation</span>
            <span className={styles.brandKicker}>Razorpay AI Buildathon · Track 4</span>
          </span>
        </Link>

        {NAV.length > 1 && (
          <nav aria-label="Primary">
            <NavLinks items={NAV} />
          </nav>
        )}
      </div>
    </header>
  );
}
