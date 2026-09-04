# Payment Reconciliation Engine + Analyst

**Razorpay AI Buildathon · Track 4 — AI Finance Controller**

This engine reconciles 920 payment records across three deliberately inconsistent financial sources and gets **65.22%** of them matched.

That is the number I am most confident about, and it is deliberately not higher.

> ### ▶ [**Live dashboard**](https://payment-reconciliation-agent-platfo.vercel.app/) · [**Live API**](https://payment-reconciliation-agent-platform-production.up.railway.app/api/health)
> **Pitch video (5 min)** · `<VIDEO_URL>` — _recording after this doc freeze_
> Both are up right now. No signup, no setup, nothing to install.

<!-- BEFORE SUBMISSION: replace <VIDEO_URL> above. Everything else on this page is live. -->

---

## Sixty seconds

If you read nothing else:

- **65.22% matched, 0 false positives.** Not "we think zero" — measured against an answer key the engine is architecturally forbidden from reading.
- **The ceiling on this dataset is 93%**, published by the data generator, not by me. So 65.22 of an achievable 93. Anyone reporting 97% here is reporting false positives.
- **The other 34.78% is not hidden.** 212 exceptions, every one classified, explained and priced. 46 rows set aside before the denominator, every one listed individually with its reason.
- **The model decides nothing.** I ran the same dataset three times — model dead, model live, model cached — and the match rate, the exception list and the score report came out identical.
- **Everything above is re-runnable by you, on the live URL, in about five seconds.** The next block is the command.

---

## Don't trust any of this. Check it.

The whole project is built so that you don't have to take my word for anything. Start here:

```bash
curl -s "https://payment-reconciliation-agent-platform-production.up.railway.app/api/runs/43ca8a11-25ab-418c-a689-282e0e5e66e6/audit/verify"
```

```json
{ "valid": true, "entriesChecked": 644, "anchored": true,
  "chainHead": "f08b4da3372d3a9ddbab0c1b895598d2ec20fd278c3cfce4313c24a323ed4161",
  "expectedChainHead": "f08b4da3372d3a9ddbab0c1b895598d2ec20fd278c3cfce4313c24a323ed4161",
  "firstDivergenceSequenceNo": null }
```

That endpoint recomputes a SHA-256 chain over every decision in the run and reports the first entry where it stops agreeing. It is built to be able to answer `false`.

**And you don't have to trust that endpoint either.** Every entry carries its own `prevHash` and `entryHash`, and [`schema.md` §9](docs/schema.md) publishes the exact recipe — the seventeen hashed fields, the canonical-JSON rules, `sha256(canonicalJson || prevHash)`. So you can rebuild the chain with your own code and compare heads ([ADR-168](docs/adr-log.md)).

