/**
 * Offline scorer (Day 12). Contract: docs/validation-strategy.md §5.
 *
 * Reads engine output from the API and the answer key from disk, joins them on
 * (sourceSystem, sourceRowNumber), and POSTs a score report to endpoint 23.
 *
 * This is the ONLY place ground truth is read (ADR-021). It lives outside
 * `apps/api` on purpose: leak-freedom should be obvious to a reader in five
 * seconds rather than something you audit.
 *
 * Refuses to run if the key's manifest hashes disagree with the run's
 * `inputFileHashes` — scoring against the wrong dataset should be impossible,
 * not something you notice late.
 *
 * Reports, per validation-strategy §5:
 *   pairwise precision / recall / F1 + RAW false-positive count
 *   8×8 classification confusion matrix
 *   accuracy by difficulty (EASY/MEDIUM/HARD)
 *   unresolvable recall  ← below 100% is a BUILD BLOCKER, not a metric
 *   false-despair rate   ← the engine's honest headroom, and the Analyst's market
 *   review-queue precision (pending_review scored separately — ADR-040)
 *   Analyst: false-despair recovered, proposal precision,
 *            HALLUCINATED RESOLUTIONS (must be 0 — ADR-053), unresolvable agreement
 */
export {};
