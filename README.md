# Payment Reconciliation Engine + Analyst

**Razorpay AI Buildathon · Track 4 — AI Finance Controller**

Reconciles **920 payment records** across three deliberately inconsistent financial sources, refuses to guess when the evidence is thin, and can prove it: **zero false positives, measured offline against an answer key the engine cannot read.**

> ### ▶ [**Live API — check it right now, no setup**](https://payment-reconciliation-agent-platform-production.up.railway.app/api/health)
> **Live dashboard** · `<DEMO_URL>` — _Vercel deploy pending_
> **Pitch video (5 min)** · `<VIDEO_URL>`
> **Screenshots** · `<SCREENSHOT>`

<!-- ══════ BEFORE SUBMISSION: replace <DEMO_URL>, <VIDEO_URL>, <SCREENSHOT> above ══════ -->

---

## The numbers

Every number here is tagged with **where it came from**, because the difference decides whether it means anything. `ENGINE` is the system's own count of what it did. `MEASURED` is a separate offline scorer (`tools/score`) grading that output against a ground-truth key `apps/api` is architecturally forbidden from importing ([ADR-021](docs/adr-log.md)) — the engine has never seen it and cannot read it.

**An engine's self-reported match rate goes *up* when it matches the wrong bank credit.** That is why only the second block is allowed to make an accuracy claim.

**Every figure below is from one run** — `readme-canonical`, run id `831da294-ec28-46eb-9d04-11006f8f2628`,
holdout seed 90210, scored by `tools/score` 1.5.0 at exit code 0. One run, so the numbers
cannot drift against each other; regenerate the block from a single run whenever it changes.

```
ENGINE ─ what the run did ─────────────────────────────────────────
   920 source records          track asks for 50+ · 323 gateway / 301 bank / 296 ledger
   874 reconcilable            37 excluded · 9 duplicates collapsed · 0 rows rejected
   284 match groups            573 records in the 214 groups that count toward the rate
   212 exceptions              all classified · all explained · 21 distinct signatures
    70 review-queue groups     216 records found and deliberately NOT auto-confirmed
 65.56% match rate  (warm)     against a published ceiling of 93.0%
 65.22% match rate  (cold)     the same run with learned aliases disabled

MEASURED ─ graded against a key the engine cannot read ────────────
   precision        1.0000     pair-level · false positives 0 · TP 438
   recall           0.6117     ← the honest weakness. Addressed below. FN 278
   F1               0.7591
   unresolvable     21 / 21    every impossible case correctly refused
   classification   macro P 0.9286 · R 0.8738   ← weaker than matching, on purpose stated
   review queue     precision 1.0000 over 210 judged pairs

VERIFIABLE ─ recomputable by anyone, from the links below ─────────
   audit chain      614 entries · verifies · anchored
   reproducibility  byte-identical output from identical inputs
```

**What this build does not do.** It reconciles the **two registered synthetic datasets**
(`GET /api/health` lists them) — the multipart upload path is documented in the contract and
**not built** ([ADR-161](docs/adr-log.md)), so you cannot yet point it at your own three CSVs.
Ingestion is format-declared rather than format-guessed, and guessing at a column mapping is the
one thing an engine built to refuse guesses should not ship in a hurry. Throughput is therefore
measured at a single input size; there is no scale benchmark.

