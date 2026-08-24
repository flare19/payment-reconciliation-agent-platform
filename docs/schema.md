# Data & Schema Design

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Day 2 architecture — locked unless a decision here is explicitly revised in `adr-log.md`.**
Companion docs: [api-contract.md](./api-contract.md) · [adr-log.md](./adr-log.md) · [validation-strategy.md](./validation-strategy.md)

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
| Immutability | `audit_log` is append-only, enforced by a `BEFORE UPDATE OR DELETE` trigger that raises. | ARCHITECTURE §4.6 says "logged immutably". A convention isn't immutability; a trigger is. This is also a good 10-second answer to a panel question. |

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
```

Two tables are deliberately **run-independent**: `learned_aliases` and `explanation_cache`. Everything else is scoped to a run so a re-run never mutates history. That separation is what makes the alias-learning feature measurable across runs (see §9).

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
| `status` | `captured` \| `authorized` \| `failed` \| `refunded` | **Only `captured` and `refunded` are reconcilable.** `failed`/`authorized` must be excluded at ingestion, not matched-and-failed. |
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
| `transaction_type` | `SETTLEMENT` \| `NEFT` \| `IMPS` \| `UPI` \| `CHARGEBACK` \| `FEE` \| `MISC_CREDIT` | `CHARGEBACK`/`FEE`/`MISC_CREDIT` rows have no gateway counterpart by design. |

**Critical structural property:** a single `SETTLEMENT` row may be the **net of many gateway payments minus fees** (a batch settlement). This is the N:1 case that `match_members` exists for, and — when no batch breakup is provided — one of the genuinely-unresolvable classes (see `validation-strategy.md`).

### 2.3 Source C — Merchant Ledger (`merchant_ledger.csv`)

Models an internal accounting export. Structured, but written by humans and by a different system's conventions.

| Column | Type as emitted | Purpose / notes |
|---|---|---|
| `entry_id` | `JE-` + 6 digits | Ledger's own key. |
| `invoice_no` | `INV/2026/00123` | Business document reference. |
| `gateway_ref` | should be the `payment_id`; blank on ~12%, **transposed/typo'd on ~4%** | The intended anchor to Source A. Its unreliability is the point. |
| `customer_name` | free text, variants again | Second alias-learning surface. |
| `gross_amount` | string, rupees, format `1234.50` (no separators) | Should equal gateway `amount`. |
| `discount` | string, rupees, often `0.00` | Subtracted before tax. A source of legitimate amount divergence. |
| `tax_amount` | string, rupees | GST on the sale (distinct from GST on the gateway fee — a classic confusion this dataset should contain). |
| `net_amount` | string, rupees | `gross - discount + tax`. Note: **ledger net ≠ gateway net.** They mean different things. Do not compare them. |
| `entry_date` | `MM/DD/YYYY` | **US-format, third distinct date format.** Ambiguity between `03/04` and `04/03` is real and deliberate; generator only emits days ≥ 13 in ~30% of rows so the parser cannot cheat by inference. Parser must be told the format, not guess it. |
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
  status_norm            TEXT NOT NULL CHECK (status_norm IN ('reconcilable','excluded_failed','excluded_draft','excluded_void','excluded_authorized')),
  txn_type               TEXT,                 -- bank only: SETTLEMENT/CHARGEBACK/FEE/...

  -- freeform
  description_raw        TEXT,

  -- ingestion bookkeeping
  ingest_warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['AMOUNT_HAD_CURRENCY_SYMBOL','DATE_ASSUMED_IST',...]
  raw_payload            JSONB NOT NULL,       -- the complete original row, verbatim
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_txn_run_source        ON transactions (run_id, source_system);
CREATE INDEX ix_txn_run_date_amount   ON transactions (run_id, txn_date, amount_paise);
CREATE INDEX ix_txn_refs_gin          ON transactions USING gin (reference_ids);
CREATE INDEX ix_txn_cp_norm           ON transactions (run_id, counterparty_norm);
```

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
  record_counts     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {gateway: 312, bank: 240, ledger: 298, excluded: 27}
  config_snapshot   JSONB NOT NULL,             -- FULL tolerance + rule-version + flags snapshot
  metrics           JSONB,                      -- NULL until completed; see §9
  error_detail      TEXT                        -- NULL unless status='failed'
);
```

`config_snapshot` is mandatory and non-negotiable. It captures every tolerance value, every rule version, `alias_learning_enabled`, and the alias-table row count at run start. Without it, a run's metrics are unreproducible — and an unreproducible accuracy number is exactly what the track's bar rejects.

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
3. Never compare gateway `net_amount` to ledger `net_amount`. They are different quantities (§2.3). Comparing them is a category error that would produce plausible-looking wrong matches. Gateway↔ledger comparison always uses **gross**.

### 5.4 Confidence scoring (Tier 2 only)

Tier 1 and the alias tier do not score — they either match or they don't. Tier 2 produces a score in `[0, 1]`:

| Component | Max weight | How it's earned |
|---|---|---|
| Reference anchor | **0.45** | `strong` anchor equal after normalization: 0.45. `weak` anchor (description-extracted, `bank_ref_no`, `order_id` only): 0.25. Anchor present on both sides but *unequal*: **0.00 and the candidate is discarded outright** — a contradicted anchor is disqualifying, not merely unhelpful. |
| Amount | **0.30** | `0.30 × (1 − |delta| / tolerance_band)`, floored at 0. Exact-to-the-paisa earns the full 0.30. |
| Date | **0.15** | `0.15 × (1 − days_off / window_size)`, floored at 0. Same-day earns full. |
| Counterparty | **0.10** | `0.10 × trigram_similarity(counterparty_key_a, counterparty_key_b)`. Uses `counterparty_key` (post-alias) when available, else `counterparty_norm`. |

**Thresholds:**

| Score | Outcome |
|---|---|
| `≥ 0.85` | `auto_confirmed` — matched at Tier 2, no human needed. |
| `0.65 – 0.849` | `pending_review` — enters the review queue. **This is the queue that feeds `learned_aliases`.** |
| `< 0.65` | Not a match. Record proceeds to Tier 3 (exception classification). |

**Ambiguity guard (overrides everything above):** if the two best candidates for a record both score `≥ 0.65` and are within `0.05` of each other, the engine **must not pick one**. It raises `AMBIGUOUS_MATCH` and records both candidates in `exceptions.evidence`. Auto-picking the marginal winner is how a reconciliation engine gets a great match rate and quietly wrong books. This guard is the single strongest honesty mechanism in the matching engine and should be called out in the pitch video.

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
Tier 1   EXACT          strong anchor + amount equal + date within [-1,+1]
   ↓ (no match)
Tier 1.5 ALIAS-RESOLVED apply active aliases to counterparty/reference fields,
                        then RE-RUN THE TIER 1 TEST on the resolved values
   ↓ (no match)
Tier 2   FUZZY          scored candidate search (§5.4)
   ↓ (score < 0.65, or ambiguous)
Tier 3   EXCEPTION      classified (§8)
```

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

  tier               TEXT NOT NULL CHECK (tier IN ('exact','alias','fuzzy')),
  status             TEXT NOT NULL CHECK (status IN ('auto_confirmed','pending_review','human_confirmed','human_rejected')),
  confidence         NUMERIC(5,4) NOT NULL,        -- 1.0000 for exact; 0.9500 for alias; scored for fuzzy

  rule_id            TEXT NOT NULL,                -- 'EXACT_PAYMENT_ID_V1', 'FUZZY_FEE_INFERRED_V1'
  rule_version       TEXT NOT NULL,

  cardinality        TEXT NOT NULL CHECK (cardinality IN ('one_to_one','one_to_many','many_to_one')),
  amount_delta_paise BIGINT NOT NULL DEFAULT 0,    -- signed; group total vs anchor
  date_delta_days    INT    NOT NULL DEFAULT 0,    -- signed
  alias_ids          UUID[] NOT NULL DEFAULT '{}', -- which aliases contributed; empty for non-alias tiers
  score_breakdown    JSONB,                        -- NULL for exact/alias; {anchor:0.45,amount:0.28,...} for fuzzy

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
  evidence               JSONB NOT NULL,    -- candidates considered + per-candidate rejection reason
  detected_by_rule       TEXT NOT NULL,
  rule_version           TEXT NOT NULL,

  explanation_text       TEXT,              -- NULL until the explain layer runs
  explanation_source     TEXT CHECK (explanation_source IN ('llm','template','llm_cache')),
  signature_hash         CHAR(64),          -- NULL until the explain layer runs; FK-ish to explanation_cache
  suggested_action       TEXT,              -- NULL until the explain layer runs

  status                 TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','explained','human_resolved','wont_fix')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_exc_run_category ON exceptions (run_id, category);
