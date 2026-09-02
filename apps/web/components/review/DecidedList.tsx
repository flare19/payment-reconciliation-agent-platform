import Link from 'next/link';
import { Chip } from '@/components/ui/Chip';
import table from '@/components/ui/table.module.css';
import { at, count } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import { SOURCE_LABEL, label } from '@/lib/taxonomy';
import type { MatchSummary } from '@/types/api';
import styles from './DecidedList.module.css';

/**
 * WHAT HAPPENED TO THE PROPOSALS SOMEBODY ALREADY DECIDED.
 *
 * Approving or rejecting removed a proposal from `/review` and it then appeared
 * NOWHERE but the audit chain — on a product whose argument is that every
 * decision carries its reason, the human decisions were the ones that
 * disappeared. Same defect as ADR-122 for exceptions, and it needed no new
 * endpoint: `matches` already stored `reviewed_by`, `reviewed_at` and
 * `review_note`, endpoint 8 already took `?status=`, and only the serializer
 * was dropping them (ADR-124).
 *
 * A REJECTED PROPOSAL KEEPS ITS ROW. Endpoint 11 returns its *members* to the
 * exception pool; it does not delete the match. So both halves of the decision
 * are readable here, which is the point — a queue that showed only approvals
 * would make the reviewer look like a rubber stamp.
 */
export function DecidedList(
  { decided, runQ }: { decided: MatchSummary[]; runQ: string | undefined },
) {
  if (decided.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>Nobody has decided a proposal on this run yet.</p>
        <p className={styles.emptyBody}>
          Approving or rejecting one in the queue records who decided it, when, and — for a
          rejection — why. Those decisions appear here and in the audit trail, both permanently.
        </p>
      </div>
    );
  }

  return (
    <div className={table.scroller}>
      <table className={table.table}>
        <caption className="sr-only">Proposals a human has decided</caption>
        <thead>
          <tr>
            <th scope="col">Decision</th>
            <th scope="col">Match</th>
            <th scope="col" className={styles.numCol}>Amount</th>
            <th scope="col">Reviewer</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {decided.map((m) => {
            const r = m.review;
            return (
              <tr key={m.matchId}>
                <td>
                  <Chip tone={r?.decision === 'human_rejected' ? 'outline' : 'verified'}>
                    {r?.decision === 'human_rejected' ? 'Rejected' : 'Approved'}
                  </Chip>
                </td>

                <td className={styles.matchCell}>
                  <span className={styles.members}>
                    {m.members.map((mem) => (
                      <span key={mem.transactionId} className={styles.member}>
                        <Link href={hrefWith(`/records/${mem.transactionId}`, { run: runQ })}>
                          {label(SOURCE_LABEL, mem.role)}
                        </Link>
                        <span className={`${styles.extId} num`} translate="no">
                          {mem.externalId ?? '—'}
                        </span>
                      </span>
                    ))}
                  </span>
                  <span className={styles.meta}>
                    {m.tier} · confidence <span className="num">{m.confidence.toFixed(2)}</span>
                  </span>
                </td>

                <td className={`${styles.numCol} num`}>{m.headlineAmountDisplay}</td>

                <td className={styles.whoCell}>
                  <span translate="no">{r?.reviewedBy ?? '—'}</span>
                  {r !== null && <span className={styles.when}>{at(r.reviewedAt)}</span>}
                </td>

                {/*
                  NO NOTE IS A REAL STATE, NOT A RENDERING GAP. Endpoint 10
                  takes an OPTIONAL note, so an approval may legitimately carry
                  no words; endpoint 11 requires a reason, so a rejection always
                  has one. Writing "Approved" here as though it were a stated
                  reason would manufacture a justification nobody gave.
                */}
                <td className={styles.noteCell}>
                  {r?.note != null && r.note !== ''
                    ? <q className={styles.note}>{r.note}</q>
                    : (
                      <span className={styles.noNote}>
                        {r?.decision === 'human_rejected'
                          ? 'no reason recorded'
                          : 'none given — approving does not require one'}
                      </span>
                    )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={styles.footnote}>
        <span className="num">{count(decided.length)}</span>{' '}
        {decided.length === 1 ? 'decision' : 'decisions'}, newest first. Each also has an
        append-only entry in the{' '}
        <Link href={hrefWith('/audit', { run: runQ, actorType: 'human' })}>audit trail</Link>,
        which is the record of authority; this screen is the readable view of it.
      </p>
    </div>
  );
}
