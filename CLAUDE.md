# CLAUDE.md

Context file for any AI agent or new contributor working in this repo. **Read this first.**
It is the source of truth for how the project is built; it is not a build diary. The day-by-day
history lives in `docs/what-broke.md` and `docs/adr-log.md`.

---

## 1. What this is

A **payment reconciliation engine** built solo for the **Razorpay AI Buildathon, Track 4 (AI Finance Controller)**. Locked 2026-08-24 · submission 2026-09-05.

It ingests three deliberately messy synthetic financial sources (a payment-gateway export, a bank settlement file, an internal merchant ledger), reconciles them through a tiered matching engine, classifies whatever it cannot match into an eight-category exception taxonomy, explains those exceptions in plain English via an LLM, logs every decision to a tamper-evident audit chain, and shows all of it on a dashboard. Downstream of the engine sits **the Analyst** — a read-only agent that investigates individual exceptions on demand.

**What the judges grade** (verbatim from the track page):

> "Throughput plus measured accuracy plus an honest exception list. One cherry-picked match proves nothing."

Three consequences that shape every decision here:

1. **The exception list is the primary feature**, not a fallback path.
2. **Accuracy is *measured* against a ground-truth key**, never printed by the engine about itself. See [docs/validation-strategy.md](docs/validation-strategy.md).
3. **A panelist must see the result without reading code.** The UI is not optional.

**Refusing to guess is a feature.** If the engine is unsure, the correct behaviour is an exception with a stated reason — never a confident wrong match. Any change that raises match rate by guessing is a regression, however good the number looks.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere. Node 22. |
| API | Express 5 |
| Database | PostgreSQL 16 — **no Redis, no ORM.** Raw SQL via `pg`, numbered forward-only migrations. |
| Frontend | Next.js 15 (App Router) + React 19. Plain CSS Modules + custom properties — **no Tailwind, no UI kit, no chart library** (ADR-100). |
| LLM | **Anthropic**, `claude-sonnet-5` on both surfaces — S13 explain and the Analyst. One `ANTHROPIC_API_KEY`, one `LLM_PROVIDER` switch. `LLM_PROVIDER=gemini` restores the Day 12 Gemini path exactly. (ADR-093) |
| Hosting | Vercel (web) + Railway (API + Postgres). **No Kubernetes, no containers we author.** |

Rationale for each is in [docs/adr-log.md](docs/adr-log.md). Don't re-litigate these — if you think one is wrong, append an ADR rather than quietly changing it.

---

## 3. Read these before changing anything

| Doc | What it owns |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **The scope lock.** In-scope / out-of-scope, model routing, concrete numbers, risks. Read §4 and §5 before proposing anything new. |
| [docs/schema.md](docs/schema.md) | **Data shapes.** Source schemas, normalized model, table shapes, tolerances, exception taxonomy + precedence, alias design, LLM prompt + caching, metrics. |
| [docs/matching-engine.md](docs/matching-engine.md) | **Execution.** Stage order S0–S14, determinism guarantees, blocking, assignment, dedup, identity short-circuit, batch decomposition, group assembly. |
| [docs/agent-design.md](docs/agent-design.md) | **The Analyst (Phase A).** Tool registry, investigation loop, grounding gate, self-correction, how the agent is measured. Read before touching anything agent-related. |
| [docs/api-contract.md](docs/api-contract.md) | Every endpoint. **Binding** — if code and contract disagree, the code is wrong until an ADR says otherwise. |
| [docs/ui-spec.md](docs/ui-spec.md) | Screens, states, the demo path, the pre-agreed degradation order. Binding on intent, not on arithmetic it could not check when written. |
| [docs/adr-log.md](docs/adr-log.md) | Every locked decision with reasoning. **Append-only.** |
| [docs/validation-strategy.md](docs/validation-strategy.md) | Ground-truth generation, precision/recall scoring, the scale benchmark, the honesty protocols. |
| [docs/testing-strategy.md](docs/testing-strategy.md) | What gets tested and what deliberately doesn't. |
| [docs/deployment.md](docs/deployment.md) | Hosting, env vars, secrets, deploy steps. |
| [docs/what-broke.md](docs/what-broke.md) | Dated log of every defect and its recovery. Required submission artifact. |
| [docs/analyst-baseline-sonnet5.md](docs/analyst-baseline-sonnet5.md) | The Analyst's measured behaviour on the current provider — what the live runs proved and what they did not. |

