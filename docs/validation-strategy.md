# Validation & Ground-Truth Strategy

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Locked.** Describes the approach. No code here by design. Revised by the Day 4 design review (ADR-041, ADR-045).
Companion docs: [schema.md](./schema.md) · [matching-engine.md](./matching-engine.md) · [adr-log.md](./adr-log.md) (ADR-021, ADR-027, ADR-041, ADR-045)

---

## 0. The problem this solves

The track's bar:

> "Throughput plus measured accuracy plus an honest exception list. One cherry-picked match proves nothing."

"Measured" is the load-bearing word. A match rate the engine prints about itself is **not** a measurement — it's the engine's opinion of its own work. If the engine wrongly matches payment A to bank credit B, it counts that as a success and the reported match rate goes *up*. A number that increases when the system gets things wrong is worse than no number.

Measurement requires an independent truth to compare against. That truth has to be **manufactured alongside the data**, because no one is going to hand-label 300 synthetic records under a 13-day clock.

---

## 1. Core approach: truth-first generation

**The generator does not create messy files and then figure out what should match. It creates the truth first, and derives the messy files from it.**

Three phases:

### Phase 1 — Generate economic events

An *economic event* is a real thing that happened: "customer paid ₹1,234.50 to Amazon Retail on 14 Aug 2026 by card." It is the ground truth. Each gets a stable `event_id` and a full set of canonical attributes.

Roughly 300 events for a run of 200–500 records (one event fans out into 1–3 source rows).

### Phase 2 — Project each event into source rows

Each event is projected into the three sources according to a **scenario** drawn from a weighted distribution (§3). A scenario decides:
- which sources this event appears in (all three, or two, or one),
- what defects are injected into each projection,
- what the correct engine outcome therefore is.

A clean event projects to three rows that a competent engine will match. A `MISSING_ROW` scenario projects to two, and the *correct* outcome becomes `MISSING_IN_LEDGER` — an exception, not a failure.

### Phase 3 — Emit files and key together

Written in the same pass, from the same in-memory structure:

```
data/fixtures/holdout/gateway_export.csv     ← messy, engine reads these
data/fixtures/holdout/bank_settlement.csv
data/fixtures/holdout/merchant_ledger.csv

data/truth/holdout_seed_90210.json           ← the answer key, engine NEVER reads this
```

**Why this ordering is the whole design:** the answer key is a **byproduct of generation**, not a post-hoc annotation. There is no separate labelling step that could disagree with the data, because the label *is* what the generator decided before it wrote a single row. A hand-labelled key would need its own validation; this one is correct by construction.

### Isolation (ADR-021)

The answer key lives in a **file, in a separate directory, never in the application database**, and no module under `apps/api/src` imports from `data/truth/`. Scoring is a standalone script (`tools/score/`) that reads engine output from the API and the key from disk, and joins them after the fact.

If the key were a table in the same schema, "does any code path read it?" becomes something you have to *audit*. Keeping it structurally outside the app makes leak-freedom obvious to a reader in five seconds. Worth more than any convenience the alternative buys. A one-line CI-style grep asserting no `data/truth` import under `apps/api` makes it enforceable rather than aspirational.

### Determinism

Everything derives from a single **seed** via an explicitly-seeded PRNG — no `Math.random()`, no wall-clock, no `Date.now()` anywhere in the generator. Same seed → byte-identical files and key. A demo cannot silently drift between rehearsal and submission, and "what broke" investigations are reproducible.

---

## 2. Answer key structure

Not a flat list of matched pairs. Three sections, because three different things need scoring.

### 2.1 `events` — expected outcome per economic event

```json
{
  "eventId": "evt_000142",
  "scenario": "AMOUNT_TRUE_MISMATCH",
  "canonical": { "amountPaise": 123450, "date": "2026-08-14", "merchant": "AMAZON RETAIL", "method": "card" },
  "projections": [
    { "sourceSystem": "gateway", "sourceRowNumber": 87,  "defects": ["MERCHANT_NAME_VARIANT"] },
    { "sourceSystem": "bank",    "sourceRowNumber": 61,  "defects": ["AMOUNT_TRUE_MISMATCH","SETTLEMENT_LAG"] },
    { "sourceSystem": "ledger",  "sourceRowNumber": 140, "defects": [] }
  ],
  "expectedOutcome": "EXCEPTION",
  "expectedCategory": "AMOUNT_MISMATCH",
  "expectedSecondaryFlags": ["TIMING_DRIFT"],
  "resolvability": "RESOLVABLE",
  "difficulty": "HARD",
  "requiresAlias": true,
  "notes": "Gateway↔ledger should still match on payment_id; the bank leg is the exception."
}
```

