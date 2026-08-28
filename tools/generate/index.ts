/**
 * Synthetic data generator (Day 5). Contract: docs/validation-strategy.md §1–§4.
 *
 * TRUTH FIRST — this is the whole design. The generator does not create messy
 * files and then work out what should match. It creates economic events, projects
 * them into source rows under a weighted scenario distribution, and writes the
 * answer key IN THE SAME PASS from the same in-memory structure. The key is a
 * byproduct of generation, not a post-hoc annotation, so it cannot disagree with
 * the data.
 *
 * Two constraints the classifier depends on (get these wrong and the engine looks
 * broken for reasons that are actually the generator's fault):
 *  - DUPLICATE_ROW must emit its copy carrying the SAME STRONG ANCHOR. Duplicates
 *    are detected by anchor evidence, never by amount+date+counterparty similarity,
 *    because IDENTITY_DESTROYED deliberately plants 3+ same-amount/day/merchant
 *    anchorless rows (ADR-034).
 *  - For every non-AMOUNT_TRUE_MISMATCH event, ledger `net_amount` must equal
 *    gateway `amount` EXACTLY. Gateway amount is what the customer was charged,
 *    which is ledger net — not ledger gross (ADR-037).
 *
 * Unresolvability is PROVEN during generation, not merely labelled
 * (validation-strategy §4): assert ≥3 indistinguishable candidates, run a real
 * subset-sum check, assert no event references the orphan row. Regenerate on failure.
 *
 * Determinism: a single seeded PRNG. No Math.random, no Date.now, anywhere.
 */
export {};