**If code and docs disagree, the docs are right until an ADR says otherwise.** Fix the doc first, add the ADR, then change code.

---

## 4. Repo structure

```
/
├── CLAUDE.md                  ← you are here
├── README.md                  ← public face; links the live demo
├── ARCHITECTURE.md            ← scope lock; source of truth for in/out of scope
├── docs/                      ← the locked design docs (see §3)
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
│   │   │   └── config/        ← env parsing, tolerance defaults, dataset registry
│   │   ├── migrations/        ← NNN_description.sql, forward-only
│   │   └── tests/             ← unit + integration
│   └── web/                   ← Next.js
│       ├── app/               ← routes (server components)
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

### Architectural invariants — do not break these

1. **All SQL lives in `repositories/`.** No query strings in routes or services. It is what keeps the schema knowable.
2. **`data/truth/` is never imported by `apps/api`.** Ground truth leaking into the engine invalidates every accuracy claim in the project. Scoring happens in `tools/score/`, offline. (ADR-021)
3. **Routes are thin.** Parse, validate, call a service, serialize. Business logic in a route belongs in a service.
4. **The LLM never decides anything.** It writes prose about decisions the rules already made. Anything that gives the model influence over match/no-match or category is a bug. (ADR-017)
5. **`audit_log` is append-only,** enforced by a DB trigger. Never write an `UPDATE` against it. (ADR-015)
6. **Money is `BIGINT` paise.** Never a float, never a `number` holding rupees. (ADR-006)
7. **Frontend fetches only through `lib/api-client.ts`.** One place for the base URL, error envelope, and casing.
8. **Nothing in the decision path reads the wall clock.** Date comparisons use `runs.reference_date` (ADR-039). `Date.now()` is for `occurred_at` and timing only. A run must be a pure function of its inputs.
9. **Every decision-feeding query has an explicit `ORDER BY`.** Unspecified row order silently breaks a measured accuracy claim. (ADR-032)
10. **Ground-truth-derived numbers go to `score_reports`, never to `runs.metrics`.** One table is the engine's account of itself, the other is a measurement. (ADR-041)
11. **The agent's tool registry contains no mutating tool, ever.** Phase A proposes; humans dispose through endpoints 16/20/21. Read-only is enforced by Postgres (`withReadOnlyTransaction`, SQLSTATE 25006), not merely declared. (ADR-049, ADR-051)
12. **The agent never does arithmetic.** It calls `score_pair` / `rerun_subset_search`, which run the engine's own locked code. A number in a reasoning chain the engine didn't compute is a bug. (ADR-049)
13. **Nothing in Phase A may appear in S0–S14.** The engine must run identically with `AGENT_ENABLED=false`. (ADR-048)
14. **Anything that takes a database client takes `TxClient`, not `pg.PoolClient`.** `withTransaction` is its only producer. Read the ADVISORY LOCKS note at the top of `db/pool.ts` before adding any lock — this repo has shipped a mis-scoped advisory lock twice. (ADR-066)

---

## 5. Naming conventions

| Thing | Convention | Example |
|---|---|---|
| DB tables | `snake_case`, plural | `learned_aliases`, `match_members` |
| DB columns | `snake_case`; money `_paise`; timestamps `_at`; dates `_date` | `amount_paise`, `approved_at`, `txn_date` |
| TS variables / fields | `camelCase` | `amountPaise`, `matchRatePct` |
| TS types / interfaces | `PascalCase`, no `I` prefix | `NormalizedTransaction`, `ExceptionDetail` |
| Files (TS) | `kebab-case.ts` | `tier2-fuzzy-matcher.ts` |
| React components | `PascalCase.tsx` | `ExceptionTable.tsx` |
| API routes | `kebab-case`, plural nouns | `/api/runs/:runId/review-queue` |
| Wire JSON | `camelCase` | `{ "amountPaise": 123450 }` |
| Migrations | `NNN_snake_case.sql`, zero-padded | `003_add_learned_aliases.sql` |
| Enum-ish DB values | `SCREAMING_SNAKE` for taxonomy, `lower_snake` for states | `AMOUNT_MISMATCH`, `pending_review` |
| Rule IDs | `SCREAMING_SNAKE` + `_V<n>` | `EXACT_PAYMENT_ID_V1` |
| Env vars | `SCREAMING_SNAKE` | `ANTHROPIC_API_KEY` |
| Git branches | `day<N>-<topic>` | `day17-doc-cleanup` |

**The `snake_case` ↔ `camelCase` boundary is the repository layer.** SQL in, camelCase objects out. Services and routes never see a `snake_case` key. One mapping point.

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
| **Signature** | The structural shape of a discrepancy with specifics stripped. The LLM cache key. (ADR-018) |
| **Cold run / warm run** | Without / with learned aliases. Both are always reported, always labelled. (ADR-020) |
| **Leverage ratio** | Records auto-resolved ÷ human corrections made. The alias feature's honest headline. |

---

## 7. Scope discipline

**In scope** and **explicitly out of scope** are in `ARCHITECTURE.md` §4 and §5. They are locked.

Out of scope, and staying out: fraud/risk scoring · cash-flow forecasting · multi-agent frameworks · auth / multi-tenancy / user accounts · mobile · fine-tuning · CQRS/hexagonal · live Razorpay APIs · over-designed UI · **Kubernetes and container orchestration** (ADR-005).

**If a task feels like it needs something on that list, stop and flag it rather than deciding alone.**

---

## 8. Build & test commands

Three independent packages (ADR-058): repo root owns `tools/`; `apps/api` and `apps/web` are standalone.

**Root (`tools/`):**

```
npm install
npm run generate -- dev            # regenerate the gitignored dev dataset
npm run score -- --run <runId>     # score a persisted run against the answer key
npm run score -- --run <runId> --post --out report.json
npm run score:watch                # re-score automatically when a run lands
npm test                           # tools/**/*.test.ts
npm run typecheck
```

`npm run score` exit codes: **0** every honesty gate passed · **1** transport/hash failure · **2** a BUILD BLOCKER fired.

**API (`apps/api/`):**

```
npm install
npm run migrate                    # run forward migrations against $DATABASE_URL
npm run dev                        # tsx watch, port from env
npm run build && npm start
npm test                           # unit + integration, needs a Postgres
npm run test:unit                  # unit only, no DB
npm run typecheck
npm run analyst                    # the Phase A measurement harness (CLI) — costs real API $
```

**Web (`apps/web/`):**

```
npm install
npm run dev                        # next dev, port 3000
npm run build
npm run typecheck
```

Before merging anything to `main`: `npm run typecheck` and `npm test` in each affected package, `next build` for web, and a re-score (`npm run score`) if any decision-path or scoring code changed.

---

## 9. Workflow guardrails

- **Commit or push only when asked.** Never merge a feature branch to `main` on your own initiative — the working agreement is one reviewer, who reviews and merges.
- **Never change a threshold, window, weight or tolerance because the score moved** (ADR-027). Structural fixes — wiring a stage that isn't called, comparing keys that should be compared — are allowed because they are arguable without citing the number. Validate on `DEV_SEED`, report on `HOLDOUT_SEED`; never tune against the holdout.
- **Report cold and warm match rates together, with the false-positive count next to them** (ADR-020). Same discipline for any small-n measurement: report the raw fraction and its denominator, or say "unmeasured".
- **Run on the full batch, never a subset.** Cherry-picking is the specific thing the track disqualifies.
- **Append to `docs/adr-log.md`** whenever you make a decision a future session might otherwise reverse. It is append-only — supersede an entry with a new one, never edit the old.
- **Keep `docs/what-broke.md` current** when a defect is found and fixed. It is a submission artifact and cannot be honestly reconstructed later.
- **Commit messages: never write `fix`/`fixed`/`closes`/`resolves` next to an issue number** unless the commit actually closes it — GitHub auto-closes on merge and does not read the sentence. Use `see #NN`, `per #NN`, `tracked in #NN`. Grep `main..HEAD` before merging.
- **A guard nobody has watched fail is indistinguishable from one that cannot fire.** When adding a regression test for a real defect, confirm it by reverting the fix and watching it fail.

