# ADR Log

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4

One file, short dated entries, newest section at the bottom. **Not** a folder of per-decision files — ARCHITECTURE §7 explicitly rejects that.

**Format:** `ADR-NNN · Title` → Decision / Because / Rejected / Revisit-if. Keep entries to a handful of lines. This exists to answer panel questions about tradeoffs, not to be a design document — the design lives in [schema.md](./schema.md).

**Rule:** if a later session changes something decided here, it appends a new ADR that supersedes the old one. Entries are never edited or deleted. Same discipline as `audit_log`.

---

## 2026-08-23 — Pre-lock decisions

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

## 2026-08-24 — Day 2 architecture decisions

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
**Revisit if:** hand-mapping row types becomes a real error source by Day 6.

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
**Because:** Railway gives a Node service and a managed Postgres in one project with one internal `DATABASE_URL` and no networking to configure; Vercel gives the frontend a URL in one push. Together that's a public demo URL on Day 3 rather than Day 12, which ARCHITECTURE §7.4 explicitly calls out as a strong signal. Consistent with ADR-005.
**Rejected:** Render (equivalent; Railway chosen for the tighter DB+service pairing — noted as the fallback), Fly.io (more control, more config), any self-managed VPS.
**Revisit if:** Railway's free-tier limits bite before Sept 5; fall back to Render with no architectural change.

### ADR-027 · Two dataset seeds: a dev seed and a held-out demo seed
**Decision:** Build and tune against `DEV_SEED`. Generate a fresh `HOLDOUT_SEED` dataset for the final reported numbers and the pitch video, and do not tune against it.
**Because:** Tuning tolerances against the same dataset used for reporting is overfitting, and the reported accuracy stops being a measurement. A held-out seed makes the final number an actual out-of-sample result, which is a direct and checkable answer to "one cherry-picked match proves nothing."
**Rejected:** A single seed.
**Revisit if:** never — this is the credibility of the headline number.

---

## Superseded

*(none yet — when an entry is superseded, move a one-line pointer here: "ADR-0NN superseded by ADR-0MM on <date>")*