`sourceRowNumber` is the join key back to `transactions.source_row_number`, which is why that column is `NOT NULL` in `schema.md` §3. **The key never contains engine-assigned UUIDs** — it is written before the engine has ever seen the data, so it can only reference file-position identity. That is also what makes it impossible for the key to have been influenced by engine behaviour.

`expectedOutcome` ∈ `MATCH_3WAY | MATCH_2WAY | EXCEPTION | EXCLUDED | NOISE`.
`resolvability` ∈ `RESOLVABLE | UNRESOLVABLE` (§4).
`difficulty` ∈ `EASY | MEDIUM | HARD` — for reporting accuracy sliced by difficulty, so a headline number can't hide a system that only handles clean records.

### 2.2 `expectedPairs` — the matching-level key

Flattened pairwise expectations, because precision/recall is defined over pairs:

```json
{ "eventId": "evt_000142", "a": {"sourceSystem":"gateway","sourceRowNumber":87},
  "b": {"sourceSystem":"ledger","sourceRowNumber":140}, "shouldMatch": true, "viaTier": "exact" }
```

`viaTier` is the *weakest tier that should suffice* — it lets scoring report tier-level correctness ("did the engine match at exact when exact was available, or did it fall through to fuzzy?"). Falling through isn't wrong, but a system that matches everything by fuzzy is more fragile than the same match rate earned at exact, and this makes that visible.

### 2.3 `aliasKey` — the alias-learning key

```json
{ "aliasType": "merchant_name", "variants": ["AMZN","AMAZON RETAIL IN","Amazon Retail India Pvt Ltd"],
  "canonical": "AMAZON RETAIL", "seededForEngine": false, "affectedEventIds": ["evt_000142", "…"] }
```

`seededForEngine: false` marks a held-out variant — one the alias table is **not** pre-populated with, so alias learning can be measured cold (§6).

### 2.4 `manifest`

Seed, generator version, generation timestamp, counts per source, scenario distribution actually realized (not just intended), and a **content hash of each emitted source file**. The scorer refuses to run if a file's hash doesn't match the key's — which makes "we scored against the wrong dataset" structurally impossible rather than a thing you notice too late.

The same hashes are recorded independently by the engine in `runs.input_file_hashes` (`schema.md` §4), and `POST /api/runs/:runId/score-report` rejects a report whose key hash disagrees with them (`422 TRUTH_KEY_MISMATCH`). The check therefore holds from both ends: the scorer will not read the wrong files, and the API will not store a measurement of the wrong run.

---

## 3. Scenario distribution

Weights for a ~300-event dataset. These are the shipped defaults; the generator takes them as config so the mix can be tuned without touching logic.

| Scenario | Share | Events | Expected outcome |
|---|---|---|---|
| `CLEAN_3WAY` | 36% | ~108 | `MATCH_3WAY` at exact |
| `TIMING_LAG_NORMAL` | 10% | ~30 | `MATCH_3WAY` at fuzzy (inside window) |
| `FEE_NET_SETTLEMENT` | 10% | ~30 | `MATCH_3WAY` at fuzzy (net-amount rule) |
| `MERCHANT_NAME_VARIANT` | 8% | ~24 | `MATCH_3WAY`, `requiresAlias: true` |
| `REF_MISSING_OR_TYPO` | 6% | ~18 | `MATCH_3WAY` at fuzzy, or exception if too degraded |
| `MISSING_IN_LEDGER` | 5% | ~15 | `EXCEPTION` |
| `MISSING_IN_BANK` | 5% | ~15 | `EXCEPTION` |
| `AMOUNT_TRUE_MISMATCH` | 4% | ~12 | `EXCEPTION` |
| `DUPLICATE_ROW` | 3% | ~9 | `EXCEPTION` |
| `SPLIT_SETTLEMENT` | 3% | ~9 | `MATCH_3WAY`, `one_to_many` |
| `REFUND_REVERSAL` | 3% | ~9 | `MATCH_3WAY`, direction `debit` |
| **Unresolvable family (§4)** | **7%** | **~21** | `EXCEPTION`, `UNRESOLVABLE` |
| Total | 100% | ~300 | |

