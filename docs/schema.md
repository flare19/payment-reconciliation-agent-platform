# Data & Schema Design

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Locked.** Day 2 architecture, revised by the Day 3 design review (ADR-028…ADR-047). Changes require a new ADR.
Companion docs: [api-contract.md](./api-contract.md) · [matching-engine.md](./matching-engine.md) · [agent-design.md](./agent-design.md) · [adr-log.md](./adr-log.md) · [validation-strategy.md](./validation-strategy.md)

**Division of ownership:** this doc owns *shapes* — tables, columns, tolerances, taxonomy, prompt. [matching-engine.md](./matching-engine.md) owns *execution* — stage order, candidate generation, assignment, determinism. If you are asking "what does the data look like", you are in the right file; if you are asking "what runs when", you are not.

This is the core document. Everything else (matching engine, exception classifier, API, dashboard) hangs off the shapes defined here. If a later session finds this doc wrong, fix this doc **first**, add an ADR entry, then change code.

---

## 0. Cross-cutting conventions

These apply to every table and every parser. They are not negotiable per-module.

| Concern | Decision | Reason |
|---|---|---|
| Money | `BIGINT` **paise** (integer minor units). Never `FLOAT`, never `NUMERIC` for arithmetic. | Reconciliation is equality-comparison of money. Binary floats make `12.30 != 12.30` a real failure mode; integer paise makes every comparison exact and every tolerance an integer band. |
| Currency | `CHAR(3)`, always `'INR'` in v1. Column exists, multi-currency logic does not. | Keeps the column honest without pulling FX conversion into scope (out-of-scope per ARCHITECTURE §5 spirit — no scope for FX rate sourcing). |
| Dates | `txn_date DATE` (calendar date in **IST**, the business day the record belongs to) plus `txn_timestamp TIMESTAMPTZ` (full instant, stored UTC) where the source has time. | Date-window matching is a *business-day* operation. Storing only a timestamp forces every comparison to redo timezone math; storing only a date loses the ordering needed for same-day duplicate detection. |
| Timezone | All ingestion normalizes to **Asia/Kolkata** for the business date, stores UTC for the instant. | The synthetic data deliberately includes cross-midnight IST/UTC drift (see §2.1). This must be a solved convention, not a per-parser guess. |
| IDs | `UUID` PK via `gen_random_uuid()` for all business tables. `BIGSERIAL` for `audit_log` only. | UUIDs let the generator and the API mint IDs without a DB round-trip. `audit_log` wants a monotonic `sequence_no` for deterministic replay ordering, which a serial gives for free. |
| Naming | `snake_case` in Postgres, `camelCase` in TypeScript, mapping done once in the repository layer. | See `CLAUDE.md`. |
| Enums | Postgres `TEXT` + `CHECK (col IN (...))`, **not** native `ENUM` types. | Adding a value to a native enum inside a migration is awkward and irreversible-ish. This taxonomy will change on Day 5. `CHECK` constraints are one `ALTER` away. |
| Nullability | Every nullable column below is nullable for a stated reason. If a reason isn't stated, it's `NOT NULL`. | Prevents the slow drift into an all-nullable schema where nothing can be trusted. |
| Immutability | `audit_log` is append-only, enforced by a `BEFORE UPDATE OR DELETE` trigger that raises, **and hash-chained** so tampering is detectable even by someone who can drop the trigger (ADR-042). | ARCHITECTURE §4.6 says "logged immutably". A convention isn't immutability; a trigger is inconvenience; a chain is detection. |
| Reference date | Every "has the window elapsed" test uses `runs.reference_date = MAX(txn_date)` over the dataset — **never the wall clock** (ADR-039). | Otherwise the same dataset produces different exception counts in August and in September, and the reported numbers drift between rehearsal and submission. A run must be a pure function of its inputs. |
| Direction | `direction` is a **hard gate** at every tier, never a scored component (ADR-035). A credit never matches a debit. | Without it a ₹5,000 capture can match a ₹5,000 chargeback on a shared anchor with a perfect score — a wrong book produced by an omission. |

---

## 1. Data model at a glance

```
runs
 └── transactions          (one row per SOURCE ROW, from any of the 3 sources)
       ├── matches         (a match GROUP: 1 row = 1 reconciled economic event)
       │     └── match_members   (transaction ↔ match, with role; supports N:1 net settlements)
       ├── exceptions      (unmatched or problematic records, classified)
       └── audit_log       (append-only; every decision, engine + human + LLM)

learned_aliases            (run-independent; human-confirmed equivalences, reused across runs)
explanation_cache          (run-independent; LLM output keyed by discrepancy SIGNATURE, not by record)
score_reports              (per-run; written ONLY by the offline scorer, never by the engine — ADR-041)

agent_investigations       (per-run; Phase A verdicts. Reads engine output; never writes to it — ADR-048)
agent_questions            (per-run; Q&A agent transcripts — ADR-056)
```

Two tables are deliberately **run-independent**: `learned_aliases` and `explanation_cache`. Everything else is scoped to a run so a re-run never mutates history. That separation is what makes the alias-learning feature measurable across runs (see §9).

`score_reports` is scoped to a run but sits outside the engine entirely: it is written by `tools/score/` after the fact and read only for display (§11.2, ADR-041). No engine module reads it, and no engine decision depends on it.

---

## 2. The three synthetic source schemas

These are the shapes the generator emits and the parsers consume. They are deliberately *inconsistent with each other* — that inconsistency is the product.

### 2.1 Source A — Payment Gateway Export (`gateway_export.csv`)

Models a Razorpay-style payments export. This is the **most structured** source and the anchor for identity.

| Column | Type as emitted | Purpose / notes |
|---|---|---|
| `payment_id` | string, `pay_` + 14 alphanumeric | Primary identity anchor. Globally unique. |
| `order_id` | string, `order_` + 14 alphanum, sometimes blank | Secondary anchor. Blank on ~8% of rows (direct payments). |
| `method` | `card` \| `upi` \| `netbanking` \| `wallet` | Drives the expected settlement lag (see §5.2). |
| `status` | `captured` \| `authorized` \| `failed` \| `refunded` | **Only `captured` and `refunded` are reconcilable.** `failed`/`authorized` are excluded at ingestion, not matched-and-failed. A `refunded` row normalizes to `direction = 'debit'` and reconciles against a bank debit or `CHARGEBACK` row (ADR-035). |
| `amount` | string, rupees, messy: `"1,234.50"`, `"₹1234.5"`, `"1234.50"` | Gross amount charged to customer. Parser must strip `₹`, commas, whitespace. |
| `currency` | `INR` | Constant in v1. |
| `fee` | string, rupees, may be blank | Gateway fee. Blank on ~15% of rows — forces the fee-inference path in §5.3. |
| `tax` | string, rupees, may be blank | GST on fee (18%). |
| `net_amount` | string, rupees, may be blank | `amount - fee - tax`. Blank whenever `fee` is blank. This is what the bank actually credits. |
| `created_at` | `YYYY-MM-DD HH:MM:SS`, **IST, no offset marker** | Ambiguous-by-design. Ingestion assumes IST. |
| `captured_at` | same format, sometimes blank | Preferred date anchor when present. |
| `merchant_name` | free text with variants: `AMZN`, `Amazon`, `AMAZON RETAIL IN`, `Amazon Retail India Pvt Ltd` | The alias-learning surface. Variants are intentional. |
| `customer_email` | string, sometimes blank | Weak anchor only; not used for matching (PII-adjacent, low value). |
| `rrn` | 12-digit numeric string, blank for ~20% of `upi` rows | Retrieval Reference Number. The **only** anchor that also appears in the bank file. |
| `settlement_id` | `setl_` + 14 alphanum, blank until settled | Blank on records that are legitimately not yet settled — a major `MISSING_IN_BANK` source. |
| `notes` | free text, often blank | Ignored by matching. Carried into `raw_payload` for audit. |

### 2.2 Source B — Bank Settlement File (`bank_settlement.csv`)

Models a bank statement / settlement report. This is the **messiest** source: identity lives inside a free-text description blob.

| Column | Type as emitted | Purpose / notes |
|---|---|---|
| `utr` | 16–22 char alphanumeric | Bank's own reference. Does **not** appear in the gateway export. Useless as a cross-source anchor; useful as a bank-side dedup key. |
| `value_date` | `DD-MM-YYYY` | **Different date format from both other sources, on purpose.** The business date of the credit. |
| `posting_date` | `DD-MM-YYYY`, sometimes ≠ `value_date` | Bookkeeping date. `value_date` is authoritative for matching. |
| `description` | free text blob, up to 100 chars, **truncated mid-token on ~10% of rows** | Contains the RRN and/or `settlement_id` and/or a merchant-name variant, embedded in noise: `"NEFT-SETL-AMZN RETAIL-234567890123-BATCH12"`. Anchor extraction happens here. |
| `credit_amount` | string, rupees, blank on debit rows | Net amount credited. |
| `debit_amount` | string, rupees, blank on credit rows | Chargebacks, fee debits, reversals. |
| `closing_balance` | string, rupees | Not used for matching. Present because real files have it and its absence would look fake. |
| `bank_ref_no` | numeric string, sometimes equal to the RRN, sometimes not | Semi-reliable anchor — worth trying, never worth trusting alone. |
| `transaction_type` | `SETTLEMENT` \| `NEFT` \| `IMPS` \| `UPI` \| `CHARGEBACK` \| `FEE` \| `MISC_CREDIT` | `CHARGEBACK` and `MISC_CREDIT` have no gateway counterpart by design and stay in the reconcilable population. **`FEE` rows are excluded at ingestion** (ADR-036) — see below. |

**Why `FEE` rows are excluded and the other two are not (ADR-036).** Gateway fees are already accounted for inside every net-amount comparison (§5.3); reconciling a fee debit separately double-counts it and guarantees a permanent block of `MISSING_IN_GATEWAY` exceptions that no human would ever action. Inflating the exception list with non-problems is the opposite failure from hiding exceptions, and it is equally dishonest. A `CHARGEBACK` is the reverse case — one that can't be tied to a payment is exactly what a controller needs surfaced — and a `MISC_CREDIT` is the designed `ORPHAN_NO_COUNTERPART` class. Excluded rows are counted, listed and visible in the UI: excluded is not hidden.

**Critical structural property:** a single `SETTLEMENT` row may be the **net of many gateway payments minus fees** (a batch settlement). This is the N:1 case that `match_members` exists for, and — when no batch breakup is provided — one of the genuinely-unresolvable classes (see `validation-strategy.md`).

### 2.3 Source C — Merchant Ledger (`merchant_ledger.csv`)

