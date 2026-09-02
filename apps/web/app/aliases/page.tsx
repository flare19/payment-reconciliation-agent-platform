import Link from 'next/link';
import { Disclosure } from '@/components/ui/Disclosure';
import { Chip } from '@/components/ui/Chip';
import { Paginate } from '@/components/ui/Paginate';
import table from '@/components/ui/table.module.css';
import { listAliases } from '@/lib/api-client';
import { at, count } from '@/lib/format';
import { hrefWith, one } from '@/lib/run-context';
import styles from './aliases.module.css';

/**
 * The alias ledger — the learning loop, read-only.
 *
 * Priority 3 in ui-spec §8, degraded exactly as that order specifies: a
 * read-only table here, with alias CREATION still working from the review
 * queue, which is where it actually matters. A reviewer teaches an alias at the
 * moment they are looking at the match that proves it; a form on this page that
 * lets someone invent a mapping with no evidence in front of them is the
 * feature working backwards.
 *
 * ALIASES ARE NEVER EDITED IN PLACE. A correction supersedes rather than
 * overwrites, so the lineage stays readable and a wrong rule taught on Tuesday
 * is still visible on Friday next to the rule that replaced it.
 */

export const dynamic = 'force-dynamic';

export default async function AliasesPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const status = one(params, 'status');
  const page = Number(one(params, 'page') ?? '1') || 1;

  /**
   * THE ALIAS LEDGER IS GLOBAL, SO THIS SCREEN RESOLVES NO RUN — `learned_aliases`
   * is not per-run and nothing here is filtered by one. It still has to CARRY the
   * run, because a reader passes through Aliases on the way somewhere else: drop
   * `?run=` here and the next nav click silently reverts to the default run.
   * Carried, never read.
   */
  const runQ = one(params, 'run');

  const data = await listAliases({ status, page });

  return (
    <main id="main" className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Aliases</h1>
        <p className={styles.lede}>
          Corrections a person taught the system —{' '}
          <span translate="no">AMZN → AMAZON RETAIL</span>.
        </p>
        <Disclosure summary="What the engine does with one">
          <p>
            Before deciding that two records cannot be matched exactly, the engine substitutes
            every alias it has been taught and runs the exact-match test again. One correction
            made once therefore keeps paying out on every later run — which is the whole argument
            for asking a person rather than guessing.
          </p>
        </Disclosure>
      </header>

      {data.aliases.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No aliases have been taught yet.</p>
          <p className={styles.emptyBody}>
            That is why every run so far is a <strong>cold</strong> run, and why the dashboard
            reports the same figure for cold start as for the headline match rate. The number to
            watch once this fills up is the <em>leverage ratio</em>: records auto-resolved divided
            by corrections made. One correction resolving six records is the whole argument for the
            feature; one resolving one is not.
          </p>
          <p className={styles.emptyBody}>
            Aliases are taught from the{' '}
            <Link href={hrefWith('/review', { run: runQ })}>review queue</Link>, where the match that justifies the mapping is
            on screen beside it.
          </p>
        </div>
      ) : (
        <>
          <div className={table.scroller}>
            <table className={table.table}>
              <caption className="sr-only">Learned aliases and their lineage</caption>
              <thead>
                <tr>
                  <th scope="col">Mapping</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col" className={table.numCol}>Applied</th>
                  <th scope="col">Taught By</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {data.aliases.map((a) => (
                  <tr key={a.aliasId}>
                    <td>
                      <span className={styles.mapping} translate="no">
                        <span className={styles.raw}>{a.rawValue}</span>
                        <span className={styles.arrow} aria-label="maps to">→</span>
                        <span className={styles.canonical}>{a.canonicalValue}</span>
                      </span>
                      {/*
                        `note` was never a field the API sends. Replaced with the
                        conflict state, which IS served and is the thing a reader
                        of this ledger actually needs: §6.3 holds a conflicted
                        alias out of Tier 1.5 until a second human confirms it,
                        so an alias can be `active` and still resolve nothing.
                      */}
                      {!a.eligibleForAliasTier && a.status === 'active' && (
                        <span className={styles.note}>
                          Held out of Tier 1.5 — {count(a.conflictCount)}{' '}
                          {a.conflictCount === 1 ? 'conflict' : 'conflicts'}, needs a second
                          confirmation before the engine will apply it.
                        </span>
                      )}
                      {a.revokedReason && (
                        <span className={styles.revoked}>Revoked: {a.revokedReason}</span>
                      )}
                    </td>
                    <td className={table.mono} translate="no">{a.aliasType}</td>
                    <td>
                      <Chip tone={a.status === 'active' ? 'verified' : 'outline'}>
                        {a.status}
                      </Chip>
                    </td>
                    <td className={`${table.numCol} num`}>
                      {a.appliedCount === 0 ? '—' : count(a.appliedCount)}
                    </td>
                    <td className={table.muted} translate="no">{a.createdBy}</td>
                    <td className={`${table.muted} ${table.nowrap}`}>{at(a.approvedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Paginate
            pagination={data.pagination}
            unit="aliases"
            hrefFor={(p) => hrefWith('/aliases', {
              run: runQ, status, page: p === 1 ? undefined : p,
            })}
          />
        </>
      )}
    </main>
  );
}
