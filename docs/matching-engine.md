# Matching Engine

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Day 3 design review — locked.** Authored because `schema.md` defined the *shapes* and *tolerances* of matching but never the *algorithm*.
Companion docs: [schema.md](./schema.md) · [adr-log.md](./adr-log.md) (ADR-028…ADR-039) · [validation-strategy.md](./validation-strategy.md)

`schema.md` owns tables, tolerances and the exception taxonomy. **This doc owns execution**: what runs in what order, how candidates are generated, how a winner is chosen, how pairs become groups, and what guarantees the whole thing is reproducible.

Everything here exists to serve one property: **the same input produces the same output, and the reason for every output is recordable.** An engine whose result depends on row ordering cannot claim measured accuracy, because the measurement wouldn't be repeatable.

---

## 0. Why this doc exists — the gap it closes

The Day 2 design specified a scoring function and a set of tiers. It did not specify:

- what order records are processed in (and therefore whether the result is deterministic at all);
- what happens when two records compete for the same counterpart;
- how pairwise comparisons become the 3-way *groups* the schema models;
- how the candidate pool is bounded (the O(n²) question, which is the throughput question);
- when duplicate detection runs relative to matching;
- how a net-settlement batch is actually decomposed before being declared unsplittable.

Each of those is a place where a plausible implementation silently produces a different accuracy number. They are decided here.

---

## 1. Execution order

A run executes these stages in strict sequence. Each stage is fully complete before the next begins — no interleaving, no streaming between stages. At ~820 records the entire pipeline is in-memory, and staging it this way is what makes each stage independently testable and independently timed.

```
S0  LOAD          read the three files, hash them, record the reference date
S1  PARSE         per-source parsers → raw field extraction, rejected-row capture
S2  NORMALIZE     paise, IST business date, counterparty_norm, anchor extraction
S3  EXCLUDE       non-reconcilable statuses removed from the matching population
S4  DEDUPE        same-source duplicate detection; elect a primary per cluster
S5  BLOCK         build candidate-generation indexes
S6  TIER 1        exact, on unmodified values
S7  TIER 1.5      alias substitution, re-run the identical Tier 1 predicate
S8  IDENTITY      strong-anchor-agreement short-circuit → deterministic value/time verdict
S9  TIER 2        fuzzy scoring over the remaining pool, global assignment
S10 BATCH         bounded subset-sum decomposition for unmatched bank settlements
S11 GROUP         assemble confirmed pairs into match groups
S12 CLASSIFY      Tier 3 — exception classification and severity
S13 EXPLAIN       LLM/template narration (off the critical path)
S14 METRICS       engine-computed metrics, run finalization
```

`S8` is new in this revision and is the fix for a structural flaw described in §6.

### 1.1 The reference date (ADR-039)

Several rules ask "has the settlement window elapsed?" — most importantly `MISSING_IN_BANK`, which is only a real exception once a payment is *overdue*. Answering that against the wall clock makes the engine's output depend on **when it is run**: the same dataset scored in August and in September produces different exception counts, and the reported numbers drift between rehearsal and submission.

```
run_reference_date = MAX(txn_date) across all ingested records, before exclusion
```

It is computed at S0, written into `runs.reference_date` and into `config_snapshot`, and every "is it overdue" test uses it. Wall-clock time is never read by matching or classification logic — only for `occurred_at` timestamps and throughput measurement.

### 1.2 Determinism guarantees (ADR-032)

Four rules, and they hold for every stage:

1. **Every query that feeds a decision carries an explicit `ORDER BY`.** Postgres row order without one is not merely unspecified, it changes with plan choice and physical layout. The canonical sort key throughout is `(source_system, source_row_number)` — file-position identity, which is also the join key the answer key uses.
2. **No `Math.random()`, no `Date.now()`, no `Set`/`Map` iteration order dependence** in any decision path. Where set iteration is unavoidable, the collection is sorted into an array first.
3. **Ties are broken by an explicit, stated rule**, never by "whichever came first". The universal tie-break is: lower `(source_system, source_row_number)` wins, with `source_system` ordered `gateway < bank < ledger`.
4. **Floating-point scores are rounded to 4 decimal places before comparison.** Score components are computed in double precision, then `Math.round(x * 10000) / 10000`. Comparing raw doubles makes threshold behaviour depend on operation order; the ambiguity guard's `0.05` band in particular must not hinge on the fifteenth decimal place.

A run's output is therefore a pure function of `(input files, config_snapshot, active alias set)`. That triple is fully captured in `config_snapshot` plus `runs.input_file_hashes`, which is what makes a result reproducible by a sceptic.

