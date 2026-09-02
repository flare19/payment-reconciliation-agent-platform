import type { ReactNode } from 'react';
import styles from './ModelVoice.module.css';

/**
 * WORDS A MODEL WROTE, SET SO THAT NOBODY HAS TO BE TOLD.
 *
 * Until now every sentence on the site was the same ink: the ones the engine
 * computed, the ones we wrote about the engine, and the ones a model produced.
 * On a page whose entire argument is *which part of this did the model do*,
 * that was the one distinction the typography did not make.
 *
 * THIS IS NOT A SECOND PROVENANCE, and it deliberately shares no signal with
 * one (ADR-098, ADR-139). Provenance asks how far a NUMBER can be trusted, and
 * answers in colour — `--verified`, a tick, a tinted tile. Voice asks whose
 * SENTENCE this is, and answers the way print has always answered it: the words
 * are quoted, set to a narrower measure, and attributed. No tick, no
 * `--verified`, no tinted panel — a reader who has learned that teal means
 * *checked against an answer key* must never meet teal on a paragraph nobody
 * checked.
 *
 * THE RULE THAT MAKES IT WORTH ANYTHING: only the model's OWN words go in here.
 * Our sentences about the model — the verdict gloss, the grounding banner, the
 * footnote explaining what a cached explanation is — stay in the interface's
 * voice, because a reader has to be able to tell a claim the model made from a
 * claim we make on its behalf. A template-written explanation is likewise NOT
 * in this voice, and that is how the page shows, without a word, that the model
 * did not write it.
 */
export function ModelVoice({
  children, attribution, size = 'normal',
}: {
  /** The model's own words, and nothing else. */
  children: ReactNode;
  /** Who said it and from what. Omitted where a label directly above says so. */
  attribution?: ReactNode;
  /** `lead` for the one explanation that heads a page. */
  size?: 'normal' | 'lead';
}) {
  return (
    <figure className={`${styles.voice} ${styles[size]}`}>
      {/* Decorative: the quotation is a signal to the eye, and a screen reader
          gets the same information from the attribution and the labels. */}
      <span className={styles.mark} aria-hidden="true">&ldquo;</span>
      <blockquote className={styles.body}>{children}</blockquote>
      {attribution && <figcaption className={styles.attribution}>{attribution}</figcaption>}
    </figure>
  );
}