---

## 10. Current state (2026-09-04)

### The engine — done, measured, stable

```
LIVE (demo-holdout, 43ca8a11, holdout seed 90210) — what the README quotes (ADR-173)
920 rows · 874 reconcilable · 570 matched · 284 groups · 212 exceptions
match rate 65.22% cold (ceiling 93%) — no aliases taught, so cold IS the run
precision 1.0000 · FP 0 · TP 435 · recall 0.6075 · unresolvable 21/21
audit chain: 612 engine entries, verifies and is anchored

LOCAL (warm, populated alias set) — real, but not reproducible on the deploy
match rate 65.56% warm · precision 1.0000 · FP 0 · recall 0.6117
```

Quote the LIVE block in anything a judge reads: those numbers resolve to a URL. The local warm figures are honest but unreproducible on the deployment, which is why they are not the headline (ADR-173).

Recall ~0.61 is the honest weakness and it lives in the HARD-difficulty band (0.15 there, vs 0.70 EASY). Precision 1.0000 with zero false positives is the point of the design: the engine claims only what it can stand behind and routes the rest to exceptions or the review queue.

### S13 explain — done

212 exceptions collapse to 21 signatures; every exception gets a non-null explanation, each tagged with its own `explanationSource`. Proven three ways on the live deploy: the same dataset run with the model unreachable (21 templates), live (21 generated) and cached (0 API calls) produced **byte-identical score reports** and the same 212 exceptions — the explain stage moved 63× and no decision moved with it (ADR-017 holding in practice).