CREATE INDEX ix_exc_run_severity ON exceptions (run_id, severity);
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
  "window_used": { "amount_band_paise": 10000, "date_window": [-1, 3] }
}
```

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
4. MISSING_IN_GATEWAY  ┐
5. MISSING_IN_BANK     ├─ the "presence" class (mutually exclusive in practice)
6. MISSING_IN_LEDGER   ┘
7. AMOUNT_MISMATCH
8. TIMING_DRIFT
```

**Why this order:**

- **Duplicates first, unconditionally.** A duplicate changes the *cardinality* of the problem. If one gateway event appears twice and the bank shows one credit, evaluating presence first yields a spurious `MISSING_IN_BANK` for the second copy — the engine would report a missing bank record that never should have existed. Deduplication must logically precede every other question.
- **Ambiguity before presence.** "We found two candidates and won't choose" and "we found none" are opposite failures. Ambiguity must claim the record first or the exception list understates what the engine actually saw.
- **Unsplittable batch before presence,** for the same reason: its member payments would each otherwise be reported as `MISSING_IN_BANK`, turning one honest exception into five misleading ones. Claiming them as a batch-level exception keeps the count truthful.
- **Presence before value.** You cannot have an amount disagreement with a record that isn't there. The discriminator is `anchor_strength` + candidate existence: **if no candidate shares an identity anchor, it is a presence problem; if a candidate's anchor agrees but its value doesn't, it is a value problem.** This is the rule that resolves the single most common overlap (`MISSING_IN_BANK` vs `AMOUNT_MISMATCH`) and it is stated here so it isn't re-litigated in code.
- **Amount before timing.** A record can be both off-amount and off-date. Money discrepancy has financial consequence; date drift is usually a process artifact. `AMOUNT_MISMATCH` primary, `TIMING_DRIFT` in `secondary_flags`. Reversing this would let a real money problem be reported as a low-severity scheduling quirk.
- **Timing drift last** because it is the weakest deviation — identity and amount both agree, only the calendar disagrees. It is the category most likely to be a false alarm and is severity `low` for that reason.

