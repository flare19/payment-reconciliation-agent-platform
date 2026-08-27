# ARCHITECTURE

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4 (AI Finance Controller)
Locked 2026-08-24 · Revised 2026-08-26 (Day 3 design review, ADR-028…ADR-047; Analyst layer, ADR-048…ADR-057) · **Submission 2026-09-05**

**This file is the scope lock.** Every other doc references it. If something is not in §4, it is not being built; if it is in §5, it is not being built *on purpose*, and the reason is recorded.

> **Note on authorship:** this file was referenced by name from `CLAUDE.md` and all six `docs/` files from Day 2 but was never actually written. It was authored on Day 3 as part of the pre-build design review, reconstructing the section numbering those references already assumed (§3 model routing, §4 in-scope, §4.4 exception classification, §4.6 audit trail, §4.7 metrics, §5 out-of-scope, §6 concrete numbers, §7 working practices, §7.4 deploy-early). See ADR-047.

---

## 1. The problem, and the bar

Three financial systems disagree about the same money. A payment gateway says a customer paid ₹1,234.50 on 14 August. The bank says ₹1,198.12 landed on 16 August. The merchant's own ledger says ₹1,234.50 on 14 August, filed under a different spelling of the customer's name. All three are describing one event. A finance controller's job is to prove that, and to be precise about the cases where it cannot be proved.

The track's grading bar, verbatim:

> "Throughput plus measured accuracy plus an honest exception list. One cherry-picked match proves nothing."

Three consequences that govern this entire repo:

1. **The exception list is the product.** Not a fallback path — the primary screen, the primary data structure, the primary demo.
2. **Accuracy is measured against an independent key**, generated before the engine ever runs. A number the engine prints about itself is not a measurement. See [docs/validation-strategy.md](docs/validation-strategy.md).
3. **A panelist must reach the result without reading code.** A live URL showing a completed run, above the fold.

**Refusing to guess is a feature.** Any change that raises the match rate by guessing is a regression, however good the number looks. The ambiguity guard (ADR-010) and the published accuracy ceiling (validation-strategy §4) exist to make that structural rather than aspirational.

---

## 2. System shape

```
  3 messy CSVs                     ┌──────────────────────────┐
  ───────────                      │  data/truth/*.json       │
  gateway_export.csv               │  answer key              │
  bank_settlement.csv              │  (engine NEVER reads)    │
  merchant_ledger.csv              └────────────┬─────────────┘
        │                                       │
        ▼                                       │
  ┌─────────────┐  lossless, 1 row in = 1 row stored
  │ INGESTION   │  parse · normalize · exclude non-reconcilable · hash inputs
  └──────┬──────┘
         ▼
  ┌─────────────┐  dedup → Tier 1 exact → Tier 1.5 alias → Tier 2 fuzzy
  │ MATCHING    │  deterministic order, global score-ordered assignment
  └──────┬──────┘  see docs/matching-engine.md
         ▼
  ┌─────────────┐  8 categories, one primary + secondary flags,
  │ CLASSIFY    │  severity from category × amount magnitude
  └──────┬──────┘
         ▼
  ┌─────────────┐  one call per DISCREPANCY SHAPE, not per exception
  │ EXPLAIN     │  never decides anything · never on the critical path
  └──────┬──────┘
         ▼
  ═══════════════════ engine output is now FINAL ═══════════════════
         │
         ▼
  ┌─────────────┐  A1 triage · A2 investigate · A3 validate · A4 propose
  │ THE ANALYST │  agentic: multi-step tool use over the exception queue
  │  (Phase A)  │  reads engine output as fact · cannot modify it
  └──────┬──────┘  see docs/agent-design.md
         ▼
  ┌─────────────┐        ┌──────────────────┐        ┌──────────────┐
  │ AUDIT LOG   │───────►│ API (Express)    │───────►│ Dashboard    │
  │ hash-chained│        │ 28 endpoints     │        │ Next.js      │
  └─────────────┘        └──────────────────┘        └──────────────┘
                                  ▲
                                  │ score report (POST, offline scorer)
                         ┌────────┴─────────┐
                         │ tools/score/     │  joins engine AND agent output
                         └──────────────────┘  ↔ the same answer key
```

