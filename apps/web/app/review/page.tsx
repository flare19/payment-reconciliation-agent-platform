import Link from 'next/link';
import { ReviewQueue } from '@/components/review/ReviewQueue';
import { getReviewQueue } from '@/lib/api-client';
import { count } from '@/lib/format';
import { hrefWith, one, resolveRun, runParam } from '@/lib/run-context';
import styles from './review.module.css';

/**
 * The review queue — ui-spec §5.
 *
 * These are matches the engine FOUND but refused to confirm on its own. They
 * are excluded from the headline match rate (ADR-040), which is why the rate is
 * lower than what the engine actually located: a proposal is not a match, and
 * counting it as one would be the guessing this project refuses to do.
 *
 * Paginated one at a time on purpose — the page size is 1, from the client
 * wrapper. It is the same URL-state pattern as everywhere else, used here to
 * make bulk approval structurally impossible rather than merely discouraged.
 */

export const dynamic = 'force-dynamic';

export default async function ReviewPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const ctx = await resolveRun(runParam(params));

  if (!ctx) {
    return (
      <main id="main" className={styles.page}>
        <h1 className={styles.title}>No runs yet</h1>
        <p className={styles.lede}>
          There is nothing to review without a run. <Link href="/">Back to the dashboard</Link>.
        </p>
      </main>
    );
  }

  const { run, runs } = ctx;
  const isDefaultRun = run.runId === (runs.find((r) => r.status === 'completed') ?? runs[0])?.runId;
  const runQ = isDefaultRun ? undefined : run.runId;
  const page = Number(one(params, 'page') ?? '1') || 1;

  const data = await getReviewQueue(run.runId, page);
  const item = data.items[0];

  return (
    <main id="main" className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Review Queue</h1>
        <p className={styles.lede}>
          Matches the engine found and declined to confirm on its own. They are excluded from the
          headline match rate rather than counted toward it — which is why the honest number is
          lower than what the engine actually located, and why this queue exists at all.
        </p>
        <p className={styles.oneAtATime}>
          One proposal at a time, deliberately. A table here would invite approving in bulk without
          reading, and an alias taught from a match nobody looked at becomes a rule that
          mis-resolves every future run.
        </p>
      </header>

      {!item ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>
            {data.pagination.total === 0
              ? 'Nothing is waiting for review.'
              : 'No proposal on this page.'}
          </p>
          <p className={styles.emptyBody}>
            {data.pagination.total === 0 ? (
              <>
                This run produced no proposals in the review band — every pair the engine scored
                either cleared the auto-confirm threshold or fell below the floor.
              </>
            ) : (
              <>
                This run has <span className="num">{count(data.pagination.total)}</span> proposals.{' '}
                <Link href={hrefWith('/review', { run: runQ })}>Start at the first one</Link>.
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <ReviewQueue item={item} pagination={data.pagination} runQ={runQ} />
        </>
      )}
    </main>
  );
}