Someone did exactly that. See [What an outside judge found](#what-an-outside-judge-found).

> `entriesChecked` grows as people use the live demo — every investigation appends to the chain. The engine's own contribution is frozen at **612 entries**; the rest is agent and human activity, which is the point of separating them.

---

## The numbers

Every figure is tagged with **where it came from**, because the difference is the whole argument. `ENGINE` is the system counting its own work. `MEASURED` is a separate offline scorer (`tools/score`) grading that output against a ground-truth key `apps/api` cannot import ([ADR-021](docs/adr-log.md)).

**A self-reported match rate goes _up_ when the engine matches the wrong bank credit.** That is why only the second block is allowed to make an accuracy claim.

**Everything below comes from one run** — `demo-holdout`, run id `43ca8a11-25ab-418c-a689-282e0e5e66e6`, holdout seed 90210 — **and that run is live on the API right now.** Every number here is a URL away.

```
ENGINE ─ what the run did ──────────────────────────────────────────
   920 source records          track asks for 50+ · 323 gateway / 301 bank / 296 ledger
   874 reconcilable            37 excluded · 9 duplicates collapsed · 0 rows rejected
   570 matched records         in 284 groups the engine confirmed on its own
   212 exceptions              all classified · all explained · 21 distinct signatures
    71 review-queue groups     219 records found and deliberately NOT auto-confirmed
 65.22% match rate             against a published ceiling of 93.0%

MEASURED ─ graded against a key the engine cannot read ─────────────
   precision        1.0000     pair-level · false positives 0 · TP 435
   recall           0.6075     ← the honest weakness. Addressed below. FN 281
   F1               0.7559
   unresolvable     21 / 21    every impossible case correctly refused
   classification   macro P 0.9286 · R 0.8738   ← weaker than matching, stated on purpose
   review queue     precision 1.0000 over 213 judged pairs

VERIFIABLE ─ reproduced from outside this repo ─────────────────────
   audit chain      612 engine entries · verifies · anchored
   reproducibility  two separately triggered runs → byte-identical score reports
   generalisation   precision 1.0000 · FP 0 on a second, independent dataset
```

**Why the headline is the cold number.** A "warm" run reuses aliases a human taught the system earlier, and will always score at least as well. Reporting only the warm figure credits the engine for a person's work ([ADR-020](docs/adr-log.md)), so both always ship together. The public demo has **no aliases taught**, so warm and cold are the same run and the same 65.22%. Locally, with the alias set populated, the same seed reaches 65.56% — a real number, but not one this deployment can show you, so it is not the headline.

**What this build does not do.** It reconciles the **two registered synthetic datasets** (`GET /api/health` lists them). The multipart upload path is specified in the contract and **not built** ([ADR-161](docs/adr-log.md)) — ingestion is format-declared rather than format-guessed, and guessing at a column mapping is the one thing an engine built to refuse guesses should not ship in a hurry.

Two more limits, stated in the same breath as the numbers: **7 of the 8 exception categories fire** on these datasets (`TIMING_DRIFT` has zero instances on either seed, and renders as a zero rather than vanishing), and **the Analyst is not scored** — see [The Analyst](#the-analyst).

> **[SCREENSHOT — the exception list, which is the actual product]**
> Open <https://payment-reconciliation-agent-platfo.vercel.app/exceptions> and capture the category filter rail (left) beside the first four or five exception rows, so the per-category `measured` P/R values and the plain-English explanations are both readable in one frame. If it will not fit, prefer the frame that keeps the P/R numbers — a list that publishes its own classifier precision is the unusual part.

### Re-derive the measured block yourself

The scorer runs offline against the answer key and will happily contradict me:

```bash
git clone https://github.com/flare19/payment-reconciliation-agent-platform.git
cd payment-reconciliation-agent-platform && npm install
npm run score -- --run 43ca8a11-25ab-418c-a689-282e0e5e66e6 \
  --api https://payment-reconciliation-agent-platform-production.up.railway.app
```

Exit **0** = every honesty gate passed · **1** = transport or hash failure · **2** = a build blocker fired. **The exit code is the claim.** The printout is just the explanation.

> **[SCREENSHOT — the scorer disagreeing with nobody]**
> Run the two commands directly above in a terminal, then screenshot from the `══ MATCHING (pairs) ══` header down to `══ every honesty gate passed ══`. Include the shell prompt line so the command is visible. This is the single most persuasive frame in the project: an independent process, reading a key the API cannot touch, arriving at the same numbers as the dashboard.
>
> To capture the exit code too, run `npm run score -- --run 43ca8a11-25ab-418c-a689-282e0e5e66e6 --api https://payment-reconciliation-agent-platform-production.up.railway.app; echo "exit=$?"` and include the final `exit=0` line in the frame.

---

## Why 65% is the point, not the apology

**An engine that guesses is worse than useless, because it produces a wrong book that looks right.**

In finance ops an unmatched item costs an analyst ten minutes. A *wrongly* matched item corrupts a ledger and gets found in an audit, months later, by someone who now distrusts every other number you gave them. The asymmetry is enormous. So this engine pays match rate for precision, on purpose, at a known exchange rate.

It does not merely *try* not to guess. Four structural properties make whole classes of wrong answer **arithmetically unreachable**:

| # | Property | Effect |
|---|---|---|
| 1 | **No-anchor pairs cannot auto-confirm** | A pair sharing no reference number caps at `0.70` against a `0.85` threshold — at any amount, any date, any name similarity. It cannot clear the bar. Amount-and-date agreement is a coincidence generator; a reference number is evidence. |
| 2 | **Contradicted anchors disqualify** | Two strong references that disagree discard the candidate outright, rather than scoring it low and hoping. |
| 3 | **The ambiguity guard** | Top two candidates within `0.05` → the engine refuses to choose, raises `AMBIGUOUS_MATCH`, and names both. |
| 4 | **Direction is a hard gate** | A credit never matches a debit, so a capture can never reconcile against a chargeback. |

**And the dataset publishes its own ceiling.** The generator writes the answer key *first*, then derives the messy files from it — and 7% of economic events are **proven unresolvable during generation** by assertion, not merely labelled. Impossible for any correct engine, and for a competent human reading the same three files.

> The maximum honest match rate on this dataset is **93%**.
> **Which means anyone reporting 97% here is reporting false positives.** The ceiling is its own fraud detector.

**Now the part that argues against me.** Recall `0.6075` is real, and it is the weakest number in this project. It concentrates in the HARD band — `0.70` on EASY, `0.67` on MEDIUM, **`0.15` on HARD** — and that profile holds on both datasets, so it is a genuine capability boundary and not noise. Roughly two of every five reconcilable pairs are missed.

Most of it is recoverable and already located: the 71-group review queue, 219 records, sitting at a measured queue precision of `1.0000` over 213 judged pairs. Those are matches the engine **found** and declined to auto-confirm. Raising the headline by loosening a threshold is explicitly forbidden ([ADR-027](docs/adr-log.md)) — a number that improves when the system gets things wrong is worse than no number at all.

---

## What an outside judge found

Before submission I handed the live deployment to an adversarial reviewer with one instruction: assume nothing, reproduce every claim or mark it unproven, and actively try to break the strong ones.

They triggered four runs, scored two datasets from their own machine with their own copies of the answer keys, and re-walked the audit chain by hand. What came back:

| Claim they tested | Result |
|---|---|
| Match rate 65.22% on held-out data, full batch | **Reproduced.** Scorer exit 0. No subsetting — 874 of 874. |
| Precision 1.0000 · zero false positives | **Reproduced on both datasets.** TP 435 / FP 0 on holdout; TP 442 / FP 0 on the second seed. |
| Byte-reproducible from its inputs | **Reproduced.** Two independently triggered live runs produced byte-identical score reports. |
| Audit chain is tamper-evident | **Reproduced independently.** 0 linkage breaks across 644 entries; their own computed head matched the server's exactly, before and after causing real writes. |
| The LLM decides nothing | **Reproduced, harder than I had.** See below. |
| Nothing is quietly dropped | **Reproduced.** All five identity equations hold; all 46 set-aside rows itemised. |
| Scaling behaviour beyond 920 records | **Unproven.** No benchmark exists. Correct — see [What is not done](#what-is-not-done). |

Their summary was that the project "claims less than it can prove." Two of the gaps they named are now closed in this document — the proof below, and the [deployment metrics](#what-it-costs-to-run-measured-on-the-live-deploy). The third, the scale curve, is still open and still listed as open.

They also reported five defects. **Four were real and are logged in [what-broke.md](docs/what-broke.md); the fifth was the reviewer's own measurement error**, retracted there with the method that produced it. Two of the four are fixed, two are named as open.

### The proof I did not know I had

The Anthropic key on Railway was invalid during one run and valid during the next. That accident produced the cleanest test in the project: **the same dataset, reconciled three times, with the explain layer in three completely different states.**

| Run | Explain layer | Stage time | Match rate | Exceptions | Score report |
|---|---|---|---|---|---|
| `demo-holdout` | model unreachable → 21 templates | 479 ms | 65.22% | 212 | identical |
| `judge-repro-check` | model live → 21 generated | 30,042 ms | 65.22% | 212 | identical |
| `judge-cache-check` | 0 API calls → 21 from cache | 759 ms | 65.22% | 212 | identical |

Same match rate. Same 212 exceptions. Same category counts. Same resolvability split (109 / 92 / 11). **Byte-identical score reports across all three.**

The explain stage moved by a factor of 63 and not one decision moved with it. That is [ADR-017](docs/adr-log.md) — *the LLM writes prose about decisions the rules already made* — demonstrated rather than asserted.

---

## What it costs to run, measured on the live deploy

Measured 2026-09-04 against the production instances, from a client in India. Tools: [`hey`](https://github.com/rakyll/hey) for load, `curl` for delivery timing, Chrome DevTools Navigation Timing for the browser figures. Every command below is re-runnable.

**API — Railway, single instance, no autoscale** (`hey -n 150 -c 10`, 150/150 → `200`):

| Endpoint | p50 | p90 | p95 | p99 | Throughput |
|---|---|---|---|---|---|
| `GET /api/health` | 243 ms | 361 ms | 405 ms | 519 ms | 36.9 req/s |
| `GET /api/runs/:id/metrics` (~35 KB JSON) | 250 ms | 430 ms | 1,306 ms | 2,503 ms | 23.4 req/s |

The p95/p99 tail on the heavier endpoint is a single container with no horizontal scaling — an honest artefact of a hobby-tier deploy, not a mystery. **The public API is rate-limited to 240 requests per window per IP** ([ADR-096](docs/adr-log.md)), exposed on `x-ratelimit-limit` / `-remaining` / `-reset`, with a `$2/hour` Anthropic spend ceiling behind it ([ADR-095](docs/adr-log.md)).

**Frontend — Vercel, 8 server-rendered routes**, full server render, three samples each:

| Route | Total | Over the wire | Decoded |
|---|---|---|---|
| `/` (dashboard) | 0.99–1.13 s | 27 KB | 179 KB |
| `/exceptions` | 0.85–0.95 s | 16 KB | 199 KB |
| `/audit` | 0.65–0.69 s | 15 KB | 179 KB |
| `/matches` | 0.76–0.87 s | 14 KB | 120 KB |
| `/analyst` · `/review` · `/aliases` · `/set-aside` | 0.51–1.13 s | 6–13 KB | 24–58 KB |

Edge TTFB 82 ms; 6.6:1 compression on the heaviest route; 15 sub-resources; no client-side data fetching on first paint.

**A complete reconciliation run, end to end on the live API** — same 874 records, three explain states:

| | Wall clock | Engine only |
|---|---|---|
| Explain templated (model unreachable) | **2.47 s** | 2,427 rec/s |
| Explain from cache (0 API calls) | **8.4 s** | 1,122 rec/s |
| Explain cold (21 signatures generated live) | **38.2 s** | 1,005 rec/s |

Engine-only throughput varies about 2.4× run to run on identical input, which is what a shared container does; the honest figure is a range, not the best sample. **`recordsPerSecEngine` excludes database writes and model latency and `recordsPerSecWallClock` includes them, and the API returns both** — because only one of them is a claim about the matching engine.

**Scoring is automatic on the deployed instance.** A watcher posts a score report through endpoint 23 **1.1–8.5 s after a run finishes** (measured across four live runs), which is why the dashboard shows all four headline tiles as measured rather than asking you to run a CLI. The answer key itself is not reachable over HTTP — six path probes, all `404`. Only the scorer reads it ([ADR-021](docs/adr-log.md)).

**What none of this tells you:** anything about behaviour above 920 records. See [What is not done](#what-is-not-done).

---

## Architecture — an engine, and an analyst

A real finance team has a reconciliation system **and** somebody who works the exception queue it produces. This is both.

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

> **[SCREENSHOT — the dashboard headline]**
> Open <https://payment-reconciliation-agent-platfo.vercel.app/> and capture from the page title down through the four headline tiles, so the `MEASURED` badge on False Positives and the 93% ceiling are both visible. That one frame carries the whole argument.

---

## The Analyst

Downstream of the engine sits a read-only agent that investigates **one** exception when a person asks. It does not sweep the queue.

> **The agent chooses which questions to ask. Deterministic code computes every answer.**

It never does arithmetic. To learn whether two records match it calls `score_pair` — **the engine's own locked scorer** — and gets exactly the number the engine would have got. What is agentic is the *strategy*: which records to pull, which hypothesis to test, when to stop.

Three enforcement layers, in increasing order of how hard they are to argue with:

1. **No mutating tool exists** in its registry. All 11 tools are reads.
2. **Postgres enforces it** — the agent runs inside a read-only transaction, so a write fails with `SQLSTATE 25006` rather than relying on anyone's discipline ([ADR-051](docs/adr-log.md)).
3. **A deterministic grounding gate** checks every citation against tool calls the agent actually made. An ID it never retrieved is an ID it **invented**, and the verdict is rejected before a human sees it.

A resolution proposed for a designed-unresolvable exception is a **build blocker, not a metric** ([ADR-053](docs/adr-log.md)).

**Here is one it got right.** Asked to investigate a `MISSING_IN_LEDGER` exception, it chased the RRN, then the order id, then searched by counterparty — found a ledger entry matching the amount *exactly* but disagreeing on date and payment id, and concluded `CONFIRMED_UNRESOLVABLE` rather than forcing the match. Four steps, six tool calls, grounding passed, $0.087. **Refusing an available-looking answer is the behaviour the whole design is for.**

**And here is one it got wrong.** A harder `AMBIGUOUS_MATCH` investigation hit the 2,048-token output ceiling — thinking tokens count against it — and returned no verdict at all, after spending $0.10. It failed loudly: status `failed`, verdict `null`, and an error naming the actual cause. It did not fabricate. But it failed, and 1 of the 3 live investigations on the demo run is a failure. That is in [what-broke.md](docs/what-broke.md) too.

> **[SCREENSHOT — an Analyst investigation]**
> Open <https://payment-reconciliation-agent-platfo.vercel.app/analyst> and capture the "Every Investigation" table plus the "What Is Not Known" block directly beneath it — the two together show a working agent and an honest account of what has not been measured about it.

---

## How it scores against the track's four criteria

| Criterion | What this repo puts on the table | Evidence |
|---|---|---|
| **Problem taste** | Multi-source reconciliation with an **exception list as the primary feature**, not a fallback. 8 categories with precedence, computed severity, money at risk, and a human review queue — the shape a finance team actually operates. | [schema.md §8](docs/schema.md) |
| **Build quality** | ~55,500 lines of TypeScript · 230 files · 63 test files · 14 forward-only migrations · **174 ADRs** · 29 documented endpoints. All SQL confined to `repositories/`. Read-only agent access enforced by **Postgres**, not by convention. | [ARCHITECTURE.md](ARCHITECTURE.md) · [adr-log.md](docs/adr-log.md) |
| **AI judgment** | **The LLM decides nothing**, and I can now show it three ways rather than assert it once. Every match, category and severity comes from deterministic rules. Also counts: choosing *not* to use a model for matching, and not reaching for embeddings on what is fundamentally a join. | [ADR-017](docs/adr-log.md) |
| **Failure recovery** | **17 dated defect write-ups** — defect, root cause, fix, regression test. Including **six instances of the same meta-bug**: a test that passed whether or not the bug was present. The rule that came out of it: writing the test is not the guard, *watching it fail* is. | [what-broke.md](docs/what-broke.md) |

---

## Cost discipline

Explanations are cached by **discrepancy signature** — the structural shape of a problem with every specific stripped out. On this run, **212 exceptions collapse to 21 signatures: a 10.1× ratio.** Cost is `O(distinct shapes)`, not `O(exceptions)`.

That is what makes re-running the *full batch* cheap, which matters, because cherry-picking is the specific thing this track disqualifies. A warm-cache run makes **zero** API calls, and I watched it do that on the live deploy.

**The model is also allowed to fail.** When the deployed key was invalid, the run took three `401`s and still finished with **212 / 212 exceptions explained** through deterministic templates, with `explanationSource` on every one saying which it was. Degradation is a designed path, not an incident.

---

## Stack

**TypeScript** everywhere · Node 22 · **Express 5** · **PostgreSQL 16** — raw SQL, no ORM, no Redis · **Next.js 15** + React 19, plain CSS Modules · **Anthropic `claude-sonnet-5`** on both LLM surfaces · Vercel + Railway.

**No Kubernetes, no ORM, no Redis, no agent framework, no vector store.** The first four are scope decisions with ADRs behind them, not oversights. The last needs no ADR: reconciliation is a *join*, and a join wants deterministic code and a relational database. Reaching for embeddings here would have been the wrong instinct dressed up as sophistication.

---

## Run it locally

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

Deployment, environment variables and the release checklist are in [docs/deployment.md](docs/deployment.md).

---

## Documentation

Documented before it was built. Every locked decision has its reasoning recorded next to it, and **the docs outrank the code** — if they disagree, the code is wrong until an ADR says otherwise.

| Doc | What it owns |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The scope lock — in scope, out of scope, concrete numbers, risks |
| [docs/validation-strategy.md](docs/validation-strategy.md) | Ground truth, precision/recall scoring, **the honesty protocols** |
| [docs/matching-engine.md](docs/matching-engine.md) | Stage order S0–S14, determinism guarantees, blocking, assignment |
| [docs/schema.md](docs/schema.md) | Tables, tolerances, the 8-category taxonomy and its precedence |
| [docs/agent-design.md](docs/agent-design.md) | The Analyst: tool registry, investigation loop, grounding gate |
| [docs/api-contract.md](docs/api-contract.md) | All 29 endpoints. Binding on the code. |
| [docs/deployment.md](docs/deployment.md) | Hosting, environment variables, secrets, release checklist |
| [docs/adr-log.md](docs/adr-log.md) | **174 decisions with reasoning.** Append-only — superseded, never edited |
| [docs/what-broke.md](docs/what-broke.md) | Every defect, root cause and fix, dated |
| [docs/analyst-baseline-sonnet5.md](docs/analyst-baseline-sonnet5.md) | What the live Analyst runs proved — **and what they did not** |

---

## What is not done

Publishing this is the same discipline as publishing the ceiling. Each gap is stated with what it actually costs.

| Gap | Status and consequence |
|---|---|
| **No scale benchmark** | The 1k / 10k / 100k throughput curve specified in [ADR-045](docs/adr-log.md) was never run, so **nothing here supports any claim about behaviour above 920 records** — and blocking degrades non-linearly if it degrades at all. This is the largest open gap and the one an outside reviewer flagged hardest. |
| **The Analyst is not scored** | Feature-complete and plumbing-verified, but `tools/score` does not grade verdict *quality*, so proposal precision, false-despair-recovered and hallucinated-resolutions do not exist as numbers. **This README therefore does not claim the Analyst works** — only that it runs, is bounded, and cannot write, invent or compute. Where a number is absent, the word used is "unmeasured". |
| **`reapStaleRuns` unimplemented** | `STALE_RUN_TIMEOUT_MINUTES` is parsed and documented but enforced nowhere — a crashed run would poll forever. Known, scoped, ~30 minutes. |
| **`TIMING_DRIFT` has no instances** | 7 of 8 categories fire on these seeds. The rule is wired and unit-tested; no record met its definition. It renders as a zero rather than disappearing, because a bar that is not drawn and a bar of length zero mean different things. |
| **`llmConfigured` tests presence, not validity** | `/api/health` reported `true` while the key was returning `401`. Narrowly correct by its own definition, misleading in practice. Logged, low severity, unfixed at freeze. |

The dashboard carries this same rule as a design constraint: every figure renders with a `provenance` token — `engine`, `measured`, or `absent` — and **the prop is required**, so a number physically cannot render without declaring where it came from.

---

*Built solo · 2026-08-24 → 2026-09-05 · 242 commits · 174 ADRs · 17 defect write-ups*