Two more limits worth stating in the same breath as the numbers above: **7 of the 8 exception
categories are exercised** by these datasets (`TIMING_DRIFT` has zero instances on either seed),
and **the Analyst is not scored** — see [The Analyst](#the-analyst) for exactly what is and is
not known about it.

### Verify it yourself in 5 seconds

Don't take the table's word for it. This hits the deployed instance — **a different run from the
one tabulated above**, which is why its entry count differs; a chain is verified per run:

```bash
curl -s "https://payment-reconciliation-agent-platform-production.up.railway.app/api/runs/cff41e32-dd53-43eb-a907-f1fa071bd32f/audit/verify"
```

```json
{ "valid": true, "entriesChecked": 612, "anchored": true,
  "chainHead": "d675dc05686dc24fac7b19c3f99a9da0471a7f9f9e6928d1939c34b80a5718cf",
  "firstDivergenceSequenceNo": null }
```

The endpoint recomputes a SHA-256 hash chain over every decision in that run and reports where it
breaks. It is designed to be able to say `false`. Swap `/audit/verify` for `/metrics` or
`/exceptions` to read the run.

**Verifying the tabulated run instead**, against a local instance — this is the run every number
above comes from, and `npm run score` re-derives the measured block from the answer key:

```bash
curl -s "http://localhost:8080/api/runs/831da294-ec28-46eb-9d04-11006f8f2628/audit/verify"
npm run score -- --run 831da294-ec28-46eb-9d04-11006f8f2628 --api http://localhost:8080
```

`npm run score` exits **0** when every honesty gate passed, **1** on a transport or hash failure,
and **2** when a build blocker fired. The exit code is the claim; the printout is the explanation.

**One thing you cannot verify from outside, stated rather than implied:** the audit entries
endpoint returns decisions, not their hashes, so `/audit/verify` is the server recomputing its own
chain. That detects corruption and accidental mutation — the append-only trigger and the chain are
independent guards — but it is not a proof you can recompute yourself without the hashes. Treat
"tamper-evident" as "the server will tell you if its own chain broke", which is what it is.

---

## Why the match rate is 65% and why that is the point

**A reconciliation engine that guesses is worse than useless — it produces a wrong book that looks right.** In finance ops an unmatched item costs an analyst ten minutes; a *wrongly* matched item corrupts a ledger and is found in an audit, months later. The asymmetry is enormous, so the engine is built to pay match rate for precision.

It does not merely *try* not to guess. Four structural properties make whole classes of wrong answer **arithmetically unreachable**, not discouraged:

| # | Property | Effect |
|---|---|---|
| 1 | **No-anchor pairs cannot auto-confirm** | A pair sharing no reference number caps at `0.70` against a `0.85` threshold — at any amount, any date, any name similarity. It cannot clear the bar. Amount-and-date agreement is a coincidence generator; a reference number is evidence. |
| 2 | **Contradicted anchors disqualify** | Two strong references that disagree discard the candidate outright, rather than scoring it low and hoping. |
| 3 | **The ambiguity guard** | Top two candidates within `0.05` → the engine refuses to choose, raises `AMBIGUOUS_MATCH`, and names both. |
| 4 | **Direction is a hard gate** | A credit never matches a debit, so a capture can never reconcile against a chargeback. |

**And the dataset publishes its own ceiling.** The generator writes the answer key *first*, then derives the messy files from it — and 7% of economic events are **proven unresolvable during generation** by assertion, not merely labelled: impossible for any correct engine, and for a competent human reading the same three files.

> The maximum honest match rate on this dataset is **93%**.
> **Which means anyone reporting 97% here is reporting false positives.** The ceiling is its own fraud detector.

**The refutation, stated plainly:** recall `0.6117` is real and it is the weakest number in the project. It concentrates in the HARD-difficulty band, and it is the price of the four properties above — every point of it was surrendered deliberately, at a known exchange rate, to hold precision at `1.0000`. The 70-group review queue — 216 records — is where most of it is recoverable: those are matches the engine *found* and declined to auto-confirm, sitting at a measured queue precision of `1.0000` over 210 judged pairs. Raising the match rate by loosening a threshold is explicitly forbidden by [ADR-027](docs/adr-log.md) — because a number that improves when the system gets things wrong is worse than no number at all.

---

## How it scores against the track's four criteria

| Criterion | What this repo puts on the table | Evidence |
|---|---|---|
| **Problem taste** | Multi-source reconciliation with an **exception list as the primary feature**, not a fallback. 8 categories with precedence, computed severity, and a human review queue — the shape a real finance team actually operates. | [schema.md §8](docs/schema.md) |
| **Build quality** | ~54,400 lines of TypeScript · 223 files · 62 test files · 13 forward-only migrations · **161 ADRs** · 28 documented endpoints. All SQL confined to `repositories/`. Read-only agent access enforced by **Postgres**, not by convention. | [ARCHITECTURE.md](ARCHITECTURE.md) · [adr-log.md](docs/adr-log.md) |
| **AI judgment** | **The LLM decides nothing.** Every match, category and severity comes from deterministic rules; the model writes prose about decisions already made. Proven: a run with a live model produced a **byte-identical score report** to a keyless run. | [ADR-017](docs/adr-log.md) |
| **Failure recovery** | **16 dated defect write-ups** — defect, root cause, fix, regression test. Including **six instances of the same meta-bug**: a test that passed whether or not the bug was present. The rule that came out of it: writing the test is not the guard, *watching it fail* is. | [what-broke.md](docs/what-broke.md) |

---

## Architecture — an engine, and an analyst

A real finance team has a reconciliation system **and** an analyst who works the exception queue it produces. This is both.

```
THE ENGINE — deterministic · reproducible · measured
   3 messy CSVs → INGEST → DEDUPE → TIER 1 exact → TIER 1.5 alias
                → IDENTITY short-circuit → TIER 2 fuzzy → BATCH decomposition
                → CLASSIFY (8 categories) → EXPLAIN → METRICS
                                  │
                                  ▼   engine output is now final and frozen
THE ANALYST — agentic · bounded · read-only
   TRIAGE → INVESTIGATE (multi-step tool use) → GROUNDING GATE → PROPOSE
                                  │
                                  ▼
                          human confirms or rejects
```

### The principle that keeps the agent honest

> **The agent chooses which questions to ask. Deterministic code computes every answer.**

It never does arithmetic. To learn whether two records match, it calls `score_pair` — **the engine's own locked scorer** — and gets exactly the number the engine would have got. What is agentic is the *strategy*: which records to pull, which hypothesis to test, when to stop.

Three enforcement layers, in increasing order of how hard they are to argue with:

1. **No mutating tool exists** in its registry. All 9 tools are reads.
2. **Postgres enforces it** — the agent runs inside a read-only transaction, so a write fails with `SQLSTATE 25006` rather than relying on anyone's discipline ([ADR-051](docs/adr-log.md)).
3. **A deterministic grounding gate** checks every citation against tool calls the agent actually made. An ID it never retrieved is an ID it **invented**, and the verdict is rejected before a human ever sees it.

A resolution proposed for a designed-unresolvable exception is a **build blocker, not a metric** ([ADR-053](docs/adr-log.md)).

---

## Cost discipline

Explanations are cached by **discrepancy signature** — the structural shape of a problem with every specific stripped out. On the current run, **212 exceptions collapse to 21 signatures: a 10.1× ratio.** Cost is `O(distinct shapes)`, not `O(exceptions)`.

That is what makes re-running the *full batch* cheap — which matters, because cherry-picking is the specific thing this track disqualifies.

**The LLM is also allowed to fail.** The deployed instance runs with a placeholder API key on purpose; its last run took three `401`s and still completed with **212 / 212 exceptions explained** via templates. Degradation is a designed path, and the public endpoint sits behind a per-IP rate limit and a `$2/hour` spend ceiling.

---

## Stack

**TypeScript** everywhere · Node 22 · **Express 5** · **PostgreSQL 16** — raw SQL, no ORM, no Redis · **Next.js 15** + React 19, plain CSS Modules · **Anthropic `claude-sonnet-5`** on both LLM surfaces · Vercel + Railway.

**No Kubernetes, no ORM, no Redis, no agent framework, no vector store.** The first four are scope decisions with ADRs behind them, not oversights. The last needs no ADR: reconciliation is a *join*, and a join wants deterministic code and a relational database. Reaching for embeddings here would have been the wrong instinct dressed up as sophistication.

---

## Run it

```bash
# 1. Data — the generator writes the answer key first, then derives the messy files
npm install && npm run generate -- dev

# 2. API
cd apps/api && npm install && npm run migrate && npm run dev

# 3. Dashboard
cd apps/web && npm install && npm run dev        # → localhost:3000

# 4. Score the run against ground truth. Exit 2 = an honesty gate fired.
npm run score -- --run <runId>
```

`npm run score` exit codes: **0** every honesty gate passed · **1** transport/hash failure · **2** a BUILD BLOCKER fired. The gates can stop a build; they have.

---

## Documentation

Documented before it was built. Every locked decision has its reasoning recorded next to it, and **the docs outrank the code** — if they disagree, the code is wrong until an ADR says otherwise.

| Doc | What it owns |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The scope lock — in scope, out of scope, concrete numbers, risks |
| [docs/validation-strategy.md](docs/validation-strategy.md) | Ground truth, precision/recall scoring, **the honesty protocols** |
| [docs/matching-engine.md](docs/matching-engine.md) | Stage order S0–S14, determinism guarantees, blocking, assignment |
| [docs/schema.md](docs/schema.md) | Tables, tolerances, the 8-category taxonomy and its precedence (7 fire on these datasets) |
| [docs/agent-design.md](docs/agent-design.md) | The Analyst: tool registry, investigation loop, grounding gate |
| [docs/api-contract.md](docs/api-contract.md) | All 28 endpoints. Binding on the code. |
| [docs/adr-log.md](docs/adr-log.md) | **158 decisions with reasoning.** Append-only — superseded, never edited |
| [docs/what-broke.md](docs/what-broke.md) | Every defect, root cause and fix, dated |
| [docs/analyst-baseline-sonnet5.md](docs/analyst-baseline-sonnet5.md) | What the live Analyst runs proved — **and what they did not** |

---

## What is not done

Listing this is the same discipline as publishing the ceiling. Each gap is stated with what it actually costs.

| Gap | Status and consequence |
|---|---|
| **The Analyst is not scored** | It is feature-complete and plumbing-verified — 10 investigations, 7 grounded cleanly, `$1.16`, median 4.8s. But `tools/score` does not yet score verdict *quality*, so proposal precision does not exist as a number. **This README therefore does not claim the Analyst works** — only that it runs, and cannot write, invent, or compute. Where a number is absent, the word used is "unmeasured". |
| **Frontend not yet deployed** | Nine routes exist and run locally; the Vercel deploy is pending. The API above is live and carries the same numbers. |
| **Deployed run shows two tiles as "not measured"** | Ground-truth figures live in `score_reports` and are never written to `runs.metrics` ([ADR-041](docs/adr-log.md)). The deployed DB has no score report posted, so the UI says so rather than borrowing the engine's self-report. |
| **`reapStaleRuns` unimplemented** | `STALE_RUN_TIMEOUT_MINUTES` is parsed and documented but enforced nowhere — a crashed run would poll forever. Known, scoped, ~30 minutes. |
| **Q&A loop cut** | Removed under a **pre-agreed degradation order** written before the time pressure arrived, so the cut was a plan rather than a panic. |

The dashboard carries this same rule as a design constraint: every figure renders with a `provenance` token — `engine`, `measured`, or `absent` — and the prop is **required**, so a number physically cannot render without declaring where it came from.

---

*Built solo · 2026-08-24 → 2026-09-05 · 226 commits · 161 ADRs · 16 defect write-ups*
