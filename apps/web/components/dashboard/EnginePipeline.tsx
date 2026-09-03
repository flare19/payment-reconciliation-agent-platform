import { count, pct } from '@/lib/format';
import type { EngineMetrics } from '@/types/api';
import styles from './EnginePipeline.module.css';

/**
 * THE ENGINE, STAGE BY STAGE — and every stage carries what it actually did.
 *
 * A judge arrives knowing the match rate and the exception list, and has no
 * picture at all of the machine between them. That story existed only in
 * `matching-engine.md`, which nobody visiting a live URL will ever read.
 *
 * WHAT THIS IS NOT: a features page. This project's one consistent rule is
 * that a claim appears next to the evidence for it — F13's tile labels, F14's
 * disclosures, F16's quoted model voice were all that rule applied to
 * different surfaces. A static "how it works" panel with no numbers in it
 * would be the first thing on this site to break it, and it would read as
 * marketing on a page whose whole argument is that it does not do marketing.
 *
 * So every stage below shows a REAL FIGURE FROM THIS RUN. Where a stage
 * publishes a count, it shows the count; where it publishes only a measured
 * time, it shows the time. Nothing here is illustrative, and nothing is
 * averaged, rounded up, or carried over from a different run.
 *
 * EVERY NUMBER HERE IS THE ENGINE'S OWN (ADR-041, ADR-098). None of it is
 * scored against the answer key, so none of it wears the `measured` accent —
 * that vocabulary belongs to figures a separate offline pass verified, and
 * spending it here would make the one distinction this dashboard is built to
 * protect slightly cheaper everywhere else.
 */

interface Stage {
  /** The stage's name in `matching-engine.md`, so the doc and the screen agree. */
  code: string;
  name: string;
  what: string;
  /** The real figure this stage produced on this run. */
  figure: string;
  unit: string;
}

interface Phase {
  key: string;
  title: string;
  /** Why this group of stages exists at all, in one line. */
  purpose: string;
  color: string;
  stages: Stage[];
}

