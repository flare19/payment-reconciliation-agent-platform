import type { ReactNode } from 'react';
import { Disclosure } from './Disclosure';
import styles from './Section.module.css';

interface SectionProps {
  id: string;
  /** Rendered as the section's `<h2>`; also its accessible name. */
  title: string;
  /**
   * The question this block answers. **Ten words or fewer** (backlog item 8) —
   * a panelist is given thirty to sixty seconds and an essay under every heading
   * spends them.
   *
   * Short is not the same operation as unambiguous, and the second is the one
   * that matters more: `874 of 920 ingested` was three words hiding a three-term
   * accounting identity, and the preposition invited the reader to supply
   * *missed* (ADR-106). A compression that creates ambiguity is worse than the
   * long sentence it replaced. Anything that cannot be said briefly without
   * becoming ambiguous goes in `basis` instead of being squeezed.
   */
  standfirst?: ReactNode;
  /** The reasoning the standfirst no longer carries, behind a disclosure. */
  basis?: { summary: string; body: ReactNode };
  /** Right-aligned in the header: a count, a link, a timestamp. */
  aside?: ReactNode;
  children: ReactNode;
}

export function Section({ id, title, standfirst, basis, aside, children }: SectionProps) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.header}>
        <div className={styles.headingGroup}>
          <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
          {standfirst && <p className={styles.standfirst}>{standfirst}</p>}
          {basis && <Disclosure summary={basis.summary}>{basis.body}</Disclosure>}
        </div>
        {aside && <div className={styles.aside}>{aside}</div>}
      </div>
      {children}
    </section>
  );
}