Models an internal accounting export. Structured, but written by humans and by a different system's conventions.

| Column | Type as emitted | Purpose / notes |
|---|---|---|
| `entry_id` | `JE-` + 6 digits | Ledger's own key. |
| `invoice_no` | `INV/2026/00123` | Business document reference. |
| `gateway_ref` | should be the `payment_id`; blank on ~12%, **transposed/typo'd on ~4%** | The intended anchor to Source A. Its unreliability is the point. |
| `customer_name` | free text, variants again | Second alias-learning surface. |
| `gross_amount` | string, rupees, format `1234.50` (no separators) | The list price before discount and sale GST. **Does not equal gateway `amount`** whenever `discount` or `tax_amount` is non-zero. |
| `discount` | string, rupees, often `0.00` | Subtracted before tax. A source of legitimate amount divergence. |
| `tax_amount` | string, rupees | GST on the sale (distinct from GST on the gateway fee — a classic confusion this dataset should contain). |
| `net_amount` | string, rupees | `gross - discount + tax` — **what the customer was actually charged, and therefore the field that equals gateway `amount`** (ADR-037). Note: ledger net ≠ gateway *net*. Gateway net is after gateway fees; ledger net is before them. Compare ledger net to gateway **gross**, never to gateway net. |
| `entry_date` | `MM/DD/YYYY` | **US-format, third distinct date format.** Ambiguity between `03/04` and `04/03` is real and deliberate: a day ≤ 12 could equally be a month, so an inferring parser has to guess. **~40 % of ledger rows are ambiguous** and the generator asserts it stays above 35 % (ADR-070 — the original "~30 % unambiguous" target was arithmetically unreachable). Parser must be told the format, not guess it. |
| `account_code` | `4000`–`4999` | Revenue account. Not used for matching. |
| `posted_by` | string | Carried for audit only. |
| `memo` | free text | Carried for audit only. |
| `status` | `posted` \| `draft` \| `void` | **Only `posted` is reconcilable.** `draft`/`void` excluded at ingestion. Including them would inflate the exception count dishonestly. |

### 2.4 Injected messiness catalogue

The generator injects exactly these defect classes. Naming them here means the classifier and the answer key use one vocabulary.

| Defect code | What it does |
|---|---|
| `DATE_FORMAT_DIVERGENCE` | Three formats across three sources (baseline, not a defect per row). |
| `TZ_MIDNIGHT_DRIFT` | Gateway timestamp within 90 min of IST midnight; bank value_date lands on the adjacent day. |
| `SETTLEMENT_LAG` | Bank `value_date` is T+1..T+3 from gateway capture, by method. |
| `AMOUNT_FEE_DELTA` | Bank credit is net of a 2.0–2.5% fee + 18% GST on the fee. |
| `AMOUNT_TRUE_MISMATCH` | Genuine discrepancy beyond any tolerance (partial capture, wrong entry). |
| `MERCHANT_NAME_VARIANT` | Same merchant, different string across sources. |
| `REF_MISSING` | Anchor field blank. |
| `REF_TYPO` | Anchor field present but character-transposed. |
| `DESC_TRUNCATED` | Bank description cut mid-anchor. |
| `DUPLICATE_ROW` | Same economic event emitted twice in one source (retry artifact). |
| `MISSING_ROW` | Economic event absent from one source entirely. |
| `ORPHAN_ROW` | Row exists in one source with no economic event behind it (misc credit, chargeback). |
| `NET_SETTLEMENT_BATCH` | N gateway payments → 1 bank credit, no breakup file. |
| `SPLIT_SETTLEMENT` | 1 gateway payment → 2–4 bank credits (partial settlement). The mirror of the batch case; resolvable, and handled by `SPLIT_SETTLEMENT_V1` (ADR-038). |
| `REFUND_REVERSAL` | A `refunded` gateway row with a matching bank **debit**. Exercises the direction gate (ADR-035). |
| `NOISE_ROW` | `failed`/`draft`/`void` rows that must be filtered, not matched. |

---

## 3. Internal normalized model — `transactions`

**One row per source row.** Not one row per economic event. This is the single most important modelling decision in the doc.

> **Why one-row-per-source-row:** the alternative (normalizing straight into economic events at ingest) means the *matching* decision has already been made by the *parser*. That destroys the audit trail — you could no longer show a panelist "here are the three raw rows and here is why the engine believes they are the same payment." Ingestion must be lossless and opinion-free; all judgement happens in the matching engine, where it can be logged.

```sql
CREATE TABLE transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  -- provenance
  source_system          TEXT NOT NULL CHECK (source_system IN ('gateway','bank','ledger')),
  source_file            TEXT NOT NULL,
  source_row_number      INT  NOT NULL,        -- 1-based, for "row 148 of the bank file" in the UI

  -- identity anchors
  external_id            TEXT NOT NULL,        -- payment_id | utr | entry_id
  reference_ids          JSONB NOT NULL,       -- see below
  anchor_strength        TEXT NOT NULL CHECK (anchor_strength IN ('strong','weak','none')),

  -- money (paise, integers)
  amount_paise           BIGINT NOT NULL,      -- gross as the source states it
  fee_paise              BIGINT,               -- NULL: source does not report a fee
  tax_paise              BIGINT,               -- NULL: source does not report tax
  net_amount_paise       BIGINT,               -- NULL: not reported AND not derivable
  currency               CHAR(3) NOT NULL DEFAULT 'INR',
  direction              TEXT NOT NULL CHECK (direction IN ('credit','debit')),

  -- time
  txn_date               DATE NOT NULL,        -- IST business date
  txn_timestamp          TIMESTAMPTZ,          -- NULL: source has date granularity only (bank, ledger)
  posting_date           DATE,                 -- NULL: only the bank source has this

  -- counterparty
  counterparty_raw       TEXT,                 -- NULL: source has no merchant/customer field populated
  counterparty_norm      TEXT,                 -- uppercased, punctuation+legal-suffix stripped, whitespace collapsed
  counterparty_key       TEXT,                 -- counterparty_norm after alias resolution; NULL until alias tier runs

  -- classification carried from source
  method                 TEXT,                 -- NULL: bank/ledger do not report method
  status_raw             TEXT NOT NULL,
  status_norm            TEXT NOT NULL CHECK (status_norm IN ('reconcilable','excluded_failed','excluded_draft','excluded_void','excluded_authorized','excluded_non_reconcilable')),
  txn_type               TEXT,                 -- bank only: SETTLEMENT/CHARGEBACK/FEE/...

  -- freeform
  description_raw        TEXT,

  -- deduplication (ADR-034; set at stage S4, before matching)
  duplicate_of_transaction_id UUID REFERENCES transactions(id),  -- NULL: this row is a primary, or not a duplicate
  duplicate_kind         TEXT CHECK (duplicate_kind IN ('exact','suspected')),  -- NULL unless duplicate_of is set

  -- ingestion bookkeeping
  ingest_warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['AMOUNT_HAD_CURRENCY_SYMBOL','DATE_ASSUMED_IST',...]
  raw_payload            JSONB NOT NULL,       -- the complete original row, verbatim
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_txn_run_source        ON transactions (run_id, source_system);
-- Blocking index (ADR-033). `direction` is in the key because it is a hard gate (ADR-035),
-- so excluding it would fetch candidates that are discarded immediately.
CREATE INDEX ix_txn_block             ON transactions (run_id, direction, txn_date, amount_paise);
CREATE INDEX ix_txn_refs_gin          ON transactions USING gin (reference_ids);
CREATE INDEX ix_txn_cp_norm           ON transactions (run_id, counterparty_norm);
CREATE INDEX ix_txn_dupe              ON transactions (duplicate_of_transaction_id) WHERE duplicate_of_transaction_id IS NOT NULL;

-- Canonical ordering for every decision-feeding query (ADR-032). source_system sorts
-- gateway < bank < ledger by explicit CASE, not alphabetically.
```

**A note on `source_row_number`.** It is `NOT NULL` because it is the join key the answer key uses (`validation-strategy.md` §2.1) *and* the canonical tie-break for deterministic ordering (ADR-032). Two loads of the same file must produce the same numbers, so it is assigned by the parser from the physical file position, counting the header as row 0 — including rows that are later rejected or excluded, so numbering never shifts.

### 3.1 `reference_ids` shape

Every anchor the parser could extract, from structured fields *and* from regex over the bank description blob:

```json
{
  "payment_id":    "pay_QK29fT10aXbZ81",
  "order_id":      "order_QK29fT10aXbZ7C",
  "rrn":           "234567890123",
  "utr":           "SBIN0R52026081412345",
  "settlement_id": "setl_QK2AAb91xxKK01",
  "invoice_no":    "INV/2026/00123",
  "entry_id":      "JE-004417",
  "extracted_from_description": ["234567890123", "SETL", "AMZN RETAIL"]
}
```

Keys are omitted when absent — never present-with-null. `extracted_from_description` holds low-confidence regex hits and is always treated as `weak`.

### 3.2 `anchor_strength`

| Value | Meaning | Assigned when |
|---|---|---|
| `strong` | A globally unique ID that can carry an exact match on its own. | `payment_id`, `settlement_id`, or a well-formed 12-digit `rrn` present in a structured field. |
| `weak` | A reference that narrows candidates but cannot confirm alone. | Anchor only recoverable from `extracted_from_description`, or `bank_ref_no`, or `order_id` alone. |
| `none` | No usable reference at all. | Bank `MISC_CREDIT` rows, ledger rows with blank `gateway_ref` and no invoice cross-ref. |

This column exists so the classifier can distinguish *"we couldn't find it"* from *"there was nothing to find"* — the difference between a solvable and an unsolvable exception, and the thing that keeps the exception list honest.

### 3.3 Normalization rules for `counterparty_norm`

