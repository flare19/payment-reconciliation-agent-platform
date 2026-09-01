import Link from 'next/link';
import { DenominatorLedger } from '@/components/setaside/DenominatorLedger';
import { Paginate } from '@/components/ui/Paginate';
import table from '@/components/ui/table.module.css';
import { getPopulation } from '@/lib/api-client';
import { count, day } from '@/lib/format';
import { hrefWith, one, resolveRun, runParam } from '@/lib/run-context';
import { SOURCE_LABEL, label } from '@/lib/taxonomy';
import styles from './set-aside.module.css';

/**
 * What the match rate does not count, and why — a consumer for endpoint 24.
 *
 * THE ENDPOINT EXISTED FOR THIS AND NOTHING CALLED IT. api-contract §111 states
 * the reason it was built: *"Any number with a shrunken denominator invites the
 * question 'what did you take out?', and the honest answer is an endpoint that
 * lists exactly that, with a per-row reason. Excluded is not hidden."*
 *
 * It was hidden. The dashboard showed `874 of 920` with no way to inspect the
 * gap, and the first person to read that line asked whether ingestion had lost
 * rows. A defence of the denominator that only exists in the API is not a
 * defence of the denominator.
 *
 * `rejected` is the tab that matters most and it is the one that is empty:
 * **0 rows failed to parse**, which is the claim that ingestion is lossless.
 * The empty state says so rather than rendering a blank table.
 */

export const dynamic = 'force-dynamic';

type Kind = 'excluded' | 'duplicates' | 'rejected';

const KINDS: { key: Kind; label: string; blurb: string }[] = [
  {
    key: 'excluded',
    label: 'Nothing to reconcile',
    blurb: 'Authorised but never captured — no money moved, so no settlement exists to match.',
  },
  {
    key: 'duplicates',
    label: 'Same row twice',
    blurb: 'The first copy counts. The second would be scored against a record already handled.',
  },
  {
    key: 'rejected',
    label: 'Failed to parse',
    blurb: 'Rows the reader could not understand. This is the count that proves nothing was lost.',
  },
];

export default async function SetAsidePage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const ctx = await resolveRun(runParam(params));

  if (!ctx) {
    return (
      <main id="main" className={styles.page}>
        <h1 className={styles.title}>No runs yet</h1>
        <p className={styles.lede}><Link href="/">Back to the dashboard</Link>.</p>
      </main>
    );
  }

  const { run, runs } = ctx;
  const isDefaultRun = run.runId === (runs.find((r) => r.status === 'completed') ?? runs[0])?.runId;
  const runQ = isDefaultRun ? undefined : run.runId;

  const raw = one(params, 'kind');
  const kind: Kind = raw === 'duplicates' || raw === 'rejected' ? raw : 'excluded';
  const page = Number(one(params, 'page') ?? '1') || 1;

  const data = await getPopulation(run.runId, kind, page);
  const active = KINDS.find((k) => k.key === kind);
  const setAsideTotal = data.counts.excluded + data.counts.duplicates + data.counts.rejected;

  return (
    <main id="main" className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>What the match rate leaves out</h1>
        <p className={styles.lede}>
          <span className="num">{count(setAsideTotal)}</span> of{' '}
          <span className="num">{count(setAsideTotal + data.counts.reconcilable)}</span> rows are
          set aside before the match rate is calculated. Every one is listed here with its reason.
          None of them were lost.
        </p>
      </header>

      <section className={styles.ledgerBlock} aria-labelledby="ledger-title">
        <h2 id="ledger-title" className="label">The Arithmetic</h2>
        <DenominatorLedger counts={data.counts} />
      </section>

      <section aria-labelledby="rows-title">
        <h2 id="rows-title" className="label">The Rows</h2>

        <nav className={styles.tabs} aria-label="Reason for being set aside">
          {KINDS.map((k) => {
            const n = k.key === 'duplicates' ? data.counts.duplicates
              : k.key === 'rejected' ? data.counts.rejected : data.counts.excluded;
            const isActive = k.key === kind;
            return (
              <Link
                key={k.key}
                href={hrefWith('/set-aside', { run: runQ, kind: k.key === 'excluded' ? undefined : k.key })}
                className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
                aria-current={isActive ? 'true' : undefined}
              >
                <span className={styles.tabLabel}>{k.label}</span>
                <span className={`${styles.tabCount} num`}>{count(n)}</span>
              </Link>
            );
          })}
        </nav>

        {active && <p className={styles.tabBlurb}>{active.blurb}</p>}

        {data.items.length === 0 ? (
          <div className={kind === 'rejected' ? styles.emptyGood : styles.empty}>
            {kind === 'rejected' ? (
              <>
                <p className={styles.emptyTitle}>Not one row failed to parse.</p>
                <p className={styles.emptyBody}>
                  All{' '}
                  <span className="num">{count(setAsideTotal + data.counts.reconcilable)}</span>{' '}
                  rows across the three files were read successfully. Reading the files loses
                  nothing and decides nothing — everything below the top line of the arithmetic is
                  a stated rule applied afterwards, not a row that went missing.
                </p>
              </>
            ) : (
              <p className={styles.emptyBody}>
                No rows in this category for this run.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className={table.scroller}>
              <table className={table.table}>
                <caption className="sr-only">
                  Rows set aside, with the reason for each
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col" className={table.numCol}>Row</th>
                    <th scope="col">External ID</th>
                    <th scope="col" className={table.numCol}>Amount</th>
                    <th scope="col">Date</th>
                    <th scope="col">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((it) => (
                    <tr key={`${it.sourceSystem}-${it.sourceRowNumber}`}>
                      <td className={table.nowrap}>{label(SOURCE_LABEL, it.sourceSystem)}</td>
                      <td className={`${table.numCol} num ${table.muted}`}>
                        #{it.sourceRowNumber}
                      </td>
                      <td className={table.mono} translate="no">
                        {it.transactionId ? (
                          <Link href={hrefWith(`/records/${it.transactionId}`, { run: runQ })}>
                            {it.externalId ?? it.transactionId.slice(0, 8)}
                          </Link>
                        ) : (it.externalId ?? '—')}
                      </td>
                      <td className={`${table.numCol} num`}>{it.amountDisplay ?? '—'}</td>
                      <td className={`${table.muted} ${table.nowrap}`}>
                        {it.txnDate ? day(it.txnDate) : '—'}
                      </td>
                      <td className={styles.reason}>{it.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Paginate
              pagination={data.pagination}
              unit="rows"
              hrefFor={(p) => hrefWith('/set-aside', {
                run: runQ,
                kind: kind === 'excluded' ? undefined : kind,
                page: p === 1 ? undefined : p,
              })}
            />
          </>
        )}
      </section>
    </main>
  );
}
