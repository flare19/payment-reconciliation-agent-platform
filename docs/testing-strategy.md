# Testing Strategy

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Day 4 — binding.**
Companion docs: [validation-strategy.md](./validation-strategy.md) · [matching-engine.md](./matching-engine.md)

**Division of labour:** [validation-strategy.md](./validation-strategy.md) measures whether the engine is *right about payments*. This doc covers whether the code is *right about itself*. They are different questions and neither substitutes for the other — an engine can pass every unit test and still reconcile badly, and it can score 82 % while a parser silently drops every row with a comma in it.

Not TDD, not a coverage target. **Tests exist where a silent wrong answer is possible**, and nowhere else. In a project whose thesis is measured accuracy, the failures worth guarding against are the ones that produce a plausible number rather than a stack trace.

---

## 1. Where a silent wrong answer is possible

These five areas get real tests. Everything else gets whatever falls out.

### 1.1 Parsers — table-driven, one case per documented defect

Every messy format in `schema.md` §2 becomes a case, because a parser bug is invisible: it produces a number, just the wrong one.

| Input | Expected |
|---|---|
| `"1,234.50"` | `123450` |
| `"₹1234.5"` | `123450` |
| `"1,23,456.50"` | `12345650` — **Indian lakh grouping.** A parser written against Western grouping produces `123456.50` → wrong by 100×, and every downstream number stays plausible. |
| `" 1234.50 "` | `123450` |
| `"(1,234.50)"` | `-123450` — accounting negative |
| `""` / `null` | `null`, warning `AMOUNT_MISSING` |
| `"abc"` | reject the row, `RECORD_REJECTED` |
| `"1234.567"` | `123457` — round-half-up at paise, asserted explicitly |

Dates get the same treatment: `03/04/2026` under the ledger's `MM/DD/YYYY` **must** be 3 April and never 4 March; the parser is told the format and never infers it (`schema.md` §2.3). Cross-midnight IST/UTC cases are asserted in both directions.

Also covered: BOM, CRLF, quoted commas inside a description blob, embedded newlines, a truncated final line.

### 1.2 Tolerance and window boundaries — exact edges, not "around"

Off-by-one at a boundary is the classic accuracy bug and it never crashes.

- Amount exactly at the band edge, one paisa inside, one paisa outside.
- The ₹1.00 floor and the ₹100.00 cap, and the two amounts where the clamp engages (₹200 and ₹20,000).
- Date exactly at `+3` and at `+4` for card; `-1` and `-2`.
- Fee band boundaries at 2.36 % and 2.95 %.

### 1.3 The precedence table — one test per row of `schema.md` §8.2

Including every worked overlap, and specifically the two the Day 4 review corrected:

- A duplicate copy produces **no** `MISSING_IN_BANK` flag (ADR-034).
- Three anchorless same-amount same-day rows classify as `AMBIGUOUS_MATCH`, **not** duplicates (ADR-034).

### 1.4 The two previously-unreachable categories — regression tests

These are the highest-value tests in the suite, because the bugs they guard against were invisible in every metric except one nobody would have looked at (ADR-029):

- Same `payment_id`, amount off by ₹412 → **`AMOUNT_MISMATCH` exception**, and specifically *not* a `pending_review` match.
- Same `payment_id`, amount exact, date +9 days → **`TIMING_DRIFT` exception**, and specifically *not* an `auto_confirmed` match at exactly 0.85.

Both assert the negative as loudly as the positive. The old design produced a *plausible* result in both cases, which is why it survived the Day 2 review.

### 1.5 Determinism — the guarantee the whole project rests on

- Run the same fixture twice in one process; assert byte-identical match sets, exception sets and metrics.
- Run it with the input rows **shuffled** in memory before matching; assert the same output. This is the real test of ADR-032 — it fails loudly if any decision path depends on iteration order, which no other test would catch.
- Assert the audit hash chain verifies after every fixture run.

### 1.6 The grounding gate — the highest-value tests in the suite