export function EnginePipeline({ engine }: { engine: EngineMetrics }) {
  const { population: pop, tierAttribution: tier, throughput, exceptions, llmCost } = engine;
  const stageMs = throughput.stageMs;

  /**
   * A stage that did not run is ABSENT from `stageMs`, not zero — printing
   * `0 ms` would claim it ran instantly. The unit carries "ms" so the figure
   * itself stays a bare numeral, lining up with the counts in every other
   * card rather than breaking the column with a unit mid-number.
   */
  const timing = (key: string): { figure: string; unit: string } => {
    const value = stageMs[key];
    return value === undefined
      ? { figure: '—', unit: 'stage not run' }
      : { figure: count(value), unit: 'ms to narrow' };
  };

  const phases: Phase[] = [
    {
      key: 'read',
      title: 'Read',
      purpose: 'Three files become one comparable shape, and every row removed says why.',
      color: 'var(--tier-1)',
      stages: [
        {
          code: 'S1–S3',
          name: 'Parse',
          what: 'Three sources, three date formats, three money formats. Formats are declared, never guessed.',
          figure: count(pop.ingested),
          unit: 'rows read',
        },
        {
          code: 'S1–S3',
          name: 'Exclude',
          what: 'Rows that were never reconcilable — a failed payment, a void ledger entry, a fee line.',
          figure: count(pop.excluded),
          unit: 'set aside',
        },
        {
          code: 'S4',
          name: 'Dedupe',
          what: 'The same source row present twice. Removed only with anchor evidence, never on resemblance.',
          figure: count(pop.nonPrimaryDuplicates),
          unit: 'duplicates',
        },
      ],
    },
    {
      key: 'match',
      title: 'Match',
      purpose: 'Cheapest, most certain rule first. Each later tier only sees what the earlier ones refused.',
      color: 'var(--tier-2)',
      stages: [
        {
          code: 'S5',
          name: 'Block',
          what: `Four indexes narrow ${count(pop.reconcilable)} records to the pairs worth scoring at all, instead of every pair against every pair.`,
          figure: timing('block').figure,
          unit: timing('block').unit,
        },
        {
          code: 'S6',
          name: 'Tier 1 · Exact',
          what: 'A reference id both sides carry — a payment id, a settlement id, a well-formed RRN.',
          figure: count(tier['exact'] ?? 0),
          unit: 'pairs',
        },
        {
          code: 'S7',
          name: 'Tier 1.5 · Alias',
          what: 'Substitutes rules a human taught, then re-runs the exact test. Empty on a run with no aliases active.',
          figure: count(tier['alias'] ?? 0),
          unit: 'pairs',
        },
        {
          code: 'S8',
          name: 'Identity',
          what: 'Same reference id, disagreeing amount or date. Identity is settled here; the disagreement becomes the finding.',
          figure: count(tier['identityEstablished'] ?? 0),
          unit: 'verdicts',
        },
        {
          code: 'S9',
          name: 'Tier 2 · Fuzzy',
          what: 'Scored on amount, date, reference agreement and counterparty. The most expensive stage in the run, by design.',
          figure: count(tier['fuzzy'] ?? 0),
          unit: 'pairs',
        },
        {
          code: 'S10',
          name: 'Batch',
          what: 'One netted bank credit split back into the payments that compose it, inside a declared search bound.',
          figure: count(tier['batch'] ?? 0),
          unit: 'pairs',
        },
        {
          code: 'S11',
          name: 'Group',
          what: 'Pairs become groups — one group is one real payment, not one pair. The third leg follows from the other two.',
          figure: count(tier['implied'] ?? 0),
          unit: 'implied pairs',
        },
      ],
    },
    {
      key: 'account',
      title: 'Account',
      purpose: 'Everything that did not match is named, ranked and explained rather than dropped.',
      color: 'var(--tier-3)',
      stages: [
        {
          code: 'S12',
          name: 'Classify',
          what: 'Every unmatched record gets one category, a severity computed from money at risk, and its evidence.',
          figure: count(exceptions.total),
          unit: 'exceptions',
        },
        {
          code: 'S13',
          name: 'Explain',
          what: 'Exceptions collapse to structural shapes, and the model is asked once per shape — not once per record.',
          figure: count(llmCost?.signaturesTotal ?? 0),
          unit: 'shapes',
        },
      ],
    },
    {
      key: 'report',
      title: 'Report',
      purpose: 'The number and its denominator — with every decision above written into an append-only chain, each entry hashed over the one before it.',
      color: 'var(--tier-4)',
      stages: [
        {
          code: 'S14',
          name: 'Measure',
          what: 'The match rate, written once when the run finished and never recomputed afterwards.',
          figure: pct(engine.matchRate.matchRatePct),
          unit: 'match rate',
        },
        {
          /**
           * NOT AN AUDIT-ENTRY COUNT, because the engine does not publish one
           * — `runs.metrics` carries no audit total, and inventing a figure
           * for the one stage whose entire purpose is provable honesty would
           * be the worst possible place to do it. The audit chain is named in
           * this phase's purpose line instead, and the figure shown here is
           * the one that actually explains the rate above it.
           */
          code: 'S14',
          name: 'Denominator',
          what: 'Proposals the engine found but would not confirm alone, held out of the rate rather than folded into it.',
          figure: count(engine.matchRate.pendingReviewExcluded),
          unit: 'records excluded',
        },
      ],
    },
  ];

  return (
    <div className={styles.wrap}>
      {phases.map((phase) => (
        <section key={phase.key} className={styles.phase} aria-labelledby={`phase-${phase.key}`}>
          <div className={styles.phaseHead}>
            <span className={styles.phaseRule} style={{ background: phase.color }} aria-hidden="true" />
            <h3 id={`phase-${phase.key}`} className={styles.phaseTitle}>{phase.title}</h3>
            <p className={styles.phasePurpose}>{phase.purpose}</p>
          </div>

          <ol className={styles.stages}>
            {phase.stages.map((s) => (
              <li key={`${s.code}-${s.name}`} className={styles.stage}>
                <div className={styles.stageHead}>
                  <code className={styles.stageCode} translate="no">{s.code}</code>
                  <span className={styles.stageName}>{s.name}</span>
                </div>
                <p className={styles.stageWhat}>{s.what}</p>
                <p className={styles.stageFigure}>
                  <span className="num">{s.figure}</span>
                  <span className={styles.stageUnit}>{s.unit}</span>
                </p>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
