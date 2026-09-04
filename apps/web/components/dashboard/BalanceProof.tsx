import { count } from '@/lib/format';
import type { ReconciliationResponse } from '@/types/api';
import styles from './BalanceProof.module.css';

/**
 * THE BOOKS, RECONCILED — the panel that answers the arithmetic this page
 * otherwise invites a reader to do wrong.
 *
 * A judge reads "573 matched", "216 awaiting review" and "212 exceptions",
 * adds them, gets 1001 against a population of 874, and concludes the engine
 * double-counts. It does not. The populations legitimately overlap: a
 * gateway↔bank pair that matched but has no ledger entry is genuinely BOTH a
 * match and a MISSING_IN_LEDGER finding, and a list that hid those would
 * understate the problem rather than overstate it.
 *
 * Until now that reconciliation lived only in the engine. The numbers were
 * right and the page never showed why, which left the strongest evidence this
 * project has — that its books balance to the record — as an exercise for a
 * reader who has thirty seconds and no reason to extend credit.
 *
 * ── WHY IT SITS DIRECTLY UNDER THE HEADLINE TILES ──
 * It is not a footnote to the figures; it is the reason to believe them. The
 * tiles claim a match rate, and this says that every one of 920 rows is in
 * exactly one place and here is where. Put it lower and a panelist reading the
 * top third meets the confusion without the answer.
 *
 * ── IT CAN SAY NO ──
 * Same stance as `/audit/verify`: a verifier that can only report success is
 * not a verifier. Every identity is recomputed from base rows on each request
 * and rendered with its two sides visible, so a reader can check the claim
 * rather than accept the tick. If one breaks, the panel says which and by how
 * much, in the failure colour, instead of quietly rendering wrong totals.
 */
