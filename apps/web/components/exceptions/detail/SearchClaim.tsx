import { count } from '@/lib/format';
import type { ExceptionEvidence } from '@/types/api';
import styles from './SearchClaim.module.css';

/**
 * `searchExhausted` AND `searchBoundExceeded` ARE DIFFERENT CLAIMS (ADR-038),
 * and this component exists so the interface says which one it is making.
 *
 *   exhausted     — the engine PROVED no subset of the candidate pool sums to
 *                   this credit, inside its declared bounds. A negative result,
 *                   and a real one.
 *   bound exceeded — the engine ran out of search room and stopped. A
 *                   decomposition may exist; it was not disproved.
 *
 * Collapsing these into one sentence turns a proof into a shrug, or worse, a
 * shrug into a proof. The second is the failure this project cannot afford, and
 * it is precisely the case the Analyst exists to revisit — so it is rendered as
 * the weaker claim it is, in the tone of an open question.
 */
export function SearchClaim({ evidence }: { evidence: ExceptionEvidence }) {
  const { searchExhausted, searchBoundExceeded, candidateSubsets } = evidence;

  if (searchBoundExceeded) {
    const { bound, value, poolSize } = searchBoundExceeded;
    return (
      <div className={`${styles.claim} ${styles.weak}`}>
        <p className="label">Search Stopped on a Bound</p>
        <p className={styles.headline}>
          Stopped on its <strong>{bound}</strong> bound at{' '}
          <span className="num">{count(value)}</span>
          {typeof poolSize === 'number' && (
            <> over <span className="num">{count(poolSize)}</span> candidate payments</>
          )}
          .
        </p>
        <p className={styles.body}>
          A decomposition <em>may</em> exist. It was not found and it was not disproved — the
          search ran out of room first. This is a weaker statement than a proof, and it is stated
          separately so nobody reads it as one.
        </p>
      </div>
    );
  }

  if (searchExhausted === true) {
    return (
      <div className={`${styles.claim} ${styles.strong}`}>
        <p className="label">Search Proved Exhaustive</p>
        <p className={styles.headline}>
          {typeof candidateSubsets === 'number' ? (
            <>
              Searched all <span className="num">{count(candidateSubsets)}</span> combinations of
              the candidate pool. No subset matches this credit.
            </>
          ) : (
            <>Searched the whole candidate pool. No subset matches this credit.</>
          )}
        </p>
        <p className={styles.body}>
          This is a proof, not a timeout: the engine enumerated the declared space and the
          decomposition is not in it. Widening the search would not help, and the Analyst agreeing
          with that is a result rather than an empty answer.
        </p>
      </div>
    );
  }

  return null;
}
