-- 002 · runs — one row per reconciliation run. See docs/schema.md §4.

CREATE TABLE runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label              TEXT NOT NULL,
  dataset_seed       BIGINT,                    -- NULL: user-uploaded files, not generated
  status             TEXT NOT NULL CHECK (status IN
                       ('pending','ingesting','matching','classifying','explaining','completed','failed')),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,               -- NULL until terminal

  -- ADR-039: MAX(txn_date) over the dataset, NEVER the wall clock. Every
  -- "has the settlement window elapsed?" test reads this. Using now() would make
  -- the same dataset produce different exception counts in August and September,
  -- so the reported numbers would drift between rehearsal and submission.
  reference_date     DATE,                      -- NULL until ingestion completes

  record_counts      JSONB NOT NULL DEFAULT '{}'::jsonb,
  rejected_row_count INT   NOT NULL DEFAULT 0,  -- ADR-046: unparseable rows are NOT exceptions
  rejected_rows      JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Together with config_snapshot this is what makes a result reproducible by a
  -- sceptic: config_snapshot proves HOW the engine was configured, these prove
  -- WHAT it ran against. The scorer refuses a score report whose truth-key hash
  -- disagrees with these (endpoint 23, ADR-041).
  input_file_hashes  JSONB NOT NULL DEFAULT '{}'::jsonb,

  config_snapshot    JSONB NOT NULL,
  metrics            JSONB,                     -- ENGINE-COMPUTED ONLY (§11.1, ADR-041)
  error_detail       TEXT,                      -- NULL unless status='failed'

  -- Paired nullability: a terminal run has an end, a live one does not.
  CONSTRAINT runs_finished_iff_terminal CHECK (
    (status IN ('completed','failed')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT runs_error_iff_failed CHECK (
    (status = 'failed') OR (error_detail IS NULL)
  )
);

CREATE INDEX ix_runs_started ON runs (started_at DESC);
CREATE INDEX ix_runs_status  ON runs (status) WHERE status NOT IN ('completed','failed');