A3 (ADR-050) is pure functions over a verdict and a tool-call log, so it is cheap to test exhaustively, and it is the only thing standing between a hallucinated reasoning chain and the database.

- A verdict citing a `transactionId` that **appears in no tool result** from that investigation → rejected, `groundingFailure` set.
- A verdict citing an id that appears in a tool result from a **different** investigation → rejected. Grounding is per-investigation.
- A `MANUAL_MATCH` proposal naming an already-matched record → rejected.
- A `MANUAL_MATCH` proposal naming two records of the **same** source role, or opposite `direction` → rejected.
- A well-grounded verdict → accepted, citations populated.
- Schema violations (bad enum, missing field, numeric confidence where a label is required) → rejected.

Every one asserts the **negative**: the verdict does not reach `agent_investigations` with `grounding_passed = true`. A gate that fails open is worse than no gate, because it produces confident-looking output nobody re-checks.

### 1.7 Agent tools — the read-only guarantee

- **Assert the tool registry exports no mutating tool.** Enumerate the registry and assert every handler is read-only — no `INSERT`, `UPDATE` or `DELETE` reachable from any tool. This is the property ADR-049 claims, and a claim about a registry should be a test over that registry, not a comment above it.
- `score_pair` returns **the same breakdown** the Tier 2 scorer produced for the same pair during the run. If these ever diverge, the agent is reasoning over numbers the engine never computed, which is the whole thing ADR-049 exists to prevent.
- `rerun_subset_search` refuses bounds above its ceilings (pool 64, subset 10, 2000 ms) rather than clamping silently.
- `search_transactions` truncates at 50 and **reports the truncation** in its result.

---

## 2. Golden-run snapshot

One committed fixture (a 60-event `DEV_SEED` subset, small enough to eyeball) with a committed expected-output JSON: match count per tier, exception count per category, and the full metrics object minus timings.

Any diff in that snapshot on any commit means the engine's behaviour changed. Sometimes that is intended, and the fix is to update the snapshot **in the same commit as the change that caused it**, so the diff is reviewable and `what-broke.md` has something concrete to record. An accuracy regression that arrives silently between Day 8 and Day 11 would be extremely hard to find afterwards; this makes it arrive with a name attached.

---

## 3. The leak guard

A test asserting **no file under `apps/api/src` references `data/truth`**. One grep, run in the suite.

ADR-021's guarantee is the foundation of every accuracy claim in the project. "We checked and nothing imports it" is an assertion about a moment in time; a failing test is a property. It costs three lines and it is the single cheapest credibility-preserving thing in the repo.

---

## 4. What is deliberately not tested

| Not tested | Why |
|---|---|
| LLM output quality | Non-deterministic prose narrating decisions that are themselves tested. Asserting on generated text produces a flaky suite that tests the model, not the engine. (validation-strategy §9) |
| Agent verdict *content* | Phase A makes no determinism claim (ADR-057). The suite tests the **gate**, the **tools** and the **budgets** — everything deterministic around the loop — and the verdicts themselves are measured against ground truth by `tools/score` (validation-strategy §5.7), which is a measurement rather than an assertion. Snapshotting agent output would produce a suite that fails on model variance and passes on wrong answers. |
| React components | Manual verification against `ui-spec.md`. Component tests on a 7-screen dashboard built in one day would consume the day. |
| Express routing | Routes are thin by construction (CLAUDE.md §4.3); the logic they delegate to is tested. |
| Repository SQL in isolation | Exercised by every integration test that runs a fixture end to end. |
| Coverage percentage | Not a goal. A high number here would mostly measure how many trivial mappers were tested. |

---

## 5. Mechanics

`node --test` with `tsx`. No Jest, no Vitest — Node 22's built-in runner needs no config file and no transform pipeline, which matters more than its feature set on a 13-day clock. Consistent with ADR-023's preference for the least interesting option available.

Integration tests run against a real Postgres (the local dev database, migrated fresh, truncated between tests). No mocking of the database: the SQL *is* the logic here (ADR-022), and a mocked query proves nothing about a query that has to be right.
