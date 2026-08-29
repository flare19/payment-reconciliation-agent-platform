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
 *   tier attribution  ← the key's viaTier distribution vs the engine's per-tier
 *                       PAIR counts. A DIAGNOSTIC, never an accuracy term.
 *   Analyst: false-despair recovered, proposal precision,
 *            HALLUCINATED RESOLUTIONS (must be 0 — ADR-053), unresolvable agreement
 *
 * ── READ ADR-072 AND §5.1.2 BEFORE JOINING ANYTHING ON TIER ──
 * `viaTier` is not comparable to `matches.tier`. The key labels a PAIR; the
 * engine reports a GROUP, at the WEAKEST tier among its constituent pairs
 * (matching-engine.md §10 rule 5). On the holdout 413 of 658 matched pairs
 * (63%) disagree — 375 of them a Tier 1 pair sitting in a group correctly
 * reported `fuzzy` because it also holds a fuzzy third leg. Every one of those
 * is matched correctly and completely.
 *
 * Correctness is PAIR MEMBERSHIP alone: did the engine put these two records in
 * one group? Two further cases, neither a recall miss:
 *   · tier fall-through (gateway<->bank labelled `exact`, reached at Tier 2)
 *     is matched, not missed;
 *   · a pair whose EVENT-level expectedOutcome is EXCEPTION is scored against
 *     the classification key (§5.2), never against the pairing key — the
 *     AMOUNT_TRUE_MISMATCH case, where the pair key says shouldMatch: true and
 *     the engine is right to refuse.
 */
export {};