---

## 2. S4 — Same-source deduplication

**Runs before matching, not after** (ADR-034). This ordering is forced by the classification precedence in `schema.md` §8.2: `DUPLICATE_RECORD` is precedence #1 because a duplicate changes the *cardinality* of the problem. If deduplication ran after matching, the second copy of a payment would compete for the same bank credit, lose, and be reported as `MISSING_IN_BANK` — inventing a missing bank record that never should have existed.

### 2.1 What counts as a duplicate — evidence required

The Day 2 rule was "same strong anchor, **or** same amount+date+counterparty within the same source." The second half of that rule is wrong, and it collides directly with the dataset's own design:

> The `IDENTITY_DESTROYED` unresolvable class (validation-strategy §4) deliberately plants **3+ same-amount, same-day, same-merchant rows with no anchors** in a single source. Under "amount+date+counterparty ⇒ duplicate", those rows classify as duplicates of each other — when the correct answer is `AMBIGUOUS_MATCH`. The generator's hardest designed case would be systematically misclassified by the classifier's first rule.

It is also simply false in the real world: two genuine ₹499 subscription payments to the same merchant on the same day are ordinary, not a defect.

**Revised rule — duplicates require anchor evidence:**

| Sub-type | Condition | Disposition |
|---|---|---|
| `EXACT_DUPLICATE` | Two rows in the same source share an identical **strong** anchor (`payment_id`, `settlement_id`, well-formed `rrn`, `entry_id`, `utr`). | Deterministic. Non-primary copies excluded from matching, `DUPLICATE_RECORD` raised, severity `high`. |
| `SUSPECTED_DUPLICATE` | Two rows in the same source share amount + business date + `counterparty_key` **and** both have `anchor_strength = 'none'` **and** the cluster size is exactly 2. | Not deterministic. Raised as `DUPLICATE_RECORD` with severity `medium`, **both copies stay in the matching pool**, and the exception carries `requiresHumanConfirmation: true`. |
| Not a duplicate | Cluster size ≥ 3 with no anchors, or any distinguishing anchor present on either row. | Left alone. These are the `IDENTITY_DESTROYED` candidates and belong to `AMBIGUOUS_MATCH`. |

The cluster-size-2 restriction on `SUSPECTED_DUPLICATE` is the specific guard that keeps the two rules from colliding: a pair looks like a retry artifact, a crowd looks like ambiguity.

### 2.2 Primary election

Within an `EXACT_DUPLICATE` cluster, the **primary** is the row with the lowest `source_row_number`. It stays in the matching pool. Every other member gets `duplicate_of_transaction_id` set to the primary and is removed from the pool.

The non-primary copies **do not** receive `MISSING_IN_BANK` or any other presence flag. `schema.md` §8.2's worked example previously said otherwise; it is corrected. A duplicate copy is not missing from the bank — it never existed as an economic event, and reporting a missing counterpart for it is exactly the "one honest exception becomes five misleading ones" failure that the precedence order exists to prevent.

Audit: `RECORD_DEDUPLICATED` per non-primary, with the primary's id and the shared anchor in `details`.

---

## 3. S5 — Blocking: bounding the candidate search (ADR-033)

This is the throughput answer, and it is an engineering answer rather than a number.

A naive Tier 2 compares every unmatched record against every unmatched record in the other two sources. At 820 records that is ~340k comparisons — fast, and therefore easy to leave unexamined. At the 100k-record scale benchmark it is ~5 billion, which does not complete. **Throughput is one of three judged axes; "it's fast on 820 records" is not a throughput claim.**

Candidates are therefore never generated by a full scan. Four block indexes are built once per run, in memory, at S5:

| Index | Key | Serves |
|---|---|---|
| `byStrongAnchor` | `(anchor_type, anchor_value)` → rows | Tier 1, Tier 1.5, S8 identity resolution. O(1) lookup. |
| `byAnchorPrefix` | first 6 chars of each strong anchor → rows | Near-anchor (typo) candidates, ADR-031. Bounds edit-distance work to a small bucket. |
| `byDateAmount` | `(business_date, amount_bucket)` → rows | Tier 2 primary candidate source. `amount_bucket = floor(amount_paise / 100_000)` (₹1,000 buckets). |
| `byCounterparty` | `counterparty_key` (post-alias) → rows | Tier 2 secondary source; catches amount-divergent, name-agreeing pairs. |

**Tier 2 candidate generation for record `r`** is the union of:

