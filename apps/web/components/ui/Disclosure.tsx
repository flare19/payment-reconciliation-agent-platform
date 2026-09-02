import type { ReactNode } from 'react';
import styles from './Disclosure.module.css';

/**
 * THE OTHER HALF OF THE COPY RULE.
 *
 * Standfirsts were cut to ten words on the argument that a panelist has under a
 * minute (backlog item 8). Cutting alone would have deleted the reasoning that
 * makes several of these screens defensible — that the rule-level answer renders
 * identically with the model switched off, that the chain is recomputed rather
 * than asserted, that a group is reported at its weakest leg. None of that is
 * marketing; it is the argument the project is making, and it belongs on the
 * page.
 *
 * So it moves down one level rather than out. `Figure` already proved the
 * pattern for numbers; this is the same disclosure for prose, extracted so that
 * a section and a page header can both use it without six copies of the CSS.
 *
 * A `<details>` and not a hover, for the reason `Figure` gives: hover exposes
 * nothing to a keyboard or a touch screen.
 */
export function Disclosure({
  summary, children,
}: {
  /** What the reader is choosing to open. A phrase, not a sentence. */
  summary: string;
  children: ReactNode;
}) {
  return (
    <details className={styles.wrap}>
      <summary className="disclosure">
        <span className="disclosure-text">{summary}</span>
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
