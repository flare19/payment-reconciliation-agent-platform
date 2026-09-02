import Link from 'next/link';
import { Chip } from '@/components/ui/Chip';
import { Disclosure } from '@/components/ui/Disclosure';
import { ModelVoice } from '@/components/ui/ModelVoice';
import { VERDICT_LABEL, label } from '@/lib/taxonomy';
import type { InvestigationDetail } from '@/types/api';
import styles from './AnalystSuggestion.module.css';

/**
 * THE SUGGESTED ACTION, ONCE THE ANALYST HAS ACTUALLY LOOKED AT THIS EXCEPTION.
 *
 * Before this, the line under the explanation was a template keyed on the
 * exception's category, and it read identically whether the agent had
 * investigated or not — so the most specific thing the system knew about this
 * one record sat two screens down as raw JSON, while a sentence that applied to
 * fifty records sat at the top.
 *
 * THE ENGINE'S SUGGESTION IS KEPT, NOT REPLACED (ADR-017). It moves into the
 * disclosure directly beneath. The whole argument of this project is that the
 * rules stand without the model, and a reader can only check that if both are
 * on the page — the moment the template disappears when the agent runs, the
 * claim becomes unfalsifiable.
 *
 * WHAT THIS COMPONENT MAY NOT DO — and the page decides, not this file: it must
 * never be rendered for a verdict the grounding gate REJECTED, for a failed or
 * still-running investigation, or for a proposal a human already declined. The
 * gate exists to stop an ungrounded claim reaching a reader as a finding, and
 * promoting one to the top of the page would undo that more thoroughly than not
 * having the gate at all. `analystMaySuggest` in the page is the single place
 * that decides; see ADR-137.
 */

/**
 * What the verdict means for the person reading it. Fixed prose per verdict,
 * NOT generated — the model's own words appear separately below, quoted and
 * attributed, so that a reader can always tell which sentences the system wrote
 * and which the model did.
 */
const VERDICT_CONSEQUENCE: Record<string, string> = {
  RESOLUTION_PROPOSED:
    'The Analyst believes this can be resolved and has proposed how. Nothing has been applied — '
    + 'a person has to approve it.',
  CONFIRMED_UNRESOLVABLE:
    'The Analyst investigated and agreed the engine was right to refuse. There is no answer to '
    + 'find in these three sources.',
  NEEDS_EXTERNAL_DATA:
    'Answerable, but not from these three files. The Analyst named what is missing rather than '
    + 'guessing at it.',
  INSUFFICIENT_EVIDENCE:
    'The Analyst could not reach a conclusion inside its budget. Treat this as unexamined rather '
    + 'than as a finding.',
};

/** `proposedAction` rendered as fields. A reader should not have to parse JSON. */
function ProposedFields({ action }: { action: Record<string, unknown> }) {
  const { type, rationale, ...rest } = action as {
    type?: unknown; rationale?: unknown; [k: string]: unknown;
  };

  return (
    <div className={styles.proposal}>
      {typeof type === 'string' && (
        <p className={styles.proposalType} translate="no">{type.replace(/_/g, ' ').toLowerCase()}</p>
      )}
      {typeof rationale === 'string' && <p className={styles.rationale}>{rationale}</p>}
      {Object.keys(rest).length > 0 && (
        <dl className={styles.proposalFields}>
          {Object.entries(rest).map(([k, v]) => (
            <div key={k}>
              <dt className={styles.proposalKey}>{k}</dt>
              <dd className={styles.proposalValue} translate="no">
                {typeof v === 'string' || typeof v === 'number'
                  ? String(v)
                  : JSON.stringify(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function AnalystSuggestion(
  { investigation, engineSuggestion }: {
    investigation: InvestigationDetail;
    engineSuggestion: string | null;
  },
) {
  const inv = investigation;

  /**
   * The model's own closing words, and labelled as exactly that rather than as
   * a conclusion. There is no `summary` column — the raw verdict carries one but
   * `concludeInvestigation` does not persist it — so the last inference in the
   * reasoning chain is the most concrete thing the Analyst said about this
   * record that the runtime actually kept. It is a step in the chain the gate
   * checked, not a separate assertion, and the label says which it is.
   */
  const closing = inv.reasoning.at(-1)?.inference ?? null;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className="label">Suggested Action</span>
        <span className={styles.byline}>
          from the Analyst&rsquo;s investigation
          <Chip tone="outline">{inv.confidence ?? 'unstated'} confidence</Chip>
        </span>
      </div>

      <p className={styles.verdict}>{label(VERDICT_LABEL, inv.verdict)}</p>
      <p className={styles.consequence}>
        {VERDICT_CONSEQUENCE[inv.verdict ?? ''] ?? 'The Analyst reached a verdict on this exception.'}
      </p>

      {inv.proposedAction && <ProposedFields action={inv.proposedAction} />}

      {closing && (
        <ModelVoice
          attribution={
            <>
              the Analyst, at step <span className="num">{inv.reasoning.length}</span> of its own
              reasoning · <span translate="no">{inv.model}</span>
            </>
          }
        >
          {closing}
        </ModelVoice>
      )}

      <p className={styles.jump}>
        <Link href="#analyst">Every step it took, and what the tools returned</Link>
      </p>

      {engineSuggestion && (
        <Disclosure summary="The engine’s own suggestion, unchanged">
          <p>{engineSuggestion}</p>
          <p>
            Written by a template from the exception&rsquo;s category, before any model ran. It is
            kept here on purpose: the rules stand without the Analyst, and that is only checkable
            while both are on the page.
          </p>
        </Disclosure>
      )}
    </div>
  );
}
