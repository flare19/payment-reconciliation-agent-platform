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

  2. **The bound model was wrong in a way only visible by running it.** ADR-038 lumped the pool cap, the subset-size cap and the budget together as `searchBoundExceeded`. In practice the depth-first search reaches the size cap on essentially any pool of eight or more — so `searchExhausted` would have been almost unreachable, and *an honesty flag that is almost never true tells a reader nothing*. The fix distinguishes a **declared** limit (the size cap: announced up front, identical for every batch, named in the reason string — searching all of it is a complete answer to the question actually asked) from a **truncating** one (the pool cap discarded eligible candidates; the budget cut the search short). The hardest case the caps permit — a full 24-candidate pool, no solution, zero tolerance — now returns a genuine proof.

  3. **My first node budget was picked from one measured case, not from the declared space, and it eventually bound on an input the caps still allow.** I picked 1,000,000 nodes after measuring one hard fixture. The declared space is actually bounded by Sum(C(24,k), k=0..8) = 1,271,626 — provably, from the caps themselves — and a same-amount, unreachable-target fixture visits close to that ceiling and exceeded the 1,000,000 budget (audit finding F2, 2026-08-27; see ADR-063). Raised to 1,300,000, which provably dominates every input the caps permit, and said so as a proof rather than a measurement. A bound derived from the declared space is stronger than one derived from a hard case that happened to get measured.

  The pattern across all three is the same and worth naming: **the spec was written carefully and was still wrong in ways that only running it could show.** Day 3's design review caught three structural flaws by writing the algorithm down; this caught three more by executing it. Both passes were necessary and neither would have found the other's.

- **2026-08-27 (later)** — **Reversed the deploy-early rule (ADR-061).** Not a failure, but a decision worth recording because it overturns one made on Day 2 and repeated in `ARCHITECTURE.md` §7.4.

  The original argument was that a live URL early is a strong panel signal and removes the most common last-week failure mode. Tejas's counter-argument is stronger at this stage: **deploying a half-built project means being correct in two places at once instead of one.** A cloud deploy is not a copy of the local build — it adds a build environment, injected variables and a managed database, and every one of those must be re-verified after every dependency change, refactor and migration still to come. The cost is paid repeatedly; the benefit accrues once.

  **The risk that was traded away is real and stays on the books:** the first deploy now lands on Day 11 with two days of slack instead of a week. That is acceptable only because the deploy surface was deliberately kept tiny back on Day 2 (two managed platforms, no containers we author, no orchestration), the one-time setup is already written down, and the Render fallback is pre-decided. Recorded here rather than only in the ADR because "we decided not to do the thing the plan said" is exactly the kind of change that is invisible later unless someone writes down that it was a choice.

  **Also Day 4 (unit 9 — the audit hash chain): two latent bugs surfaced, neither in the unit being built.**

  1. **The migration runner's advisory lock never protected anything.** It was acquired *after* `CREATE TABLE IF NOT EXISTS schema_migrations`, and when `runMigrations` was handed a `Pool` rather than a client, every query could land on a different connection — while `pg_advisory_lock` is *session*-scoped. So the lock was taken on one connection and the migrations ran on others. It had been that way since unit 1 and nothing noticed, because until now only one process ever migrated. The moment a second integration test file appeared, two sessions raced on `CREATE TABLE IF NOT EXISTS` — which is **not atomic in Postgres**: both pass the existence check and then collide on `pg_type_typname_nsp_index`. Fixed by pinning one client for the whole operation and taking the lock before any DDL.

  2. **Two integration files sharing one database, running in parallel.** Node's test runner runs test *files* concurrently by default. Both files truncate the same tables between tests, which `testing-strategy.md` §5 describes as a single-writer model — so they cancelled each other. Fixed by serializing test files (`--test-concurrency=1`); at ~1.8 s for 244 tests the cost is nothing.

  Worth recording because both were **invisible until a second consumer appeared.** A lock with one caller and a database with one writer both look correct indefinitely. The general shape — *a concurrency guarantee that has never been concurrently exercised is an untested guarantee* — is the same reason the hash chain's own append path now takes a per-run advisory lock and has a test that runs twelve appends at once, rather than trusting `schema.md`'s "single writer, single process".

  A third, smaller one: an integration assertion compared `'21' !== 21` because I typed `sequence_no` as a string. It is a `BIGINT`, and `db/pool.ts`'s int8 parser converts it to a `Number` (ADR-059) — the fix working exactly as designed, caught by a test that assumed otherwise.

  **Day 4 closed with ten code units, an independent audit, and 270 tests.** The pattern across the day is worth naming, because it repeated in five of the ten units and was not a coincidence: **writing a spec down catches structural flaws; running it catches a different set, and neither pass finds the other's.** Day 3's design review found three unreachable code paths by writing the algorithm down. Day 4 found a wall-clock determinism hole across two ADRs that never noticed each other, a bound model whose honesty flag would have been almost never true, a precedence order that silently downgraded proven money discrepancies, an advisory lock that had never protected anything, and a node budget fifty times tighter than the duration it was meant to represent — all by executing code that read correctly.

  Also worth recording plainly: **three times today a test failed and the code was right.** A tie-break test that contradicted the ambiguity guard, a severity assertion that claimed a cap was doing work when nothing had escalated, and a grounding fixture that cited an id its own context never returned. Each time the instinct was to fix the code. Each time that would have been wrong. A test written minutes after the code it tests is not independent evidence, and treating a red test as automatically the code's fault is how a suite slowly becomes a record of the author's assumptions rather than of the system's behaviour.

- **2026-08-27 (end of day)** — **Second self-audit, scoped to units 9 and 10 only. Fourteen findings, four of them P1 — and every one of the four was a property the commit message had already claimed to have.**

  The audit brief said it out loud: *read the code, not the commit summaries, because those are self-reported by the same agent that wrote the code.* That instruction earned its place. Three commits from earlier today assert, at length and with reasoning, properties the code did not have:

  > "The transaction-scoped advisory lock makes the single-writer assumption **ENFORCED** rather than merely documented."
  > "**Verified the gate cannot fail open.** A sweep corrupts every field in turn and asserts none of them get through."
  > "An unverified citation **never reaches the database**."

  None of those sentences is a lie. Each describes the design accurately. The code implemented most of the design, and the prose described all of it — and the gap between "most" and "all" is where all four P1s lived. This is a specific failure mode of writing code and its justification in the same pass: the justification is written from the intent, and it reads as evidence afterwards.

  1. **The grounding gate — the anti-hallucination layer, the one deterministic thing standing between a model's output and the database — failed open on three of its four action types.**

     `checkSchema` descended into `MANUAL_MATCH` and left `CREATE_ALIAS`, `MARK_WONT_FIX` and `ADJUST_SEARCH_BOUNDS` entirely unvalidated. The constraint pass then compared fields that might not exist, and **`undefined <= 0` is `false`** — so `if (action.poolSize <= 0 …) return 'search bounds must be positive'`, the single check that did exist, *silently affirmed* for every value that was not a positive number. A check written to reject that accepts instead is the exact shape of failing open, in the one file whose header says every check defaults to rejection.

     What came back with `groundingPassed: true, rejection: null`: an `ADJUST_SEARCH_BOUNDS` proposal with all three bounds missing; with `poolSize: NaN`; with `poolSize: 'lots'`; with a pool of a billion and a budget of one day, against ADR-054 ceilings of 64 and 2000 ms that `config/defaults.ts` already held and nothing enforced. And a `CREATE_ALIAS` with no `canonicalValue` at all, which slipped past the self-map guard because `'AMZN' === undefined` is false.

     The accept path spreads the raw action through unchanged, so each of those was what would land in `agent_investigations.proposed_action`, render in endpoint 27, and sit under the button a human presses to route it into endpoint 16 or 21.

     **Why this one matters more than its line count.** ADR-053 makes a hallucinated resolution a *build blocker*, not a metric — because an agent that invents evidence is strictly worse than an engine that stays silent, since it arrives wrapped in a confident reasoning chain. The gate is the entire mechanism behind that claim. A gate with a hole is not a weaker gate; it is a gate that produces confident-looking output nobody re-checks, which is precisely the artifact the track's *"one cherry-picked match proves nothing"* is aimed at.

     **Caught by** reading the constraint function and asking what each comparison does when the field is absent, then running it. **Recovered by** an exhaustive `switch` over `ProposedAction['type']` — a fifth action type is now a TypeScript error rather than a silently unvalidated proposal — with ADR-054's ceilings enforced on the *proposal*, and the superseded constraint check **deleted** rather than left in place. Keeping a weaker copy of a check that already ran is how the first one got trusted.

     **Changed as a result, and this is the part worth carrying:** the test guarding this was called `THE GATE NEVER FAILS OPEN`. It swept seven corruptions — every one of them a top-level field or a `MANUAL_MATCH`. It passed, continuously, while three of four action types were unguarded. **A test's name is a claim about intent, never about coverage**, and a confident name on a partial test is worse than no test, because it stops anyone looking. The sweep now walks every field of every variant, with bad values chosen per field *kind*, plus each field missing entirely — 78 corruptions, and it asserts each well-formed variant *passes* first, so the rejections mean something.

  2. **The tamper-evidence mechanism accusing itself.** The entry hash was computed over the caller's object; the columns were written with `JSON.stringify`. Two serializers, expected to agree by convention, disagreeing in two places: `details ?? {}` coerced `null` to an object the hash never saw, and `JSON.stringify` *drops* an `undefined`-valued key where `canonicalJson` emits `"k":null`.

     So `appendAuditEntry({ details: null })` wrote a row that could not reproduce its own `entry_hash`, and `GET /api/runs/:runId/audit/verify` — the endpoint that exists to prove the log was not touched — reported `entry_altered` on a log nobody had touched. **At the scale this is judged on, that is not one bad row:** the chain is per run and thousands of entries long, so one such entry makes every entry after it unverifiable too, and the failure is silent until someone runs the verifier.

     The unit test that should have caught it asserted `canonicalJson({a:undefined}) === canonicalJson({a:null})` — that the serializer agrees with *itself*, which was never in doubt. The threat was that it disagreed with what the column actually holds. **Recovered by** one `toStoredForm` producing the entry as the database will hold it, with both the hash and the column values derived from it; `computeEntryHash` applies it internally, so hashing a shape the database would not have stored is now unrepresentable. **Changed as a result:** the replacement test asserts the real invariant — a canonicalized value is a *fixed point of a jsonb round trip* — across seventeen shapes.

  3. **`valid: true` on a log that had been cut in half.** A hash chain proves the entries you are holding are consistent. It cannot prove you are holding all of them: delete the last N entries and every survivor still links correctly to the one before it. Five entries, delete two, `valid: true`. Delete a run's entire chain and it was indistinguishable from a run that never logged anything.

     Both existing removal tests deleted an **interior** entry (`OFFSET 1 LIMIT 1`), which `prev_hash` linkage does catch. The tail was never tested because the design had no way to see it — so "drop everything after the decision I want to hide", the cheapest tamper available, was the one the mechanism could not detect. Endpoint 22 is specified to be run **live in front of a finance panel** as proof of immutability; certifying a truncated log as clean is the worst possible thing for it to do.

     **Recovered by** migration 011: an anchor outside the chain holding each chain's `entry_count` and `head_hash`, moved in the same statement as the entry it describes. **Changed as a result:** verification now answers two separate questions instead of conflating them — *are the entries present consistent* and *does the log end where it should* — and the residual is stated rather than hidden. `anchored: false` makes `valid: true` the weaker claim it actually is. Nothing inside one database survives full write access to that database; the honest framing is that this turns a single `DELETE` into two coordinated writes across two tables and gives an auditor a value they can pin externally.

  4. **The same advisory-lock bug, twice, the second time inside the fix for the first.** Recorded earlier today: the migration runner took a *session*-scoped lock on a `Pool`, which hands out a different connection per query, so it protected nothing. The unit that found that then took a *transaction*-scoped lock on a caller-supplied client that need not be inside a transaction — where each statement is its own transaction, so the lock was released by the very statement that took it.

     Twelve concurrent appends on bare pooled clients produced four entries claiming one predecessor and two claiming another, and the verifier reported `chain_broken` on an untampered log. **A tamper-evidence mechanism whose own writer can make it cry tampering is worse than not having one**, and the 12-append test that was meant to prove otherwise exercised only the path that already worked.

     **Changed as a result — and this is the one structural change of the day.** Patching the instance would have left the class intact for a third occurrence, so: a branded `TxClient` that only `withTransaction` can produce, so there is no signature anywhere that lets a transaction-scoped lock be taken somewhere it will not survive; a runtime `pg_locks` check folded into an existing statement, which costs **no extra round trip** — deliberate, because at ADR-045's 100k-record benchmark the audit write path is among the hottest in the system; and one lock registry carrying the post-mortem of both failures, so a third lock gets added next to the reasons.

  **The honest summary.** Day 3 established that writing a spec down catches one class of flaw. Day 4 established that running it catches a different class, and that neither pass finds the other's. Today adds a third: **auditing your own output catches a class that neither of the first two reaches — the drift between what the code does and what its author said it does.** All four P1s were confidently-argued properties that were true of the design and partly true of the code. No test failed. Nothing looked wrong.

  Two smaller things, recorded because leaving them out would flatter the process:

  - **Nothing here was found by running the engine, because the engine still does not run end to end.** It was found by writing adversarial tests against individual units and executing them against a real PostgreSQL rather than reasoning about what PostgreSQL would do. The `jsonb` key-order round trip, the `pg_locks` predicate's behaviour on negative lock keys, and `ON CONFLICT` inference against a `NULLS NOT DISTINCT` index were each verified empirically *before* being relied on. Three of the four fixes depend on a database behaviour that would have been easy to assert confidently and wrongly.
  - **Two of the regression tests written today were wrong while the code was right.** One asserted that `{a:1,b:undefined}` should hash identically to `{a:1}` — it should not, those are two different stored values, and collapsing them is the same failure the NaN guard exists to prevent. The other flagged `rationale: 'lots'` as a fail-open, when `'lots'` is a perfectly good rationale and only a bad `poolSize`. That is five times in two days that a red test was the test's fault, and the Day 4 entry had already named the pattern. Naming a bias does not stop it; it only shortens the time to noticing.

