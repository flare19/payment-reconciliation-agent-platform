import Link from 'next/link';
import { Chip } from '@/components/ui/Chip';
import { at, count } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import { VERDICT_LABEL, label } from '@/lib/taxonomy';
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
  { investigation, runQ }: { investigation: InvestigationDetail; runQ: string | undefined },
) {
  const inv = investigation;
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
            <dd className={`${styles.metaValue} num`}>${inv.costUsd.toFixed(4)}</dd>
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
                <div className={styles.stepField}>
                  <span className={styles.fieldLabel}>The model&rsquo;s inference</span>
                  <p className={styles.inference}>{s.inference}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {inv.citations.length > 0 && (
        <section className={styles.citations} aria-label="Citations">
          <h4 className="label">Citations</h4>
          <p className={styles.citationNote}>
            Each links to the record it refers to. A reader must be able to click through and
            check.
          </p>
          <ul className={styles.chips}>
            {inv.citations.map((id) => (
              <li key={id}>
                <Link
                  href={hrefWith(`/records/${id}`, { run: runQ })}
                  className={styles.citation}
                >
                  <span className="num" translate="no">{id.slice(0, 8)}</span>
                </Link>
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
        <span className="num">{count(inv.tokensIn)}</span> in /{' '}
        <span className="num">{count(inv.tokensOut)}</span> out
        {inv.finishedAt && <> · {at(inv.finishedAt)}</>}
      </footer>
    </div>
  );
}