1. `byDateAmount` over every date in `r`'s applicable window × the amount buckets spanned by `[r.amount − tolerance − feeBand, r.amount + tolerance]`. The fee band widens the bucket span for gateway↔bank only.
2. `byCounterparty[r.counterparty_key]` intersected with `r`'s date window.
3. `byAnchorPrefix` buckets for any anchor `r` carries.

The union is deduplicated, sorted by `(source_system, source_row_number)`, and **hard-capped at 200 candidates**. If the cap binds, the record's `evidence.candidateCapHit` is set to `true` and that fact is surfaced in the UI and in the audit entry — a bounded search that silently truncates is a dishonest search. In practice the cap binds only on the `IDENTITY_DESTROYED` cases and on the 100k benchmark, which is exactly where a reader should know about it.

**Complexity:** `O(n × k)` where `k` is the mean block occupancy, rather than `O(n²)`. `k` grows with dataset density, not dataset size, so the curve is close to linear over the benchmark range. The measured curve is published (ADR-045) rather than asserted.

---

## 4. S6 — Tier 1, exact

### 4.1 The predicate

A Tier 1 match between records `a` and `b` requires **all** of:

1. **Anchor identity** — `a` and `b` share at least one equal **strong** anchor, from a structured field on both sides (never from `extracted_from_description`).
2. **Direction agreement** — `a.direction === b.direction` (ADR-035). A credit never matches a debit, at any tier. This is a hard gate, not a scored component: matching a ₹5,000 capture to a ₹5,000 chargeback debit would be a wrong book with a perfect-looking anchor.
3. **Currency agreement** — always true in v1, checked anyway.
4. **Amount agreement**, using the comparison basis for that source pair (§4.2).
5. **Date agreement**, within the window for that source pair from `schema.md` §5.2.

### 4.2 Correction: Tier 1 uses the real windows and the real amount basis (ADR-028)

The Day 2 doc described Tier 1 as "strong anchor + amount equal + date within `[-1,+1]`". Both halves were wrong for the gateway↔bank pair, and the consequences were significant:

- **Date.** `schema.md` §5.2 sets gateway→bank at `[-1,+3]` for card. A perfectly-anchored card settlement at T+2 — the *single most common case in the dataset* — would fail Tier 1's `[-1,+1]`, fall through to Tier 2, and be scored as a fuzzy inference. Tier attribution would show the engine's strongest evidence class as fuzzy guesswork, and the audit trail would say "matched at 0.87 confidence" about a byte-exact reference-number identity.
- **Amount.** Gateway `amount` is gross; bank `credit_amount` is net of a 2.36–2.95 % fee. They are *never* equal on a fee-bearing payment. "Amount equal" would fail on essentially every gateway↔bank pair.

Tier 1 therefore uses the §5.2 window for the pair being compared, and the §4.3 comparison basis. **Tier 1 means "identity is certain and everything corroborates", not "the numbers are byte-identical".**

### 4.3 Comparison basis per source pair (ADR-037)

Which amount is compared to which is a modelling decision, and getting it wrong produces confidently wrong matches. The Day 2 doc specified gateway↔bank correctly and specified gateway↔ledger **incorrectly**.

| Pair | Compare | Why |
|---|---|---|
| gateway ↔ bank | `gateway.net_amount_paise` vs `bank.credit_amount`, or the inferred fee band when gateway net is NULL (`schema.md` §5.3) | The bank credits net of fees. |
| gateway ↔ ledger | `gateway.amount_paise` vs **`ledger.net_amount_paise`** | Both are *what the customer was charged*. |
| bank ↔ ledger | **Anchor only. Amounts are not a matching basis.** | Bank is net-of-gateway-fee; ledger is a sale amount including sale GST. No arithmetic relates them without the gateway row. |

**The gateway↔ledger correction.** `schema.md` §2.3 defines `ledger.net_amount = gross − discount + tax` and separately asserts `ledger.gross_amount` "should equal gateway `amount`". Both cannot hold: whenever `discount` or `tax_amount` is non-zero, gateway amount equals ledger **net**, not ledger gross — the customer pays the discounted price plus sale GST. Comparing gross would make every discounted or taxed sale an `AMOUNT_MISMATCH`, flooding the exception list with arithmetic artifacts and destroying the honesty of the category that matters most. The generator is correspondingly constrained: for a clean event, `ledger.net_amount == gateway.amount` exactly; `AMOUNT_TRUE_MISMATCH` is what deliberately breaks it.

