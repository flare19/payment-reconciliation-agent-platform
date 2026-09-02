import Link from 'next/link';
import { AnalystBlock } from '@/components/dashboard/AnalystBlock';
import { EnginePerformance } from '@/components/dashboard/EnginePerformance';
import { ExceptionBreakdown } from '@/components/dashboard/ExceptionBreakdown';
import { HeadlineRow } from '@/components/dashboard/HeadlineRow';
import { RunLauncher } from '@/components/dashboard/RunLauncher';
import { RunPicker } from '@/components/dashboard/RunPicker';
import { TierAttribution } from '@/components/dashboard/TierAttribution';
import { Section } from '@/components/ui/Section';
import {
  countPendingReview, getHealth, getInvestigationsIfAny, getMetricsIfComplete, listRuns,
} from '@/lib/api-client';
import { at, count, day, plural } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import type { RunSummary } from '@/types/api';
import styles from './page.module.css';

/**
 * Dashboard — the landing screen.
 *
 * NON-NEGOTIABLE (ui-spec §0): this page NEVER opens on an empty state. The
 * deployed app lands on a completed run, fetched server-side and rendered. A
 * judge who arrives at an upload form and a "Run Reconciliation" button will
 * close the tab before finding out that the engine works.
 *
 * Block order is the argument the project is making, rendered:
 *   1. match rate · FALSE POSITIVES · cold start · ceiling  (equal weight, one row)
 *   2. exceptions by category      — the primary feature (F18, ADR-142)
 *   3. throughput + explain-layer cost
 *   4. tier attribution             — HOW the number in block 1 was earned
 *   4.5 the Analyst
 *   5. run picker
 *
 * 2–3 are ordered ahead of 4 on purpose: backlog item 13 names throughput,
 * measured accuracy and the exception list as the 30-second argument, and 4
 * is supporting detail on block 1 rather than one of those three things.
 *
 * Everything is fetched on the server. Nothing on this page is a client
 * component, so there is no spinner, no waterfall, and no moment where a
 * panelist looks at a skeleton of the number they came to see.
 *
 * EVERY COUNT IN THE COPY IS DERIVED, NEVER TYPED. A figure written into prose
 * is a figure that stops being true the next time the engine runs, and this is
 * the one page whose whole argument is that its numbers are checkable.
 */

export const dynamic = 'force-dynamic';

function pickRun(runs: RunSummary[], requested: string | undefined): RunSummary | undefined {
  if (requested) {
    const asked = runs.find((r) => r.runId === requested);
    if (asked) return asked;
  }
  // A completed run beats a more recent incomplete one: the landing page's job
  // is to show a result, and the newest run may be one somebody just started.
  return runs.find((r) => r.status === 'completed') ?? runs[0];
}