`CLEAN_3WAY` drops from 40 % to 36 % and `TIMING_LAG_NORMAL` from 12 % to 10 % to make room for two scenarios added by the Day 4 review:

- **`SPLIT_SETTLEMENT`** — one gateway payment settled across 2–4 bank credits. `matches.cardinality` already had `one_to_many` and nothing exercised it. It is the mirror of the net-batch case, it is *resolvable*, and a dataset that contains only the unresolvable half of that pair would make the engine look worse than it is.
- **`REFUND_REVERSAL`** — a `refunded` gateway row with a matching bank **debit**. This exercises the direction gate (ADR-035). Without it, `direction` is never tested by the data, and the guard that prevents a capture matching a chargeback would ship unverified. A defence nothing in the dataset tests is a defence you do not know you have.

**A generator constraint the classifier depends on (ADR-034).** `DUPLICATE_ROW` events must emit their duplicate copy carrying the **same strong anchor** as the original. Duplicates are detected by anchor evidence, never by amount+date+counterparty similarity — because the `IDENTITY_DESTROYED` family deliberately plants 3+ same-amount, same-day, same-merchant anchorless rows, and a similarity-based duplicate rule would classify the dataset's hardest designed case as duplicates. The two scenarios must stay distinguishable by construction, and this is the constraint that keeps them so.

**A second generator constraint (ADR-037).** For every event that is not `AMOUNT_TRUE_MISMATCH`, the ledger projection must satisfy `net_amount == gateway.amount` exactly. Gateway amount is what the customer was charged, which is the ledger *net* (after discount, including sale GST) — not the ledger gross. If the generator emits gross-equals-gateway instead, every discounted sale becomes a false `AMOUNT_MISMATCH` and the exception list fills with arithmetic artifacts.

Plus **noise rows outside the event model**: ~25 `failed`/`authorized` gateway rows and ~12 `draft`/`void` ledger rows, keyed as `EXCLUDED`. They exist to verify the engine *filters* rather than *fails* on them — a record that should never have been reconciled must not appear in the exception list. Counting them as exceptions would inflate the exception count dishonestly, and the key catches that.

The realized distribution goes into the manifest, because with a seeded PRNG the actual counts drift a little from the targets and the reported figures must reflect what was actually generated.

---

## 4. Genuinely unresolvable exceptions — **7%, ~21 of 300**

### The number and why

**7% of events are designed to be genuinely unresolvable from the data provided** — not merely hard, not solvable-with-better-tolerances, but impossible for *any* correct engine, and impossible for a competent human analyst looking at the same three files.

Reasoning for 7% specifically:

- **Real reconciliation shops run 2–5% hard-fail** on a mature process. A demo dataset at 2% risks landing at zero or one unresolvable case after PRNG variance, which proves nothing.
- **Too low looks cherry-picked.** An exception list that resolves cleanly to zero on inspection invites exactly the suspicion the track is guarding against. An engine that never admits defeat is a red flag to anyone who has actually done reconciliation work.
- **Too high looks broken.** At 15–20%, a panelist reasonably concludes the engine is weak rather than the data being hard, and the unresolvable set stops reading as deliberate design.
- **7% ≈ 21 events** — large enough to be statistically real and to break down into three sub-classes with meaningful counts each; small enough that the honest match-rate ceiling stays high enough to be a good result.

The critical consequence, stated plainly in the README and the pitch: **the theoretical maximum match rate on this dataset is ~93%, and that ceiling is published up front.** An engine reporting 91% against a known 93% ceiling is a far stronger claim than one reporting 91% against an unstated ceiling of 100%. It also means anyone reporting 97% on this dataset is reporting false positives — the ceiling itself is a fraud detector.

### The three unresolvable sub-classes

