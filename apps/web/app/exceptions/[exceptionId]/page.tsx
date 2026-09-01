import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AnalystPanel } from '@/components/exceptions/detail/AnalystPanel';
import { CandidateTable } from '@/components/exceptions/detail/CandidateTable';
import { LinkedRecords } from '@/components/exceptions/detail/LinkedRecords';
import { ResolveActions } from '@/components/exceptions/detail/ResolveActions';
import { SearchClaim } from '@/components/exceptions/detail/SearchClaim';
import { Chip, SeverityChip, ActorChip } from '@/components/ui/Chip';
import { Section } from '@/components/ui/Section';
import {
  ApiClientError, getException, getInvestigation, getInvestigationsForException,
  getTransactionAudit,
} from '@/lib/api-client';
import { at, count } from '@/lib/format';
import { hrefWith, one, resolveRun, runParam } from '@/lib/run-context';
import {
  CATEGORY_GLOSS, CATEGORY_LABEL, EXPLANATION_SOURCE_LABEL, RESOLVABILITY_GLOSS,
  RESOLVABILITY_LABEL, STATUS_LABEL, label,
} from '@/lib/taxonomy';
import styles from './detail.module.css';

/**
 * Exception detail — ui-spec §4, "where honesty is demonstrated".
 *
 * The page order is the argument:
 *   1. the verdict, with the basis of its severity
 *   2. the explanation, LABELLED with where its words came from
 *   3. why it wasn't matched — the rule-level answer, NOT subordinate to (2)
 *   4. the search claim, stating WHICH claim it is making (ADR-038)
 *   5. the source rows side by side, differing fields marked
 *   6. the Analyst, if it investigated this one
 *   7. actions
 *   8. the audit trail, collapsed
 *
 * (2) is narration and (3) is the finding. If the LLM is disabled the prose
 * becomes a template and everything below it renders identically — which is the
 * property the labelled explanation source exists to make visible.
 */

export const dynamic = 'force-dynamic';