Deterministic, applied in order, **no fuzzy logic here** (fuzzy belongs in Tier 2):
1. Unicode NFKC, trim, collapse internal whitespace to single space.
2. Uppercase.
3. Strip punctuation `. , ' " - / & ( )` → space, re-collapse.
4. Strip trailing legal suffixes: `PVT`, `PRIVATE`, `LTD`, `LIMITED`, `LLP`, `INC`, `CORP`, `CO`, `INDIA`, `IN`.
5. Strip known payment-rail prefixes from bank descriptions: `NEFT`, `IMPS`, `UPI`, `SETL`, `SETTLEMENT`, `BATCH\d+`, `MPS`.
6. Strip **reference-shaped tokens wherever they appear** in a bank description, not only at its tail: digit runs of 6+ (`RRN`, `bank_ref_no`), `setl_`/`pay_`/`order_` ids, and any remaining `BATCH\d+`. Then re-apply rule 4 — a legal suffix that was not final before those tokens were removed is final now (`ZOMATO LIMITED 818624673100 setl_…` must reach `ZOMATO`, or the bank leg never meets the gateway's `ZOMATO`). A description that is nothing but reference tokens normalizes to `NULL`: it carries no counterparty, and saying so is more honest than inventing a name that buckets alone.

   > Rule 6 was implicit until 2026-08-28. §2.2's worked example happens to put the RRN last (`…-AMZN RETAIL-234567890123-BATCH12`), so a tail-anchored strip satisfied it; the emitted data puts a `setl_…` token after the RRN, which halted that strip and left the reference embedded in **248 of 301** bank rows. `counterparty_norm` became row-unique, which silently disabled the `byCounterparty` block index, diluted Tier 2's counterparty component and made bank-side alias learning impossible (issue #31).

`Amazon Retail India Pvt Ltd` → `AMAZON RETAIL`. `AMZN` → `AMZN`. These still don't match — that gap is exactly what `learned_aliases` closes.

---

## 4. `runs`

```sql
CREATE TABLE runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label             TEXT NOT NULL,              -- 'demo-holdout-seed-90210'
  dataset_seed      BIGINT,                     -- NULL: user-uploaded files, not generated
  status            TEXT NOT NULL CHECK (status IN ('pending','ingesting','matching','classifying','explaining','completed','failed')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,                -- NULL until terminal state
  reference_date    DATE,                       -- ADR-039: MAX(txn_date) over the dataset. NULL until ingestion completes.
  record_counts     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {gateway: 312, bank: 240, ledger: 298, excluded: 27, rejected: 1,
                                                        --  nonPrimaryDuplicates: 9, reconcilable: 813}
  rejected_row_count INT NOT NULL DEFAULT 0,     -- ADR-046: rows that could not be parsed. NOT exceptions.
  rejected_rows     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{source, rowNumber, rawLine, error}]
  input_file_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {gateway: 'sha256:…', bank: '…', ledger: '…'}
  config_snapshot   JSONB NOT NULL,             -- FULL tolerance + rule-version + flags snapshot
  metrics           JSONB,                      -- NULL until completed; ENGINE-COMPUTED ONLY (§11.1)
  error_detail      TEXT                        -- NULL unless status='failed'
);
```

`config_snapshot` is mandatory and non-negotiable. It captures every tolerance value, every rule version, `alias_learning_enabled`, the alias-table row count at run start, and the resolved `reference_date`. Without it, a run's metrics are unreproducible — and an unreproducible accuracy number is exactly what the track's bar rejects.

`input_file_hashes` completes that guarantee. `config_snapshot` proves *how* the engine was configured; the hashes prove *what it was configured against*. Together with the determinism rules in [matching-engine.md](./matching-engine.md) §1.2, a run's output is a pure function of `(input files, config, active aliases)` — all three of which are recorded. The same hashes appear in the answer key's manifest, so the scorer refuses to score a run against a key built from different bytes.

`rejected_rows` holds rows that could not be parsed at all. They are **not** exceptions (ADR-046): a row that could not be read is an ingestion defect, not a reconciliation finding, and mixing the two corrupts the exception count — the number under the most scrutiny. They are excluded from the reconcilable denominator, counted here, and surfaced in the UI.

---

## 5. Matching tolerances — concrete defaults

ARCHITECTURE §6 asks for real numbers. Here they are, with reasoning. All live in `config_snapshot` and are overridable per run, but these are the shipped defaults.

### 5.1 Amount tolerance — banded, not a flat percentage

```
tolerance_paise = clamp( round(0.005 * amount_paise), 100, 10_000 )
                = 0.5% of the amount, floored at ₹1.00, capped at ₹100.00
```

**Why 0.5%:** it is deliberately *below* the real gateway fee band (2.0–2.5% + 18% GST ≈ 2.36–2.95%). Fee-bearing comparisons are handled explicitly by the net-amount rule in §5.3, not swallowed by a loose tolerance. 0.5% is sized for rounding, GST paise-rounding, and per-unit price drift — not for fees. Setting it at 3% to "absorb fees" would be the tempting mistake and would silently match records whose amounts genuinely disagree.

**Why a ₹1.00 floor:** 0.5% of a ₹50 payment is ₹0.25. Two systems rounding GST in opposite directions can differ by ₹0.50 on a small ticket. A pure percentage makes small-ticket matching fail for arithmetic reasons that have nothing to do with reconciliation quality.

**Why a ₹100.00 cap:** 0.5% of ₹5,00,000 is ₹2,500 — enough to swallow a real partial-capture error. Money discrepancy risk scales with absolute rupees, not with percentage. The cap converts the tolerance from proportional to absolute above ₹20,000, which is where absolute risk starts to dominate.

The band is therefore proportional between ₹200 and ₹20,000, and clamped outside that range. That interval covers the bulk of a realistic Indian payments batch.

### 5.2 Date window — asymmetric, per source pair and per method

Settlement flows forward in time. A symmetric window is wrong in both directions: too tight on the lag side, needlessly loose on the backward side.

| Pair | Window (days, relative to gateway date) | Reason |
|---|---|---|
| gateway → bank, `card` / `netbanking` | `[-1, +3]` | Indian card settlement is typically T+2, occasionally T+3 over a weekend or bank holiday. |
| gateway → bank, `upi` / `wallet` | `[-1, +2]` | UPI settles faster; T+1 is the norm, T+2 the tail. |
| gateway → ledger | `[-1, +1]` | The ledger entry is written by the merchant's own system, usually same day. |
| bank → ledger (derived, only when gateway row is absent) | `[-2, +4]` | The union of the two windows above; used only when a gateway anchor is missing, and always at reduced confidence. |

**Why the `-1` on every window:** the `TZ_MIDNIGHT_DRIFT` defect is real. A payment captured at 00:20 IST on the 15th is 18:50 UTC on the 14th; a bank system that books in UTC files it against the 14th. Without a one-day backward allowance, every near-midnight payment becomes a false exception, and the exception list stops being honest in the opposite direction — inflated with artifacts.

**Why not wider:** a `[-1, +7]` window at 200–500 records makes the candidate pool large enough that same-amount collisions become common, which converts clean matches into `AMBIGUOUS_MATCH` exceptions. Widening the window past the real settlement SLA trades precision for nothing.

### 5.3 The fee/net-amount rule (its own sub-rule, not a tolerance widening)

When comparing a gateway record to a bank credit:

1. If gateway `net_amount_paise` is present → compare it to bank `credit_amount` under §5.1. Rule `FUZZY_NET_EXACT`, full confidence weight.
2. If gateway `net_amount_paise` is NULL (the ~15% blank-fee rows) → compute an expected band:
   `expected_net ∈ [ gross × (1 − 0.0295), gross × (1 − 0.0236) ]`
   and accept a bank credit landing inside that band **plus** the §5.1 tolerance. Rule `FUZZY_FEE_INFERRED`, confidence weight multiplied by **0.85** — because the engine inferred a value the source did not state, and the audit trail must say so.
3. Never compare gateway `net_amount` to ledger `net_amount`. They are different quantities (§2.3) — gateway net is after *gateway fees*, ledger net is after *discount and sale GST*. Comparing them is a category error that would produce plausible-looking wrong matches.

### 5.3.1 Comparison basis per source pair (ADR-037)

Which amount is compared to which is a modelling decision, and getting it wrong produces confidently wrong matches. Stated once, here, so no tier re-derives it:

| Pair | Compare | Why |
|---|---|---|
| gateway ↔ bank | `gateway.net_amount_paise` vs `bank.credit_amount` (or the inferred fee band above) | The bank credits net of gateway fees. |
| gateway ↔ ledger | `gateway.amount_paise` vs **`ledger.net_amount_paise`** | Both are *what the customer was charged*. |
| bank ↔ ledger | **Anchor only — amounts are not a matching basis.** The amount component is scored 0 and flagged `amountUnavailable` — not renormalized out of the weighted sum (ADR-064). | Bank is net of gateway fees; ledger is a sale amount including sale GST. No arithmetic relates them without the gateway row in between. |

**The gateway↔ledger correction.** §2.3 previously asserted that ledger `gross_amount` "should equal gateway `amount`" while also defining `net = gross − discount + tax`. Both cannot hold: whenever discount or sale GST is non-zero, the customer pays the *net*. Comparing gross would turn every discounted or taxed sale into an `AMOUNT_MISMATCH`, flooding the exception list with arithmetic artifacts and destroying the credibility of the category that most needs it. The generator is constrained accordingly — for a clean event `ledger.net_amount == gateway.amount` exactly, and `AMOUNT_TRUE_MISMATCH` is what deliberately breaks it.

### 5.4 Confidence scoring (Tier 2 only)

Tier 1 and the alias tier do not score — they either match or they don't. **Neither does a pair whose strong anchors already agree**: identity is established and the pair is resolved deterministically at stage S8 rather than scored (ADR-029, [matching-engine.md](./matching-engine.md) §6). Tier 2 therefore only ever sees pairs where identity is genuinely *in question*, which is the correct domain for a similarity score.

Tier 2 produces a score in `[0, 1]`:

| Component | Max weight | How it's earned |
|---|---|---|
| Reference anchor | **0.30** | strong↔weak agreement: `0.30`. Near-anchor at edit distance 1 with corroboration (ADR-031): `0.24`. weak↔weak agreement: `0.20`. No comparable anchor: `0.00`. Anchors present on both sides but *unequal*: **candidate discarded outright** — a contradicted anchor is disqualifying, not merely unhelpful. |
| Amount | **0.35** | `0.35 × (1 − |delta| / tolerance_band)`, floored at 0. Exact-to-the-paisa earns full. **Scored 0 and flagged `amountUnavailable`** (not renormalized) for bank↔ledger per §5.3.1 — this caps a bank↔ledger pair at anchor + date + counterparty: `0.65` at strong↔weak anchor strength (exactly the review floor — needs a perfect same-day match and trigram similarity of `1.0`), or `0.55` at weak↔weak (never reaches the review floor at all). See ADR-064. |
| Date | **0.20** | `0.20 × (1 − days_off / window_span)`, floored at 0. Same business day earns full. |
| Counterparty | **0.15** | `0.15 × trigram_similarity(counterparty_key_a, counterparty_key_b)`. Uses `counterparty_key` (post-alias) when available, else `counterparty_norm`. |

**Why these weights and not the original 0.45/0.30/0.15/0.10 (ADR-030).** Once identity-established pairs are removed from Tier 2's domain, the old weights capped a weak-anchor pair at `0.25+0.30+0.15+0.10 = 0.80` — below the 0.85 auto-confirm line, so **nothing at Tier 2 could ever auto-confirm** and every fuzzy match would have queued for a human. The rebalanced weights produce a property worth stating plainly:

```
strong↔weak, everything else perfect  →  0.30+0.35+0.20+0.15 = 1.00   auto-confirm possible
weak↔weak,   everything else perfect  →  0.20+0.35+0.20+0.15 = 0.90   auto-confirm possible
NO anchor,   everything else perfect  →  0.00+0.35+0.20+0.15 = 0.70   auto-confirm IMPOSSIBLE
```

**A pair with no shared reference of any kind can never be auto-confirmed** — at any amount, on any date, with any name similarity. It can reach the review band and ask a human, and that is all it can ever do. This is not a tunable threshold; it falls out of the arithmetic. Amount-and-date agreement is a coincidence generator; a reference number is evidence.

**Thresholds:**

| Score | Outcome |
|---|---|
| `≥ 0.85` | `auto_confirmed` — matched at Tier 2, no human needed. |
| `0.65 – 0.849` | `pending_review` — enters the review queue. **This is the queue that feeds `learned_aliases`.** |
| `< 0.65` | Not a match. Record proceeds to Tier 3 (exception classification). |

**Ambiguity guard (overrides everything above):** if the two best candidates for a record both score `≥ 0.65` and are within `0.05` of each other, the engine **must not pick one**. It raises `AMBIGUOUS_MATCH` and records both candidates in `exceptions.evidence`. Auto-picking the marginal winner is how a reconciliation engine gets a great match rate and quietly wrong books.

The guard is evaluated **against the candidate list as scored, not as assigned** ([matching-engine.md](./matching-engine.md) §7.3): it asks "was this decidable?", and that question is about the evidence, not about which candidate happened to win the assignment pass. Together with the no-anchor ceiling above, the contradicted-anchor discard, and the direction gate (ADR-035), it is one of four structural defences against inventing a match — and it should be called out in the pitch video.

---

## 6. `learned_aliases`

### 6.1 What it is

When a human approves a `pending_review` match, they may assert *why* it was the same thing — most often "these two merchant strings are the same merchant." That assertion is stored, and on the next run the same string pair resolves without human involvement.

```sql
CREATE TABLE learned_aliases (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  alias_type           TEXT NOT NULL CHECK (alias_type IN ('merchant_name','counterparty_name','reference_id','description_token')),
  scope_source         TEXT NOT NULL DEFAULT 'any' CHECK (scope_source IN ('gateway','bank','ledger','any')),

  raw_value            TEXT NOT NULL,        -- exactly what the human saw, for display
  normalized_value     TEXT NOT NULL,        -- §3.3 normalization applied; THIS is the lookup key
  canonical_value      TEXT NOT NULL,        -- the target it resolves to (itself already normalized)

  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','revoked')),
  confirmation_count   INT  NOT NULL DEFAULT 1,   -- times a human has affirmed this same mapping
  conflict_count       INT  NOT NULL DEFAULT 0,   -- times a human asserted a DIFFERENT canonical for this key
  applied_count        INT  NOT NULL DEFAULT 0,   -- times the engine used it to resolve a match
  last_applied_at      TIMESTAMPTZ,               -- NULL: never applied yet

  created_from_match_id UUID REFERENCES matches(id),  -- NULL: created manually via the alias admin endpoint
  created_by           TEXT NOT NULL DEFAULT 'reviewer',   -- no auth in scope (ARCHITECTURE §5); a free-text label
  approved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  superseded_by        UUID REFERENCES learned_aliases(id),  -- NULL unless status='superseded'
  revoked_reason       TEXT,                                  -- NULL unless status='revoked'

  CONSTRAINT no_self_alias CHECK (normalized_value <> canonical_value)
);

-- At most ONE active mapping per (type, key, scope). This is the conflict-prevention mechanism.
CREATE UNIQUE INDEX ux_alias_active
  ON learned_aliases (alias_type, normalized_value, scope_source)
  WHERE status = 'active';

CREATE INDEX ix_alias_lookup ON learned_aliases (alias_type, normalized_value) WHERE status = 'active';
```

`created_by` is free text because auth is explicitly out of scope (ARCHITECTURE §5). **Flagged as a known limitation, not a decision to revisit now:** in a real system this would be a user FK. Adding auth to make it one is scope creep and is not being done.

### 6.2 Where the alias lookup sits in the pipeline — **Tier 1.5**

```
S4       DEDUPE         same-source duplicates, anchor evidence required (ADR-034)
   ↓
Tier 1   EXACT          strong anchor + direction + amount (§5.3.1 basis)
                        + date within THE §5.2 WINDOW FOR THAT PAIR (ADR-028)
   ↓ (no match)
Tier 1.5 ALIAS-RESOLVED apply active aliases to counterparty/reference fields,
                        then RE-RUN THE TIER 1 TEST on the resolved values
   ↓ (no match)
S8       IDENTITY       strong anchors AGREE → identity established, never scored:
                        amount fails → AMOUNT_MISMATCH · date fails → TIMING_DRIFT (ADR-029)
   ↓ (identity not established)
Tier 2   FUZZY          scored candidate search over blocked candidates (§5.4)
   ↓ (score < 0.65, or ambiguous)
Tier 3   EXCEPTION      classified (§8)
```

> **Two corrections from the Day 3 review are embedded above.** Tier 1's date test uses the per-pair window from §5.2, not a fixed `[-1,+1]` (ADR-028) — the old text would have failed every T+2 card settlement, the most common case in the dataset. And S8 exists because without it `AMOUNT_MISMATCH` and `TIMING_DRIFT` were structurally unreachable (ADR-029). Full reasoning in [matching-engine.md](./matching-engine.md) §4.2 and §6.

**Justification for placing it at 1.5 rather than inside Tier 2 or before Tier 1:**

- **Not before Tier 1.** An exact match on unmodified source values is the strongest possible evidence and requires no assumption. Running alias substitution first would mean the engine rewrites source data before ever checking whether the raw data already agreed — and every audit entry would then read "matched on transformed values," weakening the trail for records that never needed transforming. Cheapest, strongest check goes first.

- **Not inside Tier 2.** A human-confirmed equivalence is a *fact asserted by a person*, categorically different from a trigram similarity of 0.82. Folding it into the fuzzy scorer would express it as "+0.10 on the counterparty component," which is (a) too weak to flip a genuine match over the 0.85 line on its own, and (b) dishonest in the audit trail — it would report an alias-driven match as a fuzzy inference. Keeping it as its own tier means the dashboard can truthfully say *"this matched because a human previously told us AMZN is Amazon,"* which is a far better story for the panel than *"score 0.87."*

- **Why it is a *normalization* step, not a separate matching algorithm.** Tier 1.5 does not invent new comparison logic. It substitutes values and re-runs the *identical* Tier 1 predicate. That keeps the engine's rule surface small (one exact predicate, one fuzzy scorer) and makes Tier 1.5's correctness follow from Tier 1's. It also means an alias can never create a match that the exact rule would have rejected — aliases widen the *inputs*, never loosen the *test*.

- **Secondary effect in Tier 2.** Where a Tier 1.5 substitution exists but the record still fails the exact test (e.g. amount is also off), the resolved `counterparty_key` is carried into Tier 2 so the counterparty component scores on the resolved value. This is a *consequence* of Tier 1.5 having run, not a second alias rule.

### 6.3 Conflicting alias entries

Two humans (or one human on two days) assert different canonical values for the same key. The partial unique index makes the second write fail unless handled, so it is handled explicitly:

**Resolution policy — supersede-with-penalty, never silent overwrite:**

1. New assertion matches an existing active alias exactly → increment `confirmation_count`. Audit: `ALIAS_REAFFIRMED`. No new row.
2. New assertion **conflicts** (same `alias_type` + `normalized_value` + `scope_source`, different `canonical_value`) → in one transaction:
   - old row: `status = 'superseded'`, `superseded_by = <new id>`
   - new row inserted with `conflict_count = old.conflict_count + 1`, `confirmation_count = 1`
   - audit entry `ALIAS_CONFLICT_SUPERSEDED` carrying both `before_state` and `after_state`
3. **The penalty:** an alias with `conflict_count > 0` **and** `confirmation_count < 2` is **not** eligible for Tier 1.5. It is downgraded to a Tier 2 counterparty-component contribution only, which means matches relying on it land in `pending_review` and require a human again. Once a second independent human confirmation arrives (`confirmation_count ≥ 2`), it is promoted back to Tier 1.5 eligibility.
4. Revocation is available and is *not* the same as supersession: `status = 'revoked'` with a `revoked_reason`, no replacement row. Revoked aliases never apply again.

**Why last-write-wins-with-penalty rather than first-write-wins or a vote:** first-write-wins makes the system unfixable — a mistaken early approval is permanent, which is the worst property a learning loop can have. A pure vote needs a quorum that doesn't exist in a single-reviewer system. Last-write-wins alone lets one misclick silently poison auto-resolution across every future run. Supersede-with-penalty gets the correctability of last-write-wins while making the *first* contested application fall back to human review — the cost of a mistake is one extra review, not a permanently wrong book.

**No transitive chaining.** If `A → B` and `B → C` both exist, the engine resolves **one hop only**: `A → B`. It does not follow to `C`. Chaining silently merges clusters of merchants that no human ever approved together, and it makes the audit answer to "who decided these are the same?" unanswerable. One hop is always attributable to exactly one approval. A `CHECK` forbids self-aliases; a cycle `A→B, B→A` is harmless under one-hop resolution and is left unguarded rather than adding cycle-detection complexity.

### 6.4 Auditing alias writes — **reuse `audit_log`, add event types**

**Decision: reuse the existing `audit_log` shape with new `event_type` values, plus a `subject_type`/`subject_id` pair. Do not create an `alias_audit_log` table.**

Justification:

- **One timeline, one query.** The panel-facing question is *"show me everything that happened to this reconciliation."* A second log table makes that a `UNION` across two schemas with different column names, ordered by two different clocks. The `sequence_no` ordering guarantee only holds within one table.
- **The existing shape already fits.** An alias write has an actor, a timestamp, a before-state, an after-state, and a reason. Those are precisely `audit_log`'s mandatory columns. A separate table would be the same columns under a different name — duplication, not separation.
- **The one genuine gap, and its fix.** The original audit shape implicitly assumed every entry hangs off a transaction; an alias write does not. So `audit_log` carries `subject_type` (`transaction` \| `match` \| `exception` \| `alias` \| `run`) and `subject_id`, with `transaction_id` kept as a **separate nullable denormalized column** so the per-transaction trail endpoint stays a single indexed lookup rather than a polymorphic scan. That is a small, contained addition — cheaper than a second table and its second set of immutability triggers.
- **Immutability generalizes for free.** The append-only trigger already on `audit_log` covers alias history the moment alias events land there.

Every one of these produces an `audit_log` row: `ALIAS_CREATED`, `ALIAS_REAFFIRMED`, `ALIAS_APPLIED`, `ALIAS_CONFLICT_SUPERSEDED`, `ALIAS_REVOKED`, `ALIAS_DOWNGRADED` (penalty applied), `ALIAS_PROMOTED` (penalty lifted).

`ALIAS_APPLIED` fires **once per use**, inside the run — so `applied_count` is a cached aggregate that can always be rebuilt from the log. The log is the source of truth; the counter is convenience.

---

## 7. `matches` and `match_members`

A match is a **group**, not a pair.

> **Why a group with a membership table rather than a row with three nullable FKs:** three-way reconciliation with nullable `gateway_txn_id` / `bank_txn_id` / `ledger_txn_id` looks simpler and breaks on the first net-settlement batch, where five gateway payments map to one bank credit. A membership table handles 1:1:1, 1:1:0, and N:1:N with the same shape and the same queries.

```sql
CREATE TABLE matches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  tier               TEXT NOT NULL CHECK (tier IN ('exact','alias','fuzzy','batch','manual')),
  status             TEXT NOT NULL CHECK (status IN ('auto_confirmed','pending_review','human_confirmed','human_rejected')),
  confidence         NUMERIC(5,4) NOT NULL,        -- 1.0000 for exact; 0.9500 for alias; scored for fuzzy

  rule_id            TEXT NOT NULL,                -- 'EXACT_PAYMENT_ID_V1', 'FUZZY_FEE_INFERRED_V1'
  rule_version       TEXT NOT NULL,

  cardinality        TEXT NOT NULL CHECK (cardinality IN ('one_to_one','one_to_many','many_to_one')),
  amount_delta_paise BIGINT NOT NULL DEFAULT 0,    -- signed; group total vs anchor
  date_delta_days    INT    NOT NULL DEFAULT 0,    -- signed
  alias_ids          UUID[] NOT NULL DEFAULT '{}', -- which aliases contributed; empty for non-alias tiers
  score_breakdown    JSONB,                        -- NULL for exact/alias; {anchor:0.30,amount:0.33,...} for fuzzy

  matched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by        TEXT,                         -- NULL until a human acts
  reviewed_at        TIMESTAMPTZ,                  -- NULL until a human acts
  review_note        TEXT                          -- NULL unless the reviewer typed one
);

CREATE TABLE match_members (
  match_id       UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('gateway','bank','ledger')),
  is_anchor      BOOLEAN NOT NULL DEFAULT false,   -- exactly one true per match: the record others were matched against
  PRIMARY KEY (match_id, transaction_id)
);

-- A transaction can belong to at most one non-rejected match per run.
CREATE UNIQUE INDEX ux_txn_single_match ON match_members (transaction_id)
  WHERE match_id IN (SELECT id FROM matches WHERE status <> 'human_rejected');
```

> Note for implementation: Postgres does not allow a subquery in a partial-index predicate. The single-match invariant is therefore enforced by a `BEFORE INSERT` trigger on `match_members` instead. Recorded here so a later session doesn't waste twenty minutes discovering it — the intent is the constraint above; the mechanism is a trigger.

`confidence` is `1.0000` for exact and a **fixed `0.9500`** for alias — high, but deliberately not 1.0. An alias match rests on a human assertion about equivalence, which is one inference removed from a byte-exact identity match. The 0.05 gap makes that visible in the UI and in the metrics.

---

## 8. `exceptions` and the taxonomy

```sql
CREATE TABLE exceptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  transaction_id         UUID REFERENCES transactions(id),   -- NULL: group-level exception (e.g. an unsplittable batch)
  related_transaction_ids UUID[] NOT NULL DEFAULT '{}',       -- other records involved (duplicate partner, rival candidates)

  category               TEXT NOT NULL CHECK (category IN (
                           'DUPLICATE_RECORD','AMBIGUOUS_MATCH','MISSING_IN_BANK','MISSING_IN_LEDGER',
                           'MISSING_IN_GATEWAY','AMOUNT_MISMATCH','TIMING_DRIFT','UNSPLITTABLE_BATCH')),
  secondary_flags        TEXT[] NOT NULL DEFAULT '{}',        -- other categories that also applied, in precedence order
  severity               TEXT NOT NULL CHECK (severity IN ('high','medium','low')),

  best_candidate_score   NUMERIC(5,4),      -- NULL: no candidate was found at all
  amount_at_risk_paise   BIGINT,            -- ADR-044: drives severity escalation. NULL for group-level exceptions with no single amount.
  requires_human_confirmation BOOLEAN NOT NULL DEFAULT false,  -- true for SUSPECTED_DUPLICATE (ADR-034)
  evidence               JSONB NOT NULL,    -- candidates considered + per-candidate rejection reason
  detected_by_rule       TEXT NOT NULL,
  rule_version           TEXT NOT NULL,

  explanation_text       TEXT,              -- NULL until the explain layer runs
  explanation_source     TEXT CHECK (explanation_source IN ('llm','template','llm_cache')),
  signature_hash         CHAR(64),          -- NULL until the explain layer runs; FK-ish to explanation_cache
  suggested_action       TEXT,              -- NULL until the explain layer runs

  status                 TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','explained','human_resolved','wont_fix')),
  resolved_by            TEXT,              -- NULL until a human acts (ADR-043)
  resolved_at            TIMESTAMPTZ,       -- NULL until a human acts
  resolution_note        TEXT,              -- NULL until a human acts; REQUIRED when they do
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_exc_run_category ON exceptions (run_id, category);
CREATE INDEX ix_exc_run_severity ON exceptions (run_id, severity, amount_at_risk_paise DESC);
```

**`evidence` is mandatory and is the heart of the honest exception list.** It records what the engine *tried*:

```json
{
  "candidates_considered": 3,
  "candidates": [
    { "transaction_id": "…", "source": "bank", "score": 0.61,
      "rejected_because": "amount delta ₹412.00 exceeds band ₹100.00" },
    { "transaction_id": "…", "source": "bank", "score": 0.58,
      "rejected_because": "date delta +5d exceeds window [-1,+3]" }
  ],
  "anchor_strength": "weak",
  "aliases_attempted": ["…uuid…"],
  "window_used": { "amount_band_paise": 10000, "date_window": [-1, 3] },
  "candidate_cap_hit": false,
  "severity_basis": { "base": "high", "amount_at_risk_paise": 41200, "escalated": false }
}
```

Additional evidence keys, populated by the stage that raised the exception:

| Key | Set by | Meaning |
|---|---|---|
| `candidateCapHit` | blocking (ADR-033) | The 200-candidate cap bound. A bounded search that silently truncates is a dishonest search, so this is surfaced in the UI. |
| `wouldMatchIfWindowWidened` | S8 identity (ADR-029) | The actual date delta on a `TIMING_DRIFT`, so a reviewer can confirm it in one click. |
| `searchExhausted` | S10 batch (ADR-038) | The whole bounded subset space was searched and no decomposition exists. |
| `searchBoundExceeded` | S10 batch (ADR-038) | The search hit a pool, size or time bound. **A different claim from the row above**, and the exception list says which. |
| `candidateSubsets` | S10 batch | Two or more valid decompositions were found; arithmetic cannot choose. |
| `displacedByMatchId` | S9 assignment (ADR-032) | The counterpart went to a stronger claim, naming the winner and its score. |
| `counterpartStatus` | classification | e.g. the ledger row exists but is `void` — so "missing" is qualified rather than asserted. |

Anyone can then ask "why wasn't this matched?" and get a rule-level answer without the LLM being involved at all. The LLM narrates this object; it never generates it.

### 8.1 The taxonomy — eight categories

ARCHITECTURE §4.4 names five buckets. I'm shipping **eight**: the five as specified, plus three additions. The three are flagged explicitly below as decisions I made, so they can be cut if you disagree.

| # | Category | Definition | Severity | In ARCHITECTURE? |
|---|---|---|---|---|
| 1 | `DUPLICATE_RECORD` | Two+ rows in the **same source** represent one economic event (same strong anchor, or same amount+date+counterparty within the same source). | high | ✅ yes |
| 2 | `AMBIGUOUS_MATCH` | Two+ candidates in the target source score ≥0.65 within 0.05 of each other. The engine refuses to choose. | high | ➕ **added** |
| 3 | `MISSING_IN_BANK` | Gateway record, `status=captured`, older than its settlement window, with no bank candidate at any score. | high | ✅ yes |
| 4 | `MISSING_IN_LEDGER` | Gateway and/or bank record with no ledger counterpart. | medium | ✅ yes |
| 5 | `MISSING_IN_GATEWAY` | Bank credit or ledger entry with no gateway counterpart. | medium | ➕ **added** |
| 6 | `AMOUNT_MISMATCH` | Identity **established** (strong anchor agrees) but amounts differ beyond §5.1/§5.3. | high | ✅ yes |
| 7 | `UNSPLITTABLE_BATCH` | A bank `SETTLEMENT` credit that plausibly nets N gateway payments, but no subset sums to it within tolerance, and no breakup file exists. | medium | ➕ **added** |
| 8 | `TIMING_DRIFT` | Identity established, amounts agree, but the date sits outside the §5.2 window. | low | ✅ yes |

### 8.1.1 Severity is computed, not fixed (ADR-044)

The column above gives the **base** severity. Actual severity escalates with money at risk:

```
severity = escalate(base, amount_at_risk_paise)

  amount_at_risk ≥ ₹2,00,000  →  high
  amount_at_risk ≥   ₹50,000  →  one level up from base
  otherwise                   →  base

  TIMING_DRIFT is capped at `medium` regardless of amount.
```

A fixed-per-category severity made a ₹5 rounding mismatch and a ₹5,00,000 partial capture both `high`, which makes the primary screen's sort order useless. A finance controller triages by money at risk — and the exception list is the product, so its default ordering is a product decision, not a cosmetic one. Timing drift is capped because a late settlement is a process artifact at any size. The inputs are recorded in `evidence.severityBasis` so the sort order is always explainable.

**Justification for the three additions** (per the constraint to flag rather than silently expand):

- `MISSING_IN_GATEWAY` is not scope creep — it is the **symmetric half** of a bucket ARCHITECTURE already has. Reconciliation runs in both directions; a bank credit with no gateway record has to land somewhere, and forcing it into `MISSING_IN_LEDGER` would be a lie in the data. Without it, orphan bank rows are unclassifiable.
- `AMBIGUOUS_MATCH` is required by the §5.4 ambiguity guard. If the engine refuses to pick between two candidates, that refusal needs a category. Calling it `MISSING_IN_BANK` when two bank candidates were found would be actively false.
- `UNSPLITTABLE_BATCH` is required by the `NET_SETTLEMENT_BATCH` defect, which is one of the designed genuinely-unresolvable classes. It could be folded into `AMBIGUOUS_MATCH`, but it has a distinct root cause and a distinct (non-)remedy, and it is one of the more impressive things to point at in a demo — the engine correctly identifying what it *cannot* do.

**If you want to cut back to five,** cut `UNSPLITTABLE_BATCH` first (fold into `AMBIGUOUS_MATCH`) and keep the other two — those two are structurally load-bearing.

### 8.2 Precedence — first match wins, single primary, rest as flags

Every record is evaluated against the eight rules **in the order below**. The first that fires becomes `category`. Every subsequent rule that also fires is appended to `secondary_flags`. A record therefore always has exactly one primary category and a complete record of its other properties.

```
1. DUPLICATE_RECORD
2. AMBIGUOUS_MATCH
3. UNSPLITTABLE_BATCH
4. AMOUNT_MISMATCH        ← above presence since ADR-062; see below
5. MISSING_IN_GATEWAY  ┐
6. MISSING_IN_BANK     ├─ the "presence" class (mutually exclusive per leg)
7. MISSING_IN_LEDGER   ┘
8. TIMING_DRIFT
```

**Why this order:**

- **Duplicates first, unconditionally.** A duplicate changes the *cardinality* of the problem. If one gateway event appears twice and the bank shows one credit, evaluating presence first yields a spurious `MISSING_IN_BANK` for the second copy — the engine would report a missing bank record that never should have existed. Deduplication must logically precede every other question.
- **Ambiguity before presence.** "We found two candidates and won't choose" and "we found none" are opposite failures. Ambiguity must claim the record first or the exception list understates what the engine actually saw.
- **Unsplittable batch before presence,** for the same reason: its member payments would each otherwise be reported as `MISSING_IN_BANK`, turning one honest exception into five misleading ones. Claiming them as a batch-level exception keeps the count truthful.
- **Presence and value are mutually exclusive *within a leg*, and that is enforced, not ordered.** You cannot have an amount disagreement with a record that isn't there. The discriminator is `anchor_strength` + candidate existence: **if no candidate shares an identity anchor, it is a presence problem; if a candidate's anchor agrees but its value doesn't, it is a value problem.** `classify.ts` applies this directly — an established identity suppresses the presence signal for that leg — so the two can never compete over the same counterpart.

- **Across legs, value outranks presence (ADR-062).** A record has up to two legs, and the precedence order is applied per *record*. A gateway payment can have a proved ₹412 discrepancy against the bank **and** no ledger entry at all: both true, about different counterparts, and the original order made the bookkeeping gap the headline. Because severity is computed from the primary category (ADR-044), that filed a proven money discrepancy as `medium` instead of `high` — the exact downgrade the next bullet warns about. `AMOUNT_MISMATCH` therefore sits above the presence class.
- **Amount before timing.** A record can be both off-amount and off-date. Money discrepancy has financial consequence; date drift is usually a process artifact. `AMOUNT_MISMATCH` primary, `TIMING_DRIFT` in `secondary_flags`. Reversing this would let a real money problem be reported as a low-severity scheduling quirk.
- **Timing drift last** because it is the weakest deviation — identity and amount both agree, only the calendar disagrees. It is the category most likely to be a false alarm and is severity `low` for that reason.

**Worked overlaps:**

| Situation | Primary | Secondary flags |
|---|---|---|
| Same `payment_id` twice in gateway; bank shows one credit | `DUPLICATE_RECORD` on the non-primary copy only | **none** |
| Anchor agrees, amount off ₹400, date off 5 days | `AMOUNT_MISMATCH` | `TIMING_DRIFT` |
| Two bank credits, both ₹5,000, both T+2, no RRN on either | `AMBIGUOUS_MATCH` | — |
| Bank `MISC_CREDIT`, `anchor_strength = none` | `MISSING_IN_GATEWAY` | — |
| Ledger row present, gateway present, bank absent past T+3 | `MISSING_IN_BANK` | `TIMING_DRIFT` if within +4/+5 |
| Three anchorless bank rows, same amount, same day, same merchant | `AMBIGUOUS_MATCH` — **not** duplicates (ADR-034) | — |
| Gateway `refunded` debit with no bank debit | `MISSING_IN_BANK` | — |

**Correction to the first row (ADR-034).** It previously read `DUPLICATE_RECORD` primary with `MISSING_IN_BANK` secondary. That secondary flag was wrong: the bank is not missing anything — the second copy never existed as an economic event, and reporting a missing counterpart for it is exactly the "one honest exception becomes several misleading ones" failure that this precedence order exists to prevent. Deduplication runs *before* matching (stage S4), so the non-primary copy never enters the pool and never generates a presence finding at all.

---

## 9. `audit_log`

```sql
CREATE TABLE audit_log (
  -- One sequence, not two. The Day 2 draft had both `id BIGSERIAL PRIMARY KEY` and
  -- `sequence_no ... IDENTITY`, which are the same thing under two names.
  sequence_no    BIGSERIAL PRIMARY KEY,                -- deterministic replay order
  run_id         UUID REFERENCES runs(id),             -- NULL: alias admin actions outside any run

  event_type     TEXT NOT NULL,                        -- see catalogue below
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('transaction','match','exception','alias','run','investigation')),
  subject_id     UUID NOT NULL,
  transaction_id UUID REFERENCES transactions(id),     -- denormalized; NULL for alias/run-level events

  actor_type     TEXT NOT NULL CHECK (actor_type IN ('engine','human','llm','agent')),
  actor_id       TEXT NOT NULL,                        -- 'matching-engine@v1', 'reviewer', 'gemini-3.7-flash'

  tier           TEXT,        -- NULL for non-matching events
  rule_id        TEXT,        -- NULL for non-rule-driven events
  rule_version   TEXT,        -- NULL likewise
  decision       TEXT,        -- 'matched' | 'rejected' | 'flagged' | 'classified' | 'explained' | ...
  confidence     NUMERIC(5,4),-- NULL where confidence is not meaningful

  before_state   JSONB,       -- NULL for creation events
  after_state    JSONB,       -- NULL for pure-read events (e.g. ALIAS_APPLIED)
  reason         TEXT NOT NULL,  -- always human-readable, always populated
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Tamper-evidence (ADR-042). Chained per run; the first entry of a run has prev_hash = 64 zeros.
  prev_hash      CHAR(64) NOT NULL,
  entry_hash     CHAR(64) NOT NULL,

  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_audit_txn  ON audit_log (transaction_id, sequence_no);
CREATE INDEX ix_audit_run  ON audit_log (run_id, sequence_no);
CREATE INDEX ix_audit_subj ON audit_log (subject_type, subject_id, sequence_no);

-- Immutability is enforced, not assumed.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  -- OLD.sequence_no, not OLD.id: the two id columns were consolidated into one
  -- (see the comment on the table above). Referencing OLD.id here raises
  -- "record OLD has no field id" at trigger time rather than at migration time,
  -- so the trigger would appear to install correctly and then fail on first use.
  RAISE EXCEPTION 'audit_log is append-only (attempted % on sequence_no %)',
    TG_OP, OLD.sequence_no
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
```

**Mandatory per entry** (ARCHITECTURE §6 asks exactly this): `event_type`, `subject_type`, `subject_id`, `actor_type`, `actor_id`, `reason`, `occurred_at`, `prev_hash`, `entry_hash`. Never write an entry with a placeholder `reason` — a log that says "processed" is not an audit trail.

### 9.0 The hash chain (ADR-042)

```
entry_hash = sha256( canonical_json(entry minus prev_hash/entry_hash) || prev_hash )
```

`canonical_json` sorts object keys and serializes timestamps as ISO-8601 UTC, so the hash is stable across drivers and platforms. Entries are chained **per run**, in `sequence_no` order; the first entry of a run chains from 64 zeros. Alias-admin entries with `run_id IS NULL` form their own chain.

**Why, given the trigger already exists.** The `BEFORE UPDATE OR DELETE` trigger stops tampering *through the application*. Anyone who can drop the trigger can rewrite history, and nothing in the table would show it. A chain converts that from undetectable to detectable: altering one entry invalidates every subsequent `entry_hash`, and `GET /api/runs/:runId/audit/verify` recomputes the chain and reports the first divergence. That is the difference between "we don't update this table" and "logged immutably", which is what ARCHITECTURE §4.6 actually claims — and in a finance context it is the claim a panelist will probe. It costs roughly fifteen lines, and verifying the chain live during the pitch is a much stronger demonstration than describing a trigger.

Writing is strictly serialized within a run (single writer, single process — see ADR-024 and [matching-engine.md](./matching-engine.md) §1), so there is no concurrent-append race to resolve. The verification endpoint is read-only and can run at any time.

### 9.1 Event type catalogue

| Group | Events |
|---|---|
| Run | `RUN_STARTED`, `RUN_COMPLETED`, `RUN_FAILED` |
| Ingestion | `RECORD_INGESTED`, `RECORD_NORMALIZED`, `RECORD_EXCLUDED` (failed/draft/void/bank-fee), `RECORD_REJECTED` (unparseable — ADR-046), `RECORD_DEDUPLICATED` (ADR-034) |
| Matching | `MATCH_ATTEMPTED`, `MATCH_CONFIRMED_EXACT`, `MATCH_CONFIRMED_ALIAS`, `MATCH_CONFIRMED_FUZZY`, `MATCH_CONFIRMED_NEAR_ANCHOR`, `MATCH_FLAGGED_FOR_REVIEW`, `MATCH_CANDIDATE_REJECTED`, `MATCH_CANDIDATE_DISPLACED` (lost assignment to a stronger claim — ADR-032), `IDENTITY_ESTABLISHED` (ADR-029), `BATCH_DECOMPOSITION_ATTEMPTED` (ADR-038) |
| Human review | `MATCH_APPROVED_BY_HUMAN`, `MATCH_REJECTED_BY_HUMAN`, `MATCH_CREATED_BY_HUMAN` (ADR-043) |
| Exceptions | `EXCEPTION_RAISED`, `EXCEPTION_CLASSIFIED`, `EXCEPTION_RESOLVED_BY_HUMAN`, `EXCEPTION_DISMISSED_BY_HUMAN` (ADR-043) |
| Explain layer | `EXPLANATION_GENERATED`, `EXPLANATION_CACHE_HIT`, `EXPLANATION_FALLBACK_TEMPLATE` |
| Aliases | `ALIAS_CREATED`, `ALIAS_REAFFIRMED`, `ALIAS_APPLIED`, `ALIAS_CONFLICT_SUPERSEDED`, `ALIAS_REVOKED`, `ALIAS_DOWNGRADED`, `ALIAS_PROMOTED` |
| Scoring | `SCORE_REPORT_RECORDED` (ADR-041 — the offline scorer posting a measurement; `actor_type = 'human'`, `actor_id = 'tools/score'`) |
| Analyst (Phase A) | `INVESTIGATION_STARTED`, `AGENT_STEP`, `AGENT_TOOL_CALLED`, `INVESTIGATION_CONCLUDED`, `AGENT_GROUNDING_FAILED`, `AGENT_BUDGET_EXHAUSTED`, `AGENT_PROPOSAL_ACCEPTED`, `AGENT_PROPOSAL_DECLINED`, `AGENT_QUESTION_ANSWERED` (ADR-052; `actor_type = 'agent'`, `actor_id = 'analyst@1.0.0'`) |

**Agent traces live here rather than in a parallel table** (ADR-052) — the same argument ADR-014 made for aliases: one timeline, one query, and `sequence_no` ordering only holds within one table. The payoff is that agent reasoning is hash-chained and tamper-evident for free, which is a far stronger claim than a trace in an ordinary table. Adding `'agent'` and `'investigation'` to the CHECK constraints above is a one-line `ALTER`, which is exactly why §0 chose CHECK over native enum types.

`RUN_STARTED` is the anchor of a run's chain and its `details` carry the **full resolved `config_snapshot`, the three `input_file_hashes` and the `reference_date`**. That single immutable entry is what makes a reported number reproducible by a sceptic: it fixes the configuration and the exact bytes it ran against, inside a tamper-evident structure, before any decision was made.

`MATCH_CANDIDATE_REJECTED` is logged at `details`-level only for candidates that scored ≥0.40 — logging every pairwise rejection at 300 records would produce ~90,000 rows of noise and drown the trail. The 0.40 floor keeps "near misses" (the interesting ones) while discarding obvious non-candidates. Below-floor rejections are still summarized in `exceptions.evidence.candidates_considered`.

---

## 10. `explanation_cache` and the LLM explain layer

ARCHITECTURE §6 folds prompt design into this doc. Here it is.

### 10.1 The hard boundary

**The LLM never decides anything.** It receives a decision already made by deterministic rules and writes a sentence about it. Match/no-match, category, and severity are all rule outputs. This is stated in the system prompt, enforced by the fact that the explain layer runs *after* `exceptions` rows are already committed, and is the reason a measured accuracy number means anything at all — accuracy is a property of the rules, and the rules are deterministic and reproducible from `config_snapshot`.

If the LLM API is unavailable, the run **still completes**, with `explanation_source = 'template'`. The explain layer is never on the critical path.

### 10.2 Discrepancy signatures — the cost mechanism

The naive design is one call per exception. At 300 records with ~25% exceptions that's ~75 calls per run, and it re-pays for every re-run and every demo.

Instead, each exception is reduced to a **signature**: the structural shape of the discrepancy with all specifics stripped out.

```
signature = sha256(join('|', [
  prompt_version,            // 'v1'
  model,                     // 'gemini-3.5-flash' — a model change must invalidate the cache
  category,                  // 'AMOUNT_MISMATCH'
  amount_delta_bucket,       // 'none' | 'lt_1pct' | '1_to_3pct' | '3_to_10pct' | 'gt_10pct' | 'sign_flip'
  date_delta_bucket,         // 'same_day' | 'within_window' | 'plus_1_3d' | 'plus_4_7d' | 'gt_7d' | 'negative'
  sources_present,           // 'gateway+ledger' | 'bank_only' | 'gateway+bank+ledger'
  anchor_strength,           // 'strong' | 'weak' | 'none'
  alias_involved,            // 'yes' | 'no'
  candidate_count_bucket,    // '0' | '1' | '2_3' | 'gt_3'
  secondary_flags_sorted     // 'TIMING_DRIFT'
]))
```

No amounts, no IDs, no merchant names enter the signature. Across a 300-record batch the ~75 exceptions collapse to an expected **15–30 distinct signatures**, and across re-runs of the same dataset shape the cache hit rate approaches 100%. **Cost becomes O(distinct discrepancy shapes), not O(exceptions)** — which is the property that makes re-running the full batch (as the track demands) free rather than something to avoid.

The `model` name is part of the hashed input alongside `prompt_version` — switching models must invalidate the cache, or a run would silently serve prose written by a model it no longer uses.

```sql
CREATE TABLE explanation_cache (
  signature_hash   CHAR(64) PRIMARY KEY,
  prompt_version   TEXT NOT NULL,
  model            TEXT NOT NULL,          -- 'gemini-3.5-flash'
  category         TEXT NOT NULL,
  signature_input  JSONB NOT NULL,         -- the pre-hash components, for debugging and for the UI
  explanation_text TEXT NOT NULL,
  suggested_action TEXT NOT NULL,
  tokens_in        INT,                    -- NULL for template-sourced rows
  tokens_out       INT,
  hit_count        INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Cache invalidation is by `prompt_version` — bump it and every signature re-resolves. No TTL; a deterministic input should not expire on a clock.

### 10.3 Batching

1. Group the run's exceptions by `signature_hash`.
2. Drop signatures already in `explanation_cache` at the current `prompt_version` (increment `hit_count`, log `EXPLANATION_CACHE_HIT`).
3. Batch the remaining **up to 10 signatures per request** in one structured JSON call.
4. Parse the JSON array back, write to `explanation_cache`, fan the text out to every exception sharing that signature.
5. Hard cap `LLM_MAX_CALLS_PER_RUN` (default **8**). Beyond it, remaining signatures get template explanations and log `EXPLANATION_FALLBACK_TEMPLATE`. A runaway loop cannot produce a surprise bill.

Why 10 per request: the output is ~90 tokens per signature, so 10 keeps the response near 1K output tokens — comfortably inside a single response with no truncation risk, while cutting request count 10×. Larger batches raise the cost of a single malformed-JSON retry.

Model: **`gemini-3.5-flash`** (`GEMINI_EXPLAIN_MODEL`), `temperature: 0`, structured output via `response_format: { type: 'text', mime_type: 'application/json', schema }` (ADR-080). This is a bounded, schema-constrained generation task and the model is chosen for prose quality at a volume of ≤8 requests per run, not for throughput.

**The economy here is ADR-018's signature collapse, not any provider's prompt caching.** ~75 exceptions become 15–30 distinct signatures become ≤8 requests; that is a property of the batching and it holds on any provider. Earlier drafts of this section leaned on an Anthropic-specific cacheable prefix — **no design may depend on that now** (ADR-080 consequence 4). The static system prompt is still sent once per batch and is still small; it is simply not assumed to be discounted.

### 10.4 Prompt design

**System prompt (static, cached, `prompt_version: v1`):**

> You are the explanation layer of a payment reconciliation engine. A deterministic rule engine has already decided that a record could not be reconciled and has already assigned its exception category. Your only job is to explain that decision in plain English to a finance operations analyst.
>
> Rules you must follow:
> 1. Never dispute, revise, or second-guess the category you are given. It is already final.
> 2. Never invent amounts, dates, merchant names, or reference numbers. You will be given ranges and structural facts, never specifics — write at that level of generality.
> 3. Write for a finance analyst, not an engineer. No jargon, no rule IDs, no confidence scores.
> 4. Two to three sentences maximum for the explanation. One sentence for the suggested action.
> 5. The suggested action must be something a human can actually do. If the record is genuinely unresolvable from the data available, say so plainly instead of inventing a next step.
> 6. Respond only with the specified JSON. No preamble.
>
> [Category definitions table — the eight categories from §8.1 with their one-line definitions]

**User message (per batch):**

```json
{ "signatures": [
  { "id": "sig_1", "category": "AMOUNT_MISMATCH",
    "amount_delta": "3_to_10pct", "date_delta": "within_window",
    "sources_present": "gateway+bank", "anchor_strength": "strong",
    "alias_involved": "no", "candidate_count": "1", "secondary_flags": ["TIMING_DRIFT"],
    "occurrence_count": 14 }
] }
```

**Expected response:**

```json
{ "explanations": [
  { "id": "sig_1",
    "explanation": "The gateway and bank records refer to the same payment — their reference numbers agree — but the settled amount differs from the captured amount by more than rounding would account for. The settlement also landed a day or two later than usual, which on its own is normal.",
    "suggested_action": "Check whether a partial capture or a post-authorization adjustment was applied to this payment." } ] }
```

`occurrence_count` is passed so the model can pitch the wording at a recurring pattern rather than a one-off, and so the UI can honestly say "this explanation covers 14 exceptions."

**Failure handling:** malformed JSON → one retry at the same temperature → on second failure, template fallback for that batch, `EXPLANATION_FALLBACK_TEMPLATE` logged. There is a hand-written template string per category as the floor, so `explanation_text` is never null on a completed run.

---

## 11. Metrics

### 11.0 The split, and why it exists (ADR-041)

The Day 2 draft put `precision`, `recall`, `false_positive_matches` and `measured_against: "ground_truth/…"` inside `runs.metrics` — a column the **API** writes. That would have required the API to read the answer key, in direct contradiction of ADR-021, the rule that makes every accuracy claim in this project meaningful. As specified, the object could not have been produced by anything.

Metrics are therefore two separate things in two separate tables, and the separation is the honest expression of what they are:

| | `runs.metrics` | `score_reports` |
|---|---|---|
| Written by | the engine, at run finalization | `tools/score/`, offline, via `POST /api/runs/:runId/score-report` |
| Contains | what the engine did | how right it was |
| Knows about ground truth | **never** | that is its entire job |
| If the two disagree | `score_reports` is correct | — |

`runs.metrics` is the engine's account of its own work. `score_reports` is an independent measurement of that work. Merging them would produce a single object where nobody can tell which numbers were graded and which were self-reported — and the difference between those two things is the whole thesis of the track's bar.

### 11.1 `runs.metrics` — engine-computed

```json
{
  "match_rate": {
    "match_rate_pct": 82.4,
    "matched_records": 670,
    "reconcilable_records": 813,
    "denominator_note": "ingested − excluded − rejected_rows − non_primary_duplicates (ADR-040)",
    "pending_review_excluded": 11
  },
  "cold_start": { "match_rate_pct": 74.1, "aliases_active_at_start": 0 },
  "tier_attribution": { "exact": 168, "alias": 27, "identity_established": 31, "fuzzy": 52, "near_anchor": 6, "batch": 4, "manual": 0, "unmatched": 65 },
  "alias_learning": {
    "human_corrections_to_date": 9,
    "records_auto_resolved_by_aliases": 27,
    "leverage_ratio": 3.0,
    "aliases_active": 9, "aliases_superseded": 1, "aliases_revoked": 0
  },
  "review_burden": { "pending_review_count": 11, "per_100_records": 1.3 },
  "exceptions": {
    "by_category": { "AMOUNT_MISMATCH": 18, "MISSING_IN_BANK": 21, "…": 0 },
    "by_severity": { "high": 45, "medium": 15, "low": 5 },
    "candidate_cap_hits": 3,
    "batch_search_exhausted": 5, "batch_search_bound_exceeded": 2
  },
  "population": { "ingested": 850, "excluded": 27, "rejected_rows": 1, "non_primary_duplicates": 9, "reconcilable": 813 },
  "throughput": {
    "records_per_sec_engine": 412.0,
    "records_per_sec_wall_clock": 96.5,
    "stage_ms": { "parse": 180, "normalize": 90, "dedupe": 20, "block": 35, "tier1": 60, "tier15": 25, "identity": 15, "tier2": 940, "batch": 310, "group": 40, "classify": 120 },
    "note": "engine excludes LLM latency; wall_clock includes it"
  },
  "llm_cost": { "distinct_signatures": 22, "api_calls": 3, "cache_hits": 53, "tokens_in": 4180, "tokens_out": 1960 }
}
```

`stage_ms` is new and earns its place: throughput is a judged axis, and a per-stage breakdown turns "412 rec/s" into a claim about *where the time goes* — which is also how the scale benchmark (ADR-045) shows that the blocking strategy works.

### 11.2 `score_reports` — measured against ground truth

```sql
CREATE TABLE score_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  truth_key_file    TEXT NOT NULL,          -- 'data/truth/holdout_seed_90210.json'
  truth_key_hash    CHAR(64) NOT NULL,      -- must match the run's input_file_hashes manifest
  scorer_version    TEXT NOT NULL,
  scored_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  report            JSONB NOT NULL,         -- the full measurement (shape below)

  UNIQUE (run_id, scorer_version, truth_key_hash)
);

CREATE INDEX ix_score_run ON score_reports (run_id, scored_at DESC);
```

```json
{
  "matching": { "precision": 0.976, "recall": 0.847, "f1": 0.907,
                "true_positives": 661, "false_positives": 5, "false_negatives": 119 },
  "classification": { "macro_precision": 0.91, "macro_recall": 0.88,
                      "confusion_matrix": { "AMOUNT_MISMATCH": { "AMOUNT_MISMATCH": 16, "TIMING_DRIFT": 2 } },
                      "secondary_flag_jaccard": 0.84 },
  "by_difficulty": { "EASY": 0.99, "MEDIUM": 0.91, "HARD": 0.62 },
  "resolvability": { "unresolvable_designed": 21, "unresolvable_recall": 1.0, "false_despair_rate": 0.14 },
  "alias": { "alias_tier_precision": 1.0, "held_out_variants_learned": 4 },
  "ceiling": { "theoretical_max_match_rate_pct": 93.0, "achieved_pct": 82.4 }
}
```

`truth_key_hash` is checked against the run's `input_file_hashes` manifest before the report is accepted; a mismatch is rejected with `422`. Scoring a run against a key built from different bytes is a mistake you want to be *impossible*, not one you want to notice late.

**The engine never reads this table.** It is written by one endpoint and read by the dashboard and the accuracy report. ADR-021's guarantee — no ground truth anywhere in the decision path — is unchanged and is still enforced by the grep in `validation-strategy.md`.

### 11.3 `agent_investigations` and `agent_questions` — Phase A

```sql
CREATE TABLE agent_investigations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  exception_id       UUID NOT NULL REFERENCES exceptions(id) ON DELETE CASCADE,

  status             TEXT NOT NULL CHECK (status IN ('running','concluded','failed')),
  verdict            TEXT CHECK (verdict IN ('RESOLUTION_PROPOSED','CONFIRMED_UNRESOLVABLE',
                                             'NEEDS_EXTERNAL_DATA','INSUFFICIENT_EVIDENCE')),
  confidence         TEXT CHECK (confidence IN ('high','medium','low')),  -- a LABEL, never a number

  proposed_action    JSONB,          -- NULL unless verdict = RESOLUTION_PROPOSED
  reasoning          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ordered steps: tool, args, digest, inference
  citations          UUID[] NOT NULL DEFAULT '{}',        -- ids the agent actually retrieved (A3-verified)

  grounding_passed   BOOLEAN NOT NULL DEFAULT false,
  grounding_failure  TEXT,           -- NULL unless the A3 gate rejected it
  budget_exhausted   BOOLEAN NOT NULL DEFAULT false,

  steps              INT NOT NULL DEFAULT 0,
  tool_calls         INT NOT NULL DEFAULT 0,
  tokens_in          INT, tokens_out INT, cost_usd NUMERIC(8,4),
  model              TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,

  human_disposition  TEXT CHECK (human_disposition IN ('accepted','declined')),  -- NULL until a human acts
  resulting_match_id UUID REFERENCES matches(id),   -- NULL unless accepted into a manual match
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ
);

