-- 008 · explanation_cache — run-independent, keyed by DISCREPANCY SIGNATURE.
--
-- One LLM call per exception is ~75 calls per run and re-pays on every re-run and
-- every demo rehearsal, which creates a quiet incentive NOT to re-run the full
-- batch — directly against the track's "never cherry-pick" bar. Signatures
-- collapse ~75 exceptions into ~15-30 distinct shapes, so cost is O(distinct
-- discrepancy shapes) rather than O(exceptions) and re-running is free.

CREATE TABLE explanation_cache (
  signature_hash   CHAR(64) PRIMARY KEY,
  prompt_version   TEXT NOT NULL,
  -- Part of the HASHED INPUT alongside prompt_version, not merely recorded here:
  -- switching models must invalidate the cache, or a run would silently serve
  -- prose written by a model it no longer uses.
  model            TEXT NOT NULL,
  category         TEXT NOT NULL,
  signature_input  JSONB NOT NULL,   -- pre-hash components, for debugging and for the UI
  explanation_text TEXT NOT NULL,
  suggested_action TEXT NOT NULL,
  tokens_in        INT,              -- NULL for template-sourced rows
  tokens_out       INT,
  hit_count        INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_expl_version ON explanation_cache (prompt_version, model);

-- Invalidation is by prompt_version / model, never by TTL: a deterministic input
-- should not expire on a clock.