| Sub-class | Share of the 21 | Count | What makes it genuinely impossible |
|---|---|---|---|
| `IDENTITY_DESTROYED` | ~40% | ~8 | Every reference anchor is absent from every source (`REF_MISSING` on all projections, `DESC_TRUNCATED` cutting the RRN), **and** the generator plants 3+ same-amount, same-day, same-merchant candidates. No information distinguishes them. Expected: `AMBIGUOUS_MATCH`. |
| `ORPHAN_NO_COUNTERPART` | ~30% | ~6 | A bank row with no economic event behind it at all — a chargeback reversal, a fee debit, an unrelated inbound transfer. There is nothing to match it to, anywhere. Expected: `MISSING_IN_GATEWAY`. |
| `UNSPLITTABLE_NET_BATCH` | ~30% | ~7 | One bank `SETTLEMENT` credit nets N gateway payments minus fees, **with no breakup file provided**, and the generator verifies no subset of available payments sums to the credit within tolerance. Decomposition is mathematically impossible from the inputs. Expected: `UNSPLITTABLE_BATCH`. |

Each of the three fails for a **structurally different reason** — ambiguity, absence, and aggregation. Three ways to be unresolvable is a better demonstration of thinking than twenty-one instances of one.

### The verification that makes the claim real

The generator does not merely *label* these unresolvable. It **proves** it during generation:

- For `IDENTITY_DESTROYED`: assert that after normalization, ≥3 candidate rows are byte-identical on every field the matcher can see. If the assertion fails, regenerate that event. Unresolvability that only holds because the matcher is weak is not unresolvability.
- For `UNSPLITTABLE_NET_BATCH`: run an actual subset-sum check over the candidate payment pool against the credit amount ± tolerance. If a valid subset exists, regenerate.
- For `ORPHAN_NO_COUNTERPART`: assert no event references the row.

Without those assertions, "genuinely unresolvable" is a claim; with them it is a property of the dataset, and it survives a sceptical panelist asking "how do you know?"

---

## 5. Scoring — precision, recall, F1

Run offline by `tools/score/`, after a run completes, joining engine output (via the API) to the key (from disk) on `(sourceSystem, sourceRowNumber)`.

### 5.1 Matching accuracy — the primary metric

Over **pairs**, not records, because a match is a claim about a relationship.

| Term | Definition |
|---|---|
| **TP** | Engine proposed a pair that `expectedPairs` says should match. |
| **FP** | Engine proposed a pair the key says should **not** match. **A wrong match.** |
| **FN** | Key says a pair should match; the engine did not propose it. **A missed match.** |
| **TN** | Not counted — the non-matching pair space is O(n²) and meaningless. |

```
Precision = TP / (TP + FP)      "of what the engine claimed, how much was right"
Recall    = TP / (TP + FN)      "of what was there to find, how much did it find"
F1        = 2PR / (P + R)
```

**Precision is the metric that matters most here, and it is the one the engine's own match rate cannot see.** A finance controller can work with a missed match — it sits in the exception list and a human picks it up. A wrong match is a wrong book, silently. FP count is reported as a raw integer alongside every percentage (ADR-020), because "3 wrong matches" lands with a finance audience in a way "precision 0.988" does not.

**Reported match rate** is a separate, simpler figure and it is exactly what the engine sees. Its denominator is fixed by ADR-040 and restated here so the scorer and the engine cannot drift apart:

```
reconcilable = ingested − excluded − rejected_rows − non_primary_duplicates
matched      = records in ≥1 match with status auto_confirmed OR human_confirmed
```

Both ship. Publishing match rate *and* precision/recall side by side is what converts "the number the code printed" into a measurement.

### 5.1.1 How `pending_review` pairs are scored (ADR-040)

A proposal is not a claim, and scoring it as one would be wrong in either direction — counting a pending pair as a match inflates recall with work no human has done; counting it as a miss punishes the engine for correctly asking.

**Primary precision/recall count `auto_confirmed` and `human_confirmed` pairs only.** Pending pairs are scored separately and reported as a third figure:

```
review_queue_precision = correct pending proposals / all pending proposals
```

