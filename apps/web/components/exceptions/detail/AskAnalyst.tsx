'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiClientError, investigateException } from '@/lib/api-client';
import styles from './AskAnalyst.module.css';

/**
 * THE ONLY CONTROL IN THE FRONTEND THAT SPENDS MONEY.
 *
 * Everything else the interface can do — approve, reject, resolve, verify the
 * chain, read a persisted investigation — costs nothing. This one call runs a
 * live model against a hard-capped prepaid key, so it is built to be impossible
 * to trigger by accident:
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
 * ITS TONE IS THE OTHER HALF OF THAT (ADR-141). The step has to state plainly
 * that this spends live credit — removing that would be dishonest, and a person
 * is entitled to know before they press. What it must NOT do is hand a guest an
 * invoice. So the price is stated as a fact about the system and the reason it
 * is built this way, not as a warning aimed at the person about to click, and
 * the button says what happens rather than what it costs.
 *
 * The figure is MEASURED, not estimated. Across the 13 investigations this
 * build has run: min $0.0474, median $0.0944, max $0.1259, mean $0.0907. The
 * copy says "about $0.09" and carries no sample count, because a hardcoded
 * count is a claim that goes stale the next time somebody clicks this button.
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

      setStatus('Investigating… the panel below takes over from here.');
      // ONE refresh, then hand off. The next render replaces this component
      // with the running panel, which mounts its own poller — a poller owned by
      // the component that STARTS the work is unmounted by the first change it
      // successfully detects, which is how the previous version stalled.
      router.refresh();
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
          The Analyst decides which questions to ask about this record and answers them with the
          engine&rsquo;s own code, so every number it uses is one the engine computed. It goes
          where somebody points it, and never across the whole list.
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
            One investigation costs about <strong className="num">$0.09</strong> of live model
            credit — a measured figure, not an estimate — and takes up to a minute.
            <span className={styles.costThen}>
              It is saved when it lands, so this exception is free to open from then on, for you
              and for anyone after you. That is the reason the Analyst works one exception at a
              time rather than sweeping the list.
            </span>
          </p>
          <div className={styles.buttons}>
            <button type="button" className={styles.go} onClick={ask} disabled={busy}>
              {busy ? 'Starting…' : 'Run it'}
            </button>
            <button
              type="button"
              className={styles.cancel}
              onClick={() => setArmed(false)}
              disabled={busy}
            >
              Not now
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
