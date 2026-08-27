-- 005 · learned_aliases — run-independent, so the learning is measurable ACROSS runs.
-- Conflict policy is supersede-with-penalty (ADR-013).

CREATE TABLE learned_aliases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  alias_type            TEXT NOT NULL CHECK (alias_type IN
                          ('merchant_name','counterparty_name','reference_id','description_token')),
  scope_source          TEXT NOT NULL DEFAULT 'any'
                          CHECK (scope_source IN ('gateway','bank','ledger','any')),

  raw_value             TEXT NOT NULL,   -- exactly what the human saw, for display
  normalized_value      TEXT NOT NULL,   -- §3.3 normalization applied; THIS is the lookup key
  canonical_value       TEXT NOT NULL,   -- the target it resolves to (already normalized)

  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','superseded','revoked')),
  confirmation_count    INT NOT NULL DEFAULT 1 CHECK (confirmation_count >= 0),
  conflict_count        INT NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  -- Cached aggregate. The audit log is the source of truth: applied_count can
  -- always be rebuilt by counting ALIAS_APPLIED events.
  applied_count         INT NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  last_applied_at       TIMESTAMPTZ,

  created_from_match_id UUID REFERENCES matches(id),
  created_by            TEXT NOT NULL DEFAULT 'reviewer',
  approved_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  superseded_by         UUID REFERENCES learned_aliases(id),
  revoked_reason        TEXT,

  CONSTRAINT no_self_alias CHECK (normalized_value <> canonical_value),
  CONSTRAINT alias_superseded_has_target CHECK (
    (status = 'superseded') = (superseded_by IS NOT NULL)
  ),
  CONSTRAINT alias_revoked_has_reason CHECK (
    (status <> 'revoked') OR (revoked_reason IS NOT NULL)
  )
);

-- At most ONE active mapping per (type, key, scope). This partial unique index IS
-- the conflict-prevention mechanism: a conflicting write fails loudly and is then
-- handled explicitly by the supersede-with-penalty flow, rather than silently
-- overwriting a mapping some human asserted.
CREATE UNIQUE INDEX ux_alias_active
  ON learned_aliases (alias_type, normalized_value, scope_source)
  WHERE status = 'active';

CREATE INDEX ix_alias_lookup ON learned_aliases (alias_type, normalized_value)
  WHERE status = 'active';

-- NOTE for the Tier 1.5 implementer: eligibility for the alias tier is
-- (conflict_count = 0 OR confirmation_count >= 2) — ADR-013's penalty. It is
-- computed by the server, never stored, and never re-derived by the frontend
-- (api-contract §3, `eligibleForAliasTier`). One place owns the rule.
