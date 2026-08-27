-- 011 · audit_chain_heads — the anchor that makes truncation detectable (issue #18).
--
-- THE HOLE THIS CLOSES. A hash chain proves that the entries you are holding are
-- internally consistent. It cannot prove you are holding all of them: delete the
-- last N entries of a chain and every survivor still links correctly to the one
-- before it, so recomputation certifies a truncated log as intact. "Drop
-- everything after the decision I want to hide" is the cheapest tamper available
-- and it was the one ADR-042's mechanism could not see. Deleting a run's entire
-- chain was likewise indistinguishable from a run that never logged anything.
--
-- The fix is an anchor OUTSIDE the chain: how many entries it should have, and
-- what its last entry_hash should be. Verification then answers two different
-- questions — "are the entries present consistent?" and "does the log end where
-- it should?" — instead of conflating them.
--
-- WHAT THIS DOES AND DOES NOT BUY, stated plainly because the ADR-042 threat model
-- is someone with database write access. It does not make tampering impossible;
-- nothing in the same database can. It raises a single DELETE into two coordinated
-- writes across two tables, it catches accidental truncation outright, and — the
-- part that actually matters for an auditor — it gives a value that can be
-- published or pinned externally, so a chain can be checked against a head someone
-- recorded earlier rather than only against itself.
--
-- Not an append-only checkpoint log: a checkpoint per append would double the
-- write volume of the busiest table in the system to duplicate what audit_log
-- already records. One moving head per chain, updated in the same transaction and
-- under the same advisory lock as the append it describes.

CREATE TABLE audit_chain_heads (
  -- NULL is the alias-admin chain, exactly as in audit_log. RESTRICT for the same
  -- reason: a run whose history exists cannot be deleted.
  run_id            UUID REFERENCES runs(id) ON DELETE RESTRICT,

  entry_count       BIGINT   NOT NULL CHECK (entry_count >= 0),
  head_hash         CHAR(64) NOT NULL,
  -- Reported alongside the count so a reader can see WHERE the log claims to end,
  -- not merely how long it claims to be.
  head_sequence_no  BIGINT   NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NULLS NOT DISTINCT so the run-less chain has exactly one row like every other
-- chain; without it the default (NULLs distinct) would let it accumulate one row
-- per append and the anchor would never conflict. Requires PostgreSQL 15+, which
-- both validated targets (16 and 17) satisfy.
CREATE UNIQUE INDEX ux_audit_chain_heads_run
  ON audit_chain_heads (run_id) NULLS NOT DISTINCT;

-- Backfill, so chains written before this migration are anchored rather than
-- permanently unverifiable. DISTINCT ON picks each chain's last entry in
-- sequence_no order — the same order verification walks.
INSERT INTO audit_chain_heads (run_id, entry_count, head_hash, head_sequence_no)
SELECT run_id, count(*), (array_agg(entry_hash ORDER BY sequence_no DESC))[1],
       max(sequence_no)
  FROM audit_log
 GROUP BY run_id;