CREATE INDEX ix_inv_run     ON agent_investigations (run_id, verdict);
CREATE INDEX ix_inv_exc     ON agent_investigations (exception_id);
CREATE UNIQUE INDEX ux_inv_exc_active ON agent_investigations (exception_id)
  WHERE status <> 'failed';   -- one live investigation per exception

CREATE TABLE agent_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question      TEXT NOT NULL,
  answer        TEXT,
  citations     UUID[] NOT NULL DEFAULT '{}',
  steps         INT NOT NULL DEFAULT 0,
  tool_calls    INT NOT NULL DEFAULT 0,
  tokens_in     INT, tokens_out INT, cost_usd NUMERIC(8,4),
  grounding_passed BOOLEAN NOT NULL DEFAULT false,
  asked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**`confidence` is a text label and not a `NUMERIC(5,4)` on purpose.** The engine's confidence is computed; the agent's is asserted. Giving them the same type invites sorting, averaging and comparison between two quantities that are not the same kind of thing. Different shapes make that mistake impossible to make by accident.

`citations` is populated only after the A3 grounding gate verifies each id appeared in a tool result from this investigation (ADR-050). An unverified citation never reaches the column.

**Neither table is ever read by the engine.** Phase A runs after S14, and no module under `services/matching`, `services/classification` or `services/metrics` queries them.

