import Link from 'next/link';
import { CategoryAccuracy } from '@/components/exceptions/CategoryAccuracy';
import { SegmentBar, type Segment } from '@/components/ui/SegmentBar';
import { count, oneDp } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import type { EngineMetrics } from '@/types/api';
import styles from './ExceptionBreakdown.module.css';

/**
 * ui-spec §2 block 3 — exceptions by category, each a way into the list.
 *
 * THE SPEC ASKS FOR SEVERITY AS COLOUR WITHIN EACH CATEGORY BAR, AND THAT
 * CROSS-TAB DOES NOT EXIST. Endpoint 5 reports `byCategory` and `bySeverity` as
 * two independent distributions; endpoint 6's facets do the same. Nothing the
 * API serves says how many `MISSING_IN_LEDGER` exceptions are `high`. Colouring
 * the bars by severity would therefore mean inventing the split, and a
 * fabricated breakdown on the screen whose entire subject is honesty is not a
 * trade worth making for a nicer chart. Severity is drawn as its own
 * distribution instead, over the same 212 exceptions, which is exactly as true
 * and says so.
 */

const GLOSS: Record<string, string> = {
  MISSING_IN_LEDGER: 'Seen by the gateway or the bank, never booked to the ledger.',
  MISSING_IN_GATEWAY: 'In the bank or the ledger, with no gateway record behind it.',
  MISSING_IN_BANK: 'Captured and booked, but never seen settling in the bank.',
  AMBIGUOUS_MATCH: 'Two or more candidates too close to separate. The engine refused to choose.',
  AMOUNT_MISMATCH: 'Agreeing on identity, disagreeing on amount beyond tolerance.',
  DUPLICATE_RECORD: 'The same source record present more than once.',
  UNSPLITTABLE_BATCH: 'A netted credit the engine could not decompose into its payments.',
  TIMING_DRIFT: 'Matched, but settling outside the expected window for its instrument.',
};

const LABEL: Record<string, string> = {
  MISSING_IN_LEDGER: 'Missing in Ledger',
  MISSING_IN_GATEWAY: 'Missing in Gateway',
  MISSING_IN_BANK: 'Missing in Bank',
  AMBIGUOUS_MATCH: 'Ambiguous Match',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  DUPLICATE_RECORD: 'Duplicate Record',
  UNSPLITTABLE_BATCH: 'Unsplittable Batch',
  TIMING_DRIFT: 'Timing Drift',
};

const SEVERITY_ORDER = ['high', 'medium', 'low'] as const;

/**
 * `runQ` is threaded in rather than resolved here: these links leave the
 * dashboard, and a category link that drops the run lands the reader on a
 * DIFFERENT run's exceptions filtered by the category they clicked. It is
 * `undefined` for the default run so the common case keeps a clean URL.
 */
export function ExceptionBreakdown(
  { engine, runQ, accuracy, hasScoreReport }: {
    engine: EngineMetrics;
    runQ: string | undefined;
    /**
     * `measured.classification.multiLabel.perCategory` — precision/recall per
     * category, scored offline (ADR-041). `null` when no report exists; a
     * category absent from the map has no true events in the key.
     */
    accuracy: Record<string, { precision: number; recall: number }> | null;
    hasScoreReport: boolean;
  },
) {
  const { exceptions } = engine;

  const rows = Object.entries(exceptions.byCategory)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  const largest = rows[0]?.[1] ?? 0;

  const severitySegments: Segment[] = SEVERITY_ORDER.map((sev) => ({
    key: sev,
    label: sev.charAt(0).toUpperCase() + sev.slice(1),
    value: exceptions.bySeverity[sev] ?? 0,
    color: `var(--sev-${sev})`,
    gloss:
      sev === 'high'
        ? 'Escalated by the money at risk, not fixed per category.'
        : undefined,
  }));

  if (rows.length === 0) {
    return (
      <p className={styles.empty}>
        This run produced no exceptions. On a dataset with a computed ceiling below 100%, that
        would itself be a finding worth checking.
      </p>
    );
  }

  return (
    <div className={styles.wrap}>
      <div>
        <ol className={styles.list}>
          {rows.map(([category, n]) => (
            <li key={category} className={styles.row}>
              <Link
                href={hrefWith('/exceptions', { category, run: runQ })}
                className={styles.link}
              >
                <span className={styles.rowHead}>
                  <span className={styles.name} translate="no">
                    {LABEL[category] ?? category}
                  </span>
                  <span className={styles.figures}>
                    <span className={`${styles.n} num`}>{count(n)}</span>
                    <span className={`${styles.share} num`}>
                      {oneDp((n / exceptions.total) * 100)}%
                    </span>
                  </span>
                </span>
                <span className={styles.track} aria-hidden="true">
                  <span
                    className={styles.fill}
                    style={{ width: `${largest > 0 ? (n / largest) * 100 : 0}%` }}
                  />
                </span>
                <span className={styles.meta}>
                  {GLOSS[category] && <span className={styles.gloss}>{GLOSS[category]}</span>}
                  <CategoryAccuracy pr={accuracy?.[category]} hasReport={hasScoreReport} />
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </div>

      <div className={styles.side}>
        <div className={styles.severity}>
          <h3 className="label">Severity, Across All {count(exceptions.total)}</h3>
          <SegmentBar
            segments={severitySegments}
            total={exceptions.total}
            unit="Exceptions"
            caption="Exceptions by computed severity"
          />
          <p className={styles.sideNote}>
            Severity is computed from the money at risk rather than fixed per category, so a small
            ambiguity ranks below a large one instead of beside it.
          </p>
        </div>

        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt className="label">Proved Impossible</dt>
            <dd className={`${styles.factValue} num`}>{count(exceptions.batchSearchExhausted)}</dd>
            <p className={styles.factNote}>
              The engine proved no combination of records adds up, inside bounds it declared
              before it started.
            </p>
          </div>
          <div className={styles.fact}>
            <dt className="label">Ran Out of Room</dt>
            <dd className={`${styles.factValue} num`}>
              {count(exceptions.batchSearchBoundExceeded)}
            </dd>
            <p className={styles.factNote}>
              Ran out of search room. A weaker claim than the one above, and reported separately
              because they are different claims.
            </p>
          </div>
          <div className={styles.fact}>
            <dt className="label">Too Many Candidates</dt>
            <dd className={`${styles.factValue} num`}>{count(exceptions.candidateCapHits)}</dd>
            <p className={styles.factNote}>
              Exceptions whose candidate list was truncated before scoring finished.
            </p>
          </div>
        </dl>
      </div>
    </div>
  );
}