export default async function ExceptionDetailPage(
  {
    params, searchParams,
  }: {
    params: Promise<{ exceptionId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  },
) {
  const { exceptionId } = await params;
  const sp = await searchParams;

  let exception;
  try {
    exception = await getException(exceptionId);
  } catch (err) {
    if (err instanceof ApiClientError && err.code === 'EXCEPTION_NOT_FOUND') notFound();
    throw err;
  }

  const ctx = await resolveRun(runParam(sp));
  const runId = ctx?.run.runId;
  const runQ = one(sp, 'run');

  // Persisted only — nothing on this page spends money. A detail view that
  // re-runs the agent on load empties a prepaid key in front of an audience.
  const summaries = runId ? await getInvestigationsForException(runId, exceptionId) : [];
  const first = summaries[0];
  const investigation = first ? await getInvestigation(first.investigationId) : null;

  const auditTrail = await getTransactionAudit(exception.primaryRecord.transactionId)
    .catch(() => null);

  const { evidence } = exception;
  const sev = evidence.severityBasis;

  return (
    <main id="main" className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href={hrefWith('/exceptions', { run: runQ })}>Exceptions</Link>
        <span aria-hidden="true">/</span>
        <span className={styles.crumbCurrent}>{label(CATEGORY_LABEL, exception.category)}</span>
      </nav>

      {/* ── 1 · the verdict ─────────────────────────────────────────────── */}
      <header className={styles.verdictHead}>
        <div className={styles.verdictMain}>
          <div className={styles.chips}>
            <SeverityChip severity={exception.severity} />
            <Chip>{label(STATUS_LABEL, exception.status)}</Chip>
            {exception.secondaryFlags.map((f) => (
              <Chip key={f} tone="outline">{label(CATEGORY_LABEL, f)}</Chip>
            ))}
          </div>

          <h1 className={styles.title}>{label(CATEGORY_LABEL, exception.category)}</h1>
          <p className={styles.gloss}>{CATEGORY_GLOSS[exception.category] ?? ''}</p>

          <p className={styles.severityBasis}>
            Severity <strong>{exception.severity}</strong>
            {exception.amountAtRiskDisplay === null ? (
              // Not a zero and not a blank: this category's severity is its base
              // rank, and no amount was computed to escalate it with.
              <> · base rank for this category · no amount at risk computed</>
            ) : sev?.escalated ? (
              <> · escalated from {sev.base} by {exception.amountAtRiskDisplay} at risk</>
            ) : (
              <> · {exception.amountAtRiskDisplay} at risk</>
            )}
          </p>
        </div>

        <dl className={styles.verdictMeta}>
          <div>
            <dt className="label">Amount at Risk</dt>
            {exception.amountAtRiskDisplay === null ? (
              <dd className={styles.notQuantified}>
                Not quantified
                <span className={styles.notQuantifiedWhy}>
                  A non-primary duplicate never enters the matching pool, so the classifier has
                  no amount to attribute to it. Shown as absent rather than as &#8377;0.
                </span>
              </dd>
            ) : (
              <dd className={`${styles.bigNum} num`}>{exception.amountAtRiskDisplay}</dd>
            )}
          </div>
          <div>
            <dt className="label">Worth Your Time?</dt>
            <dd className={styles.resolvability}>
              {label(RESOLVABILITY_LABEL, exception.resolvability)}
              <span className={styles.resolvabilityGloss}>
                {RESOLVABILITY_GLOSS[exception.resolvability] ?? ''}
              </span>
            </dd>
          </div>
          <div>
            <dt className="label">Detected By</dt>
            <dd className={styles.rule} translate="no">
              {exception.detectedByRule} <span className={styles.ruleVer}>v{exception.ruleVersion}</span>
            </dd>
          </div>
        </dl>
      </header>

      {/* ── 2 · the explanation, with its source labelled ───────────────── */}
      <section className={styles.explainBlock} aria-labelledby="explain-title">
        <div className={styles.explainHead}>
          <h2 id="explain-title" className="label">Plain-English Explanation</h2>
          <span className={styles.sourceTag}>
            {label(EXPLANATION_SOURCE_LABEL, exception.explanationSource)}
          </span>
        </div>

        <p className={styles.explanation}>
          {exception.explanationText ?? 'No explanation was generated for this exception.'}
        </p>

        {exception.suggestedAction && (
          <p className={styles.suggested}>
            <span className="label">Suggested Action</span>
            {exception.suggestedAction}
          </p>
        )}

        <p className={styles.explainFoot}>
          {exception.explanationSource === 'template'
            ? 'Written by a deterministic template — the model was unavailable or disabled, and '
              + 'nothing below this line changed as a result.'
            : 'The model wrote these words about a decision the rules had already made. It has no '
              + 'influence over the match, the category, or anything below.'}
          {exception.sharedExplanationCount !== null && exception.sharedExplanationCount > 0 && (
            <> This explanation is shared with{' '}
              <span className="num">{count(exception.sharedExplanationCount)}</span> other
              exceptions of the same structural shape.</>
          )}
        </p>
      </section>

      {/* ── 3 · the finding ─────────────────────────────────────────────── */}
      <Section
        id="candidates"
        title="Why It Wasn’t Matched"
        standfirst="The rule-level answer. This section renders identically when the model is disabled — the prose above is narration, this is the finding."
        aside={
          evidence.anchorStrength
            ? <>anchor <strong>{evidence.anchorStrength}</strong></>
            : undefined
        }
      >
        <CandidateTable evidence={evidence} />
      </Section>

      {(evidence.searchExhausted !== null || evidence.searchBoundExceeded) && (
        <Section
          id="search"
          title="The Decomposition Search"
          standfirst="Proving no answer exists and running out of room looking are different claims, and the interface says which one this is."
        >
          <SearchClaim evidence={evidence} />
        </Section>
      )}

      {/* ── 5 · the records, side by side ───────────────────────────────── */}
      <Section
        id="records"
        title="The Source Rows"
        standfirst="The records themselves, with fields the sources disagree about marked. Check the engine’s reasoning against the data rather than against its summary of the data."
        aside={
          <>
            <span className="num">{count(exception.relatedRecords.length + 1)}</span> records
          </>
        }
      >
        <LinkedRecords primary={exception.primaryRecord} related={exception.relatedRecords} />
      </Section>

      {/* ── 6 · the Analyst ─────────────────────────────────────────────── */}
      {investigation && (
        <Section
          id="analyst"
          title="The Analyst Investigated This"
          standfirst="An agent chose which questions to ask; the engine’s own locked code computed every number it used. Read the runtime’s recorded result beside the model’s inference — they are separate fields on purpose."
        >
          <AnalystPanel investigation={investigation} runQ={runQ} />
        </Section>
      )}

      {/* ── 7 · actions ─────────────────────────────────────────────────── */}
      <Section
        id="actions"
        title="Close This Exception"
        standfirst="A reason is required. Every closure is written into the append-only audit log beside the engine’s own decision."
      >
        <div className={styles.actionsLayout}>
          <ResolveActions exceptionId={exception.exceptionId} status={exception.status} />
          <aside className={styles.deferred}>
            <h3 className="label">Not Built: Manual Match</h3>
            <p>
              <em>&ldquo;These records are the same, the engine just couldn&rsquo;t prove it&rdquo;</em>{' '}
              is a real action and endpoint&nbsp;21 implements it. It needs a record picker across
              the whole run, and the pre-agreed degradation order cuts from the bottom. It is named
              here rather than quietly absent.
            </p>
          </aside>
        </div>
      </Section>

      {/* ── 8 · the audit trail ─────────────────────────────────────────── */}
      {auditTrail && auditTrail.entries.length > 0 && (
        <Section
          id="trail"
          title="Audit Trail"
          standfirst="Every decision recorded about this record, in the same hash-chained timeline as everything else in the run."
          aside={<><span className="num">{count(auditTrail.pagination.total)}</span> entries</>}
        >
          <details className={styles.trail}>
            <summary className="disclosure">
              <span className="disclosure-text">
                Show the {count(auditTrail.pagination.total)}-entry trail
              </span>
            </summary>
            <ol className={styles.trailList}>
              {auditTrail.entries.map((e) => (
                <li key={e.sequenceNo} className={styles.trailItem}>
                  <div className={styles.trailHead}>
                    <span className={`${styles.seq} num`}>#{e.sequenceNo}</span>
                    <code className={styles.eventType} translate="no">{e.eventType}</code>
                    <ActorChip actor={e.actorType} />
                    <span className={styles.trailTime}>{at(e.occurredAt)}</span>
                  </div>
                  {e.reason && <p className={styles.trailReason}>{e.reason}</p>}
                </li>
              ))}
            </ol>
          </details>
        </Section>
      )}
    </main>
  );
}
