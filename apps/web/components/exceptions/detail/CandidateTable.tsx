import { count, day, ratio4 } from '@/lib/format';
import { SOURCE_LABEL, label } from '@/lib/taxonomy';
import type { ExceptionEvidence } from '@/types/api';
import styles from './CandidateTable.module.css';

/**
 * WHY IT WASN'T MATCHED — the rule-level answer.
 *
 * ui-spec §4 is emphatic that this section must NOT be visually subordinate to
 * the prose above it: the explanation is narration, this is the finding. It
 * renders identically when the LLM is disabled, which is the whole point — the
 * engine's reasoning is here whether or not a model was available to describe it.
 *
 * `rejectedBecause` is printed VERBATIM. Paraphrasing an engine's stated reason
 * would be editing a finding, and the sentences it produces ("tied with another
 * candidate to within 0; refusing to choose is preferable to a confident wrong
 * match") already say the thing this project is arguing.
 */
export function CandidateTable({ evidence }: { evidence: ExceptionEvidence }) {
  const candidates = evidence.candidates ?? [];

  if (candidates.length === 0) {
    return (
      <p className={styles.none}>
        {typeof evidence.candidatesConsidered === 'number' && evidence.candidatesConsidered > 0 ? (
          <>
            The engine scored{' '}
            <span className="num">{count(evidence.candidatesConsidered)}</span> records against this
            one and none reached the logging floor. That is a different statement from{' '}
            <em>it did not look</em> — the search ran, and nothing in range was close enough to be
            worth recording.
          </>
        ) : (
          <>
            No candidate was in range to score. Blocking produced nothing comparable within the
            date window and amount band for this record, so there is no rejected shortlist to
            show — which is itself the finding.
          </>
        )}
      </p>
    );
  }

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className="sr-only">
          Candidates the engine considered, with the reason each was rejected
        </caption>
        <thead>
          <tr>
            <th scope="col" className={styles.numCol}>Score</th>
            <th scope="col">Candidate</th>
            <th scope="col" className={styles.numCol}>Amount</th>
            <th scope="col">Date</th>
            <th scope="col">Rejected Because</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => (
            <tr key={c.transactionId}>
              <td className={`${styles.numCol} num ${styles.score}`}>{ratio4(c.score)}</td>
              <td className={styles.candCell}>
                <span className={styles.source}>{label(SOURCE_LABEL, c.sourceSystem)}</span>
                <span className={`${styles.extId} num`} translate="no">
                  {c.preview?.externalId ?? c.transactionId.slice(0, 8)}
                </span>
              </td>
              <td className={`${styles.numCol} num`}>{c.preview?.amountDisplay ?? '—'}</td>
              <td className={styles.dateCell}>
                {c.preview?.txnDate ? day(c.preview.txnDate) : '—'}
              </td>
              <td className={styles.reasonCell}>{c.rejectedBecause ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {evidence.candidateCapHit === true && (
        <p className={styles.capNote}>
          <strong>The candidate list was truncated.</strong> Scoring stopped at the configured cap,
          so this table is the top of a longer list rather than all of it. A better candidate may
          exist below the cut.
        </p>
      )}
    </div>
  );
}
