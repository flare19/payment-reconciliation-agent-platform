-- 007 · audit_log — append-only and hash-chained.
--
-- One timeline for engine, human, LLM and agent events (ADR-014, ADR-052). A
-- second log table would turn "show me everything that happened" into a UNION
-- across two schemas ordered by two clocks — and the sequence_no ordering
-- guarantee only holds inside one table.

CREATE TABLE audit_log (
  -- One sequence, not two. The Day 2 draft had both `id BIGSERIAL PRIMARY KEY`
  -- and `sequence_no ... GENERATED ALWAYS AS IDENTITY`, which are the same thing
  -- under two names.
  sequence_no    BIGSERIAL PRIMARY KEY,

  -- ON DELETE RESTRICT, deliberately: a run whose history exists cannot be
  -- deleted. CASCADE would fire the row-level delete trigger below and fail
  -- anyway; RESTRICT says why. Tests reset with TRUNCATE, which bypasses
  -- row-level triggers by design.
  run_id         UUID REFERENCES runs(id) ON DELETE RESTRICT,  -- NULL: alias admin outside any run

  event_type     TEXT NOT NULL,
  subject_type   TEXT NOT NULL CHECK (subject_type IN
                   ('transaction','match','exception','alias','run','investigation')),
  subject_id     UUID NOT NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,  -- denormalized for a fast per-record trail

  -- `llm` is the S13 explain layer. `agent` is Phase A (ADR-052). Neither may
  -- ever appear on a MATCH_CONFIRMED_* event — that separation is ADR-017 and
  -- ADR-048 made visible, and the audit screen renders it as four actor colours.
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('engine','human','llm','agent')),
  actor_id       TEXT NOT NULL,

  tier           TEXT,
  rule_id        TEXT,
  rule_version   TEXT,
  decision       TEXT,
  confidence     NUMERIC(5,4),

  before_state   JSONB,
  after_state    JSONB,
  -- Always human-readable, always populated. A log that says "processed" is not
  -- an audit trail.
  reason         TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Tamper-evidence (ADR-042). Chained per run; the first entry of a chain has
  -- prev_hash = 64 zeros. Computed in application code as
  -- sha256(canonical_json(entry minus hashes) || prev_hash).
  prev_hash      CHAR(64) NOT NULL,
  entry_hash     CHAR(64) NOT NULL,

  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_audit_txn  ON audit_log (transaction_id, sequence_no);
CREATE INDEX ix_audit_run  ON audit_log (run_id, sequence_no);
CREATE INDEX ix_audit_subj ON audit_log (subject_type, subject_id, sequence_no);
CREATE INDEX ix_audit_type ON audit_log (run_id, event_type, sequence_no);

-- Immutability is enforced, not assumed. A code convention is not immutability;
-- a database constraint is.
--
-- NOTE: references OLD.sequence_no, not OLD.id — the two id columns were
-- consolidated into one. docs/schema.md §9 still shows `OLD.id` in its example,
-- which would fail at runtime; this is the corrected version.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted % on sequence_no %)',
    TG_OP, OLD.sequence_no
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Deliberately NOT enforced here: that prev_hash equals the previous entry's
-- entry_hash.
--
-- A trigger doing that lookup would add a SELECT to every insert (there are
-- thousands per run), break batched inserts, and protect against almost nothing:
-- the threat the chain addresses is someone with database access editing rows,
-- and such a person can drop a trigger as easily as they can edit a row. The
-- chain's value is DETECTION BY RECOMPUTATION, which is what endpoint 22 does.
-- Linkage is the repository layer's responsibility on write, and the verify
-- endpoint's on read.
