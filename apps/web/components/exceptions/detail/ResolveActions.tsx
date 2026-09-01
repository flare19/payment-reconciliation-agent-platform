'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiClientError, resolveException } from '@/lib/api-client';
import styles from './ResolveActions.module.css';

/**
 * ui-spec §4 item 6 — the two actions that turn this screen from a report into
 * a workflow (ADR-043).
 *
 * A NOTE IS REQUIRED, not optional, and the submit button stays disabled until
 * there is one. `exceptions.status` permits `human_resolved` and `wont_fix`, and
 * either of them is a human overruling or accepting the engine's finding — an
 * audit log entry saying "somebody closed this, reason unknown" is worth very
 * little, and this is the one system in the project where every other decision
 * carries its reason.
 *
 * `reviewedBy` is free text because there is no auth (ARCHITECTURE §5). That is
 * a real limitation and the field says so rather than defaulting to something
 * that looks like an identity.
 *
 * MANUAL MATCH (endpoint 21) IS NOT HERE. It needs a record picker across the
 * whole run, and ui-spec §8's degradation order cuts from the bottom of
 * priority 1 first. It is the one thing on this screen that is deferred, and it
 * is named rather than quietly absent.
 */
export function ResolveActions(
  { exceptionId, status }: { exceptionId: string; status: string },
) {
  const router = useRouter();
  const [resolution, setResolution] = useState<'human_resolved' | 'wont_fix'>('human_resolved');
  const [note, setNote] = useState('');
  const [resolvedBy, setResolvedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyClosed = status === 'human_resolved' || status === 'wont_fix';

  if (alreadyClosed) {
    return (
      <p className={styles.closed}>
        This exception is closed as <strong>{status.replace('_', ' ')}</strong>. Reopening is not
        possible — the audit log is append-only, and a new decision would be a new entry rather
        than an edit to this one.
      </p>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await resolveException(exceptionId, {
        resolvedBy: resolvedBy.trim() || 'unattributed reviewer',
        resolution,
        note: note.trim(),
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError
        ? `${err.code} (${err.status}) at ${err.path} — ${err.message}`
        : String(err));
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <fieldset className={styles.fieldset} disabled={busy}>
        <legend className="sr-only">Close this exception</legend>

        <div className={styles.choices}>
          <label className={styles.choice}>
            <input
              type="radio"
              name="resolution"
              value="human_resolved"
              checked={resolution === 'human_resolved'}
              onChange={() => setResolution('human_resolved')}
            />
            <span>
              <strong>Resolve</strong>
              <span className={styles.choiceNote}>
                The discrepancy is understood and dealt with outside this system.
              </span>
            </span>
          </label>

          <label className={styles.choice}>
            <input
              type="radio"
              name="resolution"
              value="wont_fix"
              checked={resolution === 'wont_fix'}
              onChange={() => setResolution('wont_fix')}
            />
            <span>
              <strong>Won&rsquo;t Fix</strong>
              <span className={styles.choiceNote}>
                Real, and deliberately not being actioned.
              </span>
            </span>
          </label>
        </div>

        <div className={styles.field}>
          <label htmlFor="resolvedBy">Your name</label>
          <input
            id="resolvedBy"
            name="resolvedBy"
            type="text"
            autoComplete="name"
            spellCheck={false}
            placeholder="e.g. T. Lokhande…"
            value={resolvedBy}
            onChange={(e) => setResolvedBy(e.target.value)}
          />
          <p className={styles.hint}>
            Free text — there is no authentication in this build, so this is an assertion rather
            than an identity.
          </p>
        </div>

        <div className={styles.field}>
          <label htmlFor="note">Reason <span className={styles.required}>required</span></label>
          <textarea
            id="note"
            name="note"
            rows={3}
            autoComplete="off"
            value={note}
            placeholder="Why is this being closed? e.g. Confirmed with the bank; settlement posted late…"
            onChange={(e) => setNote(e.target.value)}
          />
          <p className={styles.hint}>
            Written verbatim into the append-only audit log beside the engine&rsquo;s own decision.
          </p>
        </div>

        {error && (
          <p className={styles.error} role="alert">{error}</p>
        )}

        <button type="submit" className={styles.submit} disabled={note.trim() === ''}>
          {busy
            ? 'Recording…'
            : resolution === 'human_resolved' ? 'Resolve Exception' : 'Mark Won’t Fix'}
        </button>
      </fieldset>
    </form>
  );
}
