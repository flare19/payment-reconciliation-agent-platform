-- 004 · matches + match_members. A match is a GROUP, not a pair (ADR-016).
--
-- Three nullable FKs (gateway_txn_id / bank_txn_id / ledger_txn_id) looks simpler
-- and breaks on the first net-settlement batch where five gateway payments map to
-- one bank credit. A membership table handles 1:1:1, 1:1:0 and N:1:N with one
-- shape and one set of queries.

CREATE TABLE matches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  tier               TEXT NOT NULL CHECK (tier IN ('exact','alias','fuzzy','batch','manual')),
  status             TEXT NOT NULL CHECK (status IN
                       ('auto_confirmed','pending_review','human_confirmed','human_rejected')),
  -- 1.0000 exact · 0.9500 alias (deliberately not 1.0: an alias rests on a human
  -- assertion, one inference removed from byte-exact identity) · scored for fuzzy.
  confidence         NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  rule_id            TEXT NOT NULL,
  rule_version       TEXT NOT NULL,

  cardinality        TEXT NOT NULL CHECK (cardinality IN ('one_to_one','one_to_many','many_to_one')),
  amount_delta_paise BIGINT NOT NULL DEFAULT 0,
  date_delta_days    INT    NOT NULL DEFAULT 0,
  alias_ids          UUID[] NOT NULL DEFAULT '{}',
  score_breakdown    JSONB,                       -- NULL for exact/alias; populated for fuzzy

  matched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by        TEXT,
  reviewed_at        TIMESTAMPTZ,
  review_note        TEXT,

  CONSTRAINT match_review_fields_paired CHECK (
    (reviewed_by IS NULL) = (reviewed_at IS NULL)
  )
);

CREATE INDEX ix_match_run       ON matches (run_id, tier, status);
CREATE INDEX ix_match_run_status ON matches (run_id, status);

CREATE TABLE match_members (
  match_id       UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('gateway','bank','ledger')),
  is_anchor      BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (match_id, transaction_id)
);

CREATE INDEX ix_member_txn ON match_members (transaction_id);

-- At most one anchor per match. "Exactly one" needs a deferred constraint;
-- at-most-one is the enforceable half and catches the bug that actually happens.
CREATE UNIQUE INDEX ux_match_one_anchor ON match_members (match_id) WHERE is_anchor;

-- ---------------------------------------------------------------------------
-- The single-match invariant.
--
-- Intent (schema.md §7):
--     CREATE UNIQUE INDEX ux_txn_single_match ON match_members (transaction_id)
--       WHERE match_id IN (SELECT id FROM matches WHERE status <> 'human_rejected');
--
-- Postgres does not allow a subquery in a partial-index predicate, so the
-- mechanism is a trigger. Recorded here so a later session does not spend twenty
-- minutes rediscovering it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_members_single_match() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE conflicting UUID;
BEGIN
  SELECT mm.match_id INTO conflicting
  FROM match_members mm
  JOIN matches m ON m.id = mm.match_id
  WHERE mm.transaction_id = NEW.transaction_id
    AND mm.match_id <> NEW.match_id
    AND m.status <> 'human_rejected'
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'transaction % already belongs to non-rejected match % (single-match invariant)',
      NEW.transaction_id, conflicting
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_member_single_match
  BEFORE INSERT OR UPDATE ON match_members
  FOR EACH ROW EXECUTE FUNCTION match_members_single_match();

-- Reinstating a rejected match must not smuggle a transaction into two live
-- matches. The API has no un-reject endpoint, but a database invariant should
-- hold regardless of what today's API happens to expose — that is the point of
-- putting it in the database rather than in a service.
CREATE OR REPLACE FUNCTION matches_unreject_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE offending UUID;
BEGIN
  IF OLD.status = 'human_rejected' AND NEW.status <> 'human_rejected' THEN
    SELECT mm.transaction_id INTO offending
    FROM match_members mm
    WHERE mm.match_id = NEW.id
      AND EXISTS (
        SELECT 1 FROM match_members other
        JOIN matches m2 ON m2.id = other.match_id
        WHERE other.transaction_id = mm.transaction_id
          AND other.match_id <> NEW.id
          AND m2.status <> 'human_rejected'
      )
    LIMIT 1;

    IF offending IS NOT NULL THEN
      RAISE EXCEPTION
        'cannot un-reject match %: transaction % is already in another live match',
        NEW.id, offending
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_match_unreject_guard
  BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION matches_unreject_guard();
