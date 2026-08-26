-- 003 · transactions — ONE ROW PER SOURCE ROW, not per economic event (ADR-007).
--
-- Ingestion is lossless and opinion-free: one row in, one row stored, raw_payload
-- kept verbatim. Normalizing into economic events at ingest would mean the PARSER
-- had already made the matching decision, which destroys the audit trail — you
-- could no longer show a panelist the three raw rows and the reason the engine
-- believes they are one payment.

CREATE TABLE transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  source_system          TEXT NOT NULL CHECK (source_system IN ('gateway','bank','ledger')),
  source_file            TEXT NOT NULL,
  -- Physical file position, header = row 0. The join key the answer key uses
  -- (validation-strategy §2.1) AND the canonical tie-break (ADR-032). Assigned
  -- to every row including ones later rejected or excluded, so numbering never shifts.
  source_row_number      INT  NOT NULL,

  external_id            TEXT NOT NULL,
  reference_ids          JSONB NOT NULL,
  anchor_strength        TEXT NOT NULL CHECK (anchor_strength IN ('strong','weak','none')),

  -- Money is BIGINT paise, always (ADR-006). See the type-parser note in
  -- src/db/pool.ts: pg returns BIGINT as a string by default, which makes
  -- addition concatenate.
  amount_paise           BIGINT NOT NULL,
  fee_paise              BIGINT,
  tax_paise              BIGINT,
  net_amount_paise       BIGINT,
  currency               CHAR(3) NOT NULL DEFAULT 'INR',
  direction              TEXT NOT NULL CHECK (direction IN ('credit','debit')),

  txn_date               DATE NOT NULL,          -- IST business date
  txn_timestamp          TIMESTAMPTZ,            -- NULL: source has date granularity only
  posting_date           DATE,                   -- NULL: bank source only

  counterparty_raw       TEXT,
  counterparty_norm      TEXT,
  counterparty_key       TEXT,                   -- post-alias; NULL until Tier 1.5 runs

  method                 TEXT,
  status_raw             TEXT NOT NULL,
  status_norm            TEXT NOT NULL CHECK (status_norm IN
                           ('reconcilable','excluded_failed','excluded_draft','excluded_void',
                            'excluded_authorized','excluded_non_reconcilable')),
  txn_type               TEXT,
  description_raw        TEXT,

  -- S4 dedup (ADR-034). Runs BEFORE matching: if it ran after, the second copy
  -- would compete for the same bank credit, lose, and be reported as
  -- MISSING_IN_BANK — inventing a missing bank record that never should have existed.
  duplicate_of_transaction_id UUID REFERENCES transactions(id),
  duplicate_kind         TEXT CHECK (duplicate_kind IN ('exact','suspected')),

  ingest_warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload            JSONB NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (run_id, source_system, source_row_number),
  -- Paired nullability: both set or neither.
  CONSTRAINT txn_dupe_fields_paired CHECK (
    (duplicate_of_transaction_id IS NULL) = (duplicate_kind IS NULL)
  ),
  CONSTRAINT txn_not_own_duplicate CHECK (duplicate_of_transaction_id <> id)
);

CREATE INDEX ix_txn_run_source ON transactions (run_id, source_system);

-- Blocking index (ADR-033). `direction` is in the key because it is a hard gate
-- (ADR-035) — excluding it would fetch candidates that are discarded immediately.
CREATE INDEX ix_txn_block      ON transactions (run_id, direction, txn_date, amount_paise);

CREATE INDEX ix_txn_refs_gin   ON transactions USING gin (reference_ids);
CREATE INDEX ix_txn_cp_norm    ON transactions (run_id, counterparty_norm);
CREATE INDEX ix_txn_dupe       ON transactions (duplicate_of_transaction_id)
  WHERE duplicate_of_transaction_id IS NOT NULL;

-- Serves ORDER BY source_rank(source_system), source_row_number directly, so the
-- canonical ordering is an index scan rather than a sort (ADR-032).
CREATE INDEX ix_txn_canonical   ON transactions (run_id, source_rank(source_system), source_row_number);

CREATE INDEX ix_txn_cp_trgm     ON transactions USING gin (counterparty_norm gin_trgm_ops);
