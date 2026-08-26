-- 010 · Phase A — the Analyst (ADR-048…ADR-057).
--
-- Runs strictly AFTER S14. Reads engine output as finished fact and cannot modify
-- it. Neither table here is ever read by services/matching, services/classification
-- or services/metrics: the engine must run identically with AGENT_ENABLED=false.
--
-- The step-by-step reasoning trace does NOT live here. It goes to audit_log with
-- subject_type='investigation' (ADR-052), which means agent reasoning is
-- hash-chained and tamper-evident for free — a far stronger claim than a trace in
-- an ordinary table.

CREATE TABLE agent_investigations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  exception_id       UUID NOT NULL REFERENCES exceptions(id) ON DELETE CASCADE,

  status             TEXT NOT NULL CHECK (status IN ('running','concluded','failed')),
  verdict            TEXT CHECK (verdict IN
                       ('RESOLUTION_PROPOSED','CONFIRMED_UNRESOLVABLE',
                        'NEEDS_EXTERNAL_DATA','INSUFFICIENT_EVIDENCE')),

  -- A LABEL, never a number, and deliberately a different TYPE from
  -- matches.confidence NUMERIC(5,4). The engine's confidence is COMPUTED; the
  -- agent's is ASSERTED. Same shape would invite sorting and averaging across two
  -- quantities that are not the same kind of thing.
  confidence         TEXT CHECK (confidence IN ('high','medium','low')),

  proposed_action    JSONB,          -- NULL unless verdict = RESOLUTION_PROPOSED
  reasoning          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Populated ONLY after the A3 gate verifies each id appeared in a real tool
  -- result from THIS investigation (ADR-050). An unverified citation never
  -- reaches this column.
  citations          UUID[] NOT NULL DEFAULT '{}',

  grounding_passed   BOOLEAN NOT NULL DEFAULT false,
  grounding_failure  TEXT,
  -- Budget exhaustion is an honest verdict, never a fabricated conclusion —
  -- mirroring the engine's searchBoundExceeded (ADR-038, ADR-054).
  budget_exhausted   BOOLEAN NOT NULL DEFAULT false,

  steps              INT NOT NULL DEFAULT 0,
  tool_calls         INT NOT NULL DEFAULT 0,
  tokens_in          INT,
  tokens_out         INT,
  cost_usd           NUMERIC(8,4),
  model              TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,

  human_disposition  TEXT CHECK (human_disposition IN ('accepted','declined')),
  resulting_match_id UUID REFERENCES matches(id),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,

  CONSTRAINT inv_concluded_has_verdict CHECK (
    (status <> 'concluded') OR (verdict IS NOT NULL AND finished_at IS NOT NULL)
  ),
  -- A proposal must actually propose something; anything else must not.
  CONSTRAINT inv_proposal_paired CHECK (
    (verdict IS DISTINCT FROM 'RESOLUTION_PROPOSED') = (proposed_action IS NULL)
  ),
  CONSTRAINT inv_grounding_failure_paired CHECK (
    grounding_passed = false OR grounding_failure IS NULL
  )
);

CREATE INDEX ix_inv_run ON agent_investigations (run_id, verdict);
CREATE INDEX ix_inv_exc ON agent_investigations (exception_id);

-- One live investigation per exception.
CREATE UNIQUE INDEX ux_inv_exc_active ON agent_investigations (exception_id)
  WHERE status <> 'failed';

CREATE TABLE agent_questions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question         TEXT NOT NULL,
  answer           TEXT,
  citations        UUID[] NOT NULL DEFAULT '{}',
  steps            INT NOT NULL DEFAULT 0,
  tool_calls       INT NOT NULL DEFAULT 0,
  tokens_in        INT,
  tokens_out       INT,
  cost_usd         NUMERIC(8,4),
  grounding_passed BOOLEAN NOT NULL DEFAULT false,
  asked_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the per-run and per-hour rate limits (ADR-056). The deployed demo is a
-- public URL with no auth, so this endpoint is a real quota exposure and the
-- limits are the mitigation.
CREATE INDEX ix_qa_run  ON agent_questions (run_id, asked_at DESC);
CREATE INDEX ix_qa_hour ON agent_questions (asked_at DESC);
