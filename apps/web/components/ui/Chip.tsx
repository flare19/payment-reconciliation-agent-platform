import type { ReactNode } from 'react';
import styles from './Chip.module.css';

/**
 * The one small labelled token in the system, in five tones.
 *
 * `severity` is the only tone that uses colour to carry meaning, because
 * severity is the only thing on these screens whose value is ordered and
 * urgent. Categories, statuses and sources get neutral tones — twenty coloured
 * chips in a table is a table nobody can scan, and colour that means nothing is
 * colour that stops meaning anything where it does.
 */
type Tone = 'neutral' | 'high' | 'medium' | 'low' | 'verified' | 'outline';

export function Chip(
  { tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string },
) {
  return (
    <span className={`${styles.chip} ${styles[tone]}`} title={title}>
      {children}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: string }) {
  const tone = severity === 'high' || severity === 'medium' || severity === 'low'
    ? severity : 'neutral';
  return <Chip tone={tone}>{severity.charAt(0).toUpperCase() + severity.slice(1)}</Chip>;
}

/**
 * Four actor colours so the mix is readable at a glance (ui-spec §6). A viewer
 * should be able to SEE that `llm` appears only in explanation events and
 * `agent` only in investigation events, never inside a match confirmation —
 * ADR-017 and ADR-048's boundary made visible in one screen, and a better
 * answer to "does the model decide anything?" than any paragraph.
 */
export function ActorChip({ actor }: { actor: string }) {
  return (
    <span className={`${styles.chip} ${styles.actor} ${styles[`actor_${actor}`] ?? ''}`}>
      <span className={styles.actorDot} aria-hidden="true" />
      {actor}
    </span>
  );
}