That number answers the question the review queue actually raises: *when this engine asks a human, is it asking about the right things?* A queue at 0.9 precision is a useful assistant; a queue at 0.4 is noise that costs more attention than it saves. It is also the number that justifies the review band existing at all, and it would be invisible if pending pairs were folded into either bucket.

### 5.2 Classification accuracy

For every event the key says should be an exception, is the engine's `category` right? Reported as an 8×8 confusion matrix plus per-category precision/recall.

This catches an entire class of failure that match rate cannot see: an engine that correctly declines to match but files everything as `MISSING_IN_BANK` has a perfect match rate and a useless exception list — and the exception list is arguably the primary thing being judged.

`secondaryFlags` are scored as set overlap (Jaccard) and reported separately, not folded into the primary category score.

**Two confusion-matrix cells to watch specifically**, both of which the Day 4 review showed were previously unreachable and are now the load-bearing output of stage S8 (ADR-029):

- `AMOUNT_MISMATCH` predicted as a `pending_review` match — the old failure mode, where identity was established but the pair was scored instead of decided.
- `TIMING_DRIFT` predicted as `auto_confirmed` — the worse old failure mode, where a nine-day-late settlement scored exactly 0.85 and auto-matched silently.

If either cell is non-zero, S8 is not running where it should be. They are worth an explicit assertion in the scorer rather than a reading of the matrix.

### 5.3 Resolvability honesty

Two numbers that speak directly to the "honest exception list" bar:

- **Unresolvable recall** — of the ~21 designed-unresolvable events, how many did the engine correctly leave unmatched? A number below 100% means the engine **invented** a match that cannot exist. That is the single most damning failure available in this project and it should be treated as a build-blocker, not a metric.
- **False-despair rate** — of the events the engine gave up on, how many were actually `RESOLVABLE`? This is the honest measure of the engine's headroom, and the right place to look for the next day's work.
- **Bound-honesty check** — of the `UNSPLITTABLE_BATCH` exceptions, how many claim `searchExhausted` versus `searchBoundExceeded` (ADR-038)? A run where every batch reports `searchBoundExceeded` has not proved anything about the data; it has proved its own bounds are too tight. The scorer reports the split, and the accuracy report prints it, because "I proved no combination works" and "I gave up after 250 ms" are different claims and only one of them is a finding.

### 5.4 Accuracy by difficulty

Precision/recall sliced by `EASY | MEDIUM | HARD`. A system at 99% on easy and 40% on hard has a different story than one at 85% flat, and the aggregate hides it. Also the fastest way to find what to fix next.

### 5.5 Throughput — two figures and a curve

Two figures, always labelled, never merged:
- `records_per_sec_engine` — ingest + match + classify. The real engineering number.
- `records_per_sec_wall_clock` — including LLM explain latency. The honest end-to-end number.

Quoting only the first is misleading; quoting only the second measures Anthropic's API, not this engine.

### 5.6 The scale benchmark (ADR-045)

Throughput is one of three judged axes, and a single figure measured on ~820 records mostly advertises how small the dataset is. The generator is already parameterized by event count, so the scorer publishes a curve:

| Records | Events | What is reported |
|---|---|---|
| ~820 | 300 | The demo dataset. Full accuracy scoring. |
| ~2,700 | 1,000 | Timing only. |
| ~27,000 | 10,000 | Timing only. |
| ~270,000 | 100,000 | Timing only, plus candidate-cap-hit rate. |

Reported at each size: wall-clock, `records_per_sec_engine`, the per-stage `stage_ms` breakdown from `runs.metrics`, mean and p95 candidate-pool size, and the LLM call count.

**What the curve is meant to demonstrate**, and what it would expose if the design were wrong:

1. **The candidate search is `O(n × k)`, not `O(n²)`.** Blocking (ADR-033) is the claim; the curve is the evidence. A quadratic curve here would falsify it in one glance, which is exactly why the benchmark is worth running rather than asserting.
2. **LLM calls stay roughly flat as records grow 100×.** Because explanations are cached by discrepancy *shape* (ADR-018), a 100k-record run has more exceptions but barely more distinct shapes. That is the most interesting scaling property in the system and it is invisible at demo size.
3. **Where the time actually goes.** `stage_ms` at 100k names the real bottleneck instead of leaving it to speculation.

