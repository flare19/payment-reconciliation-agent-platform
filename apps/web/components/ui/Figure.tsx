import type { ReactNode } from 'react';
import styles from './Figure.module.css';

/**
 * WHERE A NUMBER CAME FROM, RENDERED.
 *
 * `engine`   — the engine's account of itself. Ink, unmarked.
 * `measured` — scored offline against an answer key that existed before the
 *              engine ran. Carries the verified accent and says so in words.
 * `absent`   — no measurement exists. Renders the reason, muted. NEVER a zero,
 *              never an engine figure wearing a measured label.
 *
 * The third case is the one that matters. ADR-041 forbids a ground-truth-shaped
 * number arriving from the engine's own table, and ADR-020 forbids showing a
 * match rate without its false-positive count. Both are rules about what a
 * viewer is allowed to conclude, so both have to hold at a glance — which means
 * the component that renders a figure has to know its provenance, and there has
 * to be no way to render one without stating it.
 */
export type Provenance = 'engine' | 'measured' | 'absent';

interface FigureProps {
  label: string;
  provenance: Provenance;
  /** Required unless `provenance` is `absent`, where `absentReason` speaks instead. */
  value?: ReactNode;
  /**
   * A short qualifier set on the figure's own baseline — `wrong matches`,
   * `maximum`.
   *
   * Optical, and then substantive. `0` beside `65.22%` reads as an empty tile
   * rather than as the strongest claim on the page, because one glyph cannot
   * hold a line four glyphs long. `0 wrong matches` holds it, and says what the
   * zero is a zero OF — which is the more useful sentence anyway.
   */
  unit?: string;
  /** Why there is no number. Rendered in place of the value. */
  absentReason?: string;
  /** One line under the figure: the denominator, the basis, the count behind it. */
  note?: ReactNode;
  /**
   * The full basis, behind a disclosure.
   *
   * ui-spec §2 asks for this on hover. It is a disclosure instead, deliberately:
   * hover exposes nothing to a keyboard or a touch screen, and "the denominator
   * is inspectable" is a claim this project cannot afford to make only to people
   * using a mouse.
   */
  basis?: { summary: string; body: string };
  size?: 'hero' | 'normal';
}

function VerifiedMark() {
  return (
    <svg className={styles.tick} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M1.5 6.4 4.3 9.2 10.5 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Figure({
  label, provenance, value, unit, absentReason, note, basis, size = 'normal',
}: FigureProps) {
  const isAbsent = provenance === 'absent';

  return (
    <div
      className={`${styles.figure} ${styles[size]} ${styles[provenance]}`}
      data-provenance={provenance}
    >
      <div className={styles.head}>
        <span className="label">{label}</span>
        {provenance === 'measured' && (
          <span className={styles.provenanceChip}>
            <VerifiedMark />
            Measured
          </span>
        )}
      </div>

      {isAbsent ? (
        <p className={styles.absentValue}>{absentReason ?? 'Not measured'}</p>
      ) : (
        <p className={`${styles.value} num`}>
          {value}
          {unit && <span className={styles.unit}>{unit}</span>}
        </p>
      )}

      {note && <p className={styles.note}>{note}</p>}

      {basis && (
        <details className={styles.basis}>
          <summary className="disclosure">
            <span className="disclosure-text">{basis.summary}</span>
          </summary>
          <p className={styles.basisBody}>{basis.body}</p>
        </details>
      )}
    </div>
  );
}
