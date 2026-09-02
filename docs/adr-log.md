# ADR Log

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4

One file, short dated entries, newest section at the bottom. **Not** a folder of per-decision files — ARCHITECTURE §7 explicitly rejects that.

**Format:** `ADR-NNN · Title` → Decision / Because / Rejected / Revisit-if. Keep entries to a handful of lines. This exists to answer panel questions about tradeoffs, not to be a design document — the design lives in [schema.md](./schema.md).

**Rule:** if a later session changes something decided here, it appends a new ADR that supersedes the old one. Entries are never edited or deleted. Same discipline as `audit_log`.

---

## 2026-08-23 — Day 1: pre-lock decisions

### ADR-001 · Node.js / TypeScript over Go
**Decision:** Single language, Node/TS, across backend and frontend.
**Because:** The track's bar rewards a judgeable artifact, which means shipping a UI, which means JS/TS on the frontend regardless of backend language — so Go wouldn't avoid this stack, it would add a second one on top of it. Throughput at 200–500 records is a *reporting metric*, not an engineering problem, so Go's concurrency advantage solves a bottleneck that doesn't exist here. Fuzzy-matching, date-window and CSV parsing libraries are deeper in Node. The Anthropic TypeScript SDK is first-class; the Go SDK is thinner. One language means one `CLAUDE.md`, one context for AI-assisted execution, and no API-contract drift to debug under a 13-day clock.
**Rejected:** Go backend + TS frontend.
**Revisit if:** never, within this hackathon. The decision is scope-locked.

### ADR-002 · PostgreSQL, and no Redis
**Decision:** PostgreSQL as the only datastore.
**Because:** Three normalized sources plus matches, exceptions and an audit log is a relational problem with real transactional requirements. Nothing in this system needs a cache: the working set is a few hundred records, and the expensive operation (the LLM explain layer) is cached *in Postgres* by discrepancy signature, which is a durable cache, not a hot one. Adding Redis is infrastructure Razorpay isn't asking for and one more thing to deploy.
**Rejected:** Redis for caching or job queueing; SQLite (loses `JSONB`, GIN indexes, and the trigger-based audit immutability).
**Revisit if:** never within scope.

### ADR-003 · No CQRS, no hexagonal architecture
**Decision:** Pragmatic layered structure — routes → services → repositories. Readable over impressive.
**Because:** Those patterns earn their ceremony on long-lived multi-team systems. On a 13-day solo build they convert every feature into four files, and the panel is judging match rate, exception honesty and a working dashboard — not folder topology.
**Rejected:** CQRS, hexagonal/ports-and-adapters, a full DDD layering.
**Revisit if:** never within scope. Explicitly listed as out-of-scope in ARCHITECTURE §5.

### ADR-004 · Tiered matching engine
**Decision:** Exact → fuzzy → exception, as three ordered tiers rather than one scoring pass with thresholds.
**Because:** The tiers are the audit story. "This matched exactly on payment ID" and "this matched at 0.87 confidence" are different claims to a finance reviewer, and collapsing them into one score erases that distinction. Ordered tiers also mean the cheapest, strongest check runs first — most records never reach the expensive candidate search.
**Rejected:** A single unified scorer with cutoffs.
**Revisit if:** never; extended by ADR-012.

### ADR-005 · Kubernetes deferred to a separate, later, non-hackathon project
**Decision:** No Kubernetes, no container orchestration, no service mesh, no Helm — not in this build, at any point in the 13 days.
**Because:** K8s is worth learning and worth a dedicated project; it is worth zero rubric points here. The track is judged on match rate, measured accuracy, an honest exception list and a UI a panelist can use. Every hour spent on orchestration is an hour not spent on the exception classifier. This is a platform-deploy build (see [deployment.md](./deployment.md)).
**Rejected:** K8s, Docker Compose as the deploy target, ECS/Fargate.
**Revisit if:** never here. Deliberately parked as a **future standalone learning project**, so the interest in it has a home that isn't this repo.

---

## 2026-08-24 — Day 2: architecture decisions

### ADR-006 · Money stored as integer paise
**Decision:** `BIGINT` minor units everywhere. No floats, no `NUMERIC` arithmetic in application code.
**Because:** Reconciliation is money-equality-comparison. Binary floating point makes `12.30 !== 12.30` a genuine failure mode, and it would surface as a mysterious wrong match rate — the worst possible bug in a project whose thesis is measured accuracy. Integer paise makes every comparison exact and every tolerance an integer band.
**Rejected:** `NUMERIC(14,2)` (correct, but forces a decimal library in JS anyway), floats (unsafe).
**Revisit if:** multi-currency enters scope, which it won't.

### ADR-007 · `transactions` holds one row per SOURCE ROW, not per economic event
**Decision:** Ingestion is lossless and opinion-free; one row in, one row stored, with `raw_payload` retained verbatim.
**Because:** Normalizing into economic events at ingest means the *parser* has already made the matching decision, which destroys the audit trail — you could no longer show a panelist the three raw rows and the reason the engine believes they are one payment. All judgement belongs in the matching engine, where it can be logged.
**Rejected:** Event-first normalization at ingest.
**Revisit if:** never — this is load-bearing for the audit trail.

### ADR-008 · Banded amount tolerance: 0.5%, floor ₹1, cap ₹100
**Decision:** `clamp(0.5% × amount, ₹1.00, ₹100.00)`.
**Because:** 0.5% sits deliberately *below* the real gateway fee band (≈2.36–2.95%), because fee differences are handled by an explicit net-amount rule, not absorbed by a loose tolerance — a 3% tolerance would silently match records whose amounts genuinely disagree. The ₹1 floor exists because 0.5% of a ₹50 payment is ₹0.25, tighter than ordinary GST rounding drift. The ₹100 cap exists because 0.5% of ₹5,00,000 is ₹2,500, loose enough to swallow a real partial-capture error — absolute rupee risk dominates above ~₹20,000.
**Rejected:** Flat percentage (breaks at both ends of the range), flat rupee amount (breaks proportionality in the middle).
**Revisit if:** the generated dataset's amount distribution shifts materially away from a realistic Indian payments batch.

### ADR-009 · Asymmetric, per-method date windows
**Decision:** gateway→bank `[-1,+3]` for card/netbanking, `[-1,+2]` for UPI/wallet; gateway→ledger `[-1,+1]`; bank→ledger `[-2,+4]`.
**Because:** Settlement flows forward in time, so a symmetric window is wrong in both directions at once. The `-1` on every window is not slack — it is required by real IST/UTC midnight drift, and without it every near-midnight payment becomes a false exception. Windows are not widened past the real settlement SLA because at 200–500 records a wide window makes same-amount collisions common, which converts clean matches into `AMBIGUOUS_MATCH` — precision traded for nothing.
**Rejected:** A single symmetric `±3` window.
**Revisit if:** the generator's settlement-lag distribution changes.

### ADR-010 · Confidence thresholds 0.85 / 0.65, with a hard ambiguity guard at 0.05
**Decision:** ≥0.85 auto-confirm, 0.65–0.849 human review, <0.65 exception. If the top two candidates are both ≥0.65 and within 0.05 of each other, the engine **refuses to choose** and raises `AMBIGUOUS_MATCH`.
**Because:** The guard matters more than the thresholds. Auto-picking a marginal winner is exactly how a reconciliation engine reports a great match rate on quietly wrong books. Refusing to guess costs a few points of match rate and buys the honesty the track is explicitly grading. A contradicted anchor (both sides have a strong reference and they disagree) is disqualifying rather than merely unhelpful, for the same reason.
**Rejected:** Always picking the top candidate; a single threshold with no review band.
**Revisit if:** the review band produces an unreviewable queue size (>15% of records) on the real dataset.

### ADR-011 · Eight exception categories, not five
**Decision:** ARCHITECTURE's five, plus `MISSING_IN_GATEWAY`, `AMBIGUOUS_MATCH`, `UNSPLITTABLE_BATCH`.
**Because:** `MISSING_IN_GATEWAY` is the symmetric half of a bucket already in scope — reconciliation runs both directions and an orphan bank credit must land somewhere truthful. `AMBIGUOUS_MATCH` is required by ADR-010's guard: a refusal to choose needs a category, and calling it "missing" when two candidates were found would be false. `UNSPLITTABLE_BATCH` is required by the net-settlement defect class and is one of the designed genuinely-unresolvable cases.
**Rejected:** Forcing these into the existing five (produces data that misrepresents what the engine saw).
**Revisit if:** you want to trim — cut `UNSPLITTABLE_BATCH` first (fold into `AMBIGUOUS_MATCH`); the other two are structurally load-bearing.

### ADR-012 · `learned_aliases` sits at Tier 1.5, between exact and fuzzy
**Decision:** Alias resolution is a normalization step that substitutes values and re-runs the *identical* Tier 1 predicate. Not before Tier 1, not folded into Tier 2.
**Because:** Not before Tier 1, because an exact match on unmodified source data is the strongest evidence available and needs no assumption — running substitution first would make every audit entry read "matched on transformed values," including for records that never needed transforming. Not inside Tier 2, because a human-confirmed equivalence is a fact asserted by a person, categorically different from a trigram similarity of 0.82; expressing it as "+0.10 on the counterparty component" would be too weak to carry a genuine match and would misreport an alias-driven match as a fuzzy inference. As a normalization step it adds no new comparison logic, so its correctness follows from Tier 1's — and an alias can widen the *inputs* to a test without ever loosening the *test*.
**Rejected:** Pre-Tier-1 substitution; an alias bonus inside the fuzzy scorer.
**Revisit if:** never for v1.

### ADR-013 · Alias conflicts: supersede-with-penalty
**Decision:** A conflicting human assertion supersedes the old alias (which is retained, marked `superseded`), and the new one is barred from Tier 1.5 until it reaches two independent confirmations. One-hop resolution only; no alias chaining.
**Because:** First-write-wins makes a mistaken early approval permanent, the worst property a learning loop can have. Pure last-write-wins lets one misclick silently poison auto-resolution across every future run. Supersede-with-penalty keeps the correctability of last-write-wins while making the first *contested* application fall back to human review — the cost of a mistake becomes one extra review, not a permanently wrong book. No chaining, because `A→B→C` silently merges merchant clusters no human ever approved together and makes "who decided these are the same?" unanswerable; one hop is always attributable to exactly one approval.
**Rejected:** First-write-wins; silent overwrite; a voting quorum (no quorum exists with one reviewer).
**Revisit if:** a real multi-reviewer workflow appears, which it won't — auth is out of scope.

### ADR-014 · Alias writes reuse `audit_log`; `subject_type`/`subject_id` added
**Decision:** No separate alias audit table. New `event_type` values plus a polymorphic `subject_type`/`subject_id` pair, with `transaction_id` retained as a separate nullable denormalized column.
**Because:** The panel-facing question is "show me everything that happened," and a second log table turns that into a `UNION` across two schemas ordered by two clocks — the `sequence_no` ordering guarantee only holds inside one table. The existing audit shape already carries actor, timestamp, before-state, after-state and reason, which is exactly what an alias write needs; a second table would be the same columns under a different name. The one genuine gap — audit entries implicitly assumed a parent transaction — is closed by the subject pair, which is a far smaller change than a second table with its own immutability triggers. Keeping `transaction_id` denormalized keeps the per-transaction trail a single indexed lookup instead of a polymorphic scan.
**Rejected:** `alias_audit_log` table; overloading `transaction_id` to hold alias IDs.
**Revisit if:** never.

### ADR-015 · `audit_log` immutability enforced by trigger
**Decision:** `BEFORE UPDATE OR DELETE` trigger that raises.
**Because:** ARCHITECTURE §6 says "logged immutably." A code convention is not immutability; a database constraint is. It costs about six lines and it is a ten-second answer to a panel question about tamper-resistance.
**Rejected:** Convention-only; a separate append-only service.
**Revisit if:** never.

### ADR-016 · Matches are groups (`matches` + `match_members`), not pairs
**Decision:** A match row is a group; membership is a join table with a `role` and an `is_anchor` flag.
**Because:** Three nullable FKs (`gateway_txn_id`/`bank_txn_id`/`ledger_txn_id`) looks simpler and breaks on the first net-settlement batch where five gateway payments map to one bank credit. A membership table handles 1:1:1, 1:1:0 and N:1:N with one shape and one set of queries. Pairwise matching was rejected outright — it needs transitive closure to answer "is this reconciled?"
**Rejected:** Three nullable FK columns; pairwise match rows.
**Revisit if:** never.

### ADR-017 · The LLM never makes a matching or classification decision
**Decision:** The explain layer runs *after* exceptions are committed. It receives a finished decision and writes prose about it. Match/no-match, category and severity are all deterministic rule outputs.
**Because:** This is what makes a measured accuracy number mean anything — accuracy is a property of the rules, and the rules are deterministic and reproducible from `config_snapshot`. If the model influenced matching, the same dataset could produce different numbers on two runs and the track's "measured accuracy" bar would be unmeetable. It also means the run completes with template explanations when the API is down: the LLM is never on the critical path.
**Rejected:** LLM-assisted matching; LLM-assigned categories; LLM-proposed aliases in v1.
**Revisit if:** never for v1. LLM alias *suggestion* is flagged as scope creep in `schema.md` §12.

