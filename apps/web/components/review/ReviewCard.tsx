'use client';

import { useEffect, useState } from 'react';
import { ScoreBars } from '@/components/ui/ScoreBars';
import { ApiClientError, approveMatch, rejectMatch } from '@/lib/api-client';
import { count, day, ratio4 } from '@/lib/format';
import { SOURCE_LABEL, TIER_LABEL, label } from '@/lib/taxonomy';
import type { ReviewItem } from '@/types/api';
import styles from './ReviewCard.module.css';

/**
 * ONE ITEM AT A TIME, NOT A TABLE (ui-spec §5).
 *
 * This is a decision-making screen. A table invites bulk-approving without
 * reading, which is the exact behaviour that poisons a learning loop: an alias
 * taught from a match nobody looked at becomes a rule that silently
 * mis-resolves every future run. The queue is deliberately slower to work
 * through than it could be.
 *
 * THE CONFLICT INTERLOCK IS NEVER AUTO-RETRIED (ADR-025). A `409` means the
 * proposed alias contradicts an active rule; the server holds back the alias
 * write, approves the match anyway, and returns the existing mapping. The UI
 * shows what it would replace and requires a second, explicit click. Silently
 * re-sending with `confirmConflict: true` would turn a safety interlock into a
 * speed bump nobody sees.
 */
