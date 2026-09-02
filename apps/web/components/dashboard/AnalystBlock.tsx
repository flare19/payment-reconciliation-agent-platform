import { Figure } from '@/components/ui/Figure';
import { SegmentBar, type Segment } from '@/components/ui/SegmentBar';
import { count } from '@/lib/format';
import type { InvestigationListResponse, Verdict } from '@/types/api';
import styles from './AnalystBlock.module.css';

/**
 * ui-spec §2 block 4.5 — the Analyst.
 *
 * THE ONE THING THIS BLOCK MUST NOT DO IS CLAIM THE AGENT WORKS.
 *
 * The spec asks for a `hallucinated resolutions: 0` tile, and describes it as
 * the agent's equivalent of the false-positive tile — a MEASURED figure, from
 * `tools/score`, per ADR-053 and validation-strategy §7. That measurement does
 * not exist: `tools/score` does not score the Analyst.
 *
 * What the API returns instead is `agentMetrics.hallucinatedResolutions`, and
 * `routes/investigations.ts` sets it to `groundingFailures` verbatim — the same
 * integer under a second name. It is the grounding gate's REJECTION COUNT: how
 * often a verdict claimed something its own tool trace did not support and was
 * caught. That is an operational figure about the agent's own behaviour, and on
 * this run it is 3, not 0.
 *
 * Rendering it in the "Hallucinated Resolutions" tile would put a
 * self-reported number in a slot the whole architecture reserves for a
 * measurement — the exact substitution ADR-041 exists to prevent, made easier
 * here than anywhere else because both numbers are about the same subject. So
 * the gate's count is shown as what it is, and the measured tile is shown as
 * absent. An absent measurement is a weaker claim than a good one, and it is
 * the only true claim available.
 */

const VERDICT_LABEL: Record<Verdict, string> = {
  RESOLUTION_PROPOSED: 'Resolution Proposed',
  CONFIRMED_UNRESOLVABLE: 'Confirmed Unresolvable',
  NEEDS_EXTERNAL_DATA: 'Needs External Data',
  INSUFFICIENT_EVIDENCE: 'Insufficient Evidence',
};

const VERDICT_GLOSS: Record<Verdict, string> = {
  RESOLUTION_PROPOSED: 'Found something the engine missed, and proposed it for a human to confirm.',
  CONFIRMED_UNRESOLVABLE: 'Agreed the engine was right to refuse. A result, not an empty answer.',
  NEEDS_EXTERNAL_DATA: 'Answerable, but not from these three sources.',
  INSUFFICIENT_EVIDENCE: 'Could not reach a conclusion inside its budget.',
};

/**
 * Two conclusions, then two non-conclusions — the only ordering these verdicts
 * genuinely have. Proposing a resolution and confirming one is impossible are
 * given the same weight on purpose (ui-spec §4): an agent that agrees something
 * cannot be resolved is the verdict that proves it is not a yes-machine.
 */
const VERDICT_ORDER: { verdict: Verdict; color: string }[] = [
  { verdict: 'RESOLUTION_PROPOSED', color: 'var(--tier-1)' },
  { verdict: 'CONFIRMED_UNRESOLVABLE', color: 'var(--tier-2)' },
  { verdict: 'NEEDS_EXTERNAL_DATA', color: 'var(--tier-4)' },
  { verdict: 'INSUFFICIENT_EVIDENCE', color: 'var(--tier-6)' },
];

