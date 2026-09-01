import { ratio4 } from '@/lib/format';
import styles from './ScoreBars.module.css';

/**
 * A Tier 2 score, decomposed into the four components that produced it.
 *
 * Rendered as four small bars rather than one number because "0.65" answers
 * nothing and "amount agreed, date agreed, no shared reference, counterparty
 * close" answers the question actually being asked — WHY didn't this match. The
 * component weights are the engine's own (`configSnapshot.scoreWeights`), so a
 * full bar means that component contributed everything it could.
 */
const COMPONENTS: { key: string; label: string; max: number }[] = [
  { key: 'amount', label: 'Amount', max: 0.35 },
  { key: 'anchor', label: 'Anchor', max: 0.30 },
  { key: 'date', label: 'Date', max: 0.20 },
  { key: 'counterparty', label: 'Counterparty', max: 0.15 },
];

export function ScoreBars(
  { breakdown, total }: { breakdown: Record<string, number | boolean>; total?: number },
) {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className="sr-only">Score components and their contribution</caption>
        <tbody>
          {COMPONENTS.map(({ key, label, max }) => {
            const raw = breakdown[key];
            const value = typeof raw === 'number' ? raw : 0;
            const pctOfMax = max > 0 ? Math.min(100, (value / max) * 100) : 0;
            return (
              <tr key={key}>
                <th scope="row" className={styles.name}>{label}</th>
                <td className={styles.barCell}>
                  <span className={styles.track} aria-hidden="true">
                    <span className={styles.fill} style={{ width: `${pctOfMax}%` }} />
                  </span>
                </td>
                <td className={`${styles.value} num`}>{ratio4(value)}</td>
                <td className={`${styles.max} num`}>/ {max.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
        {total !== undefined && (
          <tfoot>
            <tr>
              <th scope="row" className={styles.name}>Total</th>
              <td />
              <td className={`${styles.value} ${styles.totalValue} num`}>{ratio4(total)}</td>
              <td className={`${styles.max} num`}>/ 1.00</td>
            </tr>
          </tfoot>
        )}
      </table>
      {breakdown['amountUnavailable'] === true && (
        <p className={styles.caveat}>
          One side carried no comparable amount, so the amount component scored on availability
          rather than agreement.
        </p>
      )}
    </div>
  );
}