- **2026-08-28 (Day 5)** — **The generator landed in six reviewed units (G1-G6), and the project can measure something for the first time. Two things broke: one silent data bug that eleven rows deep would have corrupted the accuracy number, and one delegation that cost far more than the work was worth.**

  **What the generator now guarantees.** 300 events → 920 records, 21 designed-unresolvable split 9/6/6, ceiling **93.0% computed from the realized data rather than asserted**. The realized scenario distribution matches §3's table exactly, because allocation is largest-remainder rather than sampled — under sampling variance a 3%-weight scenario on 300 events has a standard deviation near 3, which would have made the ceiling quoted in the README, the dashboard and the pitch move every time the seed changed.

  **THE BUG THAT MATTERED, and how it was hidden.** `captured_at` was built as `second + 2` with no carry, emitting `19:47:61`. `parseSourceDate` correctly rejects that, and a rejected row leaves the matching population entirely (ADR-046) — so **eleven of 323 gateway rows would have lost their gateway leg and surfaced as false exceptions**, corrupting the measured accuracy for a reason nothing downstream could see. The G3 invariants could not catch it: they check *typed* values, and this bug exists only in the emitted string. Nothing between the projection and the parser was looking.

  It was hidden by a test that could not fail:

  ```ts
  assert.equal(parseSourceDate(row.valueDate, 'YYYY-MM-DD HH:MM:SS' as never).ok || true, true)
  ```

  `X || true` is always `true`, and the `as never` cast was silencing the type error pointing straight at it. Rewritten as a real round trip — format as the source would, parse with that source's declared format, assert the same calendar day, over ~1,100 date fields — **it failed on the first run**, and that failure was the bug. **Recovered by** real carry arithmetic, and `formatGatewayTimestamp` now throws on an out-of-range time: a formatter that can emit what the parser refuses is a silent-bad-data generator, and the guard belongs at the boundary rather than in a test that might not be written.

  Two more tests in the same batch could not fail: `assert.ok(names.size >= 1)` under a test named *"at least two of the three names differ"* (a `Set` of two strings always has size ≥ 1), and `assert.notEqual(ledgerNet, gatewayAmount)` under one named *"beyond the real tolerance band"* (a one-paisa difference satisfies it). Plus a dead identity function, `pickLedgerDate(_rng, d) { return d; }`, whose nine-line comment claimed the ledger date distribution *"is asserted in project.test.ts"* — where no such assertion existed.

  **This is the fourth time.** Issue #11 found a test that could not fail; the Tier 1.5 guard was written specifically to avoid becoming one; the "THE GATE NEVER FAILS OPEN" sweep turned out to cover a quarter of what its name claimed. The pattern is now well enough established to name as a rule: **a test whose name makes a claim its assertion does not check is worse than no test**, because it converts an unexamined area into one that looks examined. The tell is an assertion that is weaker than the test's own title.

  **THE DELEGATION THAT WENT WRONG.** G6 was handed to Sonnet as planned — mechanical implementation against a spec (the G3 invariants and G4 proofs) that already existed and already ran. It produced working code, and it burned roughly thirty minutes and a large share of a daily allowance without committing anything, so from outside it looked like nothing had landed. The causes are specific and avoidable, and worth writing down because the same delegation is planned again for the engine tiers:

  1. **~2,400 lines read in full before writing a line.** Twelve source files opened end-to-end — `invariants.ts` (336), `answer-key.ts` (331), `proofs.ts` (288), `engine.ts` (261), `events.ts` (238) and more — where targeted greps and section reads would have served. Every subsequent turn re-sends all of it.
  2. **Very large files written in one shot, then debugged serially.** `project.ts` arrived at ~630 lines before its first typecheck. Each fix cycle then paid the full context cost again: apostrophe inside a single-quoted string, `readonly` vs mutable array types, `exactOptionalPropertyTypes`, a missing `csv-parse` dependency discovered only at test time, and a wrapper function plus a bottom-of-file import that had to be unwound across three separate edits.
  3. **Exploratory sweeps after the work was already done** — sixty seeds, then a count sweep, then a cluster-floor probe. Genuinely informative, and none of it was needed to finish the unit.
  4. **Nothing committed.** Six modules and their tests sat uncommitted, which is also why the state was unreadable from outside.

  The cost model is the thing to internalise: **an API request re-sends the whole conversation, so spend scales with turns × context length.** A long context and many short fix cycles is the most expensive possible combination, and it is exactly what "load everything, write big, debug serially" produces. The work itself was maybe six focused turns.

  **What changes as a result.** Delegation instructions now say: read by grep and section, not by whole file; write and typecheck ONE module at a time; commit each module as it passes; do not run exploratory sweeps unless the unit's acceptance criteria require them. And the model routing in `ARCHITECTURE.md` §3 gets a corollary it did not have — **the cheap model is only cheap if the session stays short**; a Sonnet session that runs long costs more than an Opus session that does not.

  **Also Day 5, mine and not inherited: the test suite was pinned to `HOLDOUT_SEED`.** I wrote `const SEED = 90_210` into G2's `events.test.ts` and repeated it in G4 and G5; it propagated to roughly forty call sites by G6. ADR-027 reserves that seed for the reported numbers and says to look at it **once, when reporting** — but a suite pinned to it looks at it on every run, and every fix made to turn one of those tests green is a change made by inspecting holdout output. That is precisely the tuning ADR-027 forbids, arriving through the test suite rather than through the engine, and it would have been invisible because every test was passing. Generator tests now run at `DEV_SEED` with property sweeps over arbitrary non-reserved seeds; `HOLDOUT_SEED` survives in exactly one smoke test that asserts the seed runs and records itself, never what the dataset contains.

  **Two more spec numbers that could not be satisfied,** both found only by building the thing they described. §1's *"200-500 records"* never followed from §3's own weight table — two thirds of events are 3-way scenarios, and the honest total is 920 (ADR-069). §2.3's *"days ≥ 13 in ~30% of rows"* is arithmetically unreachable: **any** contiguous 30-day window contains 18-19 days above the 12th, so the floor is 60% unambiguous and the dataset sits at 57.8% (ADR-070). In both cases the correction was to the doc rather than to the generator — bending the generator to hit a stale number would be tuning the dataset to a figure rather than to a purpose, which is the failure this project's whole validation strategy exists to rule out. The §2.3 purpose (an inferring parser must be visibly, frequently wrong) is served comprehensively at 42% ambiguous, and there is now a test holding that above 35%.

  **The honest summary.** Day 3 established that writing a spec down catches one class of flaw, Day 4 that running it catches another, Day 5's audit that auditing your own output catches a third. Day 5 adds a fourth, and it is about the seam between components rather than inside one: **the invariants and the proofs were both correct and both passed, and the bug lived in the gap between them** — in the emitted string, after the last typed check and before the first parse. Three layers of verification, and the defect walked between two of them. The fix that generalises is not another invariant; it is that the formatter and the parser are now required to agree, enforced at the formatter, where the value is created.

