'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './Masthead.module.css';

/**
 * The nav's only reason to be a client component: knowing which screen you are
 * on. `aria-current="page"` carries that to assistive tech; the underline
 * carries it visually.
 *
 * Nested routes count as their section — `/exceptions/<id>` keeps Exceptions
 * marked, because a reader who has drilled into a finding has not left the
 * exception list in any sense they would recognise.
 */
export function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();

  return (
    <ul className={styles.nav}>
      {items.map((item) => {
        const active = item.href === '/'
          ? pathname === '/'
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
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
