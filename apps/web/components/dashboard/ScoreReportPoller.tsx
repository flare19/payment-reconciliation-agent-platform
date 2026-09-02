'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getMetricsIfComplete } from '@/lib/api-client';
import { hrefWith } from '@/lib/run-context';
import styles from './ScoreReportPoller.module.css';

/**
 * WHY THE "NOT MEASURED YET" TILES NEEDED A POLLER (Tejas, 2026-09-03).
 *
 * `npm run score:watch` measures a run within a few seconds of it finishing
 * (ADR-148) — but the dashboard itself only ever fetched metrics ONCE, at
 * request time, server-side. A judge who clicks "Run It Again" lands on the
 * new run instantly (F19/ADR-145's whole point) and sees False Positives and
 * Best Possible as absent, correctly, at that instant — and nothing on the
 * page ever checked again. The only way to see them turn measured was a
 * manual reload, and a judge who does not know to do that, or gets bored
 * first, never sees the honest number arrive.
 *
 * MOUNTED BY THE ABSENT STATE, EXACTLY LIKE `InvestigationPoller` (ADR-116).
 * The page only renders this component when `metrics.measured === null`, so
 * the moment a `router.refresh()` brings a real score report, this component
 * is not re-rendered as "done" — it is unmounted, because its own mount
 * condition just became false. Nothing here has to notice its own success;
 * the page's own re-render is the off-switch.
 *
 * POLLS ONE CHEAP ENDPOINT, NOT A FULL PAGE REFRESH (same lesson
 * `InvestigationPoller` already paid for on this exact failure mode). Every
 * tick calls `getMetricsIfComplete`, one read; a full `router.refresh()` —
 * which re-fetches everything the dashboard needs, roughly a dozen calls —
 * only happens once, at the single moment `measured` actually stops being
 * `null`.
 *
 * GIVES UP OUT LOUD, AFTER LONGER THAN AN INVESTIGATION'S BOUND. A score
 * report depends on `score:watch` actually being the process running
 * somewhere — this project's own `what-broke.md` records it silently NOT
 * running at least twice this session. Polling forever would look identical
 * to a live check whether or not anything is listening on the other end, so
 * this stops after two minutes and says so, with a manual check and a plain
 * link that needs no JavaScript at all.
 */
const POLL_MS = 5000;
const GIVE_UP_AFTER_S = 120;

export function ScoreReportPoller({ runId, runQ }: { runId: string; runQ: string | undefined }) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    if (gaveUp) return undefined;
    let cancelled = false;

    const tick = window.setInterval(() => setElapsed((s) => s + 1), 1000);

    const check = window.setInterval(async () => {
      try {
        const metrics = await getMetricsIfComplete(runId);
        if (cancelled) return;
        if (metrics && metrics.measured !== null) {
          // ONE full refresh, at the only moment it is worth a dozen requests.
          window.clearInterval(check);
          router.refresh();
        }
      } catch {
        // A failed poll is not "no score report" — the give-up timer is what
        // stops this, not one bad response.
      }
    }, POLL_MS);

    const limit = window.setTimeout(() => setGaveUp(true), GIVE_UP_AFTER_S * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      window.clearInterval(check);
      window.clearTimeout(limit);
    };
  }, [router, gaveUp, runId]);

  if (gaveUp) {
    return (
      <p className={styles.gaveUp} role="status">
        Stopped checking automatically after {GIVE_UP_AFTER_S} seconds — the offline scorer may
        simply not be running right now.{' '}
        <button type="button" className={styles.manual} onClick={() => router.refresh()}>
          Check now
        </button>
        {/* A plain link, not a second button — works even if the automatic
            check failed because client-side JavaScript on this page did not
            run at all. */}
        <a href={hrefWith('/', { run: runQ })} className={styles.manual}>reload</a>
      </p>
    );
  }

  return (
    <p className={styles.live} aria-live="polite">
      <span className={styles.pulse} aria-hidden="true" />
      Watching for a score report… <span className="num">{elapsed}s</span>
      <button type="button" className={styles.manual} onClick={() => router.refresh()}>
        check now
      </button>
    </p>
  );
}
