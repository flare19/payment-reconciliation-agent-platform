'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiClientError, investigateException } from '@/lib/api-client';
import styles from './AskAnalyst.module.css';

/**
 * THE ONLY CONTROL IN THE FRONTEND THAT SPENDS MONEY.
 *
 * Everything else the interface can do — approve, reject, resolve, verify the
 * chain, read a persisted investigation — costs nothing. This one call is
 * roughly $0.10–0.12 of Anthropic credit against a hard-capped prepaid key, so
 * it is built to be impossible to trigger by accident:
 *
 *   · it never runs on render, only on a click
 *   · the first click ARMS it and states the cost; a second click spends
 *   · it does not appear at all when an investigation already exists — that
 *     result is rendered instead, for free
 *
 * The confirm step is not ceremony. A judge clicking around a demo will click
 * every button once, and the difference between "one button" and "two buttons"
 * is the difference between a stranger being able to spend the budget and not.
 *
 * IDEMPOTENCE IS THE SERVER'S JOB, NOT THIS COMPONENT'S. `ux_inv_exc_active`
 * permits one non-failed investigation per exception, and endpoint 25 returns a
 * concluded one with `200 reused: true` rather than starting a second (ADR-109).
 * So even a double-submit, a retry, or two people clicking at once cannot buy
 * the same investigation twice. This component only has to render that fact.
 */
export function AskAnalyst({ exceptionId }: { exceptionId: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // Leaving the page stops the polling. Without this the interval outlives the
  // component and keeps refreshing a route the reader has already left.
  useEffect(() => () => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
  }, []);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const res = await investigateException(exceptionId);

      if (res.reused) {
        setStatus('An investigation already existed — showing it. Nothing was spent.');
        router.refresh();
        return;
      }

      setStatus('Investigating… this takes up to a minute. The page updates itself.');
      // Endpoint 25 is 202-then-poll. Refreshing re-renders the panel from the
      // database, so the running → concluded transition arrives on its own.
      //
      // THE INTERVAL IS CLEARED FROM ONE PLACE. The first version armed a
      // `setInterval` and a separate `setTimeout` to cancel it, which left the
      // interval alive on unmount — navigate away mid-investigation and it kept
      // refreshing a page nobody was looking at. `agent-design.md` §8 bounds an
      // investigation at 60 s; 90 s of polling covers that with room, and then
      // stops rather than running forever.
      const started = Date.now();
      const poll = window.setInterval(() => {
        if (Date.now() - started > 90_000) {
          window.clearInterval(poll);
          setStatus('Still running after 90 seconds. Reload to see where it got to.');
          return;
        }
        router.refresh();
      }, 3000);
      pollRef.current = poll;
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'INVESTIGATION_IN_PROGRESS') {
        setStatus('Someone is already investigating this one. Refreshing when it lands.');
        router.refresh();
      } else if (err instanceof ApiClientError && err.code === 'AGENT_QUOTA_EXCEEDED') {
        setError(
          'The hourly spend ceiling has been reached. This is the budget guard working, not a '
          + 'failure — investigations resume as older spend leaves the window.',
        );
      } else if (err instanceof ApiClientError && err.code === 'AGENT_DISABLED') {
        setError(
          'The Analyst is switched off on this deployment — there is no API key configured. '
          + 'Everything else on this page was produced without one.',
        );
      } else {
        setError(err instanceof ApiClientError
          ? `${err.code} (${err.status}) at ${err.path} — ${err.message}`
          : String(err));
      }
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.copy}>
        <h3 className={styles.title}>No one has investigated this exception</h3>
        <p className={styles.body}>
          The Analyst reads this exception, decides which questions to ask, and answers them by
          calling the engine&rsquo;s own locked code — it does no arithmetic of its own. It runs
          only when someone asks, never over the queue, because 212 exceptions at this price is a
          pass nobody can afford to repeat.
        </p>
      </div>

      {!armed ? (
        <button
          type="button"
          className={styles.arm}
          onClick={() => { setArmed(true); setError(null); setStatus(null); }}
          disabled={busy}
        >
          Ask the Analyst
        </button>
      ) : (
        <div className={styles.confirm}>
          <p className={styles.cost}>
            This spends roughly <strong className="num">$0.05–0.12</strong> of real Anthropic
            credit — measured, not estimated — and takes up to a minute. The result is stored, so
            opening this exception again, by you or anyone else, is free and shows the same
            verdict.
          </p>
          <div className={styles.buttons}>
            <button type="button" className={styles.go} onClick={ask} disabled={busy}>
              {busy ? 'Starting…' : 'Yes, spend it'}
            </button>
            <button
              type="button"
              className={styles.cancel}
              onClick={() => setArmed(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div aria-live="polite">
        {status && <p className={styles.status}>{status}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    </div>
  );
}
