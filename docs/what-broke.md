# What Broke

Required submission artifact. **Updated daily from Day 1** — not reconstructed on the final day.
Format: date · what broke · how it was recovered · what changed as a result.

An empty day gets an explicit `—`. A missing day is worse than a boring one.

---

- **2026-08-23** — —
- **2026-08-24** — — *(Day 2: architecture documentation. Nothing broke; nothing was built.)*
- **2026-08-25** — *(no session. Deliberately **not** a numbered build day: numbering a day nobody worked inflated every subsequent day by one, which is why the count was corrected on Day 4.)*
- **2026-08-26** — **Day 3, first pass: pre-build design review found three structural flaws in the Day 2 architecture. All three were in documentation only — no code existed yet, which is the entire reason the review happened before Day 5 rather than after.**

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

- **2026-08-26** — **Day 3, second pass: read the architecture back against the track's actual problem statement and found it answering a different question.**

  The statement says *"Build an agent that closes one finance-ops loop."* What had been designed was a deterministic rules engine: fourteen of fifteen stages are arithmetic, tie-breaks and rule precedence, and the only AI touchpoint (S13) writes captions for decisions the engine already finalized — with a template fallback that makes the run complete identically when the API is down. Excellent rules engine. Not an agent, and a panel reading the architecture would have seen that in about ninety seconds.

  **The trap in fixing it:** the obvious move is to put the model into the matching path, and that would have destroyed the project's strongest claim. ADR-017 is load-bearing — measured accuracy is only measurable while the rules are deterministic and reproducible. Trading that for the word "agent" would have been a bad deal.

  **Recovered by:** noticing that a real finance team has both a reconciliation *system* and an *analyst* who works the exception queue it produces, and that this architecture had built the first and none of the second. The Analyst (Phase A) runs strictly after S14, reads engine output as finished fact, and cannot modify it. ADR-048…ADR-057, [agent-design.md](agent-design.md).

  **What made it defensible rather than decorative:** the agent chooses which questions to ask, but deterministic code computes every answer — it calls the engine's own scorer and subset-sum rather than doing arithmetic. Its tool registry contains no mutating tool, so it is unable to write rather than trusted not to. A non-LLM gate verifies every citation against tool calls actually made. And it is scored against the same answer key as the engine, attacking the `false-despair rate` that `validation-strategy.md` §5.3 had *already* defined as the engine's honest headroom — so the existing validation harness scores the new layer almost for free. That last part was luck rather than foresight, and worth admitting.

  **What changed as a result:** one genuine conflict, handled openly rather than papered over. ADR-017 explicitly rejected "LLM-proposed aliases in v1", and the Analyst proposes aliases. Rather than quietly building it and leaving the ADR stale, **ADR-055 amends that single clause under four stated conditions** and preserves the rest of ADR-017 intact. The same discipline applied to a safety claim: `deployment.md` §4 asserted there was no user-facing "ask the AI" box and therefore no way for an anonymous visitor to burn quota. The Q&A endpoint makes that false, so the claim is corrected in the same change that breaks it, with rate limits and a kill switch. Leaving either one stale would have been the exact species of dishonesty the project is built to avoid.

  **Also, later the same day (Day 3, third pass — scaffold + migrations):** `schema.md` §9's audit-immutability trigger raised `OLD.id`, but the `id` and `sequence_no` columns had been consolidated into one earlier that day. plpgsql resolves `OLD.<field>` at *trigger execution* time, not at `CREATE FUNCTION` time — so the trigger would have installed cleanly, passed a migration run, and then failed with "record OLD has no field id" the first time anyone tried to tamper with the audit log. A tamper-evidence mechanism that breaks only when exercised is worse than none. Found by actually running the DDL against a real Postgres rather than reading it; fixed in the doc and written correctly in `007_audit_log.sql`. The lesson is the boring one: SQL in a design doc is untested code until something runs it.

  **Cost:** roughly a day and a half of build time, absorbed by pairing the Analyst with the explain layer on Day 11 and its read tools with the classifier on Day 10. That compresses the frontend to a single day and pushes the pitch video to Sep 5 — both now listed as risks in ARCHITECTURE §10 with pre-decided degradation orders, rather than discovered on Sep 4.