**Worked overlaps:**

| Situation | Primary | Secondary flags |
|---|---|---|
| Same `payment_id` twice in gateway; bank shows one credit | `DUPLICATE_RECORD` | `MISSING_IN_BANK` |
| Anchor agrees, amount off ₹400, date off 5 days | `AMOUNT_MISMATCH` | `TIMING_DRIFT` |
| Two bank credits, both ₹5,000, both T+2, no RRN on either | `AMBIGUOUS_MATCH` | — |
| Bank `MISC_CREDIT`, `anchor_strength = none` | `MISSING_IN_GATEWAY` | — |
| Ledger row present, gateway present, bank absent past T+3 | `MISSING_IN_BANK` | `TIMING_DRIFT` if within +4/+5 |

---

## 9. `audit_log`

```sql
CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  sequence_no    BIGINT GENERATED ALWAYS AS IDENTITY,  -- deterministic replay order within a run
  run_id         UUID REFERENCES runs(id),             -- NULL: alias admin actions outside any run

  event_type     TEXT NOT NULL,                        -- see catalogue below
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('transaction','match','exception','alias','run')),
  subject_id     UUID NOT NULL,
  transaction_id UUID REFERENCES transactions(id),     -- denormalized; NULL for alias/run-level events

  actor_type     TEXT NOT NULL CHECK (actor_type IN ('engine','human','llm')),
  actor_id       TEXT NOT NULL,                        -- 'matching-engine@v1', 'reviewer', 'claude-sonnet-5'

  tier           TEXT,        -- NULL for non-matching events
  rule_id        TEXT,        -- NULL for non-rule-driven events
  rule_version   TEXT,        -- NULL likewise
  decision       TEXT,        -- 'matched' | 'rejected' | 'flagged' | 'classified' | 'explained' | ...
  confidence     NUMERIC(5,4),-- NULL where confidence is not meaningful

  before_state   JSONB,       -- NULL for creation events
  after_state    JSONB,       -- NULL for pure-read events (e.g. ALIAS_APPLIED)
  reason         TEXT NOT NULL,  -- always human-readable, always populated
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_audit_txn  ON audit_log (transaction_id, sequence_no);
CREATE INDEX ix_audit_run  ON audit_log (run_id, sequence_no);
CREATE INDEX ix_audit_subj ON audit_log (subject_type, subject_id, sequence_no);

-- Immutability is enforced, not assumed.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted % on id %)', TG_OP, OLD.id;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
```

