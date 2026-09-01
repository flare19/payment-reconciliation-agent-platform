import styles from './SegmentBar.module.css';

export interface Segment {
  key: string;
  label: string;
  value: number;
  /** A CSS colour — a `var(--tier-n)` from the ordinal ramp, or a severity token. */
  color: string;
  /** Renders hatched: present in the bar, but not a member of the ordinal scale. */
  isVoid?: boolean;
  /** One line in the legend saying what this segment actually counts. */
  gloss?: string;
}

interface SegmentBarProps {
  segments: Segment[];
  /** What the segments sum to. Passed in rather than derived: the caller knows
   *  whether a leftover belongs in the bar, and a bar that silently normalises
   *  to its own sum can never show a gap that is really there. */
  total: number;
  /** Names the unit being divided up — "pairs", "records", "exceptions". */
  unit: string;
  /** Accessible caption for the legend table. */
  caption: string;
}

const pct = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);

const pctFormatter = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 1, maximumFractionDigits: 1,
});
const intFormatter = new Intl.NumberFormat('en-IN');

export function SegmentBar({ segments, total, unit, caption }: SegmentBarProps) {
  const shown = segments.filter((s) => s.value > 0);

  if (shown.length === 0) {
    return (
      <p className={styles.empty}>
        No {unit} to attribute — this run produced none.
      </p>
    );
  }

  return (
    <div className={styles.wrap}>
      {/* Decoration over the table below, which carries the same numbers in a
          form a screen reader and a copy-paste can both use. */}
      <div className={styles.track} aria-hidden="true">
        {shown.map((s) => (
          <span
            key={s.key}
            className={`${styles.segment} ${s.isVoid ? styles.void : ''}`}
            style={{
              width: `${pct(s.value, total)}%`,
              ...(s.isVoid ? {} : { background: s.color }),
            }}
          />
        ))}
      </div>

      <table className={styles.legend}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Segment</th>
            <th scope="col" className={styles.numCol}>{unit}</th>
            <th scope="col" className={styles.numCol}>Share</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.key}>
              <th scope="row" className={styles.nameCell}>
                <span
                  className={`${styles.swatch} ${s.isVoid ? styles.void : ''}`}
                  style={s.isVoid ? undefined : { background: s.color }}
                />
                <span className={styles.name}>
                  {s.label}
                  {s.gloss && <span className={styles.gloss}>{s.gloss}</span>}
                </span>
              </th>
              <td className={`${styles.numCol} num`}>{intFormatter.format(s.value)}</td>
              <td className={`${styles.numCol} num ${styles.share}`}>
                {pctFormatter.format(pct(s.value, total))}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