- **2026-08-26** — **Day 3, third pass: first code. Scaffold, migrations, parsing primitives, the Tier 2 scorer and assignment. Three things broke, all caught by tests written alongside the code rather than after it.**

  1. **`schema.md`'s audit-immutability trigger would have failed the first time it was exercised.** It raised `OLD.id`, but the `id` and `sequence_no` columns had been consolidated earlier the same day, in the first pass. plpgsql resolves `OLD.<field>` at *trigger execution* time, not at `CREATE FUNCTION` time — so it installed cleanly, passed a migration run, and would have thrown "record OLD has no field id" the first time anyone tried to tamper with the audit log. A tamper-evidence mechanism that only breaks when exercised is worse than none, because you discover it during the demo or never. Found by running the DDL against a real Postgres instead of reading it. **SQL in a design doc is untested code until something runs it.**

  2. **`parseMoney("--5")` returned `500`.** The sign handler consumed one minus, then `STRICT_DECIMAL` still permitted a leading `-`, so the second survived into the regex and the negative was applied twice — flipping back to positive. Not an error: a plausible number, from code written carefully ten minutes earlier. Fixed by making the pattern unsigned. This is exactly the failure mode the money parser exists to prevent, which is the uncomfortable part.

  3. **A tie-break test failed and the code was right.** I had asserted that two candidates with identical scores resolve by canonical file position. They do not — a perfect tie between two rivals for the same slot is the *least* distinguishable evidence possible, and breaking it by row number is picking a winner by accident of file order. The ambiguity guard correctly refused both. The test was rewritten into two: a perfect tie is maximally ambiguous, and the canonical tie-break governs *processing order*, not winner selection. Worth recording because the instinct to "fix" the code to match the test was the wrong instinct.

  **Two challenges from Tejas that changed the work**, both of the form *"you're asserting consistency-by-construction — go verify there's actually only one implementation"*:

  - **Canonical ordering is necessarily defined twice** — `source_rank()` in plpgsql for `ORDER BY`, `SOURCE_ORDER` in TypeScript for in-memory sorting — because SQL cannot call TS. My migration comment said "change both in the same commit", which is a hope rather than a guarantee. Now a test asserts they agree value-for-value, verified to fail when drift is injected.
  - **Postgres 16 vs 17.** I had validated only against a local 17 and *reasoned* that nothing used was version-specific — a claim about the code made by the thing that wrote the code. Ran the full suite against `postgres:16` (16.15) in Docker: clean. `deployment.md` §2.1 now pins Railway to 16 explicitly and carries the repro command, and the Day 12 checklist gains a production-version check.

  Also corrected an earlier overstatement of my own: the ADR-049 claim that `score_pair` runs the engine's own code was **aspirational** when I first described it, because the scorer did not exist yet. It is now real, and `single-scorer-guard.test.ts` enforces structurally that there is exactly one `scorePair`, one `trigramSimilarity`, one edit-distance function, and no score arithmetic anywhere under `services/agent`.

  **Nothing deployed yet.** ARCHITECTURE §7.4 wants a live URL early and that did not happen — the day went into the engine's highest-risk internals instead. Flagged rather than quietly reslotted: deploying is now Day 4's first task, and every day it slips increases the chance of discovering a platform problem late.

