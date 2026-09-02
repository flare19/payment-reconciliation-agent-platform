import Link from 'next/link';
import { Disclosure } from '@/components/ui/Disclosure';
import { Chip } from '@/components/ui/Chip';
import { Paginate } from '@/components/ui/Paginate';
import table from '@/components/ui/table.module.css';
import { listMatches } from '@/lib/api-client';
import { count, day, ratio4 } from '@/lib/format';
import { hrefWith, one, resolveRun, runParam } from '@/lib/run-context';
import { SOURCE_LABEL, STATUS_LABEL, TIER_LABEL, label } from '@/lib/taxonomy';
import styles from './matches.module.css';

/**
 * The matches browser — what DID match, and at which tier.
 *
 * Priority 3 in ui-spec §8's pre-agreed degradation order, shipped as the
 * read-only table that order specifies. It earns its place because "show me the
 * ones it got right" is the first thing a sceptic asks after an exception list,
 * and because `countsTowardEngineMatchRate` is a visible column here — the
 * place a proposal can be seen being EXCLUDED from the headline rather than
 * quietly folded into it.
 */

export const dynamic = 'force-dynamic';

/**
 * `manual` IS DELIBERATELY ABSENT.
 *
 * It is the tier for matches a human creates from scratch through endpoint 21,
 * and that record picker is not built (ADR-102) — so on this build the filter
 * cannot return a row no matter what anyone does. Approving a proposal keeps
 * the tier it was FOUND at and changes who confirmed it, which is what the
 * `Confirmed by` row above is for.
 *
 * `alias` stays, and the distinction is the point: a filter that is EMPTY today
 * is a fact worth offering, because teaching one alias from the review queue
 * fills it. A filter that is IMPOSSIBLE is a control that does nothing, and
 * offering it invites exactly the wrong conclusion — that approvals went
 * missing rather than that they live under a different heading.
 *
 * `/matches?tier=manual` typed directly still explains itself, for anyone
 * arriving on an old link.
 */
const TIERS = ['exact', 'alias', 'fuzzy', 'batch'];