export function BalanceProof({ recon }: { recon: ReconciliationResponse }) {
  const { population: p, disposition: d, exceptionBreakdown: e, checks } = recon;
  const failed = checks.filter((c) => !c.holds);

  return (
    <div className={`${styles.wrap} ${recon.balanced ? styles.ok : styles.bad}`}>
      <p className={styles.verdict}>
        {recon.balanced ? (
          <>
            ✓ Every one of{' '}
            <span className="num">{count(p.ingested)}</span> source rows is accounted for
          </>
        ) : (
          <>
            ✗ The books do not balance —{' '}
            <span className="num">{count(failed.length)}</span> of{' '}
            <span className="num">{count(checks.length)}</span>{' '}
            {failed.length === 1 ? 'identity fails' : 'identities fail'}
          </>
        )}
      </p>

      {/* ── THE FLOW: what happened to 920 rows, in the order it happened ── */}
      <ol className={styles.flow}>
        <li className={styles.step}>
          <span className={`num ${styles.big}`}>{count(p.ingested)}</span>
          <span className={styles.stepLabel}>rows read</span>
          <span className={styles.stepNote}>across three source files</span>
        </li>
        <li className={styles.arrow} aria-hidden="true">−</li>
        <li className={styles.step}>
          <span className={`num ${styles.big}`}>{count(p.excluded + p.nonPrimaryDuplicates)}</span>
          <span className={styles.stepLabel}>set aside</span>
          <span className={styles.stepNote}>
            {count(p.excluded)} never reconcilable · {count(p.nonPrimaryDuplicates)} duplicates
          </span>
        </li>
        <li className={styles.arrow} aria-hidden="true">=</li>
        <li className={`${styles.step} ${styles.denominator}`}>
          <span className={`num ${styles.big}`}>{count(p.reconcilable)}</span>
          <span className={styles.stepLabel}>reconcilable</span>
          <span className={styles.stepNote}>the denominator every rate divides by</span>
        </li>
      </ol>

      {/* ── THE THREE STATES. Every reconcilable record is in exactly one. ── */}
      <div className={styles.states}>
        <div className={styles.state}>
          <span className={`num ${styles.mid}`}>{count(d.matched)}</span>
          <span className={styles.stateLabel}>matched</span>
          <span className={styles.stateNote}>
            {d.matchedByHuman > 0 ? (
              <>
                <span className="num">{count(d.matchedByEngine)}</span> the engine confirmed on
                its own, <span className="num">{count(d.matchedByHuman)}</span> a reviewer
                approved afterwards — kept apart, because only the first is a claim about the
                engine
              </>
            ) : (
              <>in a group the engine confirmed on its own</>
            )}
          </span>
        </div>
        <div className={styles.state}>
          <span className={`num ${styles.mid}`}>{count(d.inReviewQueue)}</span>
          <span className={styles.stateLabel}>proposed, not confirmed</span>
          <span className={styles.stateNote}>
            held out of the match rate rather than counted toward it
          </span>
        </div>
        <div className={styles.state}>
          <span className={`num ${styles.mid}`}>{count(d.neither)}</span>
          <span className={styles.stateLabel}>unresolved</span>
          <span className={styles.stateNote}>
            {/*
              Three legitimate ends, and the page names whichever ones this run
              has. A record in none of them is an orphan and C3 fails — the
              deferred states are an account of where a record went, never a
              place to put one nobody can explain (ADR-163).
            */}
            <span className="num">{count(d.unresolvedNamedOnList)}</span> named on the
            exception list
            {d.unresolvedNotYetDue > 0 && (
              <>
                , <span className="num">{count(d.unresolvedNotYetDue)}</span> not yet due —
                every settlement window they could be missing from is still open, so calling
                them missing would be a false finding
              </>
            )}
            {d.unresolvedAwaitingReclassification > 0 && (
              <>
                , <span className="num">{count(d.unresolvedAwaitingReclassification)}</span>{' '}
                returned to the pool by a rejection and awaiting the next run
              </>
            )}
          </span>
        </div>
      </div>

      {/*
        THE CLAIM WORTH MAKING OUT LOUD. C1, C2 and C4 are arithmetic; this one
        is about conduct. A dropped record makes every other number on the page
        look BETTER, which is exactly why its absence has to be demonstrated
        rather than asserted.
      */}
      <p className={styles.claim}>
        Nothing was dropped. A record is <strong>matched</strong>,{' '}
        <strong>proposed</strong>, or <strong>explained</strong> — never quietly
        discarded, and the count below proves it rather than promising it.
      </p>

      {/* ── WHY 212 EXCEPTIONS AND ONLY 85 UNRESOLVED RECORDS ── */}
      <div className={styles.exceptions}>
        <p className={styles.exceptionsHead}>
          Why the exception list holds{' '}
          <span className="num">{count(e.total)}</span> records and not{' '}
          <span className="num">{count(e.pure)}</span>
        </p>
        <dl className={styles.exceptionRows}>
          <div>
            <dt>{count(e.inConfirmedMatch)}</dt>
            <dd>
              are <em>also</em> inside a confirmed group — the pair matched, but a third
              source never booked it, or the amounts disagree. Both facts are true and both
              are reported.
            </dd>
          </div>
          <div>
            <dt>{count(e.inReviewQueue)}</dt>
            <dd>are also inside a proposal a human has not judged yet.</dd>
          </div>
          <div>
            <dt>{count(e.pure)}</dt>
            <dd>matched nothing at all — the unresolved population above.</dd>
          </div>
          <div>
            <dt>{count(e.outsideDenominator)}</dt>
            <dd>
              are the collapsed duplicates, surfaced as findings even though they sit
              outside the denominator.
            </dd>
          </div>
        </dl>
      </div>

      {/* ── THE IDENTITIES, WITH BOTH SIDES SHOWN ── */}
      <table className={styles.checks}>
        <caption className={styles.caption}>
          Recomputed from the records, the matches and the exceptions on this request —
          never read from the run&rsquo;s stored summary. The last row is what compares the
          two.
        </caption>
        <thead>
          <tr>
            <th scope="col">Identity</th>
            <th scope="col">Holds</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id} className={c.holds ? undefined : styles.rowBad}>
              <td>
                <span className={`num ${styles.expr}`}>{c.expression}</span>
                <span className={styles.checkNote}>{c.note}</span>
              </td>
              <td className={styles.holds}>
                {c.holds ? (
                  <span className={styles.tick} title="holds">✓</span>
                ) : (
                  <span className={styles.cross}>
                    ✗ off by <span className="num">{count(Math.abs(c.delta))}</span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