### 11.4 Agent metrics

Operational figures (no ground truth) are computed from `agent_investigations` and served alongside run metrics:

```json
{ "investigationsRun": 20, "eligibleExceptions": 47,
  "verdicts": { "RESOLUTION_PROPOSED": 18, "CONFIRMED_UNRESOLVABLE": 6,
                "NEEDS_EXTERNAL_DATA": 3, "INSUFFICIENT_EVIDENCE": 3 },
  "meanSteps": 6.2, "meanToolCalls": 8.4,
  "groundingFailures": 1, "budgetExhaustions": 2,
  "costUsd": 0.61, "cachedPrefixHitRate": 0.95,
  "humanAccepted": 0, "humanDeclined": 0 }
```

Ground-truth-scored agent figures live in `score_reports` (§11.2, ADR-053) — never here, for the same reason engine accuracy doesn't.

### 11.5 Two reporting rules that are non-negotiable

1. **Never report the warm (alias-assisted) match rate as if it were the cold one.** Both numbers ship, always labelled. A match rate that quietly includes the benefit of prior human corrections is exactly the kind of unverified number the track's bar rejects.
2. **`false_positives` is reported alongside match rate every time.** An 82% match rate with 5 wrong matches is worse than a 78% rate with 0, and the dashboard must make that comparison possible rather than hiding it behind a single headline percentage. Because false positives now live in `score_reports`, the API composes the two objects for the dashboard (`GET /api/runs/:runId/metrics` returns both) — the pairing is enforced at the contract level so no UI decision can separate them.
3. **A `pending_review` match is not a match** (ADR-040). It is a proposal, counted in `review_burden`, never in `match_rate`. Counting proposals as reconciliations puts work a human hasn't done into the headline number.
4. **Manual matches are excluded from engine match rate** (ADR-043) and reported in `tier_attribution.manual`. A human fixing something is not the engine matching it.
5. **Agent proposals are excluded from engine match rate**, before and after human confirmation (ADR-051). An accepted proposal becomes a `manual` match, which rule 4 already excludes. A language model suggesting a fix is not the engine matching it either, and the accuracy report keeps an Engine block and an Analyst block rather than one merged figure.

