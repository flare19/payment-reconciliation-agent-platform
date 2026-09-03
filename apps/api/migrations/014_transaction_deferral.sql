-- 014 · Name the state a record is in when the engine DELIBERATELY declines to
-- call it missing (ADR-163).
--
-- S12's presence rule already contains this decision:
--
--     const due = settlementDue(record, target, config);
--     if (!due.overdue) continue;   // in flight, not missing (ADR-039)
--
-- It is the right call. A bank credit that landed on the reference date has not
-- had time to reach the ledger, and raising MISSING_IN_LEDGER for it would be a
-- false exception — precisely the confident wrong answer this engine exists to
-- refuse.
--
-- The defect was never the decision. It was that the decision left no trace: the
-- record stayed in the match-rate denominator, dragging the rate down, while
-- appearing on no screen a human reads. On the dev dataset that has been one
-- bank credit of Rs 4,75,201.95, in every run, invisible — found by the balance
-- proof (ADR-162) and by nothing else, because every other instrument in this
-- project reads the engine's OUTPUT rather than asking whether the output covers
-- the input.
--
-- NULL means "not deferred", so every existing row is correct without a backfill
-- and the column changes no number the engine already published.
ALTER TABLE transactions ADD COLUMN deferred_reason text;

COMMENT ON COLUMN transactions.deferred_reason IS
  'Set by S12 when a record is unmatched, unproposed and carries no exception '
  'because every settlement window it could be missing from is still open at '
  'the run reference date. NULL for every other row. Read by endpoint 29 so the '
  'books can account for the record instead of losing it (ADR-163).';