export default async function DashboardPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const requested = typeof params['run'] === 'string' ? params['run'] : undefined;

  const { runs } = await listRuns();
  const run = pickRun(runs, requested);
  // ONE boolean for both LLM surfaces (ADR-093). The launcher disables the
  // explain option rather than offering a spend that would silently no-op.
  const health = await getHealth().catch(() => null);
  // The LIVE size of the review pile, beside the frozen figure `runs.metrics`
  // carries. `null` on failure, rendered as an absence (ADR-120).
  const livePendingReview = run === undefined || run === null
    ? null
    : await countPendingReview(run.runId).catch(() => null);
  const defaultRunId = (runs.find((r) => r.status === 'completed') ?? runs[0])?.runId;
  const runQ = run && run.runId !== defaultRunId ? run.runId : undefined;

  if (!run) {
    return (
      <main id="main" className={styles.page}>
        <div className={styles.emptyState}>
          <h1 className={styles.title}>No runs yet</h1>
          <p className={styles.emptyBody}>
            The API is reachable and has no reconciliation runs recorded. Start one against the
            committed holdout dataset and this page will open on its result from then on.
          </p>
          <code className={styles.command}>
            curl -X POST $API/api/runs -d &apos;&#123;&quot;useSeedDataset&quot;: true&#125;&apos;
          </code>
        </div>
      </main>
    );
  }

  const [metrics, investigations] = await Promise.all([
    getMetricsIfComplete(run.runId),
    getInvestigationsIfAny(run.runId),
  ]);

  return (
    <main id="main" className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroText}>
          <h1 className={styles.title}>
            Three financial sources, reconciled — and an honest account of what could not be.
          </h1>
          <p className={styles.thesis}>
            Three messy sources, matched in tiers, with everything the engine could not prove
            filed as an exception and explained. Refusing to guess is the feature — so the
            false-positive count sits beside the match rate, and every figure on this page says
            whether it is the engine&rsquo;s account of itself or a measurement against ground
            truth.
          </p>

          {/*
            F19 (backlog item 12): the launcher existed since F9.4 but lived
            only at the bottom, under Runs — visible to nobody who did not
            already scroll past everything it would have let them try before
            reading. It is unchanged functionally: same fields, same poll,
            same landing on the FINISHED run's own metrics (never the
            previous run's — that part was never a placement question). What
            moved is presence: `variant="hero"` and `id="launch"` so the
            bottom of the page can point back up to one launcher instead of
            running a second, independent one (ADR-145).
          */}
          <div id="launch" className={styles.launchRow}>
            <RunLauncher datasets={health?.datasets ?? []} variant="hero" />
          </div>
        </div>

        <dl className={styles.runStrip}>
          <div className={styles.runFact}>
            <dt className="label">Run</dt>
            <dd translate="no">{run.label}</dd>
          </div>
          <div className={styles.runFact}>
            <dt className="label">Reference Date</dt>
            <dd>{run.referenceDate === null ? 'not yet ingested' : day(run.referenceDate)}</dd>
          </div>
          <div className={styles.runFact}>
            <dt className="label">Records</dt>
            {/* WAS: "874 of 920 ingested" — which reads as 46 rows lost, and was
                the first question anyone asked about this page. Nothing is lost:
                46 rows are set aside by stated rules AFTER being read, and the
                link goes to the page that lists every one with its reason. */}
            <dd className="num">
              {count(run.recordCounts.reconcilable)} counted
              <span className={styles.runFactSub}>
                {' '}·{' '}
                <Link href={hrefWith('/set-aside', { run: runQ })} className={styles.setAsideLink}>
                  {count(
                    run.recordCounts.excluded + run.recordCounts.nonPrimaryDuplicates
                    + run.recordCounts.rejectedRows,
                  )} set aside
                </Link>
              </span>
            </dd>
          </div>
          <div className={styles.runFact}>
            <dt className="label">Finished</dt>
            <dd>{run.finishedAt ? at(run.finishedAt) : `${run.status}…`}</dd>
          </div>
        </dl>
      </header>

      {metrics ? (
        <>
          <section aria-labelledby="headline-title" className={styles.headline}>
            <h2 id="headline-title" className="sr-only">Headline figures</h2>
            <HeadlineRow
              engine={metrics.engine}
              measured={metrics.measured}
              measuredAgainst={metrics.measuredAgainst}
            />
            <p className={styles.provenanceKey}>
              {metrics.measured ? (
                <>
                  Measured figures were scored offline against{' '}
                  <code translate="no">{metrics.measuredAgainst}</code> by scorer{' '}
                  <span className="num">{metrics.scorerVersion}</span>
                  {metrics.measuredAt && <> on {at(metrics.measuredAt)}</>}. The answer key is never
                  read by the API.
                </>
              ) : (
                <>
                  No score report exists for this run, so the measured figures are shown as absent.
                  They are never filled in from the engine&rsquo;s own numbers.
                </>
              )}
            </p>
          </section>

          {/*
            F18 (backlog item 13): the bar names throughput, measured accuracy
            and the exception list. Accuracy is the headline row above; this
            reorder puts Exceptions and Cost of Running It (throughput) directly
            beneath it, ahead of Tier Attribution — which explains HOW the match
            rate was earned rather than naming one of the three things a judge is
            told to look for. CLAUDE.md's own framing settles the tiebreak between
            the two: "the exception list is the primary feature, not a fallback
            path," so it leads. No runQ threading changed — same props, same
            links, only the document order (ADR-142).
          */}
          <Section
            id="exceptions"
            title="The Exception List"
            standfirst="Every record the engine could not place, with a reason."
            basis={{
              summary: 'Why this is the main feature and not a fallback',
              body:
                'A reconciliation engine is judged on what it refuses as much as on what it '
                + 'matches. Refusing to guess produces this list, so it is built as the primary '
                + 'screen: every record here carries a category, a severity and a stated reason, '
                + 'and none of them is a silent failure.',
            }}
            aside={
              <>
                <span className="num">{count(metrics.engine.exceptions.total)}</span>{' '}
                {plural(metrics.engine.exceptions.total, 'exception', 'exceptions')}
              </>
            }
          >
            <ExceptionBreakdown engine={metrics.engine} runQ={runQ} />
          </Section>

          <Section
            id="performance"
            title="Cost of Running It"
            standfirst="How fast it ran, and what the writing cost."
            basis={{
              summary: 'Two speeds and one bill',
              body:
                `Throughput is reported twice — the engine's own time, and the wall clock including `
                + `everything around it — because only one of those is a claim about the matching `
                + `code. The cost beside it is what the model was actually charged to write the `
                + `${count(metrics.engine.exceptions.total)} explanations on this run.`,
            }}
          >
            <EnginePerformance engine={metrics.engine} livePendingReview={livePendingReview} />
          </Section>

          <Section
            id="tiers"
            title="How the Number Was Earned"
            standfirst="Which rule confirmed each pair the engine matched."
            basis={{
              summary: 'What a bad version of this bar would look like',
              body:
                'Every confirmed pair is attributed to the rule that produced it. A bar dominated '
                + 'by fuzzy matching would be a bad sign — the engine would be reaching a number by '
                + 'resemblance rather than by proof — so the split is shown rather than summarised.',
            }}
          >
            <TierAttribution engine={metrics.engine} />
          </Section>

          <Section
            id="analyst"
            title="The Analyst"
            standfirst="An agent that investigates one exception when a person asks."
            basis={{
              summary: 'What it is allowed to do',
              body:
                'The agent chooses which questions to ask; the engine’s own locked code computes '
                + 'every number it uses, so no figure in its reasoning is one the engine did not '
                + 'produce. Its tools can read everything and change nothing — it proposes, and a '
                + 'person disposes through the same controls they would use themselves.',
            }}
          >
            {investigations ? (
              <AnalystBlock data={investigations} />
            ) : (
              <p className={styles.absentBlock}>
                Analyst results are unavailable for this run — the agent is disabled on this API, or
                Phase&nbsp;A never ran against it.
              </p>
            )}
          </Section>
        </>
      ) : (
        <section aria-labelledby="progress-title" className={styles.progress}>
          <h2 id="progress-title" className={styles.progressTitle}>
            This run is {run.progress.stage}…
          </h2>
          <p className={styles.progressBody}>
            Metrics are published when the run completes. Nothing is shown before then, because a
            partial match rate is a number that will change and be quoted anyway.
          </p>
          <div className={styles.progressTrack} aria-hidden="true">
            <div className={styles.progressFill} style={{ width: `${run.progress.pct}%` }} />
          </div>
          <p className={styles.progressPct}>
            <span className="num">{run.progress.pct}%</span>
          </p>
        </section>
      )}

      <Section
        id="runs"
        title="Runs"
        standfirst="Every run, with and without learned rules, labelled."
        basis={{
          summary: 'Why both are always listed',
          body:
            'A run that reuses corrections a person taught earlier will always score at least as '
            + 'well as one that does not. Listing only the better figure would credit the engine '
            + 'with a person’s work, so both are kept side by side and labelled — never presented '
            + 'as two unrelated rows.',
        }}
        // F19: no second, independently-stateful launcher down here — the
        // working one lives in the hero (id="launch"). A user who scrolled
        // this far to look at the run list should not have to scroll back up
        // by hand to start another one.
        aside={
          <a href="#launch" className={styles.launchBack}>
            New run ↑
          </a>
        }
      >
        <RunPicker
          runs={runs}
          selectedRunId={run.runId}
          showAll={params['runs'] === 'all'}
          runQ={runQ}
        />
        <p className={styles.runsNote}>
          <span className="num">{count(runs.length)}</span>{' '}
          {plural(runs.length, 'run', 'runs')} recorded.
        </p>
      </Section>
    </main>
  );
}
