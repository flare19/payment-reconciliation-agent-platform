/**
 * ALL SQL for the balance proof lives here and nowhere else (CLAUDE.md §4.1).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS READS BASE TABLES AND NEVER `runs.metrics`.
 *
 * `runs.metrics` is the engine's summary of its own work. Checking that summary
 * against itself proves nothing — it would restate the number a reader is
 * already being asked to trust, in a panel whose entire purpose is to stop
 * asking. So every count below is recomputed from the rows the rest of the UI
 * renders: `transactions`, `matches`, `match_members`, `exceptions`.
 *
 * The published summary is then compared against this recomputation as one more
 * check (C5 in the service). That is the direction that carries information: if
 * the base rows and the headline disagree, the headline is wrong, and the panel
 * says so rather than showing both and letting the reader pick.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THE FOUR POPULATIONS MEAN ──
 * `reconcilable`  the match-rate denominator (ADR-040): ingested, minus rows
 *                 that were never reconcilable, minus non-primary duplicates.
 * `matched`       records inside a group the engine or a human CONFIRMED. A
 *                 `pending_review` group is a proposal, and a proposal is not a
 *                 match (ADR-040), so it is deliberately not counted here.
 * `inReviewQueue` records inside a proposed group, held out of the rate.
 * `exceptions`    records carrying an exception row.
 *
 * These populations OVERLAP, and that is the finding rather than a defect: a
 * gateway↔bank pair that matched but has no ledger entry is genuinely both a
 * match and a `MISSING_IN_LEDGER` exception. The service turns the overlap into
 * the decomposition that explains it.
 *
 * One query, not six. The counts must describe ONE snapshot — six statements
 * could interleave with a concurrent write and produce a set of numbers that
 * never simultaneously held, which is the one output this panel must not have.
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { getPool, type TxClient } from '../db/pool.js';

/** Raw counts, straight off the base tables. No arithmetic — that is the service's job. */
export interface ReconciliationCounts {
  /** Every row that reached `transactions` for this run. */
  ingested: number;
  /** Parsed, but never reconcilable — a failed payment, a void entry, a fee line. */
  excluded: number;
  /** Non-primary duplicates, collapsed out of the denominator. */
  nonPrimaryDuplicates: number;
  /** The match-rate denominator, counted directly rather than derived. */
  reconcilable: number;

  /** Distinct records in a confirmed group — engine's own plus a human's. */
  matched: number;
  /**
   * Records the ENGINE confirmed by itself (`auto_confirmed`).
   *
   * Split out because `runs.metrics` is frozen at S14 and knows only this
   * number, while `matched` keeps moving as reviewers work. Comparing the two
   * without the split makes the books "not balance" the moment a human does
   * their job — which would fire the failure state on exactly the workflow this
   * product wants people to use (ADR-119's engine-alone / with-review split,
   * applied to the balance proof).
   */
  matchedByEngine: number;
  /** Records a human confirmed out of the review queue, after the run finished. */
  matchedByHuman: number;
  /** Distinct records in a `pending_review` group. */
  inReviewQueue: number;
  /** Reconcilable records in neither — the population the exception list must cover. */
  neither: number;
  /**
   * How many of `neither` the exception list actually names — primary record or
   * `related_transaction_ids`. C3 compares this against `neither`, and the gap
   * is the count of records that fell off the books entirely.
   */
  neitherCovered: number;
  /**
   * Unresolved, no exception — and S12 said why: every settlement window this
   * record could be missing from is still open at the reference date. A real
   * state the engine chose, now named instead of invisible (ADR-163).
   */
  neitherNotYetDue: number;
  /** Unresolved because a human rejected their group; awaiting the next run's S12. */
  neitherAwaitingReclassification: number;

  /** Distinct records carrying an exception. */
  exceptionRecords: number;
  /** Exception records that are ALSO in a confirmed group (a group missing a leg). */
  exceptionsInConfirmedMatch: number;
  /** Exception records that are ALSO in a proposed group. */
  exceptionsInReviewQueue: number;
  /** Exception records in neither — should equal `neither` exactly. */
  exceptionsPure: number;
  /** Exception records outside the denominator entirely (the collapsed duplicates). */
  exceptionsOutsideDenominator: number;

