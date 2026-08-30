# CLAUDE.md

Orientation file for any Claude Code session working in this repo. **Read this first, every session.** You will have no memory of previous days.

---

## 1. What this is

A **payment reconciliation engine** built solo for the **Razorpay AI Buildathon, Track 4 (AI Finance Controller)**.
Locked: 2026-08-24 · **Submission: 2026-09-05.** 13-day build.

It ingests three deliberately messy synthetic financial sources, reconciles them through a tiered matching engine, classifies whatever it can't match into an exception taxonomy, explains those exceptions in plain English via an LLM, logs every decision immutably, and shows all of it on a dashboard.

**What the judges actually grade** (verbatim from the track page):

> "Throughput plus measured accuracy plus an honest exception list. One cherry-picked match proves nothing."

Three consequences that shape every decision in this repo:

1. **The exception list is the primary feature**, not a fallback path. Build it like the main thing, because it is.
2. **Accuracy must be *measured* against a ground-truth key**, not printed by the engine about itself. See [docs/validation-strategy.md](docs/validation-strategy.md).
3. **A panelist must be able to see the result without reading code.** The UI is not optional.

**Refusing to guess is a feature here.** If the engine is unsure, the correct behaviour is an exception with a stated reason — never a confident wrong match. Any change that raises match rate by guessing is a regression, however good the number looks.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, everywhere. Node 22. |
| API | Express 5 |
| Database | PostgreSQL 16 — **no Redis, no ORM.** Raw SQL via `pg`, numbered migration files. |
| Frontend | Next.js (App Router) + React |
| LLM | Anthropic API, `claude-sonnet-5`, explain layer only |
| Hosting | Vercel (web) + Railway (API + Postgres). **No Kubernetes, no containers we author.** |

Rationale for each is in [docs/adr-log.md](docs/adr-log.md). Don't re-litigate these — if you think one is wrong, append an ADR rather than quietly changing it.

---

## 3. Read these before changing anything

| Doc | What it owns |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **The scope lock.** In-scope / out-of-scope, model routing, concrete numbers, build plan, risks. Read §4 and §5 before proposing anything new. |
| [docs/schema.md](docs/schema.md) | **Data shapes.** Source schemas, normalized model, all table shapes, tolerance values, exception taxonomy + precedence, alias design, LLM prompt + caching, metrics. |
| [docs/matching-engine.md](docs/matching-engine.md) | **Execution.** Stage order (S0–S14), determinism guarantees, blocking, assignment, dedup, identity short-circuit, batch decomposition, group assembly. `schema.md` says *what the data looks like*; this says *what runs when*. |
| [docs/agent-design.md](docs/agent-design.md) | **The Analyst (Phase A).** The agentic layer downstream of S14: tool registry, investigation loop, grounding gate, self-correction, how the agent is measured. Read it before touching anything agent-related. |
| [docs/api-contract.md](docs/api-contract.md) | Every endpoint. Frontend and backend are built on different days — **this contract is binding.** |
| [docs/ui-spec.md](docs/ui-spec.md) | Screens, states, the demo path, and the pre-agreed degradation order if Day 12 overruns. |
| [docs/adr-log.md](docs/adr-log.md) | Every locked decision with reasoning. Append-only. 78 entries. |
| [docs/validation-strategy.md](docs/validation-strategy.md) | Ground-truth generation, precision/recall scoring, the scale benchmark, the honesty protocols. |
| [docs/testing-strategy.md](docs/testing-strategy.md) | What gets tested and what deliberately doesn't. |
| [docs/deployment.md](docs/deployment.md) | Hosting, env vars, secrets, deploy steps. |
| [docs/what-broke.md](docs/what-broke.md) | **Update daily.** Part of the submission. |

**If code and docs disagree, the docs are right until an ADR says otherwise.** Fix the doc first, add the ADR, then change code.

---

## 4. Repo structure

```
/
├── CLAUDE.md                  ← you are here
├── README.md                  ← public face; links the live demo
├── ARCHITECTURE.md            ← scope lock; the source of truth for in/out of scope
├── docs/
│   ├── schema.md
│   ├── matching-engine.md
│   ├── agent-design.md
│   ├── api-contract.md
│   ├── ui-spec.md
│   ├── adr-log.md
│   ├── validation-strategy.md
│   ├── testing-strategy.md
│   ├── deployment.md
│   └── what-broke.md
├── apps/
│   ├── api/                   ← Express + TS
│   │   ├── src/
│   │   │   ├── routes/        ← HTTP only: parse, validate, delegate, serialize
│   │   │   ├── services/      ← business logic
│   │   │   │   ├── ingestion/     parsers + normalizers, one file per source
│   │   │   │   ├── matching/      dedupe, blocking, tier1-exact, tier1_5-alias,
│   │   │   │   │                  identity-resolution, tier2-fuzzy, scoring,
│   │   │   │   │                  assignment, batch-decomposition, group-assembly
│   │   │   │   ├── classification/ exception rules, precedence, severity
│   │   │   │   ├── audit/         canonical JSON + the hash chain (ADR-042)
│   │   │   │   ├── explain/       LLM client, signature hashing, cache, templates
│   │   │   │   ├── agent/         Phase A: tool registry, investigation loop,
│   │   │   │   │                  grounding gate, Q&A loop  ← READ-ONLY TOOLS ONLY
│   │   │   │   └── metrics/       run metric computation
│   │   │   ├── repositories/  ← ALL SQL lives here. Nowhere else.
│   │   │   ├── db/            ← pool, migration runner
│   │   │   ├── types/         ← shared TS types (row types, DTOs)
│   │   │   └── config/        ← env parsing, tolerance defaults
│   │   ├── migrations/        ← NNN_description.sql, forward-only
│   │   └── tests/
│   └── web/                   ← Next.js
│       ├── app/               ← routes
│       ├── components/
│       ├── lib/api-client.ts  ← the ONLY place that fetches the API
│       └── types/
├── tools/
│   ├── generate/              ← synthetic data generator + answer key emitter
│   └── score/                 ← offline scorer: engine output vs. answer key
└── data/
    ├── fixtures/              ← generated source CSVs (committed)
    └── truth/                 ← answer keys. NEVER read by apps/api. See ADR-021.
```

### Structural rules that matter

