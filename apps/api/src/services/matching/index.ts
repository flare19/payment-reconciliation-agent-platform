/**
 * The matching engine — stages S4–S11.
 *
 * Execution order and every guarantee is docs/matching-engine.md. That doc is
 * binding; this module implements it and does not reinterpret it.
 *
 *   S4  DEDUPE     dedupe.ts                same-source, ANCHOR EVIDENCE REQUIRED
 *   S5  BLOCK      blocking.ts              4 in-memory indexes, candidate cap
 *   S6  TIER 1     tier1-exact.ts           per-pair window + per-pair amount basis
 *   S7  TIER 1.5   tier1_5-alias.ts         substitute, then re-run the TIER 1 predicate
 *   S8  IDENTITY   identity-resolution.ts   strong anchors agree => NEVER scored
 *   S9  TIER 2     tier2-fuzzy.ts           scoring.ts + assignment.ts
 *   S10 BATCH      batch-decomposition.ts   bounded subset-sum, two distinct failures
 *   S11 GROUP      group-assembly.ts        pairs -> groups, conflicts REFUSED
 *
 * Three invariants that are easy to break and expensive to debug:
 *  1. Determinism (ADR-032). Explicit ORDER BY on every decision-feeding query;
 *     no Math.random, no Date.now, no Set/Map iteration order; scores rounded to
 *     4dp BEFORE comparison; ties broken by compareCanonical.
 *  2. Nothing here reads the wall clock. "Has the window elapsed?" uses
 *     `config.referenceDate` (ADR-039).
 *  3. Nothing here imports from `services/agent` or `data/truth` (ADR-021, ADR-048).
 */
export {};