- **2026-08-28 (Day 6)** — **Ingestion and the first two tiers landed in two units, and an isolated audit of them found eight issues, two of them P1. Both P1s were silent: nothing threw, 338 tests passed, and each would have quietly moved the number this project is graded on.** Day 6's work landed on Aug 28 alongside Day 5's; the day count is 13 *working* days, so the calendar is a day ahead of the plan rather than the plan being behind.

  **What landed.** U1: three source parsers, exclusion rules, rejected-row capture, and the aggregator that becomes S4's input. U2: the four §3 block indexes, the Tier 1 exact predicate and its driver, and Tier 1.5 re-running that same predicate on alias-substituted values. Then AUDIT-1 — an isolated Opus session, audit-only, permitted to file issues and forbidden to fix anything.

  **THE FIRST P1: nine refunds that could never reach their ledger row (#30).** A `refunded` gateway row normalizes to `direction = 'debit'` (ADR-035). The ledger parser assigns `'credit'` to every row — correctly, in the sense that `merchant_ledger.csv` **has no direction column at all** (§2.3), so there is nothing else it could assign. Direction is a hard gate at every tier, so the gate was comparing a gateway fact against a value this codebase invented, and for a refund it always lost.

  All nine `REFUND_REVERSAL` events therefore failed at S6, S7, S8 **and** S9. Eighteen expected pairs unreachable, nine `MATCH_3WAY` events degraded to 2-way, and nine orphaned ledger rows that would have surfaced as presence exceptions the answer key says should not exist. S8 had a verdict for it — `direction_conflict`, whose reason string literally reads *"this is a refund or reversal pairing"* — so the engine recognised the shape correctly and then dropped the pair, because **`direction_conflict` has no consumer anywhere in the codebase.** A stage identified the case, named it accurately, and threw the answer away.

  The failure mode matters more than the count. This would not have shown up as a lower match rate alone; it would have manufactured nine exceptions with confident, wrong explanations, which S13 would then have narrated in plain English to a judge. **Inflating the exception list with non-problems is the failure `schema.md` §2.2 already names as "equally dishonest" to hiding exceptions** — and here the engine would have been fluent about it.

  **Recovered by** ADR-071: the gate now abstains unless *both* sources state a direction. Gateway does (via `status`), bank does (via which amount column is populated), ledger does not. ADR-035's actual argument — a ₹5,000 capture must not match a ₹5,000 chargeback — is a gateway↔bank argument, and it is untouched.

  **THE SECOND P1: the bank's merchant name was very nearly a primary key (#31).** `counterparty_norm` on **248 of 301** bank rows still carried the RRN and the `setl_…` token:

  ```
  "UPI-SETL-FSN E-COMMERCE-510996260123-setl_xot9xgPg5duO6q-BATCH81"
    -> "FSN E COMMERCE 510996260123 SETL_XOT9XGPG5DUO6Q"
  ```

  253 distinct values across 301 rows. The `byCounterparty` block index — whose stated job is *"catches amount-divergent, name-agreeing pairs"* — had almost no bucket with more than one row in it. Tier 2's counterparty component was comparing forty characters of noise. And bank-side **alias learning was structurally impossible**: `learned_aliases` keys on `normalized_value`, and a value embedding a row-unique reference can never be aliased to a canonical merchant. The holdout ships 11 merchant-name alias entries and 24 `MERCHANT_NAME_VARIANT` events with nothing to act on, which also means the **leverage ratio** — named in `CLAUDE.md` §6 as the alias feature's honest headline — had no path to a numerator.

  **This is the Day 5 lesson again, in a different seam, and worth being precise about why.** The normalizer stripped a trailing `BATCH\d+`, then trailing digit runs. That is *exactly correct* for `schema.md` §2.2's worked example, `"NEFT-SETL-AMZN RETAIL-234567890123-BATCH12"`, whose token order is MERCHANT-RRN-BATCH. The generator emits `MERCHANT-RRN-setl_ID-BATCH` — one extra token, sitting precisely where it halts a tail-anchored loop. **The code was written against the doc's example and was right about it; the doc's example was not the data.** The 53 rows that came out clean were the ones where the generator happened to omit a token, which is what turned a hypothesis into a diagnosis.

  **Recovered by** filtering reference-shaped tokens at any position, then re-applying the legal-suffix rule (a suffix that was not final before the references were removed is final now — this is what gets the bank's `ZOMATO LIMITED 818624673100 setl_…` to the gateway's `ZOMATO`). Distinct bank norms 253 → 33; bank↔gateway overlap 34/301 → **276/301**. `schema.md` §3.3 gains rule 6, because its rule list never said to remove embedded references even though its own stated outcome, `AMAZON RETAIL`, requires it.

  **WHY NEITHER WAS CAUGHT BY THE 338 PASSING TESTS.** The Tier 1 holdout suite has a good precision test — *"every Tier 1 match is a true positive in the answer key"* — which correctly found zero false positives, and still does. Its only recall-shaped assertion was:

  ```ts
  test('the exact tier carries a meaningful share of the load, …', () => {
    assert.ok(result.matches.length > 150, …);   // actual: 194
  });
  ```

  Forty-four matches of headroom under a title that claims a load-share property. **This is the fifth instance of the pattern Day 5 named** — *a test whose name makes a claim its assertion does not check is worse than no test* — and it is the most expensive one yet, because the answer key was already loaded in that exact test block and the expected-pair set was already built one test above. Computing recall from data that was sitting in scope would have printed `MISSED 18` on the first run. Filed as #33 rather than fixed here, since AUDIT-1 was audit-only and the fix belongs with the P2 sweep.

  **The generalisable half.** Day 3: writing a spec down catches one class. Day 4: running it catches another. Day 5: auditing your own output catches a third, and the gap *between* two correct verification layers catches a fourth. Day 6 adds a fifth, and it is about **who** is looking: an audit run in a fresh session, forbidden to fix anything, found two silent defects that the session which wrote the code had already reviewed and self-flagged six judgment calls about. Five of those six self-flagged calls turned out to be correct — the author's judgment was good. **What the author could not do was doubt the thing they had not thought to question**, and both P1s lived exactly there: in `direction`, which nobody had asked whether the ledger was entitled to have, and in a normalizer that had been verified against the doc's example rather than against the file.

  The cheap operational lesson, since AUDIT-1 cost a fraction of what G6 did: **an audit that may not fix anything stays short.** Removing the ability to act removed every temptation to sprawl.

  **Also Day 6, smaller:** six issues below P1 filed and left open by design (#32–#37) — an `anchor_strength` that ignores `invoice_no` and so tells a controller "there was nothing to find" while an invoice number sits in the row; the recall test above; a `viaTier` reconciliation rule U9 needs before Day 9; a Tier 1.5 guard that a type-only import satisfies; three spec-required ingestion paths with zero fixture coverage (ADR-036's `FEE` exclusion among them — the generator emits none); and a doc example that contradicts correct code.

- **2026-08-28 (Day 7)** — **Tier 2, group assembly, classification integration and the repository layer, in three units. Nothing broke loudly. What Day 7 produced instead is a pattern worth naming: three separate modules, each written correctly against a spec, each wrong the first time something actually called it.**

  **What landed.** U3: the S9 candidate-generation driver and S11's pair-to-group assembly. U4: the S12 integration that turns stage output into `ClassificationInput`. U5: all eight repositories, plus migration 012.

  **THE PATTERN, stated once because it is now the dominant failure mode.** Days 3 and 4 built the engine's decision-making core against the docs. Day 6 found two P1s in it. Day 7 found three more defects of exactly the same shape, and none of them were found by reading:

  1. **`candidatesConsidered` was reporting the length of a filtered list.** `matching-engine.md` §11 says in as many words that it must be *"a true count rather than the length of the logged list"*, and `schema.md` §9.1 sets a 0.40 floor on what gets logged. `classify.ts` computed `scored?.candidates.length`, which makes the two identical — correct until a caller applies the floor, which U4 was the first to do. An exception would have told a reviewer the engine tried three counterparts when it tried ninety, understating the search inside the very exception they are being asked to trust.

  2. **§10 rule 3 was documented and inert.** S11 computes a refusal for every pair it declines — the losing record and the group that displaced it — and nothing consumed it. `ClassificationInput` had no slot for refusals, so the `AMBIGUOUS_MATCH` that rule 3 specifies could not be raised at all. Wiring it needed a *separate* input from S9's ambiguity findings, because collapsing the two would put S9's "two candidates scored too close to call" wording on an S11 finding where nothing was scored.

  3. **The alias schema made its own documented policy impossible to execute.** Three constraints from migration 005 — `ux_alias_active`, `alias_superseded_has_target`, and the `superseded_by` foreign key — are each correct, and jointly form a cycle: the new row cannot be `active` until the old one is not, the old one cannot be `superseded` without naming its successor, and it cannot name a successor that does not exist yet. **Every statement order violates one of the three.** §6.3's supersede-with-penalty policy was specified on Day 2 and written into the schema on Day 3; nothing executed it until `upsertAlias` on Day 7. Migration 012 defers only the FK, so the unique index and the CHECK keep firing immediately and neither property that protects the data is weakened.

  **What these three have in common** is not that the specs were wrong — all three specs were right, and precise. It is that **a spec cannot be executed by reading it.** Each defect sat in the gap between a module and its first real caller, and every one of them was invisible to a typechecker, to a unit test of the module in isolation, and to a careful reading of the doc. The Day 5 entry called this "the seam between components". Day 7's contribution is that the seam is not an occasional hazard; on this project it is where most remaining defects live, because the modules were built early and correctly and the callers are arriving now.

  **The operational consequence, which is a testing decision.** U5's integration test was written for exactly this reason — TypeScript typechecks the SHAPE of a query result and says nothing about whether the SQL parses, whether a column exists, or whether a CHECK will refuse the write. It failed seven times on its first run. **Six of those seven were bugs in the test, not the code.** That is now roughly the eighth time in five days that a red test was the test's fault, and the ratio is stable enough to plan around rather than apologise for: the first run of a new integration test is a debugging session for the test, and budgeting for that is cheaper than being surprised by it.

  **A near miss worth recording, since leaving it out would flatter the process.** U3's test suite reported a determinism failure across two pipeline runs. Determinism is ADR-032's core guarantee, so this looked like the most serious possible finding. It was `shape(groups)` where `shape` expected the whole run result — my own test bug, caught only because I checked the engine independently before believing the test. Had I reported it first, the next hour would have gone into a hunt for a bug that did not exist.

  **Also Day 7, filed rather than fixed:** [#38](https://github.com/flare19/payment-reconciliation-agent-platform/issues/38), a P1. `anchorAgreement` compares weak anchor keys like-for-like, and `bank_ref_no` exists only on bank rows — so a bank row whose `bank_ref_no` is byte-identical to a gateway `rrn` scores **zero** anchor and falls below the review floor on amount, date and counterparty alone. 128 of 301 bank rows carry such a value; ~24 true gateway↔bank pairs are currently unreachable. It lives in `scoring.ts`, which was out of U3's scope and is the single guard-tested scorer, so it was filed with a deadline (before AUDIT-2 on Day 8), measured evidence, and acceptance criteria written so that a fix which merely loosens matching cannot pass.

- **2026-08-28 (Day 8)** — **The engine ran end to end and was persisted for the first time, and all 28 endpoints went up. Then a commit message closed a P1 issue by saying the opposite of what it meant.**

  **What landed.** U6: the run orchestrator, S0–S12 against a real Postgres — 920 transactions, 284 matches, 555 exceptions, 930 audit entries, chain valid and anchored, 983 ms. U7: the 28 endpoints of the binding contract, every one exercised over real HTTP.

  **THE ONE THAT MATTERS, because it is a new failure class.** Commit `f2a1245` carried the line *"Known shortfall, filed not fixed: #38"*. GitHub's closing-keyword parser matches `fix(e[sd])?\s*:?\s*#\d+` and does not read the surrounding sentence, so **`filed not fixed: #38` parsed as `fixed: #38`** and auto-closed a live P1 the moment the branch reached `main`. The sentence said, in English, the exact opposite of what the machine did with it.

  It was caught only because the next session's plan called for reading the open-issue list before writing an audit prompt. Nothing in the test suite, the typechecker or the review could have caught it — **the artifact that was wrong was prose, and the reader that acted on it was a regex.**

  The same phrasing was sitting in the U6 commit for #39, unpushed. It would have closed that one too on the next push. Corrected before merging; both issues are open.

  **Recovered by** reopening #38 with a comment explaining the mechanism, so a future reader does not find a closed P1 with no fix and conclude it was handled. **Changed as a result — a rule:** never write `fix` / `fixed` / `closes` / `resolves` anywhere near an issue number in a commit message unless the commit does it. To reference without closing: `see #38`, `per #38`, `tracked in #38`. And a pre-merge grep, because this is exactly the class of thing that is invisible until it has already happened:

  ```
  git log --format=%B main..HEAD | grep -inE "(close[sd]?|fixe[sd]|fix|resolve[sd]?)[ :]*#[0-9]+"
  ```

  **Why this is worth a full entry rather than a line.** Every previous failure in this document was a defect in code or in a test, found by running something. This one was a defect in *documentation of intent*, found by nobody — it was going to be discovered as "why is the P1 we planned Day 8 around already closed?". The project's whole thesis is that honest reporting is a feature; a commit message that reports the opposite of what happened, to a reader that acts on it automatically, is that thesis failing in the least dramatic possible way.

  **Two design calls in U6 worth recording,** both flagged in the plan as judgment rather than transcription:

  *Transaction boundaries.* The obvious design — one transaction per run — is wrong for a non-obvious reason: `GET /api/runs/:runId` is the poll target while a run is in flight, and status lives on the `runs` row, so an uncommitted status is invisible. One transaction would leave a run at `pending` for its whole duration and then jump to `completed`, making the progress bar decorative. The run is therefore a sequence of phase transactions. The cost is stated rather than hidden: a crash mid-run keeps the phases that already committed, which is what ADR-046's reaper exists for and is the honest outcome — the alternative is a run that silently looks like it never happened.

  *Audit-write points.* The log is a trail of DECISIONS. Ingestion is a transcription — `transactions` already holds every row with `raw_payload` intact — so it is one entry per source, not per row. `MATCH_CANDIDATE_REJECTED` is absent entirely: §9.1 floors it at 0.40 because logging every pairwise rejection is ~90k rows at 300 records. A trail nobody can read is not a trail.

  **A smaller thing fixed mid-build:** S8 re-derives every pair S6 already claimed and reports `outcome: 'match'` "for completeness". Logging all of them put a second entry beside every `MATCH_CONFIRMED_EXACT` and claimed the identity stage contributed 212 findings when it contributed **9** — the amount/timing verdicts Tier 1 declined, which is the only thing S8 is for.

  **Filed rather than fixed:** [#39](https://github.com/flare19/payment-reconciliation-agent-platform/issues/39), P2 — audit append costs one round trip per entry and is **~37% of a run** at 0.395 ms/entry, projecting to ~310k entries and **~122 s of pure audit writing** at ADR-045's 100k benchmark. A throughput curve dominated by a bookkeeping write says nothing about the matching engine, which is what the benchmark exists to characterise. Due before U16.

- **2026-08-29 (Day 9)** — **AUDIT-2 found the P1 it existed to find, one day before the number goes out. Tier 2 had been excluding whole RECORDS where the spec excludes PAIRS, and the engine had been reporting a match rate 10.76 points below what its own rules produce — alongside 193 exceptions that told a reviewer the engine had searched and found nothing, on records it was structurally forbidden from searching.**

  **The defect, in one line.** `matching-engine.md` §6.3 says *"Tier 2 now only ever sees **pairs** where identity is not established."* `runTier2` filtered its pool by `!claimedIds.has(t.id)` — records. The two read as the same rule and are not.

  **Why the difference is enormous rather than academic.** AUDIT-1 had already established that Tier 1 only ever produces gateway↔ledger matches: bank rows carry no *structured* strong anchor (§3.1), so `sharedStrongAnchor` is always null for gateway↔bank. Both facts were known and written down. Nobody put them together. Excluding matched records means **every gateway Tier 1 matched was deleted from Tier 2 before its bank leg could be scored**, which makes §10 rule 2 — "gateway↔bank plus gateway↔ledger on the same gateway record produces one 3-way group" — impossible to satisfy for the 203 records it most applies to. The rule was implemented, tested, and unreachable.

  **What it cost, measured against the committed answer key:**

  ```
                          before      after
  pair recall             344/872     658/872     +314 true pairs
  false positives           0           0         precision unchanged
  three-way groups          30         187
  groups                   284         284         same events, assembled more completely
  match members            598         755
  exceptions               555         256
    MISSING_IN_BANK        203          54
    MISSING_IN_GATEWAY     242          90
  match rate (ADR-040)   57.09%      67.85%       ceiling is 93.0%
  ```

  **The half that reached a reader, and the reason this is the worst defect in the project so far.** 193 of the 203 `MISSING_IN_BANK` exceptions sat on gateway records Tier 1 had matched. Every one reported `candidatesConsidered: 0` and served over HTTP as `resolvability: "needs_external_data"` — *"no candidate, but the record carries some reference → the counterpart may exist outside these three files."* The counterpart was in the file. The engine had not looked, and said it had. `tier2-fuzzy.ts` opens with a boxed warning that says exactly this — *"a candidate never generated is a match that cannot be made, and nothing downstream can tell the difference between that and a genuine exception"* — written by the session that then wrote the bug eleven lines below it.

  **What the tests were doing.** 477 of them passed, including one titled *"pair-level recall is at its known level, and every shortfall is an ENUMERATED cause"*. It pinned `hit = 344` exactly — a genuine improvement on #33's floor, and it did catch the change — but the title's second clause was asserted nowhere. **396 of the 528 misses shared one cause and nothing was classifying them.** Enumerating them is what found the bug; the enumeration is now in the test, with exact per-cause counts, and a miss matching no cause fails. This is the ninth instance of *a test whose name claims more than its assertion checks*, and the first where the unasserted clause was hiding a P1 rather than a rounding error.

  **The generalisable half.** Day 6 established that an audit in a fresh session finds what the author could not doubt. Day 9 sharpens it: **both facts this bug needed were already written down, in this repo, by the same author, days apart** — §6.3's "pairs", and AUDIT-1's "Tier 1 only ever produces gateway↔ledger". The defect lived in the *conjunction*, which no single document owns and no single test covers. Writing a fact down does not make it composed with the other facts. That is a different failure from "the spec was wrong" (Day 3), "the spec was not executed" (Day 7), or "the author could not doubt it" (Day 6), and it is the one an audit is actually for.

  **Changed as a result.** The signature is now the guard: `runTier2` takes `readonly { aId, bId }[]` instead of a `ReadonlySet<string>`, so a caller holding a set of record ids **cannot typecheck**. Three new assertions carry the property rather than the number — every miss attributed to a named cause; a record must appear in both an exact pair and a Tier 2 pair (§10 rule 2, exercised by data); and an exception may report finding nothing only if the engine actually searched. That last one was run against the pre-fix engine before being trusted: it produces **200 findings**, which is how a test earns the right to be green.

  **One number that looks like a regression and is not.** `MATCH_CONFIRMED_EXACT` fell 203 → 46. Tier 1 still produces all 203 pairs; 157 of their groups now also hold a fuzzy bank leg, and §10 rule 5 reports a group at its **weakest** tier. 203 − 157 = 46. Reporting those as `exact` would overstate the evidence for the leg a sceptical reader is most likely to check — the rule costing match-quality-on-paper exactly as designed.

  **Also from AUDIT-2, filed rather than fixed:** [#41](https://github.com/flare19/payment-reconciliation-agent-platform/issues/41) P2 — `candidateAmountBuckets` inverts the fee band for bank→gateway, using `feeBandMinPct` where the upper bound needs `feeBandMaxPct`; 9 true pairs fall outside the span and all 9 are currently rescued by another candidate source, so it costs nothing today and scales with amount. [#42](https://github.com/flare19/payment-reconciliation-agent-platform/issues/42) P2 — S11 rule 3 names the refused pair as its own displacer. [#43](https://github.com/flare19/payment-reconciliation-agent-platform/issues/43) P2 — `countsTowardEngineMatchRate` admits `pending_review`, which ADR-040 excludes, so the browse list implies a higher rate than the headline. [#44](https://github.com/flare19/payment-reconciliation-agent-platform/issues/44) P2 — three tests that cannot fail. [#45](https://github.com/flare19/payment-reconciliation-agent-platform/issues/45) P3 — S11's cluster-merge branch is unreachable and discards pairs if reached.

  **Verified correct and worth recording as such,** because silence is not a result: `candidateDateRange` inverts the §5.2 windows correctly in both directions (854 true pairs checked, 12 misses, all of them S10 batch legs); the ADR-033 cap does not bind; `matchedPairs` derives from S11's groups so a refused pair cannot reappear as matched; `candidatesConsidered` is a true count, differing from the logged list in 308 of 555 exceptions; every paginated repository query ends in a unique tiebreak; migration 012 weakened neither the partial unique index nor the CHECK; and no unwired stage fabricates a value — `headline` is `null`, `runs.metrics` is `{}`, `measured` is never backfilled from `engine`.

  **Later on Day 9 — U8 (S14 metrics), and two things it caught.**

  **A reader written against a producer that did not exist.** `serialize.ts`'s `headline` block read `m['review']?.['pendingReviewCount']`; the metrics block is named `reviewBurden` (schema.md §11.1). U7 wrote that read on Day 8 against a `runs.metrics` that was `{}`, so `?.` resolved to `null` on every run and nothing failed. `schema.md` §11.5 rule 3 requires review burden to travel *with* the match rate — and this is the one way to break that rule silently: not by omitting the field, but by shipping it permanently null. **58 pending-review groups would have rendered as "—" next to the headline for the whole demo.** Day 7 named the pattern as "a module correct against its spec, wrong the first time something called it"; this is its mirror — a CONSUMER correct against its spec, wrong because the producer arrived later and nothing re-checked the seam.

  **An overstatement caught before it shipped, because Day 8 had already found it once.** The first `tierAttribution` draft reported `identityEstablished: 212`. S8 re-derives every pair S6 already claimed and reports `outcome: 'match'` "for completeness"; the real contribution is the **9** amount/timing verdicts Tier 1 declined. Day 8 removed exactly this inflation from the audit log and wrote down why. Reintroducing it under a different name in a different file, one day later, is worth recording plainly: **a lesson learned in one module does not propagate to the next by itself.** The fix is the same filter, and the test now pins both numbers — 9 as the answer, 212 as the number it must never report — so the next place this appears fails rather than publishes.

  **The denominator, which is what U8 was flagged as risky for.** ADR-040 says `reconcilable = ingested − excluded − rejected_rows − non_primary_duplicates`. That sentence is only coherent if `ingested` means **rows read from the files** — but `ingestion/index.ts` builds `counts.gateway` from `gateway.transactions.length`, and a row that failed to parse never becomes a transaction. So an implementer who sums the three source counts and *also* subtracts `rejected` removes rows that were never added, shrinking the denominator and **inflating the match rate**. On the holdout `rejected = 0`, so all three readings agree at 874 and the error would have been invisible. `population.ingested` is now file rows attempted, stated in the object itself, and `assertDenominatorIdentity` re-derives the arithmetic and **throws** rather than publishing a rate whose denominator does not reconcile. A run that cannot account for its own denominator should fail, not round.

  **Still Day 9 — U9 (`tools/score`) and U10 (the first scored run). The project has a MEASURED number for the first time, and getting it required admitting two scorer bugs and one contract gap.**

  **THE NUMBER, unedited, as ADR-020 requires:**

  ```
  pairs      precision 1.0000 · recall 0.6173 · F1 0.7634
             TP 442 · FP 0 · FN 274
             review queue: 150 pending pairs at 0.94 precision
             165 pairs excluded from both sides (their EVENT is an exception, ADR-072)
  classify   macro P 0.7222 · macro R 0.7309 · secondary-flag Jaccard 0.80
  honesty    unresolvable recall 1.0 over 21 · false-despair 58/74 = 0.78
  difficulty EASY 0.71 · MEDIUM 0.67 · HARD 0.20
  engine     match rate 67.85% against a computed ceiling of 93%
  ```

  **Zero false positives is the number worth reading first.** The engine claims 442 pairs and every one of them is in the key. Recall 0.617 says it finds under two-thirds of what is there — the honest weakness — and HARD at 0.20 says exactly where. That is a better result to report than a higher F1 with a non-zero FP count, and it is the shape this project chose deliberately: refusing to guess is a feature.

  **THE SCORER WAS WRONG TWICE ON ITS FIRST RUN, AND BOTH TIMES IT SAID THE ENGINE WAS WORSE THAN IT IS.** The first execution printed two build blockers: "the engine INVENTED a match on 5 designed-unresolvable events" and "3 TIMING_DRIFT events auto-confirmed". Both were scorer defects.

  - The unresolvable check asked "was any pair inside this event confirmed?" But §4's three sub-classes are unresolvable **in one leg**, not throughout: an `UNSPLITTABLE_NET_BATCH` event is a bank credit that nets N payments with no breakup file, and the gateway and ledger rows behind each payment are ordinary rows that match on `payment_id`. **The key says so itself** — all three pairs of all five flagged events carry `shouldMatch: true`. The engine was right and the scorer called it invention.
  - The TIMING_DRIFT cell read `expectedSecondaryFlags` where §5.2 means the primary `expectedCategory`. TIMING_DRIFT rides along as a secondary flag on `AMOUNT_MISMATCH` events whose gateway↔ledger leg legitimately matches, so the blocker fired three times on a clean run. The holdout has **no** event whose primary category is TIMING_DRIFT, so the correct cell is structurally zero here.

  **Why this is the entry that matters.** `tools/score` was flagged in the plan as *"the purest case: no test can catch a scorer that is wrong in the direction you hoped."* Both bugs were wrong in the direction nobody hopes for, which is the only reason they were caught in one run. Had either gone the other way — a check that quietly passed a real invention, or a recall denominator that dropped a few misses — the number would have looked *better*, nothing would have complained, and it would have shipped. **The asymmetry is the whole lesson: a scorer's optimistic bugs are silent and its pessimistic bugs are loud, so the loud ones are a gift and the silent ones are what an audit has to go looking for.** Correcting a check until a blocker stops firing is also indistinguishable from tuning, so every gate now has a test asserting it still FIRES on genuinely wrong output, not merely that it passes on the real run.

  **A contract gap that made the documented measurement impossible (ADR-073).** §5 says the scorer joins engine output to the key on `(sourceSystem, sourceRowNumber)`, and §2.1 explains why it must: the key is written before the engine exists and cannot reference engine-assigned UUIDs. But `RecordPreview` — the record shape inside every match member and exception — carried `transactionId` and `sourceSystem` and **not** `sourceRowNumber`. The only endpoints exposing a row number were 24 (which lists exactly the rows *outside* the denominator) and 12 (one transaction per request). **Two locked documents specified a measurement the contract between them could not carry**, and nothing surfaced it — not the typechecker, not 498 passing tests, not a careful reading of either document alone — until U9 tried to execute the join and got a 404. This is the Day 9 seam lesson a third time: the gap was not inside any module, it was between two documents that were each internally correct.

  **A smaller one worth naming because it wasted a cycle:** the first scored run reported `precision 0, recall 0, TP 0` against an engine that had matched 658 pairs. The cause was a stale `tsx` process still serving the old `recordPreview` on port 3001 — the code was right and the server was old. Loud, harmless, and a reminder that "I restarted it" is a belief until the response body says so.

  **End of Day 9 — what the measurement turned into, once the never-found set was actually opened.**

  "~80 pairs never found" was a bucket, not a diagnosis, and buckets hide things. Opening it produced a number that changes what Day 10 and 11 are for:

  ```
  never-found true pairs .................................... 133
    viaTier = batch — S10 built, tested, NEVER CALLED .......  48   #46 P1
    bank<->ledger capped at 0.55 against a 0.65 bar .........  42   #47 P1
    gateway-bearing, awaiting diagnosis (30 overlap #38) ....  43
  candidates never generated ................................   0
  ```

  **Zero.** Not one of the 133 was missed by candidate generation. Every one was generated, scored, and fell below a threshold. The blocking strategy is doing its job; the scoring model is not.

  **#47 is the one that would have been catastrophic to ship, and it is arithmetic rather than tuning.** `schema.md` §4.3 gives bank and ledger no comparable amount basis, so `scorePair` contributes 0 for the amount component — and does **not renormalise the remaining weights**. Best case for a bank↔ledger pair is `anchor 0.20 + date 0.20 + counterparty 0.15 = 0.55`, judged against `fuzzyReviewThreshold = 0.65`. **A bank↔ledger pair with a matching anchor, an exact date and an identical counterparty is refused.** There is no input that passes. Measured: of 244 true bank↔ledger pairs the engine reaches 178, and **every one only as a three-way group's implied leg — zero on their own merit.**

  Two locked decisions had never been reconciled: ADR-030 calibrated the weights assuming all four components apply, and §4.3 created a source pair where one never does. Neither is wrong alone. **This is the Day 9 seam again — the fourth time today** — and it is the sharpest instance yet, because the two documents are not merely inconsistent, they are jointly impossible, and the impossibility is a one-line sum that nobody had performed.

  **Why this was invisible for six days.** bank↔ledger pairs mostly arrive as the *implied* third edge of a three-way group, where the gateway leg carries them, so 178 of 244 look matched and the category never reads as broken. Only a scorer that asks "reached on its own merit?" separates the two, and that question did not exist until Day 9.

  **The discipline this sits inside, written into ARCHITECTURE §8.1 and habit 0.** The measurement also showed that `fuzzyAutoConfirmThreshold` at 0.85 is the entire difference between the 442 auto-confirmed pairs and the 583 the engine actually found — lowering it would lift the headline overnight. **That change is forbidden and #47's is not**, and the distinction is the whole point: a scale that omits an inapplicable component and then compares against a full-scale bar is wrong on its own terms, arguable without any holdout number, and would be wrong if the holdout did not exist. A threshold change would be arguable only by pointing at the number. **If the argument for a change is "the holdout number goes up", the argument is the evidence against it.**

  **Also settled today: the deploy posture (ADR-074).** Deploy moves to Day 10 not to tick it off but to meet the environment's unknowns while there is still time to absorb them — nothing here has ever run outside a laptop. Four P1s are open on the day it deploys and all of them land afterwards, so the deployment is judged on how cheaply it REDEPLOYS rather than on being finished. No CI/CD: one person, one branch, two `npm test` commands and a review gate that already exists. The cost is stated rather than hidden — without CI, "the tests passed" is a claim about what somebody ran, not a property of the commit.

- **2026-08-30 (Day 10)** — **I filed a P1 that was not one, and the check that caught it was reading the ADR log before writing code.**

  Day 10 opened by implementing #47 — renormalise the Tier 2 score over applicable weights, because an anchorless `bank↔ledger` pair caps at 0.35 against a 0.65 review floor and therefore cannot be matched. The arithmetic is real. The issue was still wrong, on two counts, and both were knowable before a line was written.

  **It was already decided, deliberately, on Day 4.** `schema.md` §5.4 documents the behaviour and cites **ADR-064**, which found the same thing during the Day 4 self-audit, computed the *exact* figure I re-derived (`strong_weak: (0.30+0.20+0.15)/0.65 = 0.846`), and declined to change it — because *"rewiring a scoring weight unattended, before the project has produced its first measured accuracy run"* is precisely what ARCHITECTURE §7 asks to be flagged rather than decided alone. It left a revisit condition: bank↔ledger exceptions where **an anchor-matched** counterpart exists but never reached review.

  **The revisit condition is measurably not met, and the fix recovers zero pairs.**

  ```
  TRUE bank<->ledger pairs .................. 244   reached 178   never reached 66
    of the 66, anchor component > 0 .........   0
    of the 66, sharing ANY reference value ..   0
  every bank<->ledger pair scorePair accepts: 83,979 — anchor 0.00 on ALL of them
  pairs renormalisation would lift to review:   0
  ```

  No bank↔ledger anchor exists anywhere in this dataset, so the 0.55 and 0.65 caps the issue is named after are theoretical. Every real pair maxes at `date 0.20 + counterparty 0.15 = 0.35`, and renormalised at 0.538 — both below 0.65. The 66 rows carry **disjoint identifier namespaces**: bank has `bank_ref_no` + `utr`, ledger has `entry_id` + `invoice_no`. There is no anchor to find, which also rules out #38 as their cause.

  **So the engine was right and the issue was wrong.** Two rows sharing no identifier, with no comparable amount and only a date and a merchant name, are not a match anyone should assert. Refusing them is this project's entire thesis, and I had written it up as a catastrophe.

  **What made it wrong is worth naming precisely.** Every prior defect this month lived in a seam between artifacts that were individually correct, and I had started treating "two documents that jointly imply something impossible" as the signature of a real bug. Here the two documents **agreed**, an ADR explained why, and I never opened it — I derived the arithmetic myself, found it damning, and filed. **A striking sum is a reason to search the decision log, not a substitute for having searched it.** The cost of not searching would have been a scoring change made after seeing a measurement, recovering nothing, raising bank↔ledger ceilings across the board, and risking the strongest number the project has — precision 1.0000, FP 0 — in exchange for zero.

  **Recorded so it cannot recur:** ADR-075 states the condition was evaluated and declined, with the measurement, because `0.55 < 0.65` is exactly the kind of sum that looks like an obvious bug on a fresh reading. That is how it got filed the first time.

  **One genuine finding did fall out of it** — [#48](https://github.com/flare19/payment-reconciliation-agent-platform/issues/48). §5.4 promises that a pair with no shared reference *"can reach the review band and ask a human, and that is all it can ever do."* For bank↔ledger the second half is false under either arithmetic, so a human is never asked and the record serialises as `needs_external_data` — *"the counterpart may exist outside these three files"* — about a counterpart sitting in the ledger file. A spec that lies about one of three source pairs, and a confidently wrong sentence in front of a reviewer.

  **Corrected attribution of the 133 never-found pairs:** 48 are S10 unwired (#46, real, Day 10); **42 are the engine correctly refusing anchorless bank↔ledger pairs**; 43 are gateway-bearing and still unexplained, which is where the recall gap actually lives.

  **Also Day 10 — the 43 gateway-bearing misses, diagnosed. The never-found population is now fully attributed, and it is mostly the engine being right.**

  Every one of the 43 has the identical shape: **perfect amount (delta 0, exact to the paisa), in-window date, perfect counterparty trigram, and `anchor = 0`.** They score 0.50–0.60 against a 0.65 floor. One test splits them — do the two rows share a reference *value* under *different* keys?

  ```
  sharing a value under different keys (#38) ....... 11
  sharing no reference value at all ................ 32
  ```

  The 11 are all `bank_ref_no == rrn`: a byte-identical 12-digit reference sitting on both rows, contributing nothing because `anchorAgreement`'s weak-key loop compares the *same* key on both sides and no bank row has an `rrn` field. That is #38, already a P1, and this raises its standing — those 11 are not merely under-scored, they are never surfaced to a human at all.

  **Final attribution of the 133 never-found pairs: 48 S10 (#46), 11 #38, and 74 the engine correctly refusing pairs with no shared identifier.** Only **59 are actionable**. That is a much better result than "133 missing" implied, and it took two days of measurement to see.

  **A second finding, folded into [#48](https://github.com/flare19/payment-reconciliation-agent-platform/issues/48) rather than filed fresh.** The date component is `0.20 × (1 − days_off / window_span)`, which is exactly zero when `days_off == window_span` — **on the SLA boundary, inside the window**. A T+3 card settlement, which ADR-009 defines as normal, scores the same date evidence as one thirty days late: none. Consequence: an anchorless pair with perfect amount and counterparty sits at 0.50 and needs three-quarters of the date weight to clear the floor, so **for every window the engine defines it reaches review only on a same-day match**. `schema.md` §5.4 and ADR-030 publish the opposite property — *"it can reach the review band and ask a human"* — and 20 of the 43 score zero on date while inside the window they were measured against.

  **Folded rather than filed because it breaks the same sentence #48 already names.** After #47 — where I filed a P1 that an ADR had already decided — the instinct to open a new issue for every striking number is the thing to distrust. Two mechanisms, one false sentence, one fix conversation.

  **And the same honesty applies to its yield:** correcting the date curve alone would recover approximately nothing. Those pairs are missing 0.30 of anchor weight; a plausible re-shaping moves them 0.50 → 0.55, still short. Recording it as a defect in the *published property* rather than as a recall opportunity is the accurate framing, and #48's recommended resolution is still to make the documentation true rather than to change the arithmetic.

  **Also Day 10 — S10 wired (#46). It runs, it is honest, and it recovers nothing, and the reason is the #40 error in a new stage.**

  `batch-stage.ts` is the caller `batch-decomposition.ts` had been waiting for since Day 4. Splits (§8.1) run first because their evidence is identity-bearing; batches (§8) follow over what splits left. Four decisions the docs never made are argued in ADR-076.

  **Two over-claims the wiring surfaced, both caught before they shipped.**

  The first wired run produced a `decomposed` verdict containing **one** gateway payment — a 1:1 pair Tier 2 had already scored and declined, re-decided by S10 on strictly weaker evidence, since the batch pool requires no anchor at all. `searchSubsetsInBand`'s own docstring already states the rule for the split path — *"a size-1 solution is an ordinary 1:1 match that belongs to the tiers, not to this stage"* — and the batch path had never passed the minimum. **A rule written down in one branch of a module and not applied in the neighbouring branch**, invisible until something called it.

  The second would have been worse. Without a pool-shape floor, wiring S10 relabels **all 69** unmatched settlement credits as `UNSPLITTABLE_BATCH`, replacing accurate `MISSING_IN_GATEWAY` exceptions with a proof the engine had not performed. ADR-038's entire content is that unsplittability may be claimed only after genuinely trying; a search over fewer than two candidates is not a genuine attempt at a *batch*. That would have looked like progress — a category moving off 0.000 — while being a straight downgrade in honesty.

  **And then the real finding.** With both guards in place S10 produces **zero** verdicts, because its candidate pool has a maximum size of **1**:

  ```
  gateway rows with NO bank counterpart:
    in a group, matched to ledger only ....... 58   <- EXCLUDED from the pool
    in no group at all ....................... 10   <- the ENTIRE pool today
  ```

  Every one of the six designed `UNSPLITTABLE_NET_BATCH` events has its gateway matched to its **ledger** row, so none can enter the pool. The predicate asks *"is this record in any group?"* where the domain question is *"does it have a **bank** counterpart?"* — **the same record-versus-role error as #40, in a different stage, four days after #40 was fixed and written up at length.** Filed as [#49](https://github.com/flare19/payment-reconciliation-agent-platform/issues/49); it is blocked on #45, because a widened pool means batch findings must merge into existing groups and `roleConflict` refuses multi-role merges unconditionally.

  **What that says about the failure mode.** #40's lesson was recorded as *"two facts in different documents, never composed."* That framing was too narrow. The reusable shape is **record-level reasoning where the domain is role-level** — a category error that has now appeared in Tier 2's pool, in S10's pool, and (as #45) in `roleConflict`'s refusal rule. Writing up an instance is not the same as recognising the class, and the cost of the difference was finding it again by hand.

  **The honest outcome of a wiring day is a stage that runs and a number that did not move.** #46 stays open with four of eight criteria met, and its recall arrives with #49.

  **Day 10, continued — #45 and #49 landed, and S10 finally does something. Two over-claims and one arithmetic slip were caught on the way, all three by measuring rather than by reading.**

  **#45 — rule 3's cardinality exception.** §10 rule 3 has always said `many_to_one` and `one_to_many` groups are *"the sole exception: multiple members of one role are legitimate there, and only there"*, and `roleConflict` never implemented it. The exception is now **declared by the rule that asserts the cardinality** (`mayDuplicateRole`), never inferred from the resulting shape — inferring it would make rule 3 toothless, because every ambiguous second candidate would quietly become a "many_to_one group" instead of an `AMBIGUOUS_MATCH`. Making same-role merges legal also made the cluster-merge branch reachable for the first time, so #45's second half — that branch silently dropping `cb.pairs` — had to land in the same commit. Left alone it would have let a weak `pending_review` pair absorbed into a strong cluster vanish from the merged group's confidence, tier and status.

  **#49 — the pool predicate.** Role-scoped now: *"does this gateway have a **bank** counterpart?"* rather than *"is it in any group?"*. That is the #40 category error, and this was its third appearance.

  **Then three things the measurement caught that reading would not have.**

  1. **A same-source scoring artefact.** A `one_to_many` group's two bank legs produce a `bank↔bank` pair, and `tools/score` counted 15 of them as invented matches — precision would have dropped from 1.0000 for the exact shape §8.1 exists to produce. The key models cross-source pairs; its only same-source entries are the nine `IDENTITY_DESTROYED` gateway↔gateway **denials**, which must stay fully scoreable. So the scorer now excludes unaffirmed same-source legs and **counts the exclusion**, and a test asserts the denials still fire. **A scorer defect that only becomes reachable when the engine starts producing a shape it never produced before.**

  2. **`UNSPLITTABLE_BATCH` at precision 0.067.** With only a pool-size floor, wiring S10 relabelled 17 credits across 15 events as unsplittable batches — one of them a designed batch, fourteen of them ordinary `TIMING_LAG_NORMAL` settlements. **A category moving off 0.000 looked like progress and was a straight downgrade in honesty.** §8 says a batch is *"the net of MANY payments"*, so the discriminator is that the credit must exceed the largest available candidate; with that, precision is **1.000** and recall **0.500**, with the three misses named.

  3. **And the first version of that fix was wrong in a way worth recording.** I required **two** present candidates. §4's `UNSPLITTABLE_NET_BATCH` is a credit netting payments *"with no breakup file provided"*, and the generator proves unresolvability over the payments that ARE available — often one. **The floor demanded the very evidence whose absence defines the scenario**, and it took the six designed batches to 0/6 before the measurement said so. Twice in one day, a guard written to prevent an over-claim became an under-claim; both times the fix was to go back to what the spec says the case IS, not to move a number until it looked right.

  **Where the holdout landed:**

  ```
                      before S10    after
  pair recall           658/872    694/872     +36
  cross-source invented     0          0
  one_to_many groups        0          7
  match members           755        773
  exceptions              256        236
  UNSPLITTABLE_BATCH  0.000/0.000  1.000/0.500
  match rate            67.85%     66.48%      -1.37
  ```

  **The match rate went DOWN and that is correct.** A split settlement is `pending_review` (ADR-038: a decomposition is a strong inference, never a certainty), and §10 rule 4 says a group containing a proposal IS a proposal — so seven groups that had been auto-confirmed became pending when their bank legs arrived. **The pairs were found; they are just not confirmed.** That is the found-versus-auto-confirmed distinction ARCHITECTURE §8.1 already documents, showing up in the headline for the first time, and it is the honest direction for it to move.

  **End of Day 10 — the re-score, and three more scorer defects that only S10's new output could reach.**

  ```
                        Day 9      Day 10
  precision            1.0000     1.0000
  recall (confirmed)   0.6173     0.6089
  TP / FP / FN        442/0/274  436/0/280
  pending pairs          150        207
  review-queue prec     0.94       1.0000  (over 183 judged)
  FOUND AT ALL       583 = 81.4%  619 = 86.5%
  unresolvable recall    1.0        1.0
  false-despair         0.78       0.80
  match rate           67.85%     66.48%   ceiling 93%
  build blockers          0          0
  ```

  **The headline fell and the engine got better, and both halves of that are true.** Split legs are `pending_review` (ADR-038), §10 rule 4 makes a group holding a proposal a proposal, so six pairs moved from confirmed to pending — while 51 more pairs were found. Auto-confirmed recall −0.008; **found-at-all +5.1 points**. This is the second day running where the honest headline moves opposite to the honest improvement, and it is the strongest argument yet for publishing both figures side by side rather than one.

  **Three scorer defects, all latent until the engine produced a shape it never had before.**

  1. **A crash.** `scoreResolvability` read `e.evidence['searchExhausted']` from `ExceptionSummary`, which does not carry `evidence` — only `ExceptionDetail` does. It never threw because S10 was unwired and the `UNSPLITTABLE_BATCH` guard always skipped. The first run to produce one died with `Cannot read properties of undefined`. Now read from `runs.metrics`, which S14 computes from the verdicts themselves.
  2. **Review-queue precision applied different exclusions from the primary metric.** Pending pairs on EXCEPTION events counted as wrong asks, reporting **24 bad proposals on a run whose genuinely wrong count is zero** and dragging the queue from 1.0 to 0.88. The queue's exclusions must match TP/FP's exactly, or the two disagree about what a wrong question is. **Correct figure: 1.0000 over 183 judged.**
  3. **A tie-break nobody had chosen.** §5.2 scores classification per EVENT; the engine raises exceptions per RECORD; **40 of ~72 exception events carry more than one category.** The scorer was picking whichever came first in the key's `projections` array — generator output order. Replacing it with canonical row order moved macro precision by 0.08 and took `UNSPLITTABLE_BATCH` from **1.000/0.167 to 0.000/0.000 on identical engine output**. Filed as [#50](https://github.com/flare19/payment-reconciliation-agent-platform/issues/50), P1: it is ADR-072's unit mismatch — the key describes events, the engine reports records — in its other half.

  **The pattern for the day, stated plainly.** Every defect found today lived in a consumer that had never been fed real input: `roleConflict`'s cardinality exception, S10's pool predicate, the scorer's evidence read, its queue exclusions, its category tie-break. **A stage that produces nothing validates every consumer downstream of it, and validates none of them.** Wiring S10 was worth doing for what it broke as much as for the 51 pairs it found.

  **And twice today a guard written against an over-claim became an under-claim** — the two-candidate batch floor, and the canonical tie-break that hides a category the engine gets right. Both times the correction was to go back to what the spec says the case IS. Neither time was it to move a number until it looked better.

  **Last thing on Day 10 — #50 fixed, and the classification figures were wrong the whole time.**

  §5.2 scores classification per EVENT; the engine raises exceptions per RECORD; 40 of ~72 exception events carry more than one category. The scorer had to pick one prediction and the rule for picking it had never been chosen — it was taking whichever exception came first in the answer key's `projections` array, i.e. generator output order. Replacing that with canonical row order was better but still arbitrary, and it read `UNSPLITTABLE_BATCH` as **0.000/0.000** for a category the engine raises on exactly the right credits.

  **The rule was already written down, in `schema.md` §8.2**, and it names this exact case:

  > *"**Unsplittable batch before presence,** for the same reason: its member payments would each otherwise be reported as `MISSING_IN_BANK`, turning one honest exception into five misleading ones."*

  So the scorer now picks an event's prediction by the **engine's own precedence order**, applied across the event's records. It is the engine's stated rule rather than one I invented; it does not consult `expectedCategory`, so it cannot manufacture a hit; and it is order-independent, which the row-order rule only accidentally was.

  ```
                        row order   §8.2 precedence
  macro precision        0.7891         0.9286
  macro recall           0.8024         0.8738
  UNSPLITTABLE_BATCH  0.000/0.000    1.000/0.500
  MISSING_IN_BANK     0.700/0.933    1.000/0.933
  MISSING_IN_LEDGER   0.824/0.933    1.000/0.933
  ```

  **The engine output is byte-identical across those two columns.** Every one of those numbers moved because the measurement changed, and the earlier ones were wrong. A multi-label view is now reported beside the matrix — a category counts if raised anywhere on the event — because the single-label reduction discards what the engine said on more than half its exception events, and hiding that was part of how the problem stayed invisible.

  **What makes this the day's most uncomfortable finding.** Three separate scorer defects landed in one day, all in the module whose entire job is to be trustworthy, and all invisible until the engine produced output it had never produced before. The accuracy table published on Day 9 was not wrong about the engine, but it was wrong about the exception list, and nothing in the suite could have said so. `tools/score` needs the same treatment the engine got: an isolated audit, by someone who did not write it.


- **2026-08-31** — **Day 11: #38 fixed. Anchor agreement had never been compared across key types, so a byte-identical reference sitting on both rows scored zero.**

  `anchorAgreement` in `scoring.ts` compared weak anchor keys **like-for-like only** — `structuredValue(a, key)` against `structuredValue(b, key)` for the *same* key. `bank_ref_no` exists on bank rows and on no other source, so that branch could never fire across sources. A bank row whose `bank_ref_no` was byte-identical to a gateway `rrn` scored `anchor: none` — a literal zero — with a perfect amount, an in-window date and a perfect counterparty trigram, landing at 0.50–0.60 against the 0.65 review floor. Eleven true pairs on the holdout, every one of them in the never-found set: not scored low, never surfaced to a human at all.

  **Recovered by:** a cross-key comparison block in `anchorAgreement` — every structured STRONG anchor on one side against every structured WEAK anchor on the other, both directions, scored `strong_weak` (0.30). No weight changed. `strong_weak` and not `weak_weak` because the block immediately above already grants 0.30 when a structured anchor matches a value **regex'd out of a free-text description blob**, and a value the source stated in a structured column of its own is strictly better evidence than that. Paying it less would have inverted the ordering; paying it nothing, as it did, inverted it completely.

  **The measurement, on byte-identical inputs:**

  ```
                        Day 10     Day 11
  precision            1.0000     1.0000
  false positives          0          0
  recall (confirmed)   0.6089     0.6075
  TP / FP / FN        436/0/280  435/0/281
  pending pairs          207        230
  review-queue prec  1.0 (n=183) 1.0 (n=206)
  FOUND AT ALL       619 = 86.5% 641 = 89.5%     +3.1 pts
  match rate           66.48%     65.22%         -1.26
  match members          773        784
  exceptions             236        214
  audit entries          615        593
  MISSING_IN_BANK         51         40
  MISSING_IN_GATEWAY      70         58
  unresolvable recall    1.0        1.0
  false-despair         0.800      0.816
  classification    macro 0.9286 / 0.8738 — unchanged in every cell
  build blockers           0          0
  ```

  **Third day running that the headline moves opposite to the improvement, and the reason is the same one both previous times.** Seven of the eleven recovered pairs score in the 0.65–0.849 review band; §10 rule 4 makes a group holding a proposal a proposal, so seven groups that had been auto-confirmed became `pending_review` and took their already-counted legs out of the headline with them. One pair moved from confirmed to pending, which is the whole of the −0.0014 in auto-confirmed recall. **Twenty-two more pairs are located and every one of them is correct** — review-queue precision is still 1.0000 over 23 more judged proposals. If ARCHITECTURE §8.1's found-versus-confirmed framing needed a third witness, this is it.

  **A second-order effect worth naming, because it looks like a regression and is not.** `UNSPLITTABLE_BATCH` went 3 → 4 and `batchSearchExhausted` 3 → 4. One bank credit (`bank:51`, LENSKART, ₹3,01,719.78) was classified `MISSING_IN_GATEWAY` before and `UNSPLITTABLE_BATCH` after. Nothing about that credit changed — a gateway payment in its S10 candidate pool acquired a bank leg through the new cross-key anchor and therefore left the pool, which changed the answer S10's bounded search returns for it. The category moved from *"no gateway row found"* to *"the engine tried to decompose this credit and proved it could not"*, which is `schema.md` §8.2's precedence working exactly as written and is strictly more useful to a human. Classification precision and recall did not move in any cell.

  **What the fix deliberately does NOT do, both decided on evidence rather than symmetry:**

  1. **A strong-key contradiction still discards the pair**, whichever weak key agrees — `bank_ref_no` is documented as *sometimes* equal to the RRN, so a coincidental agreement must never outvote two ids that positively disagree. A consequence, asserted in a test rather than left to be discovered: a **near-anchor** is by construction two values of the same key that differ, so wherever a near-anchor exists the cross-key block stands down. That costs nothing measurable — bank rows carry no structured strong anchor at all (AUDIT-1), so a gateway↔bank pair has nothing to contradict with, and zero holdout pairs exercise the interaction.
  2. **weak↔weak across different keys is not granted.** A gateway `order_id` equal to a bank `bank_ref_no` is the symmetric case and the issue explicitly asked for it to be decided on evidence. It occurs **zero times among the holdout's 26,908 candidate pairs**, so granting it would add an inference path nothing exercises. Left out, and said so — in a test, so the decision is visible rather than absent.

  **Why 486 passing tests never caught this.** The same shape as #30, #31 and #40: `scoring.ts` was correct against every worked example in `schema.md` and had a guard test protecting the ADR-030 ceiling, and the ceiling was never what was wrong. The defect was in a comparison that *doesn't happen*, and no test can assert the absence of a comparison nobody thought to write. What made it findable at all was the answer key — the pair recall figure is the only artifact in this project that can say "there are eleven relationships here that you did not find", and the only reason it could name them was that #46 had already cleared the other 48 out of the way.

  **Fourteen pinned test literals moved, across five files.** Every one was checked against a before/after run rather than pasted from a failure message, and each delta reconciles arithmetically with the eleven pairs: +11 match members, +11 three-way groups, +22 implied pairs, −22 exceptions, −22 audit entries, −9 `MATCH_CONFIRMED_EXACT` (§10 rule 5 reporting a group at its weakest tier), +7 `MATCH_FLAGGED_FOR_REVIEW`. **A pin updated to whatever the run printed is not a passing test, it is a recording.** The three new positive assertions in `scoring.test.ts` were verified to FAIL with the fix reverted before they were kept.

  **Later on Day 11 — attributing the residual gap, and what it says about "65% against a 93% ceiling".**

  The headline invites the wrong reading, so here is the decomposition, measured rather than asserted:

  ```
  reconcilable records          874
  auto/human confirmed          570 = 65.22%   <- the headline
  pending_review                214 = 24.49%   <- found, correct, awaiting a human
  IN A GROUP AT ALL             784 = 89.70%
  ceiling (93%)                 813
  genuinely not located          29 =  3.32 pts
  ```

  **Of the 27.78-point gap between the headline and the ceiling, 24.49 points is the review queue** — records the engine located, whose proposals are correct at **1.0000 precision over 206 judged pairs**, and which ADR-040 deliberately keeps out of the headline because a human has not confirmed them. **3.3 points is the engine actually failing to find something.** The headline is not a measure of how much the engine found; it is a measure of how much it will assert on its own, and those are different numbers by design.

  At pair level: 716 scorable true pairs, 435 confirmed, 206 pending, **75 never found**. Attributed one by one:

  ```
  no shared reference value, bank<->ledger ....... 37   correct refusal (ADR-064/075, see #48)
  no shared reference value, gateway<->bank ...... 20   correct refusal (ADR-030 ceiling)
  no shared reference value, gateway<->ledger .... 13   correct refusal
  share a reference value, NOT matched ............ 5   ACTIONABLE -> #51
  ```

  **70 of 75 are the engine declining pairs that share no identifier at all**, which is the ADR-030 honesty property doing exactly what it exists for. Matching them would require guessing from amount, date and name — the coincidence generators — and a run that did so would raise the match rate and lower the thing the rate is supposed to stand for.

  **The remaining 5 are one defect, filed as [#51](https://github.com/flare19/payment-reconciliation-agent-platform/issues/51), and it is the third instance of one family.** `batch-stage.ts` offers the split pass only gateway records with *no* bank counterpart (`openIn('gateway','bank')`). A split settlement is one gateway payment across N bank credits — so the moment S9 accepts any single leg, the record leaves the pool and `findSplitSettlement` is never asked about the rest. **7 of 9 split events assemble fully; the 2 that do not are exactly the 2 where S9 found a leg first.** Which of the nine assemble is decided by a race between S9 and S10 rather than by evidence.

  ```
  #40  Tier 2 excluded whole RECORDS where §6.3 excludes PAIRS
  #49  S10 asked "is this in any group?" where the question is "a counterpart in this ROLE?"
  #51  S10's SPLIT pass asks "a counterpart in this role?" where the question is "is this role COMPLETE?"
  ```

  Each time a presence test stood in for a more specific question; each time it removed records from a stage's domain silently rather than erroring. **And each was found only by attributing misses against the answer key, never by a test.** The scorer is the only instrument in this project that can say "there are five relationships here you did not find".

  **Still Day 11 — #51 fixed, and §8.1's anchor clause turned out never to have fired at all.**

  Filed as "the split pass is gated on a role-PRESENCE test". That was true and it was half the defect. The other half only appeared once the gate was opened: the two events still refused, now with all their legs in the pool.

  ```
  gateway:250   net 19,386   settlement_id setl_X6oDB8pVLveGk2   rrn 579481974116
    bank:290 = 4,076   bank:39 = 5,485   bank:238 = 9,823   bank:296 = 2
    every leg: bank_ref_no = 579481974116, description carries setl_X6oDB8pVLveGk2
    sum = 19,386  — EXACTLY the expected net
    verdict before: none  ("at least two combinations sum to this credit")
  ```

  The second combination is the same four legs minus the **2-paise** one: 19,384, also inside a ±100 paise band. **The tolerance that exists to absorb fee rounding was deciding membership**, while a settlement id sitting on all four rows went unread.

  **Why it went unread is the finding.** §8.1 says *"group unmatched bank credits **sharing an anchor with the gateway record**"*, and the implementation tested `sharedStrongAnchor` — structured strong keys, like-for-like. AUDIT-1 established on Day 6 that **bank rows carry no structured strong anchor at all.** So that test was always `null` on real data, every leg was admitted on the date window alone, and **§8.1's anchor clause had never fired once since the day it was written.** Same blindness as #38, one module over, found the same way: by asking why a specific true pair was missing.

  **Fixed in three parts, all of which are needed — any one alone leaves the events half-assembled:**

  1. **The gate.** A gateway record is offered to the split pass while its bank role is *open* — empty, **or** filled by legs that sum short of the payment. Presence was the wrong test for the one rule whose subject is having more than one leg. Already-matched legs join the search pool, and the accepted solution must contain them.
  2. **Admission.** `sharedStrongAnchor` **or** `sharedReferenceValue` — the cross-key notion #38 established, now extracted into `anchors.ts` with a warning block so S9 and S10 cannot drift and S4/S6/S7/S8 cannot call it. Where ≥2 reference-bearing legs sum into the band, **that set is the split**; arithmetic proves the sum instead of choosing the members. The subset search is untouched for legs carrying no reference.
  3. **Emission.** Every leg is emitted as a split pair, including one a tier already matched, and that tier pair is superseded. §10 rule 3 admits several members of one role only through pairs that DECLARE the exception (ADR-077) — so a non-declaring fuzzy pair beside three declaring ones is refused as `AMBIGUOUS_MATCH` and **its leg is thrown out of the group the stage just proved.** That is exactly what happened to `bank:290` and `bank:253` on the first attempt, and it is why 7/9 became 8/9 and not 9/9 until this landed.

  ```
                        before #51   after
  split events assembled     7/9      9/9 by the rule, 8/9 end to end
  match members              784      789
  FOUND AT ALL         641 = 89.5%  648 = 90.5%
  pending pairs              230      246
  review-queue precision  1.0 (206) 1.0 (213)
  precision / FP          1.0000 / 0  1.0000 / 0
  exceptions                 214      212
  MISSING_IN_GATEWAY          58       53
  MISSING_IN_LEDGER           63       66
  tierAttribution batch       18       25
  match rate               65.22%   65.22%
  classification    macro 0.9286 / 0.8738 — unchanged in every cell
  ```

  The ninth split is short one **ledger** row that no tier ever matched — a gateway↔ledger miss, not a split one. `MISSING_IN_LEDGER` rising by 3 is the five newly-grouped bank rows correctly changing which role they are missing.

  **The pattern, now at four instances and worth stating as a rule.** #40, #49, #51's gate and #51's admission are all the same mistake: **a cheap test standing in for the question actually being asked, and failing SILENTLY by removing things from a stage's domain rather than erroring.** Records vs pairs; any group vs this role; a counterpart in this role vs this role being complete; a strong key vs a shared reference value. In every case the code was defensible line by line, the tests passed, and the only instrument that could see the loss was the answer key.

  **And a rule for the next one:** when a predicate names a *property of a record* but the rule around it is about a *relationship between records*, that is the smell. All four were that.

  **End of Day 11 — the LLM provider changed, and one locked design assumption did not survive it.**

  There is no Anthropic API key for this build, so both LLM surfaces move to **Gemini** on the free tier: `gemini-3.5-flash` for the explain layer, `gemini-3.7-flash` for the Analyst, one `GEMINI_API_KEY`, `@google/genai`. ADR-080. Nothing broke — but scoping it surfaced two things worth recording before U11 starts writing against them.

  **1. `AGENT_MAX_COST_USD_PER_RUN` was the wrong bound and nobody had noticed, because it had never been tested against a free tier.** A cost ceiling protects a credit card. A free-tier key has no bill to cap, and its scarce resource is **requests per day** — so a run that dutifully stays under $1.00 can still exhaust the entire daily quota and leave the deployed demo dead until it resets, with no way to pay to reopen it. On submission day that is the failure that matters, and it was not bounded at all. `AGENT_MAX_LLM_REQUESTS_PER_RUN` (default 220 — 20 investigations × ~10 steps plus headroom) is now counted and enforced whether or not the key is billed.

  Worth naming as a class: **a bound is only a bound against the failure it was written for.** ADR-057's ceiling was written when the risk was a surprise bill; the risk is now a dead demo, and the same number does not cover both.

  **2. Two documents leaned on Anthropic prompt caching for their cost argument** — `schema.md` §10.3's *"cacheable prefix"* and `agent-design.md` §8's *"that is the difference between an affordable phase and an expensive one."* Gemini does not offer that mechanism in the same form, so both claims are now removed rather than quietly reinterpreted. The good news is that neither design actually needed it: the explain layer's economy is ADR-018's **signature collapse** (~75 exceptions → 15–30 signatures → ≤8 requests), which is a property of the batching and holds on any provider; and §8's bounds are step, tool-call, wall-clock and request ceilings enforced between turns, not cost estimates. **The arguments survive; the sentences that rested on a vendor feature do not.**

  **One thing deliberately NOT written down: a rate-limit number.** Google's rate-limit page defers to AI Studio for per-key figures and the third-party summaries contradict each other by an order of magnitude. An unverified number inside a locked document is worse than a stated absence, so the design is built not to need one — 8 requests per run for explain, 220 for Phase A, and honest degradations (`explanation_source = 'template'`, `INSUFFICIENT_EVIDENCE` with `budgetExhausted`) on either side of a quota wall.

  **And one privacy fact that belongs in the submission rather than a footnote:** free-tier content is used to improve Google's products. For the explain layer that is a non-issue **by construction** — ADR-018 sends only the signature, with no amounts, no ids and no merchant names. Phase A is different: its tool results carry real record data. This dataset is synthetic, which makes the free tier acceptable here and nowhere else.

  **Last thing on Day 11 — the Analyst was pointed at the wrong pile, and nobody had noticed because the right pile is not the one the track names.**

  Phase A was designed entirely against the **exception list**, because that is the feature the track grades. A run also leaves a **review queue**: matches the engine found, scored into the 0.65–0.849 band, and correctly declined to auto-confirm. On the holdout that is **71 groups covering 214 records — 24.5 points of the reconcilable population, at a measured review-queue precision of 1.0000 over 213 judged pairs.** Nothing in Phase A looked at any of it.

  That was an accident of framing rather than a decision, and it hid the sharpest asymmetry in the design: an Analyst proposal a human accepts becomes a **`manual`** match, which ADR-043 and ADR-051 exclude from the engine match rate — so the Analyst as designed could *never* move the headline. A **pending** match a human confirms becomes **`human_confirmed`**, which ADR-040 counts. **The one Analyst surface that can move 65.22% is the one it was not looking at.**

  ADR-081 adds it, with the line drawn where ADR-017 requires: **the agent never recommends confirming or rejecting.** `CONFIRM_RECOMMENDED` was the obvious verdict shape and is the wrong one — a model answering "should this be confirmed?" fifteen times is deciding, whatever the field is called. It answers a different question it can actually source from tools: *is there evidence the scorer did not use?* — `CORROBORATED` / `CONTRADICTED` / `NO_NEW_EVIDENCE`, every one cited and checked by the A3 grounding gate. A human still clicks.

  **The measurement is unusually sharp and that is the point.** Because the queue's engine-side precision is a clean 1.0000, **every `CONTRADICTED` verdict is measurably a false alarm** — there is nowhere for a wrong answer to hide. An agent manufacturing doubt to look useful shows up on the first run.

- **2026-08-31 — overnight P2/P3 sweep, branch `day12-p2p3-sweep`.** Ten backlog issues attempted, all ten landed as real fixes — no engine output moved and no pinned literal changed (verified: `npm run typecheck` and `apps/api`'s unit suite — 424 → 430 — plus the root `tools/` suite at 235, all green; integration tests need Postgres, unavailable here, so `routes.test.ts`'s two edits are typecheck-verified only, not run).

  **#9 — `tests/` was never typechecked, and one assertion could not fail.** Added `tsconfig.test.json` (tests/** included, build config stays src-only) and pointed `npm run typecheck` at it. Turning it on immediately surfaced five real type errors `tsx`'s strip-only transform had been hiding for who knows how long — a `classification.test.ts` assertion matching `undefined ?? severity` against `/.*/` (replaced with the category/secondary-flag/candidatesConsidered it actually produces), a fixture missing two `RunRecordCounts` fields, three possibly-undefined index reads, two `string|null` args, and a `pipeline()` return type that silently dropped its own cast. All five were test-file-only; nothing in `src/` changed.

  **#44 — three tests whose titles claimed more than their assertions checked.** Two of the three findings were real: the manual-match test picked two `MISSING_IN_BANK` gateway records, which (structurally, since Tier 1 only ever matches gateway↔ledger) are routinely already matched — the POST reliably hit 409 and `tier === 'manual'` had zero coverage. Switched to two excluded (never-matched) records, making the 201 path deterministic and removing the `if/else`. The third finding (the recall test enumerating every shortfall by cause) turned out to be **already fixed** in a prior commit — `tier2-groups.test.ts` already attributes every miss to a named, exact-count cause. Said so rather than re-doing it.

  **#33 — same pattern, Tier 1's own recall test.** `matches.length > 150` had 44 matches of headroom, enough to hide #30's 9 `REFUND_REVERSAL` misses entirely. Replaced with a real recall assertion against the answer key's `viaTier: 'exact'` gateway↔ledger pairs (210 today, not the stale count from when #33 was filed) and an enumerated-cause classification of every miss: **9 are `AMOUNT_TRUE_MISMATCH`**, correctly left to S8; **9 are non-primary exact duplicates dedupe drops from the pool before Tier 1 runs** — a `DUPLICATE_RECORD` class this suite had never named before, only visible once the whole miss set was enumerated instead of floored.

  **#11 — the searchExhausted/searchBoundExceeded exclusivity test built a fixture that already satisfied what it was testing.** The real invariant lives in `searchSubsetsInBand`, not in `classify.ts` (a straight passthrough). Added a property test directly against `searchSubsets` sweeping pool size/target/tolerance/node budget, and replaced the classify-level test with one that feeds a genuinely contradictory stats object and asserts classify passes both fields through unchanged — proving it as a passthrough rather than pretending it enforces something it doesn't.

  **#13 — `domain.ts`'s header claimed every union mirrors a CHECK constraint in both directions; it doesn't.** `PaymentMethod`/`BankTxnType` back plain-TEXT columns with no CHECK (schema.md already said so correctly), and three CHECK constraints have no TS union. Comment-only: narrowed the claim and named both exceptions and why they still matter.

  **#24 — `appendAuditEntry` would throw on a NUL or an unpaired surrogate in the very record it was trying to log.** Postgres's jsonb parser rejects both even though `JSON.stringify` produces well-formed JSON text for them. `canonicalJson` now sanitizes every string (and object key) before serializing — NUL stripped, an unpaired surrogate becomes the replacement character — running BEFORE hashing so the hash and the stored bytes agree, the same way key-order and date normalisation already do. `reason` (a plain TEXT column that bypasses `canonicalize` at write time but is still walked when the whole entry is hashed) is sanitized identically in `toStoredForm`, or the hash and the actual SQL parameter would silently diverge. A no-op for any string that doesn't contain one, so no existing hash changed. Not exercised against a live INSERT here — no Postgres — verified at the `canonicalJson`/hash-chain unit level, which is where the throw actually originates once a database is involved.

  **Review, same morning — one change was reverted before merge, and it is the most instructive thing here.** The #25 commit also edited a comment inside `apps/api/migrations/007_audit_log.sql`. `db/migrate.ts` **checksums every migration file** and turns any change into a startup failure — comments included — so that one-line comment made every already-migrated database refuse to boot, with the error reading *"Migrations are forward-only: add a new migration instead of editing this one."* It broke all five integration suites (93 tests) and, with `RUN_MIGRATIONS_ON_BOOT=true` as the default, would have taken the API down on Railway the moment U14 deployed.

  **The unit suite was green the whole time.** The sweep ran in a cloud environment with no Postgres, correctly said so rather than implying integration had passed, and still could not have caught this: it is precisely a defect that only exists once a database remembers what it already ran. The clarification it was adding was already stated in `hash-chain.ts` and `schema.md` §9.0 by the same sweep — two better places — so reverting cost nothing. **Every other change was verified against a real database and a full scored run: 523/523 tests, and byte-identical engine output** (284 matches, 212 exceptions, 591 audit entries, match rate 65.22%, tier attribution unchanged).

  **#28, #25, #27, #10 — four doc-vs-code contradictions, all docs-only (plus two one-line, non-functional code comments).** `api-contract.md` described a `ChainVerification` response that matched neither itself (§1 vs §22) nor the code (missing `divergenceKind`/`anchored`/`expectedEntryCount`/`expectedChainHead`, and a `verifiedAt` the endpoint has never produced) — reconciled to the real 8-field shape (#28). `schema.md` §9.0, migration 007's comment and ADR-042 all said the hash excludes two fields; `hash-chain.ts`'s `strip()` — already correct — excludes three (`sequence_no` too, DB-assigned at INSERT). Named all three everywhere and appended **ADR-082** (#25). `schema.md` §9.0 still claimed "no concurrent-append race to resolve" via a single-writer assumption Unit 9's advisory lock made obsolete by design; rewrote it to describe the actual per-chain `TxClient`-scoped lock (#27). `matching-engine.md` §7.3 said the ambiguity guard runs AFTER assignment ("even if step 3 happened to assign it one of them") while `schema.md` §5.4 and the code (unchanged, already correct) run it BEFORE assignment and block the slot — fixed the doc and appended **ADR-083** (#10).

  **The pattern worth naming:** every one of the ten was either a test that could not fail, or a doc that disagreed with already-correct code. Not one required changing what the engine does. That is exactly the shape a P2/P3 sweep should have — the load-bearing defects get found by audits and answer-key measurement, and what is left is the credibility debt of tests and docs that stopped being true days ago and nobody re-checked.

- **2026-08-31** — **Day 11, U11: the explain layer (S13) is wired. The last unwired stage is gone, and `stagesNotRun` is empty for the first time.** Branch `day12-explain-layer`.

  **What the run does now.** 212 exceptions collapse to **21 distinct discrepancy signatures**, each one gets text, and `explanation_text` is never null. There is no `GEMINI_API_KEY` on this build, so all 21 resolve to hand-written templates and every exception carries `explanation_source = 'template'` and moves `open → explained`. That is the path ADR-017 requires to work and it is the one that actually runs here — the model path exists, is unit-tested against a fake client, and has never made a live call.

  **The number that moved, and exactly why.** The audit chain went **591 → 612**. The `+21` is not a coincidence and is not "roughly one per exception": it is *exactly* the distinct-signature count, because **the explain decision is made once per signature** — call the model, reuse the cache, or take the template — and then fanned out to every exception wearing that signature. One entry per *exception* would have added 212 and been transcription, which is the line `orchestrator.ts` already draws for ingestion (one entry per source, not per row) and that §9.1 draws by flooring `MATCH_CANDIDATE_REJECTED` at 0.40. The integration test now asserts `explainEntries === distinctSignatures` rather than pinning `21` alone, so the *reason* is what fails if it drifts.

  **What did NOT move, verified the only way worth trusting.** A `git worktree` at `main`, a holdout run through the pre-U11 engine, and `npm run score` against both runs: **the two score reports are byte-identical.** precision 1.0000 · FP 0 · recall 0.6075 · macro P 0.9286 / R 0.8738 · unresolvable recall 1.0 · match rate 65.22% · `tierAttribution {exact 203, fuzzy 277, batch 25, implied 242}`. Diffing two scorer outputs is a much stronger claim than re-reading a number out of `CLAUDE.md`, and it caught nothing — which is the result.

  > **A number in `CLAUDE.md` was stale and would have read as a regression.** §10 records `recall 0.6089` from Day 10. The current figure is **0.6075**, and it is 0.6075 **on `main` too** — #38 and #51 moved pairs into the review band after that line was written (§10 rule 4), and the headline recall was never updated with them. Had I compared against the doc instead of against `main`, I would have spent the evening hunting a 0.0014 regression that U11 did not cause and that is not a regression at all. Corrected in §10 in this commit.

  **The design decision that took the longest, and the failure it prevents (ADR-084).** `explanation_cache` is deliberately **run-independent** — it outlives the run that wrote it, which is the whole of ADR-018's economy. So if S13 had cached *template* rows, the first keyless run would have written all 21 signatures as cache entries, and every later run — **including runs that do have a key** — would have served them as hits. The day a key was finally added, the explain layer would have kept emitting templates labelled `explanation_source = 'llm_cache'`: prose attributed to a model that never wrote it, in the artifact a panelist reads, with nothing in the output saying so. Only fresh model output is cached now. What made this worth an ADR rather than a comment is that `schema.md`'s own column annotation reads the other way (`tokens_in` — *"NULL for template-sourced rows"*), so a future session finding templates absent from the cache would otherwise have "fixed" it straight back in.

  **Two more things the spec did not settle, both decided in the direction that makes the advertised bound true.**

  1. **A retry counts against `LLM_MAX_CALLS_PER_RUN`.** §10.3 caps calls at 8 and §10.4 grants one retry on malformed JSON, and the two together are ambiguous. If retries were free, a "hard cap" of 8 would permit 16 requests — and on a free-tier key the binding resource is **requests per day**, not dollars (ADR-080 consequence 2), so the doubling lands exactly on the thing that can kill a submission-day demo. `explainBatch` returns `requestsMade` on *both* its success and failure arms so the driver debits what was actually spent.
  2. **…which then exposed an off-by-one in my own first version.** Checking the budget only *before* each batch still let the last permitted batch spend its retry, so a cap of 8 could spend 9. Fixed by passing the remaining budget INTO the client, which bounds the retry as well as the first attempt: the final batch forgoes its retry and takes the template floor, which is the outcome the cap already promises. Caught by writing the test that asserts `maxRequests` arrives as `[3, 1]` and not `[3, 3]`.

  **A test fixture that was wrong in an instructive way.** My first driver tests built 100 exceptions by incrementing `candidatesConsidered: 0..99` and asserted 100 distinct signatures. They produced **four** — because `candidateCountBucket` collapses that field to `0 | 1 | 2_3 | gt_3`, which is precisely what the module exists to do. Five tests failed and every one of them was the fixture, not the code. The replacement walks a mixed-radix cross product of the four components that genuinely vary (8 categories × 3 anchor strengths × 4 candidate bands × 2 alias states = 192) and asserts the group count up front, so a fixture that stops producing distinct shapes fails loudly instead of quietly testing nothing. **This is the sixth instance in this log of a test whose name claimed more than its assertion** — and the first where the bug was that the code worked *better* than the test assumed.

  **One structural decision worth recording because it is invisible in the diff.** S13 is the only stage that awaits the network, and its reads and model calls happen **outside any transaction**; only the writes are wrapped. Every other phase opens its transaction first. Had this one followed that pattern, `appendAuditEntry`'s transaction-scoped advisory lock on the run's chain would have been held across up to eight 20-second HTTP round trips — blocking every other append and sitting exposed to a managed-Postgres idle-in-transaction timeout on Railway, the platform U14 deploys to. The cost of the split is stated rather than hidden: a crash between the model call and the write loses the prose and leaves the exceptions at `open`. That is the correct direction to fail, because a re-run regenerates it and S13 changes no decision.

  **Verified:** 579 tests in `apps/api` (481 unit + 98 integration, from 523) and 235 at root, all green against a real Postgres 17; typecheck and both builds clean; chain valid **and** anchored at 612; `explanation_cache` empty after a keyless run; `npm run score` exit 0 with every honesty gate passed, posted to `score_reports`.

- **2026-08-31** — **Day 12, U12: the Analyst's tool registry. Nine read-only tools, and the read-only claim is now enforced by Postgres rather than by this repo's good intentions.** Branch `day12-explain-layer`.

  **The thing worth reporting is not the nine tools. It is that "read-only" stopped being a word.** `agent-design.md` §4 has always promised the agent *"is not trusted not to write — it is unable to."* Every implementation I sketched made that a **claim**: a `readOnly: true` flag on each tool, a naming check, a review habit. All three are properties of code someone can change. Every tool handler now runs inside `withReadOnlyTransaction` — Postgres `BEGIN TRANSACTION READ ONLY` — so an INSERT/UPDATE/DELETE reached from any tool fails with **SQLSTATE 25006** whatever the calling code believes it is doing, *including through a repository function that was read-only when the tool was written and is not any more.* A test asserts the throw rather than assuming it. That is the only one of the three guards that survives a future edit by someone who has not read ADR-051.

  **The gap that guarantee still has, and the guard that closes it.** A read-only transaction only constrains queries issued on the client it yields. A tool calling `getPool()` directly — or calling a repository function *without passing the client*, which falls back to the pool internally — escapes into autocommit with full write access, **and every test would still pass**, because the tools being tested happen not to write. So there is a structural guard: no module under `services/agent/` may contain SQL DML, import a mutating repository function, or reach the pool; and every repository call in the registry must pass the client. I verified that last one **fires** by deleting a single `, c` argument and watching it fail — a guard nobody has watched fail is indistinguishable from one that cannot.

  > **`getCachedExplanation` is on the mutating-function denylist, and it is the interesting entry.** Its name reads like a lookup. It is an `UPDATE … SET hit_count = hit_count + 1 … RETURNING`, because U11 wanted the read and the counter in one round trip. A read-looking name that writes is exactly the trap a denylist built from intuition would miss.

  **A stale doc line that turned out to be a design bug (ADR-085).** `CLAUDE.md`'s plan flagged that §4 still described `rerun_subset_search` as *"the same S10 meet-in-the-middle"* — ADR-060 replaced that with depth-first — and asked for a doc fix. Fixing it exposed the real problem one column to the right: the tool signature let the agent pass **`budgetMs`**. That would put the operative bound back on the **wall clock, inside the evidence a reasoning chain cites** — and `searchExhausted` vs `searchBoundExceeded` are different claims *about the data*, so deciding between them by hardware speed is precisely the defect ADR-060 removed from S10. §5's entire payoff is the upgrade: *"exhaustive at wider bounds"* is worth saying only if a second machine reproduces it. The tool now widens a **node budget**; the 2 s valve stays a valve. **The word was stale for one reason and wrong for a much better one.**

  The ceiling is **5,200,000 nodes**, and unlike ADR-063's engine figure it is explicitly **not** a dominance proof — at pool 64 / subset 10 the declared space is ~1.5e11 and no budget covers it. It is derived from the opposite constraint: the node budget must stay small enough that **the safety valve never fires**, because the moment the valve can fire the machine-dependence returns through the back door.

  **A latent bug in a guard, surfaced by a correct value.** `adr-060-doc-sweep-guard`'s pattern `/200,000|200k nodes/` matched **inside** the new `5,200,000`, so a correct ceiling tripped a stale-figure check. The tempting fix — pick a rounder number — would have left the guard broken for the next person; the tempting second fix — delete the pattern — is how a stale-figure check dies quietly. Fixed with a boundary, plus a test asserting all three patterns still **fire** on the figures they exist to catch.

  **Two scoping decisions, deliberately opposite, and the asymmetry is the point.** Every transaction/exception lookup is scoped to one `run_id` — an agent investigating run A must not be able to *retrieve*, and therefore cite, a record from run B, and the WHERE clause is the cheapest place to make that impossible. `find_similar_exceptions` is deliberately **not** run-scoped: a human resolution recorded on a previous run is exactly the institutional memory the tool exists to surface, and confining it to the current run would return only what the agent can already see. Widening the READ does not widen what a verdict may CLAIM, because citations are gated by A3 over tool results.

  **`returnedIds` has to be complete AND minimal, and both directions are failures.** It is A3's grounding allow-list. An id shown to the model but not recorded makes a *truthful* citation look invented and inflates the grounding-failure count that §7 reads as "the prompt needs work". An id recorded but not returned launders a hallucination into an accepted verdict, and A3 cannot tell. Every tool derives it from the payload it is about to return, never from its own arguments — an argument is what the model *asked for*, not what it was *shown* — and a test asserts every returned id actually appears in the payload JSON.

  **Verified:** 633 tests in `apps/api` (from 593) and 235 at root against a real Postgres 17; typecheck and build clean. `score_pair` is asserted to agree with `scorePair` **component for component across 144 real pairs** — if it ever diverges, the agent is citing a number the engine never computed. A full holdout re-score is **byte-identical** to the U11 one: precision 1.0000, FP 0, recall 0.6075, match rate 65.22%, 612 audit entries, exit 0.

  **Also noticed, and now filed as a P1 — [#52](https://github.com/flare19/payment-reconciliation-agent-platform/issues/52).** A `GEMINI_API_KEY` is now present in `apps/api/.env`, so `/api/health` reports `llmConfigured: true` where it reported `false` earlier today. No live call has been made from this session, and every test still exercises the template path because they call `executeRun` without explain deps — but the live path is now REACHABLE and has never been run.

  What that makes urgent is a gap I flagged during U11 and deliberately did not fix: **S13 has no grounding check.** Phase A treats a hallucinated specific as a build blocker (ADR-053). S13 — the layer whose prose a panelist actually reads — relies entirely on a prompt instruction (§10.4 rule 2, "never invent amounts"). The inference is unusually clean and that is what makes it worth a P1 rather than a P2: ADR-018's signature is bucketed by construction and a test already asserts no long digit run reaches the prompt, **so any rupee figure, date or reference id in S13's output is *necessarily* fabricated.** There is no legitimate way for one to be there. `parseResponse` validates shape only; the text is written straight to `explanation_text` and into the exception list, and because `explanation_cache` is run-independent, one fabricated figure is then served to every later run sharing that signature with a `hit_count` that makes it look well-established. A handful of regexes and a template fallback closes it.

- **2026-08-31** — **Day 12, the first keyed run: S13's live path executed for the first time, and it exposed a bound I had picked without measuring.**

  A real `GEMINI_API_KEY` went in, so the model path that had existed since U11 — unit-tested against a fake client, never once executed — finally ran. **It half-worked, and the half that failed was mine.**

  **What happened.** 21 signatures batch into 10 / 10 / 1. Two of the three batches came back `"This operation was aborted"` — my own `AbortSignal.timeout`. The run completed correctly with **20 of 21 signatures served from templates**, `explanation_source` reading `template` for 211 of 212 exceptions, and every engine number untouched. The degradation worked exactly as ADR-017 requires; what it was degrading *from* was a working API.

  **`REQUEST_TIMEOUT_MS` was 20,000, and there was nothing behind that number.** I wrote it as a demo-safety bound — "a hung connection must not stall a run in front of a panel" — and picked 20s because it sounded obviously sufficient. Measured afterwards on `gemini-3.5-flash`, full 10-signature batches: **9.8s / 10.7s / 9.7s / 9.5s** at ~900 output tokens each, and 9.2s for a 2-signature batch. Three fired back-to-back showed no throttling, so the median is ~10s and the two aborts were ordinary latency variance against a bound sitting only **2×** above the median.

  **The lesson is not "20s was too small". It is that a timeout is a threshold on a distribution, and I had measured neither.** Every other bound in this repo is derived — ADR-063's node budget is a proof about the declared space, ADR-085's ceiling is derived from the safety valve it must not trip. This one was a guess wearing the same clothes. Raised to 60,000 with the measurements written into the comment, and the argument stated as a **ratio** (~6× the median) rather than a number, because the number is worthless to the next person and the ratio is not. 60s is also not a new magnitude here — `AGENT_DEFAULTS` already bounds an investigation at exactly 60,000 ms.

  **What a timeout does when it is too tight is the worst thing a timeout can do:** it converts a working response into a silent fallback. Nothing failed. The run completed, every exception had prose, the score was unchanged, and the only evidence was `signaturesTemplated: 20` in a metrics object nobody had a reason to read. **The honest reporting that U11 built is the only reason this was visible at all** — `llmCost.failures` carried two `transport` entries with their detail string, and `explanation_source` distinguished `template` from `llm`. A design that had just written the text and moved on would have shipped this to a panel.

  **After the fix, re-run against the real key:**

  ```
  21/21 signatures GENERATED · 212 exceptions explanation_source = 'llm' · 0 templates
  3 API calls · 2,744 tokens in / 1,745 out · failures []
  audit: 21 EXPLANATION_GENERATED   (one per SIGNATURE, as designed)
  engine: 284 matches · 212 exceptions · 612 audit · 65.22% · 570 matched
          tierAttribution {exact 203, fuzzy 277, batch 25, implied 242}  — UNCHANGED
  score report BYTE-IDENTICAL to the keyless run
  ```

  > **That last line is the point of the whole architecture.** A real language model wrote all 212 explanations and the measured accuracy report did not move by a single character. ADR-017 is no longer a claim about where the LLM sits in the pipeline; it is a diffed artifact.

  **ADR-018's economy, demonstrated live for the first time.** A second identical run made **zero API calls**: 21/21 signatures served from `explanation_cache`, all 212 exceptions `explanation_source = 'llm_cache'`, 21 `EXPLANATION_CACHE_HIT` entries, and the run finished in **~6s instead of ~39s**. "Re-running the full batch is free" stops being an argument and becomes a measurement — which matters because the track disqualifies cherry-picking, and the whole reason to make re-runs free was to remove any incentive not to do them.

  **On [#52](https://github.com/flare19/payment-reconciliation-agent-platform/issues/52), one real data point and no more than that.** Scanning all 21 generated explanations for rupee amounts, reference ids and dates found **zero**. The model rendered bucket labels faithfully into prose — `3_to_10pct` became "by three to ten percent" — which is exactly the behaviour the prompt asks for. That is encouraging and it is **not** a reason to close the issue: one clean sample from one model at one temperature is not a guarantee, and the whole argument for #52 is that the check should not depend on the model's good behaviour. Recorded so the next session knows the current state is "no observed fabrication", not "verified safe".

- **2026-08-31** — **Day 12, the first live investigation. The loop works; three things it exposed did not.** Branch `day12-explain-layer`.

  The Analyst ran against a real model for the first time. What it produced is worth stating before what broke, because the tool use is the part I had least evidence for: given an `UNSPLITTABLE_BATCH`, the agent chose `get_exception` → the engine's own audit trail (twice) → `get_transaction` → `find_by_anchor` twice → **`rerun_subset_search`** → `find_similar_exceptions` → `search_transactions`. That is §5's self-correction pattern — establish which claim the engine is making, then widen the search it admitted running out of room on — and nothing prompted it step by step. **The tool registry is usable by a model, which is not something 33 passing tests could tell me.**

  **1. `gemini-3.7-flash` cannot satisfy the spec that sits beside it (ADR-086).** The first attempt aborted on its first turn against my 90 s client timeout. Isolating it — a bare call, no tools, no history, no schema — reproduced the hang, which ruled out my code and left the model name. Measured, on `Reply with the single word: ok`: **`gemini-3.6-flash` 2.4 s, `gemini-3.7-flash` 53 s**, and 63 s with thinking disabled, so it is capacity rather than reasoning depth. `agent-design.md` §8 bounds an **entire investigation** at 60 s. One turn on 3.7 exceeds the budget for the whole investigation; ten steps would be nine minutes. ADR-080 chose 3.7 from Google's description of it — *"built for complex coding, agentic workflows"* — which is a job description, not a measurement, and neither document noticed the contradiction because neither number existed.

  **2. `thought_signature` — a provider-neutral `{id, name, args}` is not enough to replay a tool call.** On 3.6 the loop reached step 2 and died with a 400: *"Function call is missing a thought_signature in functionCall parts."* Gemini 3.x attaches an opaque signature to each `functionCall` and rejects the next request if the replayed history has lost it. My `AgentToolCall` carried only the three obvious fields, so it was dropped on every replay. **Every multi-step investigation was structurally impossible and every test passed**, because a fake client has no signatures to lose. Fixed with an opaque `providerSignature` the loop carries and never inspects — and this is not a Gemini quirk: Anthropic requires thinking blocks passed back unchanged for the same reason, so the field survives the swap. With it, the same investigation went from 1 step to 9.

  **3. The agent could not see its own budget, so it never stopped.** With the signature fixed it used all ten steps and never wrote a verdict — investigating until the bound cut it off, at which point the verdict becomes `INSUFFICIENT_EVIDENCE` regardless of what it had found. Nine steps of good work, discarded by a bound the model had no way to know existed. Each turn now carries a countdown and the last one forbids further tool calls. Injected as a separate turn rather than edited into the system prompt, so the cacheable prefix stays byte-identical; a test asserts exactly one countdown is present at any time, because nine stale ones each contradicting the last would be worse than none.

  > **THE SAME MISTAKE, THREE TIMES IN ONE DAY, AND I DID NOT SEE THE PATTERN UNTIL THE THIRD.** The 20 s explain timeout, the ceiling-charging triage budget, and `gemini-3.7-flash` were all plausible numbers with nothing measured behind them. Every *engine* bound in this repo is derived — ADR-063's node budget is a proof about the declared space, ADR-085's ceiling is derived from the valve it must not trip — and every bound around the *model* was a guess wearing the same clothes. The asymmetry was invisible because the engine's numbers are scored daily and the model's were not scored at all. **The rule going into the Anthropic swap: a per-turn latency and cost figure is measured against §8's bound before a model is adopted, never read off a description.**

  **Then a `429` ended live iteration** mid-diagnosis. I called it a daily quota; the error text did not actually say so and I had no evidence — see the correction in the next entry, which has the real number. So the budget-pacing fix in (3) is **unit-tested and has never been seen working against a real model** — recorded here rather than implied, because "fixed" and "verified" are different claims and this file exists to keep them apart. The convergence behaviour is the first thing to re-check when quota resets.

  **Where that leaves the baseline.** The Analyst is not yet finished per spec: no investigation has produced a schema-valid verdict, CORROBORATE mode is unbuilt, and the Analyst has never been scored against the answer key. The plan is unchanged and was the right one — finish on the cheap tier, branch, then swap — but the baseline it is meant to produce does not exist yet.

- **2026-08-31** — **Day 12, continued: THE ANALYST PRODUCED ITS FIRST VALID VERDICT.** And getting there cost three more corrections, one of them in a module that had been green since Day 4.

  **First, a correction to the entry above.** I wrote "the free tier's daily quota ran out". The `429` text said only *"You exceeded your current quota"*; I inferred "daily" and stated it as fact. Tejas pushed back — RPM and RPD are different, and if it were RPM we could retry immediately. He was right to push and the retry worked. The real figure, from a later error that carried the detail:

  ```
  quotaId:    GenerateRequestsPerDayPerProjectPerModel-FreeTier
  quotaValue: 20
  model:      gemini-3.6-flash
  ```

  **20 requests per day, per model.** So it *was* daily — but I had asserted it without evidence and happened to be right, which is not the same as having been right. ADR-080 deliberately refused to write an RPD number into the docs because Google's page defers to AI Studio and third-party summaries disagree; the honest move was to measure, and measuring took one request.

  **What that number does to the plan.** One investigation costs 3–10 requests, so 20/day/model is two to four investigations — nowhere near enough to iterate a prompt on. The quota is **per model**, though, and the newer models are the constrained ones: `gemini-2.5-flash` answers a tool-calling prompt in **1.5 s** and has the older generous tier. So loop development moved there. That preserves Tejas's sequencing exactly — iterate on a cheap tier, then swap — it just is not the model ADR-086 named.

  **The gate caught a real hallucination, from a real model, on its first live encounter.** After the pacing fix, `gemini-2.5-flash` jumped straight to a verdict on step 1 and wrote a reasoning step claiming it had called `rerun_subset_search`. It had not. A3 rejected it: *"reasoning step 1 cites tool rerun_subset_search, which was never called"*, and the verdict was downgraded to `INSUFFICIENT_EVIDENCE`. **ADR-050 is no longer a design argument; it is a thing that has now happened and been caught.**

  **My pacing fix had over-corrected, and the second failure was worse than the first.** The countdown urged conclusion from step one, so the model went from *never concluding* to *concluding before it had looked* — and filled the gap by inventing a step. Being cut off loses work; answering early invents it, and only one of those is dishonest. The countdown's tone now tracks the budget: retrieve first, keep going, wrap up, final step. A test pins all four phases.

  **Then a defect in the grounding gate itself, green since Day 4.** `checkSchema` treats an ABSENT `proposedAction` as equivalent to a null one — correctly, because a model omitting an optional-looking field is ordinary. `checkConstraints` guarded only `=== null` and then read `action.type`, so an omitted field **threw**. That is much worse than a rejection: `validateVerdict` is documented to throw only for a *caller* bug, so the loop does not catch it, and **2 of 17 investigations were recorded as failed instead of downgraded**. Fixed to `== null` in both places, with tests in both directions — absent must be handled, and absent must not become a free pass on a `RESOLUTION_PROPOSED`.

  **The first valid verdict, in full:**

  ```
  UNSPLITTABLE_BATCH, engine reported searchExhausted: true
  -> get_exception  ->  CONFIRMED_UNRESOLVABLE, confidence high, grounded, 1 citation
  ```
  > *"The engine's batch search was 'EXHAUSTIVE' and searchExhausted is true. This means the engine proved no combination works within its declared bounds, rather than running out of search room. Therefore, rerunning the subset search with wider bounds is not applicable."*

  That is the right answer **and the right amount of work**. §5 says the agent's job on a dead end is to decide whether the dead end is a property of the data or of the engine's bounds; it decided *data*, from the engine's own evidence, and correctly declined to spend a subset search. The prompt renders `searchExhausted` and `searchBoundExceeded` as different claims precisely so this distinction is available, and the model used it.

  > **A finding about the DATASET that the demo needs to know.** `runs.metrics` reports `batchSearchExhausted: 4, batchSearchBoundExceeded: 0` — every batch search on the holdout terminates with a proof. So **§5's flagship self-correction story has no instance in this dataset**: there is no exception where widening the bounds could find anything, and `rerun_subset_search` can only ever confirm what the engine already proved. The tool works and the agent reaches for it unprompted, but the demo cannot show it *recovering* a batch unless the generator is given a case where the pool cap binds. Recorded now rather than discovered while recording the video.

  **Status.** One valid grounded verdict end to end. A 17-investigation sample was mostly `429` noise (15 of 17 transport failures at ~20 requests/min) and is **not** a baseline — it measured Google's rate limiter, not the Analyst. CORROBORATE is still unbuilt and the Analyst has still never been scored against the answer key.