1. **All SQL lives in `repositories/`.** No query strings in routes or services. Non-negotiable — it's what keeps the schema knowable.
2. **`data/truth/` is never imported by `apps/api`.** Ground truth leaking into the engine invalidates every accuracy claim in the project. Scoring happens in `tools/score/`, offline. (ADR-021)
3. **Routes are thin.** Parse, validate, call a service, serialize. If a route has business logic, move it.
4. **The LLM never decides anything.** It writes prose about decisions the rules already made. Anything that gives the model influence over match/no-match or category is a bug. (ADR-017)
5. **`audit_log` is append-only,** enforced by a DB trigger. Never write an `UPDATE` against it. (ADR-015)
6. **Money is `BIGINT` paise.** Never a float, never a `number` holding rupees. (ADR-006)
7. **Frontend fetches only through `lib/api-client.ts`.** One place for the base URL, error envelope, and casing.
8. **Nothing in the decision path reads the wall clock.** Date comparisons use `runs.reference_date` (ADR-039). `Date.now()` is for `occurred_at` and timing only. A run must be a pure function of its inputs.
9. **Every decision-feeding query has an explicit `ORDER BY`.** Determinism is the foundation of a measured accuracy claim; unspecified row order silently breaks it. (ADR-032)
10. **Ground-truth-derived numbers go to `score_reports`, never to `runs.metrics`.** One table is the engine's account of itself, the other is a measurement. (ADR-041)
11. **The agent's tool registry contains no mutating tool, ever.** Phase A proposes; humans dispose through endpoints 16/20/21. If you find yourself adding a write tool, the design has gone wrong. (ADR-049, ADR-051)
12. **The agent never does arithmetic.** It calls `score_pair` / `rerun_subset_search`, which run the engine's own locked code. A number in a reasoning chain that the engine didn't compute is a bug. (ADR-049)
13. **Nothing in Phase A may appear in S0–S14.** The engine must run identically with `AGENT_ENABLED=false`. (ADR-048)
14. **Anything that takes a database client takes `TxClient`, not `pg.PoolClient`.** `withTransaction` is its only producer. A transaction-scoped advisory lock taken on a client that is not inside a transaction is released by the statement that takes it, and protects nothing — silently. This repo has shipped that class of bug twice: the migration runner (session lock on a `Pool`) and the audit chain (transaction lock on a bare client). Read the ADVISORY LOCKS note at the top of `db/pool.ts` before adding a third lock. (ADR-066)

---

## 5. Naming conventions

| Thing | Convention | Example |
|---|---|---|
| DB tables | `snake_case`, plural | `learned_aliases`, `match_members` |
| DB columns | `snake_case`; money always `_paise`; timestamps `_at`; dates `_date` | `amount_paise`, `approved_at`, `txn_date` |
| TS variables / fields | `camelCase` | `amountPaise`, `matchRatePct` |
| TS types / interfaces | `PascalCase`, no `I` prefix | `NormalizedTransaction`, `ExceptionDetail` |
| Files (TS) | `kebab-case.ts` | `tier2-fuzzy-matcher.ts` |
| React components | `PascalCase.tsx` | `ExceptionTable.tsx` |
| API routes | `kebab-case`, plural nouns | `/api/runs/:runId/review-queue` |
| Wire JSON | `camelCase` | `{ "amountPaise": 123450 }` |
| Migrations | `NNN_snake_case.sql`, zero-padded | `003_add_learned_aliases.sql` |
| Enum-ish values in DB | `SCREAMING_SNAKE` for taxonomy, `lower_snake` for states | `AMOUNT_MISMATCH`, `pending_review` |
| Rule IDs | `SCREAMING_SNAKE` + `_V<n>` | `EXACT_PAYMENT_ID_V1` |
| Env vars | `SCREAMING_SNAKE` | `ANTHROPIC_API_KEY` |
| Git branches | `day<N>-<topic>` | `day4-matching-engine` |

**The `snake_case` ↔ `camelCase` boundary is the repository layer.** SQL in, camelCase objects out. Services and routes never see a `snake_case` key. One mapping point; no ambiguity about which convention applies where.

---

## 6. Domain vocabulary

Use these words precisely — they mean specific things here.

| Term | Meaning |
|---|---|
| **Source record** | One row from one of the three source files. Stored 1:1 in `transactions`. |
| **Economic event** | The real-world payment behind 1–3 source records. Exists in the answer key; the engine never sees it. |
| **Match** | A *group* of source records the engine believes are one economic event. Not a pair. (ADR-016) |
| **Tier 1 / 1.5 / 2** | exact / alias-resolved / fuzzy. Tier 1.5 substitutes learned aliases and re-runs the Tier 1 test. (ADR-012) |
| **Anchor** | A reference ID usable for identity. `strong` (payment_id, settlement_id, well-formed RRN) or `weak` (description-extracted, order_id alone). |
| **Exception** | An unmatched or problematic record, classified into one of 8 categories with one primary + secondary flags. |
| **Signature** | The structural shape of a discrepancy, with specifics stripped. The LLM cache key. (ADR-018) |
| **Cold run / warm run** | Without / with learned aliases. Both are always reported, always labelled. (ADR-020) |
| **Leverage ratio** | Records auto-resolved ÷ human corrections made. The alias feature's honest headline. |

---

## 7. Scope discipline

**In scope** and **explicitly out of scope** are listed in `ARCHITECTURE.md` §4 and §5. Read them. They are locked.

Out of scope, and staying out: fraud/risk scoring · cash-flow forecasting · multi-agent frameworks · auth / multi-tenancy / user accounts · mobile · fine-tuning · CQRS/hexagonal · live Razorpay APIs · over-designed UI · **Kubernetes and container orchestration** (ADR-005 — deliberately parked as a separate future learning project).

**If a task feels like it needs something on that list, stop and flag it rather than deciding alone.** The docs contain several items already flagged as scope creep with reasoning — follow that pattern.

---

## 8. Model routing (from ARCHITECTURE §3)

On Claude Pro, Sonnet and Opus share one quota pool, and Opus costs 1.7–5× more per turn. So:

- **Sonnet — the default.** Backend logic, matching engine, classifier, generator, API routes, migrations, LLM integration, tests, and the bulk of frontend implementation once a design direction exists.
- **Opus — planning and taste only.** Architecture passes (`/model opusplan`: Opus plans, Sonnet executes) and the frontend's initial creative pass.
- **Opus — nuclear button.** Hard debugging dead-ends, wrong matching results with no obvious cause, a structural decision clearly gone wrong.
- Clear/compact context between unrelated tasks. Don't leave Opus on after a planning pass ends.