### ADR-018 · Explanations cached by discrepancy signature, not per record
**Decision:** Hash the *structural shape* of a discrepancy (category + bucketed deltas + sources present + anchor strength + alias involvement + candidate count), never the specifics. Batch up to 10 signatures per call, hard cap 8 calls per run.
**Because:** One call per exception is ~75 calls per run and re-pays on every re-run and every demo rehearsal — which creates a quiet incentive *not* to re-run the full batch, directly against the track's "never cherry-pick" bar. Signatures collapse ~75 exceptions to ~15–30 distinct shapes and approach a 100% hit rate on repeat runs, making cost O(distinct discrepancy shapes) rather than O(exceptions). The per-run call cap means a runaway loop cannot produce a surprise bill.
**Rejected:** Per-exception calls; a time-based cache TTL (a deterministic input shouldn't expire on a clock — invalidation is by `prompt_version` instead).
**Revisit if:** signature collisions produce explanations too generic to be useful; the fix is adding a component to the signature and bumping `prompt_version`.

### ADR-019 · Sonnet at runtime; Opus never called by the application
**Decision:** `claude-sonnet-5`, `temperature: 0`, static cached system prefix.
**Because:** Matches ARCHITECTURE §3's routing policy exactly — Sonnet is the default engine, and bounded prose generation from a structured input is precisely its job. Opus is for planning and the frontend's creative pass, not for a loop that runs on every batch. Temperature 0 keeps explanations stable across runs, so a re-run doesn't produce a subtly different demo.
**Rejected:** Opus at runtime; a local model.
**Revisit if:** never.

### ADR-020 · Cold-start and warm match rates are always reported as a pair
**Decision:** Every run records `matchRatePct` and `coldStart.matchRatePct` (aliases disabled). The dashboard shows both whenever any human correction exists. `falsePositiveMatches` is displayed next to the match rate, never in a separate tab.
**Because:** A match rate that quietly includes the benefit of prior human corrections is exactly the kind of unverified number the track's bar rejects. And an 82% match rate with 5 wrong matches is worse than a 78% rate with 0 — a single headline percentage hides that, so the pairing is enforced at the API-contract level, not left to UI discretion.
**Rejected:** A single headline match rate.
**Revisit if:** never — this is the project's central honesty claim.

### ADR-021 · Ground truth lives in files, never in the application database
**Decision:** The answer key is written to `data/truth/*.json`. No engine module reads it. Scoring is a separate script that joins engine output to the key after the fact.
**Because:** If the truth key were a table in the same database, "does any code path read it?" becomes a thing you have to *audit* rather than something structurally impossible. Keeping it outside the app's schema makes leak-freedom obvious to a reader in about five seconds — which is worth more than any convenience the alternative buys.
**Rejected:** A `ground_truth` table; a `truth_event_id` column on `transactions`.
**Revisit if:** never.

### ADR-022 · Raw SQL over `pg`, with numbered migration files — no ORM
**Decision:** `pg` driver, hand-written SQL, `migrations/NNN_name.sql`, hand-written row types in TypeScript.
**Because:** The schema is small, fixed by Day 2 and unlikely to churn. The queries that matter (candidate search, audit trail, faceted exception counts) are the ones an ORM obscures and that get hand-written anyway. Avoiding an ORM removes a codegen step, a migration DSL and a class of "why did it emit that query" debugging from a 13-day clock.
**Rejected:** Prisma (codegen + migration ceremony), Drizzle (lighter, but still a layer between the SQL in `schema.md` and the SQL that runs), TypeORM.
**Revisit if:** hand-mapping row types becomes a real error source by Day 5.

### ADR-023 · Express + TypeScript for the API
**Decision:** Express 5 on Node 22, TypeScript throughout.
**Because:** Deliberately the least interesting choice available. Widest documentation and training-data coverage, so AI-assisted sessions produce idiomatic code with the fewest surprises. There is no performance requirement here that would justify anything else — throughput at 300 records is a metric, not a constraint (ADR-001).
**Rejected:** Fastify (faster; irrelevant at this scale), NestJS (contradicts ADR-003), Hono.
**Revisit if:** never.

### ADR-024 · Runs are asynchronous with polling; no WebSockets or SSE
**Decision:** `POST /api/runs` returns `202`; the frontend polls run status every 750 ms.
**Because:** A 300-record run finishes in seconds, so the whole polling loop is a handful of requests. A realtime transport is infrastructure the demo doesn't need and one more component that can fail live in front of a panel. Async rather than synchronous because a synchronous request would still be blocking through the LLM explain phase, and a browser timeout mid-demo is a worse failure than a poll loop.
**Rejected:** Synchronous `POST`; WebSockets; SSE.
**Revisit if:** never.

### ADR-025 · Match approval and alias-teaching succeed independently
**Decision:** If a proposed alias conflicts with an existing active one, the API approves the match and returns `409 ALIAS_CONFLICT_UNCONFIRMED` for the alias only; the client re-sends with `confirmConflict: true` to trigger ADR-013's supersession flow.
**Because:** A reviewer's judgement about *this specific match* should never be discarded because of a disagreement about a *general rule*. Coupling them would mean a conflicting alias silently blocks a correct approval, and the reviewer would have no way to record what they actually know.
**Rejected:** All-or-nothing transactional approval; silently applying the conflicting alias.
**Revisit if:** never.

### ADR-026 · Deploy: Vercel (frontend) + Railway (API + Postgres)
**Decision:** See [deployment.md](./deployment.md). Two managed platforms, no containers authored by us.
**Because:** Railway gives a Node service and a managed Postgres in one project with one internal `DATABASE_URL` and no networking to configure; Vercel gives the frontend a URL in one push. Together that's a public demo URL early rather than on the final day, which ARCHITECTURE §7.4 explicitly calls out as a strong signal. *(Day numbers in this entry predate the Day-4 count correction; see ARCHITECTURE §8 for the authoritative table.)* Consistent with ADR-005.
**Rejected:** Render (equivalent; Railway chosen for the tighter DB+service pairing — noted as the fallback), Fly.io (more control, more config), any self-managed VPS.
**Revisit if:** Railway's free-tier limits bite before Sept 5; fall back to Render with no architectural change.

### ADR-027 · Two dataset seeds: a dev seed and a held-out demo seed
**Decision:** Build and tune against `DEV_SEED`. Generate a fresh `HOLDOUT_SEED` dataset for the final reported numbers and the pitch video, and do not tune against it.
**Because:** Tuning tolerances against the same dataset used for reporting is overfitting, and the reported accuracy stops being a measurement. A held-out seed makes the final number an actual out-of-sample result, which is a direct and checkable answer to "one cherry-picked match proves nothing."
**Rejected:** A single seed.
**Revisit if:** never — this is the credibility of the headline number.

---

## 2026-08-26 — Day 3, first pass: pre-build design review

Twenty entries from a principal-engineer review of the Day 2 architecture, conducted before any code was written. Three of them (ADR-028, ADR-029, ADR-030) correct flaws that would have made documented exception categories structurally unreachable. Nothing here reduces scope.

### ADR-028 · Tier 1 uses the real per-pair date window and the real amount basis
**Decision:** The Tier 1 exact predicate uses the §5.2 window for the source pair being compared (not a fixed `[-1,+1]`) and the §4.3 comparison basis (not raw "amount equal").
**Because:** `schema.md` §6.2 described Tier 1 as "strong anchor + amount equal + date within `[-1,+1]`", which contradicted §5.2's `[-1,+3]` gateway→bank window. A perfectly-anchored card settlement at T+2 — the most common case in the dataset — would fail Tier 1 and be re-decided by the fuzzy scorer, so the engine's strongest evidence class would report as fuzzy inference and the audit trail would say "matched at 0.87 confidence" about a byte-exact reference identity. "Amount equal" was wrong for the same pair in a second way: gateway gross is never equal to a bank credit net of a 2.36–2.95 % fee. Tier 1 means *identity is certain and everything corroborates*, not *the numbers are byte-identical*.
**Rejected:** Widening every window to `[-1,+3]` (breaks the ledger pair); keeping Tier 1 narrow and accepting fuzzy attribution (destroys the tier story, which is the audit story per ADR-004).
**Revisit if:** never — this was a defect, not a preference.

### ADR-029 · Identity-established short-circuit before fuzzy scoring
**Decision:** New stage S8. When strong anchors agree on both sides, identity is *established* and the pair is never scored. It is resolved deterministically: amount outside tolerance → `AMOUNT_MISMATCH`; date outside window → `TIMING_DRIFT`; both → `AMOUNT_MISMATCH` primary with `TIMING_DRIFT` secondary.
**Because:** Under the Day 2 design, a same-`payment_id` pair with a ₹412 discrepancy scored `0.45+0.00+0.15+0.10 = 0.70`, landing in the review band as a *proposed match* and never reaching classification — so `AMOUNT_MISMATCH` could not fire. The mirror case was worse: same anchor, correct amount, nine days late scored `0.45+0.30+0.00+0.10 = 0.85` and **auto-confirmed**, silently matching a settlement three times past its SLA, so `TIMING_DRIFT` could not fire either. Two of the eight documented categories were structurally unreachable. The root cause is a category error — a similarity score answers "are these the same thing?", and when an anchor already proves they are, blending that proof with unrelated evidence lets a date disagreement cancel out an identity proof.
**Rejected:** Raising the amount component's floor (masks the problem); classifying from the review queue (makes a human the classifier); a "penalty" term (still a blend).
**Revisit if:** never.

### ADR-030 · Tier 2 weights recalibrated; no-anchor pairs cannot auto-confirm
**Decision:** anchor `0.30` / amount `0.35` / date `0.20` / counterparty `0.15`, replacing `0.45/0.30/0.15/0.10`. Anchor earns `0.30` strong↔weak, `0.24` near-anchor, `0.20` weak↔weak, `0.00` with none, and a contradiction discards the candidate.
**Because:** With ADR-029 removing strong-anchor pairs from Tier 2's domain, the old weights capped a weak-anchor pair at `0.25+0.30+0.15+0.10 = 0.80`, below the `0.85` auto-confirm line — **nothing at Tier 2 could ever auto-confirm**, so every fuzzy match would have queued for human review and the cold-run match rate would have collapsed for reasons unrelated to the data. The new weights make a perfect weak↔weak pair reach `0.90` while leaving a **no-anchor** pair capped at `0.70`: a pair with no shared reference of any kind can never be auto-confirmed at any amount, on any date, with any name similarity. That guarantee falls out of the arithmetic rather than out of a tunable threshold, and amount-plus-date agreement is a coincidence generator where a reference number is evidence.
**Rejected:** Lowering the auto-confirm threshold to 0.80 (would have made no-anchor auto-confirmation reachable — the exact wrong outcome); leaving weights and accepting a 100 % review queue.
**Revisit if:** the review band exceeds 15 % of records on the dev seed (the ADR-010 trigger), which would indicate the bands rather than the weights need attention.

### ADR-031 · Near-anchor matching at edit distance 1, corroboration required
**Decision:** Same-type anchors of length ≥12 at Damerau-Levenshtein distance exactly 1 score `0.24`, and only when amount is within tolerance **and** date within window. Rule `NEAR_ANCHOR_V1`. Candidates come from a 6-character prefix block.
**Because:** The generator injects `REF_TYPO` on ~4 % of ledger `gateway_ref` values — a transposition in an 18-character id. Without this rule those degrade to no-anchor pairs and become unmatchable by construction, understating what a competent engine can do against a defect the dataset deliberately contains. It is not guessing: two independently generated 20-character alphanumeric ids at edit distance 1 is not a realistic coincidence, and the corroboration requirement means a near-anchor never carries a match alone.
**Rejected:** Distance ≤2 (collision risk climbs and the corroboration no longer bounds it); an alias of type `reference_id` per typo (works, but requires a human for something arithmetic can settle safely).
**Revisit if:** the scorer shows any near-anchor false positive against the answer key — in which case delete the rule rather than tune it.

### ADR-032 · Deterministic order and global score-ordered mutual assignment
**Decision:** Every decision-feeding query carries an explicit `ORDER BY (source_system, source_row_number)`; no `Math.random()`, no `Date.now()`, no set-iteration dependence in decision paths; scores rounded to 4dp before comparison; ties broken by canonical order. Assignment scores all candidate pairs, sorts by `(score DESC, canonical ASC)`, and accepts a pair only when **both** members are still unassigned.
**Because:** Greedy per-record assignment is order-dependent — if gateway `A` scores 0.88 against bank credit `X` and gateway `B` scores 0.95 against the same `X`, processing `A` first hands `X` to the weaker claim and pushes the stronger into an exception. Match rate, exception list and measured precision would all depend on iteration order, and Postgres row order without `ORDER BY` changes with plan choice. A result that isn't reproducible isn't a measurement, which is the entire thesis of the project.
**Rejected:** Hungarian / optimal maximum-weight matching — arithmetically better, but it occasionally trades one strong pair for two medium ones, which is materially harder to justify in an audit trail; the explainability of "strongest evidence is assigned first" is worth more here than optimality.
**Revisit if:** never.

### ADR-033 · Blocking strategy for candidate generation
**Decision:** Four in-memory block indexes per run (`byStrongAnchor`, `byAnchorPrefix`, `byDateAmount` on ₹1,000 buckets, `byCounterparty`). Tier 2 candidates are the union of block lookups, capped at 200 per record, with `candidateCapHit` recorded in evidence when the cap binds.
**Because:** Throughput is one of three judged axes and "it's fast on 820 records" is not a throughput claim. A full pairwise scan is ~340k comparisons at demo size (invisibly fine) and ~5 billion at the 100k benchmark (does not complete). Blocking makes the search `O(n × k)` in mean block occupancy, which grows with density rather than size. The cap is surfaced rather than silent because a bounded search that quietly truncates is a dishonest search.
**Rejected:** Full pairwise scan; a Postgres-side candidate query per record (round-trip per record dominates at scale); LSH/minhash (complexity unjustified at this size).
**Revisit if:** the measured curve (ADR-045) is materially super-linear, which would point at bucket sizing rather than at the approach.

### ADR-034 · Deduplication runs before matching, and requires anchor evidence
**Decision:** Same-source dedup is stage S4, before Tier 1. `EXACT_DUPLICATE` requires an identical **strong** anchor. `SUSPECTED_DUPLICATE` requires amount + date + counterparty **and** no anchor on either row **and** a cluster of exactly 2, stays in the matching pool, and is flagged for human confirmation. Clusters of ≥3 without anchors are never duplicates.
**Because:** Two reasons. (1) Ordering: `DUPLICATE_RECORD` is precedence #1 because a duplicate changes the problem's cardinality; if dedup ran after matching, the second copy would compete for the same bank credit, lose, and be reported as `MISSING_IN_BANK` — inventing a missing bank record. (2) Evidence: the Day 2 rule "same amount+date+counterparty in one source" collides head-on with the dataset's own `IDENTITY_DESTROYED` class, which deliberately plants 3+ same-amount, same-day, same-merchant anchorless rows — the generator's hardest designed case would be systematically misclassified as duplicates by the classifier's first rule. It is also false in the real world: two ₹499 subscription charges on one day are ordinary. A pair looks like a retry artifact; a crowd looks like ambiguity.
**Rejected:** Post-match dedup; amount+date+counterparty as sufficient evidence.
**Revisit if:** never.

### ADR-035 · Direction is a hard gate; refunds and chargebacks handled explicitly
**Decision:** `a.direction === b.direction` is a precondition at every tier, never a scored component. Gateway `refunded` rows are `debit` and reconcilable against bank debits and `CHARGEBACK` rows. Unmatched chargebacks remain exceptions.
**Because:** `schema.md` declared `refunded` reconcilable and gave the bank a `CHARGEBACK` type, but no rule anywhere handled a debit — leaving `direction` decorative and permitting a ₹5,000 capture to match a ₹5,000 chargeback on a shared anchor with a perfect score. That is a wrong book produced by an omission rather than by a judgement call.
**Rejected:** Scoring direction as a component (a strong enough anchor could outvote it).
**Revisit if:** never.

### ADR-036 · Bank `FEE` rows excluded at ingestion; `CHARGEBACK` and `MISC_CREDIT` are not
**Decision:** `status_norm` gains `excluded_non_reconcilable`, applied to bank `FEE` rows. They are counted, listed and visible in the UI — excluded, not hidden. `CHARGEBACK` and `MISC_CREDIT` stay in the reconcilable population.
**Because:** Gateway fees are already accounted for inside every net-amount comparison; reconciling a fee debit separately double-counts it and guarantees a permanent block of `MISSING_IN_GATEWAY` exceptions no human would ever action. Inflating the exception list with non-problems is the opposite failure from hiding exceptions and is equally dishonest. Chargebacks are the reverse case — a chargeback nobody can tie to a payment is precisely what a controller needs surfaced.
**Rejected:** Excluding chargebacks too (hides real findings); keeping fees in (permanent noise).
**Revisit if:** a fee row ever carries a gateway-resolvable anchor, which this generator does not emit.

### ADR-037 · Gateway amount compares to ledger NET, not ledger gross
**Decision:** gateway↔ledger compares `gateway.amount_paise` to `ledger.net_amount_paise`. bank↔ledger pairs form on anchors only, with the amount component marked unavailable rather than scored.
**Because:** `schema.md` §2.3 asserted both `ledger.net = gross − discount + tax` and "`gross_amount` should equal gateway `amount`". Both cannot hold — whenever discount or sale GST is non-zero, what the customer was charged equals ledger *net*. Comparing gross would turn every discounted or taxed sale into an `AMOUNT_MISMATCH`, flooding the exception list with arithmetic artifacts and destroying the credibility of the one category that most needs it. For bank↔ledger, no arithmetic relates a fee-net bank credit to a sale-GST ledger amount without the gateway row in between, so scoring them against each other would be a category error of the same kind §5.3 already forbids for gateway net vs ledger net.
**Rejected:** Comparing gross and widening tolerance to absorb discount/tax (hides genuine mismatches behind a loose band — the exact mistake ADR-008 exists to avoid).
**Revisit if:** never.

### ADR-038 · Bounded subset-sum decomposition, with bound-exceeded reported distinctly
**Decision:** Attempt decomposition of every unmatched bank `SETTLEMENT` credit: pool ≤24, subset size ≤8, 250 ms budget, fee bands as intervals. One subset → `many_to_one` match at `pending_review`. Two or more → `AMBIGUOUS_MATCH`. None → `UNSPLITTABLE_BATCH` with `searchExhausted`. Bound hit → `UNSPLITTABLE_BATCH` with `searchBoundExceeded` naming the bound.
**Because:** The engine may only claim a batch is unsplittable after genuinely trying to split it — otherwise "unresolvable" is an assertion rather than a finding, and a panelist is entitled to ask which. Bounds are required because subset-sum is exponential, and the two failure modes are different claims: "I proved no combination works" and "I gave up after 250 ms" are both honest, and conflating them is not. A found decomposition always asks a human because it is a strong inference, not a certainty.
**Rejected:** Declaring unsplittable without searching; unbounded search; auto-confirming a found subset.
**Revisit if:** the bounds bind on more than ~2 batches in the holdout run, in which case raise the pool cap and re-report.

### ADR-039 · `run_reference_date` derived from the dataset, never the wall clock
**Decision:** `run_reference_date = MAX(txn_date)` over all ingested records, computed at load, stored on `runs` and in `config_snapshot`. Every "has the settlement window elapsed" test uses it. Wall-clock time is used only for `occurred_at` and throughput.
**Because:** `MISSING_IN_BANK` requires a payment to be *overdue*. Answering that against the wall clock makes the engine's output depend on when it is run — the same dataset would produce different exception counts in August and in September, and the reported numbers would drift silently between rehearsal and submission. A dataset-derived reference date makes the run a pure function of its inputs.
**Rejected:** `now()`; a hardcoded date (breaks on regeneration).
**Revisit if:** never.

### ADR-040 · Match-rate denominator defined; `pending_review` is not "matched"
**Decision:** `reconcilable = ingested − excluded − rejected_rows − non_primary_duplicates`; `matched = records in ≥1 match with status auto_confirmed or human_confirmed`. `pending_review` and `human_rejected` count toward neither numerator and are reported as review burden alongside.
**Because:** The Day 2 docs used "matched_records / reconcilable_records" without defining either term, leaving the headline number ambiguous for the API, the UI and the scorer independently. A `pending_review` match is a *proposal*; counting proposals as reconciliations means the headline includes work a human has not done, which is the same class of dishonesty as reporting a warm number as a cold one (ADR-020).
**Rejected:** Counting pending review as matched; a single undefined "match rate".
**Revisit if:** never — this is a headline-number definition.

### ADR-041 · Ground-truth-derived metrics live in `score_reports`, written by the offline scorer
**Decision:** `runs.metrics` holds only engine-computed figures. Precision, recall, F1, false positives, the confusion matrix, difficulty slices, unresolvable recall and alias precision live in a separate `score_reports` table, written via `POST /api/runs/:runId/score-report` by `tools/score`. No engine module reads either the truth file or `score_reports`.
**Because:** `schema.md` §11 put `precision`, `recall` and `measured_against: "ground_truth/…json"` inside `runs.metrics`, which the API writes — meaning the API would have had to read the answer key, in direct contradiction of ADR-021. The shape as specified could not be produced by anything. Splitting the two sets keeps ADR-021's guarantee structurally intact while still letting the dashboard display measured accuracy, which is the whole point of measuring it. The separation also expresses the distinction honestly in the schema itself: one table is the engine's view of its own work, the other is an independent measurement.
**Rejected:** The API reading `data/truth/` (breaks ADR-021); a static JSON file served by the frontend (the dashboard could then show numbers with no provenance record).
**Revisit if:** never.

### ADR-042 · `audit_log` entries are hash-chained
**Decision:** Each entry carries `prev_hash` and `entry_hash = sha256(canonical_json(entry_without_hash) || prev_hash)`, chained per run. `GET /api/runs/:runId/audit/verify` recomputes the chain and reports the first divergence.
**Because:** ADR-015's trigger prevents `UPDATE` and `DELETE` through the application, but anyone who can drop a trigger can rewrite history and nothing would show it. A chain makes tampering *detectable* rather than merely *inconvenient*, which is the actual meaning of "logged immutably" in a finance context. It costs roughly fifteen lines and one endpoint, and a live verification during the pitch is a far stronger demonstration than describing a trigger.
**Rejected:** Trigger only; signing entries with a key (key management for no additional guarantee here).
**Revisit if:** never.

### ADR-043 · Humans can resolve exceptions and create matches manually
**Decision:** `POST /api/exceptions/:id/resolve` (`human_resolved` | `wont_fix`, reason required) and `POST /api/runs/:runId/matches` (manual match with required reason, `tier: 'manual'`, confidence `1.0`, status `human_confirmed`). Both write full audit entries; manual matches are reported separately in tier attribution and excluded from *engine* match rate.
**Because:** `exceptions.status` already allowed `human_resolved` and `wont_fix`, but no endpoint could produce either state — the column was unreachable. More substantively, the obvious action from an exception drill-down is "these two *are* the same, the engine just couldn't prove it", and there was no way to record it. Without these the exception list is a report; with them it is a workflow, which is what a finance controller actually needs. Excluding manual matches from the engine match rate keeps the headline honest — a human fixing something is not the engine matching it.
**Rejected:** Read-only exception list; folding manual matches into the engine's match rate.
**Revisit if:** never.

### ADR-044 · Severity is computed from category **and** money at risk
**Decision:** A base severity per category, escalated by absolute rupees at risk: ≥ ₹50,000 escalates one level, ≥ ₹2,00,000 escalates to `high`; `TIMING_DRIFT` never escalates above `medium`. Stored on the exception with the inputs recorded in `evidence.severityBasis`.
**Because:** Day 2 fixed severity per category, so a ₹5 rounding mismatch and a ₹5,00,000 partial capture were both `high`. A finance controller triages by money at risk, and a severity column that ignores amount makes the primary screen's sort order useless — which matters because the exception list is the product. Timing drift is capped because a late settlement is a process artifact regardless of size.
**Rejected:** Pure category severity; pure amount severity (a ₹50 duplicate is still a duplicate).
**Revisit if:** the thresholds misfit the generated amount distribution; they are config, not code.

### ADR-045 · Throughput is reported as a curve at 1k / 10k / 100k, not a single number
**Decision:** `tools/score` publishes a scale benchmark: wall-clock and per-stage timings at 1k, 10k and 100k generated records, plus per-stage complexity notes and the LLM call count at each size.
**Because:** Throughput is one of three judged axes, and a single "412 rec/s on 820 records" figure advertises how small the dataset is. A curve demonstrates that the design was reasoned about rather than measured once, makes the blocking strategy (ADR-033) verifiable rather than asserted, and shows a property that is genuinely interesting: because explanations are cached by signature (ADR-018), LLM calls stay roughly flat as records grow 100×. The generator is already parameterized by event count, so the marginal cost is a script and a table.
**Rejected:** Quoting demo-size throughput alone; a load-testing harness (out of proportion).
**Revisit if:** never.

### ADR-046 · Rejected rows are not exceptions; interrupted runs are reaped on boot
**Decision:** Malformed source rows are captured with their parse error into `runs.rejected_row_count` and audit `RECORD_REJECTED`, excluded from the reconcilable denominator, and never classified. On API boot, any run in a non-terminal state older than 5 minutes is marked `failed` with `error_detail: 'interrupted by restart'`.
**Because:** A row that could not be read is an ingestion defect, not a reconciliation finding; mixing the two corrupts the exception count, which is the number under the most scrutiny. And without a reaper, a crashed run sits at `matching` forever while the dashboard polls it indefinitely — a failure mode that surfaces during a live demo rather than during development, since only then does anything restart mid-run.
**Rejected:** A ninth exception category for bad rows; failing the whole run on one bad row; no reaper.
**Revisit if:** never.

### ADR-047 · `ARCHITECTURE.md` authored; four new binding docs
**Decision:** `ARCHITECTURE.md`, `docs/matching-engine.md`, `docs/ui-spec.md` and `docs/testing-strategy.md` are written and added to the binding set in `CLAUDE.md` §3.
**Because:** Every Day 2 doc referenced `ARCHITECTURE §3/§4/§5/§6/§7` as the scope lock — 23 citations across seven files — and the file did not exist, so the entire doc set hung off a phantom whose section numbering had to be inferred. Separately, `schema.md` defined the shapes and tolerances of matching but never the algorithm, which is where three structural flaws were hiding (ADR-028/029/030); an algorithm doc is what made them visible. The UI and testing docs exist for the same reason `api-contract.md` does: they are built by a later session on a different day, and a binding spec is what prevents that session from redesigning under time pressure.
**Rejected:** Folding everything into `schema.md` (already 800 lines and would bury the algorithm); leaving `ARCHITECTURE.md` unwritten and rewriting the 23 references.
**Revisit if:** never.

---

## 2026-08-26 — Day 3, second pass: The Analyst, an agentic layer downstream of the engine

Ten entries adding an agent layer to close a gap against the track's problem statement, which asks for an *agent*. **Nothing in S0–S14, the scoring logic, the determinism guarantees or ADR-001…ADR-047 is modified**, with one explicit and stated exception: ADR-055 amends a single clause of ADR-017 under four conditions that did not exist when it was written.

### ADR-048 · A separate agentic "Analyst" phase, strictly downstream of S14
**Decision:** A new Phase A (A1 TRIAGE → A2 INVESTIGATE → A3 VALIDATE → A4 PROPOSE) runs after the engine completes, as a separate job with its own lifecycle. It reads engine output as finished fact and cannot modify a match, exception, confidence, category or metric. See [agent-design.md](./agent-design.md).
**Because:** The track says "build an agent," and as designed through ADR-047 this system was a deterministic rules engine with one caption-writing LLM call that had a no-op template fallback. Fourteen of fifteen stages were arithmetic. Calling that an agent would be the same species of dishonesty the project is otherwise built to avoid, and a panel reading the architecture would see it immediately. But the fix could not be to make the *engine* agentic — ADR-017 is load-bearing, because accuracy is measurable only while the rules are deterministic and reproducible. The resolution is that a real finance-ops team has both a reconciliation system and an analyst who works the exception queue; this architecture had the first and not the second. The loop the track asks us to close is not closed when the engine finishes — it is closed when someone has dealt with the exceptions.
**Rejected:** Making the matching engine agentic (destroys measured accuracy); rebranding S13 as "the agent" (dishonest); a multi-agent planner/researcher/critic framework (out of scope per ARCHITECTURE §5, and A3 is a better critic than a critic because it is code).
**Revisit if:** never — but note that Phase A is a strict addition. If it is cut entirely the engine stands alone and nothing breaks.

### ADR-049 · The agent chooses questions; deterministic code computes every answer
**Decision:** The Analyst never performs arithmetic. It cannot compare amounts, compute a score, evaluate a date window or sum a subset. To learn whether two records match it calls `score_pair`, which runs **the same Tier 2 scorer S9 used**. Nine tools, and **not one of them writes** — the registry contains no mutating tool.
**Because:** This is what makes the layer agentic without weakening a single accuracy claim. What is agentic is the strategy — which records to pull, which hypothesis to test, when to stop. What is deterministic is every fact reasoned over. Three properties follow: the agent cannot produce a number the engine wouldn't have produced; it cannot silently disagree with the engine, since disagreement requires showing a tool result; and its reasoning is auditable at the level of evidence rather than narrative. A read-only registry is also a stronger guarantee than any instruction in a prompt — the agent is not *trusted* not to write, it is *unable* to.
**Rejected:** Letting the model do its own arithmetic on retrieved values (reintroduces non-reproducibility through the back door); giving the agent write tools with prompt-level guardrails.
**Revisit if:** never.

### ADR-050 · A deterministic grounding gate (A3) sits between agent output and the database
**Decision:** Every verdict passes a non-LLM gate before persistence: JSON-schema validation, **citation grounding** (every id cited must appear in a tool result this investigation actually retrieved), and constraint checks (proposed match members are in-run, unmatched, same-direction, distinct roles). Failure downgrades the verdict to `INSUFFICIENT_EVIDENCE` with `groundingFailure: true`, and **does not retry**.
**Because:** This converts "we hope it doesn't hallucinate" into "hallucination is structurally detected." An id the agent never retrieved is an id it invented, and that is checkable in code for a few lines. No retry, because a second attempt at a hallucinated answer is still an attempt at a hallucinated answer — and a retry loop would quietly select for whichever output happened to pass. Grounding failures are counted and reported rather than suppressed; a rising count means the prompt or tools need work.
**Rejected:** Trusting the model's citations; an LLM-as-judge validator (adds a second non-deterministic component to check the first); retry-until-valid.
**Revisit if:** never — this is the layer's central safety property.

### ADR-051 · Agent proposals route through existing human endpoints and never enter engine match rate
**Decision:** `MANUAL_MATCH` → endpoint 21, `CREATE_ALIAS` → endpoint 16, `MARK_WONT_FIX` → endpoint 20. **Zero new write endpoints.** A human-confirmed agent proposal becomes a `manual` match, which ADR-043 already excludes from engine match rate.
**Because:** Two reasons. Architecturally, the human-confirmation flow, its audit trail and its UI already exist; the Analyst proposes into an inbox rather than needing one built, which is most of why this layer is buildable in the remaining time. For honesty, an agent proposal that counted toward the engine's match rate would let a language model inflate a number that claims to measure deterministic rules — the same error as counting a human's manual fix as an engine match, which ADR-043 already rejected. The precedent is set; this is consistent with it rather than novel.
**Rejected:** Dedicated agent-approval endpoints; auto-applying high-confidence proposals without a human.
**Revisit if:** never.

### ADR-052 · Agent reasoning traces live in `audit_log`, not a parallel table
**Decision:** Each agent step and tool call is written to `audit_log` with `actor_type = 'agent'` and `subject_type = 'investigation'`. New tables are limited to `agent_investigations` and `agent_questions`; there is no `agent_tool_calls` table.
**Because:** Exactly the ADR-014 argument, which was right then and is right now: one timeline, one query, and the `sequence_no` ordering guarantee only holds within one table. It also means agent reasoning is **hash-chained and tamper-evident for free** (ADR-042) — a much stronger claim than a trace in an ordinary table, and one worth making to a finance panel. Adding values to the `actor_type` and `subject_type` CHECK constraints is a one-line `ALTER`, which is precisely why `schema.md` §0 chose CHECK over native enums.
**Rejected:** A parallel `agent_tool_calls` table (duplicates the audit shape, and leaves the trace outside the hash chain).
**Revisit if:** trace volume becomes a query problem, which at 20 investigations × ~16 calls it will not.

### ADR-053 · The Analyst is scored against the same answer key; a hallucinated resolution is a build blocker
**Decision:** Four ground-truth metrics in `score_reports`: **false-despair recovered** (headline), **proposal precision**, **hallucinated resolutions** (must be 0), **unresolvable agreement**. The Analyst never reads the key (ADR-021 unchanged, still enforced by the import grep).
**Because:** `validation-strategy.md` §5.3 already defined false-despair rate as *"the honest measure of the engine's headroom, and the right place to look for the next day's work."* The Analyst is that next day's work, and the false-despair set is exactly its addressable market — so the existing validation harness scores the new layer almost for free. The hallucination bar is a build blocker rather than a metric for the same reason unresolvable recall is: the ~21 designed-unresolvable events are impossible for any correct engine *and any competent human*, verified by assertion during generation. An agent that resolves one has invented evidence, which is strictly worse than the engine's silence because it arrives wrapped in a confident reasoning chain.
**Rejected:** Scoring the agent by human acceptance rate alone (measures the reviewer, not the agent); LLM-as-judge on reasoning quality (flagged as scope creep in validation-strategy §9 and still is).
**Revisit if:** never.

### ADR-054 · Bounded agency, and budget exhaustion is an honest verdict
**Decision:** 10 steps, 16 tool calls, 60 s and 40 k tokens per investigation; 20 investigations and $1.00 per run. Exhaustion yields `INSUFFICIENT_EVIDENCE` with `budgetExhausted: true` — never a best guess. `rerun_subset_search` bounds are ceilinged at pool 64 / subset 10 / 2000 ms.
**Because:** An unbounded agent loop against a paid API on a public no-auth demo is a financial risk, not a feature. And this mirrors the engine's existing honesty distinction exactly: `searchBoundExceeded` versus `searchExhausted` (ADR-038) already establishes that the system names which bound stopped it. An agent that produces its best guess when it runs out of room is worse than one that says it ran out of room.
**Rejected:** Unbounded loops; silently truncating to a conclusion; letting the agent set its own compute ceilings.
**Revisit if:** the step budget binds on more than ~10 % of investigations, which would mean the tools return too little per call.

### ADR-055 · Amends ADR-017's "no LLM-proposed aliases" clause, under four stated conditions
**Decision:** ADR-017 stands in full — the LLM still makes no matching or classification decision inside the engine, and S13 is unchanged. **One clause is amended:** its "Rejected: LLM-proposed aliases in v1" and the matching scope-creep flag in `schema.md` §12 no longer hold, *provided* all four of the following are true, which they are under ADR-048…ADR-053: (1) the proposal is downstream of a finalized, already-measured run; (2) it cannot modify engine output; (3) it requires human confirmation through an existing endpoint; (4) it is independently scored against ground truth with hallucination as a build blocker.
**Because:** The ADR log's own rule is that decisions are never quietly edited — a reversal appends a superseding entry. An agent that proposes an alias *is* the thing ADR-017 rejected, and pretending otherwise would be exactly the kind of drift this log exists to prevent. The original rejection was correct **for a v1 in which the LLM sat inside the pipeline with no independent measurement of its output**; that was the entire stated reason ("it puts the LLM adjacent to a matching decision"). Those four conditions did not exist on Day 2 and now do. The rejection was right; its premise changed.
**Rejected:** Silently building alias proposals and leaving ADR-017 as written; abandoning agent alias proposals to avoid amending an ADR (the alias loop is where agent leverage is most measurable, via the existing `wouldAlsoResolve` count).
**Revisit if:** any one of the four conditions is weakened — in which case this amendment lapses and ADR-017's original clause resumes in full.

### ADR-056 · A Q&A agent over finalized run results, and the quota exposure it creates
**Decision:** `POST /api/runs/:runId/ask`, a second loop over the same read-only tools, bounded at 6 steps and 8 tool calls, grounding-gated identically. Mitigations: 50 questions per run, 100 per hour globally, 1024 output tokens, and an `AGENT_QA_ENABLED` kill switch.
**Because:** The track names "Settlement Q&A agent" as an example direction, and the tool registry is already the hard part, so this is a second loop rather than a second system. The mitigations exist because **this endpoint falsifies a safety claim already written in `deployment.md` §4** — *"there is no user-facing 'ask the AI' box, so there is no path for an anonymous visitor to burn quota"* — on a demo that has no auth by design. Leaving a stale safety claim in a document while shipping the thing that breaks it would be precisely the quiet dishonesty this project exists to avoid, so the claim is corrected in the same change that breaks it.
**Rejected:** Shipping Q&A without rate limits; adding auth (out of scope per ARCHITECTURE §5, and it would block a panelist from clicking around).
**Revisit if:** observed cost exceeds the per-hour bucket, in which case lower the bucket rather than removing the feature.

### ADR-057 · Agent runs are reproducible-in-evidence, not reproducible-in-output
**Decision:** Phase A makes **no determinism claim** about its verdicts. It guarantees instead that every verdict's full transcript — every tool call, its arguments, its result digest, in order — is persisted in the hash-chained audit log, so any claim is checkable after the fact. A1 triage *selection and ordering* remain fully deterministic. Engine determinism (ADR-032) is untouched.
**Because:** A tool-use loop at temperature 0 is more reproducible than at temperature 1 and still not byte-identical across runs, and claiming otherwise would be a lie a careful reader could catch in one rerun. The honest formulation separates two different guarantees: the engine's numbers are *reproducible*, and the agent's conclusions are *auditable*. Both are strong claims; only one of them is determinism, and conflating them would contaminate the engine's guarantee with the agent's looseness. Keeping triage deterministic means which exceptions get investigated is reproducible even when the investigations are not.
**Rejected:** Claiming end-to-end determinism; caching agent verdicts by exception signature to fake it (would hide genuine variance and produce stale conclusions after a data change).
**Revisit if:** never — this distinction is what keeps ADR-032's guarantee clean.

---

## 2026-08-26 — Day 3, third pass: scaffold and first code

### ADR-058 · Three independent packages, no npm workspaces
**Decision:** `apps/api`, `apps/web` and the repo root (which owns `tools/`) are independent packages with their own `package.json` and lockfile. No workspaces, no monorepo tooling, no shared internal package. Wire types are duplicated between `apps/api/src/types` and `apps/web/types`.
**Because:** The two apps deploy to different platforms with different root directories — Railway builds `apps/api` with `npm ci`, Vercel builds `apps/web` — and `npm ci` inside a workspace subdirectory without the root lockfile does not work. Workspaces would buy one `npm install` locally and cost a build-time workaround on both platforms. The thing being shared is a handful of interfaces already specified in a binding contract doc (`api-contract.md`); duplicating them costs less than a shared package that both apps must build before either can start. Consistent with ADR-023's stated preference for the least interesting option available.
**Rejected:** npm workspaces (breaks the platform build commands in deployment.md §5.1); a `packages/shared-types` package (adds a build step to both apps for ~10 interfaces); a build-time codegen step from the contract doc.
**Revisit if:** a third app appears, or duplicated types drift in a way that causes a real bug — neither is likely inside 13 days.

### ADR-059 · `pg` type parsers are overridden for BIGINT, NUMERIC and DATE at pool construction
**Decision:** `src/db/pool.ts` registers parsers for int8 (→ `Number`, with a safe-integer assertion that throws), numeric (→ `Number`) and date (→ left as a `YYYY-MM-DD` string).
**Because:** All three defaults are actively wrong for this schema and all three fail *silently*. `pg` returns BIGINT as a string, so `row.amount_paise + row.fee_paise` concatenates rather than adds — on a money column, in a project whose thesis is measured accuracy, surfacing as a mysteriously wrong match rate rather than a crash. NUMERIC has the same problem for confidence scores. And the default DATE parser builds a `Date` at *local* midnight, which shifts the calendar day for anyone running outside UTC — every date comparison in the engine is a business-day operation on an IST date, so that is a one-day error that only reproduces on someone else's machine. The int8 assertion throws rather than widening, because ₹10 crore is 10^11 paise against a safe-integer ceiling of ~9×10^15: if it ever fires, the right response is a real decision about the type, not a bigger guard.
**Rejected:** Casting at every call site (one omission is a silent bug); `::text` casts in SQL (moves the problem into every query); leaving DATE as a `Date` and normalizing later (the timezone error is already baked in by then).
**Revisit if:** never.

---

## 2026-08-27 — Day 4

### ADR-060 · Subset-sum search is bounded by a deterministic node budget, not by the wall clock; and searches depth-first rather than meet-in-the-middle
**Decision:** S10's primary bound is a **node budget** (default 200,000 visited search nodes), not the 250 ms wall clock. The time budget is retained only as a last-resort safety valve, is expected never to fire, and reports itself distinctly (`bound: 'time'`) when it does. The search itself is depth-first with prefix pruning over candidates sorted by descending contribution, not meet-in-the-middle. Amends ADR-038's step 3 and its "250 ms budget" bound; every other part of ADR-038 — the two distinct failure claims, the pool and subset caps, `pending_review` on a found decomposition — stands unchanged.
**Because:** Two separate problems with the original step.

*The wall clock is a determinism hole.* ADR-032 rule 2 and `CLAUDE.md` §4.8 both forbid `Date.now()` in any decision path, and a time-bounded search is exactly that: the same dataset produces `searchExhausted` on a fast machine and `searchBoundExceeded` on a slow one. Those are **different claims about the data** — one says "no combination exists", the other says "I ran out of room" — so the exception's evidence, and potentially the match set, would depend on the hardware the run happened to land on. That is the precise failure ADR-039 was written to prevent for dates, reappearing in a different stage. A node budget is a pure function of the inputs, so exhaustiveness becomes a property of the dataset rather than of the machine.

*Meet-in-the-middle is the wrong tool at this size.* It wins for large-n **exact** subset-sum. Here `n ≤ 24`, subset size `≤ 8`, each candidate contributes an **interval** rather than a point (the inferred fee band), and the stage must distinguish "exactly one solution" from "two or more". MITM under interval arithmetic, with a size constraint and full solution enumeration, is materially more code and materially harder to argue correct. This stage's entire purpose is making a defensible claim about whether the space was exhausted — simpler code that is *obviously* exhaustive is worth more here than faster code whose exhaustiveness needs an argument. Depth-first with prefix pruning makes "I visited the whole bounded space" a one-line check, and at these caps it completes far inside any plausible budget.
*The subset-size cap is a declared limit, not a truncation.* ADR-038's table lumped the pool cap, the size cap and the budget together as `searchBoundExceeded`. Implementing it showed why that is wrong: the DFS reaches depth 8 on essentially any pool of eight or more, so `searchExhausted` would be almost unreachable — and an honesty flag that is almost never true tells a reader nothing. The two limits sit at different levels. The **size cap is part of the question**: announced up front, identical for every batch, and named in the reason string, so searching all of it is a complete answer to the question actually asked. The **pool cap and the budgets are a failure to answer it**: eligible candidates were discarded, or the search was cut short. So `exhaustive` is defeated only by truncation, and the size cap is reported as a qualifier alongside it.

*The budget was sized by measurement.* A full 24-candidate pool with no solution and zero tolerance — the worst case the caps permit — visits ~405k nodes in ~6 ms. The 250 ms figure in ADR-038 was therefore about fifty times more generous than the node count first chosen to represent it. The budget is 1,000,000 nodes (~25 ms locally, still inside the safety valve on a machine eighty times slower), and the wall valve moves to 2 s because the node cap already guarantees termination — the valve now exists only for a pathological case where individual nodes are expensive, and if it ever fires that is a bug report rather than a tuning opportunity.
**Rejected:** Wall-clock-only bounding (non-deterministic); dropping the time budget entirely (no protection if a node ever becomes expensive); meet-in-the-middle (complexity unjustified at `n ≤ 24`, and harder to prove exhaustive); treating the subset-size cap as a truncation (makes the exhaustiveness claim almost unreachable, and so useless).
**Revisit if:** the node budget binds on any batch in the holdout run — that would mean the pruning is ineffective, not that the budget is too small.

### ADR-061 · Deploy is deferred until the project runs end-to-end locally, superseding the Day-3 deploy-early rule
**Decision:** No deployment until the engine, the API and the frontend run and are tested locally. `ARCHITECTURE.md` §7.4's "deploy early" instruction and ADR-026's Day-3 target no longer hold. The deploy moves to **Day 11 for the API** — once the backend is locally complete and has produced a scored run — and **Day 12 for the web app**, alongside the frontend. It is not left to Day 13.
**Because:** Deploying a half-built project means **being correct in two places at once instead of one.** A cloud deploy is not a copy of the local build: it adds a CI/CD path, a platform build environment, injected environment variables and a managed database, and every one of those has to stay correct through the changes still coming. Dependencies will change, large refactors are likely, and the migration set is still growing — so an early deploy does not lock in a working system, it creates a second system that must be re-verified after every one of those changes. The cost is paid repeatedly and the benefit accrues once.

This is a genuine reversal, not a reinterpretation. ARCHITECTURE §7.4 and ADR-026 argued the opposite — that a live URL early is a strong panel signal and removes the most common last-week failure mode — and that argument is not wrong, it is outweighed. **The residual risk is real and stays on the books:** a first deploy that goes badly on Day 11 has two days of slack rather than a week. Three things keep that survivable, and they are the reason the trade is acceptable: the deploy surface is deliberately tiny (two managed platforms, no containers authored by us, no orchestration — ADR-005, ADR-026); `deployment.md` §5.1 already documents the exact one-time setup, so it is execution rather than design; and the fallback to Render is pre-decided at a 45-minute budget. What is NOT acceptable is letting this slide to Day 13 — the deploy slot is a scheduled task with a date, not a thing that happens when there is time.
**Rejected:** Deploying on Day 4 as originally planned (two places to keep correct while the codebase is still moving); deploying only on Day 13 (concentrates platform risk on submission day); a staging environment (a third place to be correct, for a demo).
**Revisit if:** the Day 11 API deploy exposes a platform problem that is not fixed inside its slot — at which point the schedule, not the decision, is what needs attention.

### ADR-062 · `AMOUNT_MISMATCH` moves above the presence class in the precedence order
**Decision:** The order becomes `DUPLICATE_RECORD → AMBIGUOUS_MATCH → UNSPLITTABLE_BATCH → AMOUNT_MISMATCH → MISSING_IN_GATEWAY → MISSING_IN_BANK → MISSING_IN_LEDGER → TIMING_DRIFT`. `TIMING_DRIFT` stays last. Amends the order in `schema.md` §8.2; the "presence before value" *rationale* is narrowed rather than deleted.
**Because:** §8.2 justified putting presence above value with *"you cannot have an amount disagreement with a record that isn't there."* That reasoning is sound, and it is **about a single leg**. The precedence order, however, is applied **per record** — and a record has up to two legs. A gateway payment can simultaneously have a proved ₹412 discrepancy against the bank *and* no ledger entry at all. Both statements are true, about different counterparts, and the original ordering made the bookkeeping gap the headline.

That is the same failure §8.2 already warns about one line further down — *"reversing this would let a real money problem be reported as a low-severity scheduling quirk"* — because **severity is computed from the primary category** (ADR-044). Filing that record as `MISSING_IN_LEDGER` yields `medium`; filing it as `AMOUNT_MISMATCH` yields `high`. The old order silently downgraded a proven money discrepancy, which is precisely the finding a finance controller most needs at the top of the screen.

The reorder is safe because presence and value **cannot compete within one leg**: `classify.ts` enforces the discriminator directly — an established identity means the question is value, so no presence signal is raised for that leg. Any record where both appear therefore has them on *different* legs, where the original justification does not apply and only consequence remains. `TIMING_DRIFT` stays below presence deliberately: a late settlement is a process artifact, while a wholly absent record is not.
**Rejected:** Keeping the order and accepting the downgrade (contradicts ADR-044's whole purpose); making precedence per-leg rather than per-record (a record needs one headline category — the schema has one `category` column and the UI has one row per record); special-casing severity to look past the primary category (would make the severity of a row unexplainable from its own category).
**Revisit if:** never — this is a correction, not a preference.

### ADR-063 · S10's node budget is sized to provably dominate the declared search space, not a measured hard case
**Decision:** `batchNodeBudget` is **1,300,000** visited nodes, not the 1,000,000 ADR-060 set. The declared space for one batch decomposition is subsets of size `0..batchMaxSubsetSize` (8) drawn from a pool of up to `batchPoolCap` (24) candidates, whose combinatorial ceiling is `Sum(C(24,k), k=0..8) = 1,271,626`. 1,300,000 is stated as a **proof** that the budget dominates every input the caps permit, not as a measurement of one hard fixture. Amends ADR-060's node-budget figure and its "Revisit if" trigger; every other part of ADR-060 — the node budget over the wall clock, depth-first over meet-in-the-middle, the declared/truncating distinction — stands unchanged.
**Because:** Audit finding F2 (Day 4 self-audit, 2026-08-27) reproduced a real input inside the declared caps — 24 point contributions of ₹10,000 each, an unreachable target, zero tolerance — that visited over 1,000,000 nodes and hit the budget, reporting `searchBoundExceeded` on a case the engine should have been able to prove unsplittable. ADR-060's 1,000,000 figure was chosen by measuring one hard-looking fixture (~405k nodes), the same mistake ADR-060 itself corrected in ADR-038's 200,000: a number meant to bound a *declared* space should be derived from that space's own ceiling, not from a case that happened to get measured. The true ceiling was computable from the caps that were already locked (`batchPoolCap`, `batchMaxSubsetSize`), so there is no reason to keep guessing at it.

The engine's *behaviour* was honest throughout — a bound miss reports `searchBoundExceeded`, which is the correct claim, never a silent wrong answer. Only the budget, and the documentation asserting it was already the worst case, were wrong. Measured cost of the true worst case (~1.08M nodes) is well under 50 ms locally, so raising the budget to dominate the full ceiling is free.
**Rejected:** Keeping 1,000,000 and rewriting the docs to state the real ceiling instead of raising the budget (weaker claim — "we measured a hard case" instead of "the budget provably dominates the declared space" — for no cost saving); sizing the budget to the exact ceiling of 1,271,626 with no headroom (leaves no margin for a future cap change to `batchPoolCap` or `batchMaxSubsetSize` being missed in this file).
**Revisit if:** `batchPoolCap` or `batchMaxSubsetSize` changes — the ceiling must be recomputed and the budget re-raised to dominate it, not left at 1,300,000 on the assumption it still covers a different declared space.

### ADR-064 · bank↔ledger's unavailable amount component is scored 0, not renormalized — and that caps the pair at the review floor
**Decision:** For a bank↔ledger candidate pair, the amount component of the Tier 2 score is **0**, flagged `amountUnavailable: true`, and **not renormalized** across the remaining components. This is the scorer's existing behaviour (`scoring.ts`); the decision is to make the documentation agree with the code rather than the reverse. Amends `schema.md` §5.3.1 and §5.4, and `matching-engine.md` §4.3 and §7.1, which stated three different and mutually contradictory readings (`unavailable, not 0`; `unavailable and renormalized`) against the code's actual `0, not renormalized`.
**Because:** Audit finding F7 (Day 4 self-audit, 2026-08-27) found three of four doc passages asserting a reading the code does not implement, and the fourth (`matching-engine.md` §4.3) already agreeing with the code but not stating the consequence. Renormalizing would raise a bank↔ledger pair's reachable ceiling — `strong_weak: (0.30+0.20+0.15)/0.65 = 0.846` — making ADR-037's "bank↔ledger pairs may form on a shared anchor" comfortably reachable and close to auto-confirm. Not renormalizing caps the same pair at `0.65` exactly (the review floor, reachable only with a perfect same-day match and a trigram similarity of `1.0`) and caps weak↔weak at `0.55` (never a candidate at all). That is a real behavioural difference the docs must state honestly, not paper over by picking whichever reading sounds better.

This ADR takes the **conservative option** deliberately: it records the code's current arithmetic as the decision rather than changing the arithmetic to match the more generous of the four passages. Rewiring a scoring weight unattended, before the project has produced its first measured accuracy run, is exactly the kind of change ARCHITECTURE.md §7 asks to be flagged rather than decided alone — renormalization remains available as a follow-up, informed by whatever the holdout run actually shows about bank↔ledger reachability, not decided blind now.
**Rejected:** Renormalizing to match three of the four passages (a real scoring change, made unattended and pre-measurement — the article's own "if you conclude the code must change, log it as a failed issue instead" steer applies); picking a reading anywhere in between (invents a fifth position no doc or code currently holds).
**Revisit if:** the holdout run shows bank↔ledger `MISSING_IN_*` exceptions where a genuine anchor-matched ledger counterpart exists but never reached the review band — that would be the measured case for reconsidering renormalization, not a guess made now.

### ADR-065 · A bank record's missing-gateway check gets its own fallback window, not the borrowed gateway→bank window
**Decision:** When a **bank** record has no gateway counterpart, `classify.ts`'s settlement-due check uses a new `dateWindowGatewayLookbackDays` constant, default `[-1, 1]`, measured from the bank record's own `txnDate`. This is a stated rule with its own window, not the `dateWindowCardDays` `[-1, 3]` window ADR-009 defines for the opposite direction (gateway → bank). A **ledger** record's missing-gateway check uses ADR-009's existing `gateway_ledger` window `[-1, 1]`, applied symmetrically — no new constant needed there, since ADR-009 already defines that pair's window without reference to direction.
**Because:** Audit finding F5 (Day 4 self-audit, 2026-08-27) found `classify.ts`'s `settlementDue()` forcing `kind = 'gateway_bank'` for every non-gateway record, so a ledger record's check silently used the wrong ADR-009 window (`[-1,3]` instead of `[-1,1]`), and a bank record's check used a window ADR-009 does not define in that direction at all — measured from the bank date rather than the gateway date the window's own name and rationale describe, and named `T+3 settlement window` in the reason string, asserting an SLA that does not exist for that source pair.

The ledger case is a straightforward bug: ADR-009 already has the right answer (`gateway_ledger`), it just wasn't reached. The bank case is not — there genuinely is no ADR-009 window for "how long to wait for a gateway record, checked from the bank side." Settlement flows forward FROM the gateway capture (ADR-009's own framing): a real gateway record for an economic event is captured before or at the time of the downstream bank credit, and this project's runs process all three source files as one batch, not a stream, so there is no ingestion-lag reason to wait days for it to "arrive" the way a bank credit waits to settle after a gateway capture. `[-1, 1]` keeps the universal `-1` IST/UTC midnight-drift slack every other window in this codebase carries, and adds one day rather than `dateWindowCardDays`'s three, because this window is not standing in for a settlement SLA — there isn't one to stand in for.
**Rejected:** Reusing `dateWindowCardDays` with a corrected `kind` label (numerically identical to the bug — the window is defined and measured in the opposite direction, so "correctly naming" it as `gateway_bank` does not fix the underlying category error); a wider fallback window matching the card SLA (invents a settlement wait that does not exist for this direction, and would silently delay genuine `MISSING_IN_GATEWAY` findings on bank rows by two extra days for no stated reason); zero slack (would make a near-midnight bank record a false exception, the exact failure the `-1` convention exists to prevent).
**Revisit if:** the generator or a real dataset shows gateway records genuinely arriving after their bank credit's date (e.g. a batch-settled gateway feed) — that would be evidence for widening `dateWindowGatewayLookbackDays`, not a guess made now.

---

## Superseded

- **ADR-021** — not superseded, but *clarified* by **ADR-041** (2026-08-26): the no-truth-in-the-engine rule stands; ground-truth-derived metrics move to a separate `score_reports` table written by the offline scorer, because the metrics shape in `schema.md` §11 could not otherwise have been produced by anything.
- **ADR-004 / ADR-012** — extended by **ADR-029** (2026-08-26): a fourth stage (identity-established short-circuit) sits between the alias tier and the fuzzy tier. The tier ordering itself is unchanged.
- **ADR-011 / schema.md §8.2** — the eight categories stand; the *order* is amended by **ADR-062** (2026-08-27), which lifts `AMOUNT_MISMATCH` above the presence class because precedence is applied per record while "presence before value" only holds per leg.
- **ADR-026** — the platform choice stands; its **Day-3 deploy target is superseded by ADR-061** (2026-08-27), which defers deploying until the project runs end-to-end locally.
- **ADR-038** — stands, with step 3 and the "250 ms budget" bound amended by **ADR-060** (2026-08-27): the primary bound is a deterministic node budget, because a wall-clock bound made exhaustiveness a property of the machine rather than of the data.
- **ADR-060** — stands, with its node-budget figure (stated inconsistently there as both 200,000 and 1,000,000) **superseded by ADR-063** (2026-08-27): the budget is 1,300,000, sized to provably dominate the declared search space's combinatorial ceiling rather than a measured hard case.
- **ADR-037** — not superseded, but *clarified* by **ADR-064** (2026-08-27): "the amount component is marked unavailable rather than scored" is settled as *scored 0 and flagged unavailable, not renormalized* — the docs had drifted into three contradictory readings of that clause, none of them wrong about the anchors-only rule itself.
- **ADR-009** — stands in full, and is **extended by ADR-065** (2026-08-27) for a case it never covered: how long a *bank* record waits for a missing *gateway* counterpart, which is not the inverse of any window ADR-009 defines. ADR-009's `gateway_ledger` window is unchanged and now correctly reached from both directions (a code bug, not a doc gap).
- **ADR-010** — thresholds unchanged; the component weights they operate on were recalibrated by **ADR-030** (2026-08-26).
- **ADR-035** — stands in full for gateway↔bank; its **"at every tier" scope is narrowed by ADR-071** (2026-08-28): the gate binds only between two sources that state a direction, because the ledger has no direction column and gating on the parser's assumed `'credit'` cost every `REFUND_REVERSAL` event its ledger leg at all four tiers.
- **ADR-017** — stands in full, with **one clause amended by ADR-055** (2026-08-26): "no LLM-proposed aliases in v1" no longer holds for downstream agent proposals that meet four stated conditions. The core rule — the LLM makes no matching or classification decision inside the engine — is unchanged and unweakened.
- **ADR-043** — extended by **ADR-051** (2026-08-26): agent proposals route through the same human-confirmation endpoints and are excluded from engine match rate on the same reasoning.

### ADR-066 · Transaction-scoped locks require a branded `TxClient`, and the lock's survival is verified at runtime
**Decision:** `withTransaction` is the only producer of `TxClient`, a branded `pg.PoolClient`. `takeAdvisoryXactLock` and `appendAuditEntry` accept nothing else, so a transaction-scoped lock cannot be taken on a `Pool` or a bare client. In addition, the statement that reads the audit chain head also asks `pg_locks` whether the lock is still held by this backend, and the append is refused if it is not.
**Because:** the same bug shipped twice. Unit 1's migration runner took a *session*-scoped `pg_advisory_lock` on a `Pool`, which hands out a different connection per query, so the lock was held on one connection while the migrations ran on others. Unit 9 — the commit that *fixed* that — then took a *transaction*-scoped `pg_advisory_xact_lock` on a caller-supplied client that need not be in a transaction, where each statement is its own transaction and the lock dies with the statement that took it (issue #16). Both are "a lock acquired somewhere it does not survive", both succeed silently, and in both cases the guarantee is simply absent with nothing to see. Twelve concurrent appends on bare clients produced entries claiming the same predecessor, and the verifier reported `chain_broken` on an untampered log — a tamper-evidence mechanism made to accuse itself by its own writer. A third occurrence was a question of when, so the fix is a type that makes the mistake unrepresentable rather than a comment asking the next reader to be careful. The runtime check exists because a type can be cast away and JS callers ignore it entirely; it is folded into an existing statement, so it costs no extra round trip on a path that runs thousands of times per run — which matters at ADR-045's 100k benchmark, where the audit write path is among the hottest in the system.
**Rejected:** a comment on the parameter (this is precisely what failed the first time); a runtime check alone (catches it after the fact rather than at compile time, and only on the paths that execute); `UNIQUE INDEX (run_id, prev_hash) NULLS NOT DISTINCT` on `audit_log`, which would make two entries claiming one predecessor impossible to commit regardless of locking — strictly stronger, but it turns the failure into a unique violation every future caller must catch and retry, and that is a contract change for a problem the type system already closes. Still available if the append path ever gains a writer outside the run orchestrator.
**Revisit if:** a legitimate caller needs to append outside a transaction, which would mean the single-writer model in `schema.md` §9.0 has changed and the chain-head read needs rethinking, not the lock.

### ADR-067 · The generator draws from one seeded `sfc32` stream, scrambled per seed and split into named sub-streams
**Decision:** `tools/generate/prng.ts` is the only source of randomness under `tools/`. It is `sfc32` (128 bits of state, pure 32-bit integer ops), seeded through `splitmix32` rather than directly, with named sub-streams derived by an order-dependent FNV-1a fold over the parent's stream identity. `Math.random`, `Date.now`, `new Date`, `performance.now` and `crypto` randomness are forbidden under `tools/`, enforced by a guard test rather than by intention. The algorithm is now fixed: changing it changes every dataset and invalidates every number already published against one.
**Because:** three separate properties are needed and only the first is obvious. **Reproducibility** — `validation-strategy.md` §1 requires same seed → byte-identical files and key, because a dataset that drifts between rehearsal and submission cannot be honestly measured. **Seed independence** — ADR-027 develops against `DEV_SEED` and reports against `HOLDOUT_SEED`, and that separation is worth nothing if the two are correlated; small generators seeded directly produce visibly related output for adjacent seeds, so tuning against dev would partially tune against holdout, which is the exact leak ADR-027 exists to prevent arriving through the back door. Scrambling the seed through `splitmix32` before it reaches the state removes it, and a test asserts seeds *n* and *n+1* share none of their first 64 draws. **Edit stability** — without named sub-streams every draw shares one sequence, so inserting a single extra draw while iterating on defect logic reshuffles every event and every projection; regenerate-and-compare, which is how this generator will actually be developed and how a scoring regression gets localised, degrades to "everything changed". Sub-streams keep §1's single-seed guarantee exactly, since they are a deterministic function of that seed and not a second source of entropy. Derivation is deliberately non-commutative and non-cancelling: an XOR-combined seed would make `derive('a').derive('b')` equal `derive('b').derive('a')`, and would make `derive('x').derive('x')` collapse back onto the parent and hand out the same stream twice.
**Rejected:** `Math.random` (unseeded, and the entire point is that it is not); `mulberry32` (32 bits of state and weaker adjacent-seed behaviour than a file that decides what "the truth" is should rely on); `xoshiro128**` (equally good, marginally longer, no reason to prefer either — `sfc32` chosen and recorded so it is not re-litigated); PCG32 or SplitMix64 as the main generator (64-bit arithmetic means `BigInt`, which is slower and reads worse for no gain at this scale); `floor(float * range)` for bounded integers (modulo bias of parts in 10^-9, which is negligible and is still a sentence one would have to write about the process that generates ground truth — rejection sampling removes the need to say it); a golden-vector test pinning the output (pins behaviour without stating what must be true of it, and gets silently rewritten to whatever the code now does the first time anything changes).
**Revisit if:** never for the algorithm — this is now a compatibility surface, and a dataset regenerated under a different PRNG is a different dataset. If a genuinely better generator is wanted, it arrives as a new `prngVersion` recorded in the manifest, alongside the old one.

### ADR-068 · The answer key's manifest carries no generation timestamp, and publishes the computed ceiling instead
**Decision:** `manifest` holds `seed`, `generatorVersion`, per-source record counts, the realized scenario distribution, the realized unresolvable count, the theoretical maximum match rate computed from it, and a content hash per emitted file. It does **not** hold a generation timestamp, which `validation-strategy.md` §2.4 originally listed. A test asserts no manifest field name looks like a clock read.
**Because:** §1 requires "same seed → byte-identical files and key", and a timestamp breaks that on every regeneration — including the manifest's own content hash, so the artifact could never be compared against itself, which is the single property the key exists to have. It is also unenforceable: `Date.now()` and `new Date()` are forbidden under `tools/` (ADR-067) precisely so the generator is a pure function of its seed, and a timestamp would be the one exception, in the file whose reproducibility matters most. `seed` and `generatorVersion` identify the artifact completely and reproducibly, and git already records when it was written — the timestamp was answering a question nothing was asking. Publishing `theoreticalMaxMatchRatePct` in its place is the more useful field by some distance: the ~93 % ceiling is quoted in the README, the dashboard and the pitch, and computing it from the realized data means those figures cite a number the artifact derived rather than one a human transcribed and may not re-transcribe after a regeneration.
**Rejected:** keeping the timestamp and excluding it from the byte-identity claim (a carve-out in the one guarantee the key exists to provide, and the manifest hash would still move); passing the timestamp in from the caller (moves the clock read one file away without making the output reproducible); recording it in a sidecar file (two artifacts to keep in step, for a value git already has).
**Revisit if:** never — reproducibility of the key is load-bearing for every accuracy claim in the project.

### ADR-069 · §1's "200-500 records" estimate was stale; corrected to match §3's own weight table
**Decision:** `validation-strategy.md` §1's parenthetical record-count estimate is corrected from "200-500" to "~850-950", matching what the generator actually produces once §3's scenario table (36% CLEAN_3WAY and five other 3-way-dominant scenarios, only four presence/absence scenarios subtracting a leg) is honoured. The committed HOLDOUT_SEED dataset lands at 920 records (323 gateway + 301 bank + 296 ledger, including noise) — verified by running `tools/generate` (G6) rather than estimated.
**Because:** "200-500" was never reachable from §3's own numbers. At 300 events with §3's weights, roughly two-thirds of events are 3-way scenarios (CLEAN_3WAY alone is 108 events), and even the presence/absence scenarios (MISSING_IN_LEDGER, MISSING_IN_BANK) still contribute 2 rows each rather than dropping to near-zero. The arithmetic that produces 200-500 from 300 events would require most events to average under two rows, which nothing in §3 describes. The figure also disagreed with two OTHER numbers already in this document set: §5.5's own "~820 records" throughput baseline, and the worked example already corrected once this build cycle (api-contract.md / schema.md's `850 ingested / 813 reconcilable`, fixed for a different reason — the ADR-040 denominator arithmetic — during the Day 5 handoff-gap pass). Three numbers in the same doc set implying three different totals is the same failure the ADR-060 sweep and the denominator sweep both found: an estimate written early, never reconciled against a later, more detailed, authoritative table (§3 itself).
**Rejected:** Shrinking the generator's output to hit "200-500" — §3's weight table is the more detailed, reviewed, already-implemented source, and bending the generator to match a stale parenthetical would mean *tuning the dataset to a number* rather than reporting what the honest scenario mix produces, which is exactly the kind of massaging this project's validation strategy exists to rule out.
**Revisit if:** §3's scenario weights change materially — the record-count estimate should move with them, not be re-fixed independently a second time.

### ADR-070 · §2.3's ledger-date ambiguity target was arithmetically unreachable; corrected to what a realistic window produces, and asserted
**Decision:** `schema.md` §2.3's "generator only emits days ≥ 13 in ~30% of rows" is corrected. A contiguous 30-day window cannot produce that: **any** 30-day span contains 18–19 days numbered above 12, so the *lowest* unambiguous share achievable over any such window is 60 %, and the realized dataset sits at 57.8 % unambiguous / 42.2 % ambiguous. The doc now states ~40 % ambiguous, and `project.test.ts` asserts the ambiguous share stays above 35 % rather than leaving the property unmeasured.
**Because:** the target was unimplemented and unimplementable, and the code that should have implemented it had quietly become an identity function (`pickLedgerDate(_rng, d) { return d; }`) carrying a comment that claimed the distribution "is asserted in project.test.ts" — where no such assertion existed. Two failures at once: a spec number nothing could satisfy, and a false claim that something else was checking it. What matters is the PURPOSE, which §2.3 states plainly — a parser that infers the format must be visibly, frequently wrong, which is why `dates.ts` refuses to guess. At 42 % ambiguous an inferring parser mis-dates roughly a fifth of all ledger rows, which demonstrates the point comprehensively; the specific figure 30 % was an estimate, not a requirement derived from anything.
**Rejected:** gerrymandering the event window to hit 30 % (a ~19-day window ending mid-month gets close) — that is tuning the dataset to a number rather than to a purpose, it compresses the settlement windows the dataset also has to exercise, and a calendar range visibly chosen to avoid month-ends is exactly the kind of artifact a careful reader notices; leaving the target in place and unimplemented (the status quo, and the reason this was only found by writing the missing test); dropping the property entirely (the ambiguity is load-bearing — it is why the format is declared rather than inferred).
**Revisit if:** the event window changes shape materially — the ambiguous share moves with it, and the 35 % floor in the test is the thing to re-derive, not the doc prose.

### ADR-071 · The direction gate applies only between two sources that STATE a direction, superseding ADR-035's "at every tier"
**Decision:** `directionAgrees` is now a predicate over two records rather than two `Direction` values, and abstains unless **both** sources assert a direction. The gateway asserts it (`status`: `captured` → credit, `refunded` → debit, `schema.md` §2.1) and the bank asserts it (which of `credit_amount` / `debit_amount` is populated, §2.2). **The merchant ledger does not** — §2.3 gives it no direction column, every row is a posted sale entry, and the `'credit'` its parser assigns is a modelling constant. So the gate binds gateway↔bank and abstains on gateway↔ledger and bank↔ledger. ADR-035's other holdings are unchanged: direction is still a hard gate and never a scored component, `refunded` is still `debit`, unmatched chargebacks are still exceptions.
**Because:** ADR-035's argument is a **gateway↔bank** argument — "a ₹5,000 capture matching a ₹5,000 chargeback on a shared anchor" is a statement about two sources that each report a direction. Applied to a ledger pair it compares a gateway fact against a value this codebase invented, and it fails for exactly the case the dataset plants: a `REFUND_REVERSAL` has the gateway recording the reversal as a debit while the ledger records the original sale as a credit, and both legs belong to one economic event. AUDIT-1 measured the cost on the holdout — all **nine** `REFUND_REVERSAL` events lost their ledger leg at S6, S7, S8 *and* S9, because the gate is applied at each. Eighteen expected pairs became unreachable, nine `MATCH_3WAY` events degraded to 2-way, and nine orphaned ledger rows would have surfaced as presence exceptions the answer key says should not exist — inflating the exception list with non-problems, which `schema.md` §2.2 names as "the opposite failure from hiding exceptions, and equally dishonest." Where one side does not state a direction there is nothing to disagree with, and inventing a conflict is a guess wearing a gate's clothing.
**Rejected:** Making `transactions.direction` nullable or adding an `'unknown'` value (a migration, a CHECK change and a nullable column threaded through every consumer, to express something already derivable from `source_system`); teaching the ledger parser to detect a reversal (the row is byte-identical to an ordinary sale — positive amounts, `status=posted`, empty memo — so there is nothing to detect); changing the generator to emit a reversal-shaped ledger row (rewrites the committed holdout and invalidates `manifest.fileHashes`, and the ledger genuinely does record the sale as a credit, so the data is not wrong); dropping the gate entirely (it is correct and load-bearing at gateway↔bank, which is ADR-035's actual subject).
**Revisit if:** a fourth source is added, or the ledger export gains a direction, sign or entry-type column — at which point `DIRECTION_BEARING_SOURCES` in `services/matching/tolerance.ts` is the one line to change.

### ADR-072 · `viaTier` is scored against the engine's per-tier PAIR attribution, never against `matches.tier`; pair membership is the sole correctness criterion
**Decision:** `tools/score` scores matching accuracy on **pair membership alone** — did the engine place these two records in one group? `viaTier` is never a term in precision, recall or F1. Three cases are settled explicitly, and none of them is a recall miss:

1. **Tier fall-through** (gateway↔bank). The key labels the pair `exact`; the engine reaches it at Tier 2 on a `strong_weak` anchor. Matched. `viaTier` is "the weakest tier that *should suffice*" (§2.2), not a requirement.
2. **Identity established, match correctly refused** (gateway↔ledger `AMOUNT_TRUE_MISMATCH`). The key says `shouldMatch: true` + `viaTier: exact` at pair level while the event's `expectedOutcome` is `EXCEPTION`. **A pair whose event-level `expectedOutcome` is `EXCEPTION` is scored against the classification key (§5.2), never against the pairing key.** Scoring it as an unmatched pair understates recall; scoring it as a match overstates it and contradicts the event-level key.
3. **Pair tier vs group tier.** The key labels a **pair**; `matches.tier` describes a **group**, and §10 rule 5 makes it the *weakest* tier among the group's constituent pairs. They are different quantities and are not comparable. Measured on the holdout after issue #40: **413 of 658 matched true pairs (63%) disagree**, 375 of them `key=exact` sitting in a group correctly reported `fuzzy` because it also holds a fuzzy third leg.

Tier attribution — the diagnostic §2.2 promises — is therefore computed by comparing the key's `viaTier` distribution against the **engine's own per-tier pair counts**, both pair-level and directly comparable. This makes one concrete demand on S14 (U8): `runs.metrics` must record how many PAIRS each tier produced, alongside the group-level figures. It is reported as a labelled diagnostic, never as an accuracy term.

**Because:** the promise in §2.2 — *"did the engine match at exact when exact was available, or did it fall through to fuzzy?"* — is worth keeping, and the obvious way to compute it is now wrong for nearly two-thirds of matched pairs. A scorer that joins `viaTier` to `matches.tier` produces a plausible per-tier table reporting that the engine "failed to match exactly" 375 pairs it matched perfectly and completely. The failure is invisible in exactly the way this project's measurement story exists to rule out: the headline match rate would be correct while the breakdown beneath it is not, and a panelist reading the breakdown would draw a conclusion about engine fragility that the data does not support. Case 3 did not exist in a visible form until issue #40 was fixed — before that most Tier 1 pairs sat alone in two-way groups, so pair-tier and group-tier usually coincided and the mismatch read as an edge case rather than the majority.

Cases 1 and 2 were filed by AUDIT-1 (#34) and are settled here in the same ADR because all three are the same underlying confusion: **the key describes pairs and economic events; the engine reports groups and records.** Every one of the three is a place where scoring the wrong quantity moves a published number in a flattering or unflattering direction for a reason that has nothing to do with engine quality.

**Rejected:** persisting per-pair tier provenance on `match_members` or a new table (a migration, a repository change and a serialization change, to recover something S14 can record as four integers — and it would put per-pair rows in front of a UI that correctly reasons in groups); dropping the tier diagnostic entirely (§2.2's question is a good one, and "matched everything by fuzzy" genuinely is more fragile than the same rate earned at exact — that distinction should stay visible); comparing `viaTier` to the tier of the *strongest* constituent pair instead of the weakest (invents a second tier semantic that contradicts §10 rule 5, purely to make a join work); scoring tier agreement as a soft penalty (a penalty for correct behaviour, and it would make the headline sensitive to how many third legs the engine found).

**Revisit if:** S11 ever gains per-pair provenance in its persisted output for an unrelated reason, at which point the diagnostic could be computed per pair rather than per tier-count — the correctness rule (pair membership only) does not change either way.

### ADR-073 · `sourceRowNumber` travels on every record preview, because it is the only join key the answer key can express
**Decision:** `RecordPreview` — the record shape embedded in `MatchSummary.members`, `ExceptionSummary.primaryRecord`, `ExceptionDetail.relatedRecords` and every candidate preview — gains `sourceRowNumber` alongside the `transactionId` it already carries. `api-contract.md` §3's examples are updated to show it. Additive: no existing field changes meaning, so nothing built against the previous shape breaks.
**Because:** `validation-strategy.md` §5 specifies that `tools/score` "joins engine output (via the API) to the key (from disk) on `(sourceSystem, sourceRowNumber)`", and §2.1 is explicit about why it must be that pair: *"The key never contains engine-assigned UUIDs — it is written before the engine has ever seen the data, so it can only reference file-position identity."* But the wire carried `transactionId` and `sourceSystem` and **not** `sourceRowNumber`, so the documented join was impossible to perform. The only endpoints exposing a row number were 24 (`population`, which lists exactly the rows *outside* the denominator) and 12 (one transaction per request — 920 round trips to score one run). Two locked documents therefore specified a measurement that the contract between them could not carry, and nothing surfaced it until U9 tried to execute it: the gap was invisible to the typechecker, to 498 passing tests, and to a careful reading of either document alone.

The field also earns its place independently of scoring. A finance controller reading an exception wants to find the row in *their own file*, and "gateway row 87" does that where a UUID does not. `transactions.source_row_number` is already `NOT NULL` for exactly this reason (schema.md §3).
**Rejected:** adding a 29th endpoint listing every transaction in a run (a contract expansion, and the frontend has no screen for it — endpoint 24 deliberately lists only the rows outside the denominator); having the scorer call endpoint 12 per transaction (920 round trips per scored run, and it would make the scale benchmark's scoring path quadratic in the thing it is measuring); having the scorer read `data/fixtures/` directly to rebuild the row-number mapping itself (it would then be joining engine output to the *files* rather than to the engine, and a parser disagreement between the scorer and the engine would silently become an accuracy figure — the scorer must measure what the engine actually produced); exposing the mapping only on a scoring-specific endpoint (a second, parallel record shape maintained for one consumer, and it would drift).
**Revisit if:** a source is ever ingested from something without stable row identity — a streamed feed, say — at which point file-position identity stops being a join key and the answer key's whole addressing scheme needs rethinking, not just this field.

### ADR-074 · Deploy early to flush environment unknowns, redeploy manually, and no CI/CD
**Decision:** The API deploys to Railway on **Day 10 (Aug 30)**, well before the engine is finished. The purpose is **not** to tick deploy off — it is to convert every unknown that only appears in a real environment into a known one while there is still time to absorb it. Redeployment stays a **manual, single-command** operation for the rest of the build, and **no CI/CD pipeline is built**. Deploy is explicitly a **repeatable gate, not a freeze**: #46, #47, #38 and #43 are all expected to land after the first deploy and each will be redeployed by hand.
**Because:** two failure modes are being avoided at once, and they pull in opposite directions.

The first is **discovering the environment late.** Nothing in this project has ever run outside a laptop. Managed Postgres connection limits and SSL modes, `NODE_ENV`/`CORS_ORIGIN` handling, migration-on-boot behaviour against a database that is not empty, cold-start latency on the poll target endpoint 4, and the plain question of whether a run completes inside the platform's request and memory limits are all unknowns that a local test cannot answer. Meeting them on the last day, when the pitch video is also due, is how a working project fails to be a submitted one. ADR-061 deferred deploy until the project ran locally *specifically so that this day would come early rather than never*; that condition has been met since Day 8.

The second is **treating deploy as a checkpoint that closes.** A deployment that is expensive or ceremonious to repeat becomes a reason not to fix things, and this build has four P1s outstanding on the day it deploys. The engine WILL change after Day 10. So the deploy has to be cheap to redo — which is a constraint on how it is set up, not a thing to bolt on later.

**Why no CI/CD.** It is complexity that buys nothing here. A pipeline pays for itself when many people push often, when a human cannot be trusted to run the tests, or when rollback must be automatic. None holds: one person, one branch at a time, a working agreement that already requires review before merge, and `npm test` in two packages as the gate. Railway deploys from a branch on demand; that is one action. Building and debugging a pipeline would spend the very hours this ADR exists to protect, and a broken pipeline on Sep 4 is a worse outcome than no pipeline at all. It is also squarely the kind of infrastructure ADR-005 parked as a separate future learning project.

The honesty cost is stated rather than hidden: **without CI, "the tests passed" is a claim about what somebody ran, not a property of the commit.** The mitigations are that both suites are one command each, daily habit 0 already requires a re-score before a day ends, and the pre-merge grep and audit passes are manual rituals that have caught more than a pipeline would have.
**Rejected:** deploying on the last day (the original Day 11 slot — it makes every environment surprise a submission risk, and there is no reason to wait now that the local run is green); deploying only once and freezing the engine (four P1s are open, three of them measured — freezing would ship a known-wrong result to protect a deployment, which is exactly backwards); building GitHub Actions CI (hours spent on a mechanism for a team of one, and it competes for the same days as the frontend); auto-deploy on push to `main` (the working agreement is that Tejas reviews and merges, so a push-triggered deploy would put unreviewed work in front of a panelist).
**Revisit if:** a second person joins the build, or the deploy stops being a single action — either would change the arithmetic that makes manual redeployment correct.

### ADR-075 · ADR-064's revisit condition was evaluated against the first measurement and is NOT met; bank↔ledger renormalisation stays rejected
**Decision:** The Tier 2 score is **not** renormalised over applicable weights. ADR-064's decision stands unchanged, now on measured evidence rather than on conservatism. Issue #47, which proposed the renormalisation as a P1, is closed as not-a-defect. This ADR exists so that the arithmetic — which is genuinely eye-catching and will be rediscovered — is recorded as **evaluated and declined**, not as pending.
**Because:** ADR-064 deferred the question with a precise revisit condition: *"the holdout run shows bank↔ledger `MISSING_IN_*` exceptions where a genuine **anchor-matched** ledger counterpart exists but never reached the review band."* The first scored run (Day 9) supplies the evidence, and it says no.

```
TRUE bank<->ledger pairs (scorable) ............... 244
  reached by the engine ........................... 178   (every one as a 3-way group's implied leg)
  never reached at all ............................  66
    of those, anchor component > 0 ................   0
  pairs sharing ANY reference value across ANY key:   0 of 66

every bank<->ledger pair scorePair accepts ....... 83,979
  anchor 0.00 (none) ............................. 83,979
  anchor 0.20 / 0.24 / 0.30 ......................      0

pairs renormalisation would lift to >= review floor:  0
```

**Zero anchor-matched bank↔ledger pairs failed to reach the review band, because zero anchor-matched bank↔ledger pairs exist.** The `0.55` weak↔weak cap and the `0.65` strong↔weak knife-edge that ADR-064 and §5.4 both describe are *theoretical on this dataset*: no bank↔ledger anchor occurs at all, so every real pair is capped at `date 0.20 + counterparty 0.15 = 0.35`, and renormalising lifts that to `0.538` — still below the `0.65` floor. The change recovers **nothing**.

The 66 unreached pairs carry **disjoint identifier namespaces** — bank has `bank_ref_no` + `utr`, ledger has `entry_id` + `invoice_no` — with no value in common across any key. That also rules out #38 as their cause: #38 is about comparing weak keys like-for-like, and these pairs share no *value* to compare.

So the engine's behaviour is correct, and refusing these pairs is the honesty property working rather than a gap: two rows with no shared identifier, **no comparable amount** (§5.3.1), and only a date and a merchant name are not something any engine should assert a match on. The 178 that are reached come through the gateway leg, which is the record that actually carries identity.

Making the change anyway would have raised bank↔ledger ceilings across the board, for zero measured gain, against a deliberate ADR whose condition was unmet — putting the strongest figure the project has (**precision 1.0000, false positives 0**) at risk in exchange for nothing.
**Rejected:** renormalising on principle because the scale is "incoherent" (it is arguably incoherent, and it is also inert — a scale correction that cannot change any decision on any pair in the dataset is a refactor wearing a P1's clothing, and it would be made *after* seeing a measurement, which is the posture ADR-027 exists to prevent); leaving #47 open as a known-unfixed P1 (a P1 marked "cannot ship" that has been proven harmless distorts every plan that reads the issue list); silently closing #47 without recording the arithmetic (guarantees rediscovery — the `0.55 < 0.65` sum is exactly the kind of thing that looks like an obvious bug on a fresh reading, which is how it got filed in the first place).
**Revisit if:** a dataset produces a bank↔ledger pair with a **shared anchor** that fails to reach the review band. That remains ADR-064's condition and it remains the right trigger. Note it is a property of the DATA, not of the code — a generator change that gives bank rows a ledger-comparable identifier would make it live immediately.

### ADR-076 · S10's wiring decisions: batch groups carry `tier = 'batch'`, splits run before batches, and a size-1 subset is not a batch
**Decision:** Wiring S10 (issue #46) required four calls that no document made. Each is recorded here because the code alone cannot argue for them.

1. **A batch or split group's `tier` is `'batch'`, not `'fuzzy'`.** `matching-engine.md` §8's outcome table says `tier = fuzzy`; the `matches.tier` CHECK constraint (migration 004), `schema.md` §11.1's `tier_attribution` example, `TIER_RANK` in `group-assembly.ts` and the answer key's own `viaTier` all say `batch`. Three artifacts and the database schema against one sentence, and the sentence is very likely older than the enum value. Reporting `fuzzy` would also break ADR-072's tier diagnostic permanently: the key carries 77 `viaTier: batch` pairs, and the engine would report `batch: 0` forever with no way to tell a fall-through from a mis-labelled stage.
2. **Split settlements (§8.1) run before batch decomposition (§8), over the pool splits do not consume.** The two rules are duals competing for the same records, so the order changes the output. Splits go first because their evidence is identity-bearing — `findSplitSettlement` admits a leg only on a shared strong anchor, or on the gateway's own settlement window with a non-contradicting counterparty, and then demands exactly one arithmetic solution. Batch decomposition is pure arithmetic over a date-and-counterparty pool with no anchor requirement. The engine is ordered identity-before-similarity at every other stage (S6, S7, S8, then S9); running arithmetic inference ahead of anchor-backed evidence would invert that inside one stage.
3. **`decomposeBatch` requires a subset of at least 2.** `searchSubsetsInBand`'s own docstring already gives the reason, applied to the split search: *"a size-1 solution is an ordinary 1:1 match that belongs to the tiers, not to this stage."* The batch path never passed the minimum, and the consequence was invisible until the stage was wired: S10 produced a one-payment "decomposition" for a pair Tier 2 had already scored and declined — **S10 overruling S9 on strictly weaker evidence**, since the batch pool requires no anchor at all. A stage that may only extend the engine's output must not be able to re-decide it.
4. **`UNSPLITTABLE_BATCH` is claimed only when the candidate pool held at least 2 payments.** ADR-038 is that the engine may call a batch unsplittable only after genuinely trying to split it. A search over fewer than two candidates is not a genuine attempt at a *batch* — it is the observation that there was nothing to combine, which the presence categories already say better and more precisely. Credits below the floor are still searched and still counted; they simply produce no batch verdict. Without this, wiring S10 would have relabelled every unmatched settlement credit on the holdout — 69 of them — as `UNSPLITTABLE_BATCH`, replacing accurate `MISSING_IN_GATEWAY` exceptions with a proof the engine had not performed.

**Because:** all four are the same principle in different clothes — **a stage may only claim what it actually established.** (1) is about not lying to a diagnostic, (2) about not letting arithmetic outrank identity, (3) about not re-deciding a settled claim, and (4) about not dressing an absence up as a proof.
**Rejected:** `tier = 'fuzzy'` per §8's literal text (leaves the `batch` enum value dead, breaks ADR-072's diagnostic, and contradicts three other artifacts including the schema); batches before splits (arithmetic ahead of anchors); allowing size-1 decompositions (S10 silently re-deciding S9's declines); raising `UNSPLITTABLE_BATCH` on every unmatched settlement credit regardless of pool (69 over-claims on the holdout, and it would make the category's precision meaningless).
**Revisit if:** `matching-engine.md` §8's `tier = fuzzy` is ever restated deliberately rather than inherited, or S9 and S10 are given a way to negotiate a shared record — see the pool-eligibility issue, which is the real remaining cost of this stage.

### ADR-077 · Rule 3's cardinality exception is DECLARED by the rule, and a net batch may not merge into an existing group
**Decision:** §10 rule 3's stated exception — *"`many_to_one` and `one_to_many` groups are the sole exception: multiple members of one role are legitimate there, and only there"* — is implemented (#45), with two constraints that are the whole safety of it.

1. **The exception is DECLARED, never inferred.** `GroupPair` gains `mayDuplicateRole`, set only by a rule that ASSERTS a cardinality — today `SPLIT_SETTLEMENT_V1` — naming the single role it may duplicate. If the assembler instead admitted any merge that happened to produce N:1, rule 3 would be toothless: every ambiguous second candidate would quietly become a "many_to_one group" instead of an `AMBIGUOUS_MATCH`, which is the exact failure rule 3 exists to prevent.
2. **Split settlements merge; net batches do not.** A split is ONE gateway payment across N bank credits, so its group is one economic event and every pair it implies is a true pair. A net batch is the opposite shape: N payments share one credit, each payment has its own ledger row, and merging a batch into the existing groups would fuse N economic events into one — making every implied pair ACROSS those events (gateway₁ with ledger₂, and so on) a pair the answer key denies. Verified on the key: **no source row belongs to more than one event**, so a fused group is guaranteed to manufacture false pairs. Batch decompositions therefore stay atomic groups over wholly-unclaimed records; a decomposition whose members are already grouped is refused, counted and named.

**Because:** the cluster-merge branch in `assembleGroups` was unreachable before this (#45's second half — two clusters over three roles always collide by pigeonhole), and it silently dropped `cb.pairs`. Making same-role merges legal makes that branch live, so the two changes had to land together: without the fix a weak `pending_review` pair absorbed into a strong cluster would vanish from the merged group's confidence, tier AND status, which is precisely the laundering rules 4 and 5 exist to prevent.

Measured on the holdout: 7 `one_to_many` groups form, 18 split legs are recovered, pair recall rises **658 → 694**, and **cross-source invented pairs stay at 0**.
**Rejected:** inferring the exception from the resulting shape (rule 3 becomes unenforceable); allowing batches to merge (a false-positive factory, for a cardinality that never resolves on this dataset anyway); emitting split legs as a pre-formed group like batches (the gateway is usually already in a `[gateway+ledger]` group, so a competing group would be refused and the legs lost — pairs are what let them join the group that exists).
**Revisit if:** a resolvable `many_to_one` batch ever needs to form over records that are already grouped. That needs the implied-pair problem solved — grouping must then express "these records share a bank leg" without asserting they are one event — and it is a data-model change, not a rule change.

### ADR-078 · `UNSPLITTABLE_BATCH` is claimed only when the credit exceeds every available candidate
**Decision:** S10 produces a batch verdict for S12 only when the credit's own pool holds **at least one** candidate AND the credit's amount **exceeds the largest single candidate's expected contribution**. Credits failing either test are still searched and counted; they simply produce no batch verdict, and the presence categories describe them.
**Because:** §8 defines the case as *"the net of MANY gateway payments"*, and a credit that one available payment could account for on its own is not that — it is an ordinary 1:1 whose match failed for another reason. Without the size test, wiring S10 relabelled **17 credits across 15 events as `UNSPLITTABLE_BATCH`, of which one was a designed batch — precision 0.067** — with fourteen `TIMING_LAG_NORMAL` settlements recast as batch failures. The category reading `0.000` because the stage never ran is an honest absence; reading `0.067` because the stage answers a question nobody asked is worse, and in a published table it would have looked like progress.

The first attempt required **two** present candidates and was wrong for a subtler reason worth recording: §4's `UNSPLITTABLE_NET_BATCH` is a credit netting payments *"with no breakup file provided"*, and the generator proves unresolvability over the payments that ARE available — which on this dataset is often one. **A floor of two demands the very evidence whose absence defines the scenario.** With one candidate plus the size test, the category measures **precision 1.000, recall 0.500** (3 of 6 designed batches, zero false claims); the three misses are named — two credits whose window holds no candidate at all, one whose only candidate is larger than the credit.
**Rejected:** no shape test (precision 0.067); a two-candidate floor (contradicts §4's own definition of the case); tuning the floor until recall improved (that is tuning against `HOLDOUT_SEED`, and the size test is arguable from §8's wording without any number).
**Revisit if:** §8's definition of a batch changes, or a dataset appears where a genuine batch's constituent payments are all present — the size test still holds there, and the candidate floor stops binding.

### ADR-079 · Inside the split rule, identity comes before arithmetic — and a bank role is OPEN until it is ACCOUNTED FOR, not until it is non-empty
**Decision:** Two changes to S10's split-settlement pass (§8.1), which have to land together because either alone leaves the same events half-assembled (issue #51).

1. **A gateway record is offered to the split pass while its bank role is OPEN — empty, OR filled by legs that sum SHORT of the payment's expected net.** The shipped predicate was `!hasCounterpartIn(record, 'bank')`, i.e. *does this payment have A bank leg?*, asked about the one rule in the engine whose entire subject is having **more than one**. The moment S9 accepted any single leg of a split, the payment left the pool and `findSplitSettlement` was never asked about the rest. The legs S9 already found are included in the search pool, so the sum the search must reach is the whole payment; and the one solution must **contain** every already-matched leg, or it is a second competing claim about a record rather than an extension of the engine's output.
2. **Legs that carry the payment's own reference are the split; arithmetic then proves the sum rather than choosing the members.** Leg admission now tests `sharedStrongAnchor` **or** `sharedReferenceValue` — the cross-key notion #38 established, extracted into `anchors.ts` so S9 and S10 cannot drift. Where two or more admitted legs are reference-bearing and their sum lands in the expected-net band, that set is the split. Otherwise the existing subset search runs unchanged.

**Because:** §8.1 in its own words is *"group unmatched bank credits **sharing an anchor with the gateway record** (or falling in its window with the same counterparty), and accept when **their sum** lands in the expected net band."* The shipped implementation could never execute the first clause: `sharedStrongAnchor` compares structured strong keys like-for-like, **bank rows carry no structured strong anchor at all** (AUDIT-1), so on real data that test was always null and every leg was admitted on the window alone. §8.1's anchor clause had never once fired.

The consequence was not academic. Both split settlements the engine failed to assemble had four and three legs each carrying the gateway's `settlement_id` in their description **and** its `rrn` in `bank_ref_no`, summing **exactly** to the expected net — and both were refused as ambiguous, because dropping a 2-paise leg (or adding an unrelated same-window credit) also lands inside a ±100 paise tolerance band. **The tolerance that exists to absorb fee rounding was deciding membership**, and the reference number that answers the question was never read. This is the engine's own identity-before-similarity ordering (S6, S7, S8, then S9) restored inside a single stage.

A third change follows from rule 3 and is not optional: **every leg of a split is emitted as a pair, including one a tier already matched, and that tier pair is superseded rather than left beside it.** §10 rule 3 admits several members of one role only through pairs that DECLARE the exception (ADR-077), so a non-declaring fuzzy `gateway↔bank` pair sitting next to three declaring ones is refused as an `AMBIGUOUS_MATCH` and its leg is thrown out of the very group the stage just proved. Measured: that dropped `bank:290` and `bank:253` from the two splits. Superseding is not S10 re-deciding S9 — the relationship survives unchanged, and only its rule id and tier move, from a fuzzy score on one leg to an arithmetic proof covering all of them.

Measured on the holdout: split events fully assembled **7/9 → 9/9** at the group level (**8/9** end to end, the ninth short one ledger row that no tier ever matched), match members **784 → 789**, pair-level found-at-all **641 → 648 of 716 (89.5% → 90.5%)**, exceptions **214 → 212**, `MISSING_IN_GATEWAY` **58 → 53**. **Precision 1.0000, false positives 0, `unresolvableRecall` 1.0, classification unchanged in every cell.**
**Rejected:** subtracting matched legs from the target and searching for the remainder (assumes the existing leg belongs to this split instead of proving it); accepting the subset-search solution closest to exact (a tie-break invented to make a number move, which ADR-027 forbids and which would fire on window-only pools where nothing establishes membership); putting `sharedReferenceValue` beside `sharedStrongAnchor` without the warning block (it would invite S4/S6/S7/S8 to treat a coincidental `bank_ref_no` as identity, which is the one thing it must never be); leaving the absorbed tier pair in place (rule 3 refuses it and the leg falls out of the group); requiring the anchored set to be exhaustive rather than merely sufficient (a leg the bank failed to reference would then sink the whole split).
**Revisit if:** a dataset appears where reference-bearing legs sum into the band but do **not** constitute the settlement — the arithmetic proof would pass on a set identity chose wrongly. On this holdout the anchored set sums to the expected net **exactly**, not merely within tolerance, in both events; if that stops being true, the band is doing work it was not meant to do and the rule needs a stricter test than "inside tolerance".

### ADR-080 · The LLM provider is Google Gemini, on the free tier, with two models and a REQUESTS bound
**Decision:** Both LLM surfaces — the S13 explain layer and the Analyst's Phase A loops — call the **Gemini API** via `@google/genai`, with one `GEMINI_API_KEY`. Two models, chosen from Google's own descriptions rather than from a benchmark:

| Surface | Model | Why |
|---|---|---|
| S13 explain | `gemini-3.5-flash` | Bounded JSON generation, ≤8 calls per run (§10.3), schema-constrained. The output is *prose a panelist reads*, so quality matters more than latency at this volume. |
| Phase A investigate + Q&A | `gemini-3.7-flash` | Google's description is *"built for complex coding, agentic workflows, and reliable multi-step execution"* — which is the investigation loop's job description. |

`temperature: 0` on both. Structured output via `response_format: { type: 'text', mime_type: 'application/json', schema }`; tool use via the Interactions API's `tools` / `function_call` / `function_result` steps.

**Because:** there is no Anthropic API key available for this build, and Gemini's free tier covers every Flash model. That is the whole reason, and it is worth writing down plainly rather than dressing up as a technical preference — the previous choice (`claude-sonnet-5`, ADR-019) was not wrong; it was unavailable.

**Four consequences that are NOT cosmetic, and each changes something:**

1. **The cache key already handles it.** ADR-018 hashes `model` into `signature_hash` precisely so a model change cannot silently serve prose written by a model no longer in use. Switching provider invalidates `explanation_cache` correctly and automatically. No migration, no manual purge — the mechanism was built for this and this is its first exercise.
2. **`AGENT_MAX_COST_USD_PER_RUN` stops being the binding bound, and a run-level REQUEST bound replaces it.** ADR-057's cost ceiling protects a credit card. A free-tier key has no bill to cap, and its scarce resource is **requests per day**. A ceiling of $1.00 is satisfied by a run that exhausts the entire daily quota and leaves the demo dead for the rest of the day — on submission day, that is the failure that matters. `AGENT_MAX_LLM_REQUESTS_PER_RUN` (default **220**) is counted and enforced whether or not the key is billed: 20 investigations × ~10 steps, plus headroom. Cost is still tracked and still reported; it is no longer the thing standing between the demo and a dead quota.
3. **Free-tier content is used to improve Google's products** (stated on Google's pricing page). For the explain layer this is already a non-issue and by construction rather than by luck: ADR-018 sends **only the signature** — category, bucketed deltas, source presence, anchor strength — with *no amounts, no ids, no merchant names*. Phase A is different: tool results carry real record data, and a production deployment on real money would need a paid tier. This dataset is synthetic, which makes the free tier acceptable **here** and nowhere else, and that distinction belongs in the submission rather than in a footnote.
4. **Prompt caching is not assumed.** ADR-019 and `agent-design.md` §8 both lean on "a cacheable static prefix" for cost. Anthropic's explicit prompt caching is not what Gemini offers, so **no design may depend on it.** The bounds in §8 hold on their own — they are step, tool-call, wall-clock and request ceilings, not cost estimates — and the explain layer's economy comes from ADR-018's signature collapse (≈75 exceptions → 15–30 signatures → ≤8 calls), which is a property of the batching, not of any provider's caching.

**On free-tier rate limits specifically:** Google's rate-limit page defers to AI Studio for per-key numbers and third-party summaries disagree with each other, so **no RPM/RPD figure is written into these docs**. The design deliberately does not depend on one: the explain layer is capped at 8 requests per run, and Phase A at 220. If a quota is hit, both layers already have honest degradations — `explanation_source = 'template'` and `INSUFFICIENT_EVIDENCE` with `budgetExhausted` — rather than a failed run.
**Rejected:** one model for both surfaces (the two tasks have genuinely different shapes, and the config cost of two lines is nothing); a Pro-tier model for the Analyst (no free tier, and §8's bounds matter more than reasoning depth for a 10-step loop over deterministic tools); keeping `ANTHROPIC_*` env names with a Gemini key behind them (a variable that lies about its provider is the kind of small dishonesty that costs an hour six weeks later); writing an RPD number into the docs from a blog post (an unverified number in a locked document is worse than a stated absence).
**Revisit if:** an Anthropic key becomes available — the switch back is `GEMINI_*` → provider-neutral env names plus a client swap, and ADR-018's model-in-the-hash makes the cache handle it for free; or the project moves to a paid tier, at which point consequence 3's privacy caveat and consequence 2's request bound both relax.

### ADR-081 · The Analyst triages the review queue too — as evidence, never as a recommendation
**Decision:** A1 selects **two** work lists. The existing one is exceptions. The new one is `pending_review` matches, ordered by `confidence ASC, amount_at_risk_paise DESC, (source_system, source_row_number) ASC`, capped at `AGENT_MAX_QUEUE_TRIAGES_PER_RUN` (default 15), run **after** exceptions and cut first if the request budget binds. A2 gains a `CORROBORATE` mode — 6 steps, 8 tool calls, `rerun_subset_search` excluded — whose verdicts are `CORROBORATED` / `CONTRADICTED` / `NO_NEW_EVIDENCE`.

**The agent never recommends confirming or rejecting a match.** It reports what evidence exists beyond the score, with citations the A3 gate verifies. A human still clicks, through `PATCH /api/matches/:id`. Zero new write endpoints, again.

**Because:** the exception list is the graded feature, but it is not the bigger pile. A holdout run leaves **71 pending groups covering 214 records — 24.5 points of the reconcilable population**, every one of them a proposal the engine found and correctly declined to auto-confirm, at a measured **review-queue precision of 1.0000 over 213 judged pairs**. Until this ADR nothing in Phase A looked at them, and the agent's entire addressable market was the 87-event false-despair set. That was an accident of framing — Phase A was designed against the exception queue because the exception queue is what the track names — not a decision anyone made.

It also resolves an asymmetry worth stating plainly. An Analyst proposal a human accepts becomes a `manual` match, which ADR-043 and ADR-051 exclude from the engine match rate — deliberately, so a language model cannot inflate a number that measures deterministic rules. A **pending match** a human confirms becomes `human_confirmed`, which ADR-040 **does** count. So this is the one Analyst surface that can move the headline, and the only mechanism by which it moves it is *making a human faster*. Nothing the agent outputs enters the decision.

**Why the verdict vocabulary is about evidence and not about the match:** `CONFIRM_RECOMMENDED` was the obvious shape and it is the wrong one. A model that answers "should this be confirmed?" fifteen times is being asked to decide, whatever the field is called, and the first time a reviewer trusts it the accuracy claim is gone. Asking instead "is there evidence the scorer did not use?" is a question the agent can answer from tools alone, and its answer is checkable — `CORROBORATED` must cite a `get_transaction`, `score_pair` or `get_audit_trail` result that the A3 grounding gate confirms was actually retrieved. `NO_NEW_EVIDENCE` exists for the same reason `NEEDS_EXTERNAL_DATA` does: an agent asked fifteen times whether there is more evidence, with no way to say *no*, will find some.

**Measured, and one of the two metrics is unusually sharp:** queue corroboration precision (of `CORROBORATED` pairs, how many the key confirms) and **false alarms** (`CONTRADICTED` on pairs the key confirms). Because the queue's engine-side precision is currently a clean 1.0000 over 213 judged pairs, **every `CONTRADICTED` verdict is measurably a false alarm** — there is no ambiguity to hide in. A rising count means the agent is manufacturing doubt to look useful, and it is visible immediately.
**Rejected:** `CONFIRM_RECOMMENDED` / `REJECT_RECOMMENDED` verdicts (a decision wearing a recommendation's clothes; ADR-017); auto-confirming high-corroboration matches (the same objection ADR-051 already rejected, and worse here because it would move the headline); ordering the queue by confidence DESC (the strongest proposals need the least help — the point is to spend agent budget where a reviewer's own time would go); one shared cap across both work lists (the exception list would starve on a run with a large queue, and the exception list is what is graded); a separate agent or a separate loop (same tools, same gate, same bounds — this is a mode, not a system).
**Revisit if:** the queue's engine-side precision stops being ~1.0 — the false-alarm metric assumes it, and on a dataset where the engine's proposals are genuinely mixed, `CONTRADICTED` becomes informative rather than diagnostic and needs scoring against the key directly.

### ADR-082 · The hash formula excludes THREE fields, not two — `sequence_no` joins `prev_hash`/`entry_hash`, and the exclusion is now stated identically everywhere
**Decision:** `entry_hash = sha256(canonical_json(entry minus sequence_no/prev_hash/entry_hash) || prev_hash)`. `schema.md` §9.0, migration 007's comment and this ADR now all name the same three excluded fields; none of the three previously agreed with `hash-chain.ts`'s `strip()`, which was already correct.
**Because:** an isolated audit (#25) found ADR-042's original wording, `schema.md` §9.0 and migration 007's comment all said **two** fields were excluded, while `hash-chain.ts:132-137`'s `strip()` — the code actually run at verification — excludes **three**: `sequence_no` is dropped alongside `prev_hash`/`entry_hash`, for a sound reason none of the three documents stated (it is `BIGSERIAL`, assigned by Postgres at INSERT, so it does not exist yet when the hash must be computed, and the append-only trigger forbids adding it afterward). Publishing the formula is the point of writing it down at all — a finance panelist or an independent verifier implementing it from `schema.md` alone would include `sequence_no` and get a total mismatch on every entry. The same audit also found `hash-chain.ts`'s own file-header self-contradictory: it says "TWO fields are deliberately outside the hash" and then names `sequence_no` and `occurred_at` as the two, while the paragraph about `occurred_at` immediately says it **IS** hashed. Only `strip()` was ever right; the prose around it, in four different places, was not.
**Rejected:** Leaving `occurred_at` out of the hash to make "two fields" true (it must stay hashed — a DB-side `now()` default would be unknown at hash time, per ADR-042's own reasoning about `occurred_at`); treating this as a code bug and changing `strip()` to match the docs (the code was the one correct artifact; ADR-021's discipline of "docs are right until an ADR says otherwise" does not protect a doc that was simply wrong from the start).
**Revisit if:** never — this is a correction to match already-correct, tested behavior, not a new design choice.

### ADR-083 · The ambiguity guard runs BEFORE assignment and blocks the slot — `matching-engine.md` §7.3 corrected to match `schema.md` §5.4 and the code
**Decision:** `assignment.ts`'s order is: compute ambiguity from the scored candidate list first, exclude ambiguous `(record, targetSource)` slots from assignment, then walk the sorted list. An ambiguous record never consumes a slot and is never assigned a winner. `matching-engine.md` §7.3 now states this order; `schema.md` §5.4 ("the engine must not pick one") already did.
**Because:** an isolated audit (#10) found the two binding docs directly contradicted each other. `schema.md` §5.4 said no assignment happens for an ambiguous record; `matching-engine.md` §7.3 step 4 said the guard runs AFTER assignment and raises `AMBIGUOUS_MATCH` "even if step 3 happened to assign it one of them" — i.e. a record could be both matched and flagged ambiguous at once. The code (`assignment.ts:168-181`, unchanged by this ADR) has always followed `schema.md`: ambiguity is computed first and ambiguous slots are blocked before the assignment walk runs at all, precisely so a blocked slot's rivals in the OTHER source stay available rather than being displaced by a pair that will not survive. Two binding docs may not disagree (CLAUDE.md §3) — a future session reading the stale `matching-engine.md` text would have "fixed" the code to match it and lost the guard `schema.md` and the code both already implement correctly.
**Rejected:** Changing the code to match the stale `matching-engine.md` text (assign first, then revoke) — the module's own comment already argues this correctly: revoke-after-assign frees slots mid-walk and needs a second pass whose result depends on revocation order, which breaks determinism (ADR-032).
**Revisit if:** never — a documentation correction, not a design change.

### ADR-084 · Template explanations are NEVER written to `explanation_cache` — only fresh model output is cached
**Decision:** S13 writes a row to `explanation_cache` only when the text came from a live model call (`explanation_source = 'llm'`). Text produced by the hand-written per-category template is attached to the exception and audited as `EXPLANATION_FALLBACK_TEMPLATE`, but is never persisted to the cache. A cache hit therefore always means "a model wrote this once, for this exact signature".
**Because:** the cache is keyed by signature and is deliberately **run-independent** (`schema.md` §1) — it outlives the run that wrote it, which is the entire point of ADR-018's economy. A template row would therefore be served as a HIT by every later run **including runs that do have an API key**, and that signature would never be sent to a model again. This build has no `GEMINI_API_KEY` today (ADR-080), so the very first keyless run would have poisoned the cache for all 21 of the holdout's signatures, permanently, and the day a key was finally added the explain layer would have silently kept serving templates with `explanation_source = 'llm_cache'` — prose labelled as model output that no model ever wrote, in the artifact a panelist reads. Nothing in the output would have said so. The alternative costs nothing: a template is free, deterministic, and recomputable from the category alone, so there is no expense to amortise and no reason to store it.
**On the schema comment this declines to follow:** `explanation_cache.tokens_in` is annotated *"NULL for template-sourced rows"*, which implies template rows were once expected in the table. That comment describes a column's **nullability** and is satisfied by any non-model row a future path might cache; it does not require this one, and `schema.md` §10 states no rule that a template must be cached. Recorded as an ADR rather than a silent implementation choice precisely because the comment reads the other way — a future session finding template text absent from the cache should find the reason here rather than "fixing" it.
**Also decided here, same mechanism:** a cache HIT reports `tokensIn`/`tokensOut` as `null` for the current run rather than carrying the cached row's counts forward. Those tokens were spent by the run that paid for them; re-billing this run would make the cache appear to have saved nothing, inverting the number ADR-018 exists to demonstrate.
**Rejected:** caching templates with a `source` discriminator on the row and skipping them at lookup (the row then exists only to be ignored, and the first person to write a lookup that forgets the discriminator reintroduces the bug); clearing template rows when a key appears (a repair for a problem better not created, and it would need to know which rows were template-sourced anyway).
**Revisit if:** template text ever becomes expensive to produce — e.g. if templates were themselves generated per-signature rather than written by hand. Then it is a cache like any other, and the poisoning concern returns as a `prompt_version` question instead.

### ADR-085 · `rerun_subset_search` widens the NODE budget, never a time budget — the agent cannot choose a wall clock
**Decision:** the Analyst's `rerun_subset_search` tool takes `{ bankTransactionId, poolSize, maxSubsetSize, nodeBudget }`, bounded by hard ceilings the agent cannot exceed: **pool ≤ 64, subset ≤ 10, nodes ≤ 5,200,000**. `budgetMs` is **not** an argument. The 2,000 ms wall clock stays exactly what ADR-060 made it — a safety valve on the engine's own config, not a bound anyone selects. `agent-design.md` §4's tool row is corrected accordingly, along with its stale description of the search as "meet-in-the-middle" (ADR-060 replaced that with depth-first + prefix pruning).
**Because:** §4 as written let the agent pass a `budgetMs`, which would have made the wall clock the operative bound **inside the evidence a reasoning chain cites**. `searchExhausted` and `searchBoundExceeded` are different claims *about the data* — "no combination exists" versus "I ran out of room" — and ADR-060 exists precisely because letting a clock decide between them makes the claim a property of the hardware. The Analyst is the last place that defect can be tolerated, because §5's entire payoff is the *upgrade*: a failed investigation is a win only if "exhaustive at wider bounds" means something a second machine would reproduce. Under a time budget it would not: the same credit on a slower box reports the weaker claim, and the agent's transcript would record a conclusion that a re-run contradicts.
**On the ceiling, and why it is 5,200,000 rather than a round number:** at agent bounds the declared space is subsets of size 0..10 drawn from ≤64 candidates, whose combinatorial ceiling is far beyond any budget — so unlike ADR-063's engine figure, this one **cannot** be a proof of dominance and is not claimed as one. It is derived from the opposite constraint: **the node budget must be small enough that the wall-clock valve never fires**, or the valve silently becomes the bound and the machine-dependence returns through the back door. The engine's ~1.08M-node worst case measures well under 50 ms locally (ADR-063), so ~5.2M is under ~250 ms — an 8× hardware margin against the 2,000 ms valve. `SearchStats.exhaustive` remains a truthful per-input runtime flag: when pruning finishes the declared space inside the budget, "exhaustive at pool 48 / subset 8" is a real claim about that credit, and when it does not, the agent reports `boundHit: { bound: 'nodes' }` — which is still strictly better evidence than the engine's `bound: 'pool'`.
**Rejected:** keeping `budgetMs` and documenting the caveat (a caveat does not make a machine-dependent claim reproducible, and the transcript is the artifact a judge reads); sizing the node ceiling to dominate the declared space (impossible at 64/10 — `C(64,10)` alone is ~1.5e11); removing the wall-clock valve now that nodes bound the search (it protects against a node becoming expensive, which is exactly the case a node count cannot see).
**Revisit if:** the ceilings move. Any increase to `poolSize`/`maxSubsetSize`/`nodeBudget` must re-check the same inequality — worst-case node cost must stay well inside the valve — because the moment the valve can fire, `exhaustive` stops being reproducible.

### ADR-086 · Phase A's Gemini model is `gemini-3.6-flash`, not `gemini-3.7-flash` — measured, not described
**Decision:** `GEMINI_AGENT_MODEL` defaults to **`gemini-3.6-flash`**. ADR-080's choice of `gemini-3.7-flash` for the Analyst is superseded. Every other part of ADR-080 stands: the provider is still Gemini, `gemini-3.5-flash` remains the S13 explain model, one key still serves both surfaces, and the request-bound reasoning in consequence 2 is unchanged.
**Because:** ADR-080 picked `gemini-3.7-flash` from Google's own *description* of it — *"built for complex coding, agentic workflows, and reliable multi-step execution"* — which is a job description, not a measurement. Measured on this key, with the prompt `Reply with the single word: ok`:

| Model | Latency |
|---|---|
| `gemini-3.6-flash` | **2.4 s** |
| `gemini-3.7-flash` | **53 s** |
| `gemini-3.7-flash`, `thinkingBudget: 0` | **63 s** |

Disabling thinking made it *slower*, so this is capacity or queueing on the free tier rather than reasoning depth. **The contradiction is not a preference — `agent-design.md` §8 bounds an ENTIRE investigation at 60 seconds, and a single turn on 3.7 exceeds the budget for the whole investigation.** A ten-step investigation would need roughly nine minutes. The model ADR-080 selected cannot satisfy the spec ADR-080 sits beside, and neither document noticed because neither number had been measured.
**How it was found:** the first live investigation aborted on its first turn against my own 90 s per-turn client timeout. Isolating it — a bare call with no tools, no history and no schema — reproduced the hang, which ruled out the tool declarations and the prompt and left the model name.
**The rule this is the third instance of, in one day:** the 20 s explain timeout, the ceiling-charging triage budget, and now this were all plausible numbers with nothing measured behind them. Every *engine* bound in this repo is derived — ADR-063's node budget is a proof about the declared space, ADR-085's ceiling is derived from the valve it must not trip — and every bound around the *model* was a guess. The asymmetry was invisible because the engine's numbers get scored daily and the model's did not.
**Rejected:** raising §8's 60 s bound to accommodate 3.7 (the bound exists to stop an unbounded loop on a public demo, and stretching a safety bound to fit a slow model inverts what the bound is for); keeping 3.7 and accepting one-turn investigations (an agent that cannot take a second step is not an agent); `gemini-3.5-flash` for both surfaces (untested for tool use here, and one model for two differently-shaped jobs was already rejected in ADR-080).
**Revisit if:** the provider changes — the pending `swap-for-anthropic-api` branch replaces this choice entirely, and this ADR's real contribution is the requirement that **the replacement model's per-turn latency is measured against §8's bound before it is adopted**, not read off a description.

### ADR-087 · Corroborations get their own table and their own verdict vocabulary — `agent_corroborations`, not a widened `agent_investigations`
**Decision:** A2 CORROBORATE persists to a new table, `agent_corroborations` (migration 013), keyed on `match_id`, with verdicts `CORROBORATED | CONTRADICTED | NO_NEW_EVIDENCE` and **no `proposed_action` column at all**. `agent_investigations` is untouched. The A3 gate gains `validateCorroboration`, which reuses `checkGrounding` verbatim and differs only in its schema check.
**Because:** ADR-081 added the review queue as a second work list after migration 010 was written, and `agent-design.md` §11 still says "two tables" from before that. So where a corroboration lives was never specified, and the schema could not hold one: `agent_investigations.exception_id` is `NOT NULL` and its verdict CHECK lists only the four investigation verdicts. Three reasons the answer is a new table rather than a widened one:

1. **The verdicts are not comparable.** An investigation answers *"can this exception be resolved?"*; a corroboration answers *"is there evidence beyond the score?"*. Putting `CORROBORATED` in the same column as `RESOLUTION_PROPOSED` invites a `GROUP BY verdict` that counts them together, and §7's grounding and hallucination figures are claims about **investigations** — diluting them with corroborations would quietly change what the honesty metric measures.
2. **Widening weakens two existing guarantees for every existing row.** `exception_id NOT NULL` and the `ux_inv_exc_active` partial index are load-bearing; making the column nullable to admit match-scoped rows relaxes both permanently, to serve rows that are not investigations.
3. **The absent column is the enforcement.** §3 is emphatic: *"The Analyst does not recommend confirming or rejecting a match. It never says 'confirm this'."* A table with nowhere to put a recommendation cannot carry one. That is a structural guarantee rather than a rule someone must remember — the same move as the read-only tool registry (ADR-051) and `withReadOnlyTransaction`.

**On sharing the gate:** `validateCorroboration` reuses `checkGrounding` unchanged — the citation rule, the "cites a tool it never called" rule, and the digest checksum are the substance of A3, and a second copy tuned for corroborations would drift while both copies kept passing their own tests. Only the schema differs, because only the vocabulary differs. A corroboration arriving **with** a `proposedAction` is REFUSED rather than stripped: stripping it would hide that the prompt has drifted into asking for a recommendation.
**On the downgrade target:** a rejected corroboration becomes `NO_NEW_EVIDENCE`, never `CONTRADICTED`. `CONTRADICTED` is a positive claim about evidence *against* a match; a gate failure is an absence of evidence, not evidence of absence, and downgrading into it would manufacture a finding out of a rejection.
**Rejected:** widening `agent_investigations` (all three reasons above); a shared `agent_verdicts` supertable (a join for every read, to unify two things the design spends its effort keeping apart); putting corroborations only in `audit_log` (ADR-052 puts the *trace* there, but endpoints 26/27 and §7's metrics need a queryable row).
**Revisit if:** the UI ever needs one merged feed of Analyst output. That is a read concern and a `UNION ALL` view answers it without collapsing the two vocabularies into one column.

### ADR-088 · `countsTowardEngineMatchRate` is governed by ADR-040 — the wire field is corrected to match, not the other way around
**Decision:** `serialize.ts`'s `countsTowardEngineMatchRate` becomes `tier !== 'manual' && (status === 'auto_confirmed' || status === 'human_confirmed')`, replacing `tier !== 'manual' && status !== 'human_rejected'`. `api-contract.md` §3 and `matching-engine.md` §7.4 now cross-reference each other and state explicitly that the two must never disagree about which statuses count toward the engine's match rate.
**Because:** the old predicate admitted `pending_review` — a match is a *proposal* the engine has not auto-confirmed and a human has not yet acted on, and ADR-040 already excludes it from `matched_records` for exactly that reason. On the Day 9 holdout run the two readings diverged by 11.3 points from the same data (57.09% from §7.4 vs 68.42% summed over the old wire field) — a panelist could read the browse list and the headline on the same screen and see two different match rates, which is the specific overstatement this project's honesty thesis exists to refuse. Filed as #43; this is resolution A from that issue (make the field mean what its name says), not resolution B (rename it) — the field's name is already a claim about ADR-040's number, so the cheaper fix is to make the claim true rather than to weaken the name.
**Rejected:** resolution B, renaming the field and adding a second, §7.4-conformant one alongside it — more surface for the same information, and the removed predicate (`tier !== 'manual' && status !== 'human_rejected'`, i.e. "not a manual match and not rejected") had no other consumer once `countsTowardEngineMatchRate` itself was corrected, so nothing was lost by not preserving it under a new name.
**Revisit if:** never — this is a correction to match ADR-040, not a new definition.

### ADR-089 · The grounding gate's negative space closed — `NEEDS_EXTERNAL_DATA`, `CREATE_ALIAS`, and the alias contradiction check (#58)
**Decision:** Three additions to `grounding-gate.ts`, all defaulting toward rejection per the file's own stated standard: (1) `NEEDS_EXTERNAL_DATA` joins `RESOLUTION_PROPOSED`/`CONFIRMED_UNRESOLVABLE` in requiring a non-empty reasoning chain — it can no longer be reached with zero tool calls. (2) A `CREATE_ALIAS` proposal's `rawValue` and `canonicalValue` must each appear as a `check_alias`/`search_transactions` call *argument* this investigation actually made (case- and whitespace-normalized through a new shared `normalizeAliasValue`), not merely be well-shaped strings. `MARK_WONT_FIX` is deliberately exempted — it carries no id or value to ground, only a rationale a human reads. (3) The alias-contradiction lookup in `checkConstraints` now normalizes `action.rawValue` through the same `normalizeAliasValue` before comparing against `activeAliases`, which is keyed by the already-normalized value; `check_alias` in `tool-registry.ts` now calls the same function instead of its own inline `.trim().toUpperCase()`.
**Because:** all three were reachable on the built gate before this — `NEEDS_EXTERNAL_DATA` with literally zero tool calls, `CREATE_ALIAS` with two invented strings nothing had retrieved, and a contradicting alias slipping past the one check written to catch it because `"amazon seller services"` compared unnormalized against `"AMAZON SELLER SERVICES"`. All three are the same shape as #19's earlier fail-open defects in this file: a check that exists on paper but does not fire on the case it exists for.
**Rejected:** grounding `CREATE_ALIAS`'s values against tool *results* rather than *arguments* — `ToolCallRecord` persists `returnedIds`, `resultDigest` and `arguments`, never the full result payload, so a result-based check would need a broader change to what the investigation loop records, which is out of this issue's scope; requiring `MARK_WONT_FIX` to cite something — there is nothing of substance to cite, and requiring one would just train the model to invent a citation to satisfy the gate.
**Revisit if:** `ToolCallRecord` ever gains the full tool result (not just its digest and returned ids) — at that point `CREATE_ALIAS` grounding could check the result directly rather than the call's arguments, which is a strictly stronger guarantee than the argument-match this ADR ships.

### ADR-090 · ADR-050 corrected: FIVE gate checks, not three, and `groundingFailure` is a string (#26)
**Decision:** `agent-design.md` §A3 now documents the gate as it has always run: schema, citation grounding, a reasoning-required check, a result-digest checksum, and the constraint check — the digest checksum and reasoning-required check existed in code from the gate's first commit but were never added to ADR-050's three-check description. `groundingFailure` is documented as the `string | null` it has always been (`"<check>: <reason>"`, `null` on a pass), not the `groundingFailure: true` boolean both ADR-050 and the old table description claimed. The `CREATE_ALIAS` constraint row now says "rejected outright", matching `checkConstraints`, not the old "without flagging it" wording that implied a softer outcome. The `sequenceNo`/`citations UUID[]` disagreement (§A3 blesses citing one; the column cannot hold one) is recorded as a stated, unresolved discrepancy — deliberately not settled here.
**Because:** AUDIT-3 re-triaged this issue and found the `sequenceNo` half is not merely stale documentation — it is a live crash path that permanently locks an exception out of investigation (fixed separately, #57's orphaned-row fix). That finding is what prompted re-reading the rest of this issue closely enough to notice the doc had never matched the code on the other three points either. Per CLAUDE.md §3, the doc is corrected to match already-correct, already-tested code — this is not a new design choice.
**Rejected:** picking a resolution for the `sequenceNo`/`UUID[]` disagreement (a new `TEXT[]` column, or dropping `sequenceNo` from what §A3 permits citing) — AUDIT-3's re-triage comment on #26 explicitly asks that this stay a human decision, not something settled silently in a doc-only pass.
**Revisit if:** the `sequenceNo` citation question is decided — at that point this ADR's "stated, unresolved discrepancy" language in §A3 should be replaced with whatever was chosen, via a further superseding entry.

### ADR-091 · `schema.md` §5.4's review-band promise corrected to what the scoring arithmetic actually allows (#48)
**Decision:** §5.4 no longer claims an anchorless pair "can reach the review band and ask a human, and that is all it can ever do" for every amount and date. It now states the real property, driven by two independent mechanisms: bank↔ledger never reaches the review band at any date (no comparable amount basis, §5.3.1/ADR-064, ceiling `0.35`); every other pair (gateway↔bank, gateway↔ledger) reaches it only on a same-day match, because the date component (`0.20 × (1 − days_off/window_span)`) zeroes at `days_off == window_span` — still inside the window, not outside it — and every §5.2 window has `window_span ≤ 3`, so clearing `0.65` from an anchorless `0.50` (perfect amount + counterparty) needs `days_off ≤ window_span/4`, satisfiable only at `0`. Doc-only: no scoring code changed.
**Because:** measured on the holdout, both mechanisms are real and independent. Every one of 244 true bank↔ledger pairs is anchorless with amount unavailable (#47 already showed renormalizing recovers zero of them). Of 43 gateway-bearing never-found pairs with a perfect amount, in-window date and perfect counterparty trigram, 20 score exactly `0.00` on date while inside their own window — a T+3 card settlement is the documented normal case (§5.2), and the curve cannot distinguish it from a month-late settlement once past the boundary. §5.4's original sentence told a reader debugging "why didn't this match" a confidently wrong story for the majority of anchorless pairs, not just bank↔ledger.
**Rejected:** changing the date curve to give partial credit for a date inside its own window — a defensible idea, but it is a scoring change under ADR-027, needs its own ADR reasoning about the curve's shape (neither ADR-009 nor ADR-030 does), must be validated on `DEV_SEED` before touching the reported holdout number, and the issue's own measurement shows it would recover close to none of the affected pairs (they are still short of `0.65` by the missing `0.30` anchor weight) — so it is not a recall fix and should not be bundled with a doc correction that costs no accuracy risk.
**Revisit if:** the date-curve question above is ever taken up on its own merits, with its own ADR and its own `DEV_SEED` measurement — at which point §5.4's stated property should be re-derived from the new curve, not patched.

### ADR-092 · S13's explain output gets a deterministic grounding check, because any specific in it is necessarily fabricated (#52)

**Decision:** `findUngroundedSpecific` (`services/explain/llm-client.ts`) rejects an explanation or suggested action containing a currency marker (`₹`, `Rs.`, `INR`), a source reference-id shape (`pay_`, `setl_`, `order_`, `rfnd_`, `txn_`, `utr_`), an ISO or calendar date, or any digit run of three or more. A rejected signature falls back to its hand-written template with the new `TemplateCause` value `ungrounded_specific`, is counted in `runs.metrics.llmCost.failures` with `reason: 'ungrounded'`, and — because `asTemplate` sets `needsCacheWrite: false` — writes no `explanation_cache` row. **Rejected, never retried**, matching ADR-053's posture at A3: a second attempt at a fabricated answer is still an attempt at a fabricated answer. The signature's own `occurrence_count` is exempted **by value**, since `buildUserMessage` sends it and "this covers 39 exceptions" is therefore grounded.

**Because:** `schema.md` §10.4's system-prompt rule 2 — *"Never invent amounts, dates, merchant names, or reference numbers"* — was a request with nothing verifying it, on the one layer whose output a panelist reads directly. The asymmetry with Phase A was indefensible: ADR-053 makes a fabricated specific a build blocker at A3, while S13 relied on the model's cooperation. What makes the check cheap rather than a general hallucination detector is that S13's **input provably contains no specifics**: ADR-018's signature is bucketed by construction, `buildUserMessage` emits only those buckets, and `explain-llm-client.test.ts` already asserts no long digit run reaches the prompt (ADR-080 consequence 3's privacy claim depends on it). So a rupee figure in the output did not come from us, and there is no legitimate route by which it could have. The cache made it durable rather than transient: `explanation_cache` is run-independent, so one fabricated figure would be served to every later run sharing that signature, with `hit_count` making it look well-established.

**Rejected:** *a retry on rejection* — same reasoning as A3's no-retry rule; a retry loop quietly selects for whichever output happened to pass. *Folding the cause into `malformed_response`* — that means unusable JSON and carries a retry; this means well-formed output that was refused, and collapsing them would hide the count that says the prompt needs work. *Dropping `occurrence_count` from the prompt* to avoid the digit question — it is the one figure that makes an explanation concrete for a reader ("this shape covers 39 exceptions"), and exempting it by value costs one regex. *A digit-length threshold instead of a value exemption* — the holdout's largest occurrence count is 39, but ADR-045's 100k benchmark will produce signatures covering hundreds, and a rule that only holds at one scale is not a rule.

**Revisit if:** the prompt is ever changed to supply real specifics — at which point this check must be redesigned around what was actually given, not removed. `prompt_version` must be bumped in the same change, since ADR-018 hashes it and every cached row must re-resolve.

### ADR-093 · Anthropic is the shipped LLM provider, on `claude-sonnet-5` for both surfaces, with Gemini kept as the free-tier path

**Decision:** `LLM_PROVIDER` (`anthropic` | `gemini`, default `anthropic`) selects the provider for **both** LLM surfaces at once. Two new clients implement the existing injected interfaces — `createAnthropicAgentClient` (`AgentLlmClient`) and `createAnthropicExplainClient` (`ExplainLlmClient`) — and `services/llm-provider.ts` is the only file that chooses between providers. Both surfaces default to **`claude-sonnet-5`**. Published rates live in `ANTHROPIC_COST_PER_MILLION` in `config/defaults.ts` and feed `agent_investigations.cost_usd` and `AGENT_MAX_COST_USD_PER_RUN`; an unknown model yields `null`, never a guessed rate.

**Because:** the free tier could not support iteration — 20 requests/day/model made a single full run a day's budget, which is why the Analyst was finished against a fake client and `docs/analyst-baseline.md` is a plumbing measurement rather than a quality one. **Sonnet 5 over Opus 5 is a deliberate downgrade in capability to buy runs**: at $2/$10 per MTok against Opus's $5/$25 it is 2.5× cheaper on both sides, and on a hard-capped prepaid balance the binding constraint is how many verification runs are affordable, not how good any single one is. Four acceptance criteria across #52, #53, #54 and #55 are waiting on a live run, and one run that can be repeated after a fix is worth more than one that cannot. **One switch for both surfaces** because `/api/health` reports `llmConfigured` as a single boolean and `env.ts` reads one provider's key — a per-surface provider would make "configured" true while half the system had no key, and that run would silently take the template floor rather than fail.

**Consequences that are not cosmetic:**
- **`temperature: 0` is gone.** Sampling parameters are removed on Sonnet 5 and return a 400. The Analyst was never the reproducible half — ADR-048 puts determinism in the ENGINE, which is measured by `tools/score` and unaffected — but any doc claiming the agent is deterministic because of temperature is now wrong.
- **`budget_tokens` is removed** (400). Depth is `output_config.effort`, defaulting to `high` via `AGENT_EFFORT`. S13 is pinned to `low` in code: it writes two sentences about a decision the rules already made (ADR-017) and has nothing to reason about, and thinking bills as output at 5× the input rate.
- **Thinking blocks must be replayed unchanged**, exactly as Gemini required its `thought_signature`. `AgentToolCall.providerSignature` already exists for this and its doc comment predicted the requirement would survive the swap. It did; the blocks are serialised into it. The loop still may not inspect it.
- **ADR-018 invalidates the explanation cache for free** — `model` is hashed into every signature, so no prose written by Gemini is served for an Anthropic run.

**Rejected:** *`claude-opus-5` for the Analyst* — the original plan, and defensible on quality, but it is 2.5× the cost on a balance that has to cover a verification run plus at least one repeat after a fix. Revisit if the balance allows. *A per-surface provider switch* — see the `llmConfigured` argument above. *Deleting the Gemini clients* — they are the only way to exercise the whole system without spending a capped balance, and `LLM_PROVIDER=gemini` restores Day 12 exactly for one branch's worth of code. *Reporting a cost of `0.00` when rates are unknown* — the same rule `run-metrics.ts` applies to an unrun stage: an absence and a measured zero are different claims, and a made-up number in the ledger that guards real money is worse than an acknowledged gap.

**Revisit if:** the first paid run measures per-turn latency that breaches `agent-design.md` §8's 60 s whole-investigation bound at `AGENT_EFFORT=high` — that is ADR-086's rule, and `npm run smoke` exists to measure it in one call before a full run is spent.

### ADR-094 · A bound that binds asks for a verdict; a bound on MONEY does not — and the cost cap is enforced for the first time

**Decision:** Three changes to `investigation-loop.ts` and one new module.
1. **The token and step ceilings became soft.** When either will bind on the next turn, the loop sets `concludeNow`, takes ONE more turn with **no tools declared** and an instruction to write the verdict from what was retrieved, then stops. Tools are withheld rather than discouraged — an instruction not to call one is a request; an empty tool list is a property.
2. **The countdown reports the bound that actually binds**, in turns: `min(maxSteps − steps, ⌊(maxTokens − spent) / perTurn⌋)`, where `perTurn` is this investigation's own measured average over *completed* turns. Turn 1 legitimately reports the step bound — nothing is measured yet and it is a true upper bound — and every later turn corrects downward.
3. **A spend refusal stays a HARD stop.** `preflight` returning a string breaks immediately, with no conclude turn.
4. **`createSpendGuard`** (`services/agent/spend-guard.ts`) supplies `preflight`, refusing before a call whose worst case would cross `AGENT_MAX_COST_USD_PER_RUN`. One guard spans the phase.

**Because:** measured on holdout run `80ddde9d`, the 10-step ceiling fired **zero** times and the 40,000-token ceiling fired **fifteen**, at steps 6–9. Fifteen investigations were killed mid-reasoning, each discarding 6–9 steps of real retrieval, and the `remaining === 0` branch carrying *"write your verdict now"* was unreachable because the countdown measured steps while tokens did the stopping. `analyst-baseline.md` named the fix and did not take it: *"being cut off loses work, answering early invents it — there is a third option."* Separately, `AGENT_MAX_COST_USD_PER_RUN` was parsed in `env.ts`, listed in `agent-design.md` §8, and **enforced nowhere**; `LoopDeps.preflight` was documented as "the seam the spend guard plugs into" and nothing ever plugged into it. Harmless on a free tier with no bill; on a prepaid key with auto-reload off it is the difference between a run that stops and a balance that dies mid-investigation, taking the run with it.

**Why work bounds and money bounds are treated differently, which is the substance of this ADR:** a token or step ceiling is a **work** bound — the money is already spent, so one more turn converting that work into a verdict is free of regret. A spend ceiling is a **money** bound — a "final" turn spends precisely what the guard just said could not be afforded. Collapsing the two would have made the cost cap advisory, and the pre-existing test *"the refused turn must not reach the model"* caught exactly that when the first version of this change got it wrong.

**Rejected:** *a fixed token reserve* — cost per turn varies by an order of magnitude with which tools were called (`rerun_subset_search` returns far more than `get_exception`; the holdout shows 41,632 vs 51,396 tokens at the same step count), so the reserve is measured per investigation. *Raising `maxTokens` until the step ceiling binds* — it would work today and break at the first tool payload larger than the ones this dataset happens to contain; the two bounds would still be inconsistent, just less visibly. *An expected-case spend estimate* — an expected-case guard that is wrong once has already spent the money, so `preflight` prices the whole conversation as input plus a full output cap.

**Revisit if:** Anthropic's `task_budget` (`output_config`, beta, supported on Sonnet 5) proves reliable — the server injects a countdown the model sees *during* generation, which is a stronger version of change 2 and would let the hand-rolled pacing signal be deleted rather than maintained.

### ADR-095 · The public investigate endpoint is bounded by a trailing-hour spend ceiling, derived from rows already written (#61)

**Decision:** `POST /api/exceptions/:exceptionId/investigate` now (a) refuses with `429 AGENT_QUOTA_EXCEEDED` when agent spend in the trailing hour has reached `AGENT_MAX_COST_USD_PER_HOUR` (default 2.00), and (b) supplies `investigateOne` a `SpendGuard` seeded with that hour's spend and capped at `min(hourly remaining, AGENT_MAX_COST_USD_PER_RUN)`. The ledger is **derived**, by summing `cost_usd` across `agent_investigations` and `agent_corroborations` — no new table. The route also stops rebuilding `GateContext` inline and calls the shared `buildGateContext`.

**Because:** the bounded path and the exposed path were inverted. `runPhaseA` — the CLI, used for measurement, unreachable over HTTP — carried the request budget and, since ADR-094, the cost cap. Endpoint 25, the one the frontend calls on every click, carried neither. That was harmless while nothing drove it and no bill existed; ADR-093 put the project on a paid key with auto-reload off, and the Day 14 decision to make investigation **on-demand rather than batch** made this endpoint the product path rather than a spare surface. Measured on Sonnet 5: **$0.10–0.12 per investigation**.

**Why per HOUR and not per run:** a per-run ceiling cannot bound an unauthenticated surface, because `POST /api/runs` mints a fresh run with a fresh exception set on demand — "per run" is a ceiling the caller controls. `ux_inv_exc_active` bounds one *exception* to one investigation and does not bound the loop `POST /api/runs → investigate ×21 → repeat`, which is ~$2.30 a cycle.

**Why derived rather than an in-memory counter:** a counter resets when the process does, so on a hard-capped prepaid key it is a ceiling an attacker clears by making the service crash. `cost_usd` is already written on every concluded investigation and corroboration — the ledger existed and had no reader. Rows with a NULL `cost_usd` contribute zero rather than a guess; that understates a mixed-provider window, which is safe only because NULL there means nothing was billed, and that is stated rather than assumed.

**Rejected:** *a new `agent_spend` table* — the data is already persisted and a second copy is a second thing to keep true. *Auth on the endpoint* — out of scope (ARCHITECTURE §5) and it would not help: the demo is meant to be clicked by judges. *An expected-case estimate in the guard* — an expected-case guard that is wrong once has already spent the money, so `preflight` prices the whole conversation as input plus a full output cap. *Leaving `AGENT_MAX_COST_USD_PER_RUN` as the only cap* — it still applies, as the tighter of the two, but it cannot be the outer bound for the reason above.

**Revisit if:** the deployment ever runs more than one instance. The window is derived from a shared database, so it stays correct across instances — but the *refusal* is checked per request, so two simultaneous requests can each see headroom that only one of them has. At demo scale that races by at most one investigation; at any larger scale it wants a transactional reservation.

### ADR-096 · The public API is rate limited per IP, in tiers priced by what the endpoint actually costs

**Decision:** `createApp` mounts one middleware, `rateLimit` (`routes/rate-limit.ts`), ahead of every router. It classifies each request into one of four tiers and refuses over-budget requests with `429 RATE_LIMITED`, a `Retry-After` header and the standard error envelope. `ERROR_CODES` gains one member — `RATE_LIMITED` — and `api-contract.md` §0's 429 row gains it beside `AGENT_QUOTA_EXCEEDED`.

| Tier | Endpoints | Per IP | Global | Derived from |
|---|---|---|---|---|
| `read` | every `GET` | **120 / min** | — | the busiest legitimate screen is ~12 requests; this is ~10× a human's busiest minute |
| `write` | `POST`/`PATCH` on matches, aliases, exceptions, score reports | **60 / hour** | — | human review actions, one per click |
| `run` | `POST /api/runs` | **10 / hour** | **40 / hour** | measured today on Railway: 2.4 s and ~1,700 rows written per run |
| `investigate` | `POST /api/exceptions/:id/investigate` | **12 / hour** | — (ADR-095's $2/hour stands) | measured $0.10–0.12 per investigation ⇒ 12 ≈ $1.32, deliberately **below** the $2 ceiling |

`app.set('trust proxy', TRUST_PROXY_HOPS)` (default `1`) is set at the same time, and is load-bearing rather than incidental — see below.

**Because:** two meters now bill for traffic this API accepts from anyone. ADR-093 put the Analyst on a prepaid Anthropic key with auto-reload off, and Railway bills CPU, egress and Postgres storage by usage. ADR-095 bounded the *money* on the one endpoint that spends it, and that bound is correct and unchanged — but it bounds dollars, not requests, and it bounds only Phase A. `POST /api/runs` spends no LLM money at all and is the cheapest way to hurt this deployment: unauthenticated, ~1,700 rows and 2.4 s of engine per call, in a loop. The exception list is unauthenticated by design (ARCHITECTURE §5 — judges must be able to click it), so the surface cannot be closed; it can only be metered.

**Why per-IP tiers and not one global limit:** a single global limit protects the wallet and hands an attacker a denial-of-service against the demo — one script exhausts the shared bucket and every judge sees 429. Per-IP buckets mean the cost of denying the demo is the cost of rotating IPs. Where that is not enough — `run`, where storage is cumulative and IP rotation is cheap — a global cap sits *behind* the per-IP one, sized so the per-IP limit binds first for any honest user. `investigate` deliberately has **no** new global cap: ADR-095's derived $2/hour already is one, and stacking a second would make the demo's failure mode a count nobody can reason about instead of a dollar figure everyone can.

**Why the per-IP `investigate` limit is below the global spend ceiling, and not equal to it:** at the measured rate, 12 investigations ≈ $1.32 against a $2.00 hourly ceiling. A single IP therefore cannot exhaust the wallet alone, which keeps ADR-095's refusal a *wallet* protection rather than a race between visitors. The gap is the demo's headroom.

**Why in memory, when ADR-095 went out of its way to derive its ledger from rows already written:** those two guards protect different things and the argument does not transfer. ADR-095 guards **money**, where a counter cleared by crashing the process is a ceiling an attacker can clear. This guards **request volume**, where crashing the process is itself the outage being defended against — an attacker who can crash it gains nothing by clearing a counter, and Railway restarts into a fresh window either way. A database round-trip on *every* request would also make the limiter a load amplifier: it would add a query to exactly the flood it exists to survive. The money ceiling stays derived and is untouched by this ADR; that is the defence in depth, and it is why the weaker mechanism is acceptable here and would not have been there.

**The key table is bounded.** Buckets are pruned when their window empties, and the table is capped at `MAX_TRACKED_KEYS` (10,000); at the cap the least-recently-seen key is evicted. Without that, rotating the source IP turns the limiter itself into the memory-exhaustion attack it was added to prevent.

**`trust proxy` is load-bearing, not incidental.** Railway terminates TLS at its edge, so without it `req.ip` is the edge's address for *every* visitor and all of them share one bucket — the first judge to browse would exhaust the read tier for everyone else. `trust proxy: 1` takes the hop the immediate proxy wrote (the rightmost `X-Forwarded-For` entry) rather than the leftmost, which a client can set to anything it likes. `true` would have been the spoofable choice.

**Rejected:** *`express-rate-limit`* — a dependency, its store abstraction, and its defaults, to replace ~120 lines that need to be read anyway because the numbers are the interesting part. This repo already hand-rolls its provider-side limiter (`services/agent/rate-limiter.ts`) for the same reason. *Auth instead of limits* — out of scope (ARCHITECTURE §5) and it defeats the point: an unauthenticated demo is the requirement. *A global-only limit* — see the denial-of-service argument above. *Refusing with `AGENT_QUOTA_EXCEEDED`* — it would tell a frontend the Analyst was out of budget when the truth is that `GET /api/runs` was polled too fast, and endpoint 4's poll loop is the most likely thing ever to see a 429. *Counting bytes or CPU rather than requests* — the honest bound, and not measurable per request without instrumenting the engine; the request counts above are derived from measured per-request cost instead, which is the same arithmetic done once rather than continuously.

**Revisit if:** the deployment ever runs more than one instance — the per-IP windows are per-process, so N instances multiply every limit by N. At that point the tiers want the same derived-from-Postgres treatment ADR-095 gives the spend ceiling, and the cost of that query stops mattering because a multi-instance deployment is not the flood-survival scenario this sizing assumes.

### ADR-097 · The API stays ALWAYS-ON through submission; scale-to-zero is rejected until the stale-run reaper exists

**Decision:** Railway's App Sleeping / scale-to-zero stays **OFF** from now until after the Day 16 submission (2026-09-05). Revisit afterwards, when the deployment is a portfolio artifact rather than a thing being demonstrated.

**Because — the saving is not the size of the risk.** Four days of an idle Node container is a low single-digit dollar figure, and **Postgres does not sleep with it**, so the larger half of the bill is unaffected either way. Against that:

1. **A sleeping container drops work that is deliberately not awaited.** `POST /api/runs` is 202-then-poll by contract (api-contract §5) and `POST /api/exceptions/:id/investigate` dispatches `void investigateOne(...)`. Both do real work *after* the response is sent. Scale-to-zero keys on inbound traffic, so a judge who starts a run and looks away is the exact case where the platform decides nothing is happening. An investigation killed this way has already spent its Anthropic money and persists no verdict.
2. **There is no reaper to clean up after it, and the config lies about that.** `index.ts` carries `reapStaleRuns` as a commented TODO; `STALE_RUN_TIMEOUT_MINUTES` is parsed in `env.ts` and documented in `deployment.md` §3 as though it were enforced. It is enforced nowhere. **This is ADR-094's defect shape exactly** — a bound that is parsed, documented, and never applied — and its own TODO predicted the consequence: *"a crashed run sits at `matching` forever and the dashboard polls it indefinitely — a failure mode that only shows up in front of an audience, because only then does anything restart."* Scale-to-zero makes restarts routine.
3. **Cold starts hit the endpoint that must never look broken.** The first request after a sleep pays container start plus `runMigrationsOnBoot` plus pool connect. A judge's first impression is a dashboard that hangs, and 502s during evaluation are the one failure this project cannot argue its way out of.
4. **The frontend is being built next**, against this API, all day. It is the least idle the deployment will ever be, so the saving is at its smallest precisely when the disruption is at its largest.

**What makes this cheap to reverse:** it is one toggle in the Railway dashboard, and ADR-074 already judges this setup on how cheap it is to redo rather than on being finished.

**Revisit if:** the reaper lands. With `reapStaleRuns` implemented, failure 1 degrades from *"polls forever"* to *"marked failed within 5 minutes, with a stated reason"*, and sleeping becomes a reasonable post-submission economy. That is the sequence: **reaper first, sleep second** — never the reverse.

**Rejected:** *sleeping now and toggling it off on Day 16* — it depends on remembering, on the day with the least slack, and the first cold start after the toggle would land during the demo window. *A cron ping to keep it warm* — it defeats the saving while adding a moving part, and the platform bills the wake-ups. *Sleeping only the API and not Postgres* — that is already what would happen; see the cost argument above.

### ADR-098 · Provenance is a design token: every figure on screen says whether it is self-reported or measured

**Decision:** The frontend's design system carries **three provenance states as first-class visual tokens** — `engine` (the engine's account of itself, ink on the base surface), `measured` (scored offline against the answer key, a distinct accent plus a `Measured` mark), and `absent` (no measurement exists, muted and italic, stating the reason). The `Figure` component takes `provenance` as a **required** prop, so there is no way to render a number without declaring where it came from.

**Because — ADR-041 and ADR-020 are rules about what a viewer is allowed to conclude, and a rule about conclusions has to hold at a glance or it does not hold.** Both ADRs are enforced at the API today: endpoint 5 returns `engine` and `measured` together or not at all, and `measured` is `null` rather than backfilled. That stops the *backend* from substituting one for the other. It does nothing to stop a *layout* from putting an engine figure in a tile a reader will read as a measurement, and on a dashboard the reader's inference is the whole product. A viewer who cannot tell the two apart will take whichever number flatters, which is precisely the behaviour ADR-020 exists to prevent. Making provenance a token means the wrong choice is visible rather than silent.

**What it forced, immediately.** Endpoint 26 returns `agentMetrics.hallucinatedResolutions`, and `routes/investigations.ts` sets it to `groundingFailures` verbatim — the same integer under a second name. ui-spec §2 block 4.5 asks for a `hallucinated resolutions: 0` tile and describes it as the agent's equivalent of the false-positive tile, which makes it a **measured** figure per ADR-053. It is not one: it is the grounding gate's rejection count, self-reported, and on the current run it is 3. Under this ADR the two cannot share a tile, so the dashboard renders the gate count as an engine figure under its true name and renders the measured tile as **absent**. That is the honest state — `tools/score` does not score the Analyst — and the tile stays on screen while empty because the absence is the finding.

**Rejected:** *a footnote or a legend explaining which numbers are measured* — nobody reads a legend in fifteen seconds, and a rule that depends on being read is not enforced. *Rendering the engine's figure with a caveat* — a caveated number is still a number, and it is the one that gets quoted. *Omitting absent tiles entirely* — an absent measurement that is visible is a stronger honesty signal than a tidy row, and hiding it would make the page silently better-looking exactly where it is weakest.

### ADR-099 · The tier bar is a single-hue ordinal ramp, and two things the ui-spec lists are not segments of it

**Decision:** Tier attribution renders as **one hue darkening toward the strongest tier**, not eight distinct colours. `identityEstablished` and `unmatched` are **excluded from the bar**, and `identityEstablished` is shown beside it as a labelled diagnostic.

**Because:** `exact → alias → fuzzy → batch → implied → manual` is an **ordinal** scale of evidence strength. Eight unrelated hues assert that these are eight unrelated kinds of thing, which is false, and force a reader to consult a legend to recover an ordering the ramp could have shown directly.

The two exclusions are arithmetic, not taste, and ui-spec §2 block 2 lists both as segments:

1. **`identityEstablished` is not part of the sum.** `tierPairCounts` builds the tier buckets from the internal pairs of every assembled group; `run-metrics.ts` then grafts `identityEstablished` onto the same object as a separate diagnostic — it counts S8 verdicts, not pairs. Drawing it as a slice inflates the bar by exactly its own value (747 → 756) and silently changes every other proportion.
2. **`unmatched` is a different unit.** The bar divides **pairs**; unmatched is a count of **records**. One bar cannot divide two units without lying about at least one. Unmatched records live in the exception block, where the unit is records throughout.

**Corollary, same shape, same block:** ui-spec §2 block 3 asks for severity as colour *within* each category bar. That cross-tab does not exist — endpoint 5 reports `byCategory` and `bySeverity` as independent distributions, and endpoint 6's facets do the same. Severity is therefore drawn as its own distribution over the same exceptions rather than invented per category.

**The general rule this establishes:** where the ui-spec asks for a rendering the data cannot support, the data wins and the divergence is written down. The spec was written on Day 3 against shapes that did not exist yet; it is binding on intent, not on arithmetic it could not have checked.

### ADR-100 · The frontend is plain CSS Modules with a token layer — no Tailwind, no component library, no chart library

**Decision:** `apps/web` styles with **CSS custom properties in one `globals.css` plus per-component `.module.css`**. No CSS framework, no UI kit, no charting dependency. The web app's runtime dependencies stay `next`, `react`, `react-dom`.

**Because:**

1. **Every visual element here is a rule, a bar, or a number in a table.** The dashboard's charts are two stacked bars and a list of proportional rows; a charting library would be several hundred kilobytes to draw what forty lines of flexbox draws, and it would fight the tabular-figure alignment that the whole design depends on.
2. **The deploy has one shot.** U19 puts this on Vercel late on the last working day, with no CI (ADR-074). Every build-time dependency is a way for that deploy to fail in a way nobody has time to debug, and a token layer in plain CSS has no build step beyond the one Next already runs.
3. **The design is a small, strict system** — one ramp, three provenance states, four type sizes. Utility classes are a good trade when a design is large and irregular; this one is neither, and hand-written CSS keeps the reasoning next to the rule it justifies.

`next/font` **is** used, for Inter and JetBrains Mono, and that is the one exception worth its weight: the figures are the product, and a judge on Windows and a judge on macOS must see identical digit widths for a column of numbers to be comparable at all. Both faces are self-hosted at build time, so nothing about the type depends on a network at runtime.

**Rejected:** *Tailwind* — a config, a build plugin and a class vocabulary, bought for a page whose repeated units are already extracted into components. *shadcn/ui* — every component it would provide here (a disclosure, a table) is native HTML that needs no JavaScript. *Recharts / visx* — see 1.

### ADR-101 · The record inspector is a ROUTE, not a modal; and every stateful surface deep-links

**Decision:** `ui-spec.md` §1 specifies the record inspector and the run launcher as modals. The record inspector ships as a route — `/records/[transactionId]` — and every filter, page, tab and selection across the frontend lives in the URL rather than in component state.

**Because:** three different surfaces link to a record — an Analyst citation, a match member, a rejected candidate — and each of those links is something a judge should be able to open in a new tab, middle-click, share, or reach with the back button. A modal is a dead end that a URL is not. The same argument covers the exception list's facets, the audit screen's actor filter, the matches browser's tier filter and the review queue's position: all of them are query params, all of them are server-rendered from those params, and none of them needs JavaScript to work.

The practical consequence is that the demo path in ui-spec §7 is a **sequence of shareable links**. If a live click goes wrong during the pitch, the next step is still one URL away.

**Rejected:** *modals with a synced URL* — the sync is the hard part and the modal adds nothing once it is done. *`useState` filters* — faster to write, and it breaks the back button on the screen a judge will use the back button on most.

### ADR-102 · Manual match (endpoint 21) is deferred, and named on screen rather than quietly absent

**Decision:** The exception detail screen ships `Resolve` and `Won't Fix` (endpoint 20). **`Create match manually` (endpoint 21) is not built.** The screen carries a short panel saying so and why.

**Because:** the action needs a record picker over the whole run — search, filter, multi-select, role validation against S11's collision rule — which is a screen in itself, not a button. `ui-spec.md` §8's degradation order cuts from the bottom, and this is the bottom of priority 1.

**Why it is named on screen rather than removed:** a judge who reads *"these two are the same, the engine just couldn't prove it"* on the exception list will look for the action that says so. Finding nothing reads as an oversight; finding a sentence that says what is missing and why reads as a decision. This project's whole argument is that stating a limitation is stronger than hiding one, and that has to apply to the frontend's own gaps, not only to the engine's.

**Revisit if:** time remains after AUDIT-4. The endpoint, its audit wiring and its conflict handling all already exist and are tested — only the picker is missing.

### ADR-103 · `datasetSeed` is accepted by `POST /api/runs` and used nowhere

**Decision (finding, not yet a fix):** `routes/runs.ts` parses `datasetSeed` from the request body, stores it on the run row, and serialises it back on every `RunSummary`. **`readSeedDataset()` always returns the committed holdout CSVs** (`app.ts` resolves a fixed `data/fixtures/holdout/`). A caller passing `datasetSeed: 12345` gets a run labelled with seed 12345 that reconciled seed-90210 data.

**This is ADR-094's defect shape for the third time:** a field that is parsed, persisted, published to clients, and enforced nowhere — after `AGENT_MAX_COST_USD_PER_RUN` (fixed, ADR-094) and `STALE_RUN_TIMEOUT_MINUTES` (still open, ADR-097). It is invisible to the test suite for the same reason both of those were: every test asserts the field round-trips, which it does.

**The cheap fix is to reject it.** Ten lines: a `datasetSeed` that does not match the committed dataset's seed returns `400 INVALID_REQUEST` naming the one seed this build can serve. A field that refuses what it cannot honour is honest; a field that accepts and ignores is not.

**The better fix, agreed with Tejas and scheduled after U18:** commit a second generated dataset with its answer key and let `datasetSeed` select among committed datasets that have keys. `tools/generate` already produces both from any integer seed, deterministically (ADR-067). That turns the demo claim from *"it reconciles this data"* into *"it reconciles data it has not seen before, and the accuracy is still measured"* — which is materially stronger, because a fresh dataset with no key would render two of four headline tiles as *not measured* and be the weaker demo, not the stronger one.

### ADR-104 · The holdout's repeated round amounts are the ambiguity mechanism, not a generator defect — do not "fix" them

**Decision:** `data/fixtures/holdout/` stays exactly as committed. The clustering of `₹999` / `₹1,199` / `₹1,499` across the exception list is **correct output of a deliberate design** and must not be smoothed away. Widening the amount spread happens in the NEW dataset built for task 7c, never by regenerating the holdout.

**Because — the repetition IS the feature, and removing it removes the demo.** Measured on the holdout:

```
₹999   × 8  →  AMBIGUOUS_MATCH ×6, MISSING_IN_BANK ×2
₹1,499 × 6  →  AMBIGUOUS_MATCH ×6
₹1,199 × 6  →  AMBIGUOUS_MATCH ×6
```

**18 of the 22 `AMBIGUOUS_MATCH` exceptions sit on three round price points**, and that is `planting.ts` working: an ambiguity cluster is *constructed* by planting several payments on one price point, one merchant, one day (`AMBIGUITY_PRICE_POINTS_RUPEES`). The shared amount is the mechanism that makes them ambiguous. Give those records distinct amounts and the engine matches them trivially — the category ceases to exist, and with it ui-spec §7 step 5, the moment the engine half of the pitch is built around.

The 52% retail-price weighting in `events.ts` is separately justified and documented there: it creates natural (unplanted) collisions so the ambiguity guard is exercised by ordinary data, and it spreads events across all three regimes of `clamp(0.5%, ₹1, ₹100)` so the ₹1 floor and ₹100 cap are covered by the measurement rather than shipped untested.

**Why it LOOKS wrong.** Default sort is severity DESC then amount DESC. `AMBIGUOUS_MATCH` carries base severity `high` regardless of amount, so all 22 land in the high band — 20 of the 92 high rows are those three values, and the repeat rate inside the high band is **47.8%**. A reader scrolling page one meets the large amounts first and then a long tail of identical small ones. Combined with the null-amount rendering defect below, it reads as stubbed data.

**Blast radius of the rejected alternative,** recorded because the argument will resurface: regenerating the holdout invalidates the committed answer key, precision 1.0000 / recall 0.6075 / ceiling 93.0% / classification macro 0.9286–0.8738 / unresolvable recall 1.0, the posted score report, the deployed Railway fixtures, `input_file_hashes` on every existing run row, the 10 persisted Analyst investigations (they cite current exception ids), and every figure quoted in `what-broke.md` Days 9–15.

**And it is the ADR-027 move.** Changing a generator parameter because a measured artefact looked wrong is the prohibited operation. That the complaint here is aesthetic rather than numeric does not change the mechanism, and the exemption for "structural fixes arguable without citing the number" does not apply — nothing about the current distribution is structurally wrong.

**Revisit at 7c:** more ambiguity clusters (only 3 are planted, which is why only 3 price points appear) and a wider draw belong in the new seed, where the answer key is generated alongside the data and costs nothing.

### ADR-105 · `amountAtRiskPaise` is always null for exact duplicates — the pool-membership fact was patched once and not twice

**Finding (frontend guarded; engine fix deferred).** `classify.ts:135` reads the duplicate's amount as `byId.get(d.transactionId)?.amountPaise ?? null`, where `byId` is built from `pool` alone. Twenty-five lines above it, the same function states the governing fact in a comment — *"an excluded exact `DUPLICATE_RECORD` never enters `pool`"* — and builds a **second** map, `sortKeyFor`, precisely to work around it for the output-order comparator.

So the author knew the pool does not contain duplicates, patched the consequence they were looking at, and left the amount lookup reading the map that cannot answer it. **All 9 `DUPLICATE_RECORD` exceptions on the holdout carry `amountAtRiskPaise: null`, and always have.**

> **This is the repo's signature defect shape once more: two facts, both written down, in the same file, by the same author — and the bug living in their conjunction.** It is the Day 9 `#40` pattern (§6.3's "pairs" plus AUDIT-1's "Tier 1 only produces gateway↔ledger") reproduced inside a single function.

**Not fixed today, deliberately.** `amountAtRiskPaise` feeds `severity.ts`, so populating it could re-rank those 9 exceptions and move `runs.metrics.exceptions.bySeverity`. That is engine output, and engine output changes end with a re-score (habit 0), not with a frontend commit.

**The frontend now guards it explicitly** rather than rendering a blank: the list shows `n/a` with a title, and the detail page shows *"Not quantified"* with the reason. **Never `₹0`** — a fabricated zero in a money column is the same failure as an engine figure in a slot labelled measured.

**Note for whoever fixes it:** the type is `string | null` on the wire and `null` is a legal `ReactNode`, so **TypeScript cannot catch this class of bug at a render site.** Widening the type produced zero new errors. Only looking at the page found it.

### ADR-106 · Endpoint 24 gets a screen, because a denominator defended only in the API is not defended

**Decision:** `/set-aside` renders `GET /api/runs/:runId/population` — every row removed from the match rate's denominator, grouped by reason, with the subtraction shown as arithmetic. The dashboard's record count links to it.

**Because the endpoint existed for exactly this and nothing called it.** api-contract §111 states the reason it was built: *"Any number with a shrunken denominator invites the question 'what did you take out?', and the honest answer is an endpoint that lists exactly that, with a per-row reason. Excluded is not hidden."* It was hidden. `ui-spec.md` §1 put it on the run-launcher modal, the run launcher was never built, and endpoint 24 shipped with **no consumer at all**.

The proof that this mattered is that the first person to read the dashboard asked the exact question the endpoint answers — *"874 of 920 — did we lose rows in ingestion, and isn't ingestion supposed to be lossless?"* — and nothing on the site could reply. A defence of the denominator that lives only in an API is a defence nobody encounters.

**The page shows a subtraction, not a table.** `920 attempted → −0 failed to parse → 920 read → −37 nothing to reconcile against → −9 same row twice → 874 measured`. The `−0` line renders **even at zero, especially at zero**: it is the only statement in the product that ingestion is lossless, and omitting it would leave that claim resting on a reader's trust. Same reasoning as the `hallucinated resolutions` tile staying on screen while empty (ADR-098).

**Wording, and why the old wording was the defect.** The dashboard said `874 of 920 ingested`. Three words hiding a three-term accounting identity, and the preposition invites the reader to supply the missing verb — *missed*, *rejected*, *dropped*. It now reads `874 counted · 46 set aside`, and the second half is the link. **The line was not too long; it was ambiguous in the one place ambiguity costs the most.** Worth carrying into the copy-simplification pass: shortening prose is not the same operation as removing ambiguity, and this line would have survived a pass that only counted words.

**Not added to the primary nav.** Six screens is already the limit for a judge with thirty seconds. The link sits where the question forms — on the record count itself — which is more discoverable than a seventh nav item and costs nothing to the five people who never wonder.

### ADR-107 · The review queue drains in place; a decision never parks the reviewer on a confirmation screen

**Decision:** Approving or rejecting a proposal refreshes the queue in place — the decision is recorded, the total drops, and the next pending proposal appears where the last one was, under a one-line confirmation. `<ReviewCard>` is keyed on `matchId`. There is no "done" screen and no instruction to reload.

**Because the first version was wrong twice, and the two faults compounded.**

1. **`<ReviewCard>` was rendered without a `key`.** React reconciles by component type and position, so navigating `?page=1 → ?page=2` **reused the same instance** and its `done` state survived the navigation. Every later proposal rendered as the confirmation screen for the first one, and the only thing that visibly changed was the page number in the server-rendered `Paginate` beneath it. The reviewer could not reach proposal two at all.

2. **An approved proposal LEAVES the queue,** so "next" never meant what the control implied. Refreshing in place is the honest model, and it is how a work queue is actually worked.

**A second number was being invented.** The done screen printed `Math.max(0, total - 1)` — a guess that one fewer remained — directly above a `Paginate` showing the real `pagination.total`. The page therefore displayed **66 and 67 simultaneously**, from one source, one of them fabricated. Every count on the screen now derives from `pagination.total` and there is no arithmetic anywhere in the view.

**The flash lives in the parent, not the card, precisely because the card is keyed.** A confirmation stored inside a component that unmounts on success erases itself at the moment it is needed. `ReviewQueue` owns the message; `ReviewCard` owns the form state and resets with the proposal.

> **A RUNTIME RULE `tsc` CANNOT SEE, HIT ON THE FIRST ATTEMPT.** The initial fix passed `hrefFor={(p) => …}` from the server page into the `'use client'` queue. **Functions cannot cross the server-to-client boundary** — React serialises every prop into the RSC payload and a closure has no serialisation. It typechecked cleanly and threw on load. The prop is a `runQ` string now and the href is built client-side. Third distinct class this session that types could not catch, after the `null` ReactNode and the `position: relative` table row.

**Verified by doing it, not by reading it:** a real approval through the browser advanced the queue from one proposal to a different one, moved all four on-screen counts from 67 to 66 together, cleared the form, and produced audit entry **#733** `MATCH_APPROVED_BY_HUMAN` with the queue total dropping 67 → 66 on the API.

### ADR-108 · A confirmation is transient; and `/matches` filters by WHO CONFIRMED, not only by tier

**Two fixes from one walkthrough, both about state or a filter outliving its meaning.**

**1 · The confirmation banner followed the reviewer through the queue.** ADR-107 moved the flash out of the keyed card and into `ReviewQueue` so it would survive the card remounting on success. `ReviewQueue` is not keyed either — which is what makes that work — so the message also survived `?page=` navigation, and a reviewer paging forward saw *"Approved."* announcing a decision three proposals ago. **The same defect as the unkeyed card it replaced, moved up one level: state outliving the event it describes.**

It is now dismissed two ways, because one is not enough: a 4-second timer, and an effect keyed on `pagination.page` so paging away clears it immediately. The flash object carries an `id` so two identical messages in a row still re-arm the timer — `setFlash('Approved.')` twice is the same value, and a `[flash]` effect would not re-run on the second.

4 seconds rather than the 1–2 suggested: the message is a full sentence, and a banner that vanishes before it can be read is the same failure in the opposite direction.

**2 · `/matches?tier=manual` was empty and could never not be.** Approving a proposal **keeps the tier it was found at** and changes its status to `human_confirmed`. `manual` is the tier for matches a human creates from scratch through endpoint 21, which is not built (ADR-102). So the one filter a reviewer reaches for after approving twenty matches is the one filter that can never contain them.

Endpoint 8 has always accepted `?status=`; **nothing in the frontend used it.** `/matches` now leads with a *Confirmed by* row — All · Engine confirmed · **You confirmed** · Waiting for you — each carrying its count from three parallel reads, so a filter says what it will return before it is clicked. Tier moves to a second row.

**The empty states now explain themselves rather than saying "no results".** `tier=alias` states that no alias has been taught yet and links to the review queue.

**And the `manual` tier filter is REMOVED from the control row entirely.** Explaining a control that can never do anything is still shipping a control that can never do anything — the honest move is not to offer it. The distinction against `alias`, which stays, is the useful one: **a filter that is EMPTY today is worth offering** because teaching one alias fills it; **a filter that is IMPOSSIBLE is a dead control**, and offering it invites the wrong conclusion — that approvals went missing rather than that they live under a different heading. `/matches?tier=manual` typed directly still explains itself, for anyone on an old link.

> **A CONSEQUENCE TO CARRY INTO THE DEMO, not a defect.** `runs.metrics` is frozen at run completion (ADR-041), so the dashboard headline still reads **65.22%** and **71 pending** while `/matches` truthfully reports 22 human-confirmed and 49 pending. Both are correct — one is the engine's account of itself at the moment it finished, the other is live — but a judge who approves a few proposals and then returns to the dashboard will see two pending counts that disagree. **Either re-run before demoing, or say plainly that the headline is the run's own frozen figure.** Testing this session has moved the review queue from 71 to 49; a fresh run restores it.

### ADR-109 · A concluded investigation is RETURNED, not refused; `409 INVESTIGATION_IN_PROGRESS` means in progress

**Decision:** `POST /api/exceptions/:exceptionId/investigate` now distinguishes three states where it previously collapsed two:

| Existing investigation | Response | Spends money |
|---|---|---|
| none, or `failed` | `202` — dispatches a new investigation | **yes** |
| `running` | `409 INVESTIGATION_IN_PROGRESS` | no |
| `concluded` | **`200`** with the existing investigation and `reused: true` | **no** |

**This is a contract change.** `api-contract.md` §0 listed `409 INVESTIGATION_IN_PROGRESS` for "investigation already exists", and that document is binding until an ADR says otherwise (CLAUDE.md §3). It is corrected in the same commit.

**Because the endpoint was refusing where it should have been answering, under a code that was not true.** `ux_inv_exc_active` (migration 010) already guarantees at most one non-failed investigation per exception, so **the money guarantee was never in question — Postgres enforces it.** What was wrong is what a caller got back: an investigation concluded an hour ago returned `409 INVESTIGATION_IN_PROGRESS`, a status code asserting work is happening when none is. A client cannot distinguish "wait and poll" from "here is your answer" from that.

The practical consequence is the one that matters for a demo: **a judge clicking "Ask the Analyst" on an exception someone already investigated should see the investigation, not an error.** Under the old behaviour the second viewer of the most interesting exception on the site got a red banner.

**`failed` remains re-runnable, and that is deliberate.** Memoising a failure forever would mean one grounding rejection or budget exhaustion permanently poisons an exception. The partial index's `WHERE status <> 'failed'` predicate already encodes exactly this rule; the route now agrees with it.

**What this is NOT.** It is memoisation — look up before working — not idempotency. Idempotency would require a caller-supplied request key and would make a *repeat* of the same request safe; this makes *any* second request cheap by returning what the first one produced. The distinction decides where the fix lives: in the lookup, not in a key. Worth naming because "make it idempotent" would have sent someone to build request-key plumbing this system does not need.

**Re-running a concluded investigation is not offered at all**, and that is a deliberate omission rather than an oversight. It costs $0.10–0.12, the model is not deterministic, and a second opinion that disagrees with the first raises a question nobody has budget to resolve. If it is ever wanted it should be an explicit, separately-labelled, cost-stating action — never the same button.

### ADR-110 · An investigation's `status` is read before any of its fields; a running one has no findings to show

**Decision:** `AnalystPanel` branches on `status` first and renders `running` and `failed` as their own states. Nothing describing a *result* — verdict, confidence, grounding, cost, tokens, reasoning — is drawn until `status === 'concluded'`. `costUsd` and `tokensIn/Out` are typed `number | null` to match the table.

**Because a running investigation is mostly NULLs and one dangerous default.** `startInvestigation` inserts only `run_id`, `exception_id`, `status`, `model`, `prompt_version`; every result column is written by `concludeInvestigation`. So while the loop is running:

```
cost_usd          NULL          → `.toFixed(4)` threw, and the page went to the error boundary
tokens_in/out     NULL          → `count(null)`
grounding_passed  false         ← the COLUMN DEFAULT, not a finding
```

The crash was the *lesser* bug. Had the panel survived that line it would have rendered **“Grounding: Rejected”** about a verdict that did not exist yet — a confident, specific, false claim, on the page whose entire subject is not claiming more than the evidence supports. **A schema default is not a measurement**, and treating one as a finding is the same error as putting an engine figure in a measured tile (ADR-098).

> **THIRD TIME A TYPE I WROTE WAS A LIE, AND THE THIRD TIME IT COST A RUNTIME CRASH.** `amountAtRiskDisplay: string` was really `string | null` (ADR-105). `costUsd: number` is really `number | null` — and I had written the reason down myself, in a comment in this very repo: *"NULL on a free-tier key, never 0."* Widening the declaration to the truth made `tsc` immediately name all three crash sites it had been blind to. **The compiler is only as honest as the annotations, and every one of these was a case of me telling it what I hoped rather than what the schema says.**

**The heading follows the status too.** "The Analyst Investigated This" above a panel reading "working on it" is a small lie, and this is the wrong page to keep one.

**And the error boundary stopped blaming the API for its own bugs.** `app/error.tsx` printed *"The API is expected at … check CORS_ORIGIN"* unconditionally, so a React render error sent the reader to debug their network. The advice is now shown only when the message looks like a transport or contract failure; otherwise the page says plainly that the data arrived and the page failed to draw it. **An error surface that names the wrong cause is worse than one that names none**, because it sends someone confidently in the wrong direction — which is exactly what happened.

### ADR-111 · Starting a run is free by default; the explain layer is the only spend and it is a choice

**Decision:** The dashboard carries a run launcher. It posts `useSeedDataset: true` with `configOverrides: { llmExplainEnabled }`, and **that box is unchecked by default**. The engine — ingestion, matching, classification, group assembly, the audit chain — involves no model at all, so a run costs nothing unless the reader asks for explanations.

**Because the most prominent button on the landing page must not be able to spend a stranger's money.** A judge will click it. `POST /api/runs` runs S13 automatically, capped at `llmMaxCallsPerRun` (~$0.03), and until now nothing in the interface exposed that or offered a way to decline it. Task 7c turns this path into a per-click cost, which is why the gating had to land first rather than alongside.

**Two things measured while building it, both stronger than expected:**

1. **A run with `llmExplainEnabled: false` produced 0 API calls and byte-identical results** — 65.22%, 212 exceptions, same audit chain. ADR-017 says the model narrates decisions the rules already made; this control is where a viewer can *prove* that themselves by running it both ways, rather than being told.

2. **It still showed real explanations: 199 of 200 came from `llm_cache`.** The signature is a bucketed shape — category, amount-delta band, date-delta band, sources present, anchor strength, candidate-count band — with **no record identity in it at all**. So explanations generated by an earlier run apply to a later one over different rows. A "free" run is not a degraded run; it is the same run reusing what was already paid for.

**The second finding is the one that changes 7c's economics.** A freshly generated dataset producing the same *kinds* of discrepancy hits the same signatures, so the feared "every fresh run costs another $0.03" is wrong after the first. Only genuinely novel shapes cost anything.

**The launcher disables the option rather than hiding it** when `/api/health` reports `llmConfigured: false`, and says why. A control that silently no-ops is worse than one that explains it cannot act.

### ADR-112 · Web types are checked against the migrations, because three of them were wishes

**Decision:** Nullable columns in the schema must be nullable in `apps/web/types/api.ts`. Checked by comparing `information_schema.columns` against the declarations rather than by reading.

**Because the audit found a fourth live crash the moment it was run.** `matches.score_breakdown` is NULL for 39 of 284 matches — every `exact` match and, critically, **all 7 `pending_review` batch matches, which are in the review queue.** `ScoreBars` indexed it directly, so review pages 23, 26, 28, 29, 30, 31 and 34 threw `Cannot read properties of null (reading 'amount')`. Seven of forty-nine pages, live, reachable by paging.

**And drawing four bars of `0.0000` would have been worse than the crash.** A batch match comes out of the subset-sum search, not the pair scorer: there are no amount/date/anchor/counterparty components for it. Rendering zeros asserts the engine measured each component and found nothing — the exact opposite of the truth. The panel now says there is no component breakdown and why, and reports that the confidence came from the decomposition.

> **THE PATTERN, NAMED AFTER FOUR INSTANCES.** `amountAtRiskDisplay: string`, `costUsd: number`, `tokensIn/Out: number`, `scoreBreakdown: Record<…>` — every one declared non-null, every one nullable in Postgres, every one a runtime crash or a false claim. **TypeScript found all of them within seconds of the annotation being corrected, and none of them before.** The compiler is exactly as honest as what it is told, and these were cases of writing down the happy path and calling it a type. The check belongs in AUDIT-4 as a command, not a habit.

### ADR-113 · An exception's own `runId` decides which investigations belong to it — never the page's resolved run

**Decision:** `ExceptionDetail` exposes `runId`, and the exception detail screen uses it. `resolveRun()` answers *"which run is this screen about"*, which is the wrong question for a screen that is about one exception.

**Because the second run in the database broke the first one's Analyst entirely, in three places at once.** The detail page derived the run from `?run=` or "most recent completed", then asked endpoint 26 for that run's investigations and filtered by exception id. Correct while exactly one run existed. The moment a second appeared and became the default:

- every exception from the older run reported **"no one has investigated this"** and offered to spend money on work already done;
- the poll after a real investigation **never found it**, because it kept looking under the wrong run — so the button said *"the page updates itself"* and the page never did;
- the dashboard's Analyst block reported **Phase A had not run**, on a run with eleven investigations.

One coupling defect, three symptoms, all of them shaped like the agent not existing.

**The fix is additive and in ADR-073's shape:** a record that belongs to a run should say which run, and any consumer that needs the answer should read it rather than infer it from global state. **The bug was latent from the moment the page was written and invisible until a second run existed** — which is exactly the condition task 7c creates on every click, so it would have shipped straight into the feature that makes runs cheap to create.

> **A TEST RUN CAUSED IT.** The `phase4-free` run I created to verify the launcher became the default and broke the screen I had built an hour earlier. Nothing in the test suite covers "two runs exist", and the fixture-based integration tests create exactly one.

### ADR-114 · The Analyst gets a screen, and everything on it is evidence

**Decision:** `/analyst` is a first-class screen in the primary nav. It explains the loop in four steps, lists **the tools the agent actually called with their real counts**, shows the verdict distribution, lists every investigation, states the cost, and states plainly what is not measured. The exception list marks investigated rows with an `Analyst` chip; the dashboard block links through.

**Because the track asks for an agent and ours was invisible.** The layer is the most architecturally careful thing in the repo — read-only enforced by Postgres, no arithmetic of its own, a grounding gate that rejects unsupported verdicts — and its entire presence in the product was **one button at the bottom of one exception detail page**. A judge with sixty seconds would have concluded there was no agent. For grading purposes, a layer nobody can find is a layer that does not exist.

**THE TOOL LIST IS DERIVED, NOT TRANSCRIBED.** It is built from the tool calls recorded in the persisted reasoning chains, with their counts — 59 calls across 11 investigations, 7 distinct tools. If the agent never called a tool, that tool does not appear. A list copied out of `agent-design.md` would describe a design; this describes behaviour, and the difference is the entire reason the page earns its place on a site whose argument is that its claims are checkable.

**The caveat block is as prominent as the metrics.** *"None of this is scored against the answer key"* sits beside the cost figure, not below the fold. And the grounding-failure count is given both readings in the same breath — the gate working, and the model asserting what it had not established — because both are true and picking one would be editing.

### ADR-115 · A citation is resolved to its kind before it is linked; and a "not built yet" page must not outlive the build

**Two defects, both about a page asserting something that used to be true.**

**1 · Citations are not all transactions.** The A3 grounding gate accepts any id that appeared in a tool result, and the tools return more than one kind: `get_transaction` yields transaction ids, `get_exception` and `find_similar_exceptions` yield exception ids. On the holdout the split is **18 transactions to 8 exceptions**, and the panel linked all 26 to `/records/:id`.

So **roughly a third of citations led to a not-found page** — on the one element of the Analyst panel whose entire purpose is letting a reader check a claim against the record behind it. A citation that cannot be followed is not a citation.

Each distinct id is now resolved server-side before rendering: transaction → `/records/`, exception → `/exceptions/`, and anything that resolves to neither renders as **unresolved rather than as a dead link**, because a citation the gate accepted with nothing behind it is a finding rather than a broken href. All 26 now reach a live page.

The chips also stopped showing eight hex characters. `record · gbBjF2pd5DHVpJSKOLGXR · bank · ₹4,06,441.50` is checkable; `07f111a4` is not, and the difference matters precisely because this is the evidence surface.

**2 · The 404 page still said the site was half-built.** Written during U17, when the dashboard genuinely was the only screen, it read: *"the exception list, exception detail, review queue, matches browser, aliases and audit screens are still being built."* U18 built all six and nobody returned to that file. A reader who followed a broken citation was told the exception detail screen did not exist — while looking at it in the previous tab.

> **A STALE EXPLANATION IS WORSE THAN NO EXPLANATION.** "No explanation" leaves someone to investigate; a confident wrong one sends them away to wait for a feature that shipped days ago. It cost real confusion here, and it is the same failure shape as the error boundary blaming the API for a render bug (ADR-110) — **a surface that is certain about a cause it does not know.** The page now states only what it can: the id is not in the database, ids are per-run, here are three places to go.

### ADR-116 · A poller belongs to the state it watches, must be cheaper than the page, and must not need JavaScript to be escapable

**Three defects in one control, each one caused by the fix for the previous.**

**1 · The poller was owned by the component that started the work.** `AskAnalyst` fired the request and then set an interval to watch for the result. Three seconds later its own first refresh made the investigation row exist, the page swapped `<AskAnalyst>` for `<AnalystPanel>`, `AskAnalyst` unmounted, and the unmount cleanup added in Phase 3 to stop the interval leaking stopped the only thing driving the page.

> **A watcher owned by the action is guaranteed to be destroyed by the first change it successfully detects.** The Phase 3 fix was correct in isolation — an interval really must not outlive its component — and choosing the wrong owner turned it into a stall. The poller is now mounted by the *running state*, so it lives exactly as long as the thing it is watching.

**2 · Then it rate-limited itself.** The poller called `router.refresh()`, which re-renders the whole exception detail page — and that page costs roughly seven API reads. Every three seconds is ~140 requests/minute against ADR-096's 120/minute read ceiling. Every refresh 500'd, so the page still never updated, now for a completely different reason. It polls `GET /api/investigations/:id` instead — **one** request — and spends a full refresh only at the single moment the status changes.

The same pass removed a redundant read: endpoint 26 already returns full investigation objects, so re-fetching the same row through endpoint 27 was a second request buying nothing.

> **THE RATE LIMITER IS SHARED, AND THAT IS WORTH KNOWING BEFORE THE DEMO.** Page renders are server-side, so the API sees the Next server's IP, not the viewer's. `120/min per IP` therefore isolates nothing between browsers: several judges on the deployed site draw from **one bucket**. This is the inverse of `TRUST_PROXY_HOPS` (ADR-096) — there the risk was everyone sharing the edge's IP; here it is everyone sharing the renderer's.

**3 · And the escape hatch needed the thing that might be broken.** Both the give-up state and the live state offer a plain `<a>` to the page's own URL beside the refresh button. If the automatic check ever fails *because* client JavaScript is not running — a chunk that failed to load, a hydration error, an extension — then a button wired to `router.refresh()` is no fallback at all: it needs exactly what is broken. A link is a full page load and works when nothing else does.

**It gives up out loud after 90 seconds**, against `agent-design.md` §8's 60-second bound. Silent polling that has quietly died is indistinguishable from work still in progress, and a reader watching a spinner cannot tell which they are looking at.

---

### ADR-117 · The demo dataset gets its own seed, because DEV and HOLDOUT already have jobs

**Decision.** A second committed dataset is generated at **seed 20260905**, label **`demo`**, at
`data/fixtures/demo/` with its answer key at `data/truth/demo_seed_20260905.json`. It is *not*
DEV_SEED (1337) promoted to a shipped artifact.

**Why not just commit the dev dataset, which already exists on disk with a key?** Because ADR-027
gives the two existing seeds mutually exclusive roles — **develop against DEV, report against
HOLDOUT** — and the whole force of that rule is that a reader can tell which number came from which
seed. A dataset we tune against, shipped as the thing we demo, blurs exactly the line ADR-027 draws,
and invites the one question this project cannot afford: *"did you tune on the data you are showing
us?"* The answer would be "no, but the seed is the one we develop against", which is a worse answer
than not needing one. A third seed costs a single command and removes the question.

It also keeps `data/fixtures/dev/` gitignored, so regenerating dev during development cannot
silently change a committed artifact.

**What the second dataset is for.** `datasetSeed` has been parsed, persisted and serialised since
Day 8 and honoured nowhere (ADR-103) — `readSeedDataset()` always returns the holdout. So the two
runs on the dashboard reconcile **byte-identical inputs** and report 65.22% twice. That is correct
output and a dishonest impression: two rows that look like two experiments are one experiment run
twice. F3 makes the seed load-bearing; this ADR is the data it loads.

**Verified.** 300 events → 922 records (324 gateway / 303 bank / 295 ledger), 21 designed-
unresolvable, ceiling 93%, 915 expected pairs. All three CSVs differ from holdout's byte-for-byte,
and regeneration is byte-identical (ADR-067's determinism, re-checked on the new seed). The
scenario distribution matches holdout's because §3's weights are fixed — **the datasets differ in
content, not in difficulty**, which is what makes two runs comparable rather than merely different.

**A committed dataset must have a committed answer key.** Without one, two of the four headline
tiles render "not measured" (ADR-041 + the provenance rule of ADR-098), so a keyless dataset makes
the *weaker* demo, not the stronger one. F3 restricts `datasetSeed` to datasets that have a key, and
refuses the rest with `400` rather than accepting and ignoring — the defect shape ADR-094 named.

---

### ADR-118 · `datasetSeed` selects the bytes, and an unknown seed is refused — the third instance of one defect, closed

**The defect (ADR-103).** `routes/runs.ts` parsed `datasetSeed`, `repositories/runs.ts` persisted it and `serialize.ts` published it back — and `readSeedDataset()` was a **zero-argument closure** that always returned the holdout. Passing `datasetSeed: 12345` produced a run *labelled* 12345 that *reconciled* 90210. Identical in shape to `AGENT_MAX_COST_USD_PER_RUN` (fixed, ADR-094) and `STALE_RUN_TIMEOUT_MINUTES` (still open, ADR-097): parsed, documented, published, enforced nowhere.

**The decision.**

1. `readSeedDataset(seed: number | null)` resolves through a registry in `config/datasets.ts`.
2. An unregistered seed is refused with `400 INVALID_REQUEST`, carrying `availableSeeds` in `details`. **A field that accepts what it cannot honour is dishonest; one that refuses is not.**
3. A run with no `datasetSeed` now persists `90210` rather than `NULL`, so every run records what it actually read instead of leaving the reader to assume.
4. The dataset is loaded **before** `createRun`. An unreadable dataset fails the request rather than leaving a run stuck at `pending` that nothing will finish — there is no reaper (ADR-097).

**Why the registry is a hand-maintained allowlist and not a directory scan.** A dataset is offerable only if it has a committed answer key; without one it can never populate `score_reports` and two of four headline tiles render "not measured" (ADR-041, ADR-098), making the *weaker* demo. But the obvious check — look for `data/truth/<label>_seed_<seed>.json` — is exactly what **ADR-021 forbids**, and the leak guard enforces that by grep, so even an `existsSync` fails it. **So the engine is told which datasets are offerable and never told why.** The invariant is enforced outside the wall by `tools/generate/committed-datasets.test.ts`, which may see both sides: it asserts every registered seed has committed fixtures *and* a committed key, that the key was generated from that seed, that the fixtures hash to what the key's manifest claims, and that all four files are **tracked by git** rather than merely present on disk.

**DEV_SEED (1337) is deliberately not offerable.** `data/fixtures/dev/` is gitignored, so it does not exist in a deployed environment. A seed that works only on a developer's laptop is worse than one that is not offered.

**Measured.** A fresh run with no `datasetSeed` reproduces the holdout **byte-for-byte** — identical `input_file_hashes`, 65.22%, 212 exceptions. A run at seed 20260905 produces **64.61% and 198 exceptions**, and scores against its own key at **precision 1.0000, FP 0**, recall 0.6139, macro P 0.919 / R 0.8833, unresolvable recall 1.0, every honesty gate passed, exit 0.

> **THE SECOND DATASET IS ALSO EVIDENCE, NOT JUST FURNITURE.** The engine had never been scored against data it was not built on. It holds precision at 1.0000 with zero false positives on a dataset that did not exist when the matching rules were written. That is a stronger claim than anything the holdout alone can support, and it is available because the seed now does something.

---

### ADR-119 · Every matching figure ships twice: engine-alone and with review

**A measurement that changes when nobody changes the code is not yet a measurement.**

Run `verify` was scored at **recall 0.6075**. A re-score of the same run, with a byte-identical `tools/score`, returned **0.6941**. Between the two, a human approved 22 matches. `validation-strategy.md` §5 counts `auto_confirmed` **or** `human_confirmed` as a true positive and `scoring.ts` implemented that faithfully — so **8.7 points of "measured accuracy" arrived because somebody clicked Approve**, and nothing on screen or in the report said so.

**This was not a bug.** It was a documented rule meeting a fact the rule did not anticipate: `human_confirmed` is a state a match *enters after the run is over*. The figure was correct at the instant it was computed and silently wrong an hour later.

**Decision.** Every matching figure is computed under two confirmation policies, and **both always ship, both always labelled**:

| | Confirmed | Deferred | Property |
|---|---|---|---|
| `ENGINE_ALONE` | `auto_confirmed` | `pending_review` + `human_confirmed` + `human_rejected` | **invariant after the run finishes** |
| `WITH_REVIEW` | `auto_confirmed` + `human_confirmed` | `pending_review` | moves as reviewers work |

`ENGINE_ALONE` is the headline for any claim about the **engine**; `WITH_REVIEW` is the system including its human loop, and is honest only with the human decision count printed beside it. Reporting either alone is the failure this ADR exists to prevent. It is ADR-020's cold/warm discipline applied to review, which is where it should always have been.

**The stability is a property of the API, not a convention.** `POST /api/matches/:matchId/approve` refuses anything that is not `pending_review` (`409 MATCH_NOT_REVIEWABLE`), so review can only move a match *between* review states — never into or out of `auto_confirmed`. Engine-alone therefore reconstructs the run exactly as the engine left it, however much reviewing has happened since.

**It also repairs `review_queue_precision`, which drifted for the same reason.** As reviewers clear the queue the denominator shrinks, so *"when this engine asks a human, is it asking about the right things?"* was being answered over a human-selected subset of the engine's own asks. Engine-alone answers it over the queue **as the engine handed it over**, which is the question §5.1.1 poses.

**Verified.** Engine-alone reproduces `verify`'s pre-approval report to the digit (P 1.0000, R 0.6075, TP 435, FP 0). The guard was watched failing: widening `ENGINE_ALONE` to include `human_confirmed` — the pre-ADR behaviour — fails *"ENGINE_ALONE changed when a human clicked Approve"*. `SCORER_VERSION` 1.3.0 → 1.4.0, so re-posting appends rather than colliding with the unique constraint and the older measurements survive as history.

> **THE SELF-CONSISTENCY CHECK THIS UNLOCKED, AND IT WAS PREVIOUSLY IMPOSSIBLE.** Three runs reconcile identical holdout bytes with identical code, so they must score identically. They now all report engine-alone recall **0.6075**. Before this change one of them reported 0.6941 and nothing was wrong with it. **An invariant that cannot be stated cannot be checked**, and "two runs over the same bytes agree" is the cheapest regression test this project has never had.

---

### ADR-120 · A frozen figure and a live one may both appear, provided each says which it is

**The symptom.** The dashboard read **71 pending review** while `/review` and `/matches` read **49**, for the same run, at the same moment. Both were right. `runs.metrics` is frozen at run completion (ADR-041) and records what the **engine deferred**; the review screens count what is **still waiting**. Nothing on either screen said which question it was answering.

**This is ADR-119's defect one layer up**, and the fix is the same shape: the problem was never that a number was frozen, it is that a frozen number and a moving number were presented as though they were the same number.

**Decision.** Keep the frozen figure — it is the engine's own account of itself and ADR-041 is right that it should not be recomputed — and **render the live state beside it, labelled**:

```
71 groups · 219 records                       what the engine deferred
22 have since been decided by a reviewer,     what has happened since
so 49 are still waiting
```

**One extra request, not three.** `countPendingReview` fetches only `pagination.total` at `pageSize: 1`. The count of decisions is then `frozen − live`, which is exact rather than an estimate: `POST /api/matches/:matchId/approve` refuses anything that is not `pending_review` (`409 MATCH_NOT_REVIEWABLE`), so review moves matches **out of** the deferred pile and never into it. The identity `frozen = still_waiting + approved + rejected` holds on both reviewed runs (71 = 49 + 22 + 0, and 71 = 70 + 0 + 1). It does **not** split approvals from rejections, which is `/review`'s job — the dashboard's question is only "has this moved since the engine finished?"

Request count matters here because renders are server-side, so the API sees the Next server's IP and all viewers draw from one 120/min bucket (ADR-116's note). A three-request version of this would have been a 43% increase on the dashboard's read cost for a distinction two numbers already answer.

**A failed fetch renders as an absence, never as a fallback to the frozen number** — falling back would silently recreate the exact ambiguity this ADR removes, and would do it only under the conditions where nobody is watching.

---

### ADR-121 · A run in flight has no metrics and no reference date, and the run list is where it shows

**Found by F6's nullability audit — the fifth instance of the type-level lie ADR-105, ADR-110 and ADR-112 each recorded once.**

`types/api.ts` declared `RunSummary.headline: RunHeadline` and `RunSummary.referenceDate: string`. Both are false for a run that has not finished:

| Field | Actually null while | Because |
|---|---|---|
| `referenceDate` | `pending`, `ingesting` | derived from the data at S1 (ADR-039), so it does not exist before ingestion |
| `headline` | anything but `completed` | `runs.metrics` is written by S14 |

**The failure mode is worse than a crash, which is why nobody had seen it.** `RunPicker` maps over *every* run and read `run.headline.coldStartMatchRatePct` unguarded. With a run in flight that throws inside the map, and React takes the **whole Runs section** off the page — picker, launcher and all — while the request still returns **HTTP 200** and the rest of the dashboard renders normally. There is no error message, no missing-data state, and no status code to alert on. The section is simply gone.

That is why three separate probes said the page was fine: HTTP 200, no error-boundary markup, and the dashboard's own headline still present. The truth was only in the dev server's stderr:

```
⨯ TypeError: Cannot read properties of null (reading 'coldStartMatchRatePct')
    at RunPicker.tsx:37
 GET / 200 in 128ms
```

**Decision.** Both fields become `| null` in `types/api.ts`, and every reader renders the absence rather than a substitute. An in-flight row shows `—` in each metric column, never `0` — a figure that does not exist must not be drawn as one that does (ADR-098). `day()` is never called on a null: it throws `RangeError: Invalid time value` rather than returning a placeholder.

**Correcting the type immediately found a second reader** — `app/exceptions/page.tsx:135` read `run.headline.exceptionCount` in its empty state — which `tsc` had been unable to see for as long as the annotation was wrong. That is the whole argument for fixing the type rather than the call site.

> **THIS IS DIRECTLY IN F19's PATH.** The backlog wants a prominent "run a fresh dataset" control that lands on the new run's metrics. That lands a viewer on the dashboard during precisely the window where the run list disappears. **F19 cannot be built safely until this is fixed**, and it was found by an audit rather than by the demo only because F6 ran first.

**On the probe method.** HTTP status was the wrong instrument, the same shape of error as reading `tail`'s exit code instead of the scorer's. A server component that throws still returns 200. **The reliable probe is the render's own output — is the section present? — plus the server log.** Add both to AUDIT-4's click-through script.

---

### ADR-122 · A closed exception serves who closed it, when, and why — as one object

**The engine's decisions carry their reasons everywhere in this API. The one decision a *human* makes did not.**

Endpoint 20 has required a `note` and recorded `resolvedBy` since Day 8. `repositories/exceptions.ts` loads `resolvedBy`, `resolvedAt` and `resolutionNote` on every read. The audit log stores the reason verbatim. And `routes/serialize.ts` **dropped all three**, so the closed state on the exception detail screen could say only:

> *"This exception is closed as human resolved. Reopening is not possible…"*

On a product whose whole argument is that every decision carries its reason, the human's was the invisible one.

**Decision.** `ExceptionDetail` gains `closure`: `null` when the exception is open, and a complete object when it is closed.

```json
"closure": { "resolution": "human_resolved", "resolvedBy": "…",
             "resolvedAt": "…", "note": "…" }
```

**One object, not three parallel nullable fields, because the database already says they are one thing.** `exceptions` carries the check constraint `exc_resolution_complete`: `resolved_by`, `resolved_at` **and** `resolution_note` must all be non-null whenever `status` is `human_resolved` or `wont_fix`. Three nullable wire fields would model eight states where the database permits two, and invite a half-read — the shape F6 had just finished paying for (ADR-121). The serializer therefore emits the object only when all three are present, so a partial closure is impossible on the wire even if one ever reached the database.

**The reason is rendered as a quotation, at the weight the engine's reasons get.** A note paraphrased or truncated would be a worse artifact than none — the point is that a reader can check what the human actually said.

**The backlog proposed reading this from the audit trail instead, and that was the wrong instrument.** The trail on that page is fetched for the primary *transaction*, so a closure could be absent from it, ambiguous among several entries, or require parsing prose. The exception row **is** the canonical record of its own closure; the audit log is the immutable proof that it happened. Serving the row is direct, typed and exact.

**A serializer that omits a field is invisible to `tsc`** — the return type is `Record<string, unknown>`, so nothing about dropping three fields is a type error. `tests/unit/serialize-exception-closure.test.ts` asserts the wire shape instead, and all five of its cases were watched failing against the pre-fix serializer.

> **Two closures existed, not one.** CLAUDE.md and `what-broke.md` both record audit entry #728 as "the only human actor in the run". There are two resolved exceptions across the database — one in `verify`, one in `phase4-free` — and this screen displayed the reason for neither.

---

### ADR-123 · Closing an exception is terminal and changes nothing else

**Three questions the Day 16 walkthrough raised and did not answer.** Each has a different answer for a different reason, so leaving them as "probably fine" was not good enough — the exception list is the primary feature and this is what a judge will click.

**1 · Does a closed exception appear in `/matches`? No, ever.** ADR-043 already decided it — only endpoint 21 creates a match, at `tier: 'manual'`, and those are excluded from the engine's rate because *"a human fixing something is not the engine matching it."* Confirmed empirically rather than assumed: there are **zero `tier='manual'` matches** anywhere in the database.

> **One result looks like a contradiction and is not, so it is recorded here.** The one resolved exception on `verify` is a `DUPLICATE_RECORD`, and one of its records *is* in an `auto_confirmed` fuzzy match. That record is the **related** one, not the exception's primary — the original of the duplicate pair, which matches normally while its duplicate is the finding. The match was created by the engine at `11:35:10`; the exception was closed at `21:07:04`, nearly ten hours later. Closing created nothing.

**2 · Does it leave the exception list? No. It stays, and it is marked closed.** The list is the run's record of what the engine could not prove, not a work queue that empties. An exception that vanished when someone dealt with it would make the primary screen a moving target and its count unreproducible — two viewers would see different totals for the same finished run depending on who had clicked what. But leaving it *indistinguishable* is the defect that was actually shipping: the table had **no status at all**, so a reader counting open findings counted one already handled. Terminal statuses now carry a chip; `explained` does not, because it is the ordinary state and marking every row is noise.

**3 · Does it move a denominator? No.** `runs.metrics` is frozen at completion (ADR-041), so `matchRatePct`, `reconcilable` and `exceptions.total` describe the run as the engine left it. Measured on `verify` with one exception resolved: **65.22 / 874 / 212**, every figure unchanged.

**The consequence, and it is the third time this rule has been needed in one day:** the run's exception total and the number still open are two different figures, and neither may appear alone. Same rule as ADR-119 (engine-alone vs with-review) and ADR-120 (deferred vs still waiting). **A frozen figure and a live one may both appear, provided each says which it is** — that sentence is now load-bearing in three places, which is the argument for it being a rule rather than three separate fixes.

---

### ADR-124 · Decided proposals get a view, and an approval with no reason is shown as having none

**Found by Tejas walking the built UI, and it is ADR-122 a second time.** Approving or rejecting a proposal removed it from `/review`, after which it existed **nowhere but the audit chain**. On a product whose argument is that every decision carries its reason, both human decisions — closing an exception and deciding a proposal — were the ones that disappeared.

**It needed no new endpoint.** `matches` already stored `reviewed_by`, `reviewed_at` and `review_note`; endpoints 10 and 11 already wrote them; endpoint 8 already took `?status=`. **Only `matchSummary` was dropping them**, exactly as `exceptionDetail` had been dropping closures. Two instances of one shape in one day, in the same file.

**`/review` gains a second view rather than a second screen**, at `?view=decided` (ADR-101: every selection is a query param, so both are shareable links). The tab counts read `Awaiting decision 49` and `Decided 22`, and `49 + 22 = 71` — the frozen figure ADR-120 exposed, so the two screens now visibly reconcile. The decided count costs no extra request on the queue view: it is `frozen − live`, exact because approve refuses anything that is not `pending_review`.

**Rejections are shown beside approvals, deliberately.** Endpoint 11 returns a rejected match's *members* to the exception pool; it does not delete the match, so its row survives with the reason attached. A screen that listed only approvals would make the reviewer look like a rubber stamp — the interesting half of a review queue is the half where a human overruled the engine.

#### The asymmetry this exposed, which is a decision and not a bug

`review.note` is nullable while `reviewedBy` and `reviewedAt` are not, because **endpoint 11 requires a `reason` and endpoint 10 takes an optional `note`**. Overruling the engine must be justified; agreeing with it need not be.

> **All 22 approvals recorded so far carry no note.** The view renders that as *"none given — approving does not require one"* rather than printing the word "Approved" in the reason column. A substituted word would manufacture a justification nobody gave, which is the same failure as drawing an absent figure as a zero (ADR-098).

Whether approval *should* require a reason is a real question and is left open rather than decided here — it is a contract change to endpoint 10, it would invalidate 22 existing records, and `exc_resolution_complete` already takes the opposite position for exceptions (both terminal states require a note). **The two surfaces genuinely disagree, and that disagreement is now visible instead of hidden.**

---

### ADR-125 · The alias suggestion is real; the loop around it has three holes

**F9 set out to exercise the alias learning loop and found that it could not be reached at all.**

**1 · `aliasSuggestions` was a hardcoded `[]` (fixed).** `routes/runs.ts`'s review-queue handler returned an empty array with a comment deferring the work. `ReviewCard` renders its entire teach-an-alias section only when `aliasSuggestions[0]` exists — so the checkbox, the `wouldAlsoResolve` line, the conflict path, all of it, had never once been reachable from a browser. **ui-spec §7's demo path step 10 is "teach one alias, show `wouldAlsoResolve: 6`", and it could not be performed.** Fifth instance of declared-and-never-populated, after `datasetSeed`, `AGENT_MAX_COST_USD_PER_RUN`, `STALE_RUN_TIMEOUT_MINUTES` and this file's own error code below.

Now generated deterministically: a suggestion exists when a pending match's members carry **exactly two** distinct counterparty keys. One means nothing to teach; three or more means the group disagrees in more than one direction and the reviewer should not be handed a guess. **Canonical is whichever key already appears on more records in the run**, ties broken lexicographically — mapping the odd spelling onto the established one is the correction a reviewer means to make, and a length heuristic would invert on the first merchant whose abbreviation is longer than its full name. On the holdout this yields 5 suggestions over 49 pending proposals, the strongest being `API HOLDINGS → THREPSI SOLUTIONS` with `wouldAlsoResolve: 5`.

> **THE VALUES SENT ARE THE NORMALIZED KEYS, NOT `counterpartyRaw`, AND THE FIRST IMPLEMENTATION HAD THIS WRONG.** A bank row's raw counterparty is its whole settlement description — `IMPS-SETL-BMS TICKETS-697172334728-setl_cSIThmKMybcQZ8-BATCH29` — unique per transaction. Endpoint 10 derives `normalized_value` by running `normalizeCounterparty(rawValue)`, which does **not** reproduce the bank-specific stripping AUDIT-1 added in `eb5995d`. Suggesting the raw string would have taught an alias keyed on a value no future record can carry: a rule that looks taught, applies to nothing, and quietly makes every warm run identical to a cold one. Caught by reading the generated suggestions before teaching one.

**2 · `ALIAS_CONFLICT_UNCONFIRMED` is declared and thrown nowhere.** It sits in `ERROR_CODES`, `api-contract.md` promises it, and `ReviewCard` carries a full confirm-and-retry UI for it — *"The match was approved. Only the alias was held back."* Measured: proposing a **different** canonical for an already-active key returns **200**, supersedes the correct alias, and reports nothing. The repository's behaviour underneath is correct and deliberate (§6.3 supersedes with a penalty rather than overwriting, so `eligibleForAliasTier` goes false), but **the confirmation gate does not exist**, so a reviewer can silently replace a right rule with a wrong one. Not fixed here — it is only reachable from a UI that does not currently hydrate (ADR-126), and it deserves its own unit.

**3 · A warm run resolves more records and still reports itself as cold.** Teaching one alias moved matched members **570 → 573** and the match rate **65.22% → 65.56%**, with every honesty gate passing and precision unchanged. But `matches.tier` shows **no `alias` tier at all**, `learned_aliases.applied_count` stays **0**, `recordsAutoResolvedByAliases` is **0** and `leverageRatio` is **0** — so `coldStartMatchRatePct` equals `matchRatePct` and the run picker labels a genuinely warm run **Cold**.

> **ADR-020's entire reporting mechanism is the cold/warm pair, and on the only warm run this project has ever produced it reports zero leverage on an alias that demonstrably resolved three records.** The scorer sees it too: the answer key attributes 27 pairs to `viaTier: alias` and the engine attributes **0**. The learning works; the attribution does not. Until that is fixed the alias feature cannot be demonstrated, because its headline number is structurally zero.

---

### ADR-126 · No client component inside a page hydrates — every interactive control in the product is inert

**This is a P0, it is PRE-EXISTING, and it reproduces on `main` at `89500d5`.** Found while trying to teach an alias through the UI for F9.

**What was measured.** On the dashboard, `main button` matches exactly one element — *Run It Again* — and it has no React fiber attached (`Object.getOwnPropertyNames` shows no `__reactFiber$…`). Clicking it programmatically changes nothing in the DOM. The same holds on `/review` for the teach checkbox, the reviewer-name field, *Approve Match* and *Reject*, and for the view tabs and pagination links. **The masthead's links, in the layout, hydrate normally** — so React is running; it is the page subtree that never attaches.

**Every interactive feature in the product is affected:** `RunLauncher` (Run It Again), `ReviewCard` (approve, reject, teach an alias), `ResolveActions` (resolve, won't fix), `AskAnalyst`, `InvestigationPoller`, `VerifyChain`. `NavLinks` is the only client component that works, and it is the only one in the layout rather than a page.

**Ruled out**, each by measurement rather than reasoning:
- *A stale build* — reproduces after `rm -rf .next` and a fresh `next dev`.
- *F1's Suspense boundaries* — reverting `chrome/` to its pre-F1 state changes nothing.
- *Any Day 17 change* — an isolated `git worktree` at `main` on port 3100 fails identically.
- *A truncated RSC stream* — the raw HTTP response is complete: 318 KB, 112 `__next_f.push` calls, closing `</html>`, and React's `$RC("B:0","S:0")` boundary-completion script.
- *A failed chunk* — `app/review/page.js`, `layout.js`, `main-app.js` and `webpack.js` all return 200.
- *A hydration error* — the console is empty of errors on a clean load.

**Why nobody noticed.** The backlog's own loose-threads table already says it without drawing the conclusion: *"AskAnalyst arm → confirm panel — **never watched render**"*, *"Run launcher open state — same"*, *"the ticking counter and automatic transition are not [verified]"*. Day 16's resolve was exercised **against the live local API**, not through a browser click — `what-broke.md` says so in those words. **No client component in this application has ever been verified by clicking it**, and three of Day 17's own units (F10, F11, and the browser half of F9) were the ones scheduled to find this.

**Consequence for the plan.** F10 and F11 are not "verification" tasks any more; they are downstream of this. F28's approve/reject, F9's teach-an-alias, endpoint 25's Ask-Analyst button and the audit chain's verify button are all unreachable until it is fixed. **It outranks every remaining P1 on the Day 17 list**, and it must be fixed before the pitch video, because the demo path is a sequence of clicks.

Root cause is **not yet identified** and is deliberately not guessed at here. The next step is a minimal reproduction — one page, one `'use client'` button with an `onClick` that logs — to establish whether the failure is app-wide or specific to how these pages are composed.

---

### ADR-127 · F9.1 — SUPERSEDED BY MEASUREMENT: there was no hydration bug. The instrument was wrong.

> **CORRECTION, same day, before anything was changed.** Tejas opened the dashboard in an ordinary
> browser and clicked **Run It Again**. It worked: a run was created and appears in the picker as
> `demo-2026-09-02-13:41`. **The application hydrates correctly. The embedded browser pane used for
> every observation below does not complete a streamed response, and that — not the app — is what
> produced every symptom.**
>
> The reasoning below is left intact because the *method* was sound and the conclusion was not: four
> probes isolating one variable each, five causes eliminated by measurement, and a mitigation
> deliberately withheld pending a check only a human could run. **Withholding it is the only reason
> `app/loading.tsx` still exists.** Had the diagnosis been acted on, a working skeleton would have
> been deleted to fix a bug that was never there.
>
> **This is the fourth instrument failure in one day and by far the most expensive.** The others:
> reading `tail`'s exit code instead of the scorer's; reading HTTP 200 from a server component that
> had thrown; and `Object.keys` missing non-enumerable React fibers. Each time the *measurement* was
> wrong and the code was fine. **The rule this earns: before reporting that something is broken,
> establish that the instrument reports a known-good case correctly.** Probe 1 did exactly that —
> a sync page hydrated in the pane — which is precisely why the false conclusion survived. A
> known-good case that differs from the failing case *in the very dimension the instrument is weak
> on* proves nothing.
>
> **What remains true and is not superseded:** no interactive control in this product had ever been
> confirmed by a human clicking it until today. Day 16's resolve was exercised against the live
> local API, and the backlog says *"never watched render"* against three separate controls. F10 and
> F11 are still real work.

### (superseded) The original diagnosis: streamed Suspense boundaries

**Reproduced minimally, in four steps, each isolating one variable.** Every probe was a page rendering one `'use client'` counter button with a `useEffect`; "hydrated" means the button gained a React fiber, the effect ran, and clicking incremented the count.

| Probe | Page component | Result |
|---|---|---|
| 1 | sync | **hydrates** |
| 2 | sync + `export const dynamic = 'force-dynamic'` | **hydrates** |
| 3 | `async` + `await new Promise(setTimeout, 50)` — no network | **DEAD** |
| 4 | `async` + a real API fetch | **DEAD** |

So it is not `force-dynamic`, not the API client, not the network: **an `async` page component is enough.**

**The mechanism is the Suspense boundary, not the async-ness.** An async page streams into a boundary, and the payload ends with React's reveal script `$RC("B:0","S:0")`; a sync page's payload has no `$RC`. Removing `app/loading.tsx` — which is what creates that boundary for every route — removes the `$RC`, **and probe 3 and `/review` both hydrate immediately afterwards**, `/review` going from 0 of 6 interactive elements to 6 of 6, Approve Match included.

**Any boundary that actually streams is enough**, from any source. With `loading.tsx` removed, `/` and `/exceptions` still emit one `$RC` — from **F1's own Masthead Suspense** (ADR-121's `useSearchParams` requirement, the only other Suspense in the app) — and those two routes still fail. `/review`, which emits none, works.

**Ruled out by measurement, not by argument:** a stale `.next` (survives a clean rebuild); a duplicate React (one copy, 19.2.8, resolved from `apps/web`); a truncated response (318 KB, 112 payload pushes, closing `</html>`); a failed chunk (all 200); a console error (none); **and the React version — pinning `react`/`react-dom` to 19.1.1 changes nothing.** The first React-pin test was run while `loading.tsx` was still present and was therefore confounded; it was repeated afterwards and still showed no effect.

#### THE OPEN QUESTION, AND IT IS NOT ONE I CAN ANSWER

**Every observation above comes from the embedded browser pane.** Claude-in-Chrome was not connected, so there was no second browser to check against. A streamed-boundary hydration failure this total would be an extremely prominent bug in Next 15.5, which makes it genuinely plausible that **the pane, not the application, is what fails to complete a streamed response**.

The distinction decides the fix and they are opposite:

- **If a real browser fails too**, this is a P0 and the mitigation is to remove the streaming boundaries — delete `app/loading.tsx` (losing ui-spec §9's skeleton) and rework F1's Masthead Suspense.
- **If a real browser works**, there is no defect, the skeleton stays, and what needs fixing is the *belief* that these controls are verified — because they still would never have been clicked by a human.

**Nothing is changed in the app until that is answered**, because deleting the skeleton to fix a bug that does not exist is a real loss for nothing. The test takes thirty seconds in any ordinary browser: open the dashboard, click **Run It Again**, and see whether a confirmation panel appears.

> **Either answer is worth having.** The second one still leaves the backlog's own words standing — *"AskAnalyst arm → confirm panel: never watched render"*, *"Run launcher open state: same"* — and Day 16's resolve was exercised **against the live local API**, not through a browser. No interactive control in this product has been confirmed by a human clicking it, and that is true regardless of which way this lands.

---

### ADR-128 · The `Alias` type described a response the API has never sent

`/aliases` died with `RangeError: Invalid time value` the moment an alias existed. `types/api.ts` declared `createdAt`, `note` and `timesApplied`; endpoint 15 sends `approvedAt`, `appliedCount`, and no `note` at all — plus eight fields the type omitted entirely (`normalizedValue`, `confirmationCount`, `conflictCount`, `lastAppliedAt`, `eligibleForAliasTier`, `createdFromMatchId`, `scopeSource` as non-null, `status`). Reading `a.createdAt` yielded `undefined`; `at(undefined)` threw.

**`tsc` cannot see this.** The field is declared `string`, so every use of it typechecks, and it is only missing at runtime. It survived because **the screen had never rendered a row** — zero aliases had ever been taught, which is what F9 was investigating when it crashed.

**F6's audit should have caught it and could not, and that is the reusable lesson.** That audit compared fields the API sent as `null` against fields the type forbade null on. **A field that is entirely ABSENT from the response never appears in the observed-null set at all** — `absent` and `null` are different failures and the audit only modelled one of them. The audit needs a converse pass: for every field a type *declares*, assert the API actually sends it.

Fixed by transcribing the type from a real response, per ADR-098's rule that types are transcribed from responses rather than from the contract's prose. `note` had no counterpart, so the cell now shows something the API does serve and a reader of an alias ledger actually needs: **whether the alias is eligible for Tier 1.5**, since §6.3 holds a conflicted alias out until a second human confirms it — an alias can be `active` and still resolve nothing.

---

### ADR-129 · The run launcher chooses the dataset, and can no longer spend anything

**Two changes to the most prominent control in the product, for two different reasons.**

**1 · It offers the dataset.** `datasetSeed` has worked at the API since ADR-118, but `startRun` did not accept one and `RunLauncher` never sent one — so every click reconciled the holdout. **Nine of the first ten runs reconciled byte-identical input** (`sha256:3e58a16…`) and reported the same match rate, which reads as a broken or faked button rather than as determinism. It is in fact determinism working: a run is a pure function of its inputs (CLAUDE.md rule 8, ADR-067), and a "Run It Again" that produced a different number every time would mean no measurement in this project could be trusted. **The honest fix is not to randomise anything — it is to let the reader choose which dataset to reconcile**, and to say why the holdout reproduces itself exactly.

The list is **served from `/api/health`** rather than duplicated in the frontend, because the criterion for offering a seed — committed, with an answer key — is enforced on the API side (ADR-118), and a second copy of the list would eventually offer a seed `POST /api/runs` refuses.

**The label now names the dataset it ran.** It read `demo-<timestamp>` on every run while reconciling the holdout; with a committed dataset now actually called `demo`, that label was a false statement about which bytes a run had read.

**2 · The explain option is removed, not merely defaulted off (Tejas, Day 17).** It was an opt-in ~$0.03 pass, defaulted off, and its reasoning was sound — but the most prominent button on a public unauthenticated demo should have **no path** to spending real credit, not a path a stranger has to decline. Every run is now `llmExplainEnabled: false`.

> **Nothing is lost from the argument.** Every exception still gets its deterministic template, and no match, number, or audit entry differs either way — that is ADR-017, and it is the point. Plain English from a model stays available **per exception, on request, behind the Analyst's own confirmation**, which is where a human has already decided to spend. The one thing this forfeits is the side-by-side demonstration of ADR-017 by running the same dataset with and without explanations; that can still be shown from two existing runs rather than by offering a spend button.

---

### ADR-130 · F9.2 — the alias feature was attributed nothing, and cold-start reported the warm number

**Three defects, one theme: the learning loop worked and every figure describing it was wrong.**

**1 · Attribution counted the wrong tier.** `appliedAliasIds` and `recordsAutoResolvedByAliases` were both derived from `exactPairs.filter(tier === 'alias')` — **Tier 1.5 matches only**. But Tier 1.5 substitutes aliases and re-runs the **Tier 1 exact test**, which requires a shared strong anchor, and a *counterparty* alias creates no anchor. It feeds Tier 2's counterparty component instead (`counterpartyKey ?? counterpartyNorm`). So the entire alias family the review queue actually teaches can never produce a Tier 1.5 match, and was attributed **zero** by construction.

Measured before: `applied_count 0`, `last_applied_at null`, **no `ALIAS_APPLIED` audit entry ever written**, `recordsAutoResolvedByAliases 0`, `leverageRatio 0` — on a run where the alias demonstrably moved matched records 570 → 573.

Now derived from `Tier15Result.counterpartyResolutions` — S7's record of every transaction whose key an alias resolved, regardless of which tier used it — intersected with records that ended up matched. Both halves matter: a resolution that changed nothing is not leverage, and a match that would have happened anyway is not the alias's doing. **`leverageRatio` is now 6** — one human correction resolving six records, which is the number ui-spec §5 calls the feature's whole argument.

> `counterpartyResolutions` was declared in `types/engine.ts`, populated by S7, and read by **nothing**. Sixth instance of declared-and-never-consumed, after `datasetSeed`, `AGENT_MAX_COST_USD_PER_RUN`, `STALE_RUN_TIMEOUT_MINUTES`, `aliasSuggestions` and `ALIAS_CONFLICT_UNCONFIRMED`.

**2 · `coldStart.matchRatePct` was a copy of the warm rate, not a computation.** Both were literally `pct(matched.size, reconcilable)`. ADR-020 defines cold start as the rate **"with aliases disabled"** and exists to stop a match rate quietly including the benefit of human corrections — **and its implementation reported exactly that.** On a warm run the tile showed the alias's benefit under the label whose only job is to exclude it.

A cold run's own rate *is* the cold rate and is still reported. On a warm run the counterfactual has not been computed — it needs a second matching pass with the alias set empty — so it is **`null`, rendered as an absence that says why**. Reporting an honest absence is strictly better than a warm number wearing a cold label; computing the real counterfactual is filed as its own unit.

**3 · The run picker decided coldness by comparing the two rates**, which defect 2 made identical on every run — so **every run in the list was labelled "Cold"**, including the one with a learned alias active. Coldness is `aliasCountAtStart === 0` and only the API knows it, so `isCold` is now served on the headline and read rather than re-derived. That is ADR-088's rule — *the frontend must not re-derive a rule the API already answers* — and this is its second instance.

**Verified end to end on a fresh warm run:** `coldStart.matchRatePct: null`, `isCold: false`, `aliasesActiveAtStart: 1`, `recordsAutoResolvedByAliases: 6`, `leverageRatio: 6`, `applied_count: 1`, `last_applied_at` set, one `ALIAS_APPLIED` entry. The picker now shows Warm for every run after the alias was taught and Cold for every run before it. Re-scored: precision 1.0000 on both datasets, every honesty gate passed.

---

### ADR-131 · F9.3 — the alias conflict interlock, and the retry it had no way to complete

**`ALIAS_CONFLICT_UNCONFIRMED` was declared in `ERROR_CODES`, promised by `api-contract.md`, fully handled by `ReviewCard` — and thrown nowhere.** Proposing a different canonical for an already-active key returned **200** and silently superseded the correct rule. Measured live: it replaced a correct alias with a deliberately wrong one and reported success.

Sixth instance of declared-and-never-reached, after `datasetSeed`, `AGENT_MAX_COST_USD_PER_RUN`, `STALE_RUN_TIMEOUT_MINUTES`, `aliasSuggestions` and `counterpartyResolutions`.

**What is refused, and what is not.** Only a genuine disagreement — an active rule for the same key pointing somewhere else. Re-asserting the same mapping is a *confirmation*, and §6.3 counts it as one. The refusal carries the existing rule, who taught it, both canonical values and `confirmWith: { confirmConflict: true }`, so the reviewer decides against the thing they are replacing rather than against a constraint name.

**§6.3's supersede-with-penalty underneath is unchanged and was always right** — one misclick costs one extra review rather than poisoning auto-resolution. What was missing is that a reviewer has to be *told* they are about to spend it.

#### Two structural fixes the interlock could not work without

**1 · The approval commits in its own transaction.** `ReviewCard` promises *"The match was approved. Only the alias was held back — a judgement about this match is never discarded over a disagreement about a general rule."* Throwing inside the approval transaction rolled the approval back, and the first implementation did exactly that — **measured: the match returned to `pending_review`**, making the interface's sentence false. Aliases are now taught in a second transaction, after the approval is durable.

**2 · Idempotent no longer means inert.** `approve` short-circuits on an already-`human_confirmed` match and returned `aliasesCreated: []`. That made the interlock a **dead end**: it approves the match, refuses the alias, and the reviewer's "Replace the Existing Rule" retry arrives at an already-approved match, short-circuits, and reports success having written nothing. **The retry is the only attempt that was ever going to teach that alias.** The idempotent path now still processes `aliasProposals`.

**Verified live, in the order a reviewer meets it:** a conflicting proposal on a pending match returns **409**, leaves the alias untouched, and leaves the match **`human_confirmed`**; the retry with `confirmConflict: true` on that same already-approved match supersedes with a penalty and returns the new alias. Restoring the correct mapping through two confirmations then lifted the penalty exactly as §6.3 rule 3 says it should — `confirmation_count 2`, eligible for Tier 1.5 again.

**The guard is structural, because the defect was.** `tests/unit/alias-conflict-interlock.test.ts` asserts the code is referenced outside the enum that declares it — the precise property that was missing when it lived in `types/dto.ts` and nowhere else — plus that `confirmConflict` survives validation and that only an exact `true` counts, so silence is never consent. All three watched failing against the pre-fix source.

---

### ADR-132 · F9.5 — the cold-start rate is computed by a second matching pass, not estimated

**ADR-130 made cold start honest by reporting an absence. This makes it a number.**

S5–S11 is extracted as `runMatchingPipeline(pool, config, aliases, time)` — a pure function of its arguments that touches no database, writes no audit entry and reads no clock — and a warm run calls it **twice**: once with its real alias set, which *is* the run, and once with an empty one. The second pass's matched set is the cold-start figure. Nothing from it is persisted except the count.

**It is computed rather than derived, and the difference is not pedantic.** An alias rewrites `counterparty_key`, which feeds **blocking** and Tier 2 candidate generation as well as scoring. Subtracting alias-touched records therefore yields a *bound*, not an answer — and assignment is greedy and global (ADR-032), so a warm pass can in principle reassign a pair the cold pass matched. Only running the machine answers the question the label asks.

**Measured on the holdout with one alias active:**

```
warm                65.56%   573 matched
cold counterfactual 65.22%   ← computed in-run
alias TOUCHED        6 records
alias DECISIVE for   3 records
```

> **The counterfactual reproduces an independently produced cold run to the digit.** `verify` ran cold days earlier and scored **65.22%**; the in-run second pass computes **65.22%**. Two unrelated paths to the same number is the strongest corroboration available without a second implementation.

#### The second figure this unlocked, and it corrects a claim ADR-130 shipped

`recordsAutoResolvedByAliases` counts records an alias **touched** that ended up matched — six. Only **three** of those six needed it; the other three matched on amount and date regardless. `leverageRatio` divided by the touched count, so it read **6** where the causal figure is **3**: *"one correction fixed six records"* was a claim the data did not support.

`recordsDecidedByAliases` is now the causal count, `leverageRatio` divides by it, and the dashboard states the gap explicitly — *"the other 3 would have matched anyway. Only the decisive count is credited to the correction."* **Neither figure was knowable without a cold pass**, which is why ADR-130 could only report the absence.

#### The instrument is checked against a known-good case, because ADR-127 was not

`tests/unit/cold-pass.test.ts` asserts the property that makes two passes comparable at all:

1. **Two passes with the same alias set produce the identical matched set** — if the second pass saw different inputs, every cold figure would be a plausible wrong number, the worst failure available here.
2. **The pipeline does not mutate the pool it is handed.** `runTier15` returns copied records rather than writing `counterpartyKey` in place; if it mutated, the cold pass would inherit the warm pass's alias-resolved keys and report the **warm** rate under the cold label — ADR-130's exact defect, reintroduced by the fix for it. **Watched failing**: making `runTier15` mutate in place fails this test and no other.
3. **An alias only ever adds matched records.** Asserted on the shipped dataset rather than claimed as a law, because greedy global assignment does not guarantee it — if it ever fires, the cold/warm pairing has to be stated differently.

**Cost:** one extra matching pass per warm run, roughly a second, and nothing on a cold run — the pass is skipped entirely where the run's own figures already are the cold ones.

---

### ADR-133 · There is no "Measure" button, and the absence says why instead of naming a command

**The complaint was correct: the dashboard told a judge to run `npm run score`.** An instruction the only people who see that screen cannot follow, printed where a number should be — which makes a deliberate architectural boundary read as an unfinished feature.

**A Measure button cannot exist.** **ADR-021** forbids any module under `apps/api` from reading `data/truth/`, enforced by a leak guard that greps for it. That rule is why the accuracy claim is believable at all: *"does any code path reach the answer key?"* is otherwise a question you have to audit, and keeping the key outside the application makes leak-freedom obvious in five seconds. A button that made the API score a run would trade the project's central structural honesty claim for a convenience.

**So the measurement keeps arriving the way the contract always intended, just automatically.** `POST /api/runs/:runId/score-report` (endpoint 23) exists precisely so an offline scorer can push a result in. `npm run score:watch` is that scorer on a loop: it polls for completed runs with no report, scores each against the answer key its `datasetSeed` names, and posts it. **A run started from the dashboard is measured within a few seconds of finishing, and the engine still cannot see the answers.**

The key is found by filename — the generator writes `<label>_seed_<seed>.json`, so the seed→key mapping already exists on disk and a second copy in the watcher would eventually disagree with it. A run whose dataset has no committed key is reported and skipped, not retried forever.

**The copy now explains rather than instructs:**

> *Not measured yet — no score report has been posted for this run.*
> *The engine is never given the answer key, so it cannot mark its own work. Accuracy is measured by a separate offline pass and posted back, which is why this is absent rather than estimated.*

That sentence is worth more to a judge than the number would have been: it says the engine **cannot** mark its own homework, which is the property the whole measurement rests on.

---

### ADR-134 · F12 — a run cannot be retired, and that is the system working

**The task was "retire the test runs". The database refuses, twice over, and it is right to.**

Measured rather than inferred:

```
DELETE FROM runs      → violates FK "audit_chain_heads_run_id_fkey"  (ON DELETE RESTRICT)
DELETE FROM audit_log → "audit_log is append-only (attempted DELETE on sequence_no 4448)"
```

`audit_log.run_id` and `audit_chain_heads.run_id` are **RESTRICT**, and `trg_audit_log_immutable` fires `BEFORE DELETE OR UPDATE`. So a run's history cannot be erased and the run cannot be removed while it has one — which is every run. **That is ADR-015 doing exactly what it was built for**, and tidying a list by dismantling it would trade the project's audit guarantee for cosmetics. Not a trade worth making, and the refusal is a better demo than the tidy list would have been.

**The clutter is real, though.** Twenty runs, of which eighteen are Day 17 probes with names like `f6-crash-proof-2`, on a screen a judge scrolls past. So the fix is presentational and hides nothing: the picker shows the **five most recent**, always includes the selected run wherever it sits, states the true total, and links to all of them. The audit screen still lists every one.

> **Two runs must survive any future tidying, and they are the ones carrying every human action in the system.** `verify` holds 24 review decisions, a closed exception, 29 human audit entries and the three aliases in the ledger's supersession chain. `phase4-free` holds the only *rejection* — with its reason — and two closures. Everything else has zero human activity. If the demo database is ever rebuilt from scratch rather than tidied, those decisions have to be re-made deliberately, not assumed to carry over.

**What would actually clean the list** is rebuilding the demo database and performing the handful of runs and human decisions you want, in order. That is a real option before the pitch video and it costs nothing but the re-doing; it is not the same as deleting, and it does not weaken anything.

---

### ADR-135 · F13 — a tile label is read by someone who has not read the repo

**Two labels on the dashboard named their concept only for a reader who already knew it.**

- **"Ceiling"** → **"Best Possible"**, unit `maximum` → `on this dataset`.
- **"Grounding-Gate Rejections"** → **"Unsupported Claims Caught"**.

The backlog filed both as "opaque", and the third label it named — "Cold Start" — had already become **"Without Learned Rules"** under F30/F9.5. Re-reading the row before rewriting it was the difference between a two-label change and a wrong one.

**Why these two and not the others.** `Ceiling` is a field name (`measured.ceiling.theoreticalMaxMatchRatePct`) that reached the screen unchanged; "grounding gate" is this repo's name for A3 and means nothing outside `agent-design.md`. Neither reader-facing word survives the question *what does a panelist with fifty seconds conclude from this?* — and for the second one, the answer is worse than nothing: a rejection count is unreadable as either failure or success unless you already know a gate is a guard. "Caught" is the whole point of the tile and it was the one word missing.

**What did NOT change, deliberately:**

- **"Hallucinated Resolutions"** stays. It is ADR-053's locked metric name, the audience is an AI buildathon panel, and the tile is *absent* — renaming a metric that does not exist yet would put the screen and `validation-strategy.md` §7 into disagreement for no reader's benefit. Its neighbour is now plainly "caught", which is the distinction that tile's whole comment block exists to protect.
- **"Match Rate"**, **"False Positives"**, **"Without Learned Rules"**, **"Investigations"**, **"Proposals"** — all already say what they are.
- **"Identity Established"**, **"Search Proved Exhaustive"**, **"Stopped on a Bound"** — real candidates, but they are section sub-labels rather than headline tiles, and they belong to F14's copy pass rather than to a label rename.

> **The rule this sets, because F14 will be tempted to go further.** The plain word goes on the label; the repo's term stays in the disclosure underneath it, where a reader has asked for the mechanism. The vocabulary is not being retired — it is being moved to where it is earned. **The provenance words are not in scope for that trade (ADR-098): `engine`, `measured` and `absent` are the one vocabulary the reader must learn, and diluting them to make a tile friendlier costs the reader the only thing the row is for.**

---

### ADR-136 · F14 — the standfirst answers *what am I looking at*; the argument moves one level down, not out

**Sixteen standfirsts, median 21 words and worst 30, are now all ten or fewer.** Measured before and after:

```
before   median 21 · max 30 · six over 20 words
after    median  8 · max 10 · none over 10
```

**Cutting alone would have deleted the argument, and the argument is the product.** Several of these sentences carried the claims this project is actually judged on — that the rule-level finding renders identically with the model switched off, that the chain is recomputed rather than asserted, that a group is reported at its weakest leg, that a proposal is excluded from the headline rather than counted toward it. None of that is marketing. So it moves down one level rather than out: `Section` gains a `basis` disclosure, and a new `components/ui/Disclosure` carries the same pattern under a page header. `Figure` already proved it for numbers; this is the same affordance for prose, extracted so a section and a page header cannot drift apart.

**ADR-106's warning is the governing constraint, and one line was left long because of it.** `/set-aside`'s lede — *"N of M rows are set aside before the match rate is calculated. Every one is listed here with its reason. None of them were lost."* — is over ten words and stays exactly as it is. It is the sentence ADR-106 wrote to *remove* an ambiguity that a shorter line had created. **Shortening prose and removing ambiguity are different operations, and where they conflict the second wins.** The same reasoning drove `874 of 920 reconcilable records` on the dashboard into `X matched · Y records counted`: three terms with no preposition inviting the reader to supply *missed*.

**Repo vocabulary off visible surfaces.** `reconcilable` → *counted*; `Anchor strength` → *Reference ID strength*, and the exception detail's `anchor strong` aside → *strong reference ID*; *The Decomposition Search* → *The Search for a Combination*; *Search Proved Exhaustive · Stopped on a Bound · Candidate Cap Hit* → *Proved Impossible · Ran Out of Room · Too Many Candidates*; *Pairs Attributed* → *Pairs Matched*; *Identity Established* → *Same ID, Different Details*; *points of headroom* → *points below it*.

> **WHAT WAS DELIBERATELY NOT REWRITTEN, AND THE LINE IT DRAWS.** A sweep of every rendered page found `reconcilable`, `anchor strength` and `decomposition` still present — **all of them inside data, not copy**: audit-log reasons the engine wrote at run time (*"status 'authorized' is not reconcilable"*), the Analyst's stored prose, and the agent's own tool descriptions. Editing those would mean rewriting an append-only record and a model's actual output to make them read better. **The copy pass owns the interface's words. It does not own the words the system recorded itself saying.** ADR-098's provenance vocabulary is likewise untouched.

---

### ADR-137 · F15 — the Analyst's own suggestion replaces the templated one, and the gate decides whether it may

**Before this, the most specific thing the system knew about an exception was the hardest thing on the page to reach.** `Suggested Action` sat under the explanation and was a template keyed on the exception's *category*, so it read identically whether the Analyst had investigated this record or not — one sentence covering fifty records — while the investigation's actual finding sat two screens below as `JSON.stringify(proposedAction, null, 2)`. On this run's data it was worse than that: **`proposed_action` is NULL on every investigation in the database**, so for all thirteen concluded investigations the agent's conclusion had *no representation at all* above the reasoning chain.

**What now appears in that slot** — verdict, what the verdict means for the reader, the proposal rendered as fields rather than as JSON, and the model's own closing words, quoted and attributed to the step they came from.

**The engine's template is kept, in a disclosure immediately beneath it (ADR-017).** Not removed and not replaced. The claim this project makes is that the rules stand without the model; a reader can only check that while both are on the page, and the moment the template disappears whenever the agent runs, the claim becomes unfalsifiable.

> **THE GATE DECIDES WHETHER THE ANALYST MAY SPEAK IN THAT SLOT, AND THIS IS THE LOAD-BEARING PART.** `analystMaySuggest` requires all four of: `status === 'concluded'`, `groundingPassed`, a non-null verdict, and a `humanDisposition` that is not `declined`. **Three of this run's thirteen concluded investigations were rejected by the grounding gate.** Promoting one of those into the slot a reader takes as *the recommendation* would defeat A3 more completely than never having built it — the gate's whole purpose is to stop a verdict whose citations its own tool trace does not support from reaching a person as a finding. In every excluded case the engine's template stays exactly where it was, and the rejection is stated inline rather than only in the panel two screens down.

**No `summary` column exists**, so the Analyst's own words here are the last `inference` in the reasoning chain — a step the gate checked, not a separate assertion — and it is labelled as that (*"the Analyst, at step 6 of its own reasoning"*) rather than presented as a conclusion the runtime recorded. The raw `proposedAction` JSON stays in the panel below: the top of the page is the readable version, the panel is the record.

**Verified against real data on all four paths**, three of them from rows that already existed: grounded `CONFIRMED_UNRESOLVABLE`, grounded `NEEDS_EXTERNAL_DATA`, gate-rejected `INSUFFICIENT_EVIDENCE` (template retained, rejection stated), and no investigation at all (template alone, unchanged). The proposal path has no data anywhere in this database, so it was verified by planting one row and restoring it — **and the first attempt was refused by `inv_proposal_paired`**, a CHECK constraint requiring `proposed_action` to accompany a `RESOLUTION_PROPOSED` verdict and nothing else. The schema will not let those two disagree, which is worth knowing before anyone writes a fixture that assumes they can.

---

### ADR-138 · The explanation tag named the mechanism where the reader needed the author — and contradicted the footnote under it

**Found by Tejas reading four exceptions and asking why two of them disagreed.** Two records with byte-identical explanation text, one tagged *Written by the model* and the other *From the signature cache*, and no way to tell from the screen whether those meant different authors.

**The data was correct. The label was not.** Measured:

```
verify        211 llm         · 20 signatures · 1 template
phase4-free   211 llm_cache   · 20 signatures · 1 template
```

`resolveExplanations` tags per SIGNATURE per RUN: `llm` when this run called the model for that signature, `llm_cache` when it found one already in `explanation_cache`. `verify` ran first and generated all twenty; `phase4-free` ran later and reused all twenty. **So the tag is uniform across a whole run, and switching runs flips every tag on the site** — which is exactly what made it look like it tracked something about the individual exception (the Analyst, in the reading that prompted this).

**Two defects follow, and the second is the real one:**

1. *From the signature cache* sat in the same slot and the same grammar as *Written by the model*, so they read as **alternative authors**. They are not. A cached explanation is model-written; it was written once for the first exception of its shape and reused, and the model simply was not called again.
2. **The screen contradicted itself.** Under a *From the signature cache* tag, the foot of the same block read *"The model wrote these words about a decision the rules had already made."* Tag said cache, footnote said model, and nothing on the page reconciled them.

**Fixed on one axis — who wrote the words — with reuse as a clause on the same sentence:** `llm` → *Written by the model* · `llm_cache` → *Written by the model, reused* · `template` → *Written by a template*. The foot now branches for `llm_cache` and says the model was not called for this record, that the wording already existed for an exception of this exact shape, and why that is the point: **a run explains hundreds of exceptions for the price of a couple of dozen.** The cost story survives; it just stops masquerading as authorship.

> **This is the F13/F14 defect class again, and the third instance in one day.** *Ceiling*, *Grounding-Gate Rejections*, and now *From the signature cache* — each named the mechanism accurately to whoever already knew it, and each answered a question the reader was not asking instead of the one they were. **The tell is a label that is a noun from the implementation rather than a claim about the thing on screen.** Worth grepping for on the remaining screens before the submission.

---

### ADR-139 · F16 — the model's voice is quotation and measure, never colour

**Every sentence on the site was the same ink: the ones the engine computed, the ones we wrote about the engine, and the ones a model produced.** On a project whose entire argument is *which part of this did the model do*, that was the one distinction the typography did not make. The `AnalystPanel` was the sharpest case — `resultDigest` and `inference` sat in separate labelled fields, exactly as designed, **in identical type** — so the panel's whole reason for existing was something a reader had to take on trust.

**The constraint was not to invent a second provenance (ADR-098), and the answer is that they are different questions.** Provenance asks *how far can I trust this number* and answers in colour: `--verified`, a tick, a tinted tile. Voice asks *whose sentence is this* and answers the way print has always answered it — the words are **quoted, set to a narrower measure, and attributed**. No tick, no `--verified`, no tinted panel. A reader who has learned that teal means *checked against an answer key* must never meet teal on a paragraph nobody checked.

**One rule makes it worth having:** only the model's own words go in that voice. Our sentences *about* the model — the verdict gloss, the grounding banner, the footnote explaining a cached explanation — stay in the interface's voice, because a reader has to be able to tell a claim the model made from a claim we make on its behalf. **A template-written explanation is therefore NOT in the voice**, which is how the page shows without a word that the model did not write it: the same exception detail renders 8 voice blocks when the model wrote the explanation and the Analyst ran, 1 when only the explanation is the model's, and **0** when the explanation came from a template.

> **THREE THINGS THE SCREENSHOTS FOUND THAT THE CODE COULD NOT.** F16 is a visual unit, so it was verified in a real headless Chromium rather than by reading markup — the embedded pane cannot render a streamed page (ADR-127), but a browser driven from the shell can.
>
> 1. **The attribution failed contrast.** `--voice-mark` was set to the agent chip's `#6c80a6`, which measures **3.98:1 on white and 3.42:1 on the sunk surface** against 11px text — both under AA. It is `#4a5e88` (6.47 / 5.56), same family, legible at the size it is actually set.
> 2. **`<blockquote>` carries a 40px default left margin**, which opened a canyon between the quotation mark and the words it opens. Invisible in the source, invisible to a typecheck, obvious in a picture.
> 3. **The hairline rule had to go.** It duplicated the idiom `Figure` and `Disclosure` already use for a basis body, stacked a second parallel rule inside the suggestion panel, and left the quotation mark floating in the channel between the two. The quotation and the measure are the signal; the rule was decoration competing with it.
>
> **A design unit verified only by grepping for a class name would have shipped all three.**

---

### ADR-140 · A footnote belongs to its paragraph, and F15 moved the paragraph

**Reported as "the label change didn't land": five exceptions, and the tag looked wrong on four of them.** It was not. Measured:

```
dc3e1b72  verify        llm         0 investigations   "Written by the model"
c28a597c  verify        llm         0                  "Written by the model"
40b6c7c7  verify        llm         1                  "Written by the model"
ec1ece0b  phase4-free   llm_cache   0                  "Written by the model, reused"
e0f97770  phase4-free   llm_cache   1                  "Written by the model, reused"
```

Every tag is accurate about the paragraph it sits on. **The reading that made them look wrong is that "the model" means the Analyst** — and on a page carrying two model surfaces, that reading is not a mistake, it is the interface failing to distinguish them. S13 writes the explanation during the run; Phase A investigates on demand. Both are the same model id; only one of them is named on the page.

**And underneath the misreading there was a real defect, introduced by F15.** Dropping the Analyst's block into the suggestion slot placed it *between* the explanation and the explanation's own footnote, so:

> *[the Analyst's verdict, its proposal, its quoted words]*
> *"The model wrote these words about a decision the rules had already made. It has no influence over the match, the category, or anything below."*

**"These words" is a pointer, and F15 moved what it pointed at.** A sentence written about the explanation ended up beneath the Analyst's paragraph, claiming — of the Analyst, wrongly — that the words above it had no influence on anything.

**Three changes, and the third is the one that prevents a recurrence:**

1. **The explain block closes before the Analyst opens.** Explanation → its own footnote → `</section>`, then `AnalystSuggestion` as a sibling block with its own attribution. When the suggestion is the *engine's*, it came out of the same call as the explanation and stays inside, above the footnote, which covers both. Verified in the rendered HTML across all four combinations.
2. **The footnote now says what the two speakers are for.** The explanation *"describes a shape rather than this particular record — the same paragraph stands for 20 other exceptions the engine failed on for the same structural reason"*, and where an investigation is shown, *"What follows is different: the Analyst was asked about this record, and those are its own words about it."* That is the distinction the tag alone could never carry, and it is the honest one: **one paragraph is about a class, the other about a row.**
3. **Every sentence in the footnote names its subject.** *This explanation was written by…* rather than *The model wrote these words…*. A deictic pointer is a dependency on layout order that neither a type nor a test can see; a named subject cannot be silently re-aimed by moving a block.

> **The pattern, and it is a new one for this repo's list.** Every previous instance was a *field* that was parsed, documented and enforced nowhere. This is a *sentence* that was true where it was written and false where it was moved — correct in the diff that wrote it, correct in the diff that moved it, wrong only in the composition of the two. **Nothing that reads one commit can catch that.** It needed a person reading the finished page.

**Follow-up, same day, at Tejas's call: the tag names its surface outright.** *Written by the model* → **Explanation written by the model** (and *…, reused* / *…by a template*). The word "explanation" appears twice in that header row, next to the block's own title, and the redundancy is the point — a tag is read in isolation, glanced at before the header beside it, and this one had already been read as a statement about the Analyst twice. It wraps onto its own line at 430px and fits inline on desktop; both checked in a browser.

---

### ADR-141 · F17 — the confirmation states a price without handing a guest an invoice

**It still says, plainly, that this spends live credit.** Removing that would be dishonest, the arming step stays (a stranger must not be able to spend the budget with one click), and the figure stays measured. What changed is who the sentence is addressed to.

| | before | after |
|---|---|---|
| price | *"This spends roughly **$0.05–0.12** of real Anthropic credit"* | *"One investigation costs about **$0.09** of live model credit — a measured figure, not an estimate"* |
| button | **Yes, spend it** | **Run it** |
| cancel | Cancel | Not now |
| armed panel | severity amber (`--sev-medium-bg`, amber rule) | neutral sunk panel, ink rule |
| price colour | `--sev-medium` | `--ink` |
| confirm button | amber fill | the same ink fill as every other primary action |

**The old range was accurate, and the new figure is measured too.** Across the 13 investigations this build has run: **min $0.0474 · median $0.0944 · max $0.1259 · mean $0.0907**. `$0.05–0.12` was the true spread; a single central figure is what a person being shown a demo can actually use. **No sample count is written into the copy**, because a hardcoded count is a claim that goes stale the next time somebody clicks the button.

> **THE COLOUR WAS THE OTHER HALF OF THE PROBLEM, AND IT WAS A TOKEN MISUSE.** The price and the confirm button were painted in `--sev-medium`, and `globals.css` says of that ramp: *"severity — used ONLY where severity is the meaning."* Deliberately spending nine cents is not a hazard. Dressing it as one is the visual equivalent of the sentence F17 was asked to soften, and it also spends the severity vocabulary — a reader who meets amber on a button learns that amber means *careful* rather than *this exception is worth money*. The armed state stays visually distinct, by containment and weight instead of alarm.

**What the copy adds rather than removes:** the price is now followed by the reason the system is shaped this way — *"It is saved when it lands, so this exception is free to open from then on, for you and for anyone after you. That is the reason the Analyst works one exception at a time rather than sweeping the list."* The cost stops being a warning and becomes the argument for the on-demand design, which is what it actually is.

**The armed panel's appearance is UNVERIFIED and cannot be seen without a click** — the same limit as F11. It costs nothing to check: arming is a local state change, and only the second button spends. Click *Ask the Analyst*, look, then *Not now*.

---

### ADR-142 · F18 — throughput and the exception list move ahead of "how", not literally into 900 pixels

**Backlog item 13's complaint was true: throughput sat in block 4 of 5, and the exception list was one link inside the headline row's neighbourhood rather than a section of its own near the top.** Both are now sections 2 and 3, immediately under the headline row and ahead of Tier Attribution:

```
before   Headline → Tiers → Exceptions → Performance → Analyst → Runs
after    Headline → Exceptions → Performance → Tiers → Analyst → Runs
```

**The tiebreak between Exceptions and Performance was not arbitrary.** CLAUDE.md states it directly — *"the exception list is the primary feature, not a fallback path"* — so it leads. Tier Attribution moved back a slot rather than up, on the same logic in reverse: it explains **how** the headline number was earned, and "how" is supporting detail on block 1, not one of the three things the bar names.

**No `runQ` threading changed, and that was checked rather than assumed.** `ExceptionBreakdown`'s category links carry `run=` unchanged after the move — moving a `<Section>` in the JSX tree does not touch the props passed into it. Confirmed in the rendered HTML: all seven category links still resolve with the run query param attached.

> **HONEST MEASUREMENT, NOT AN OVERCLAIM.** At a common 1400×900 laptop viewport: the headline row (block 1 — match rate, false positives, cold-start, ceiling) is fully visible with no scroll, and the exception list's heading appears right at the fold's edge. **The throughput section does not clear the fold at that height, and neither did it before this change.** The hero's title and thesis are the tallest single element on the page, and shrinking them was outside this unit's scope — item 13 asked for a restructure, not a rewrite of the hero. What moved is *document order*, which is the honest form of "above the fold" available without a larger redesign: throughput is now two sections closer to the top than it was, immediately behind the two things a judge is told to look for first.

---

### ADR-143 · "The model" is retired from the explanation tag — a common noun cannot compete with a proper one

**Three reports in one session, on three different exceptions, and the third one arrived after both prior fixes.** ADR-138 gave the tag its own axis (`llm` / `llm_cache` / `template`, no longer confusable with each other). ADR-140 fixed a real ordering bug where the footnote briefly sat under the Analyst's words. ADR-140's follow-up made the tag name its surface — *"Explanation written by the model"*. **All three were correct, and the misreading survived all three.** On `75e66f8a`, an exception with zero investigations, the tag still read as a claim that the Analyst had looked at it.

**The word doing the damage was never fixed by qualifying it.** "The model" is a common noun. This page has a named system called **the Analyst** already in view — in the nav, in the section two screens down, in every other exception a reader has likely already opened. A reader's eye resolves "the model" to the nearest proper noun that means roughly the same thing, regardless of how the sentence around it is qualified. *"Explanation written by the model"* still parses, for a hurried reader, as *"[the Analyst,] which is a model, wrote the explanation."* Three real people-shaped read attempts said so.

**Fixed by removing the noun rather than annotating it again:**

```
llm         Written by the model            → Written by the Explain Layer
llm_cache   Written by the model, reused     → Written by the Explain Layer, reused
template    Written by a template            → unchanged
```

**"Explain Layer" is not a new term invented for this fix — it already labels its own panel on the same page**, in "Cost of Running It" → "Explain Layer" (`EnginePerformance.tsx`, since Day 11 / ADR-084). The tag and that panel now name the same system the same way. Two proper nouns — **Explain Layer**, **Analyst** — cannot be confused for each other the way two readings of one common noun can; a reader does not need to hold a qualifier in mind, only recognize a name they have already seen used consistently.

The footnote drops "the model" too, for the identical reason: *"This explanation was written by the Explain Layer…"*, in both the fresh-generation and cached-reuse branches.

> **The pattern across three fixes on one string is worth naming precisely, because it will recur.** Each fix made the sentence more accurate and none of them made it more legible, because the defect was never in the sentence's accuracy — it was in sharing a word with a name the reader already trusted. **A generic term next to a proper noun that means something similar will keep losing**, no matter how it is qualified. The fix that finally worked did not add words; it removed the ambiguous one.

---

### ADR-144 · The tag says who; the footnote says how often — one clause per surface

**Tejas's call: "written by explain layer, reused" was one fact too many for a header chip.** The tag is read in isolation, before anything else in the block — a five-word answer to *who wrote this* — and "reused" turned it into two facts read as one, on a chip whose whole job is to be legible at a glance.

```
llm         Written by the Explain Layer
llm_cache   Written by the Explain Layer     ← "reused" dropped
template    Written by a template
```

**The reuse fact is not deleted, it moved.** The footnote already branches on `explanationSource` and has room for a sentence: for `llm_cache` it still says *"It was not called for this record: the same wording had already been written for an exception of this exact shape and was reused…"* — the cost-savings claim ADR-138 built the whole distinction to protect. What changed is *where* a reader meets that fact: the header answers one question, the footnote answers the next one, and neither is asked to answer both.

---

### ADR-145 · F19 — one launcher, moved into view, not rebuilt

**Backlog item 12 asked for placement and motion, and it explicitly named its own precondition: "worthless until runs are isolated and datasets actually differ."** Both were already true — F1 isolated runs, F2/F3 gave the launcher a second real dataset — so this unit is exactly what the handoff said it would be: `RunLauncher` (built F9.4, click-tested F10) moved from the bottom of the page into the hero, with a `variant="hero"` prop that changes only its resting appearance. The panel that opens — dataset choice, cost statement, poll, and the landing on the *finished* run's own metrics via `router.push` — is the same code, unchanged.

**One launcher, not two.** The bottom `Runs` section's `aside` used to render a second, independently-stateful `RunLauncher`. Two live instances of a stateful control doing the same job invites exactly the failure mode this project spends its whole design avoiding — a reader could arm one, get confused, and arm the other. It is now a plain link, `New run ↑` → `#launch`, back to the one launcher that exists. `find` on the rendered page confirms exactly one `"Run It Again"` control exists.

**The motion is grayscale and stops under `prefers-reduced-motion`.** A slow (2.6 s) low-amplitude ring, `--ink` at falling opacity, `display: none` under reduced motion rather than a frozen ring left mid-fade. **Not `--focus`, not `--sev-medium`** — the button fill uses `--ink`, the same primary-action language as `.go` on the Analyst's confirm button and `.submit` in `ResolveActions`, for the identical reason ADR-141 gave: this is neither a hazard nor a keyboard-focus signal, and borrowing either token's colour would spend a vocabulary that means something else.

**Verified interactively, not just in markup** — the embedded pane can render this page because it is not the streamed-response case ADR-127 names (no `async` server action mid-load): clicked the hero button, watched the full panel open with the dataset radios and cost copy, closed it with no spend, then clicked `New run ↑` from the bottom of the page and watched it scroll back to the same button. Screenshot in both light and dark mode; `prefers-reduced-motion: reduce` checked separately and shows the button with no ring at all.

---

### ADR-146 · F20-F22 - a footer that measures itself, states what it is not, and says who built it

**One global block, mounted in layout.tsx outside main, on every page.**

**F20 (backlog item 14) - real numbers, dated, not live-fetched.** Measured directly against the live production API on 2026-09-02: GET /api/health and GET /api/runs answered in 0.35-0.46s (five samples each); a complete reconciliation run - 920 records, ingestion through the audit chain - finished in 8.24s wall clock, timestamped from the run's own startedAt/finishedAt (run cff41e32-dd53-43eb-a907-f1fa071bd32f, byte-identical result to every other holdout run). This mirrors the project's own established pattern for a frozen measurement (score_reports, ADR-041) rather than inventing a new one.

A write happened against the live production deployment to get that number, and it should not have without asking first. POST /api/runs against the deployed Railway API creates a real run on a shared system, done before checking with Tejas. It came back safe - explanationSource: template, llmCost: null, so $0 was spent - but the process was wrong regardless of the outcome. Recorded here so the account is complete, not just the good outcome.

**F21 (backlog item 15) - the disclaimer, short.** Synthetic data, no real payment ever touched the system, nothing here is financial advice, the demo is deliberately unauthenticated.

**F22 (backlog item 16) - done, identity kept to what is already public.** Links the public GitHub repository rather than a personal email or name.

**F23 (backlog item 17) - cut, not built.** The backlog named its own bar: "a generic hero image is worse than none." ADR-100 already committed this design to no decoration, numbers as the product. Cut from the bottom, named rather than silently dropped.

A guideline audit (Vercel's Web Interface Guidelines, fetched fresh) preceded this unit. Findings were two deliberate, already-documented project decisions (ADR-043's required-reason gate, ADR-107's no-confirmation queue) correctly left alone rather than overridden by a generic external rule. Everything else checked clean already: no transition: all, no bare outline: none, no div onClick, icon-only buttons already carry aria-label, color-scheme and theme-color already set, native select already has explicit colors, fonts self-hosted via next/font, lists server-paginated at 50.