export function ReviewCard(
  { item, total, page, onCompleted }:
  {
    item: ReviewItem;
    total: number;
    page: number;
    /**
     * Called on a recorded decision. The PARENT owns what happens next —
     * this component is keyed on `matchId` and unmounts the moment the queue
     * advances, so a confirmation kept here would erase itself on success.
     */
    onCompleted: (message: string) => void;
  },
) {
  const [reviewedBy, setReviewedBy] = useState('');
  const [note, setNote] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [teachAlias, setTeachAlias] = useState(false);
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<null | { existing: string; proposed: string }>(null);

  const suggestion = item.aliasSuggestions[0];
  const who = () => reviewedBy.trim() || 'unattributed reviewer';

  /**
   * TEACHING AND REJECTING ARE MUTUALLY EXCLUSIVE, MADE STRUCTURALLY TRUE
   * RATHER THAN MERELY DISCOURAGED -- the same discipline ADR-025's conflict
   * interlock already holds this screen to.
   *
   * `approve()` is the only path that ever reads `teachAlias`, so a stray
   * checked box was never actually reachable through `reject()` -- but a
   * reviewer typing a rejection reason with "teach this alias" still visibly
   * checked reads as a contradiction on screen even when it is inert underneath,
   * and inviting that reading is itself the defect (Tejas, 2026-09-03). Once a
   * rejection reason exists, teaching is force-cleared, not merely disabled --
   * so the STATE agrees with the checkbox, not just its interactivity.
   */
  const rejecting = rejectReason.trim() !== '';
  useEffect(() => {
    if (rejecting) setTeachAlias(false);
  }, [rejecting]);

  async function approve(confirmConflict: boolean) {
    setBusy('approve');
    setError(null);
    try {
      const proposals = teachAlias && suggestion
        ? [{ ...suggestion, confirmConflict }]
        : undefined;
      const res = await approveMatch(item.matchId, {
        reviewedBy: who(),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(proposals ? { aliasProposals: proposals } : {}),
      });
      setConflict(null);
      onCompleted(
        res.aliasesCreated.length > 0
          ? `Approved, and taught ${count(res.aliasesCreated.length)} alias — it will resolve `
            + 'matching records on every future run.'
          : 'Approved. The match is now human-confirmed and counts toward the match rate.',
      );
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'ALIAS_CONFLICT_UNCONFIRMED') {
        // The match IS approved; only the alias write was held back.
        setConflict({
          existing: err.message,
          proposed: suggestion ? `${suggestion.rawValue} → ${suggestion.canonicalValue}` : '',
        });
      } else {
        setError(err instanceof ApiClientError
          ? `${err.code} (${err.status}) at ${err.path} — ${err.message}` : String(err));
      }
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy('reject');
    setError(null);
    try {
      await rejectMatch(item.matchId, { reviewedBy: who(), reason: rejectReason.trim() });
      onCompleted('Rejected. Its records return to the exception pool with your reason attached.');
    } catch (err) {
      setError(err instanceof ApiClientError
        ? `${err.code} (${err.status}) at ${err.path} — ${err.message}` : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className={styles.card}>
      <header className={styles.head}>
        <div>
          <p className="label">Proposal {page} of {count(total)}</p>
          <p className={styles.why}>{item.whyFlagged}</p>
        </div>
        <div className={styles.confidence}>
          <span className="label">Score</span>
          <span className={`${styles.confidenceValue} num`}>{ratio4(item.confidence)}</span>
          <span className={styles.tier}>{label(TIER_LABEL, item.tier)}</span>
        </div>
      </header>

      <section className={styles.members} aria-label="Records in this proposal">
        {item.members.map((m) => (
          <div key={m.transactionId} className={styles.member}>
            <span className={styles.role}>
              {label(SOURCE_LABEL, 'role' in m ? String(m.role) : '')}
            </span>
            <span className={`${styles.extId} num`} translate="no">{m.externalId ?? '—'}</span>
            <span className={`${styles.amount} num`}>{m.amountDisplay}</span>
            <span className={styles.date}>{day(m.txnDate)}</span>
            <span className={styles.counterparty} translate="no">{m.counterpartyRaw ?? '—'}</span>
          </div>
        ))}
      </section>

      <section className={styles.score} aria-label="Score breakdown">
        <h3 className="label">Why It Scored What It Did</h3>
        <ScoreBars breakdown={item.scoreBreakdown} total={item.confidence} />
      </section>

      {suggestion && (
        <section className={styles.alias}>
          <label className={`${styles.aliasToggle} ${rejecting ? styles.aliasToggleOff : ''}`}>
            <input
              type="checkbox"
              checked={teachAlias}
              disabled={rejecting}
              onChange={(e) => setTeachAlias(e.target.checked)}
            />
            <span>
              <strong>
                Teach{' '}
                <span translate="no">{suggestion.rawValue} → {suggestion.canonicalValue}</span>
              </strong>
              {/* The number that makes the learning loop legible in a demo. */}
              <span className={styles.wouldAlsoResolve}>
                Would also resolve{' '}
                <span className="num">{count(suggestion.wouldAlsoResolve)}</span> other
                {suggestion.wouldAlsoResolve === 1 ? ' record' : ' records'} in this run.
              </span>
              {rejecting && (
                <span className={styles.aliasOffNote}>
                  Not available while rejecting this match — a rule is only learned from a
                  confirmed match. Clear the rejection reason to teach it instead.
                </span>
              )}
            </span>
          </label>
        </section>
      )}

      {conflict && (
        <div className={styles.conflict} role="alert">
          <p className={styles.conflictTitle}>This contradicts an existing rule.</p>
          <p className={styles.conflictBody}>{conflict.existing}</p>
          <p className={styles.conflictNote}>
            <strong>The match was approved.</strong> Only the alias was held back — a judgement
            about this match is never discarded over a disagreement about a general rule.
          </p>
          <button
            type="button"
            className={styles.replace}
            onClick={() => approve(true)}
            disabled={busy !== null}
          >
            Replace the Existing Rule
          </button>
        </div>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}

      <footer className={styles.actions}>
        <div className={styles.field}>
          <label htmlFor="reviewedBy">Your name</label>
          <input
            id="reviewedBy" type="text" autoComplete="name" spellCheck={false}
            placeholder="e.g. T. Lokhande…"
            value={reviewedBy} onChange={(e) => setReviewedBy(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="note">Note <span className={styles.optional}>optional</span></label>
          <input
            id="note" type="text" autoComplete="off"
            placeholder="What convinced you?…"
            value={note} onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="rejectReason">
            Rejection reason <span className={styles.required}>required to reject</span>
          </label>
          <input
            id="rejectReason" type="text" autoComplete="off"
            placeholder="Why is this not the same payment?…"
            value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
          />
        </div>

        <div className={styles.buttons}>
          <button
            type="button" className={styles.approve}
            onClick={() => approve(false)} disabled={busy !== null}
          >
            {busy === 'approve' ? 'Approving…' : 'Approve Match'}
          </button>
          <button
            type="button" className={styles.reject}
            onClick={reject} disabled={busy !== null || rejectReason.trim() === ''}
          >
            {busy === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </footer>
    </article>
  );
}
