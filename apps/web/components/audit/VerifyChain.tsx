'use client';

import { useState } from 'react';
import { ApiClientError, verifyAuditChain } from '@/lib/api-client';
import { count } from '@/lib/format';
import type { ChainVerification } from '@/types/api';
import styles from './VerifyChain.module.css';

/**
 * ui-spec §6 — CHAIN VERIFICATION IS A BUTTON, not a background check.
 *
 * Running it live in front of a panel is a stronger demonstration than any
 * description of the database trigger that enforces it, and it takes one click.
 * The whole argument of an append-only hash-chained log is that you can
 * recompute it and see that it matches; a page that just asserted "chain valid"
 * would be making exactly the kind of unverifiable claim this project exists to
 * avoid.
 *
 * A FAILING VERIFICATION IS RENDERED AS PROMINENTLY AS A PASSING ONE, with the
 * divergence point named. A verifier that can only report success is not a
 * verifier.
 */
export function VerifyChain({ runId }: { runId: string }) {
  const [result, setResult] = useState<ChainVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await verifyAuditChain(runId));
    } catch (err) {
      setError(err instanceof ApiClientError
        ? `${err.code} (${err.status}) at ${err.path} — ${err.message}`
        : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.top}>
        <button type="button" className={styles.button} onClick={run} disabled={busy}>
          {busy ? 'Recomputing…' : 'Verify Audit Chain'}
        </button>
        <p className={styles.blurb}>
          Recomputes every entry&rsquo;s hash from its contents and its predecessor, then compares
          the result against the stored chain head.
        </p>
      </div>

      {/* Async result — announced, not just drawn. */}
      <div aria-live="polite">
        {error && <p className={styles.error} role="alert">{error}</p>}

        {result && (
          <div className={`${styles.result} ${result.valid ? styles.ok : styles.bad}`}>
            <p className={styles.verdict}>
              {result.valid ? (
                <>
                  ✓ <span className="num">{count(result.entriesChecked)}</span> entries verified,
                  chain intact
                </>
              ) : (
                <>
                  ✗ Chain broken at entry{' '}
                  <span className="num">#{result.firstDivergenceSequenceNo}</span>
                  {result.divergenceKind && <> — {result.divergenceKind}</>}
                </>
              )}
            </p>

            <dl className={styles.facts}>
              <div>
                <dt>Entries</dt>
                <dd className="num">
                  {count(result.entriesChecked)} of {count(result.expectedEntryCount)} expected
                </dd>
              </div>
              <div>
                <dt>Anchored</dt>
                <dd>{result.anchored ? 'Yes' : 'No'}</dd>
              </div>
              <div className={styles.wide}>
                <dt>Chain Head</dt>
                <dd className={`num ${styles.hash}`} translate="no">{result.chainHead}</dd>
              </div>
              {result.chainHead !== result.expectedChainHead && (
                <div className={styles.wide}>
                  <dt>Expected Head</dt>
                  <dd className={`num ${styles.hash}`} translate="no">
                    {result.expectedChainHead}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
