-- 009 · score_reports — ground-truth-derived measurements (ADR-041).
--
-- runs.metrics is the engine's account of ITS OWN WORK. This table is an
-- INDEPENDENT MEASUREMENT of that work. Merging them would produce one object
-- where nobody can tell which numbers were graded and which were self-reported —
-- and that difference is the whole thesis of the track's bar.
--
-- Written ONLY by tools/score via endpoint 23. Never read by the engine.
-- ADR-021's guarantee (no ground truth in the decision path) is unchanged and is
-- enforced by apps/api/tests/unit/truth-leak-guard.test.ts.

CREATE TABLE score_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  truth_key_file TEXT NOT NULL,       -- 'data/truth/holdout_seed_90210.json'
  -- Checked against runs.input_file_hashes before the report is accepted
  -- (422 TRUTH_KEY_MISMATCH). Scoring a run against a key built from different
  -- bytes should be impossible, not something you notice late.
  truth_key_hash CHAR(64) NOT NULL,
  scorer_version TEXT NOT NULL,
  scored_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  report         JSONB NOT NULL,      -- shape in schema.md §11.2

  UNIQUE (run_id, scorer_version, truth_key_hash)
);

CREATE INDEX ix_score_run ON score_reports (run_id, scored_at DESC);
