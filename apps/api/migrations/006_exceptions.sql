-- 006 · exceptions — the primary feature, not a fallback path.
--
-- `evidence` is mandatory and is the heart of the honest exception list: it
-- records what the engine TRIED, so "why wasn't this matched?" has a rule-level
-- answer with no LLM involved. The explain layer narrates this object; it never
-- generates it.

CREATE TABLE exceptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  transaction_id          UUID REFERENCES transactions(id),  -- NULL: group-level (e.g. unsplittable batch)
  related_transaction_ids UUID[] NOT NULL DEFAULT '{}',

  -- Exactly one primary category, chosen by the fixed precedence order in
  -- schema.md §8.2. Every other applicable category goes to secondary_flags, so a
  -- record always has one primary and a complete record of its other properties.
  category                TEXT NOT NULL CHECK (category IN
                            ('DUPLICATE_RECORD','AMBIGUOUS_MATCH','MISSING_IN_BANK','MISSING_IN_LEDGER',
                             'MISSING_IN_GATEWAY','AMOUNT_MISMATCH','TIMING_DRIFT','UNSPLITTABLE_BATCH')),
  secondary_flags         TEXT[] NOT NULL DEFAULT '{}',
  severity                TEXT NOT NULL CHECK (severity IN ('high','medium','low')),

  best_candidate_score    NUMERIC(5,4),  -- NULL: no candidate was found at all
  -- ADR-044: severity is computed from category AND money at risk. A fixed
  -- per-category severity made a ₹5 rounding mismatch and a ₹5,00,000 partial
  -- capture both `high`, which makes the primary screen's sort order useless.
  amount_at_risk_paise    BIGINT,
  requires_human_confirmation BOOLEAN NOT NULL DEFAULT false,  -- SUSPECTED_DUPLICATE (ADR-034)

  evidence                JSONB NOT NULL,
  detected_by_rule        TEXT NOT NULL,
  rule_version            TEXT NOT NULL,

  explanation_text        TEXT,
  explanation_source      TEXT CHECK (explanation_source IN ('llm','template','llm_cache')),
  signature_hash          CHAR(64),
  suggested_action        TEXT,

  status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','explained','human_resolved','wont_fix')),
  resolved_by             TEXT,
  resolved_at             TIMESTAMPTZ,
  resolution_note         TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A resolution without a stated reason is the same hole in the audit trail a
  -- reason-less rejection would be (api-contract §20).
  CONSTRAINT exc_resolution_complete CHECK (
    (status NOT IN ('human_resolved','wont_fix'))
    OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL)
  )
);

CREATE INDEX ix_exc_run_category ON exceptions (run_id, category);

-- Serves the exception list's DEFAULT SORT: severity, then money at risk (ui-spec
-- §3). A finance controller triages by money, so this ordering is a product
-- decision rather than a cosmetic one.
CREATE INDEX ix_exc_run_severity ON exceptions (run_id, severity, amount_at_risk_paise DESC);
CREATE INDEX ix_exc_txn          ON exceptions (transaction_id);
CREATE INDEX ix_exc_signature    ON exceptions (signature_hash) WHERE signature_hash IS NOT NULL;
