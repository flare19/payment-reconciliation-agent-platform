'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiClientError, getRun, startRun } from '@/lib/api-client';
import styles from './RunLauncher.module.css';

/**
 * Start a reconciliation run, in front of an audience, without spending
 * anything you did not agree to spend.
 *
 * "Here is what it does" beats "here is what it would do", so the run button
 * earns its place on the landing page — a judge watching 920 records go
 * `ingesting → matching → classifying → explaining → completed` in a couple of
 * seconds has seen the product work rather than been told about it.
 *
 * THE ENGINE IS FREE. Matching, classification, group assembly and the audit
 * chain involve no model at all. The ONLY spend in a run is S13, the explain
 * layer, which turns 212 exceptions into ~21 structural signatures and asks the
 * model once per signature — capped at `llmMaxCallsPerRun`, about $0.03.
 *
 * So the choice is exposed rather than assumed, and it defaults to OFF. A
 * stranger who clicks the most prominent button on the site should not be able
 * to spend money by doing it, and the run is still fully demonstrable without
 * explanations: every match, every exception, every audit entry and the whole
 * measured accuracy report are produced identically either way. That is ADR-017
 * — the model narrates decisions the rules already made — and this control is
 * where a viewer can prove it to themselves by running it both ways.
 *
 * THE SIGNATURE CACHE MAKES THE SECOND RUN NEARLY FREE, and that is worth
 * saying out loud rather than leaving as a surprise: signatures are bucketed
 * shapes with no record identity in them, so a rerun — and, later, a run over a
 * freshly generated dataset — mostly hits explanations that already exist.
 */
export function RunLauncher({ explainAvailable }: { explainAvailable: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [explain, setExplain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
  }, []);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const run = await startRun({
        label: `demo-${new Date().toISOString().slice(0, 16).replace('T', '-')}`,
        configOverrides: { llmExplainEnabled: explain },
      });
      setStage('pending');

      // 202-then-poll (api-contract §5). 750 ms is inside the read tier's
      // 120/min allowance and a run completes in ~3 s, so this is a handful of
      // requests, not a stream.
      const started = Date.now();
      const poll = window.setInterval(async () => {
        if (Date.now() - started > 120_000) {
          window.clearInterval(poll);
          setError('The run has not reported completion in two minutes. It may still be going — '
            + 'reload to see where it got to.');
          setBusy(false);
          return;
        }
        try {
          const now = await getRun(run.runId);
          setStage(now.progress.stage);
          if (now.status === 'completed') {
            window.clearInterval(poll);
            setBusy(false);
            setOpen(false);
            router.push(`/?run=${run.runId}`);
            router.refresh();
          } else if (now.status === 'failed') {
            window.clearInterval(poll);
            setBusy(false);
            setError('The run failed. Its partial results are still readable — matches and '
              + 'exceptions produced before the failure are preserved.');
          }
        } catch {
          // A single poll failing is not the run failing. Keep polling; the
          // outer timeout is what gives up.
        }
      }, 750);
      pollRef.current = poll;
    } catch (err) {
      setError(err instanceof ApiClientError
        ? `${err.code} (${err.status}) at ${err.path} — ${err.message}`
        : String(err));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={styles.open} onClick={() => setOpen(true)}>
        Run It Again
      </button>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3 className={styles.title}>Reconcile the dataset again</h3>
        <button
          type="button"
          className={styles.close}
          onClick={() => setOpen(false)}
          disabled={busy}
          aria-label="Close the run launcher"
        >
          ×
        </button>
      </div>

      <p className={styles.body}>
        Reads the three committed source files and runs every stage from ingestion to the audit
        chain. Takes about two seconds and <strong>costs nothing</strong> — no model is involved in
        matching, classifying, or auditing anything.
      </p>

      <label className={`${styles.choice} ${!explainAvailable ? styles.choiceOff : ''}`}>
        <input
          type="checkbox"
          checked={explain}
          disabled={busy || !explainAvailable}
          onChange={(e) => setExplain(e.target.checked)}
        />
        <span>
          <strong>Also write plain-English explanations</strong>
          <span className={styles.choiceNote}>
            {explainAvailable
              ? <>Adds roughly <span className="num">$0.03</span> of Anthropic credit — the 212
                exceptions collapse to about 21 structural shapes and the model is asked once per
                shape. Explanations already generated are reused, so a second run is close to
                free. Leave it off and every exception still gets a deterministic template; no
                match, no number, and no audit entry changes either way.</>
              : <>Unavailable — this deployment has no API key configured. The run still produces
                every match, exception and audit entry, with template explanations.</>}
          </span>
        </span>
      </label>

      <div className={styles.actions}>
        <button type="button" className={styles.go} onClick={go} disabled={busy}>
          {busy ? `Running… ${stage ?? ''}` : explain ? 'Run and spend ~$0.03' : 'Run for free'}
        </button>
        <button
          type="button"
          className={styles.cancel}
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          Cancel
        </button>
      </div>

      <div aria-live="polite">
        {busy && stage && (
          <p className={styles.stage}>
            <span className={styles.stageName}>{stage}</span>
            {' — this page will switch to the new run when it finishes.'}
          </p>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    </div>
  );
}