---

## 9. Daily habits

0. **END EVERY DAY WITH A RE-SCORE, and write the number down.** Since Day 9 this is one command:

   ```
   npm run score -- --run <runId>
   ```

   Exit 0 = every honesty gate passed · 1 = transport/hash failure · **2 = a BUILD BLOCKER fired**. This is now the cheapest regression check in the project and it covers the whole system at once — a stage that stops being called, a group rule that starts laundering, a classifier that drifts, all show up as a number that moved. **Do not end a day on an unexplained movement.** Every prior defect of consequence in this repo was invisible to a green test suite and would have been visible to this.

   **Never change a parameter because the score went up** (ADR-027, ARCHITECTURE §8.1). Thresholds, windows, weights and tolerances are off-limits in response to a holdout measurement; structural fixes — wiring a stage that is not called, comparing keys that should be compared — are allowed because they are arguable without citing the number. Validate on `DEV_SEED`, report on `HOLDOUT_SEED`.

1. **Update `docs/what-broke.md` every single day.** It's a required submission artifact and it cannot be honestly reconstructed on Day 13. One line is fine; blank is not.
2. **Append to `docs/adr-log.md`** whenever you make a decision a future session might otherwise reverse.
3. **Never tune against `HOLDOUT_SEED`.** Develop against `DEV_SEED`. (ADR-027)
4. **Report cold and warm match rates together**, with the false-positive count next to them. (ADR-020)
5. **Run on the full batch, never a subset.** Cherry-picking is the specific thing the track disqualifies.

---

## 10. Current state

**As of 2026-08-29 (Day 9): AUDIT-2 is done and its P1 is fixed. A full holdout run takes 859 ms and produces 920 transactions, 284 matches (755 members), 256 exceptions and a 635-entry audit chain that verifies and is anchored. Pair-level recall against the answer key is 658/872 with ZERO false positives, and the engine's own match rate is 67.85% against a computed ceiling of 93.0%.**

