# Validation & Ground-Truth Strategy

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Day 2 architecture.** Describes the approach. No code here by design.
Companion docs: [schema.md](./schema.md) · [adr-log.md](./adr-log.md) (ADR-021, ADR-027)

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

---

## 3. Scenario distribution

Weights for a ~300-event dataset. These are the shipped defaults; the generator takes them as config so the mix can be tuned without touching logic.

| Scenario | Share | Events | Expected outcome |
|---|---|---|---|
| `CLEAN_3WAY` | 40% | ~120 | `MATCH_3WAY` at exact |
| `TIMING_LAG_NORMAL` | 12% | ~36 | `MATCH_3WAY` at fuzzy (inside window) |
| `FEE_NET_SETTLEMENT` | 10% | ~30 | `MATCH_3WAY` at fuzzy (net-amount rule) |
| `MERCHANT_NAME_VARIANT` | 8% | ~24 | `MATCH_3WAY`, `requiresAlias: true` |
| `REF_MISSING_OR_TYPO` | 6% | ~18 | `MATCH_3WAY` at fuzzy, or exception if too degraded |
| `MISSING_IN_LEDGER` | 5% | ~15 | `EXCEPTION` |
| `MISSING_IN_BANK` | 5% | ~15 | `EXCEPTION` |
| `AMOUNT_TRUE_MISMATCH` | 4% | ~12 | `EXCEPTION` |
| `DUPLICATE_ROW` | 3% | ~9 | `EXCEPTION` |
| **Unresolvable family (§4)** | **7%** | **~21** | `EXCEPTION`, `UNRESOLVABLE` |
| Total | 100% | ~300 | |

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

**Reported match rate** is a separate, simpler figure — `matched_records / reconcilable_records` — and it is exactly what the engine sees. Both ship. Publishing match rate *and* precision/recall side by side is what converts "the number the code printed" into a measurement.

### 5.2 Classification accuracy

For every event the key says should be an exception, is the engine's `category` right? Reported as an 8×8 confusion matrix plus per-category precision/recall.

This catches an entire class of failure that match rate cannot see: an engine that correctly declines to match but files everything as `MISSING_IN_BANK` has a perfect match rate and a useless exception list — and the exception list is arguably the primary thing being judged.

`secondaryFlags` are scored as set overlap (Jaccard) and reported separately, not folded into the primary category score.

### 5.3 Resolvability honesty

Two numbers that speak directly to the "honest exception list" bar:

- **Unresolvable recall** — of the ~21 designed-unresolvable events, how many did the engine correctly leave unmatched? A number below 100% means the engine **invented** a match that cannot exist. That is the single most damning failure available in this project and it should be treated as a build-blocker, not a metric.
- **False-despair rate** — of the events the engine gave up on, how many were actually `RESOLVABLE`? This is the honest measure of the engine's headroom, and the right place to look for the next day's work.

### 5.4 Accuracy by difficulty

Precision/recall sliced by `EASY | MEDIUM | HARD`. A system at 99% on easy and 40% on hard has a different story than one at 85% flat, and the aggregate hides it. Also the fastest way to find what to fix next.

### 5.5 Throughput

Two figures, always labelled, never merged:
- `records_per_sec_engine` — ingest + match + classify. The real engineering number.
- `records_per_sec_wall_clock` — including LLM explain latency. The honest end-to-end number.

Quoting only the first is misleading; quoting only the second measures Anthropic's API, not this engine.

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

A one-page **accuracy report**, generated by the scorer, that the README links and the pitch video shows:

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

Accuracy by difficulty:  EASY 0.99 · MEDIUM 0.91 · HARD 0.62
Throughput: 412 rec/s engine · 96 rec/s wall-clock (incl. LLM)
```

*(Illustrative figures — the shape of the report, not predicted results.)*

Every number there is measured against a key that existed before the engine ran. That is the difference between "measured accuracy" and "a number the code printed," and it is the specific bar the track set.

---

## 9. Flagged / out of scope

- **Hand-labelling real anonymized payment data** — would be stronger evidence, but ARCHITECTURE §5 puts live Razorpay APIs out of scope and the track asks for synthetic data. Not doing it.
- **Cross-validation across many seeds** — statistically nicer, and genuinely tempting. **Flagged as scope creep**: two seeds answer the overfitting objection; ten answer a question nobody asked. If time exists on Day 11, running 3–5 extra seeds for a variance band is the cheapest credibility upgrade available — as a *reporting* addition only, with no tuning against them.
- **Adversarial/property-based test data** — a different discipline from reconciliation accuracy. Out.
- **Scoring the LLM explanations for quality** — would need human judgement or an LLM-as-judge harness. **Flagged as scope creep.** The explanations are narration of deterministic decisions (ADR-017); their accuracy is bounded by the decisions they narrate, which are already scored.
