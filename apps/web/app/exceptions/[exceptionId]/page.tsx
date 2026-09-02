import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AnalystPanel } from '@/components/exceptions/detail/AnalystPanel';
import { AskAnalyst } from '@/components/exceptions/detail/AskAnalyst';
import { CandidateTable } from '@/components/exceptions/detail/CandidateTable';
import { LinkedRecords } from '@/components/exceptions/detail/LinkedRecords';
import { ResolveActions } from '@/components/exceptions/detail/ResolveActions';
import { SearchClaim } from '@/components/exceptions/detail/SearchClaim';
import { Chip, SeverityChip, ActorChip } from '@/components/ui/Chip';
import { Section } from '@/components/ui/Section';
import {
  ApiClientError, getException, getInvestigationsForException,
  getTransactionAudit, resolveCitation,
} from '@/lib/api-client';
import { at, count } from '@/lib/format';
import { hrefWith, one } from '@/lib/run-context';
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

  const runQ = one(sp, 'run');

  // THE EXCEPTION'S OWN RUN, not the page's. `resolveRun` answers "which run is
  // this screen about", which is the wrong question here: this screen is about
  // one exception, and that exception belongs to exactly one run whatever the
  // reader last selected. Using the resolved run meant that as soon as a second
  // run existed, every exception from the older one looked uninvestigated — the
  // investigations were real, they were being sought under the wrong run id.
  const runId = exception.runId;

  // Persisted only — nothing on this page spends money. A detail view that
  // re-runs the agent on load empties a prepaid key in front of an audience.
  const summaries = await getInvestigationsForException(runId, exceptionId);
  // Endpoint 26 already returns FULL investigation objects, reasoning chain
  // included, so re-fetching the same row through endpoint 27 was a second
  // request buying nothing — and every saved request is headroom against the
  // read rate limit this page was quietly exhausting.
  const investigation = summaries[0] ?? null;

  // Resolved here, once per distinct id, so the panel never has to guess what
  // kind of thing a citation points at.
  const citations = investigation
    ? await Promise.all([...new Set(investigation.citations)].map(resolveCitation))
    : [];

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
        standfirst="What the rules decided, and what they compared."
        basis={{
          summary: 'This part does not need the model',
          body:
            'Everything in this section is produced by the matching rules, and it renders identically '
            + 'when the model is switched off. The prose higher up the page is narration of this finding; '
            + 'this is the finding itself.',
        }}
        aside={
          evidence.anchorStrength
            ? <><strong>{evidence.anchorStrength === 'none' ? 'no' : evidence.anchorStrength}</strong> reference ID</>
            : undefined
        }
      >
        <CandidateTable evidence={evidence} />
      </Section>

      {(evidence.searchExhausted !== null || evidence.searchBoundExceeded) && (
        <Section
          id="search"
          title="The Search for a Combination"
          standfirst="Whether no answer exists, or the search stopped early."
          basis={{
            summary: 'Two different claims, never conflated',
            body:
              'When several payments are settled as one lump sum, the engine searches for the combination '
              + 'of records that adds up to it. Proving no combination works and running out of room while '
              + 'looking are different results, and only the first is evidence. The panel below says which '
              + 'one happened, and the bounds it searched within.',
          }}
        >
          <SearchClaim evidence={evidence} />
        </Section>
      )}

      {/* ── 5 · the records, side by side ───────────────────────────────── */}
      <Section
        id="records"
        title="The Source Rows"
        standfirst="The records themselves, with disagreeing fields marked."
        basis={{
          summary: 'Check the data, not the summary of it',
          body:
            'The rows are shown side by side so the engine’s reasoning can be checked against the '
            + 'data rather than against its own account of the data. Fields the three sources disagree '
            + 'about are marked.',
        }}
        aside={
          <>
            <span className="num">{count(exception.relatedRecords.length + 1)}</span> records
          </>
        }
      >
        <LinkedRecords primary={exception.primaryRecord} related={exception.relatedRecords} />
      </Section>

      {/* ── 6 · the Analyst ─────────────────────────────────────────────────
          NOTHING HERE RUNS A MODEL ON PAGE LOAD. If an investigation exists it
          is read from the database and rendered for free; if none does, the
          reader is offered a button that states its own price. Opening every
          exception in the list must cost zero, or a judge browsing the site
          spends the budget by reading it. */}
      <Section
        id="analyst"
        // Past tense only once it IS past. A heading reading "Investigated This"
        // above a panel saying "working on it" is a small lie, and this page is
        // the wrong place to keep one.
        title={
          investigation === null ? 'The Analyst'
            : investigation.status === 'concluded' ? 'The Analyst Investigated This'
            : investigation.status === 'running' ? 'The Analyst Is Investigating This'
            : 'The Analyst'
        }
        standfirst={
          investigation?.status === 'concluded'
            ? 'An agent asked the questions; the engine computed the answers.'
            : 'An agent that investigates this exception when you ask.'
        }
        basis={{
          summary: 'Which parts are the model’s and which are not',
          body:
            'The agent decides which questions to ask; every number in its reasoning is computed '
            + 'by the engine’s own locked code, called as a tool. Below, what the tools actually '
            + 'returned is shown beside what the model inferred from them — separate fields on '
            + 'purpose, so a claim can be checked against the result it was drawn from. The tools '
            + 'can read everything and change nothing.',
        }}
      >
        {investigation
          ? <AnalystPanel investigation={investigation} runQ={runQ} citations={citations} />
          : <AskAnalyst exceptionId={exception.exceptionId} />}
      </Section>

      {/* ── 7 · actions ─────────────────────────────────────────────────── */}
      <Section
        id="actions"
        title="Close This Exception"
        standfirst="A reason is required, and it is recorded."
        basis={{
          summary: 'What closing one does',
          body:
            'The closure is written into the same append-only log as the engine’s own decision, '
            + 'with the reason given, the person who gave it and the time. The exception stays on the '
            + 'list afterwards, marked closed — this list is the run’s record of what the engine '
            + 'could not prove, not a queue that empties.',
        }}
      >
        <div className={styles.actionsLayout}>
          <ResolveActions
            exceptionId={exception.exceptionId}
            status={exception.status}
            closure={exception.closure}
          />
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
          standfirst="Every decision recorded about this record."
          basis={{
            summary: 'Where these entries live',
            body:
              'The same append-only log as the rest of the run, where every entry carries a hash of the '
              + 'one before it. Nothing here can be edited or removed afterwards without breaking the '
              + 'chain, and the chain can be recomputed on demand from the audit screen.',
          }}
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