Accuracy is **not** scored at the larger sizes: the answer key generation is fast, but the point of the benchmark is the performance curve, and scoring 270k records adds runtime without adding a claim. The demo-size run remains the only one whose accuracy is reported, and it is the one generated from `HOLDOUT_SEED`.

---

## 5.7 Measuring the Analyst (ADR-053)

Phase A is scored against **the same answer key as the engine**, which it cannot read (ADR-021 unchanged, still enforced by the import grep in `testing-strategy.md` §3). This section exists because an agent layer that is not measured is decoration, and this project does not ship unmeasured numbers.

**The metric the Analyst exists to attack is already defined in §5.3:** false-despair rate — of the events the engine gave up on, how many were actually `RESOLVABLE`. That was described as *"the honest measure of the engine's headroom, and the right place to look for the next day's work."* The Analyst is that next day's work, and the false-despair set is precisely its addressable market.

| Metric | Definition |
|---|---|
| **False-despair recovered** | Of the engine's false-despair exceptions, how many did the Analyst propose a resolution for that the key confirms? **The headline agent number.** |
| **Proposal precision** | Of all `RESOLUTION_PROPOSED` verdicts, how many the key confirms. Reported as a raw fraction (`16/18`), never as a rounded percentage. |
| **Hallucinated resolutions** | Proposals on events the key marks `UNRESOLVABLE`. **Must be 0 — build blocker, not a metric.** |
| **Unresolvable agreement** | Of designed-`UNRESOLVABLE` exceptions investigated, how many returned `CONFIRMED_UNRESOLVABLE`. |
| **Grounding failure rate** | Verdicts rejected by the A3 gate for citing evidence never retrieved. |

**Why hallucination is a build blocker.** The ~21 designed-unresolvable events are impossible for any correct engine *and any competent human analyst looking at the same three files* — verified by assertion during generation (§4), not merely labelled. A resolution proposed for one of them means the agent invented evidence. That is strictly worse than the engine's silence, because it arrives wrapped in a confident, cited-looking reasoning chain. It is treated exactly as unresolvable recall is in §5.3: something that stops the build.

**The Analyst is never told which exceptions are designed-unresolvable.** A1 triage selects on severity and amount alone. It investigates them like anything else, and is expected to conclude that they cannot be resolved — which is what makes `unresolvable agreement` a real test rather than a formality.

**Reported separately, always.** Agent proposals never enter the engine's match rate, before or after human confirmation (ADR-051). The accuracy report carries an Engine block and an Analyst block. This is the fourth paired-figure discipline in the project, after cold/warm (ADR-020), engine/manual (ADR-043) and self-reported/measured (ADR-041) — consistent rather than novel.

---

## 6. Measuring alias learning honestly

The alias feature creates a specific temptation: run the dataset, correct a few things, re-run, and report the improved match rate as *the* match rate. That would be reporting a warm-cache number as a cold one.

**The protocol, which is a scoring rule, not a suggestion:**

1. **Cold run** — `aliasLearningEnabled: false`, empty alias table. Score it. **This is the headline match rate.**
2. **Correction pass** — a human works the review queue on the cold run's output, creating aliases. Record how many corrections (`humanCorrectionsToDate`).
3. **Warm run** — same dataset, same seed, aliases active. Score it identically.
4. Report **both**, labelled, always together (ADR-020).

The interesting figure is the delta and its leverage:

```
leverage_ratio = records_auto_resolved_by_aliases / human_corrections_made
```

"9 corrections auto-resolved 27 records — 3.0× leverage" is a concrete, checkable claim about a learning system. "Our match rate improved to 89%" is not.

**Alias precision guards the loop:** of the matches made at the alias tier, how many does the key confirm? This must stay at 1.0. If alias learning ever *creates* false positives, the feature is producing wrong books faster than a human could — and the metric that catches it is alias precision, not match rate, which would happily go up.

**Held-out variants:** the `aliasKey` marks some merchant-name variants `seededForEngine: false`. Those never get pre-populated, so the cold run genuinely has to fail on them and the correction pass genuinely has to teach them. Without held-out variants the whole learning demonstration is circular.

---

## 7. Two seeds, and why (ADR-027)