**Two halves, measured separately.** The Engine (S0–S14) is deterministic and reproducible; its accuracy is the headline number. The Analyst (A1–A4) is agentic and bounded; it works the exception queue the Engine produces and is scored against the same answer key, which neither of them can read. Their numbers are never merged — see §4.11 and ADR-051.

---

## 3. Model routing

On Claude Pro, Sonnet and Opus share one quota pool and Opus costs 1.7–5× more per turn. Routing is therefore deliberate:

- **Sonnet — the default.** Backend logic, matching engine, classifier, generator, API routes, migrations, LLM integration, tests, and the bulk of frontend implementation once a design direction exists.
- **Opus — planning and taste only.** Architecture passes (`/model opusplan`: Opus plans, Sonnet executes) and the frontend's initial creative pass.
- **Opus — nuclear button.** Hard debugging dead-ends, wrong matching results with no obvious cause, a structural decision clearly gone wrong.
- Clear or compact context between unrelated tasks. Don't leave Opus running after a planning pass ends.

**At runtime the application calls `claude-sonnet-5` only** (ADR-019). Opus is a build-time tool, never a production dependency.

---

## 4. In scope

### 4.1 Ingestion
Parse three CSVs with three different date formats, three different amount formats, and one free-text description blob carrying embedded identifiers. Ingestion is **lossless and opinion-free**: one source row in, one `transactions` row stored, `raw_payload` retained verbatim (ADR-007). Malformed rows are captured as rejected rows with a reason, never silently dropped and never allowed to kill a run (ADR-046).

### 4.2 Normalization
Money to integer paise (ADR-006). Dates to an IST business date plus a UTC instant. Counterparty strings through a deterministic normalizer. Non-reconcilable records (`failed`, `authorized`, `draft`, `void`, bank `FEE` rows) excluded here with a stated reason (ADR-036) — excluded, not matched-and-failed.

### 4.3 Matching
Four ordered stages: same-source deduplication, Tier 1 exact, Tier 1.5 alias-resolved, Tier 2 fuzzy — then Tier 3 exception classification for whatever survives. Matches are **groups**, not pairs (ADR-016), supporting 1:1:1, partial, many-to-one (net batches) and one-to-many (split settlements). The full algorithm, including determinism guarantees, blocking strategy and assignment policy, is [docs/matching-engine.md](docs/matching-engine.md).

### 4.4 Exception classification
Eight categories (ADR-011): `DUPLICATE_RECORD`, `AMBIGUOUS_MATCH`, `UNSPLITTABLE_BATCH`, `MISSING_IN_GATEWAY`, `MISSING_IN_BANK`, `MISSING_IN_LEDGER`, `AMOUNT_MISMATCH`, `TIMING_DRIFT`. Exactly one primary category per record, chosen by a fixed precedence order, with every other applicable category recorded in `secondaryFlags`. Every exception carries machine-generated `evidence`: what candidates were considered and the rule-level reason each was rejected. Severity is computed from category **and** absolute money at risk (ADR-044), so the list is triageable rather than merely categorized.

### 4.5 Explain layer
One LLM call per **discrepancy shape**, not per exception (ADR-018). The model receives a decision already made and writes prose about it; it never influences match/no-match, category or severity (ADR-017). If the Anthropic API is absent or failing, the run completes with template explanations. The explain layer is never on the critical path.

### 4.6 Audit trail
Every decision — engine, human and LLM — is **logged immutably**. Immutability is enforced by a database trigger, not a convention (ADR-015), and entries are **hash-chained** so tampering is detectable even by someone who can drop the trigger (ADR-042). Mandatory fields per entry: `event_type`, `subject_type`, `subject_id`, `actor_type`, `actor_id`, `reason`, `occurred_at`. A `reason` reading "processed" is not an audit trail.

### 4.7 Metrics
Engine-computed, per run: match rate (with a stated denominator), tier attribution, exception counts by category and severity, review burden, throughput split into engine-only and wall-clock, LLM cost. Scorer-computed, offline against the answer key: precision, recall, F1, false-positive count, classification confusion matrix, accuracy by difficulty, unresolvable recall, alias precision and leverage. The two sets are stored separately and never merged (ADR-041), because one is the engine's view of itself and the other is a measurement.

