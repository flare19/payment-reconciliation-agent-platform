import type { ReactNode } from 'react';
import styles from './Section.module.css';

interface SectionProps {
  id: string;
  /** Rendered as the section's `<h2>`; also its accessible name. */
  title: string;
  /** The question this block answers. One sentence, no marketing. */
  standfirst?: ReactNode;
  /** Right-aligned in the header: a count, a link, a timestamp. */
  aside?: ReactNode;
  children: ReactNode;
}

export function Section({ id, title, standfirst, aside, children }: SectionProps) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.header}>
        <div className={styles.headingGroup}>
          <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
          {standfirst && <p className={styles.standfirst}>{standfirst}</p>}
        </div>
        {aside && <div className={styles.aside}>{aside}</div>}
      </div>
      {children}
    </section>
  );
}
