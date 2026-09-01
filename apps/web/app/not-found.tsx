import Link from 'next/link';
import styles from './status.module.css';

/**
 * The dashboard links into `/exceptions` and its filters, which land with U18.
 * Until they do, a click has to arrive somewhere that says which screen is
 * missing rather than at a framework default — a stock 404 in front of a panel
 * reads as a broken deployment, which is a worse claim than "not built yet".
 */
export default function NotFound() {
  return (
    <main id="main" className={styles.wrap}>
      <p className="label">Not Found</p>
      <h1 className={styles.title}>This screen does not exist yet.</h1>
      <p className={styles.body}>
        The dashboard is built. The exception list, exception detail, review queue, matches browser,
        aliases and audit screens are still being built, and the links pointing at them are already
        wired to the routes they will occupy.
      </p>
      <Link href="/" className={styles.retry}>Back to the Dashboard</Link>
    </main>
  );
}