**The bank↔ledger correction.** §5.2 defines a `[-2,+4]` bank→ledger window, implying such pairs get formed. They may — but only on a shared anchor (an `invoice_no` or a `settlement_id` appearing in both), never on amount+date, and always at Tier 2 with the amount component scored **0 and marked unavailable** rather than scored against an incomparable quantity, and **not renormalized** (ADR-064). That caps a bank↔ledger pair's score at anchor + date + counterparty — `0.65` at strong↔weak (exactly the review floor) or `0.55` at weak↔weak (never a candidate at all) — so anchor-only bank↔ledger pairs are reachable only at strong↔weak anchor strength with perfect date and counterparty corroboration. Where no gateway record exists to bridge them, the honest outcome is usually two separate presence exceptions, not a speculative pair.

### 4.4 Rule IDs

Tier 1 emits one of: `EXACT_PAYMENT_ID_V1`, `EXACT_SETTLEMENT_ID_V1`, `EXACT_RRN_V1`, `EXACT_UTR_V1`, `EXACT_GATEWAY_REF_V1`, `EXACT_INVOICE_NO_V1`. The rule ID names the anchor that carried the match, because "which field proved this?" is the first question a reviewer asks.

---

## 5. S7 — Tier 1.5, alias-resolved

Unchanged in intent from ADR-012: substitute active aliases into `counterparty_key` and into `reference_ids`, then **re-run the identical Tier 1 predicate**. No new comparison logic; an alias widens the *inputs* to a test without loosening the *test*.

Two clarifications this revision adds:

- **Eligibility is checked per alias, per application.** An alias with `conflict_count > 0 AND confirmation_count < 2` is barred from Tier 1.5 (ADR-013) and contributes only to Tier 2's counterparty component. The server owns this rule; `eligibleForAliasTier` on the wire is computed, never stored.
- **One hop, and the hop is recorded.** `matches.alias_ids` lists every alias that contributed, and the `MATCH_CONFIRMED_ALIAS` audit entry's `reason` names the alias, its canonical value, who approved it and when. That sentence is the single best artifact the alias feature produces for a demo.

---

## 6. S8 — Identity-established short-circuit (ADR-029)

**This stage is new, and it fixes the most serious flaw the review found.**

### 6.1 The flaw

Consider a gateway record and a bank record that share an identical `payment_id`, where the amount is off by ₹412 — a genuine partial capture. This is precisely the `AMOUNT_MISMATCH` case, `schema.md` §8.1 category 6: *"identity established (strong anchor agrees) but amounts differ beyond tolerance."*