| Seed | Purpose | Rule |
|---|---|---|
| `DEV_SEED` (1337) | Everyday development. Tune tolerances, debug the classifier, iterate freely. | Tune against this all you like. |
| `HOLDOUT_SEED` (90210) | The final reported numbers, the dashboard's demo run, the pitch video. | **Generated fresh and never tuned against.** Look at its output once, when reporting. |

Tuning tolerances against the same dataset you report on is overfitting, and the reported accuracy stops being a measurement of anything. A held-out seed makes the final number an actual out-of-sample result.

**Practically:** if the held-out run comes in materially worse than the dev run, that is *information*, and the honest move is to say so in the "what broke" log — not to regenerate seeds until a good one appears. Seed-shopping is the exact failure mode this whole document exists to prevent, and it would be invisible in the final artifact, which is what makes committing to the rule now (rather than on Day 12, under pressure) the point.

---

## 8. What this produces for the submission

A one-page **accuracy report**, generated by the scorer, that the README links and the pitch video shows. The same measurement is posted to `POST /api/runs/:runId/score-report` and stored in `score_reports` (ADR-041), so the dashboard renders the identical numbers rather than a second, separately-computed set that could quietly disagree.

```
Dataset: holdout_seed_90210 · 300 events → 823 reconcilable records
Theoretical ceiling:      93.0%   (21 events unresolvable by design)

COLD RUN (no learned aliases)
  Match rate            74.1%
  Precision  0.994   Recall  0.812   F1  0.894
  False positive matches: 2
  Exceptions: 65    Correctly identified as unresolvable: 21/21

WARM RUN (9 human corrections → 9 aliases)
  Match rate            82.4%   (+8.3pp)
  Precision  0.988   Recall  0.901   F1  0.943
  False positive matches: 5
  Alias precision: 1.00   Leverage: 3.0× (27 records / 9 corrections)

ANALYST (agentic, measured against the same key)
  Investigated 20 of 47 eligible exceptions
  False-despair recovered   14 / 22
  Proposal precision        16 / 18
  Hallucinated resolutions  0          ← build blocker if non-zero
  Unresolvable agreement    6 / 6
  Mean 6.2 steps · 8.4 tool calls · $0.03 per investigation

Accuracy by difficulty:  EASY 0.99 · MEDIUM 0.91 · HARD 0.62
Review queue precision:  0.91  (11 proposals, 10 correct)
Unsplittable batches:    5 proved exhaustively · 2 hit the search bound
Throughput: 412 rec/s engine · 96 rec/s wall-clock (incl. LLM)

SCALE BENCHMARK (timing only, no accuracy scoring)
  ~2.7k rec    0.9 s    3,000 rec/s   ·  LLM calls: 3
  ~27k rec     7.4 s    3,650 rec/s   ·  LLM calls: 4
  ~270k rec   82.1 s    3,290 rec/s   ·  LLM calls: 5
```

*(Illustrative figures — the shape of the report, not predicted results.)*

Every number there is measured against a key that existed before the engine ran. That is the difference between "measured accuracy" and "a number the code printed," and it is the specific bar the track set.

---

## 9. Flagged / out of scope

- **Hand-labelling real anonymized payment data** — would be stronger evidence, but ARCHITECTURE §5 puts live Razorpay APIs out of scope and the track asks for synthetic data. Not doing it.
- **Cross-validation across many seeds** — statistically nicer, and genuinely tempting. **Flagged as scope creep**: two seeds answer the overfitting objection; ten answer a question nobody asked. If time exists on Day 11, running 3–5 extra seeds for a variance band is the cheapest credibility upgrade available — as a *reporting* addition only, with no tuning against them.
- **Accuracy scoring at benchmark scale** — the 10k/100k runs report timing only (§5.6). Scoring them would add runtime without adding a claim: the accuracy question is answered by the holdout run, and the throughput question is what the larger sizes exist to answer. Deliberate, not an omission.
- **Adversarial/property-based test data** — a different discipline from reconciliation accuracy. Out.
- **Scoring the LLM explanations for quality** — would need human judgement or an LLM-as-judge harness. **Flagged as scope creep.** The explanations are narration of deterministic decisions (ADR-017); their accuracy is bounded by the decisions they narrate, which are already scored.
