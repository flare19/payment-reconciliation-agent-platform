import styles from './loading.module.css';

/**
 * Skeletons, not a spinner (ui-spec §9). A spinner on the landing page during a
 * judge's first three seconds reads as "broken"; a skeleton in the shape of the
 * headline row reads as "the numbers are on their way".
 *
 * The shapes deliberately match the real layout's proportions, so nothing jumps
 * when the data lands.
 */
export default function Loading() {
  return (
    <div className={styles.page} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the run…</span>

      <div className={styles.hero}>
        <div className={`${styles.bar} ${styles.titleBar}`} />
        <div className={`${styles.bar} ${styles.lineBar}`} />
        <div className={`${styles.bar} ${styles.lineBarShort}`} />
      </div>

      <div className={styles.row}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={styles.tile}>
            <div className={`${styles.bar} ${styles.labelBar}`} />
            <div className={`${styles.bar} ${styles.figureBar}`} />
            <div className={`${styles.bar} ${styles.noteBar}`} />
          </div>
        ))}
      </div>

      <div className={`${styles.bar} ${styles.trackBar}`} />
    </div>
  );
}
