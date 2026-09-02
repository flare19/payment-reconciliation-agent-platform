import { at } from '@/lib/format';
import styles from './Footer.module.css';

/**
 * F20 + F21 + F22 (backlog items 14–16) — production credibility, in one
 * global block rather than three separate ones. All three answer the same
 * reader question at the bottom of every page: *is this real, and who made
 * it.*
 *
 * F20 — A PERFORMANCE FIGURE WITH NO MEASUREMENT DATE IS THE SAME CATEGORY OF
 * CLAIM THIS PROJECT REFUSES EVERYWHERE ELSE. These numbers are not fetched
 * live on every page load — that would mean every visitor's page paying a
 * round trip to Railway for a footer nobody asked to see, and it would also
 * quietly change on every deploy without anyone deciding it should. They are
 * a dated snapshot, exactly like `score_reports` (ADR-041): measured once,
 * against the real production API, and superseded by re-measuring rather
 * than by drifting silently. Re-measure and update this file rather than
 * animate a number that was never re-checked.
 *
 * Measured directly against the live API on 2026-09-02 (five samples per
 * read endpoint, one full run): `GET /api/health` and `GET /api/runs`
 * answered in 0.35–0.46 s; a complete reconciliation run — 920 records,
 * ingestion through the audit chain — finished in 8.24 s wall clock
 * (`startedAt` 21:08:04.426Z → `finishedAt` 21:08:12.667Z, run
 * `cff41e32-dd53-43eb-a907-f1fa071bd32f`, byte-identical result to every
 * other holdout run). The service does not scale to zero (ADR-097), so
 * these are steady-state numbers, not a cold start.
 */

/** The instant of measurement, run through the site's own date formatter
 *  rather than typed as prose — the same discipline every other timestamp
 *  on the site follows. */
const MEASURED_AT = '2026-09-02T21:08:04.426Z';

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.block}>
          <h2 className="label">Deployed</h2>
          <p className={styles.text}>
            Live on Railway, always-on. Read endpoints answered in{' '}
            <span className="num">0.35–0.46&nbsp;s</span> and a complete run — 920 records,
            ingestion through the audit chain — finished in{' '}
            <span className="num">8.24&nbsp;s</span> wall clock, measured directly against the
            production API on {at(MEASURED_AT)}.
          </p>
          <a
            href="https://payment-reconciliation-agent-platform-production.up.railway.app/api/health"
            className={styles.link}
            target="_blank"
            rel="noopener noreferrer"
          >
            Check it yourself — /api/health ↗
          </a>
        </div>

        <div className={styles.block}>
          <h2 className="label">What This Is Not</h2>
          <p className={styles.text}>
            Synthetic data generated for this submission — no real bank, gateway or ledger, and
            no real payment has ever touched this system. Nothing on this site is financial
            advice. The demo is deliberately unauthenticated (ADR-096); please don&rsquo;t enter
            real payment or personal details anywhere on it.
          </p>
        </div>

        <div className={styles.block}>
          <h2 className="label">Built For</h2>
          <p className={styles.text}>
            The Razorpay AI Buildathon, Track&nbsp;4 — AI Finance Controller.{' '}
            <a
              href="https://github.com/flare19/payment-reconciliation-agent-platform"
              className={styles.link}
              target="_blank"
              rel="noopener noreferrer"
            >
              Source on GitHub ↗
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