- **2026-08-27** — **Day 4: the day count itself was wrong.** Aug 25 had been numbered as a build day despite no session happening, which pushed every subsequent day one ahead — yesterday was logged as "Day 5" when it was Day 3, and today would have been Day 6 rather than Day 4.

  Nothing broke in the code, but the error was in two *submission artifacts* — this file and the ADR log — plus the build plan, so it was worth correcting properly rather than patching the visible instances. Caught by Tejas, not by me.

  **What made it obvious once stated:** dropping the empty day gives exactly **13 working days, Aug 23 → Sep 5, ending on submission day**. The project has always described itself as a 13-day build; the old numbering quietly made it 14 calendar days with a phantom in the middle.

  **What changed as a result.** The build plan was re-slotted rather than shifted by one, because Day 3 turned out to hold three passes — design review, the Analyst, and five code units — which puts the engine's highest-risk internals about a day ahead. That buffer is already spent on the deploy that did not happen. The re-slot also moves the **first honest cold-run number from Day 12 to Day 10**: a measured accuracy figure with two days left to react to it is useful, and the same figure on the final day is only a report.

  The lesson is small and boring: a day counter is state, and state that nobody reconciles against reality drifts. It drifted for four days inside a project whose entire thesis is measuring things honestly.

  **Also Day 4 (unit 6 — dedupe and the identity short-circuit): `dedupe()` returned the matching pool in INPUT ORDER.**

  The duplicate *findings* were fully deterministic — same clusters, same elected primaries, on any input permutation. What was not deterministic was the collection handed to every stage downstream: `pool` came from a `filter()`, which preserves whatever order the caller happened to supply.

  That is worse than it sounds. ADR-032 requires every decision-feeding collection to be canonically ordered, and S4 is the *first* stage — its output is the input to blocking, the tiers, scoring and assignment. Correctness would then have depended on each of those stages remembering to sort, and the one that forgot would not have failed: it would have produced a slightly different, still-plausible match set depending on how the ingestion happened to enumerate rows. Assignment already sorts, so the visible damage today would have been nil, which is exactly why it would have survived until some later stage did not sort and nobody could explain why two runs disagreed.

  **Caught by** the dedupe determinism test asserting that a reversed input yields an identical result — it did not, and the diff was pool order alone. **Fixed by** returning the pool canonically sorted from S4 itself, so no downstream stage has to remember.

  **What changed as a result:** the rule is now "the stage that produces a collection sorts it", not "the stage that consumes one sorts it". Pushing the obligation to the producer means there is one place to get it right instead of one place per consumer, and a new consumer added later inherits the guarantee rather than having to know about it.

  Never shipped — caught before the commit. Recorded because "the tests caught it" is only reassuring if the near-misses are written down too; a log that contains only the failures that escaped would overstate how well the process is working.

  **Also Day 4 (unit 7 — batch decomposition): two locked ADRs contradicted each other, and implementing the spec exposed a third problem.**

  1. **ADR-038 made a 250 ms wall clock a search bound. ADR-032 and `CLAUDE.md` §4.8 forbid `Date.now()` in any decision path.** Both were written on Day 3, three passes apart, and neither noticed the other. A time-bounded search reports `searchExhausted` on a fast machine and `searchBoundExceeded` on a slow one — and those are *different claims about the data*, one saying "no combination exists" and the other "I ran out of room". Which claim the exception list makes would have depended on the hardware the run landed on. It is exactly the failure ADR-039 was written to prevent for dates, reappearing in another stage four passes later. Fixed by ADR-060: the primary bound is a deterministic node budget, and the wall clock survives only as a safety valve.

  2. **The bound model was wrong in a way only visible by running it.** ADR-038 lumped the pool cap, the subset-size cap and the budget together as `searchBoundExceeded`. In practice the depth-first search reaches the size cap on essentially any pool of eight or more — so `searchExhausted` would have been almost unreachable, and *an honesty flag that is almost never true tells a reader nothing*. The fix distinguishes a **declared** limit (the size cap: announced up front, identical for every batch, named in the reason string — searching all of it is a complete answer to the question actually asked) from a **truncating** one (the pool cap discarded eligible candidates; the budget cut the search short). The hardest case the caps permit — a full 24-candidate pool, no solution, zero tolerance — now returns a genuine proof in about 7 ms.

  3. **My first node budget was ~50x too tight, and I only knew because I measured it.** I picked 200,000 nodes to stand in for "250 ms". That worst case actually runs ~405,000 nodes in ~6 ms, so the budget I chose would have reported a truncation on a case the engine can *prove*. Raised to 1,000,000 with the measurement recorded next to it. A number chosen to represent a duration should be derived from a measurement of that duration, not from how large it looks.

  The pattern across all three is the same and worth naming: **the spec was written carefully and was still wrong in ways that only running it could show.** Day 3's design review caught three structural flaws by writing the algorithm down; this caught three more by executing it. Both passes were necessary and neither would have found the other's.

- **2026-08-27 (later)** — **Reversed the deploy-early rule (ADR-061).** Not a failure, but a decision worth recording because it overturns one made on Day 2 and repeated in `ARCHITECTURE.md` §7.4.

  The original argument was that a live URL early is a strong panel signal and removes the most common last-week failure mode. Tejas's counter-argument is stronger at this stage: **deploying a half-built project means being correct in two places at once instead of one.** A cloud deploy is not a copy of the local build — it adds a build environment, injected variables and a managed database, and every one of those must be re-verified after every dependency change, refactor and migration still to come. The cost is paid repeatedly; the benefit accrues once.

  **The risk that was traded away is real and stays on the books:** the first deploy now lands on Day 11 with two days of slack instead of a week. That is acceptable only because the deploy surface was deliberately kept tiny back on Day 2 (two managed platforms, no containers we author, no orchestration), the one-time setup is already written down, and the Render fallback is pre-decided. Recorded here rather than only in the ADR because "we decided not to do the thing the plan said" is exactly the kind of change that is invisible later unless someone writes down that it was a choice.
