import Link from 'next/link';
import styles from './status.module.css';

/**
 * WHAT THIS PAGE SAID USED TO BE TRUE, AND STOPPED BEING TRUE.
 *
 * It was written during U17, when the dashboard was the only screen, and it
 * said so: *"the exception list, exception detail, review queue, matches
 * browser, aliases and audit screens are still being built."* U18 built all of
 * them and nobody came back to this file. A reader who followed a broken
 * Analyst citation was told the exception detail screen did not exist yet —
 * while looking at it in the previous tab.
 *
 * A stale explanation is worse than none: the first sent someone to wait for a
 * feature that shipped days ago. So this page no longer claims to know why the
 * URL is missing, because it does not.
 */
export default function NotFound() {
  return (
    <main id="main" className={styles.wrap}>
      <p className="label">Not Found</p>
      <h1 className={styles.title}>Nothing lives at this address.</h1>
      <p className={styles.body}>
        The record, exception or run in this URL is not in the database. That usually means it
        belongs to a different run — ids are per-run, so a link copied from one run will not
        resolve against another.
      </p>
      {/*
        THESE THREE DELIBERATELY DO NOT CARRY `?run=`. This page is statically
        prerendered and has no request to read the run from — and more to the
        point, the run in a URL that 404'd is the most likely thing to have been
        wrong about it. Sending someone back to the default run is the correct
        recovery here, and the copy above already says why the id did not
        resolve.
      */}
      <nav className={styles.links} aria-label="Where to go instead">
        <Link href="/" className={styles.retry}>Dashboard</Link>
        <Link href="/exceptions" className={styles.secondary}>Exceptions</Link>
        <Link href="/analyst" className={styles.secondary}>The Analyst</Link>
      </nav>
    </main>
  );
}
