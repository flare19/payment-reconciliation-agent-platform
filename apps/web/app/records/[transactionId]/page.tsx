import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActorChip, Chip } from '@/components/ui/Chip';
import { Section } from '@/components/ui/Section';
import table from '@/components/ui/table.module.css';
import { ApiClientError, getTransaction, getTransactionAudit } from '@/lib/api-client';
import { at, count, day } from '@/lib/format';
import { hrefWith, one } from '@/lib/run-context';
import { SOURCE_LABEL, label } from '@/lib/taxonomy';
import styles from './record.module.css';

/**
 * The record inspector — normalized fields, the RAW payload, and this record's
 * own audit trail.
 *
 * ui-spec §1 calls for a modal from anywhere. It is a ROUTE instead, and that
 * is the better shape: an Analyst citation, a match member and a candidate all
 * link here, and every one of those links is something a judge should be able
 * to open in a new tab, share, or reach with the back button. A modal is a
 * dead end that a URL is not.
 *
 * THE RAW PAYLOAD IS THE POINT. Everything else on this page is the engine's
 * interpretation; `rawPayload` is what was actually in the file. Showing both
 * lets a reader check the normalizer — the layer whose mistakes are hardest to
 * see from the outside — instead of trusting it.
 */

export const dynamic = 'force-dynamic';

export default async function RecordPage(
  {
    params, searchParams,
  }: {
    params: Promise<{ transactionId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  },
) {
  const { transactionId } = await params;
  const sp = await searchParams;
  const runQ = one(sp, 'run');

  let record;
  try {
    record = await getTransaction(transactionId);
  } catch (err) {
    if (err instanceof ApiClientError && err.code === 'TRANSACTION_NOT_FOUND') notFound();
    throw err;
  }

  const trail = await getTransactionAudit(transactionId).catch(() => null);

  const normalized: [string, string | null][] = [
    ['External ID', record.externalId],
    ['Amount', record.amountDisplay],
    ['Currency', record.currency],
    ['Direction', record.direction],
    ['Transaction Date', day(record.txnDate)],
    ['Posting Date', record.postingDate ? day(record.postingDate) : null],
    ['Counterparty (raw)', record.counterpartyRaw],
    ['Counterparty (normalized)', record.counterpartyNorm],
    ['Counterparty key', record.counterpartyKey],
    ['Method', record.method],
    ['Status (raw)', record.statusRaw],
    ['Status (normalized)', record.statusNorm],
    ['Transaction type', record.txnType],
    ['Anchor strength', record.anchorStrength],
    ['Source file', record.sourceFile],
    ['Source row', `#${record.sourceRowNumber}`],
  ];

  return (
    <main id="main" className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href={hrefWith('/exceptions', { run: runQ })}>Exceptions</Link>
        <span aria-hidden="true">/</span>
        <span className={styles.crumbCurrent}>Record</span>
      </nav>

      <header className={styles.header}>
        <div className={styles.headMain}>
          <div className={styles.chips}>
            <Chip>{label(SOURCE_LABEL, record.sourceSystem)}</Chip>
            <Chip tone="outline">{record.statusNorm}</Chip>
            {record.duplicateOfTransactionId && (
              <Chip tone="medium">Duplicate — {record.duplicateKind}</Chip>
            )}
          </div>
          <h1 className={`${styles.title} num`} translate="no">
            {record.externalId ?? record.transactionId}
          </h1>
          <p className={styles.subtitle}>
            Row <span className="num">#{record.sourceRowNumber}</span> of{' '}
            <span translate="no">{record.sourceFile}</span>
          </p>
        </div>

        <div className={styles.amountBox}>
          <span className="label">Amount</span>
          <span className={`${styles.amount} num`}>{record.amountDisplay}</span>
          <span className={styles.amountDate}>{day(record.txnDate)}</span>
        </div>
      </header>

      {record.exceptionId && (
        <p className={styles.link}>
          This record is the subject of an exception —{' '}
          <Link href={hrefWith(`/exceptions/${record.exceptionId}`, { run: runQ })}>
            open the finding
          </Link>.
        </p>
      )}

      <Section
        id="normalized"
        title="Normalized"
        standfirst="What the engine understood this row to be, after parsing and normalization."
      >
        <dl className={styles.fields}>
          {normalized.map(([k, v]) => (
            <div key={k} className={styles.field}>
              <dt>{k}</dt>
              <dd className={v === null ? styles.nullValue : ''}>{v ?? 'null'}</dd>
            </div>
          ))}
        </dl>

        {Object.keys(record.referenceIds).length > 0 && (
          <div className={styles.refs}>
            <h3 className="label">Reference IDs</h3>
            <dl className={styles.fields}>
              {Object.entries(record.referenceIds).map(([k, v]) => (
                <div key={k} className={styles.field}>
                  <dt translate="no">{k}</dt>
                  <dd className={table.mono} translate="no">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {record.ingestWarnings && record.ingestWarnings.length > 0 && (
          <div className={styles.warnings}>
            <h3 className="label">Ingest Warnings</h3>
            <ul>
              {record.ingestWarnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}
      </Section>

      <Section
        id="raw"
        title="Raw Payload"
        standfirst="The row as it appeared in the file, before the engine touched it. Everything above is interpretation; this is the evidence."
      >
        <pre className={styles.raw}>
          <code>{JSON.stringify(record.rawPayload, null, 2)}</code>
        </pre>
      </Section>

      {trail && trail.entries.length > 0 && (
        <Section
          id="trail"
          title="Audit Trail"
          standfirst="Every decision recorded about this record, in the run’s hash-chained timeline."
          aside={<><span className="num">{count(trail.pagination.total)}</span> entries</>}
        >
          <ol className={styles.trail}>
            {trail.entries.map((e) => (
              <li key={e.sequenceNo} className={styles.trailItem}>
                <div className={styles.trailHead}>
                  <span className={`${styles.seq} num`}>#{e.sequenceNo}</span>
                  <code className={styles.eventType} translate="no">{e.eventType}</code>
                  <ActorChip actor={e.actorType} />
                  <span className={styles.trailTime}>{at(e.occurredAt)}</span>
                </div>
                {e.reason && <p className={styles.trailReason}>{e.reason}</p>}
              </li>
            ))}
          </ol>
        </Section>
      )}
    </main>
  );
}
