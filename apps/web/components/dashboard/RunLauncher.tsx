'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiClientError, getRun, startRun } from '@/lib/api-client';
import type { SeedDatasetOption } from '@/types/api';
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
 * THIS BUTTON CANNOT SPEND ANYTHING, AND THE CHOICE THAT COULD IS GONE
 * (ADR-129). It previously offered an opt-in explain pass — defaulted off,
 * about $0.03 — and the option is removed rather than merely defaulted,
 * because the most prominent control on a public unauthenticated demo should
 * not have a path to spending real credit at all. Every run is now
 * `llmExplainEnabled: false`: every exception still gets its deterministic
 * template, and no match, number or audit entry differs either way (ADR-017).
 * Plain-English explanation stays available on demand, per exception, behind
 * the Analyst's own confirmation — which is where a human has already decided
 * to spend.
 *
 * WHAT IT DOES OFFER INSTEAD IS THE DATASET. Nine of the first ten runs
 * reconciled byte-identical input and reported the same match rate, because
 * `datasetSeed` worked at the API (ADR-118) and the launcher could not ask for
 * anything else — so "Run It Again" could only ever reproduce one number, which
 * reads as broken rather than as deterministic.
 *
 * PLACEMENT, NOT A REBUILD (F19, ADR-145). The functionality above shipped on
 * F9.4 and was already exercised end to end by F10 — this only moves it and
 * gives the resting state presence. `variant="hero"` renders the same closed
 * button with more visual weight and a slow pulse; `variant="compact"` (the
 * default) is the smaller neutral one, kept for anywhere the launcher is
 * secondary to what's already on screen. The panel that opens is identical
 * either way — same fields, same poll, same `router.push` onto the finished
 * run's OWN metrics rather than the previous run's, which is the one part of
 * backlog item 12 that was never a placement question.
 */
export function RunLauncher(
  { datasets, variant = 'compact' }: { datasets: SeedDatasetOption[]; variant?: 'compact' | 'hero' },
) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<number | undefined>(datasets[0]?.seed);
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
      // The label NAMES THE DATASET IT RAN. It used to read `demo-<timestamp>`
      // on every run while reconciling the holdout — and now that a committed
      // dataset is actually called `demo`, that label was a false statement.
      const name = datasets.find((d) => d.seed === seed)?.label ?? 'holdout';
      const run = await startRun({
        label: `${name}-${new Date().toISOString().slice(0, 16).replace('T', '-')}`,
        ...(seed === undefined ? {} : { datasetSeed: seed }),
        configOverrides: { llmExplainEnabled: false },
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
      <button
        type="button"
        className={`${styles.open} ${variant === 'hero' ? styles.openHero : ''}`}
        onClick={() => setOpen(true)}
      >
        {variant === 'hero' && <span className={styles.pulse} aria-hidden="true" />}
        Run It Again — Free
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
        matching, classifying, or auditing anything, and explanations are deterministic templates.
        Plain English from a model is available per exception, on request, from the Analyst.
      </p>

      {/*
        THE DATASET LIST COMES FROM `/api/health` (ADR-129). If that call failed
        the array is empty, and an empty panel with a working Run button would
        start a holdout run while appearing to offer no choice at all — the
        reader would have no way to know which dataset they just reconciled.
        Say so instead.
      */}
      {datasets.length === 0 && (
        <p className={styles.body}>
          The dataset list could not be loaded, so there is nothing to choose between. Running now
          would reconcile the default dataset without saying which one — reload to try again.
        </p>
      )}

      {datasets.map((d) => (
        <label key={d.seed} className={styles.choice}>
          <input
            type="radio"
            name="dataset"
            value={d.seed}
            checked={seed === d.seed}
            disabled={busy}
            onChange={() => setSeed(d.seed)}
          />
          <span>
            <strong translate="no">{d.label}</strong>
            <span className={styles.choiceNote}>
              {d.label === 'holdout'
                ? <>The dataset every reported number in this project is measured against
                  (seed <span className="num">{d.seed}</span>). Running it again reproduces the
                  same figures exactly — the engine is a pure function of its inputs, so a run
                  that drifted would mean no measurement here could be trusted.</>
                : <>A second committed dataset with its own answer key
                  (seed <span className="num">{d.seed}</span>). Different payments, same
                  generator and the same difficulty mix — so the numbers differ and are still
                  comparable.</>}
            </span>
          </span>
        </label>
      ))}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.go}
          onClick={go}
          disabled={busy || datasets.length === 0}
        >
          {busy ? `Running… ${stage ?? ''}` : 'Run for free'}
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