**Mandatory per entry** (ARCHITECTURE §6 asks exactly this): `event_type`, `subject_type`, `subject_id`, `actor_type`, `actor_id`, `reason`, `occurred_at`. Never write an entry with a placeholder `reason` — a log that says "processed" is not an audit trail.

### 9.1 Event type catalogue

| Group | Events |
|---|---|
| Run | `RUN_STARTED`, `RUN_COMPLETED`, `RUN_FAILED` |
| Ingestion | `RECORD_INGESTED`, `RECORD_NORMALIZED`, `RECORD_EXCLUDED` (failed/draft/void) |
| Matching | `MATCH_ATTEMPTED`, `MATCH_CONFIRMED_EXACT`, `MATCH_CONFIRMED_ALIAS`, `MATCH_CONFIRMED_FUZZY`, `MATCH_FLAGGED_FOR_REVIEW`, `MATCH_CANDIDATE_REJECTED` |
| Human review | `MATCH_APPROVED_BY_HUMAN`, `MATCH_REJECTED_BY_HUMAN` |
| Exceptions | `EXCEPTION_RAISED`, `EXCEPTION_CLASSIFIED`, `EXCEPTION_RESOLVED_BY_HUMAN` |
| Explain layer | `EXPLANATION_GENERATED`, `EXPLANATION_CACHE_HIT`, `EXPLANATION_FALLBACK_TEMPLATE` |
| Aliases | `ALIAS_CREATED`, `ALIAS_REAFFIRMED`, `ALIAS_APPLIED`, `ALIAS_CONFLICT_SUPERSEDED`, `ALIAS_REVOKED`, `ALIAS_DOWNGRADED`, `ALIAS_PROMOTED` |

`MATCH_CANDIDATE_REJECTED` is logged at `details`-level only for candidates that scored ≥0.40 — logging every pairwise rejection at 300 records would produce ~90,000 rows of noise and drown the trail. The 0.40 floor keeps "near misses" (the interesting ones) while discarding obvious non-candidates. Below-floor rejections are still summarized in `exceptions.evidence.candidates_considered`.

---

## 10. `explanation_cache` and the LLM explain layer

ARCHITECTURE §6 folds prompt design into this doc. Here it is.

### 10.1 The hard boundary

**The LLM never decides anything.** It receives a decision already made by deterministic rules and writes a sentence about it. Match/no-match, category, and severity are all rule outputs. This is stated in the system prompt, enforced by the fact that the explain layer runs *after* `exceptions` rows are already committed, and is the reason a measured accuracy number means anything at all — accuracy is a property of the rules, and the rules are deterministic and reproducible from `config_snapshot`.

