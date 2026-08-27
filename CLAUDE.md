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
| [docs/adr-log.md](docs/adr-log.md) | Every locked decision with reasoning. Append-only. 57 entries. |
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

1. **Update `docs/what-broke.md` every single day.** It's a required submission artifact and it cannot be honestly reconstructed on Day 13. One line is fine; blank is not.
2. **Append to `docs/adr-log.md`** whenever you make a decision a future session might otherwise reverse.
3. **Never tune against `HOLDOUT_SEED`.** Develop against `DEV_SEED`. (ADR-027)
4. **Report cold and warm match rates together**, with the false-positive count next to them. (ADR-020)
5. **Run on the full batch, never a subset.** Cherry-picking is the specific thing the track disqualifies.

---

## 10. Current state

**As of 2026-08-27 (Day 4): architecture LOCKED. Five code units landed on Day 3, on branch `day5-scaffold-and-core` (named before the day count was corrected — the branch holds Day 3's work). Not yet merged.**

> **Day numbering.** The build is 13 *working* days, Aug 23 → Sep 5. **Aug 25 is not a numbered day** — no session happened, and numbering it inflated every subsequent day by one. Corrected on Day 4; the full table is ARCHITECTURE §8.

### History
- **Day 1 (Aug 23)** — pre-lock decisions, ADR-001…005.
- **Day 2 (Aug 24)** — six docs plus this file.
- *(Aug 25 — no session.)*
- **Day 3 (Aug 26)**, three passes in one day:
  1. Pre-build design review. `ARCHITECTURE.md` written (it had been cited 23 times by docs that existed before it did), plus `matching-engine.md`, `ui-spec.md`, `testing-strategy.md`. ADR-028…047. Three structural flaws fixed **before any code existed**: Tier 1's date window contradicted §5.2; `AMOUNT_MISMATCH` and `TIMING_DRIFT` were structurally unreachable; nothing at Tier 2 could ever auto-confirm.
  2. **The Analyst** (Phase A) — the agentic layer downstream of S14, closing a gap against the track's "build an agent" requirement without weakening ADR-017. ADR-048…057 plus `agent-design.md`.
  3. First code, in five reviewed units.
- **Day 4 (Aug 27)** — *today.*

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

### Next: Day 5 (2026-08-28) — the generator

**Start with a self-contained audit of units 9–10** (the audit chain and the grounding gate), the same way units 1–8 were audited. Then `tools/generate`.

The generator is the gate on everything downstream: **until it exists, nothing has been scored against ground truth, so every accuracy claim in this repo is a claim about code rather than a measurement.** Read `validation-strategy.md` §1–§4 first. Two constraints the engine already depends on:

- `DUPLICATE_ROW` must emit its copy carrying the **same strong anchor** (ADR-034), because dedupe requires anchor evidence and `IDENTITY_DESTROYED` deliberately plants anchorless look-alikes.
- For every non-`AMOUNT_TRUE_MISMATCH` event, `ledger.net_amount` must equal `gateway.amount` **exactly** (ADR-037).

Unresolvability is **proved during generation**, not labelled: assert ≥3 indistinguishable candidates, run a real subset-sum check, assert no event references the orphan row.

### Carried debt, stated rather than buried
- **Nothing is deployed, deliberately** (ADR-061). Deploying a half-built project means keeping two environments correct while dependencies, refactors and migrations are still moving. Scheduled: Day 11 (API), Day 12 (web). It is a dated task, not a spare-time task.
- `tools/generate` and `tools/score` are still stubs. **Nothing has been measured yet** — the engine's accuracy is currently an untested claim. Day 5 (generator) and Day 9 (scorer) are when that changes.
- **Nothing is wired end to end.** The stages exist and are individually tested; no run orchestrator calls them in sequence, no routes are mounted, `createApp` serves 404s by design.
- The repository layer is one file deep: only `repositories/audit.ts` exists. The rest are stubs.

Update this section as the build progresses so the next session knows where it is.
