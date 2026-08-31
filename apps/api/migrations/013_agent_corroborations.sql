-- A2 CORROBORATE — the review queue as a second work list (ADR-081, ADR-087).
--
-- A SEPARATE TABLE, not a widening of `agent_investigations`, and the reason is
-- the whole point of ADR-081.
--
-- An investigation answers "can this exception be resolved?" and may propose an
-- ACTION. A corroboration answers "is there evidence beyond the score?" and may
-- propose NOTHING — the human still clicks, through PATCH /api/matches/:id,
-- exactly as today. Sharing one table would have put CORROBORATED in the same
-- column as RESOLUTION_PROPOSED, which invites counting them together and
-- dilutes the grounding and hallucination figures §7 reports about
-- investigations specifically.
--
-- THERE IS NO `proposed_action` COLUMN, AND THAT IS THE DESIGN.
-- agent-design.md §3: "The Analyst does not recommend confirming or rejecting a
-- match. It never says 'confirm this'." A table with nowhere to put a
-- recommendation cannot carry one, which is a stronger guarantee than a rule
-- saying it must not.
--
-- `agent_investigations` is untouched: its `exception_id NOT NULL` and its
-- `ux_inv_exc_active` partial index are load-bearing, and making the column
-- nullable to admit match-scoped rows would weaken both for every existing row.

CREATE TABLE agent_corroborations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  match_id           UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,

  status             TEXT NOT NULL CHECK (status IN ('running','concluded','failed')),

  -- Statements about EVIDENCE, never about the decision (ADR-081). Disjoint from
  -- the investigation verdicts on purpose: no query can accidentally union them.
  verdict            TEXT CHECK (verdict IN
                       ('CORROBORATED','CONTRADICTED','NO_NEW_EVIDENCE')),

  -- A LABEL, never a number, and deliberately a different TYPE from
  -- matches.confidence NUMERIC(5,4) — same reason as agent_investigations.
  confidence         TEXT CHECK (confidence IN ('high','medium','low')),

  reasoning          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Populated ONLY after the A3 gate verifies each id came from a real tool
  -- result in THIS corroboration (ADR-050).
  citations          UUID[] NOT NULL DEFAULT '{}',

  grounding_passed   BOOLEAN NOT NULL DEFAULT false,
  grounding_failure  TEXT,
  budget_exhausted   BOOLEAN NOT NULL DEFAULT false,

  steps              INT NOT NULL DEFAULT 0,
  tool_calls         INT NOT NULL DEFAULT 0,
  tokens_in          INT,
  tokens_out         INT,
  cost_usd           NUMERIC(10,6),

  model              TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,

  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,

  CONSTRAINT corr_concluded_has_verdict CHECK (
    (status <> 'concluded') OR (verdict IS NOT NULL AND finished_at IS NOT NULL)
  ),
  -- Mirrors `inv_grounding_failure_paired`: a failure must say what failed.
  CONSTRAINT corr_grounding_failure_paired CHECK (
    grounding_passed OR status <> 'concluded' OR grounding_failure IS NOT NULL
  )
);

CREATE INDEX ix_corr_run ON agent_corroborations (run_id, verdict);
CREATE INDEX ix_corr_match ON agent_corroborations (match_id);

-- One live corroboration per match, mirroring ux_inv_exc_active.
CREATE UNIQUE INDEX ux_corr_match_active ON agent_corroborations (match_id)
  WHERE status <> 'failed';