---

## 12. Open / flagged items

Not decided here, deliberately:

- **Reviewer identity** — `created_by` / `reviewed_by` are free-text labels because auth is out of scope (ARCHITECTURE §5). Known limitation, not being fixed.
- **Multi-currency** — column exists, logic doesn't. Would need FX rate sourcing. **Flagged as scope creep; not doing it.**
- ~~**Alias suggestion by the LLM**~~ — **now in scope, under four stated conditions** (ADR-055). The original flag was correct for a v1 where the LLM sat inside the pipeline with no independent measurement of its output. The Analyst proposes aliases downstream of a finalized run, cannot modify engine output, requires human confirmation through an existing endpoint, and is scored against ground truth with hallucination as a build blocker. Those conditions did not exist on Day 2. §10.1's boundary — the LLM makes no decision *inside the engine* — is unchanged. See [agent-design.md](./agent-design.md).
- **Alias export/import between environments** — useful for seeding the demo. Small, but not required. Decide on Day 8 if the demo needs it.
- **Optimal (Hungarian) assignment** instead of greedy score-ordered assignment — arithmetically better, materially harder to explain in an audit trail. **Decided against**, with reasoning, in ADR-032.
- **Transitive group closure across sources** — resolved: groups assemble from pairs sharing a member, conflicts are refused rather than resolved, and group confidence is the *minimum* of its pairs. See [matching-engine.md](./matching-engine.md) §10.
- **Cycle detection in aliases** — still unguarded, still harmless under one-hop resolution (§6.3). Unchanged by the Day 3 review.
