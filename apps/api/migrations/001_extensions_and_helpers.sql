-- 001 · Extensions and shared helpers.
--
-- `gen_random_uuid()` is core in PostgreSQL 13+, so pgcrypto is not required.

-- Trigram index support for the `?search=` parameters on endpoints 6 and 15.
-- Without it, ILIKE '%foo%' is a sequential scan.
--
-- IMPORTANT: pg_trgm is for SEARCH ONLY. The Tier 2 counterparty component
-- (schema.md §5.4) is computed in TypeScript, not by pg_trgm, for two reasons:
-- the scorer must be a pure in-memory function over blocked candidates rather
-- than a database round-trip per pair (ADR-033), and the agent's `score_pair`
-- tool must run the exact same code path the engine ran (ADR-049). Two
-- similarity implementations that disagree by 0.01 would be a silent accuracy
-- bug that only shows up as an unexplained score difference in a reasoning chain.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Canonical source ordering for deterministic tie-breaks (ADR-032).
-- gateway < bank < ledger — NOT alphabetical. Mirrors SOURCE_ORDER in
-- src/types/domain.ts; change both in the same commit.
--
-- Every decision-feeding query orders by (source_rank(source_system),
-- source_row_number). Unspecified row order does not merely vary — it changes
-- with plan choice and physical layout, which would silently break the
-- reproducibility that every accuracy claim in this project rests on.
CREATE OR REPLACE FUNCTION source_rank(s TEXT) RETURNS INT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT CASE s WHEN 'gateway' THEN 0 WHEN 'bank' THEN 1 WHEN 'ledger' THEN 2 ELSE 99 END $$;