### The Analyst — feature-complete, plumbing-verified, NOT measured

A1 triage → A2 investigate / corroborate → A3 grounding gate → A4 persist. Eleven read-only tools, read-only enforced by Postgres. Runs **on demand** when a human opens an exception (endpoint 25, 202-then-poll) — it does not sweep the queue. On Sonnet 5 locally, 14 of 19 investigations ground cleanly; 5 are downgraded by the gate. One reached RESOLUTION_PROPOSED with a grounded MANUAL_MATCH.

On the **live deploy** the record is 3 investigations: 2 concluded with grounding passed (one `NEEDS_EXTERNAL_DATA`, one `CONFIRMED_UNRESOLVABLE` after 6 tool calls), 1 **failed** at the 2,048-token output ceiling — thinking tokens count against it — returning no verdict after $0.10. It failed loudly rather than fabricating, which is the designed behaviour, but the ceiling is a real limit on harder exceptions (what-broke Day 18). Note the UI still says "nine read-only tools"; there are eleven, and the copy predates ADR-159/ADR-171.

> **The submission must not describe the Analyst as "working".** `tools/score` does not score it, so proposal precision, false-despair recovered, unresolvable agreement and hallucinated-resolutions (must be 0, ADR-053) do not exist as numbers. "Feature-complete and plumbing-verified" is the honest claim; nothing stronger. Scoring it is now affordable — it is offline work against the persisted verdicts, $0 of API — and is the highest-value open task.

### Frontend — U17 + U18 done