If the Anthropic API is unavailable, the run **still completes**, with `explanation_source = 'template'`. The explain layer is never on the critical path.

### 10.2 Discrepancy signatures — the cost mechanism

The naive design is one call per exception. At 300 records with ~25% exceptions that's ~75 calls per run, and it re-pays for every re-run and every demo.

Instead, each exception is reduced to a **signature**: the structural shape of the discrepancy with all specifics stripped out.

```
signature = sha256(join('|', [
  prompt_version,            // 'v1'
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

```sql
CREATE TABLE explanation_cache (
  signature_hash   CHAR(64) PRIMARY KEY,
  prompt_version   TEXT NOT NULL,
  model            TEXT NOT NULL,          -- 'claude-sonnet-5'
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

Model: **`claude-sonnet-5`**, `temperature: 0`. Per ARCHITECTURE §3, Sonnet is the default engine and this is exactly the kind of bounded generation task it's for. Opus is never called at runtime.

The static system prompt is a **cacheable prefix** (Anthropic prompt caching), so the instructions and taxonomy aren't re-billed at full rate on every batch.

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

## 11. Metrics — what `runs.metrics` holds

Beyond ARCHITECTURE §4.7's match rate / throughput / exception counts, the alias-learning feature makes several more worth surfacing. Full reasoning is in the summary handed back with these docs; the shape is:

```json
{
  "accuracy": {
    "match_rate_pct": 82.4,
    "precision": 0.976, "recall": 0.847, "f1": 0.907,
    "false_positive_matches": 5,
    "measured_against": "ground_truth/holdout_seed_90210.json"
  },
  "cold_start": { "match_rate_pct": 74.1, "aliases_active_at_start": 0 },
  "tier_attribution": { "exact": 168, "alias": 27, "fuzzy": 52, "unmatched": 65 },
  "alias_learning": {
    "human_corrections_to_date": 9,
    "records_auto_resolved_by_aliases": 27,
    "leverage_ratio": 3.0,
    "alias_precision_vs_truth": 1.0,
    "aliases_active": 9, "aliases_superseded": 1, "aliases_revoked": 0
  },
  "review_burden": { "pending_review_count": 11, "per_100_records": 3.7 },
  "exceptions": {
    "by_category": { "AMOUNT_MISMATCH": 18, "MISSING_IN_BANK": 21, "…": 0 },
    "unresolvable_designed": 21, "unresolvable_detected_as_such": 19
  },
  "throughput": {
    "records_per_sec_engine": 412.0,
    "records_per_sec_wall_clock": 96.5,
    "note": "engine excludes LLM latency; wall_clock includes it"
  },
  "llm_cost": { "distinct_signatures": 22, "api_calls": 3, "cache_hits": 53, "tokens_in": 4180, "tokens_out": 1960 }
}
```

Two reporting rules that are non-negotiable:

1. **Never report the warm (alias-assisted) match rate as if it were the cold one.** Both numbers ship, always labelled. A match rate that quietly includes the benefit of prior human corrections is exactly the kind of unverified number the track's bar rejects.
2. **`false_positive_matches` is reported alongside match rate every time.** An 82% match rate with 5 wrong matches is worse than a 78% rate with 0, and the dashboard must make that comparison possible rather than hiding it behind a single headline percentage.

---

## 12. Open / flagged items

Not decided here, deliberately:

- **Reviewer identity** — `created_by` / `reviewed_by` are free-text labels because auth is out of scope (ARCHITECTURE §5). Known limitation, not being fixed.
- **Multi-currency** — column exists, logic doesn't. Would need FX rate sourcing. **Flagged as scope creep; not doing it.**
- **Alias suggestion by the LLM** — the model could propose alias candidates for a human to approve. Tempting, and it would sit cleanly on the review queue. **Flagged as scope creep for v1** — it puts the LLM adjacent to a matching decision, which §10.1 exists to prevent. Revisit only if everything else is done by Day 10.
- **Alias export/import between environments** — useful for seeding the demo. Small, but not required. Decide on Day 9 if the demo needs it.