> **Those numbers moved a long way on Day 9 and the movement is CORRECT — do not treat them as a regression.** AUDIT-2 found that Tier 2 excluded whole *records* matched at S6/S7 where `matching-engine.md` §6.3 excludes *pairs* (issue #40). Fixing it recovered 314 true pairs, turned 157 two-way groups into three-way ones, and removed 299 exceptions — 193 of which were fabricated `MISSING_IN_BANK` entries reporting `candidatesConsidered: 0` on records the engine was structurally forbidden from searching. `MATCH_CONFIRMED_EXACT` fell 203 → 46 for the same reason and is also correct: §10 rule 5 reports a group at its weakest tier, and 157 of Tier 1's groups now hold a fuzzy third leg.

**What is still missing is `tools/score` — so this remains a claim about code rather than a measurement. That changes with U8/U9.**

> **Day numbering.** The build is 13 *working* days, Aug 23 → Sep 5. **Aug 25 is not a numbered day** — no session happened, and numbering it inflated every subsequent day by one. Corrected on Day 4; the full table is ARCHITECTURE §8.

### History
- **Day 1 (Aug 23)** — pre-lock decisions, ADR-001…005.
- **Day 2 (Aug 24)** — six docs plus this file.
- *(Aug 25 — no session.)*
- **Day 3 (Aug 26)**, three passes in one day:
  1. Pre-build design review. `ARCHITECTURE.md` written (it had been cited 23 times by docs that existed before it did), plus `matching-engine.md`, `ui-spec.md`, `testing-strategy.md`. ADR-028…047. Three structural flaws fixed **before any code existed**: Tier 1's date window contradicted §5.2; `AMOUNT_MISMATCH` and `TIMING_DRIFT` were structurally unreachable; nothing at Tier 2 could ever auto-confirm.
  2. **The Analyst** (Phase A) — the agentic layer downstream of S14, closing a gap against the track's "build an agent" requirement without weakening ADR-017. ADR-048…057 plus `agent-design.md`.
  3. First code, in five reviewed units.
- **Day 4 (Aug 27)** — ten reviewed code units plus an independent audit pass.
- **Day 5 (Aug 28)** — the generator, in six reviewed units, plus the committed holdout dataset.
- **Day 6 (Aug 28)** — ingestion and the first two tiers, then AUDIT-1 and its two P1 fixes.
- **Day 7 (Aug 28)** — Tier 2 + group assembly, classification integration, the repository layer.
- **Day 8 (Aug 28)** — the run orchestrator and the 28 routes.
- **Day 9 (Aug 29)** — *today.* **AUDIT-2** (six issues, #40–#45) and its P1 fix; ADR-072 and ADR-073; **U8, U9 and U10 complete — the project has a measured number.**

### What exists in code

| Unit | Commit | What |
|---|---|---|
| 1 | `4ff6d07` | Scaffold: three independent packages (ADR-058), the type contract in `src/types/`, `pg` type-parser fixes (ADR-059), migration runner, ADR-021 leak guard |
| 2 | `c02005a` | Migrations 001–010: every table, the append-only + hash-chain audit log, single-match and un-reject triggers. Validated against **both** Postgres 16 and 17 |
| 3 | `00e280d` | `money.ts`, `dates.ts`, `normalize.ts` — Indian lakh grouping, string-decimal arithmetic (no floats), declared-never-inferred date formats, IST/UTC drift |
| 4 | `d6b83fe` | `tolerance.ts` + `scoring.ts` — banded tolerance, asymmetric windows, comparison basis (ADR-037), **the single Tier 2 scorer** and its guard test |
| 5 | `1ed0b26` | `assignment.ts` — global score-ordered assignment, the ambiguity guard (per target source) |

**113 tests passing.** API typechecks and builds; `apps/web` builds via `next build`.

### Working agreement for these units
One logical unit → show the diff → wait for explicit approval → commit that unit alone → next. **Do not merge these branches** — Tejas reviews and merges.

### Day 4 (2026-08-27) — complete. Ten code units, all reviewed and committed individually.

| Unit | Commit | What |
|---|---|---|
| 6 | `c986847` | S4 dedupe (anchor evidence required) + S8 identity short-circuit |
| 7 | `312806d` | S10 bounded batch decomposition + split settlements |
| 8 | `020d25d` | S12 classification: precedence, computed severity, evidence |
| — | 10 commits | **Independent audit pass** and its fixes (ADR-063…065) |
| 9 | `9710362` | Audit hash chain: canonical JSON, chaining, verification |
| 10 | `33a7b9d` | The Analyst's grounding gate (A3) |

**270 tests passing.** Typecheck and build clean. Branch `day4-dedupe-and-identity`, 22 commits, **unmerged — Tejas reviews and merges.**

Four locked ADRs were amended during implementation, each with a superseding entry rather than a quiet edit: **ADR-060** (deterministic node budget, not a wall clock — a time bound made exhaustiveness a property of the machine), **ADR-061** (deploy deferred until the project runs locally), **ADR-062** (`AMOUNT_MISMATCH` above the presence class — precedence is per record, but the categories describe legs), plus the build-day renumbering.

### Day 5 (2026-08-28) — complete. The generator, in six reviewed units.

| Unit | Commit | What |
|---|---|---|
| G1 | `2f5472b` | Deterministic substrate: seeded `sfc32`, scrambled per seed, named sub-streams (ADR-067) |
| G2 | `898eceb` | Economic event model + §3 scenario distribution, largest-remainder allocation |
| G3 | `4063523` | Projection contract + 13 invariants, **written before the projection they police** |
| G4 | `054bb64` | §4 unresolvability proofs + planting, running the ENGINE's own normalizer/tolerance/subset search |
| G5 | `8aef802` | Answer key + manifest (ADR-068: no timestamp, publishes the computed ceiling) |
| G6 | `ff5fffb` | Projection, CSV emission, orchestrator behind `npm run generate` |
| — | `c169e61` | **The holdout dataset and its answer key** — the first measurable artifact |

**202 tests at root, 308 in `apps/api`.** Typecheck and build clean in both. ADR-067…070.

**The dataset:** 300 events → 920 records (323 gateway / 301 bank / 296 ledger), 21 designed-unresolvable split 9/6/6, **ceiling 93.0% computed from realized data**, 881 expected pairs, 11 alias entries (all cold). Committed at `data/fixtures/holdout/` + `data/truth/holdout_seed_90210.json`. Dev datasets are gitignored — regenerate with `npm run generate -- dev`.

**Read `docs/what-broke.md`'s Day 5 entry before delegating anything.** It records the `captured_at` bug that three layers of verification walked past, the fourth instance of a test that could not fail, and a precise account of why the G6 delegation cost far more than the work was worth.

### Day 6 (2026-08-28) — complete. Ingestion and the first two tiers, then an isolated audit.

| Unit | Commit | What |
|---|---|---|
| U1 | `8b5453a` | Ingestion S1–S3: three parsers, exclusion, rejected-row capture, `ingestSources` |
| U2 | `4287887` | Blocking S5 (four indexes) + Tier 1 S6 + Tier 1.5 S7 re-running S6's predicate |
| — | AUDIT-1 | **Isolated Opus audit, audit-only.** Eight issues filed (#30–#37), two P1 |
| P1 | `146eeda` | **Fix #30** — direction gate scoped to sources that state a direction (ADR-071) |
| P1 | `eb5995d` | **Fix #31** — bank `counterparty_norm` no longer keeps RRN / `setl_` tokens |

**339 tests in `apps/api`, 202 at root.** Typecheck and build clean.

**Where the engine stands against the holdout:** Tier 1 produces **203 matches, all gateway↔ledger on `EXACT_GATEWAY_REF_V1`, with ZERO false positives** against the answer key. Every `source_row_number` joins the key exactly; zero rejected rows. Tier 1.5 cold-runs to 0 alias matches by design.

**Two structural facts to carry forward, both settled by AUDIT-1:**
- **Tier 1 only ever produces gateway↔ledger matches.** Bank rows carry no *structured* strong anchor (their rrn/settlement_id live in the free-text description = weak, §3.1), so `sharedStrongAnchor` is always null for gateway↔bank. **All gateway↔bank correlation is U3's job at Tier 2**, where a gateway structured anchor matching a bank description-extracted token scores `strong_weak`. This is faithful to §4.1, not a gap.
- **`direction_conflict` (S8) has no consumer.** Post-ADR-071 it is reachable only on a gateway↔bank pair carrying a shared structured strong anchor, which real bank rows never have. Left as defensive code; wiring or removing it is an open question, not a bug.

**Six issues remain open below P1** (#32–#37). **#34 blocks U9 and must be decided before Day 9** — the `viaTier` reconciliation rule is a judgment call about how the headline number is computed, and `tools/score` is still `export {}`. **#33 (a recall test that hides misses) and #32 (`anchor_strength` ignores `invoice_no`) should land before Day 9** too.

**Read `docs/what-broke.md`'s Day 6 entry before starting Day 7.** It records both P1s, why 338 passing tests caught neither, and the fifth instance of the "test whose name claims more than its assertion" pattern.

### Day 7 (2026-08-28) — complete. Tier 2, groups, classification integration, repositories.

| Unit | Commit | What |
|---|---|---|
| U3 | `f2a1245` | S9 Tier 2 driver (candidate generation → `scorePair` → `assign`) + S11 group assembly, all five §10 rules |
| U4 | `addd0c0` | S12 integration: `collect.ts` builds `ClassificationInput` from stage output |
| U5 | `89aedc5` | The repository layer — eight tables — **plus migration 012** |

**441 tests in `apps/api` (386 unit + 55 integration), 202 at root.** Typecheck clean; migrations run from an empty database.

**Where the engine stands against the holdout, S1 → S12:**

```
S9   6,388 pairs scored · 111 accepted (71 auto / 40 pending) · 0 cap hits · 90ms
     ZERO false positives · median 24 candidates/record
S11  284 groups (203 exact, 81 fuzzy) · 254 two-way, 30 three-way
     no record in two groups · exactly one anchor each
S12  555 exceptions · one primary per record · 328 carry candidate evidence
     MISSING_IN_GATEWAY 242 · MISSING_IN_BANK 203 · MISSING_IN_LEDGER 63
     AMBIGUOUS_MATCH 20 · AMOUNT_MISMATCH 18 · DUPLICATE_RECORD 9
```

**Those counts will move twice, and the tests say so.** S10 is not wired yet (batch decomposition is U6's job), so 12 `UNSPLITTABLE_BATCH` legs currently land in presence categories; and **#38** will recover ~24 gateway↔bank pairs. Both are expected movement, pinned exactly rather than floored, so any OTHER movement fails a test.

**Three facts to carry into Day 8:**
- **`matchedPairs` for S12 derives from S11's GROUPS, never from the tier outputs.** S11 can refuse a pair a tier proposed; reading the tiers would reinstate exactly what it declined.
- **Migration 012 exists** because `ux_alias_active` + `alias_superseded_has_target` + the `superseded_by` FK formed a cycle that made §6.3's alias policy impossible to execute in any statement order. Only the FK is deferred.
- **`candidatesConsidered` ≠ `candidates.length`** by design (§11): the first is everything scored, the second is the ≥0.40 logged subset.

**#38 is a P1, still open** — a bank `bank_ref_no` equal to a gateway `rrn` scores zero anchor. Filed at "~24 true pairs"; re-measured on Day 9 after #40 the residual is **17**. Filed with evidence and acceptance criteria; deliberately not fixed inside U3.

**Read `docs/what-broke.md`'s Day 7 entry before starting Day 8.** It names the pattern that now dominates: three modules, each correct against its spec, each wrong the first time something actually called it. A spec cannot be executed by reading it.

### Day 8 (2026-08-28) — complete. AUDIT-2 followed on Day 9.

| Unit | Commit | What |
|---|---|---|
| U6 | `3af578f` | Run orchestrator S0–S14. **First end-to-end persisted run.** |
| U7 | `d836a58` | All 28 endpoints of `api-contract.md`, exercised over real HTTP |

**477 tests in `apps/api` (386 unit + 91 integration), 202 at root.** Typecheck and build clean.

**A full holdout run, persisted:**

```
920 transactions · 284 matches (598 members) · 555 exceptions
930 audit entries · chain valid AND anchored · 983 ms
[SUPERSEDED on Day 9 by the #40 fix — see the Day 9 block below]
reference date 2026-08-21 · no record in two matches
reconcilable 874 = 920 ingested − 37 excluded − 0 rejected − 9 duplicates
```

**Three things deliberately unwired, named rather than hidden** (`UNWIRED_STAGES` in `services/run/orchestrator.ts`):
- **S10 batch decomposition** — built and tested, but wiring needs a decision U6 should not make alone: which unmatched bank credits enter the pool, and how a decomposition's members interact with S11's role-collision rule. Until then `UNSPLITTABLE_BATCH` is never raised and those 12 legs sit in the presence categories.
- **S13 explain** (U11) and **S14 metrics** (U8) — status transitions and call sites exist; neither fabricates a value. `runs.metrics` stays `{}`, and endpoint 4's `headline` is `null` rather than zeroed.
- **`POST /api/runs` variant A** (multipart upload) returns `400 MISSING_REQUIRED_FILE`. Variant B (seeded dataset) is the demo path.

**⚠️ A COMMIT-MESSAGE RULE, learned the expensive way.** Commit `f2a1245` said *"filed not fixed: #38"*. GitHub parses `fix(e[sd])?\s*:?\s*#\d+` and does not read the sentence, so it **auto-closed a live P1** on merge. Never write `fix`/`fixed`/`closes`/`resolves` near an issue number unless the commit does it — use `see #38`, `per #38`, `tracked in #38`. Grep before merging:

```
git log --format=%B main..HEAD | grep -inE "(close[sd]?|fixe[sd]|fix|resolve[sd]?)[ :]*#[0-9]+"
```

**Read `docs/what-broke.md`'s Day 8 entry before starting Day 9.** It records that incident in full — the first failure in this project that was a defect in *prose* acted on by a machine, invisible to every test.

### Day 9 (2026-08-29) — AUDIT-2, its P1, and the rule U9 was blocked on.

**AUDIT-2** (isolated, Opus/max, audit-only) filed six issues: **[#40](https://github.com/flare19/payment-reconciliation-agent-platform/issues/40) P1**, #41–#44 P2, #45 P3. It also verified — and this is a result, not silence — that `candidateDateRange` inverts the §5.2 windows correctly in both directions, the ADR-033 cap does not bind, `matchedPairs` derives from S11's groups, `candidatesConsidered` is a true count, every paginated repository query ends in a unique tiebreak, migration 012 weakened neither constraint, and no unwired stage fabricates a value.

| Unit | Commit | What |
|---|---|---|
| P1 | `94c3e85` | **#40** — Tier 2 excludes settled PAIRS, not matched RECORDS |
| — | `67d55bf` | **ADR-072** — the `viaTier` reconciliation rule (#34), plus doc refresh |
| **U8** | `cffd386` | **S14 metrics.** The first persisted headline: **67.85%**, with every denominator term beside it |
| **U9** | (this commit) | **`tools/score`.** The scorer, plus ADR-073 — `sourceRowNumber` on every record preview |
| **U10** | (this commit) | **The first MEASURED number.** Posted to `score_reports`; endpoint 5 serves `engine` + `measured` together |

**The #40 fix, measured against the answer key:**

```
                       before      after
pair recall            344/872     658/872    +314 true pairs
false positives          0           0        precision unchanged
three-way groups        30         187
groups                 284         284        same events, assembled fully
match members          598         755
exceptions             555         256   (MISSING_IN_BANK 203 -> 54)
match rate (ADR-040) 57.09%      67.85%       ceiling 93.0%
runtime               983 ms      859 ms
```

`runTier2`'s third parameter is now `readonly { aId, bId }[]` rather than `ReadonlySet<string>`, **so a caller holding record ids cannot typecheck.** The signature is the guard.

**479 tests in `apps/api`, 202 at root.** Typecheck and both builds clean.

**ADR-072 settles #34, which CLAUDE.md had flagged as blocking U9.** `viaTier` is never a term in precision/recall — correctness is pair membership alone. Three cases, none a recall miss: tier fall-through; a pair whose *event*-level `expectedOutcome` is `EXCEPTION` (scored against the classification key, not the pairing key); and pair-tier vs group-tier, which the #40 fix turned from an edge case into the majority — **413 of 658 matched pairs (63%) have a `viaTier` that disagrees with their group's tier**, all of them matched correctly. See `validation-strategy.md` §5.1.2.

> **ADR-072 placed one requirement on U8:** `runs.metrics` must record how many **PAIRS** each tier produced. **Done** — `tierAttribution` reads `exact 203 · fuzzy 268 · implied 187 · unattributed 0`, summing to 658, exactly the pair count of the 284 groups. The group-tier figure it deliberately is NOT would read `exact: 46`.

**U8 (S14 metrics) is complete.** `runs.metrics` is populated, `GET /api/runs/:runId` serves a headline, endpoint 5 returns `engine` alongside `measured: null`. **498 tests in `apps/api`, 202 at root.**

```
matchRatePct 67.85 · matched 593 / reconcilable 874
tierAttribution  exact 203 · fuzzy 268 · implied 187 · identityEstablished 9
reviewBurden     58 groups · 162 records, excluded from the rate (ADR-040)
stagesNotRun     S10_BATCH · S13_EXPLAIN   (null, never 0)
throughput       3,898 rec/s engine · 1,093 rec/s wall clock
```

**Two things U8 caught, both in `what-broke.md`:** `serialize.ts` read the metrics block as `review` where §11.1 names it `reviewBurden`, so `headline.pendingReviewCount` had been permanently `null` — §11.5 rule 3 broken silently. And the first `tierAttribution` draft reported `identityEstablished: 212`, the same overstatement Day 8 removed from the audit log; the real figure is **9**.

**`llmCost` and `batchSearch*` are `null`, not zero.** `stagesNotRun` names why. A stage that did not run must not report a performance figure.

### THE FIRST MEASURED NUMBER (U10) — reported unedited, per ADR-020

> **The headline understates what the engine FOUND, and the honest reframing is already specified.**
> Of 716 scorable true pairs the engine auto-confirms **442**. A further **141 it found and correctly
> declined to auto-confirm** — they sit in the review queue at **0.94 precision**. Counted as "did the
> engine locate this relationship at all", that is **583 / 716 = 81.4%**; only **133 pairs (18.6%) were
> never found**. ADR-040 is right to keep proposals out of the headline and §5.1.1's review-queue
> precision is exactly the figure that makes the distinction legible. **Both ship, both labelled.**
> A further **53** of the misses are S10 being unwired — **7.4 recall points behind a wiring change.**


```
pairs      precision 1.0000 · recall 0.6173 · F1 0.7634
           TP 442 · FP 0 · FN 274
           review queue: 150 pending pairs at 0.94 precision
           165 pairs excluded from both sides (their EVENT is an exception, ADR-072)
classify   macro P 0.7222 · macro R 0.7309 · secondary-flag Jaccard 0.80
           AMBIGUOUS 1.00/0.67 · AMOUNT_MISMATCH 1.00/0.58 · DUPLICATE 1.00/1.00
           MISSING_IN_BANK 0.78/0.93 · MISSING_IN_LEDGER 0.78/0.93
           MISSING_IN_GATEWAY 0.50/1.00 · UNSPLITTABLE_BATCH 0.00/0.00  (S10 unwired)
honesty    unresolvable recall 1.0 over 21 · false-despair 58/74 = 0.78
difficulty EASY 0.71 · MEDIUM 0.67 · HARD 0.20
engine     match rate 67.85% against a computed ceiling of 93%
```

**Read `precision 1.0000` and `FP 0` first.** The engine claims 442 pairs and every one is in the key. Recall 0.617 is the honest weakness and HARD 0.20 says where it lives. `UNSPLITTABLE_BATCH` at 0.00 is S10 being unwired, not a classifier defect — wiring it is the single largest identified gain.

**The scorer was WRONG TWICE on its first run, both times against the engine.** It printed two build blockers — "invented a match on 5 unresolvable events" and "3 TIMING_DRIFT auto-confirmed" — and both were scorer defects, not engine defects. §4's sub-classes are unresolvable in ONE LEG (the key marks all five events' pairs `shouldMatch: true`), and §5.2's TIMING_DRIFT cell means the primary `expectedCategory`, not a secondary flag. **Every gate now has a test asserting it still FIRES on genuinely wrong output** — a check corrected until a blocker stops firing is otherwise indistinguishable from tuning.

**ADR-073 was needed before U9 could run at all.** §5's documented join is on `(sourceSystem, sourceRowNumber)`, and `RecordPreview` did not carry `sourceRowNumber` — so two locked documents specified a measurement the contract between them could not express. Additive fix; no field changed meaning.

**To reproduce:**

```
npm run score -- --run <runId> [--post] [--out report.json]
```

Exit 0 = every honesty gate passed · 1 = transport/hash failure · 2 = a BUILD BLOCKER fired.

**Read `docs/what-broke.md`'s Day 9 entry before starting U8.** It records why #40 was invisible to 477 passing tests: both facts the bug needed were already written down in this repo, days apart, by the same author — §6.3's "pairs" and AUDIT-1's "Tier 1 only ever produces gateway↔ledger". The defect lived in their *conjunction*, which no document owns and no test covered.

---

## THE EXECUTION PLAN — Days 6 to 13

**Read this before starting anything. The order is dependency-driven, not preference.**
Each unit is one commit, reviewed before the next starts (the working agreement since Day 3).
`AUDIT-n` are **isolated sessions** — fresh context, audit-only, file findings as GitHub issues, fix nothing in the same session.

### Model routing for this phase (ARCHITECTURE §3, plus the Day 5 corollary)

| Profile | When |
|---|---|
| **Sonnet / medium** | Mechanical against a complete spec, with existing tests or guards to check against |
| **Sonnet / high** | Mechanical, but carrying one invariant that fails SILENTLY if got wrong |
| **Opus / high** | Judgment, spec ambiguity, or anything whose error corrupts a measured number |
| **Opus / max** | Audits only. An audit must catch what the builder missed, which is the builder's blind spot by definition |

> **The Day 5 corollary: the cheap model is only cheap if the session stays short.** Cost is turns × context. Every delegation prompt must carry: read by grep and section, never whole files; write and typecheck ONE module at a time; commit each module as it passes; no exploratory sweeps beyond the unit's stated acceptance criteria.

### Day 6 (Aug 28) — ingestion and the first tiers — **COMPLETE**

| # | Unit | Model | Outcome |
|---|---|---|---|
| **U1** | Ingestion parsers S1–S3 | Sonnet / high | ✅ `8b5453a`. Every `source_row_number` joins the answer key; zero rejected rows on the holdout. |
| **U2** | Blocking S5 + Tier 1 S6 + Tier 1.5 S7 | Sonnet / high | ✅ `4287887`. Tier 1.5 re-runs S6's predicate live; the guard held. |
| **AUDIT-1** | Isolated audit of U1+U2 | Opus / max | ✅ Eight issues (#30–#37). **Two P1s, both silent, both fixed** (`146eeda`, `eb5995d`). Five of the six author-flagged judgment calls were correct; both P1s were in what the author had not thought to question. |

### Day 7 (Aug 28) — the rest of the matching core, plus persistence — **COMPLETE**

| # | Unit | Model | Outcome |
|---|---|---|---|
| **U3** | Tier 2 driver S9 + group assembly S11 | Opus / high | ✅ `f2a1245`. Zero false positives; #38 filed for a scorer gap it exposed. |
| **U4** | Classification integration S12 | Opus / high | ✅ `addd0c0`. Found `candidatesConsidered` reporting a filtered length, and §10 rule 3 inert. |
| **U5** | Repositories — 8 stubs | Opus / high | ✅ `89aedc5`. Found a constraint cycle that made §6.3 unexecutable; migration 012. |

### Day 8 (Aug 31) — wiring. **First end-to-end run.**

| # | Unit | Model | Why |
|---|---|---|---|
| **U6** | Run orchestrator S0–S14 | Opus / high | ✅ `3af578f`. Phase-per-transaction (the poll target needs committed status); audit records decisions, not transcription. |
| **U7** | Routes — 28 endpoints | Opus / high | ✅ `d836a58`. All 28 over real HTTP; 24 integration tests green first run. |
| **AUDIT-2** | Isolated audit of U3–U7 | **Opus / max** | ✅ Ran Day 9. Six issues (#40–#45); the P1 (#40) is fixed in `94c3e85`. It was the last checkpoint before a number exists, and it earned its place: the engine was understating its own match rate by 10.76 points. |

### Day 9 (Aug 29) — **the first honest number** — COMPLETE

| # | Unit | Model | Why |
|---|---|---|---|
| **U8** ✅ | `metrics/run-metrics.ts` S14 | **Opus / high** | ADR-040's denominator is prose; three defensible readings give three different headline match rates. The worked examples were corrected on Day 5 — implement from ADR-040 itself, not from an example. **Must also record per-TIER PAIR counts (ADR-072)**, or U9's tier-attribution diagnostic is not computable. |
| **U9** ✅ | `tools/score` | **Opus / high** | The purest case: no test can catch a scorer that is wrong in the direction you hoped. §5.1.1's `pending_review` handling and the group→pair mapping are both judgment. **The `viaTier` rule is no longer a judgment call — ADR-072 and §5.1.2 settle it. Read both before joining anything on tier.** |
| **U10** ✅ | **First scored cold run** against `data/truth/holdout_seed_90210.json` | **Opus / high** | Report cold AND warm with the false-positive count beside them (ADR-020). Whatever the number is, it goes in `what-broke.md` unedited. |

> **THE PLAN GAINED THREE DAYS. Read §8 of ARCHITECTURE.md for the re-dated table.**
> Day 9 landed on **Aug 29** against a plan that put it on Sep 1. The slack is spent, not absorbed:
> **deploy moves to Day 10** (largest un-de-risked item; ADR-061's precondition has been met since Day 8),
> **the frontend grows to two days**, and **AUDIT-4 stops sharing a day with the submission**.

### Day 10 (Aug 30) — deploy as an unknowns-flush, and the last unwired matching stage

> **Deploy is NOT a checkbox and Day 10 is not a freeze (ADR-074).** Its purpose is to convert
> every unknown that only appears in a real environment into a known one **while there is still
> time to absorb it** — managed-Postgres connection limits and SSL, `CORS_ORIGIN`, migrate-on-boot
> against a non-empty database, cold-start latency on endpoint 4, and whether a run completes
> inside the platform's limits. **Four P1s are open on the day it deploys and all of them land
> afterwards.** So the setup is judged on how cheap it is to REDO, not on being finished:
> redeployment stays a single manual action, and **there is no CI/CD** — one person, one branch,
> two `npm test` commands and a review gate that already exists (ADR-074, ADR-005).

| # | Unit | Model | Why |
|---|---|---|---|
| **U14** | Deploy API to Railway (ADR-061, ADR-074) | **Opus / high** | Moved up a day. Nothing has ever run outside a laptop. `deployment.md` §5. Acceptance is *"a second deploy is one command"*, not *"it is live"*. |
| **R1** ✅ | Wire S10 — **#46**, **#45**, **#49** | **Opus / high** | **Done.** Pair recall **658 → 694**, `UNSPLITTABLE_BATCH` **0.000/0.000 → 1.000/0.500**, 7 `one_to_many` groups, cross-source invented pairs still **0**. Match rate 67.85% → **66.48%** and that is CORRECT — split legs are `pending_review` (ADR-038), and §10 rule 4 makes a group holding a proposal a proposal. ADR-076/077/078. |
| — | Re-score, record the number | — | `npm run score -- --run <id>`. Every day from here ends with a re-score (habit 0). |

### The four open P1s, and when each lands

| # | What | Cost, measured | When |
|---|---|---|---|
| ~~#45~~ ✅ | Rule 3's cardinality exception, plus the cluster-merge pair loss it made reachable | ADR-077 | Day 10 |
| ~~#49~~ ✅ | S10's pool is now role-scoped | ADR-077 | Day 10 |
| ~~#46~~ ✅ | S10 wired and producing | pair recall **658 → 694**, `UNSPLITTABLE_BATCH` **0.000 → 1.000/0.500**, 7 `one_to_many` groups | Day 10 |
| **[#38](https://github.com/flare19/payment-reconciliation-agent-platform/issues/38)** | `anchorAgreement` compares weak keys like-for-like | 17 pairs — and **11 of them are in the never-found set**, the entire actionable remainder once #46 is wired | **Day 11** |
| **[#43](https://github.com/flare19/payment-reconciliation-agent-platform/issues/43)** | `countsTowardEngineMatchRate` admits `pending_review` | Browse list implies 86.4% where the headline says 67.85% | **before the frontend reads it** |

> **[#47](https://github.com/flare19/payment-reconciliation-agent-platform/issues/47) IS CLOSED AS NOT-A-DEFECT — do not re-open it from the arithmetic alone (ADR-075).**
> It was filed as the P1 that "cannot ship", and it was wrong. The sum is real — an anchorless
> bank↔ledger pair caps at `0.35` against a `0.65` floor — but ADR-064 decided this **deliberately on
> Day 4**, with the same arithmetic, and set a revisit condition that the first measurement does not
> meet: **all 83,979 scorable bank↔ledger pairs on the holdout score `anchor 0.00`**, so the caps are
> theoretical and **renormalising recovers 0 pairs**. The 66 unreached pairs share no reference value
> across any key — bank has `bank_ref_no`/`utr`, ledger has `entry_id`/`invoice_no` — so #38 is not
> their cause either. Refusing them is the honesty property working. What DID come out of it is
> [#48](https://github.com/flare19/payment-reconciliation-agent-platform/issues/48): §5.4 promises such
> a pair "can reach the review band and ask a human", and for bank↔ledger that is false.

### Day 11 (Aug 31) — explain layer

| # | Unit | Model | Why |
|---|---|---|---|
| **U11** | Explain layer S13: signature, cache, LLM client, templates | **Sonnet / medium** | `schema.md` §10 is the most complete spec in the repo. Run must complete with the API unavailable (`explanation_source = 'template'`). Fills the last unwired stage, so `llmCost` and `stagesNotRun` stop being null. |

### Day 12 (Sep 1) — the Analyst

| # | Unit | Model | Why |
|---|---|---|---|
| **U12** | Agent tool registry | **Opus / high** | `score_pair`/`rerun_subset_search` must call locked engine code (ADR-049) — the first `services/agent` → `services/matching` import, which is legal and required. `agent-design.md` §4 still says "meet-in-the-middle"; ADR-060 replaced that with depth-first. Fix the doc. |
| **U13** | Investigation loop A2 + triage A1 | **Opus / high** (loop), **Sonnet / medium** (triage) | The loop decides whether the grounding gate's per-investigation property holds; #21's `investigationId` plumbing is already in place and must be honoured. Triage's `ORDER BY` is stated exactly. |
| **AUDIT-3** | Isolated audit of U11–U13 | **Opus / max** | Hallucination is a build blocker (ADR-053), not a metric |

### Day 13 (Sep 2) — AUDIT-3, scale, and the P2 sweep

| # | Unit | Model | Why |
|---|---|---|---|
| **AUDIT-3** | Isolated audit of U11–U13 | **Opus / max** | Hallucination is a build blocker (ADR-053), not a metric |
| **U16** | Scale benchmark 1k/10k/100k (ADR-045) | **Sonnet / medium** | Throughput is a judged axis and the curve is the evidence for ADR-033's O(n×k) claim. Generator is already parameterized. |
| — | **#38** (P1, 17 pairs) and **#43** | **Sonnet / high** | #43 must land before the frontend reads `countsTowardEngineMatchRate` |
| **U15** | Q&A loop | **Sonnet / medium** | Same loop, smaller budget, one tool removed. **First cut candidate if the day overruns.** |

### Day 14 (Sep 3) — frontend

| # | Unit | Model | Why |
|---|---|---|---|
| **U17** | Design direction + dashboard | **Opus / high** | CLAUDE.md §8's own routing rule: Opus for the creative pass |

### Day 15 (Sep 4) — the rest of the frontend, and the web deploy

| # | Unit | Model | Why |
|---|---|---|---|
| **U18** | Remaining screens | **Sonnet / medium** | `ui-spec.md` §1–9 + the endpoint-to-screen map. §8's degradation order is pre-agreed — cut from the bottom and SAY what was cut. |
| **U19** | Deploy web to Vercel | **Sonnet / medium** | |

### Day 16 (Sep 5) — submission

| # | Unit | Model |
|---|---|---|
| **AUDIT-4** | Final pre-submission audit, whole repo | **Opus / max** |
| **U20** | Holdout run, accuracy report, README, pitch video, build-challenges write-up | **Opus / high** |

### Open issues — status going into U8

**P1, still open:** **#38** — `anchorAgreement` compares weak anchor keys like-for-like, so a bank `bank_ref_no` equal to a gateway `rrn` scores zero anchor. Re-measured after #40: the residual is **17 pairs**, 11 of them scoring a literal zero anchor (down from the "~24" it was filed at, because #40 recovered most of the same pairs by a different route). Comment on the issue carries the measurement.

**Should land before the number is published:** **#43** (`countsTowardEngineMatchRate` admits `pending_review`, which ADR-040 excludes — the browse list implies 86.4% where the headline says 67.85%); **#41** (fee band inverted for bank→gateway; costs nothing today, scales with amount); **#32** and **#33** (both flagged for Day 9 since Day 6).

**Not scheduled:** #9–#15, #20, #22–#29, #35–#37, #42, #44, #45. Sweep at AUDIT-3.

### Carried debt, stated rather than buried
- **Nothing is deployed, deliberately** (ADR-061). Day 11 (API), Day 12 (web). A dated task, not a spare-time task.
- ~~`tools/score` is still a stub~~ — **done Day 9. The project has a measured number: precision 1.0000, recall 0.6173, zero false positives, against a 93% ceiling.**
- ~~Nothing is PERSISTED end to end~~ — done Day 8. Original note:
- **(historical)** Every stage S1–S12 exists and they run in sequence against the holdout in-memory (see the Day 7 block), but no orchestrator writes any of it to the database, no routes are mounted, and `createApp` serves 404s by design. That is U6 and U7.
- The repository layer is complete (U5), and exercised against a real Postgres — but only by its own integration test, not yet by the engine.
- `proofs.ts`'s `matcherView` is a VIEW, not a parser. U1 has landed, so the §4 proofs can now be re-run through the real parsers — not yet done.
- `testing-strategy.md` §2 plans a 60-event DEV_SEED golden snapshot. **60 events is too few** — §3's 2.8% `IDENTITY_DESTROYED` share rounds below the 3-member cluster floor and the generator correctly refuses. Use ≥100 events or raise that weight for the snapshot config.

Update this section as the build progresses so the next session knows where it is.