### 4.8 Dashboard
Next.js. Landing on a completed run with match rate, false-positive count and cold-start rate visible without interaction (ADR-020). Exception list as the primary screen, with drill-down to evidence, explanation, linked records and the per-record audit trail. Review queue, alias management with lineage, and a run-level audit view. Specified in [docs/ui-spec.md](docs/ui-spec.md).

### 4.9 Validation harness
A synthetic data generator that emits the answer key as a byproduct of generation, and an offline scorer that joins engine output to that key. Two seeds: one to develop against, one held out for the reported numbers (ADR-027). A scale benchmark at 1k/10k/100k records establishing the throughput curve (ADR-045).

### 4.10 The Analyst — the agentic layer

A tool-using agent that runs **strictly after S14** and works the exception queue. Given an exception, it plans, calls read-only tools against the run's real data, observes, continues, and produces a verdict with a cited reasoning chain: a concrete resolution proposal, a confirmation that the exception is genuinely unresolvable, a statement of what external document would be needed, or an admission that it ran out of budget.

Four properties make it defensible rather than decorative:

1. **The agent chooses which questions to ask; deterministic code computes every answer** (ADR-049). It never does arithmetic — to learn whether two records match it calls the same scorer S9 used, and gets the same answer S9 would have got. What is agentic is the strategy; what is deterministic is every fact it reasons over.
2. **The tool registry contains no mutating tool.** The agent is not trusted not to write; it is unable to. Proposals route through the human-confirmation endpoints that already exist (ADR-051), so there are zero new write paths.
3. **A deterministic gate (A3) sits between the agent and the database** (ADR-050): schema validation, plus citation grounding — an id cited but never retrieved by an actual tool call is an id the agent invented, and the verdict is rejected.
4. **It is measured against the same answer key as the engine** (ADR-053), attacking the false-despair rate that `validation-strategy.md` §5.3 already identified as the engine's honest headroom. A resolution proposed for a designed-unresolvable exception is a **build blocker**, not a metric.

It also self-corrects against the engine's own honest dead ends: when S10's bounded subset-sum reports `searchBoundExceeded`, the Analyst can re-run the same search with wider bounds — and *both* outcomes improve the submission, because failing at 2× bounds upgrades the exception from "we gave up" to "we proved it." Full design in [docs/agent-design.md](docs/agent-design.md).

A second loop over the same tools answers natural-language questions about a finished run (ADR-056), which is the track's own "Settlement Q&A agent" example direction.

### 4.11 Human-in-the-loop actions
Approve or reject a flagged match; teach an alias while approving; resolve or dismiss an exception with a reason; **manually create a match** the engine did not propose (ADR-043); accept or decline an Analyst proposal. Every one of these writes to the audit log. This is what makes the exception list actionable rather than a report.

**Agent proposals and manual fixes are excluded from the engine's match rate** (ADR-043, ADR-051). A human fixing something is not the engine matching it, and neither is a language model suggesting it. The accuracy report shows an Engine block and an Analyst block, never a merged figure.

---

## 5. Out of scope

Locked. Not "not yet" — **not in this build**, with the reason recorded so it isn't re-litigated by a later session.

