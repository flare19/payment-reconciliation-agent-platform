import { day } from '@/lib/format';
import { SOURCE_LABEL, label } from '@/lib/taxonomy';
import type { RecordPreview } from '@/types/api';
import styles from './LinkedRecords.module.css';

/**
 * The source rows side by side, with differing fields marked.
 *
 * ui-spec §5: side-by-side raw rows are what makes a reconciliation demo land.
 * A panelist can verify the engine's reasoning with their own eyes instead of
 * taking the engine's word for it, and "these two rows differ HERE" is a
 * sentence a picture says faster than a paragraph.
 *
 * Difference is computed per FIELD across the set: a field is marked when the
 * records do not all agree on it. Amounts are compared on `amountPaise` — the
 * integer — never on the formatted string, because two different paise values
 * can format identically and a display-string comparison would call them equal.
 */
export function LinkedRecords(
  { primary, related }: { primary: RecordPreview; related: RecordPreview[] },
) {
  const all = [primary, ...related];

  const differs = {
    amount: new Set(all.map((r) => r.amountPaise)).size > 1,
    date: new Set(all.map((r) => r.txnDate)).size > 1,
    counterparty: new Set(all.map((r) => r.counterpartyRaw ?? '')).size > 1,
  };

  return (
    <div className={styles.grid}>
      {all.map((r, i) => (
        <article
          key={r.transactionId}
          className={`${styles.card} ${i === 0 ? styles.primary : ''}`}
        >
          <header className={styles.cardHead}>
            <span className={styles.source}>{label(SOURCE_LABEL, r.sourceSystem)}</span>
            {i === 0 && <span className={styles.primaryTag}>Subject</span>}
          </header>

          <dl className={styles.fields}>
            <div className={styles.field}>
              <dt>External ID</dt>
              <dd className="num" translate="no">{r.externalId ?? '—'}</dd>
            </div>

            <div className={`${styles.field} ${differs.amount ? styles.diff : ''}`}>
              <dt>Amount</dt>
              <dd className={`num ${styles.amount}`}>{r.amountDisplay}</dd>
            </div>

            <div className={`${styles.field} ${differs.date ? styles.diff : ''}`}>
              <dt>Date</dt>
              <dd>{day(r.txnDate)}</dd>
            </div>

            <div className={`${styles.field} ${differs.counterparty ? styles.diff : ''}`}>
              <dt>Counterparty</dt>
              <dd className={styles.counterparty} translate="no">{r.counterpartyRaw ?? '—'}</dd>
            </div>

            <div className={styles.field}>
              <dt>Source Row</dt>
              <dd className="num">#{r.sourceRowNumber}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}
