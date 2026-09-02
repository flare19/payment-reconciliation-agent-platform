import Link from 'next/link';
import { Chip } from '@/components/ui/Chip';
import { ModelVoice } from '@/components/ui/ModelVoice';
import { at, count } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import { InvestigationPoller } from './InvestigationPoller';
import { VERDICT_LABEL, label } from '@/lib/taxonomy';
import type { ResolvedCitation } from '@/lib/api-client';
import type { InvestigationDetail } from '@/types/api';
import styles from './AnalystPanel.module.css';

/**
 * ui-spec §4 item 7 — the Analyst's work on this exception.
 *
 * FOUR THINGS THIS PANEL IS CAREFUL ABOUT:
 *
 * 1. **Confidence is a LABEL, drawn differently from the engine's numeric
 *    confidence.** They are different kinds of quantity — one is a model saying
 *    how sure it feels, the other is a score the engine computed — and making
 *    them look like the same widget would invite a reader to compare them.
 *
 * 2. **`resultDigest` and `inference` are in visibly separate fields.** The
 *    digest is recorded by the RUNTIME; the inference is the model's own words.
 *    That separation is what lets a reader check the reasoning against the
 *    evidence rather than against a paraphrase of it.
 *
 * 3. **`groundingFailure` and `budgetExhausted` render as explicit banners,
 *    never as a missing panel.** An agent that ran out of room and said so is a
 *    feature; hiding it would not be.
 *
 * 4. **`CONFIRMED_UNRESOLVABLE` gets the same visual weight as a proposal.** The
 *    agent agreeing that something cannot be resolved is a result, not an empty
 *    state — it is the verdict that proves it is not a yes-machine.
 *
 * It renders a PERSISTED investigation. Nothing here triggers a model call:
 * re-running the agent on every page load would empty a prepaid key in front of
 * an audience.
 */