export function AnalystBlock({ data }: { data: InvestigationListResponse }) {
  const { agentMetrics: m, investigations, pagination } = data;

  if (m.total === 0) {
    return (
      <p className={styles.empty}>
        Phase&nbsp;A has not run on this run. The Analyst investigates an exception when a human
        opens it and asks — it does not sweep the queue, because 212 exceptions at roughly $0.11
        each is a pass nobody can afford to repeat.
      </p>
    );
  }

  // Only trustworthy when every investigation is in hand; a distribution over
  // one page of many is a distribution over an arbitrary subset.
  const complete = investigations.length >= pagination.total;

  const tally = new Map<Verdict, number>();
  for (const inv of investigations) {
    if (inv.verdict) tally.set(inv.verdict, (tally.get(inv.verdict) ?? 0) + 1);
  }

  const segments: Segment[] = VERDICT_ORDER.map(({ verdict, color }) => ({
    key: verdict,
    label: VERDICT_LABEL[verdict],
    value: tally.get(verdict) ?? 0,
    color,
    gloss: VERDICT_GLOSS[verdict],
  }));

  return (
    <div className={styles.wrap}>
      <div className={styles.figures}>
        <Figure
          label="Investigations"
          provenance="engine"
          value={count(m.total)}
          note={`${count(m.concluded)} concluded · ${count(m.failed)} failed`}
        />

        {/*
          "GROUNDING GATE" IS THIS REPO'S NAME FOR A3, AND IT IS THE ONLY PLACE
          THAT NAME MEANS ANYTHING. A reader who has not read `agent-design.md`
          cannot tell whether a rejection is the system failing or the system
          working, which is the one thing this tile exists to say. The plain
          label says it: a claim went unsupported, and it was caught before
          anyone saw it. The mechanism keeps its real name in the disclosure
          below, where a reader who wants it has asked for it (ADR-135).
        */}
        <Figure
          label="Unsupported Claims Caught"
          provenance="engine"
          value={count(m.groundingFailures)}
          note={
            <>
              Verdicts making a claim their own tool trace does not support. Rejected, not shown.
            </>
          }
          basis={{
            summary: 'What the gate checks',
            body:
              'Every citation in a verdict is joined back to a tool call the runtime actually made, '
              + 'on the tool name and the result digest the runtime recorded. A verdict citing a step '
              + 'that never ran is refused and downgraded. This count is the gate firing, which is the '
              + 'gate working — but it is also the count of times the model asserted something it had '
              + 'not established, and it is reported rather than suppressed because a rising number is '
              + 'the only signal that the prompt or the tools need work.',
          }}
        />

        <Figure
          label="Hallucinated Resolutions"
          provenance="absent"
          absentReason="Not measured. The offline scorer does not yet score the Analyst."
          note={
            <>
              ADR-053 makes this a build blocker rather than a metric, so it has to come from the
              answer key — not from the agent&rsquo;s account of itself.
            </>
          }
          basis={{
            summary: 'Why this is empty and the tile stayed',
            body:
              'The API does return a field by this name, and it holds the count shown to the left — '
              + 'the rejections of the grounding gate, the same integer under a second name. Putting '
              + 'that number here would place a self-reported figure in a slot reserved for a '
              + 'measurement, which '
              + 'is precisely the substitution this project is built to prevent. The tile stays '
              + 'visible while empty because the absence is the finding: feature-complete and '
              + 'plumbing-verified is the honest claim about this layer, and nothing stronger.',
          }}
        />

        <Figure
          label="Proposals"
          provenance="engine"
          value={count(m.proposals)}
          note={`${count(m.accepted)} accepted · ${count(m.declined)} declined by a human`}
          basis={{
            summary: 'The agent proposes, it never writes',
            body:
              'The tool registry contains no mutating tool, and read-only is enforced by Postgres '
              + 'rather than declared. A proposal reaches the database only through the same '
              + 'endpoints a human uses, with the investigation recorded as its source.',
          }}
        />
      </div>

      <div className={styles.distribution}>
        <h3 className="label">Verdict Distribution</h3>
        {complete ? (
          <SegmentBar
            segments={segments}
            total={m.total}
            unit="Verdicts"
            caption="Investigations by the verdict they reached"
          />
        ) : (
          <p className={styles.partial}>
            {count(investigations.length)} of {count(pagination.total)} investigations were
            fetched, so a distribution over them would describe an arbitrary subset rather than the
            run. Not shown.
          </p>
        )}

        <p className={styles.caveat}>
          <strong>This layer has no measured number.</strong> Proposal precision, false-despair
          recovered and unresolvable agreement are all defined against the answer key and none of
          them has been computed. Everything above is the agent&rsquo;s account of its own
          behaviour.
        </p>
      </div>
    </div>
  );
}
