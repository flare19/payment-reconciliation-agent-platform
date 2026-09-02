import { count, ms, oneDp, plural } from '@/lib/format';
import type { EngineMetrics } from '@/types/api';
import styles from './EnginePerformance.module.css';

/**
 * ui-spec §2 block 4 — throughput and the explain layer's cost.
 *
 * BOTH THROUGHPUT FIGURES OR NEITHER. The engine rate excludes database writes
 * and LLM latency; the wall-clock rate includes them. Only the first is a claim
 * about the matching engine and only the second is a claim about the product,
 * so showing one alone would answer a question nobody asked with a number
 * someone will quote.
 */
/**
 * `livePendingReview` is the CURRENT size of the review pile; `reviewBurden` is
 * what the engine deferred, frozen at run completion (ADR-041). They are
 * different questions and both are true, but the dashboard used to show only
 * the frozen one while `/review` showed only the live one, so the same run read
 * 71 here and 49 there with nothing saying why (ADR-120).
 *
 * `null` when the count could not be fetched — rendered as an absence rather
 * than silently falling back to the frozen number, which would recreate exactly
 * the ambiguity this fixes.
 */
export function EnginePerformance(
  { engine, livePendingReview }: { engine: EngineMetrics; livePendingReview: number | null },
) {
  const { throughput, llmCost, reviewBurden, aliasLearning } = engine;

  /**
   * Review only ever moves a match OUT of `pending_review` --- approve refuses
   * anything else (409 MATCH_NOT_REVIEWABLE) --- so what the engine deferred
   * minus what is still waiting is exactly what a human has decided since.
   */
  const decidedSince = livePendingReview === null
    ? null
    : reviewBurden.pendingReviewCount - livePendingReview;

  const stages = Object.entries(throughput.stageMs)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className={styles.wrap}>
      <div className={styles.panel}>
        <h3 className="label">Throughput</h3>
        <div className={styles.pair}>
          <div className={styles.rate}>
            <span className={`${styles.rateValue} num`}>{count(throughput.recordsPerSecEngine)}</span>
            <span className={styles.rateUnit}>records/sec</span>
            <span className={styles.rateWhich}>Engine</span>
          </div>
          <div className={styles.rate}>
            <span className={`${styles.rateValue} num`}>
              {oneDp(throughput.recordsPerSecWallClock)}
            </span>
            <span className={styles.rateUnit}>records/sec</span>
            <span className={styles.rateWhich}>Wall Clock</span>
          </div>
        </div>
        <p className={styles.note}>{throughput.note}</p>

        {stages.length > 0 && (
          <details className={styles.details}>
            <summary className="disclosure">
              <span className="disclosure-text">Per-stage timing</span>
            </summary>
            <table className={styles.stageTable}>
              <caption className="sr-only">Milliseconds spent in each engine stage</caption>
              <tbody>
                {stages.map(([stage, value]) => (
                  <tr key={stage}>
                    <th scope="row" className={styles.stageName} translate="no">{stage}</th>
                    <td className={`${styles.stageValue} num`}>{ms(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      <div className={styles.panel}>
        <h3 className="label">Explain Layer</h3>
        {llmCost ? (
          <>
            <p className={styles.llmLine}>
              <span className="num">{count(llmCost.apiCalls)}</span> API calls ·{' '}
              <span className="num">{count(llmCost.signaturesTotal)}</span> distinct shapes ·{' '}
              <span className="num">{count(llmCost.exceptionsExplained)}</span> exceptions explained
            </p>
            <p className={styles.note}>
              Exceptions collapse to {count(llmCost.signaturesTotal)} structural signatures — a{' '}
              <span className="num">{oneDp(llmCost.collapseRatio)}×</span> reduction — and the model
              is asked once per signature, not once per exception.
            </p>

            <dl className={styles.sourceSplit}>
              <div className={styles.source}>
                <dt>Generated</dt>
                <dd className="num">{count(llmCost.signaturesGenerated)}</dd>
              </div>
              <div className={styles.source}>
                <dt>From Cache</dt>
                <dd className="num">{count(llmCost.signaturesFromCache)}</dd>
              </div>
              <div className={styles.source}>
                <dt>Templated</dt>
                <dd className="num">{count(llmCost.signaturesTemplated)}</dd>
              </div>
            </dl>

            {llmCost.failures.length > 0 && (
              <p className={styles.degraded}>
                <strong>
                  {count(llmCost.failures.length)}{' '}
                  {plural(llmCost.failures.length, 'call failed', 'calls failed')}
                </strong>{' '}
                and every affected exception fell back to a deterministic template. The match rate,
                the exception list and the audit chain are unchanged — no decision on this page
                depends on the model.
              </p>
            )}

            <p className={styles.modelLine} translate="no">
              {llmCost.model} · prompt {llmCost.promptVersion}
            </p>
          </>
        ) : (
          <p className={styles.absent}>
            The explain stage did not run on this run, so it reports no figure — not a zero.
          </p>
        )}
      </div>

      <div className={styles.panel}>
        <h3 className="label">Review Burden</h3>
        <p className={styles.llmLine}>
          <span className="num">{count(reviewBurden.pendingReviewCount)}</span> groups ·{' '}
          <span className="num">{count(reviewBurden.pendingReviewRecords)}</span> records
        </p>
        <p className={styles.note}>
          <span className="num">{oneDp(reviewBurden.per100Records)}</span> proposals per 100 records
          for a human to judge, as the engine left them. These are excluded from the match rate
          rather than counted toward it — a proposal is not a match.
        </p>
        {livePendingReview !== null && decidedSince !== null && (
          <p className={styles.note}>
            {decidedSince > 0 ? (
              <>
                <span className="num">{count(decidedSince)}</span>{' '}
                {decidedSince === 1 ? 'has' : 'have'} since been decided by a reviewer, so{' '}
                <span className="num">{count(livePendingReview)}</span> are still waiting. The
                figure above is the engine’s own, frozen when the run finished; it does not move
                when somebody clicks.
              </>
            ) : (
              <>Nobody has decided one yet, so all{' '}
              <span className="num">{count(livePendingReview)}</span> are still waiting.</>
            )}
          </p>
        )}

        <h3 className={`label ${styles.subhead}`}>Alias Learning</h3>
        {aliasLearning.humanCorrectionsToDate > 0 ? (
          <p className={styles.note}>
            <span className="num">{count(aliasLearning.humanCorrectionsToDate)}</span> human
            corrections have auto-resolved{' '}
            <span className="num">{count(aliasLearning.recordsAutoResolvedByAliases)}</span> records
            {aliasLearning.leverageRatio !== null && (
              <> — a leverage ratio of <span className="num">{oneDp(aliasLearning.leverageRatio)}</span></>
            )}.
          </p>
        ) : (
          <p className={styles.note}>
            No aliases have been taught yet, so there is no leverage ratio to report. This is the
            cold run the headline names.
          </p>
        )}
      </div>
    </div>
  );
}
