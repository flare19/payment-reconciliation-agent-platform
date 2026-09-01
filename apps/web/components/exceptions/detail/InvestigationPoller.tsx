'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getInvestigation } from '@/lib/api-client';
import styles from './InvestigationPoller.module.css';

/**
 * THE POLLER LIVES WHERE THE RUNNING STATE LIVES, and that is the whole point.
 *
 * The first version polled from `AskAnalyst` — the component that STARTS the
 * investigation. Three seconds later its own first refresh made the
 * investigation row exist, the page swapped `<AskAnalyst>` for
 * `<AnalystPanel>`, `AskAnalyst` unmounted, and the unmount cleanup that had
 * been added to stop the interval leaking stopped the only thing driving the
 * page. It sat on "Investigating now" until somebody reloaded by hand.
 *
 * The fix that broke it was correct in isolation: an interval really must not
 * outlive its component. What was wrong is WHICH component owned it. A poller
 * that watches for a transition has to be mounted by the state it is watching,
 * not by the action that caused it — otherwise it is guaranteed to be
 * unmounted by the first change it successfully detects.
 *
 * AND IT POLLS ONE CHEAP ENDPOINT, NOT THE WHOLE PAGE. The second version
 * called `router.refresh()` every three seconds, and the exception detail page
 * costs about seven API reads per render — roughly 140 requests a minute
 * against a 120/minute ceiling (ADR-096). THE POLLER RATE-LIMITED ITSELF,
 * every refresh 500'd, and the page still never updated. It now polls
 * `GET /api/investigations/:id` — one request — and spends a full refresh only
 * at the single moment the status actually changes.
 *
 * AND THE FALLBACK DOES NOT NEED JAVASCRIPT. Both states offer a plain `<a>`
 * to this page's own URL alongside the refresh button. If the automatic check
 * ever fails *because* client-side JavaScript is not running — a chunk that did
 * not load, a hydration error, a browser extension — then a button wired to
 * `router.refresh()` is no fallback at all, because it needs exactly the thing
 * that is broken. A link is a full page load and works when nothing else does.
 *
 * IT ALSO GIVES UP OUT LOUD. `agent-design.md` §8 bounds an investigation at
 * 60 seconds; this polls to 90 and then stops and says so, with a button.
 * Silent polling that has quietly died is indistinguishable from work still in
 * progress, and a reader staring at a spinner cannot tell which they are
 * looking at. A manual reload is offered throughout, not only after the bound,
 * because the cheapest fix for "is this thing still alive" is letting someone
 * check.
 */
const POLL_MS = 3000;
const GIVE_UP_AFTER_S = 90;

export function InvestigationPoller(
  { investigationId, exceptionId }: { investigationId: string; exceptionId: string },
) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    if (gaveUp) return undefined;
    let cancelled = false;

    const tick = window.setInterval(() => setElapsed((s) => s + 1), 1000);

    const check = window.setInterval(async () => {
      try {
        const inv = await getInvestigation(investigationId);
        if (cancelled) return;
        if (inv.status !== 'running') {
          // ONE full refresh, at the only moment it is worth seven requests.
          window.clearInterval(check);
          router.refresh();
        }
      } catch {
        // A failed poll is not a failed investigation. The give-up timer stops
        // this, not one bad response.
      }
    }, POLL_MS);

    const limit = window.setTimeout(() => setGaveUp(true), GIVE_UP_AFTER_S * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      window.clearInterval(check);
      window.clearTimeout(limit);
    };
  }, [router, gaveUp, investigationId]);

  if (gaveUp) {
    return (
      <div className={styles.gaveUp} role="status">
        <p className={styles.gaveUpText}>
          <strong>This page stopped checking after {GIVE_UP_AFTER_S} seconds.</strong>{' '}
          The investigation may well have finished — nothing here can tell the difference between
          still working and no longer being watched, so rather than leave you guessing:
        </p>
        <div className={styles.buttons}>
          <button type="button" className={styles.reload} onClick={() => router.refresh()}>
            Check for the result
          </button>
          {/* A PLAIN LINK, not a second button. If the automatic check failed
              because JavaScript on this page is not running, a button that
              needs JavaScript is no fallback at all — this one is a full page
              load and works when nothing else does. */}
          <a href={`/exceptions/${exceptionId}`} className={styles.hardReload}>
            or reload the page
          </a>
        </div>
      </div>
    );
  }

  return (
    <p className={styles.live} aria-live="polite">
      <span className={styles.pulse} aria-hidden="true" />
      Checking for the result… <span className="num">{elapsed}s</span> elapsed
      <button type="button" className={styles.manual} onClick={() => router.refresh()}>
        check now
      </button>
      <a href={`/exceptions/${exceptionId}`} className={styles.manual}>reload</a>
    </p>
  );
}
