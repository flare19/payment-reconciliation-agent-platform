import Link from 'next/link';
import { Disclosure } from '@/components/ui/Disclosure';
import { VerifyChain } from '@/components/audit/VerifyChain';
import { ActorChip } from '@/components/ui/Chip';
import { Paginate } from '@/components/ui/Paginate';
import { Section } from '@/components/ui/Section';
import { listAudit } from '@/lib/api-client';
import { at, count } from '@/lib/format';
import { hrefWith, one, resolveRun, runParam } from '@/lib/run-context';
import styles from './audit.module.css';

/**
 * The audit screen — ui-spec §6.
 *
 * FOUR ACTOR COLOURS, AND THE MIX IS THE POINT. A viewer should be able to see
 * at a glance that `llm` appears only in explanation events and `agent` only in
 * investigation events — never inside a `MATCH_CONFIRMED_*`. That is ADR-017 and
 * ADR-048's boundary made visible in one screen, and it is a better answer to
 * "does the model decide anything?" than any paragraph could be. The actor
 * filter is there so a sceptic can check it themselves in two clicks.
 */

export const dynamic = 'force-dynamic';

const ACTORS = ['engine', 'human', 'llm', 'agent'] as const;

export default async function AuditPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const ctx = await resolveRun(runParam(params));

  if (!ctx) {
    return (
      <main id="main" className={styles.page}>
        <h1 className={styles.title}>No runs yet</h1>
        <p className={styles.lede}>
          There is no audit trail without a run. <Link href="/">Back to the dashboard</Link>.
        </p>
      </main>
    );
  }

  const { run, runs } = ctx;
  const isDefaultRun = run.runId === (runs.find((r) => r.status === 'completed') ?? runs[0])?.runId;
  const runQ = isDefaultRun ? undefined : run.runId;

  const actorType = one(params, 'actorType');
  const eventType = one(params, 'eventType');
  const page = Number(one(params, 'page') ?? '1') || 1;

  const data = await listAudit(run.runId, { actorType, eventType, page });

  const hrefFor = (next: Record<string, string | number | undefined>) =>
    hrefWith('/audit', { run: runQ, actorType, eventType, ...next });

  return (
    <main id="main" className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Audit</h1>
        <p className={styles.lede}>
          Every decision this run made, in the order it made them.
        </p>
        <Disclosure summary="Why an entry here cannot be changed afterwards">
          <p>
            The log is append-only, and each entry&rsquo;s hash covers both its own contents and
            the hash of the entry before it. Editing or removing one therefore breaks every entry
            after it, which the check below will find and name.
          </p>
        </Disclosure>
      </header>

      <Section
        id="verify"
        title="Verify the Chain"
        standfirst="Recompute the chain now instead of trusting the claim."
        basis={{
          summary: 'What the button actually does',
          body:
            'It is a live call against the running database, not a cached result. Every entry in the '
            + 'log carries a hash of the one before it, so re-deriving them in order either reproduces '
            + 'the recorded head or names the first entry where it stops agreeing.',
        }}
      >
        <VerifyChain runId={run.runId} />
      </Section>

      <Section
        id="entries"
        title="The Trail"
        standfirst="Every decision in the run, and who made it."
        basis={{
          summary: 'The boundary you can check here',
          body:
            'Filter by actor. The model appears only where it writes prose, the agent only where it '
            + 'investigates, and neither ever appears on a match decision — those are the rules’ own, '
            + 'and a person’s where a person overruled them.',
        }}
        aside={<><span className="num">{count(data.pagination.total)}</span> entries</>}
      >
        <nav className={styles.filters} aria-label="Filter by actor">
          <Link
            href={hrefFor({ actorType: undefined, page: undefined })}
            className={`${styles.filter} ${!actorType ? styles.filterActive : ''}`}
            aria-current={!actorType ? 'true' : undefined}
          >
            All Actors
          </Link>
          {ACTORS.map((a) => (
            <Link
              key={a}
              href={hrefFor({ actorType: actorType === a ? undefined : a, page: undefined })}
              className={`${styles.filter} ${actorType === a ? styles.filterActive : ''}`}
              aria-current={actorType === a ? 'true' : undefined}
            >
              <ActorChip actor={a} />
            </Link>
          ))}
        </nav>

        {data.entries.length === 0 ? (
          <p className={styles.empty}>
            No entries match {actorType ? <>actor <strong>{actorType}</strong></> : 'this filter'}
            {eventType && <> and event type <strong>{eventType}</strong></>}.{' '}
            <Link href={hrefWith('/audit', { run: runQ })}>Clear the filter</Link>.
            {actorType === 'human' && (
              <> That is expected on a run nobody has reviewed yet — human entries appear once
              somebody approves, rejects or resolves something.</>
            )}
          </p>
        ) : (
          <>
            <ol className={styles.entries}>
              {data.entries.map((e) => (
                <li key={e.sequenceNo} className={styles.entry}>
                  <div className={styles.entryHead}>
                    <span className={`${styles.seq} num`}>#{e.sequenceNo}</span>
                    <code className={styles.eventType} translate="no">{e.eventType}</code>
                    <ActorChip actor={e.actorType} />
                    {e.tier && <span className={styles.tier}>{e.tier}</span>}
                    {e.confidence !== null && (
                      <span className={`${styles.confidence} num`}>{e.confidence.toFixed(4)}</span>
                    )}
                    <time className={styles.time} dateTime={e.occurredAt}>{at(e.occurredAt)}</time>
                  </div>

                  {e.reason && <p className={styles.reason}>{e.reason}</p>}

                  <div className={styles.entryFoot}>
                    <span className={styles.subject} translate="no">
                      {e.subjectType} · {e.subjectId.slice(0, 8)}
                    </span>
                    {e.ruleId && (
                      <span className={styles.ruleId} translate="no">
                        {e.ruleId}{e.ruleVersion ? ` v${e.ruleVersion}` : ''}
                      </span>
                    )}
                    {e.actorId && (
                      <span className={styles.actorId} translate="no">{e.actorId}</span>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            <Paginate
              pagination={data.pagination}
              unit="entries"
              hrefFor={(p) => hrefFor({ page: p === 1 ? undefined : p })}
            />
          </>
        )}
      </Section>
    </main>
  );
}