Ten server-rendered routes: dashboard, `/exceptions` (+ detail), `/review`, `/audit`, `/matches`, `/aliases`, `/records/[id]`, `/analyst`, `/set-aside`. Design principle to preserve: **provenance is a token** — every figure declares `engine` / `measured` / `absent`; `Figure`'s `provenance` prop is required so a number cannot render without saying where it came from. The write path (`resolve`) is verified end to end against a real audit entry.

### Deploy — both surfaces live

- **Web** · <https://payment-reconciliation-agent-platfo.vercel.app/> — ten server-rendered routes, `PINNED_RUN_ID` set to the `demo-holdout` run (ADR-166).
- **API** · <https://payment-reconciliation-agent-platform-production.up.railway.app> — reproduces the local numbers exactly over real HTTPS. Root Directory must be the **repo root**, not `apps/api`.

Redeploys are **manual, one click**; do not enable auto-deploy before submission (no CI, no stale-run reaper).

- `ANTHROPIC_API_KEY` on Railway is **valid and live** — the explain layer generates real signatures and the Analyst runs on the deployed instance. It was a placeholder until Day 18; runs from before the swap show three `401`s and template fallback, which is ADR-017 degradation working and is left in the record deliberately.
- Scoring on the deployed instance is **automatic** — a watcher posts a score report through endpoint 23 within 1–9 s of a run completing (measured across four live runs), so the live dashboard shows all four headline tiles as measured. The answer key is not reachable over HTTP; only the scorer reads it (ADR-021).
- The public API is rate-limited to **240 requests per window per IP** (ADR-096), exposed on `x-ratelimit-*`, with a $2/hour Anthropic spend ceiling behind it (ADR-095). `TRUST_PROXY_HOPS` is load-bearing on Railway.
- Measured deployment figures — latency percentiles, route delivery, run wall clock in three explain states — are in README §*What it costs to run* (ADR-174).

### Known-incomplete, stated rather than buried

| Item | Status |
|---|---|
| Analyst scoring in `tools/score` (validation-strategy §7) | not done — now affordable (offline, $0) |
| `reapStaleRuns` (ADR-046/097) | **not implemented.** `STALE_RUN_TIMEOUT_MINUTES` is parsed and documented but enforced nowhere — a crashed run polls forever. ~30 min fix, protects the demo. |
| Web deploy to Vercel (U19) | **done.** Live, with `PINNED_RUN_ID` set (ADR-166). Known defect: `?run=<id>` deep links hang on a cold load for runs created after the last build — see what-broke Day 18. |
| U16 scale benchmark | **not done** — the largest open gap. Deployment metrics at 920 records are published instead (ADR-174), explicitly labelled as supporting no claim above that size. |
| U15 Q&A loop (`/api/runs/:runId/ask`) | **shipped.** Cut under the pre-agreed degradation order, then built when the time was there; 11 questions answered, 9 grounded. |
| AUDIT-4 + U20 | **docs done** — external judge pass run against the live deploy, README re-based on the live run (ADR-173), five defects logged (what-broke Day 18). **Pitch video remaining.** |

### A recurring defect shape to watch for

Several config fields in this repo have been **parsed, documented, published, and enforced nowhere**: `AGENT_MAX_COST_USD_PER_RUN` (fixed), `STALE_RUN_TIMEOUT_MINUTES` (**open**), `datasetSeed` on `POST /api/runs` (fixed on the day17 branch), `aliasLearningEnabled` (fixed on day18 — it was the fourth instance, and the worst, because api-contract §2 names it as *the* way to measure the cold-start rate, so the documented route to the number the project is proudest of silently returned the warm one). The missing test is always the same one — *assert the field changes something*. When you add a knob, add that test, and **watch it fail against the unfixed code** before you trust it.

`STALE_RUN_TIMEOUT_MINUTES` is the one still open. It is the same shape and it will read the same way to a reviewer who tries it.