export default async function MatchesPage(
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
  const tier = one(params, 'tier');
  const status = one(params, 'status');
  const page = Number(one(params, 'page') ?? '1') || 1;

  // Counts for the status row, so a filter shows what it will return before it
  // is clicked. Three cheap parallel reads against the same endpoint.
  const [data, autoN, humanN, pendingN] = await Promise.all([
    listMatches(run.runId, { tier, status, page }),
    listMatches(run.runId, { status: 'auto_confirmed', page: 1 }),
    listMatches(run.runId, { status: 'human_confirmed', page: 1 }),
    listMatches(run.runId, { status: 'pending_review', page: 1 }),
  ]);

  const STATUSES: { key: string | undefined; label: string; n: number }[] = [
    { key: undefined, label: 'All', n: autoN.pagination.total + humanN.pagination.total + pendingN.pagination.total },
    { key: 'auto_confirmed', label: 'Engine confirmed', n: autoN.pagination.total },
    { key: 'human_confirmed', label: 'You confirmed', n: humanN.pagination.total },
    { key: 'pending_review', label: 'Waiting for you', n: pendingN.pagination.total },
  ];

  return (
    <main id="main" className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Matches</h1>
        <p className={styles.lede}>
          The record groups the engine matched, each reported at its weakest rule.
        </p>
        <Disclosure summary="Why a group is reported at its weakest rule">
          <p>
            A group is a claim about a <em>set</em> of records being one real payment — not a
            pair. A three-way group holding one fuzzy leg is therefore reported as fuzzy, however
            exact its other two legs were, because the group is only as good as the weakest
            reason for putting it together.
          </p>
        </Disclosure>
      </header>

      {/* STATUS FIRST, because "show me the ones I approved" is the question
          people actually arrive with — and until this row existed there was no
          way to answer it. A human-confirmed match keeps the tier it was found
          at, so filtering by tier can never surface one. */}
      <nav className={styles.filterRow} aria-label="Filter by who confirmed it">
        <span className="label">Confirmed by</span>
        {STATUSES.map((s) => {
          const isActive = status === s.key || (!status && s.key === undefined);
          return (
            <Link
              key={s.label}
              href={hrefWith('/matches', { run: runQ, tier, status: s.key })}
              className={`${styles.filter} ${isActive ? styles.filterActive : ''}`}
              aria-current={isActive ? 'true' : undefined}
            >
              {s.label}
              <span className={`${styles.filterCount} num`}>{count(s.n)}</span>
            </Link>
          );
        })}
      </nav>

      <nav className={styles.filterRow} aria-label="Filter by tier">
        <span className="label">Found at</span>
        <Link
          href={hrefWith('/matches', { run: runQ, status })}
          className={`${styles.filter} ${!tier ? styles.filterActive : ''}`}
          aria-current={!tier ? 'true' : undefined}
        >
          Any tier
        </Link>
        {TIERS.map((t) => (
          <Link
            key={t}
            href={hrefWith('/matches', { run: runQ, status, tier: tier === t ? undefined : t })}
            className={`${styles.filter} ${tier === t ? styles.filterActive : ''}`}
            aria-current={tier === t ? 'true' : undefined}
          >
            {label(TIER_LABEL, t)}
          </Link>
        ))}
      </nav>

      {data.matches.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing matches these filters.</p>
          {tier === 'manual' && (
            <p className={styles.emptyBody}>
              <strong>The manual tier is empty by construction on this build.</strong> It holds
              matches a human created from scratch through endpoint&nbsp;21, and that record picker
              is not built. <strong>Approving a proposal does not put it here</strong> — it keeps
              the tier it was found at and changes who confirmed it. To see your approvals, use{' '}
              <Link href={hrefWith('/matches', { run: runQ, status: 'human_confirmed' })}>
                Confirmed by · You
              </Link>.
            </p>
          )}
          {tier === 'alias' && (
            <p className={styles.emptyBody}>
              No alias has been taught yet, so nothing has been matched by substituting one. Teach
              one from the <Link href={hrefWith('/review', { run: runQ })}>review queue</Link> and
              this fills up on the next run.
            </p>
          )}
          <p className={styles.emptyBody}>
            <Link href={hrefWith('/matches', { run: runQ })}>Clear all filters</Link>.
          </p>
        </div>
      ) : (
        <>
          <div className={table.scroller}>
            <table className={table.table}>
              <caption className="sr-only">Confirmed and proposed matches</caption>
              <thead>
                <tr>
                  <th scope="col">Tier</th>
                  <th scope="col">Status</th>
                  <th scope="col">Members</th>
                  <th scope="col" className={table.numCol}>Amount</th>
                  <th scope="col" className={table.numCol}>Score</th>
                  <th scope="col">In Match Rate</th>
                  <th scope="col">Rule</th>
                </tr>
              </thead>
              <tbody>
                {data.matches.map((m) => (
                  <tr key={m.matchId}>
                    <td><Chip>{label(TIER_LABEL, m.tier)}</Chip></td>
                    <td className={table.nowrap}>{label(STATUS_LABEL, m.status)}</td>
                    <td>
                      <div className={styles.membersCell}>
                        {m.members.map((mem) => (
                          <span key={mem.transactionId} className={styles.member}>
                            <span className={styles.memberSource}>
                              {label(SOURCE_LABEL, mem.sourceSystem)}
                            </span>
                            <Link
                              href={hrefWith(`/records/${mem.transactionId}`, { run: runQ })}
                              className={`${table.mono} ${styles.memberLink}`}
                              translate="no"
                            >
                              {mem.externalId ?? mem.transactionId.slice(0, 8)}
                            </Link>
                            <span className={`${styles.memberAmount} num`}>
                              {mem.amountDisplay}
                            </span>
                          </span>
                        ))}
                        <span className={styles.memberDate}>
                          {m.members[0] ? day(m.members[0].txnDate) : ''}
                        </span>
                      </div>
                    </td>
                    <td className={`${table.numCol} num ${table.strong}`}>
                      {m.headlineAmountDisplay}
                    </td>
                    <td className={`${table.numCol} num ${table.muted}`}>
                      {ratio4(m.confidence)}
                    </td>
                    <td>
                      {m.countsTowardEngineMatchRate ? (
                        <Chip tone="verified">Counted</Chip>
                      ) : (
                        <Chip tone="outline" title="A proposal is not a match (ADR-040)">
                          Excluded
                        </Chip>
                      )}
                    </td>
                    <td className={table.mono} translate="no">{m.ruleId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Paginate
            pagination={data.pagination}
            unit="matches"
            hrefFor={(p) => hrefWith('/matches', {
              run: runQ, tier, page: p === 1 ? undefined : p,
            })}
          />
        </>
      )}
    </main>
  );
}