export function AnalystPanel(
  { investigation, runQ, citations }: {
    investigation: InvestigationDetail;
    runQ: string | undefined;
    /**
     * Resolved server-side, because a citation id can be a TRANSACTION or an
     * EXCEPTION — the gate accepts any id that appeared in a tool result, and
     * different tools yield different kinds. Linking them all at `/records/`
     * sent a third of them to a not-found page.
     */
    citations: ResolvedCitation[];
  },
) {
  const inv = investigation;

  /**
   * STATUS IS READ FIRST, and nothing below it is trusted until `concluded`.
   *
   * A running investigation carries `costUsd: null`, `tokensIn/Out: null`, and
   * `groundingPassed: false` — the last of which is the COLUMN DEFAULT, not a
   * finding. The first version of this panel rendered all of it: it crashed on
   * `costUsd.toFixed(4)`, and had it survived that line it would have displayed
   * "Grounding: Rejected" about a verdict that did not exist yet. On a page
   * whose subject is not claiming more than the evidence supports, the second
   * would have been the worse bug.
   */
  if (inv.status === 'running') {
    return (
      <div className={styles.panel}>
        <p className="label">Investigating Now</p>
        <p className={styles.runningTitle}>The Analyst is working on this exception.</p>
        <p className={styles.runningBody}>
          It is choosing which questions to ask and answering them with the engine&rsquo;s own
          locked code. This takes up to a minute; the page refreshes itself. Nothing below is
          decided yet — there is no verdict, no grounding result and no cost to report until it
          finishes, and showing placeholders for them would be inventing findings.
        </p>
        <p className={styles.runningMeta} translate="no">
          {inv.model} · started {at(inv.startedAt)}
        </p>
        {/* Mounted BY the running state, so it cannot be unmounted by the first
            transition it detects — which is exactly how the previous version
            killed itself. */}
        <InvestigationPoller
          investigationId={inv.investigationId}
          exceptionId={inv.exceptionId}
          runQ={runQ}
        />
      </div>
    );
  }

  if (inv.status === 'failed') {
    return (
      <div className={styles.panel}>
        <p className="label">Investigation Failed</p>
        <p className={styles.runningTitle}>The Analyst did not finish.</p>
        <p className={styles.runningBody}>
          The loop threw rather than reaching a verdict. Failure is a state, not an absence — and
          this one is re-runnable, because memoising it would let a single crash permanently
          poison the exception.
        </p>
      </div>
    );
  }

  const isProposal = inv.verdict === 'RESOLUTION_PROPOSED';

  return (
    <div className={styles.panel}>
      <header className={styles.head}>
        <div className={styles.verdictGroup}>
          <span className="label">Verdict</span>
          <p className={`${styles.verdict} ${isProposal ? styles.proposal : ''}`}>
            {label(VERDICT_LABEL, inv.verdict)}
          </p>
        </div>

        <dl className={styles.meta}>
          <div>
            <dt className="label">Confidence</dt>
            {/* A word, never a number — see note 1 above. */}
            <dd><Chip tone="outline">{inv.confidence ?? 'unstated'}</Chip></dd>
          </div>
          <div>
            <dt className="label">Grounding</dt>
            <dd>
              <Chip tone={inv.groundingPassed ? 'verified' : 'high'}>
                {inv.groundingPassed ? 'Passed' : 'Rejected'}
              </Chip>
            </dd>
          </div>
          <div>
            <dt className="label">Work</dt>
            <dd className={styles.metaValue}>
              <span className="num">{count(inv.steps)}</span> steps ·{' '}
              <span className="num">{count(inv.toolCalls)}</span> tool calls
            </dd>
          </div>
          <div>
            <dt className="label">Cost</dt>
            <dd className={`${styles.metaValue} num`}>
              {inv.costUsd === null
                // NULL is never rendered as $0.00 — a zero cost reads as a
                // measured figure, and a free-tier key has not measured one.
                ? <span className={styles.unmeasured}>not billed</span>
                : `$${inv.costUsd.toFixed(4)}`}
            </dd>
          </div>
        </dl>
      </header>

      {!inv.groundingPassed && (
        <div className={`${styles.banner} ${styles.bannerBad}`}>
          <strong>The grounding gate rejected this verdict.</strong>{' '}
          {inv.groundingFailure
            ? inv.groundingFailure
            : 'It made a claim its own tool trace does not support.'}{' '}
          The conclusion below is shown because suppressing it would hide the gate doing its job —
          but it was not accepted, and nothing downstream acted on it.
        </div>
      )}

      {inv.budgetExhausted && (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>
          <strong>The investigation ran out of budget.</strong> It concluded on what it had rather
          than on what it wanted. An agent that says so is behaving correctly; treat the verdict as
          provisional.
        </div>
      )}

      <section className={styles.chain} aria-label="Reasoning chain">
        <h4 className="label">Reasoning</h4>
        <ol className={styles.steps}>
          {inv.reasoning.map((s) => (
            <li key={`${s.step}-${s.tool}`} className={styles.step}>
              <div className={styles.stepHead}>
                <span className={`${styles.stepNo} num`}>{s.step}</span>
                <code className={styles.tool} translate="no">{s.tool}</code>
              </div>

              <div className={styles.stepBody}>
                <div className={styles.stepField}>
                  <span className={styles.fieldLabel}>Recorded by the runtime</span>
                  <code className={styles.digest} translate="no">{s.resultDigest}</code>
                </div>
                {/*
                  The digest above is the runtime's record; this is the model
                  talking. They were already in separate fields with separate
                  labels and still in identical ink — so the one distinction
                  this panel exists to draw was the one a reader had to take on
                  trust. No attribution here: the label directly above it says
                  whose words these are (ADR-139).
                */}
                <div className={styles.stepField}>
                  <span className={styles.fieldLabel}>The model&rsquo;s inference</span>
                  <ModelVoice>{s.inference}</ModelVoice>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {citations.length > 0 && (
        <section className={styles.citations} aria-label="Citations">
          <h4 className="label">Citations</h4>
          <p className={styles.citationNote}>
            Every id the agent cited had to appear in a tool result it actually received — that
            is what the grounding gate checks. Each one links to the record or exception it names,
            so a reader can go and check the claim rather than take it.
          </p>
          <ul className={styles.chips}>
            {citations.map((c) => (
              <li key={c.id}>
                {c.href === null ? (
                  <span className={`${styles.citation} ${styles.citationDead}`}>
                    <span className={styles.citationKind}>unresolved</span>
                    <span className="num" translate="no">{c.label}</span>
                  </span>
                ) : (
                  <Link href={hrefWith(c.href, { run: runQ })} className={styles.citation}>
                    <span className={styles.citationKind}>
                      {c.kind === 'transaction' ? 'record' : 'exception'}
                    </span>
                    <span className={styles.citationLabel} translate="no">{c.label}</span>
                    {c.detail && <span className={styles.citationDetail}>{c.detail}</span>}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {inv.proposedAction && (
        <section className={styles.proposalBox} aria-label="Proposed action">
          <h4 className="label">Proposed Action</h4>
          <pre className={styles.proposalJson}>
            <code>{JSON.stringify(inv.proposedAction, null, 2)}</code>
          </pre>
          <p className={styles.proposalNote}>
            {inv.humanDisposition
              ? `A human has already ${inv.humanDisposition} this proposal.`
              : 'Accepting a proposal routes through the same endpoints a human uses — the agent '
                + 'has no write tool and cannot apply this itself.'}
          </p>
        </section>
      )}

      <footer className={styles.footer}>
        <span translate="no">{inv.model}</span> · prompt {inv.promptVersion} ·{' '}
        {inv.tokensIn === null || inv.tokensOut === null
          ? <span className={styles.unmeasured}>tokens not reported</span>
          : <>
              <span className="num">{count(inv.tokensIn)}</span> in /{' '}
              <span className="num">{count(inv.tokensOut)}</span> out
            </>}
        {inv.finishedAt && <> · {at(inv.finishedAt)}</>}
      </footer>
    </div>
  );
}
