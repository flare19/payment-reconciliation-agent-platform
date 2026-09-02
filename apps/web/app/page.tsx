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
 *   2. tier attribution
 *   3. exceptions by category
 *   4. throughput + explain-layer cost
 *   4.5 the Analyst
 *   5. run picker
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

          <Section
            id="tiers"
            title="How the Number Was Earned"
            standfirst="Every confirmed pair, attributed to the tier that produced it. A bar dominated by fuzzy matching would be a bad sign, and this one is honest enough to show it."
          >
            <TierAttribution engine={metrics.engine} />
          </Section>

          <Section
            id="exceptions"
            title="The Exception List"
            standfirst="The primary feature, not a fallback path. Every record the engine could not prove belongs somewhere, with a stated reason."
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
            standfirst={
              <>
                Throughput measured two ways, and what the explain layer actually spent to write{' '}
                {count(metrics.engine.exceptions.total)} explanations.
              </>
            }
          >
            <EnginePerformance engine={metrics.engine} livePendingReview={livePendingReview} />
          </Section>

          <Section
            id="analyst"
            title="The Analyst"
            standfirst="An agent that investigates one exception when a human asks, using read-only tools that call the engine’s own locked code. It proposes; it never writes."
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
        standfirst="Cold and warm runs listed together and labelled, never as two unrelated rows."
        aside={<RunLauncher datasets={health?.datasets ?? []} />}
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