  /** Exception ROWS, which can exceed exception RECORDS if a record ever carried two. */
  exceptionRows: number;
}

/**
 * Recompute a run's population from the rows themselves.
 *
 * `reconcilable` is counted, not derived as `ingested − excluded − duplicates`.
 * Deriving it would make C1 a tautology: the identity would hold because it was
 * computed to hold, and the check would be incapable of failing. Counting both
 * sides independently is what gives C1 the power to disagree.
 */
export async function reconciliationCounts(
  runId: string, client?: TxClient,
): Promise<ReconciliationCounts | null> {
  const { rows } = await (client ?? getPool()).query<Record<string, string>>(
    `WITH t AS (
       SELECT id, status_norm, duplicate_of_transaction_id, deferred_reason
         FROM transactions WHERE run_id = $1
     ),
     recon AS (
       SELECT id FROM t
        WHERE status_norm = 'reconcilable' AND duplicate_of_transaction_id IS NULL
     ),
     conf AS (
       SELECT DISTINCT mm.transaction_id AS id
         FROM match_members mm JOIN matches m ON m.id = mm.match_id
        WHERE m.run_id = $1 AND m.status IN ('auto_confirmed', 'human_confirmed')
     ),
     conf_engine AS (
       SELECT DISTINCT mm.transaction_id AS id
         FROM match_members mm JOIN matches m ON m.id = mm.match_id
        WHERE m.run_id = $1 AND m.status = 'auto_confirmed'
     ),
     conf_human AS (
       SELECT DISTINCT mm.transaction_id AS id
         FROM match_members mm JOIN matches m ON m.id = mm.match_id
        WHERE m.run_id = $1 AND m.status = 'human_confirmed'
     ),
     rev AS (
       SELECT DISTINCT mm.transaction_id AS id
         FROM match_members mm JOIN matches m ON m.id = mm.match_id
        WHERE m.run_id = $1 AND m.status = 'pending_review'
     ),
     -- Members of a group a HUMAN rejected. Endpoint 11 returns them to the
     -- pool and deliberately raises no exception -- re-classifying is S12's job
     -- on the next run, not something a route improvises. So they are genuinely
     -- unresolved and genuinely accounted for: awaiting re-classification, which
     -- is a state, not a disappearance (ADR-163).
     rejected AS (
       SELECT DISTINCT mm.transaction_id AS id
         FROM match_members mm JOIN matches m ON m.id = mm.match_id
        WHERE m.run_id = $1 AND m.status = 'human_rejected'
     ),
     -- TWO SETS, DELIBERATELY, because they answer different questions.
     --
     -- exc      the PRIMARY record of each exception. This is the population the
     --          exception list screen paginates and the dashboard counts, so the
     --          C4 decomposition must add up to THIS or the panel would publish a
     --          total no other screen agrees with.
     -- exc_cov  every record an exception NAMES, primary plus
     --          related_transaction_ids. C3 asks whether a reader can find the
     --          record on the list at all, and being named as a related record
     --          counts -- it is on the page.
     -- (No backticks in this comment: it lives in a TS template literal.)
     exc AS (
       SELECT DISTINCT transaction_id AS id
         FROM exceptions WHERE run_id = $1 AND transaction_id IS NOT NULL
     ),
     exc_cov AS (
       SELECT DISTINCT id FROM (
         SELECT transaction_id AS id FROM exceptions
          WHERE run_id = $1 AND transaction_id IS NOT NULL
         UNION
         SELECT unnest(related_transaction_ids) AS id FROM exceptions WHERE run_id = $1
       ) q WHERE id IS NOT NULL
     )
     SELECT
       (SELECT count(*) FROM t)                                   AS ingested,
       (SELECT count(*) FROM t WHERE status_norm <> 'reconcilable') AS excluded,
       (SELECT count(*) FROM t
         WHERE duplicate_of_transaction_id IS NOT NULL)           AS non_primary_duplicates,
       (SELECT count(*) FROM recon)                               AS reconcilable,

       (SELECT count(*) FROM conf)                                AS matched,
       (SELECT count(*) FROM conf_engine)                         AS matched_by_engine,
       (SELECT count(*) FROM conf_human)                          AS matched_by_human,
       (SELECT count(*) FROM rev)                                 AS in_review_queue,
       (SELECT count(*) FROM recon r
         WHERE NOT EXISTS (SELECT 1 FROM conf c WHERE c.id = r.id)
           AND NOT EXISTS (SELECT 1 FROM rev  v WHERE v.id = r.id)) AS neither,
       (SELECT count(*) FROM recon r
         WHERE NOT EXISTS (SELECT 1 FROM conf c WHERE c.id = r.id)
           AND NOT EXISTS (SELECT 1 FROM rev  v WHERE v.id = r.id)
           AND EXISTS     (SELECT 1 FROM exc_cov x WHERE x.id = r.id)) AS neither_covered,
       -- S12 declined to call it missing because every window it could be
       -- missing from is still open at the reference date.
       (SELECT count(*) FROM recon r
         JOIN t ON t.id = r.id
         WHERE NOT EXISTS (SELECT 1 FROM conf c WHERE c.id = r.id)
           AND NOT EXISTS (SELECT 1 FROM rev  v WHERE v.id = r.id)
           AND NOT EXISTS (SELECT 1 FROM exc_cov x WHERE x.id = r.id)
           AND t.deferred_reason IS NOT NULL)                       AS neither_not_yet_due,
       (SELECT count(*) FROM recon r
         WHERE NOT EXISTS (SELECT 1 FROM conf c WHERE c.id = r.id)
           AND NOT EXISTS (SELECT 1 FROM rev  v WHERE v.id = r.id)
           AND NOT EXISTS (SELECT 1 FROM exc_cov x WHERE x.id = r.id)
           AND EXISTS     (SELECT 1 FROM rejected j WHERE j.id = r.id)) AS neither_awaiting_reclassification,

       (SELECT count(*) FROM exc)                                 AS exception_records,
       (SELECT count(*) FROM exc e
         WHERE EXISTS (SELECT 1 FROM conf c WHERE c.id = e.id))   AS exceptions_in_confirmed_match,
       (SELECT count(*) FROM exc e
         WHERE EXISTS (SELECT 1 FROM rev v WHERE v.id = e.id))    AS exceptions_in_review_queue,
       (SELECT count(*) FROM exc e
         WHERE EXISTS (SELECT 1 FROM recon r WHERE r.id = e.id)
           AND NOT EXISTS (SELECT 1 FROM conf c WHERE c.id = e.id)
           AND NOT EXISTS (SELECT 1 FROM rev  v WHERE v.id = e.id)) AS exceptions_pure,
       (SELECT count(*) FROM exc e
         WHERE NOT EXISTS (SELECT 1 FROM recon r WHERE r.id = e.id)) AS exceptions_outside_denominator,

       (SELECT count(*) FROM exceptions WHERE run_id = $1)        AS exception_rows`,
    [runId],
  );

  const r = rows[0];
  if (r === undefined) return null;
  const n = (k: string): number => Number(r[k] ?? 0);

  return {
    ingested: n('ingested'),
    excluded: n('excluded'),
    nonPrimaryDuplicates: n('non_primary_duplicates'),
    reconcilable: n('reconcilable'),
    matched: n('matched'),
    matchedByEngine: n('matched_by_engine'),
    matchedByHuman: n('matched_by_human'),
    inReviewQueue: n('in_review_queue'),
    neither: n('neither'),
    neitherCovered: n('neither_covered'),
    neitherNotYetDue: n('neither_not_yet_due'),
    neitherAwaitingReclassification: n('neither_awaiting_reclassification'),
    exceptionRecords: n('exception_records'),
    exceptionsInConfirmedMatch: n('exceptions_in_confirmed_match'),
    exceptionsInReviewQueue: n('exceptions_in_review_queue'),
    exceptionsPure: n('exceptions_pure'),
    exceptionsOutsideDenominator: n('exceptions_outside_denominator'),
    exceptionRows: n('exception_rows'),
  };
}