| Excluded | Why |
|---|---|
| **Kubernetes, container orchestration, service mesh, Helm, Dockerfiles we author** | Worth learning, worth zero rubric points here. Deliberately parked as a separate standalone learning project so the interest has a home that isn't this repo. (ADR-005) |
| Fraud / risk scoring | A different product. Reconciliation is about agreement between records, not about the intent behind them. |
| Cash-flow forecasting | Prediction, not reconciliation. |
| Multi-agent frameworks (planner / researcher / critic) | The Analyst is one bounded loop with nine tools and a deterministic validation gate (§4.10). The "critic" role is A3, and A3 is better than a critic because it is code rather than a second non-deterministic component checking the first. |
| An auditor agent reviewing auto-confirmed matches | Genuinely tempting — it would attack precision rather than recall. Rejected because it puts a model in a position to second-guess a finalized engine decision, which is the boundary the whole Analyst design exists to hold. False positives are found by the scorer against ground truth: a measurement, not an opinion. (agent-design §10) |
| Agent-in-the-loop during matching | Violates ADR-017 and makes engine output non-reproducible. The ambiguity guard's value is that it *refuses* to decide; handing that decision to a model destroys exactly what makes it valuable. |
| Agent-tuned tolerances or thresholds | Would make `config_snapshot` a function of model output, destroying reproducibility. The agent may observe that a bound was binding; it may not change a shipped default. |
| Auth, multi-tenancy, user accounts | Reviewer identity is a free-text label. Adding auth would consume days and add nothing the panel is grading. Consequences flagged in [docs/deployment.md](docs/deployment.md) §4. |
| Mobile / responsive-first design | Desktop dashboard. A finance controller reconciles at a desk. |
| Fine-tuning | No training data, no need; the model writes prose, it doesn't classify. |
| CQRS, hexagonal / ports-and-adapters, full DDD layering | Converts every feature into four files on a 13-day solo build. (ADR-003) |
| Live Razorpay APIs, real merchant data | The track asks for synthetic data. Real data would need anonymization review nobody is available to give. |
| Multi-currency / FX | The `currency` column exists; FX rate sourcing does not. |
| OpenAPI / Swagger generation | The API contract is a binding table read by humans. A generated spec adds a build step and catches nothing at this size. (§7) |
| Redis, or any second datastore | Nothing here needs a hot cache; the one expensive operation is cached durably in Postgres. (ADR-002) |
| An ORM | Raw SQL over `pg`, numbered migrations. (ADR-022) |
| WebSockets / SSE | Runs finish in seconds; polling is fewer moving parts in front of a live panel. (ADR-024) |
| Monitoring / APM / error tracking | Platform logs suffice for a 13-day demo. |
| Over-designed UI | Judged on whether a panelist can read the result, not on animation. |

**If a task feels like it needs something on this list, stop and flag it rather than deciding alone.**

---

## 6. Concrete numbers

Architecture that doesn't commit to numbers isn't architecture. Full reasoning for each lives in [docs/schema.md](docs/schema.md) and the ADR log; these are the shipped values.

| Parameter | Value | Source |
|---|---|---|
| Dataset size (demo) | ~300 economic events → ~820 source records | validation-strategy §3 |
| Dataset size (scale benchmark) | 1k / 10k / 100k records | ADR-045 |
| Amount tolerance | `clamp(0.5% × amount, ₹1.00, ₹100.00)` | ADR-008 |
| Gateway fee band (inference) | 2.36 %–2.95 % of gross (2.0–2.5 % fee + 18 % GST) | schema §5.3 |
| Date window, gateway→bank, card/netbanking | `[-1, +3]` days | ADR-009 |
| Date window, gateway→bank, UPI/wallet | `[-1, +2]` days | ADR-009 |
| Date window, gateway→ledger | `[-1, +1]` days | ADR-009 |
| Date window, bank→ledger (anchor-only) | `[-2, +4]` days | ADR-009 / ADR-037 |
| Fuzzy auto-confirm threshold | `≥ 0.85` | ADR-030 |
| Fuzzy review band | `0.65 – 0.849` | ADR-010 |
| Ambiguity guard | top two candidates both `≥ 0.65` and within `0.05` | ADR-010 |
| Near-anchor tolerance | Damerau-Levenshtein `≤ 1` on anchors of length `≥ 12`, corroboration required | ADR-031 |
| Subset-sum bounds (net batch) | pool `≤ 24`, subset size `≤ 8`, 250 ms budget per batch | ADR-038 |
| Designed-unresolvable share | 7 % of events (~21) → published ceiling ≈ 93 % | validation-strategy §4 |
| LLM model | `claude-sonnet-5`, `temperature: 0` | ADR-019 |
| LLM batching | ≤ 10 signatures per request, hard cap 8 calls per run | ADR-018 |
| Poll interval | 750 ms | ADR-024 |
| Max upload size | 10 MB per file | api-contract §0 |
| Analyst investigations per run | 20, deterministically triaged | ADR-054 |
| Analyst steps / tool calls per investigation | 10 / 16, 60 s, 40 k tokens | ADR-054 |
| Analyst cost cap per run | $1.00 | ADR-054 |
| `rerun_subset_search` ceilings | pool ≤ 64, subset ≤ 10, ≤ 2000 ms | ADR-054 |
| Q&A bounds | 6 steps, 8 tool calls, 1024 output tokens | ADR-056 |
| Q&A rate limits | 50 per run, 100 per hour globally | ADR-056 |
| Hallucinated resolutions | **0 — build blocker** | ADR-053 |