Under the Day 2 design it fails Tier 1 (amount), fails Tier 1.5 (aliases don't help), and arrives at Tier 2. There it scores:

```
anchor  0.45  (strong anchors agree)
amount  0.00  (delta exceeds the band; component floors at 0)
date    0.15  (same day)
counterparty 0.10  (names agree)
                    ────
              score 0.70
```

`0.70` is inside the `0.65–0.849` review band. **The record becomes a `pending_review` match — it never reaches Tier 3, so `AMOUNT_MISMATCH` is never raised.** A category described in the docs as load-bearing could not fire.

The mirror case is worse. Same anchor, amount agrees, date 9 days late — the `TIMING_DRIFT` case:

```
anchor 0.45 + amount 0.30 + date 0.00 + counterparty 0.10 = 0.85
```

`0.85` is the auto-confirm threshold. **The engine silently auto-matches a settlement that arrived three times later than its SLA**, records nothing, and `TIMING_DRIFT` never fires either. Two of the eight categories were structurally unreachable.

The root cause is a category error: **a fuzzy scorer is a tool for deciding whether two records are the same thing. When a strong anchor already proves they are, scoring them is asking a question that has already been answered** — and blending the answer with unrelated evidence lets a date disagreement cancel out an identity proof.

### 6.2 The fix

Before Tier 2 runs, every remaining pair whose **strong anchors agree on both sides** is short-circuited. Identity is treated as *established*, and the pair is resolved deterministically on value and time — never scored:

| Amount | Date | Outcome |
|---|---|---|
| within tolerance | within window | Would have matched at Tier 1; treated as a Tier 1 match (this row exists for completeness — S6 already claimed it). |
| **outside** tolerance | within window | `AMOUNT_MISMATCH` exception. Severity from ADR-044. No match created. |
| within tolerance | **outside** window | `TIMING_DRIFT` exception. Severity `low`. No match created. `evidence.wouldMatchIfWindowWidened` records the actual delta so a reviewer can confirm it in one click via the manual-match endpoint. |
| **outside** both | **outside** both | `AMOUNT_MISMATCH` primary, `TIMING_DRIFT` in `secondaryFlags` — exactly `schema.md` §8.2's precedence, now actually reachable. |

Direction disagreement on an otherwise-agreeing anchor is its own case: it is **not** a match and **not** an amount mismatch. It is a refund or reversal pairing, handled in §9.

A pair whose strong anchors **contradict** each other (both sides carry a strong anchor of the same type, and they differ) is discarded outright and never becomes a candidate — unchanged from ADR-010, and now enforced at S8 rather than inside the scorer.

### 6.3 What this does to Tier 2

Tier 2 now only ever sees pairs where identity is **not** established: weak anchors, one-sided anchors, near-anchors, or no anchor at all. That is the correct domain for a similarity score, and it forces the recalibration in §7.

---

## 7. S9 — Tier 2, fuzzy

### 7.1 Recalibrated weights (ADR-030)

The Day 2 weights (anchor 0.45 / amount 0.30 / date 0.15 / counterparty 0.10) had a second structural problem, independent of §6. With strong-anchor pairs removed from Tier 2's domain, the maximum achievable score for a weak-anchor pair was:

```
0.25 (weak anchor) + 0.30 + 0.15 + 0.10 = 0.80  <  0.85 auto-confirm
```

**Nothing at Tier 2 could ever auto-confirm.** Every fuzzy match — including a weak-anchor pair agreeing to the paisa, on the same day, with identical merchant names — would land in the human review queue. The review burden would be every fuzzy match in the dataset, and the cold-run match rate (which excludes unreviewed matches, §7.4) would collapse for a reason that has nothing to do with the data.

Revised weights:

| Component | Weight | Earned |
|---|---|---|
| **Anchor** | **0.30** | strong↔weak agreement: `0.30`. weak↔weak agreement: `0.20`. Near-anchor (§7.2): `0.24`. No comparable anchor: `0.00`. **Contradiction: candidate discarded** (not scored 0). |
| **Amount** | **0.35** | `0.35 × (1 − |delta| / band)`, floored at 0. Exact-to-the-paisa earns full. **Scored 0 and marked *unavailable*, not renormalized**, for bank↔ledger (§4.3, ADR-064). |
| **Date** | **0.20** | `0.20 × (1 − days_off / window_span)`, floored at 0. Same business day earns full. |
| **Counterparty** | **0.15** | `0.15 × trigram_similarity(key_a, key_b)`, using post-alias `counterparty_key` where available. |

**The property this buys, and it is worth stating in the pitch:**

```
strong↔weak, everything else perfect  →  0.30+0.35+0.20+0.15 = 1.00   auto-confirm possible
weak↔weak,   everything else perfect  →  0.20+0.35+0.20+0.15 = 0.90   auto-confirm possible
NO anchor,   everything else perfect  →  0.00+0.35+0.20+0.15 = 0.70   auto-confirm IMPOSSIBLE
```

**A pair with no shared reference of any kind can never be auto-confirmed, at any amount, on any date, with any name similarity.** It can reach the review band and ask a human, and that is all it can ever do. That is not a threshold choice that could be tuned away — it falls out of the weights arithmetically, and it is the strongest single honesty guarantee in the engine. Amount-and-date agreement is a coincidence generator; a reference number is evidence.

Thresholds are unchanged: `≥0.85` auto-confirm, `0.65–0.849` review, `<0.65` exception. The ambiguity guard (top two both `≥0.65` and within `0.05`) is unchanged and is evaluated **after** assignment (§7.3).

### 7.2 Near-anchor matching (ADR-031)

The generator injects `REF_TYPO` on ~4 % of ledger `gateway_ref` values — a character transposition in an 18-character `pay_` id. Under the Day 2 design these degrade to no-anchor pairs and become unmatchable-by-construction, which understates what a competent engine can do.

A **near-anchor** is scored when all of:

- both anchors are of the same type and length `≥ 12`;
- Damerau-Levenshtein distance is exactly `1` (a single substitution, insertion, deletion or adjacent transposition);
- **corroboration**: the amount is within tolerance *and* the date is within window.

It contributes `0.24` — deliberately below weak↔weak agreement plus a corroboration bonus is not granted, so a near-anchor pair needs genuine amount and date agreement to clear the review band. Candidates come from `byAnchorPrefix`, so the edit-distance work is bounded to a small bucket rather than run pairwise.

**Why this is not guessing:** across a 20-character alphanumeric space, two independently generated ids at edit distance 1 is not a realistic coincidence, and the corroboration requirement means a near-anchor alone never carries a match. The rule is `NEAR_ANCHOR_V1` and it is named in the audit `reason`, so a reviewer always sees "matched on a reference differing by one character, corroborated by amount and date" rather than an opaque score.

### 7.3 Assignment: global, score-ordered, mutual (ADR-032)

Scoring says how good a pair is. **Assignment** decides who actually gets whom, and the naive approach is order-dependent.

Greedy per-record assignment — walk records, give each its best available candidate — produces different results depending on which record is walked first. If gateway record `A` scores `0.88` against bank credit `X`, and gateway record `B` scores `0.95` against the same `X`, then processing `A` first hands `X` to the weaker claim and pushes the stronger one into an exception. The match rate, the exception list and the measured precision all depend on iteration order.

**The algorithm:**

1. Generate every candidate pair via blocking (§3) and score all of them. Discard anything below `0.65` or with a contradicted anchor.
2. Sort all surviving pairs by `(score DESC, source_system ASC, source_row_number ASC)` — the tie-break from §1.2, so equal scores resolve identically on every run.
3. Walk the sorted list once. Accept a pair only if **both** members are still unassigned for that source-role. Otherwise skip it and record `rejected_because: "counterpart already matched to a stronger candidate (score 0.95)"` in the loser's evidence.
4. After the walk, evaluate the ambiguity guard **against the candidate list as scored, not as assigned**: if a record's top two candidates were both `≥0.65` and within `0.05`, it raises `AMBIGUOUS_MATCH` even if step 3 happened to assign it one of them. The guard asks "was this decidable?", and that question is about the evidence, not about who won a race.

This is a greedy approximation to maximum-weight bipartite matching. It is not globally optimal in the way the Hungarian algorithm would be, and that is a deliberate trade: it is `O(p log p)` in candidate pairs, it is trivially explainable to a panelist in one sentence ("strongest evidence is assigned first"), and every rejection produces a human-readable reason. An optimal assignment would occasionally trade a strong pair for two medium ones — arithmetically better, and much harder to justify in an audit trail, which is the wrong trade for this project.

**Rejection reasons are first-class.** Step 3's "your counterpart went to a better claim" is one of the most useful things the exception list can say, and it is invisible in any design that assigns greedily per record.

### 7.4 Pending-review matches are not counted as matched (ADR-040)

A `pending_review` match is a **proposal**, not a reconciliation. It is excluded from the headline match rate and reported separately as review burden. Counting unconfirmed proposals as matches would mean the headline number includes work a human has not done — which is the same class of dishonesty as reporting a warm number as a cold one (ADR-020).

Denominator definitions, stated once so the UI, the API and the scorer cannot disagree:

```
reconcilable_records = ingested_records − excluded_records − rejected_rows − non_primary_duplicates
matched_records      = records in ≥1 match with status auto_confirmed OR human_confirmed
match_rate_pct       = 100 × matched_records / reconcilable_records
```

`pending_review` and `human_rejected` matches contribute to neither numerator. The API exposes `pendingReviewCount` alongside, and the UI shows it adjacent to the match rate rather than in a separate panel.

---

## 8. S10 — Net settlement batches (ADR-038)

A bank `SETTLEMENT` credit may be the net of many gateway payments minus fees, with no breakup file. `UNSPLITTABLE_BATCH` is one of the three designed-unresolvable classes — but the engine may only claim a batch is unsplittable **after genuinely trying to split it.** Declaring unsplittability without attempting decomposition is an assertion, not a finding, and a panelist is entitled to ask which one it is.

**The attempt, for each unmatched bank `SETTLEMENT` credit `C`:**

1. Build the candidate pool: unmatched gateway records, `direction = credit`, business date within `[C.date − 4, C.date]`, same `counterparty_key` where both have one. Sort canonically; **cap the pool at 24 records** (the 24 nearest by date, then by amount descending).
2. For each candidate, compute its expected net contribution using the §4.3 fee rule — the inferred fee band where gateway net is NULL, giving each candidate a `[min, max]` interval rather than a point.
3. Search for a subset whose summed interval overlaps `C.credit_amount ± tolerance`. **Depth-first with prefix pruning** over candidates sorted by descending contribution, **subset size capped at 8**, bounded by a **deterministic node budget** (default 1,300,000 visited nodes — sized to provably dominate the declared space's combinatorial ceiling of `Sum(C(24,k), k=0..8) = 1,271,626`) — see ADR-060, amended by ADR-063. A 2 s wall budget is retained as a safety valve only and should never fire; if it does, it reports itself as a distinct bound.

   > **Why a node budget and not a time budget (ADR-060).** A wall-clock bound makes the same dataset report `searchExhausted` on a fast machine and `searchBoundExceeded` on a slow one — two *different claims about the data*, decided by hardware. That is ADR-039's date problem reappearing in another stage. A node budget is a pure function of the inputs, so exhaustiveness is a property of the dataset.
4. Outcomes:

| Result | Outcome |
|---|---|
| Exactly one subset found | `many_to_one` match, `tier = fuzzy`, `rule_id = BATCH_DECOMPOSED_V1`, confidence `0.80`, status `pending_review`. A batch decomposition is a strong inference, not a certainty — it always asks a human. |
| Two or more distinct subsets found | `AMBIGUOUS_MATCH` on the bank record, with each subset recorded in `evidence.candidateSubsets`. Arithmetic cannot choose between them. |
| No subset found within bounds | `UNSPLITTABLE_BATCH`, `evidence.searchExhausted: true` — the engine searched the whole bounded space and there is genuinely no answer. |
| **Truncated** — the pool cap discarded eligible candidates, or the node budget / time valve cut the search short | `UNSPLITTABLE_BATCH`, `evidence.searchBoundExceeded: { bound: 'pool' \| 'nodes' \| 'time'; value: number }` naming which bound stopped it. The subset-size cap is **not** a truncation: it is part of the declared question, is named in the reason string, and is reported as a qualifier (ADR-060). |

**The last two rows are different claims and the exception list says which.** "I proved no combination works" and "I ran out of search budget" are both honest, and conflating them is not. `evidence` carries the pool size, the subsets examined and the bound that stopped the search, and the UI renders that distinction rather than flattening both to "unsplittable".

### 8.1 Split settlements — the mirror case (ADR-036 companion)

One gateway payment settled across two bank credits is `one_to_many`, already supported by `matches.cardinality`, and previously had no rule. It is detected in the same stage and is far cheaper than the batch case: group unmatched bank credits sharing an anchor with the gateway record (or falling in its window with the same counterparty), and accept when their sum lands in the expected net band. Capped at 4 legs. Rule `SPLIT_SETTLEMENT_V1`, status `pending_review`.

---

## 9. Refunds, chargebacks and direction (ADR-035)

`schema.md` §2.1 declares gateway `status = refunded` reconcilable, and §2.2 gives the bank `CHARGEBACK`, `FEE` and `MISC_CREDIT` transaction types — but no rule anywhere handled a debit. Without one, the direction field is decorative and the engine can match a capture to a reversal.

**Direction is a hard gate at every tier** (§4.1). Beyond that:

| Record class | Handling |
|---|---|
| Gateway `refunded` | `direction = debit`. Reconcilable. Matches a bank debit or a `CHARGEBACK` row on anchor + amount + window; matches its ledger counterpart on the reversing entry. An unmatched refund is `MISSING_IN_BANK` with severity computed on the refund amount. |
| Bank `CHARGEBACK` | Reconcilable, `direction = debit`. A genuine exception when unmatched — a chargeback nobody can tie to a payment is exactly what a controller needs to see. |
| Bank `FEE` | **Excluded at ingestion**, `status_norm = 'excluded_non_reconcilable'` (ADR-036). Gateway fees are already accounted for inside every net-amount comparison; reconciling them again double-counts them, and leaving them in guarantees a permanent block of `MISSING_IN_GATEWAY` exceptions that no human would ever action. Excluded rows are counted, listed and visible in the UI — excluded is not hidden. |
| Bank `MISC_CREDIT` | Reconcilable, `direction = credit`, `anchor_strength = 'none'`. This is the `ORPHAN_NO_COUNTERPART` unresolvable class and correctly ends as `MISSING_IN_GATEWAY`. |

Excluding `FEE` rows changes the reported denominator, so it is a metrics-affecting decision and is recorded as one. The alternative — counting routine fee debits as unresolved exceptions — would inflate the exception list with items that are not problems, which is the *opposite* failure from hiding exceptions but is equally dishonest.

---

## 10. S11 — Pair-to-group assembly

`schema.md` §7 models a match as a **group**, but every rule above produces **pairs**. The bridge was never specified.

**Rules:**

1. **The gateway record is the anchor** wherever one is present (`match_members.is_anchor = true`). It is the most structured source and the only one carrying a globally unique payment identity. Where no gateway record exists, the bank record anchors; where neither exists, the ledger record does.
2. **Pairs sharing a member merge into one group**, restricted to one member per role. `gateway↔bank` plus `gateway↔ledger` on the same gateway record produces one 3-way group.
3. **Conflicting merges are refused, not resolved.** If merging would place two records of the same role into a group (e.g. `gateway↔bank₁` and a separately-derived `bank₂↔ledger` claim over the same ledger row), the engine does **not** pick one. The stronger pair (by tier, then confidence, then canonical order) forms the group; the losing pair becomes an `AMBIGUOUS_MATCH` exception naming the group that displaced it. `many_to_one` and `one_to_many` groups are the sole exception: multiple members of one role are legitimate there, and only there.
4. **Group confidence is the minimum of its constituent pair confidences**, not the mean. A group is only as trustworthy as its weakest link, and averaging lets one exact pair launder a marginal one.
5. **Group tier is the weakest tier used** — a group formed from one exact pair and one fuzzy pair is reported as `fuzzy`. Reporting it as exact would overstate the evidence.

Rules 4 and 5 are conservative on purpose and both cost match-quality-on-paper. Both are the correct trade for a project graded on honesty.

---

## 11. S12 — Classification entry conditions

Tier 3 receives, in this order:

1. Non-primary duplicates from S4 → `DUPLICATE_RECORD`.
2. S8 identity-established verdicts → `AMOUNT_MISMATCH` / `TIMING_DRIFT`.
3. S10 batch verdicts → `UNSPLITTABLE_BATCH` / `AMBIGUOUS_MATCH`.
4. Ambiguity-guard raises from S9 → `AMBIGUOUS_MATCH`.
5. Everything left unmatched → the presence categories, discriminated by which sources hold a counterpart and whether the settlement window has elapsed relative to `run_reference_date` (§1.1).

Precedence and secondary flags are exactly `schema.md` §8.2. Severity is computed per ADR-044. Every exception carries `evidence` built from the candidates the blocking stage actually generated — including the count that were considered and discarded below the logging floor, so `candidatesConsidered` is a true count rather than the length of the logged list.

---

## 12. Failure and robustness

| Failure | Behaviour |
|---|---|
| Malformed CSV row | Captured as a rejected row with the parse error and the raw line; counted in `runs.rejected_row_count`; audit `RECORD_REJECTED`. **Not** an exception — a row that could not be read is an ingestion defect, not a reconciliation finding, and mixing them corrupts the exception count. (ADR-046) |
| Whole file unparseable | Run fails with `PARSE_FAILED`, `error_detail` names the file and line. No partial run. |
| Process restart mid-run | On boot, any run in a non-terminal state older than 5 minutes is marked `failed` with `error_detail: 'interrupted by restart'`. Without this a crashed run sits at `matching` forever and the dashboard hangs on a poll loop during a demo. (ADR-046) |
| Candidate cap hit | Recorded in evidence and surfaced, never silent (§3). |
| Subset-sum budget exhausted | Recorded as `searchBoundExceeded`, distinct from `searchExhausted` (§8). |
| Anthropic API down | Templates; run completes; `explanation_source = 'template'`. (ADR-017) |

---

## 13. Rule ID register

Every decision names the rule that made it. Rule IDs are `SCREAMING_SNAKE` + `_V<n>` and are versioned independently of the app.

| Stage | Rule IDs |
|---|---|
| Dedup | `DEDUP_STRONG_ANCHOR_V1`, `DEDUP_SUSPECTED_PAIR_V1` |
| Tier 1 | `EXACT_PAYMENT_ID_V1`, `EXACT_SETTLEMENT_ID_V1`, `EXACT_RRN_V1`, `EXACT_UTR_V1`, `EXACT_GATEWAY_REF_V1`, `EXACT_INVOICE_NO_V1` |
| Tier 1.5 | `ALIAS_RESOLVED_EXACT_V1` |
| Identity | `IDENTITY_AMOUNT_MISMATCH_V1`, `IDENTITY_TIMING_DRIFT_V1`, `IDENTITY_CONTRADICTED_V1` |
| Tier 2 | `FUZZY_NET_EXACT_V1`, `FUZZY_FEE_INFERRED_V1`, `FUZZY_WEAK_ANCHOR_V1`, `NEAR_ANCHOR_V1`, `FUZZY_NO_ANCHOR_V1` |
| Batch | `BATCH_DECOMPOSED_V1`, `SPLIT_SETTLEMENT_V1`, `BATCH_UNSPLITTABLE_V1` |
| Classify | `CLASSIFY_<CATEGORY>_V1`, one per category |

A rule ID change requires a version bump, and `rule_version` is recorded on every match, exception and audit entry — so a metric can always be attributed to the exact rule set that produced it.
