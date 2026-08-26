# What Broke

Required submission artifact. **Updated daily from Day 1** — not reconstructed on Day 12.
Format: date · what broke · how it was recovered · what changed as a result.

An empty day gets an explicit `—`. A missing day is worse than a boring one.

---

- **2026-08-23** — —
- **2026-08-24** — — *(Day 2: architecture documentation. Nothing broke; nothing was built.)*
- **2026-08-25** — *(Day 3: no session logged. If work happened this day, replace this line — a reconstructed entry is worth less than an honest gap, but an unmarked gap is worth least of all.)*
- **2026-08-26** — **Day 4: pre-build design review found three structural flaws in the Day 2 architecture. All three were in documentation only — no code existed yet, which is the entire reason the review happened before Day 5 rather than after.**

  1. **Two of the eight exception categories were unreachable.** `AMOUNT_MISMATCH` is defined as "identity established, amounts differ" — but a pair sharing a `payment_id` with a ₹412 discrepancy scored `0.45 + 0.00 + 0.15 + 0.10 = 0.70` in the fuzzy tier, landing in the 0.65–0.849 review band as a *proposed match*. It never reached classification, so the category could never fire. `TIMING_DRIFT` was worse: same anchor, correct amount, nine days late scored exactly `0.85` — the auto-confirm threshold — so the engine would have silently auto-matched settlements three times past their SLA and reported it as a clean match.
     **Recovered by:** a new pipeline stage (S8) that short-circuits pairs whose strong anchors agree. Identity is *established*, not scored — a similarity score answers "are these the same thing", and blending that with a date disagreement lets the calendar cancel out an identity proof. ADR-029.
     **Changed as a result:** [matching-engine.md](matching-engine.md) §6 exists; two regression tests are now mandatory ([testing-strategy.md](testing-strategy.md) §1.4) and both assert the *negative* — that the result is not a match — because the old behaviour produced a plausible number rather than an error.

  2. **Nothing at Tier 2 could ever auto-confirm.** Once fix #1 removed strong-anchor pairs from the fuzzy tier's domain, the remaining weights capped a weak-anchor pair at `0.25+0.30+0.15+0.10 = 0.80`, below the 0.85 threshold. Every fuzzy match in every run would have queued for human review.
     **Recovered by:** rebalanced weights (anchor 0.30 / amount 0.35 / date 0.20 / counterparty 0.15). ADR-030.
     **Changed as a result:** the fix produced a better property than the original design had — a pair with **no shared reference of any kind now caps at 0.70 and can never be auto-confirmed**, at any amount, on any date. That guarantee falls out of the arithmetic rather than a tunable threshold, and it is now one of the four structural defences against inventing a match.

  3. **`ARCHITECTURE.md` did not exist.** Every one of the six Day 2 docs cited it as the scope lock — 23 references across seven files, to §3, §4, §4.4, §4.6, §4.7, §5, §6, §7 and §7.4. The whole doc set hung off a file nobody had written.
     **Recovered by:** authoring it, reconstructing the section numbering the existing references already assumed. ADR-047.

  Also found and fixed: Tier 1's date window contradicted §5.2 and would have failed every T+2 card settlement (ADR-028); the duplicate-detection rule collided with the generator's own `IDENTITY_DESTROYED` class and would have misclassified the dataset's hardest designed case (ADR-034); ground-truth metrics were specified inside `runs.metrics`, a column the API writes, which would have required the API to read the answer key in direct contradiction of ADR-021 (ADR-041); gateway amount was specified to compare against ledger *gross* when the arithmetic requires ledger *net* (ADR-037); and `MISSING_IN_BANK` used the wall clock, so the same dataset would have produced different exception counts in August and September (ADR-039).

  **The honest summary:** the Day 2 architecture read well and was internally wrong in three places that no amount of careful writing would have surfaced. Writing the *algorithm* down — which stage runs when, and what each one hands the next — is what exposed all three within an hour. Twenty ADRs, nothing built yet, and a day spent not writing code that would have needed rewriting on Day 9.