**Mandatory per audit entry:** `event_type`, `subject_type`, `subject_id`, `actor_type`, `actor_id`, `reason`, `occurred_at`, `prev_hash`, `entry_hash`.

**LLM prompt design is owned by [docs/schema.md](docs/schema.md) §10**, not by this file, so the prompt sits next to the signature scheme it depends on.

---

## 7. Working practices

**7.1 Docs lead code.** If code and docs disagree, the docs are right until an ADR says otherwise. Fix the doc, add the ADR, then change the code.

**7.2 One ADR log, not a folder of files.** [docs/adr-log.md](docs/adr-log.md) is one append-only file with short dated entries. A folder of per-decision markdown files is ceremony that makes the set harder to read in one sitting, which defeats the purpose. Entries are never edited or deleted; a reversal appends a superseding entry.

**7.3 `docs/what-broke.md` is updated every day.** It is a required submission artifact and cannot be honestly reconstructed on Day 13. An empty day gets an explicit `—`. A missing day is worse than a boring one.

**7.4 Deploy on Day 4, not Day 13.** A live URL early is a strong signal to a panel and removes the single most common last-week failure mode. It also means every subsequent day's work is verified in the environment it will be judged in. See [docs/deployment.md](docs/deployment.md).

**7.5 Never tune against `HOLDOUT_SEED`.** Develop against `DEV_SEED`. Seed-shopping until a good number appears is the exact failure the validation strategy exists to prevent (ADR-027).

**7.6 Run on the full batch, never a subset.** Cherry-picking is the specific thing the track disqualifies. The signature cache (ADR-018) exists partly so that re-running the full batch is free and there is no quiet incentive to avoid it.

---

## 8. Build plan

The build is **13 working days**, Aug 23 → Sep 5. There is no Day for Aug 25 — no session happened, and numbering a day nobody worked would inflate the count.

| Day | Date | Deliverable |
|---|---|---|
| 1 | Aug 23 | Pre-lock decisions (ADR-001…005). **Done.** |
| 2 | Aug 24 | Six design docs plus `CLAUDE.md`. **Done.** |
| — | Aug 25 | No session. |
| 3 | Aug 26 | **Three passes.** Pre-build design review (`ARCHITECTURE.md`, `matching-engine.md`, `ui-spec.md`, `testing-strategy.md`; ADR-028…047) · the Analyst (`agent-design.md`; ADR-048…057) · first five code units: scaffold, migrations 001–010, parsing primitives, the Tier 2 scorer, assignment. **Done.** |
| 4 | Aug 27 | **Deploy to Railway + Vercel — carried from Day 3 and now the first task** (§7.4). Dedupe S4, identity short-circuit S8, batch decomposition S10. |
| 5 | Aug 28 | Generator (`tools/generate`): economic events → projections → three CSVs + answer key + manifest hashes. Unresolvability assertions. |
| 6 | Aug 29 | Ingestion: three parsers wired to the Day 3 primitives, exclusion rules, rejected-row handling. |
| 7 | Aug 30 | Blocking S5, Tier 1 S6, Tier 1.5 alias S7, group assembly S11. |
| 8 | Aug 31 | Classification S12 — precedence, severity, evidence — plus the audit hash chain and the repository layer. |
| 9 | Sep 1 | Routes and run orchestration. **First end-to-end run.** |
| 10 | Sep 2 | Scorer (`tools/score`), score-report endpoint, metrics. **First honest cold-run number.** Scale benchmark. |
| 11 | Sep 3 | Explain layer S13 + signature cache + templates; Analyst loop A1–A4 + grounding gate. Shared Anthropic client and cost caps across both. |
| 12 | Sep 4 | Frontend: dashboard, exception list, drill-down, review queue, alias screen, audit view, Analyst panel, Q&A box. |
| 13 | Sep 5 | Holdout run, accuracy report, README, pitch video, build-challenges write-up, **submit**. |

**Two notes, stated rather than discovered later.**

Day 3 absorbed both the design review and five code units, which puts the engine's highest-risk internals — the scorer, assignment, the parsing primitives — roughly a day ahead of where a linear plan would have them. That is the buffer, and it is already spent on the one thing that slipped: **nothing is deployed**, which §7.4 wanted on Day 4 at the latest.

The first honest accuracy number lands on **Day 10, not Day 12**. That is deliberate: a measured number with two days left to react to it is useful, and the same number on the final day is only a report.

## 9. Submission artifacts

Three things are submitted, and all three are graded:

1. **Public GitHub repo** — code, the six-plus design docs, `what-broke.md`, the generated fixtures and the answer key, and a README linking the live demo above the fold.
2. **5-minute pitch video** — demo path defined in [docs/ui-spec.md](docs/ui-spec.md) §7. The narrative is: here is the honest ceiling, here is what we hit against it, here is what we refused to guess, and here is the audit trail proving it.
3. **Written build-challenges answer** — sourced directly from `what-broke.md`, which is why that file is written daily rather than reconstructed.

The two-block accuracy report (Engine, then Analyst — agent-design §7) is the artifact that answers the track's bar most directly: throughput and measured accuracy from the Engine block, an honest exception list from the Analyst block showing what judgment recovered and what it confirmed could not be recovered.

The accuracy report generated by `tools/score` (validation-strategy §8) is the single most important artifact inside the repo. It is what converts "a number the code printed" into "measured accuracy".

---

## 10. Risks, and what is done about them

| Risk | Mitigation |
|---|---|
| **Frontend compressed into Day 12 (Sep 4).** The largest schedule risk. | The API contract is binding from Day 4, so no design work happens on a build day. If Day 13 overruns, the exception list and metrics panel ship and the alias-management screen degrades to a read-only table — decided in advance, in ui-spec §8. |
| **Pitch video on submission day (Sep 5).** | The holdout run and accuracy report are a single command and can be produced any evening from Day 10; only the video and README genuinely need Sep 5. A rehearsal-quality video recorded on Day 12 is the fallback and is better than none. |
| **The Analyst hallucinates a resolution for a designed-unresolvable exception.** | Treated as a build blocker, not a metric (ADR-053). Three structural defences: a read-only tool registry, the A3 citation-grounding gate (ADR-050), and budget exhaustion returning an honest verdict rather than a best guess (ADR-054). |
| **The Analyst cannot be finished in time.** | It is a strict addition — nothing in the engine depends on it. Degradation order is pre-decided (agent-design §11): investigation on the two highest-value categories ships first, the Q&A agent is cut first. If the whole phase is cut, the engine stands alone and the submission is honest about what it is. |
| **Cold-run match rate lands embarrassingly low.** | It is *reported anyway* (ADR-020, ADR-027). A published ceiling and an honest number below it is the thesis of the project; a suspiciously high number is the failure mode. `false-despair rate` (validation-strategy §5.3) tells us where the headroom is. |
| **Candidate search degrades non-linearly at scale.** | Blocking strategy specified before implementation (ADR-033); scale benchmark at 1k/10k/100k publishes the actual curve (ADR-045). |
| **The engine invents a match that cannot exist.** | The single most damning failure available here. Unresolvable recall is a build-blocker, not a metric (validation-strategy §5.3). Ambiguity guard, contradicted-anchor disqualification, direction gate (ADR-035) and no-anchor auto-confirm impossibility (ADR-030) are the four structural defences. |
| **Anthropic API unavailable during the demo.** | Templates per category; run completes; `llmConfigured` visible on `/api/health`. The explain layer is never on the critical path (ADR-017). |
| **Railway free credit exhausted before Sep 5.** | Render fallback, no architectural change, 45-minute budget. (deployment.md §2) |
| **A later session quietly reverses a decision.** | Append-only ADR log, and `CLAUDE.md` instructs every session to read it first. |
